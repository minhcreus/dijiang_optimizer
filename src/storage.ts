// Browser persistence: named profiles (save slots) and UI prefs in one
// localStorage key. When storage is blocked (private mode, sandboxed frames)
// the same API keeps working from memory for the session.
import type { Profile } from "./core/types.ts";

export interface ProfileMeta { id: string; name: string; updatedAt: number; createdAt: number }
export interface UiPrefs { tab: string; room: string; filterRoom: string; filterStatus: string; sortBy: string }
/** `at`: last successful write in this session (null before the first one). */
export type SaveStatus = { state: "saved" | "pending" | "unavailable" | "error"; at: number | null; message?: string };
export type StoreEvent = { type: "status" | "external" };

/** Where the store hears other tabs ("storage") and page hiding (auto flush): window, or any EventTarget in tests. */
export interface StoreEventSource {
  addEventListener(type: string, listener: (e: Event) => void): void;
}

export interface StoreDeps {
  defaults: () => Profile;
  normalize: (raw: unknown) => Profile;
  /** Omitted: window.localStorage. null: memory only. */
  storage?: Storage | null;
  key?: string;
  legacyKeys?: string[];
  now?: () => number;
  debounceMs?: number;
  uid?: () => string;
  /** Omitted: window when present. null: no listeners. */
  events?: StoreEventSource | null;
}

export interface Store {
  /** false when localStorage is missing or throws; everything then lives in memory. */
  readonly available: boolean;
  /** Ordered by creation. */
  list(): ProfileMeta[];
  activeId(): string;
  active(): ProfileMeta;
  /** The active profile, normalized; a fresh copy on every call. */
  load(): Profile;
  /** Debounced write: at most one write per debounceMs, never later than that. */
  save(profile: Profile): void;
  /** Writes pending changes now. Also runs on window pagehide / visibilitychange. */
  flush(): void;
  create(name: string, from?: Profile): string;
  duplicate(id: string): string;
  rename(id: string, name: string): void;
  /** Removing the last profile replaces it with a fresh "Main". Unknown ids are ignored. */
  remove(id: string): void;
  switchTo(id: string): Profile;
  exportProfile(id?: string): { filename: string; json: string };
  /** Every profile as a store dump (importProfile accepts it back). */
  exportAll(): { filename: string; json: string };
  /** Accepts a bare profile (JSON or the original site's Base64 export), this app's export, or a store dump. Throws a friendly Error. */
  importProfile(text: string, name?: string): string;
  loadUi(): UiPrefs;
  saveUi(p: Partial<UiPrefs>): void;
  /** `message` also carries a one-off notice (corrupt data recovered) until the next change is saved. */
  status(): SaveStatus;
  /** "external": another tab changed the store; reload from load()/list(). */
  subscribe(fn: (e: StoreEvent) => void): () => void;
}

interface Entry { meta: ProfileMeta; data: Profile }
interface StoreFile { version: number; active: string; order: string[]; profiles: Record<string, Entry>; ui: UiPrefs }
interface Incoming { name?: unknown; data: unknown; active?: boolean }

export const STORE_KEY = "dijiang-optimizer/v2";
export const LEGACY_KEYS = ["dijiang-planner-profile"];
export const UI_DEFAULTS: UiPrefs = { tab: "overview", room: "MFG-I", filterRoom: "ALL", filterStatus: "all", sortBy: "rarity" };
const VERSION = 2;
const NAME_MAX = 40;
const IMPORT_MAX = 2_000_000;
const MSG = {
  unavailable: "Browser storage is blocked here, so changes last only until this tab closes. Use Export to keep a copy.",
  quota: "Browser storage is full, so recent changes are not saved. Export your profiles and delete ones you no longer need.",
  empty: "Nothing to import: paste an exported profile or choose a .json file.",
  tooBig: "That file is too large to be a planner profile.",
  badJson: "Could not read that profile: it is not valid JSON (or a Base64 export from the original planner).",
  notProfile: "That is not a Dijiang Optimizer profile: no \"dijiangPlanner\" section was found.",
  newer: "The saved data is from a newer version of the planner, so this tab does not save changes. Reload the page to update.",
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const time = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);
const pad = (n: number) => String(n).padStart(2, "0");

/** Single line, trimmed, at most 40 characters (code points); `fallback` when empty or not a string. */
export function cleanName(raw: unknown, fallback: string): string {
  const s = typeof raw === "string" ? raw.replace(/[\p{Cc}\p{Bidi_Control}]/gu, " ").replace(/\s+/g, " ").trim() : "";
  return s ? [...s].slice(0, NAME_MAX).join("").trim() : fallback;
}

/** `base` cut so that `base + suffix` fits the name limit. */
function fit(base: string, suffix: string): string {
  return [...base].slice(0, NAME_MAX - [...suffix].length).join("").trimEnd() + suffix;
}

function cleanUi(raw: unknown, base: UiPrefs = UI_DEFAULTS): UiPrefs {
  const src = isObj(raw) ? raw : {};
  const pick = (k: keyof UiPrefs) => {
    const v = src[k];
    return typeof v === "string" && v.length > 0 && v.length <= NAME_MAX ? v : base[k];
  };
  return { tab: pick("tab"), room: pick("room"), filterRoom: pick("filterRoom"), filterStatus: pick("filterStatus"), sortBy: pick("sortBy") };
}

function slug(name: string): string {
  const s = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, NAME_MAX).replace(/-+$/, "");
  return s || "profile";
}

function day(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function errorName(e: unknown): string {
  const name = isObj(e) || e instanceof Error ? (e as { name?: unknown }).name : undefined;
  return typeof name === "string" ? name : "unknown error";
}

// Chrome/Safari: QuotaExceededError, Firefox: NS_ERROR_DOM_QUOTA_REACHED, old WebKit: code 22.
const isQuota = (e: unknown) => /quota/i.test(errorName(e)) || (e as { code?: unknown } | null)?.code === 22;

/** The storage to use, or null when it is missing or unusable. A full storage still counts: it can be read. */
function openStorage(given: Storage | null | undefined, key: string): Storage | null {
  try {
    const s = given === undefined ? (typeof window !== "undefined" ? window.localStorage : null) : given;
    if (!s) return null;
    s.getItem(key);
    try {
      s.setItem(`${key}/probe`, "1");
      s.removeItem(`${key}/probe`);
    } catch (e) {
      if (!isQuota(e)) return null;
    }
    return s;
  } catch {
    return null;
  }
}

/** The stored JSON object, or null when the value is not one. */
function parseStored(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** Checked before the layout: a newer version may store its data differently. */
const isNewer = (v: Record<string, unknown> | null): boolean => typeof v?.version === "number" && v.version > VERSION;
const isStoreFile = (v: Record<string, unknown> | null): v is Record<string, unknown> => isObj(v?.profiles);

/** The original site exports Base64 of UTF-8 JSON by default. */
function decodeBase64(s: string): string | null {
  if (typeof atob !== "function" || !/^[A-Za-z0-9+/=_\s-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

function parseImport(text: string): unknown {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) throw new Error(MSG.empty);
  if (t.length > IMPORT_MAX) throw new Error(MSG.tooBig);
  for (const candidate of [t, decodeBase64(t)]) {
    if (candidate === null) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next form
    }
  }
  throw new Error(MSG.badJson);
}

/** Ids of a stored or dumped store whose entries are objects: `order` first, then any others. */
function storedIds(v: Record<string, unknown>, profiles: Record<string, unknown>): string[] {
  const order = Array.isArray(v.order) ? v.order.filter((id): id is string => typeof id === "string") : [];
  return [...new Set([...order, ...Object.keys(profiles)])].filter((id) => has(profiles, id) && isObj(profiles[id]));
}

const looksLikeProfile = (v: unknown) => isObj(v) && (isObj(v.dijiangPlanner) || typeof v.latestVersion === "string");

/** The profiles found in an import: a store dump, a single {meta, data} entry, or a bare profile. */
function incoming(v: unknown): Incoming[] {
  if (!isObj(v)) return [];
  const { profiles } = v;
  if (isObj(profiles)) {
    return storedIds(v, profiles).flatMap((id) => {
      const e = profiles[id] as Record<string, unknown>;
      return looksLikeProfile(e.data) ? [{ name: isObj(e.meta) ? e.meta.name : undefined, data: e.data, active: id === v.active }] : [];
    });
  }
  if (looksLikeProfile(v.data)) return [{ name: isObj(v.meta) ? v.meta.name : v.name, data: v.data }];
  return looksLikeProfile(v) ? [{ data: v }] : [];
}

export function createStore(deps: StoreDeps): Store {
  const key = deps.key ?? STORE_KEY;
  const legacyKeys = deps.legacyKeys ?? LEGACY_KEYS;
  const now = deps.now ?? Date.now;
  const debounceMs = deps.debounceMs ?? 250;
  const uid = deps.uid ?? (() => Math.random().toString(36).slice(2, 10));
  const storage = openStorage(deps.storage, key);
  const listeners = new Set<(e: StoreEvent) => void>();

  let profiles = new Map<string, Entry>();
  let activeId = "";
  let ui: UiPrefs = { ...UI_DEFAULTS };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false; // changes not yet written
  // What this tab changed or removed since it last read or wrote the store: it wins over another tab's data.
  // A profile's name and its data are tracked apart, so a rename here and an edit there both survive.
  const savedData = new Set<string>();
  const renamed = new Set<string>();
  const removed = new Set<string>();
  let frozen = false; // the store was written by a newer version: never overwrite it
  let lastRaw: string | null = null;
  let savedAt: number | null = null;
  let notice: string | undefined;
  let current: SaveStatus = storage ? { state: "saved", at: null } : { state: "unavailable", at: null, message: MSG.unavailable };

  const normalize = (raw: unknown): Profile => {
    try {
      return deps.normalize(raw);
    } catch {
      return deps.defaults();
    }
  };

  /** A stored profile, or null when it is not one (it is then backed up, see keepUnreadable). */
  function readProfile(raw: unknown): Profile | null {
    if (!looksLikeProfile(raw)) return null;
    try {
      return deps.normalize(raw);
    } catch {
      return null;
    }
  }

  function read(k: string): string | null {
    try {
      return storage ? storage.getItem(k) : null;
    } catch {
      return null;
    }
  }

  function emit(e: StoreEvent): void {
    for (const fn of [...listeners]) {
      try {
        fn(e);
      } catch (err) {
        console.error(err);
      }
    }
  }

  function setStatus(next: SaveStatus): void {
    const same = next.state === current.state && next.at === current.at && next.message === current.message;
    current = next;
    if (!same) emit({ type: "status" });
  }

  function newId(): string {
    for (let i = 0; ; i++) {
      const id = i < 8 ? uid() : `${uid()}-${i}`;
      if (id && !profiles.has(id)) return id;
    }
  }

  function uniqueName(name: string, self?: string): string {
    const taken = new Set([...profiles.values()].filter((e) => e.meta.id !== self).map((e) => e.meta.name.toLowerCase()));
    let out = name;
    for (let n = 2; taken.has(out.toLowerCase()); n++) out = fit(name, ` ${n}`);
    return out;
  }

  function addEntry(name: string, data: Profile): string {
    const id = newId();
    const t = now();
    profiles.set(id, { meta: { id, name: uniqueName(name), createdAt: t, updatedAt: t }, data });
    savedData.add(id);
    renamed.add(id);
    return id;
  }

  function entry(id: string): Entry {
    const e = profiles.get(id);
    if (!e) throw new Error(`Profile "${id}" does not exist.`);
    return e;
  }

  /**
   * Replaces the in-memory profiles with stored data, repairing and normalizing it.
   * Returns the entries whose data is not a readable profile (they start from defaults).
   */
  function apply(v: Record<string, unknown>): [string, unknown][] {
    const src = v.profiles as Record<string, unknown>;
    const bad: [string, unknown][] = [];
    profiles = new Map();
    for (const id of storedIds(v, src)) {
      const e = src[id] as Record<string, unknown>;
      const m = isObj(e.meta) ? e.meta : {};
      const t = now();
      const data = readProfile(e.data);
      if (!data) bad.push([id, e]);
      profiles.set(id, {
        meta: { id, name: cleanName(m.name, "Profile"), createdAt: time(m.createdAt, t), updatedAt: time(m.updatedAt, t) },
        data: data ?? deps.defaults(),
      });
    }
    activeId = typeof v.active === "string" && profiles.has(v.active) ? v.active : [...profiles.keys()][0] ?? "";
    ui = cleanUi(v.ui);
    return bad;
  }

  /**
   * Copies unreadable data to `${prefix}-<time>`, unless an earlier visit already kept the same
   * data (else every reload would add a copy while a full storage keeps the original in place).
   * Returns the backup's key, or null when it could not be written.
   */
  function backup(prefix: string, value: string): string | null {
    if (!storage) return null;
    try {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k?.startsWith(`${prefix}-`) && storage.getItem(k) === value) return k;
      }
      const k = `${prefix}-${now()}`;
      storage.setItem(k, value);
      return k;
    } catch {
      return null; // best effort
    }
  }

  /** Unreadable profiles are reset; their stored data is copied to a backup key first. Returns false when that failed. */
  function keepUnreadable(bad: [string, unknown][]): boolean {
    if (!bad.length || frozen) return true;
    const backups = bad.flatMap(([id, e]) => backup(`${key}/corrupt-${id}`, JSON.stringify(e)) ?? []);
    const names = bad.map(([id]) => `"${profiles.get(id)?.meta.name ?? id}"`).join(", ");
    const where = backups.length ? ` A copy of the old data is kept in browser storage under ${backups.map((k) => `"${k}"`).join(", ")}.` : "";
    notice = `The saved data of ${names} could not be read, so it was reset to the defaults.${where}`;
    return backups.length === bad.length;
  }

  /** Stopped writing for good: another tab or a newer deploy of the planner owns the stored data. */
  function freeze(): void {
    frozen = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    setStatus({ state: "error", at: savedAt, message: MSG.newer });
  }

  /**
   * Takes another tab's stored data, keeping this tab's active profile, UI prefs, removals, and the
   * names and data it changed. A profile removed elsewhere comes back only for unsaved data.
   */
  function merge(stored: Record<string, unknown>, raw: string): void {
    const prev = profiles;
    const keepActive = activeId;
    const keepUi = ui;
    keepUnreadable(apply(stored));
    lastRaw = raw;
    for (const id of removed) profiles.delete(id);
    for (const id of new Set([...savedData, ...renamed])) {
      const mine = prev.get(id);
      const theirs = profiles.get(id);
      if (!mine || (!theirs && !savedData.has(id))) continue;
      if (!theirs) {
        profiles.set(id, mine);
        continue;
      }
      const name = renamed.has(id) ? mine.meta.name : theirs.meta.name;
      const updatedAt = Math.max(mine.meta.updatedAt, theirs.meta.updatedAt);
      profiles.set(id, { meta: { ...theirs.meta, name, updatedAt }, data: savedData.has(id) ? mine.data : theirs.data });
    }
    if (!profiles.size) addEntry("Main", deps.defaults());
    activeId = profiles.has(keepActive) ? keepActive : profiles.has(activeId) ? activeId : [...profiles.keys()][0];
    ui = keepUi;
  }

  function snapshot(): StoreFile {
    return { version: VERSION, active: activeId, order: [...profiles.keys()], profiles: Object.fromEntries(profiles), ui };
  }

  function written(): void {
    dirty = false;
    savedData.clear();
    renamed.clear();
    removed.clear();
  }

  function write(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (frozen) return;
    if (!storage) return written();
    // Another tab wrote since we last looked and its storage event is still on its way: merge, do not overwrite.
    const cur = read(key);
    let merged = false;
    if (cur !== null && cur !== lastRaw) {
      const stored = parseStored(cur);
      if (isNewer(stored)) return freeze();
      if (isStoreFile(stored)) {
        merge(stored, cur);
        merged = true;
      } else {
        backup(`${key}/corrupt`, cur); // best effort, then this tab's data replaces it
      }
    }
    const raw = JSON.stringify(snapshot());
    try {
      if (raw !== cur) storage.setItem(key, raw);
      lastRaw = raw;
      written();
      savedAt = now();
      setStatus({ state: "saved", at: savedAt });
    } catch (e) {
      dirty = true; // the next save or flush retries
      setStatus({ state: "error", at: savedAt, message: isQuota(e) ? MSG.quota : `Could not save to browser storage (${errorName(e)}).` });
    }
    // after the caller (e.g. a profile action) has finished with the store
    if (merged) queueMicrotask(() => emit({ type: "external" }));
  }

  /** A user change that is written right away. */
  function commit(): void {
    notice = undefined;
    write();
  }

  function schedule(): void {
    notice = undefined;
    dirty = true;
    if (!storage || frozen) return;
    timer ??= setTimeout(write, debounceMs);
    setStatus({ state: "pending", at: savedAt });
  }

  function flush(): void {
    if (dirty || timer !== null) write();
  }

  function readLegacy(): Profile | null {
    for (const k of legacyKeys) {
      const raw = read(k);
      if (raw === null) continue;
      try {
        return normalize(JSON.parse(raw));
      } catch {
        // unreadable legacy data: try the next key, else start fresh
      }
    }
    return null;
  }

  function boot(): void {
    const raw = read(key);
    const stored = raw === null ? null : parseStored(raw);
    // shown when this version can read it, never overwritten
    if (isNewer(stored)) freeze();
    if (isStoreFile(stored)) {
      const kept = keepUnreadable(apply(stored));
      lastRaw = raw;
      written();
      if (!profiles.size) activeId = addEntry("Main", deps.defaults());
      if (savedData.size || (kept && notice)) write(); // a new Main, or reset profiles now backed up
      return;
    }
    if (raw !== null) {
      activeId = addEntry("Main", deps.defaults());
      if (frozen) return; // a newer version's layout: kept as it is
      // best effort; without a backup the next change overwrites the unreadable data
      const kept = backup(`${key}/corrupt`, raw);
      notice = kept
        ? `Saved data could not be read, so the planner started fresh. The unreadable data is kept in browser storage under "${kept}".`
        : "Saved data could not be read, so the planner started fresh.";
      if (kept) write();
      return;
    }
    activeId = addEntry("Main", readLegacy() ?? deps.defaults());
    write();
  }

  /** Another tab wrote the store: take its profiles, keep this tab's active profile, UI prefs and unsaved edits. */
  function onStorage(e: Event): void {
    const { key: k, storageArea } = e as StorageEvent;
    if (!storage || frozen || (k !== null && k !== key) || (storageArea && storageArea !== storage)) return;
    const raw = read(key);
    if (raw === null || raw === lastRaw) return;
    const stored = parseStored(raw);
    if (isNewer(stored)) return freeze();
    if (!isStoreFile(stored)) return;
    merge(stored, raw);
    if (dirty) write();
    emit({ type: "external" });
  }

  boot();
  const events = deps.events !== undefined ? deps.events : typeof window !== "undefined" ? window : null;
  events?.addEventListener("storage", onStorage);
  events?.addEventListener("pagehide", flush);
  events?.addEventListener("visibilitychange", flush);

  const load = (): Profile => normalize(clone(entry(activeId).data));

  return {
    available: storage !== null,
    list: () => [...profiles.values()].map((e) => ({ ...e.meta })),
    activeId: () => activeId,
    active: () => ({ ...entry(activeId).meta }),
    load,
    save(profile) {
      const e = entry(activeId);
      e.data = clone(profile);
      e.meta.updatedAt = now();
      savedData.add(activeId);
      schedule();
    },
    flush,
    create(name, from) {
      activeId = addEntry(cleanName(name, `Profile ${profiles.size + 1}`), from ? normalize(clone(from)) : deps.defaults());
      commit();
      return activeId;
    },
    duplicate(id) {
      const src = entry(id);
      activeId = addEntry(fit(src.meta.name, " copy"), normalize(clone(src.data)));
      commit();
      return activeId;
    },
    rename(id, name) {
      const e = entry(id);
      e.meta.name = uniqueName(cleanName(name, e.meta.name), id);
      renamed.add(id);
      commit();
    },
    remove(id) {
      if (!profiles.has(id)) return;
      const ids = [...profiles.keys()];
      const at = ids.indexOf(id);
      profiles.delete(id);
      savedData.delete(id);
      renamed.delete(id);
      removed.add(id);
      if (!profiles.size) activeId = addEntry("Main", deps.defaults());
      else if (activeId === id) activeId = ids[at + 1] ?? ids[at - 1];
      commit();
    },
    switchTo(id) {
      entry(id);
      activeId = id;
      commit(); // one write carries the previous profile's pending edits too
      return load();
    },
    exportProfile(id = activeId) {
      const e = entry(id);
      return { filename: `dijiang-${slug(e.meta.name)}-${day(now())}.json`, json: JSON.stringify(normalize(clone(e.data)), null, 2) };
    },
    exportAll: () => ({ filename: `dijiang-all-profiles-${day(now())}.json`, json: JSON.stringify(snapshot(), null, 2) }),
    importProfile(text, name) {
      const found = incoming(parseImport(text));
      if (!found.length) throw new Error(MSG.notProfile);
      const items = found.map((it) => {
        try {
          return { ...it, data: deps.normalize(it.data) };
        } catch {
          throw new Error(MSG.notProfile);
        }
      });
      const named = items.length === 1 ? cleanName(name, "") : "";
      let target = "";
      for (const it of items) {
        const id = addEntry(named || cleanName(it.name, "Imported"), it.data);
        if (!target || it.active) target = id;
      }
      activeId = target;
      commit();
      return target;
    },
    loadUi: () => ({ ...ui }),
    saveUi(p) {
      const next = cleanUi({ ...ui, ...p }, ui);
      if ((Object.keys(next) as (keyof UiPrefs)[]).every((k) => next[k] === ui[k])) return;
      ui = next;
      schedule();
    },
    status() {
      const message = [notice, current.message].filter(Boolean).join(" ");
      return message ? { ...current, message } : { state: current.state, at: current.at };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}
