// Storage layer tests: in-memory Storage fakes, a fake core (defaults/normalize)
// and mocked timers, so they run in plain Node.
// @ts-ignore -- this repo has no @types/node; node:test is untyped here
import { test } from "node:test";
// @ts-ignore -- as above
import assert from "node:assert/strict";
import { createStore, STORE_KEY, type StoreDeps } from "../src/storage.ts";
import type { Profile } from "../src/core/types.ts";

const LEGACY = "dijiang-planner-profile";
const NOW = new Date(2026, 9, 15, 12, 0).getTime(); // local noon, so file dates are stable

type FakeStorage = Storage & { map: Map<string, string>; writes: number; full: boolean };

function memoryStorage(seed: Record<string, string> = {}): FakeStorage {
  const map = new Map(Object.entries(seed));
  const s = {
    map,
    writes: 0,
    full: false,
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem(k: string, v: string) {
      if (s.full) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      s.writes++;
      map.set(k, String(v));
    },
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  return s;
}

function throwingStorage(): Storage {
  const fail = (): never => { throw new DOMException("The operation is insecure.", "SecurityError"); };
  return { get length() { return fail(); }, key: fail, getItem: fail, setItem: fail, removeItem: fail, clear: fail };
}

function defaults(): Profile {
  return {
    latestVersion: "test",
    dijiangPlanner: {
      roomAssignments: {},
      roomSettings: {},
      operatorSkills: {},
      settings: { defaultLevels: [2, 2], prio: "Equal", align: "Staggered", utcOffset: 8 },
    },
    operators: {},
  };
}

let normalizeCalls = 0;
function normalize(raw: unknown): Profile {
  normalizeCalls++;
  const base = defaults();
  if (typeof raw !== "object" || raw === null || !("dijiangPlanner" in raw)) return base;
  const r = raw as Partial<Profile>;
  return {
    latestVersion: "test",
    dijiangPlanner: { ...base.dijiangPlanner, ...r.dijiangPlanner, settings: { ...base.dijiangPlanner.settings, ...r.dijiangPlanner?.settings } },
    operators: { ...r.operators },
  };
}

function withPrio(prio: string): Profile {
  const p = defaults();
  p.dijiangPlanner.settings.prio = prio;
  return p;
}
const prio = (p: Profile) => p.dijiangPlanner.settings.prio;

function setup(over: Partial<StoreDeps> = {}) {
  const clock = { t: NOW };
  const storage = "storage" in over ? over.storage : memoryStorage();
  let n = 0;
  const events = new EventTarget();
  const store = createStore({ defaults, normalize, storage, now: () => clock.t, uid: () => `id${++n}`, events, ...over });
  return { store, storage: storage as FakeStorage, clock, events };
}

const stored = (s: FakeStorage) => JSON.parse(s.map.get(STORE_KEY) ?? "null");
const storageEvent = (key: string | null, storageArea?: Storage) => Object.assign(new Event("storage"), { key, storageArea });

test("fresh install: one Main profile from defaults, persisted in the v2 shape", () => {
  const { store, storage } = setup();
  assert.equal(store.available, true);
  assert.deepEqual(store.list().map((m) => m.name), ["Main"]);
  assert.equal(store.active().name, "Main");
  assert.deepEqual(store.load(), defaults());
  assert.equal(store.status().state, "saved");
  const file = stored(storage);
  assert.equal(file.version, 2);
  assert.equal(file.active, store.activeId());
  assert.deepEqual(file.order, [store.activeId()]);
  assert.deepEqual(Object.keys(file.profiles[store.activeId()]), ["meta", "data"]);
  assert.deepEqual(file.ui, store.loadUi());
  assert.deepEqual([...storage.map.keys()], [STORE_KEY]); // probe key cleaned up

  const again = createStore({ defaults, normalize, storage, events: null });
  assert.equal(again.activeId(), store.activeId());
});

test("legacy migration imports the Python profile as Main and leaves the legacy key alone", () => {
  const legacyRaw = JSON.stringify(withPrio("Higher"));
  const storage = memoryStorage({ [LEGACY]: legacyRaw });
  const { store } = setup({ storage });
  assert.deepEqual(store.list().map((m) => m.name), ["Main"]);
  assert.equal(prio(store.load()), "Higher");
  assert.equal(storage.map.get(LEGACY), legacyRaw);
  assert.ok(storage.map.has(STORE_KEY));

  // Once migrated, the new key wins over the legacy one.
  store.save(withPrio("Lower"));
  store.flush();
  const again = createStore({ defaults, normalize, storage, events: null });
  assert.equal(prio(again.load()), "Lower");
  assert.equal(storage.map.get(LEGACY), legacyRaw);
});

test("unreadable legacy data starts fresh", () => {
  const storage = memoryStorage({ [LEGACY]: "{oops" });
  const { store } = setup({ storage });
  assert.deepEqual(store.load(), defaults());
  assert.equal(storage.map.get(LEGACY), "{oops");
});

test("create, duplicate, rename, remove and switch profiles", () => {
  const { store, storage } = setup();
  const main = store.activeId();
  store.save(withPrio("Main prio"));

  const alt = store.create("  Alt\nplan ", withPrio("Alt prio"));
  assert.equal(store.activeId(), alt);
  assert.equal(store.active().name, "Alt plan");
  assert.equal(prio(store.load()), "Alt prio");
  assert.equal(stored(storage).active, alt); // structural changes are written at once

  const blank = store.create("");
  assert.equal(store.active().name, "Profile 3");
  assert.deepEqual(store.load(), defaults());

  const copy = store.duplicate(alt);
  assert.equal(store.activeId(), copy);
  assert.equal(store.active().name, "Alt plan copy");
  assert.equal(prio(store.load()), "Alt prio");
  const copy2 = store.duplicate(alt);
  assert.equal(store.active().name, "Alt plan copy 2");

  store.rename(blank, "x".repeat(60));
  assert.equal(store.list().find((m) => m.id === blank)?.name, "x".repeat(40));
  store.rename(blank, "main"); // names stay unique, case-insensitively
  assert.equal(store.list().find((m) => m.id === blank)?.name, "main 2");
  store.rename(blank, "   ");
  assert.equal(store.list().find((m) => m.id === blank)?.name, "main 2");
  assert.throws(() => store.rename("nope", "x"), /does not exist/);

  assert.deepEqual(store.list().map((m) => m.id), [main, alt, blank, copy, copy2]);

  assert.equal(prio(store.switchTo(main)), "Main prio");
  assert.equal(store.activeId(), main);
  assert.throws(() => store.switchTo("nope"), /does not exist/);

  store.switchTo(alt);
  store.remove(alt); // active removed: the next profile takes over
  assert.equal(store.activeId(), blank);
  store.remove("nope");
  for (const m of store.list()) store.remove(m.id);
  assert.equal(store.list().length, 1);
  assert.equal(store.active().name, "Main");
  assert.notEqual(store.activeId(), main);
  assert.deepEqual(store.load(), defaults());

  const again = createStore({ defaults, normalize, storage, events: null });
  assert.deepEqual(again.list(), store.list());
});

test("switchTo writes the previous profile's pending edits", () => {
  const { store, storage } = setup();
  const main = store.activeId();
  const alt = store.create("Alt");
  store.switchTo(main);
  store.save(withPrio("unsaved"));
  store.switchTo(alt);
  const again = createStore({ defaults, normalize, storage, events: null });
  assert.equal(again.activeId(), alt);
  assert.equal(prio(again.switchTo(main)), "unsaved");
});

test("save is debounced; flush and pagehide write at once", (t: { mock: { timers: { enable(o: object): void; tick(ms: number): void } } }) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, storage, clock, events } = setup();
  const writes = storage.writes;

  clock.t += 1000;
  store.save(withPrio("a"));
  store.save(withPrio("b"));
  assert.equal(store.status().state, "pending");
  assert.equal(store.active().updatedAt, clock.t);
  t.mock.timers.tick(249);
  assert.equal(storage.writes, writes);
  store.save(withPrio("c")); // does not push the write further out
  t.mock.timers.tick(1);
  assert.equal(storage.writes, writes + 1);
  assert.equal(prio(normalize(stored(storage).profiles[store.activeId()].data)), "c");
  assert.deepEqual(store.status(), { state: "saved", at: clock.t });

  store.save(withPrio("d"));
  store.flush();
  assert.equal(storage.writes, writes + 2);
  assert.equal(store.status().state, "saved");
  t.mock.timers.tick(1000); // the cancelled timer does not write again
  assert.equal(storage.writes, writes + 2);

  store.save(withPrio("e"));
  events.dispatchEvent(new Event("pagehide"));
  assert.equal(prio(normalize(stored(storage).profiles[store.activeId()].data)), "e");
  store.flush(); // nothing pending: no write
  assert.equal(storage.writes, writes + 3);
});

test("save keeps its own copy of the profile", () => {
  const { store } = setup();
  const p = withPrio("kept");
  store.save(p);
  p.dijiangPlanner.settings.prio = "mutated later";
  assert.equal(prio(store.load()), "kept");
  const loaded = store.load();
  loaded.dijiangPlanner.settings.prio = "mutated copy";
  assert.equal(prio(store.load()), "kept");
});

test("export and import round trip", () => {
  const { store } = setup();
  store.rename(store.activeId(), "My Plan: Résumé #1");
  store.save(withPrio("Exported"));

  const { filename, json } = store.exportProfile();
  assert.equal(filename, "dijiang-my-plan-resume-1-2026-10-15.json");
  assert.match(json, /\n  "dijiangPlanner"/); // pretty-printed
  assert.deepEqual(Object.keys(JSON.parse(json)), ["latestVersion", "dijiangPlanner", "operators"]);

  const id = store.importProfile(json);
  assert.equal(store.activeId(), id);
  assert.equal(store.active().name, "Imported");
  assert.equal(prio(store.load()), "Exported");

  store.importProfile(json, "  Friend's\tplan  ");
  assert.equal(store.active().name, "Friend's plan");
  store.importProfile(json, "y".repeat(100));
  assert.equal(store.active().name, "y".repeat(40));
  store.importProfile(json);
  assert.equal(store.active().name, "Imported 2");

  // a {meta, data} entry carries its (sanitized) name
  store.importProfile(JSON.stringify({ meta: { name: "\u202eEvil\u0000" }, data: withPrio("entry") }));
  assert.equal(store.active().name, "Evil");
  assert.equal(prio(store.load()), "entry");

  // the original site's default export: Base64 of UTF-8 JSON, with extra planners
  const original = { ...withPrio("Original 🌱"), essencePlanner: { x: 1 } };
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(original))));
  store.importProfile(b64);
  assert.equal(prio(store.load()), "Original 🌱");
  assert.equal("essencePlanner" in store.load(), false);

  assert.equal(store.exportProfile(id).filename, "dijiang-imported-2026-10-15.json");
  assert.throws(() => store.exportProfile("nope"), /does not exist/);
});

test("importing a whole store dump adds every profile and activates the dump's active one", () => {
  const a = setup();
  a.store.save(withPrio("main"));
  const alt = a.store.create("Alt", withPrio("alt"));
  a.store.create("Third", withPrio("third"));
  a.store.switchTo(alt);
  const dump = a.store.exportAll();
  assert.equal(dump.filename, "dijiang-all-profiles-2026-10-15.json");
  // the raw stored value is a dump too
  const raw = a.storage.map.get(STORE_KEY) ?? "";

  const b = setup();
  const id = b.store.importProfile(dump.json);
  assert.deepEqual(b.store.list().map((m) => m.name), ["Main", "Main 2", "Alt", "Third"]);
  assert.equal(b.store.activeId(), id);
  assert.equal(b.store.active().name, "Alt");
  assert.equal(prio(b.store.load()), "alt");
  assert.equal(new Set(b.store.list().map((m) => m.id)).size, 4); // fresh ids, no clashes

  b.store.importProfile(raw);
  assert.equal(b.store.list().length, 7);
});

test("garbage imports throw a friendly error and change nothing", () => {
  const { store, storage } = setup();
  const before = storage.map.get(STORE_KEY);
  const cases: [string, RegExp][] = [
    ["", /Nothing to import/],
    ["   ", /Nothing to import/],
    ["not json at all", /not valid JSON/],
    ["{\"dijiangPlanner\": ", /not valid JSON/],
    ["[1, 2, 3]", /not a Dijiang Optimizer profile/],
    ["42", /not a Dijiang Optimizer profile/],
    ["null", /not a Dijiang Optimizer profile/],
    ["{\"foo\": 1}", /not a Dijiang Optimizer profile/],
    ["{\"version\": 2, \"profiles\": {}}", /not a Dijiang Optimizer profile/],
    ["{\"profiles\": {\"a\": {\"meta\": {}, \"data\": 5}}}", /not a Dijiang Optimizer profile/],
    ["x".repeat(2_000_001), /too large/],
  ];
  for (const [text, msg] of cases) assert.throws(() => store.importProfile(text), (e: unknown) => e instanceof Error && msg.test(e.message));
  assert.equal(store.list().length, 1);
  assert.equal(storage.map.get(STORE_KEY), before);
});

test("corrupted data is backed up, the app starts fresh and says so until the next save", () => {
  const storage = memoryStorage({ [STORE_KEY]: "{\"version\": 2, \"profi" });
  const { store, clock } = setup({ storage });
  assert.deepEqual(store.list().map((m) => m.name), ["Main"]);
  const backupKey = `${STORE_KEY}/corrupt-${NOW}`;
  assert.equal(storage.map.get(backupKey), "{\"version\": 2, \"profi");
  assert.equal(store.status().state, "saved");
  assert.match(store.status().message ?? "", /could not be read/);
  assert.match(store.status().message ?? "", new RegExp(backupKey));
  assert.equal(stored(storage).version, 2); // fresh store written

  clock.t += 5;
  store.save(withPrio("new"));
  store.flush();
  assert.equal(store.status().message, undefined);
  assert.equal(storage.map.get(backupKey), "{\"version\": 2, \"profi");
});

test("wrongly shaped stored data counts as corrupt", () => {
  for (const raw of ["[]", "42", "{\"version\": 2}"]) {
    const storage = memoryStorage({ [STORE_KEY]: raw });
    const { store } = setup({ storage });
    assert.equal(store.list().length, 1);
    assert.match(store.status().message ?? "", /could not be read/);
  }
});

test("hand-edited stored data is repaired and every profile goes through normalize", () => {
  const raw = JSON.stringify({
    version: 2,
    active: "missing",
    order: ["b", 7, "a", "ghost"],
    profiles: {
      a: { meta: { name: 123, createdAt: "yesterday" }, data: "not a profile" },
      b: { meta: { name: "  Bee  ", createdAt: 5, updatedAt: 6 }, data: { dijiangPlanner: { settings: { prio: "Edited" } } } },
      c: 5,
    },
    ui: { tab: 42, room: "GC" },
  });
  const storage = memoryStorage({ [STORE_KEY]: raw });
  normalizeCalls = 0;
  const { store } = setup({ storage });
  assert.ok(normalizeCalls >= 1);
  // "a" holds no profile: it is reset, and its old data is backed up and named in a notice
  const backupKey = `${STORE_KEY}/corrupt-a-${NOW}`;
  assert.deepEqual(JSON.parse(storage.map.get(backupKey) ?? "null"), JSON.parse(raw).profiles.a);
  assert.match(store.status().message ?? "", /"Profile" could not be read/);
  assert.ok((store.status().message ?? "").includes(backupKey));
  assert.deepEqual(stored(storage).profiles.a.data, defaults()); // written, so the next start does not back it up again
  assert.deepEqual(store.list(), [
    { id: "b", name: "Bee", createdAt: 5, updatedAt: 6 },
    { id: "a", name: "Profile", createdAt: NOW, updatedAt: NOW },
  ]);
  assert.equal(store.activeId(), "b");
  const loaded = store.load();
  assert.equal(prio(loaded), "Edited");
  assert.deepEqual(loaded.dijiangPlanner.roomAssignments, {});
  assert.equal(loaded.dijiangPlanner.settings.utcOffset, 8);
  assert.deepEqual(store.switchTo("a"), defaults());
  assert.deepEqual(store.loadUi(), { tab: "overview", room: "GC", filterRoom: "ALL", filterStatus: "all" });
});

test("throwing or missing storage falls back to memory with the same API", () => {
  for (const storage of [throwingStorage(), null, undefined]) {
    const { store } = setup({ storage });
    assert.equal(store.available, false);
    assert.equal(store.status().state, "unavailable");
    assert.match(store.status().message ?? "", /blocked/);
    store.save(withPrio("memory"));
    store.flush();
    assert.equal(prio(store.load()), "memory");
    assert.equal(store.status().state, "unavailable");
    const alt = store.create("Alt");
    store.saveUi({ tab: "roster" });
    assert.equal(store.loadUi().tab, "roster");
    const id = store.importProfile(store.exportProfile(alt).json, "Copy");
    assert.equal(store.switchTo(id).latestVersion, "test");
    store.remove(id);
    assert.equal(store.list().length, 2);
  }
});

test("quota errors are reported in status, not thrown, and retried on the next flush", () => {
  const { store, storage } = setup();
  const statuses: string[] = [];
  store.subscribe(() => statuses.push(store.status().state));
  storage.full = true;
  store.save(withPrio("big"));
  assert.doesNotThrow(() => store.flush());
  const s = store.status();
  assert.equal(s.state, "error");
  assert.match(s.message ?? "", /storage is full/);
  assert.equal(typeof s.at, "number");
  assert.doesNotThrow(() => store.create("Another"));
  assert.equal(store.status().state, "error");

  storage.full = false;
  store.flush();
  assert.equal(store.status().state, "saved");
  assert.equal(store.status().message, undefined);
  assert.deepEqual(statuses, ["pending", "error", "saved"]);
  const again = createStore({ defaults, normalize, storage, events: null });
  assert.equal(again.list().length, 2);
  assert.equal(prio(again.switchTo(again.list()[0].id)), "big");
});

test("a full storage is still read at startup", () => {
  const { storage } = setup();
  const first = createStore({ defaults, normalize, storage, events: null });
  first.save(withPrio("kept"));
  first.flush();
  storage.full = true;
  const again = createStore({ defaults, normalize, storage, events: null });
  assert.equal(again.available, true);
  assert.equal(prio(again.load()), "kept");
});

test("UI prefs: defaults, partial updates, validation and persistence", () => {
  const { store, storage } = setup();
  assert.deepEqual(store.loadUi(), { tab: "overview", room: "MFG-I", filterRoom: "ALL", filterStatus: "all" });
  const updatedAt = store.active().updatedAt;
  store.saveUi({ tab: "roster", filterRoom: "GC" });
  store.saveUi({ room: 5 as unknown as string, filterStatus: "z".repeat(41) }); // ignored
  store.flush();
  assert.deepEqual(store.loadUi(), { tab: "roster", room: "MFG-I", filterRoom: "GC", filterStatus: "all" });
  assert.equal(store.active().updatedAt, updatedAt);
  const again = createStore({ defaults, normalize, storage, events: null });
  assert.deepEqual(again.loadUi(), store.loadUi());
});

test("subscribe: status changes, unsubscribe", () => {
  const { store } = setup();
  const seen: string[] = [];
  const off = store.subscribe((e) => seen.push(e.type));
  store.save(withPrio("a"));
  store.save(withPrio("b")); // still pending: no new event
  store.flush();
  assert.deepEqual(seen, ["status", "status"]);
  off();
  store.save(withPrio("c"));
  store.flush();
  assert.deepEqual(seen, ["status", "status"]);
});

test("another tab's write triggers an external event and keeps this tab's active profile, UI and unsaved edits", () => {
  const storage = memoryStorage();
  const a = setup({ storage });
  const main = a.store.activeId();
  const b = createStore({ defaults, normalize, storage, events: null, uid: () => "fromB" });
  const seen: string[] = [];
  a.store.subscribe((e) => seen.push(e.type));

  a.store.saveUi({ tab: "settings" });
  a.store.flush();
  b.create("From B", withPrio("b"));
  b.saveUi({ tab: "roster" });
  b.flush();

  a.store.save(withPrio("a unsaved"));
  a.events.dispatchEvent(storageEvent("unrelated", storage));
  a.events.dispatchEvent(storageEvent(STORE_KEY, memoryStorage())); // sessionStorage or another area
  assert.deepEqual(seen, ["status", "status", "status"]);

  a.events.dispatchEvent(storageEvent(STORE_KEY, storage));
  assert.equal(seen.at(-1), "external");
  assert.deepEqual(a.store.list().map((m) => m.name), ["Main", "From B"]);
  assert.equal(a.store.activeId(), main);
  assert.equal(a.store.loadUi().tab, "settings");
  assert.equal(prio(a.store.load()), "a unsaved");
  // the unsaved edit was written on top of B's change
  const file = stored(storage);
  assert.deepEqual(Object.keys(file.profiles), [main, "fromB"]);
  assert.equal(prio(normalize(file.profiles[main].data)), "a unsaved");

  // a clear() in another tab (key null) with nothing new to read is ignored
  const count = seen.length;
  a.events.dispatchEvent(storageEvent(null, storage));
  assert.equal(seen.length, count);
});

test("a stored profile the planner cannot read is reset only after a backup, never silently", () => {
  const entry = (data: unknown) => ({ meta: { id: "x", name: "Keep me", createdAt: 1, updatedAt: 1 }, data });
  const file = (data: unknown) => JSON.stringify({ version: 2, active: "x", order: ["x"], profiles: { x: entry(data) }, ui: {} });
  const throwing = (raw: unknown): Profile => {
    if ((raw as { dijiangPlanner?: unknown }).dijiangPlanner === "boom") throw new TypeError("corrupt");
    return normalize(raw);
  };
  for (const data of [{}, 5, null, { foo: 1 }, { dijiangPlanner: "boom" }]) {
    const storage = memoryStorage({ [STORE_KEY]: file(data) });
    const { store } = setup({ storage, normalize: throwing });
    assert.match(store.status().message ?? "", /"Keep me" could not be read/, JSON.stringify(data));
    assert.deepEqual(JSON.parse(storage.map.get(`${STORE_KEY}/corrupt-x-${NOW}`) ?? "null"), entry(data));
    assert.deepEqual(store.load(), defaults());
  }
  // no backup possible (storage full): the old data stays until the next change
  const storage = memoryStorage({ [STORE_KEY]: file({}) });
  storage.full = true;
  const { store } = setup({ storage });
  assert.match(store.status().message ?? "", /could not be read, so it was reset to the defaults\.$/);
  assert.deepEqual(stored(storage).profiles.x.data, {});
});

test("data written by a newer version is shown but never overwritten", () => {
  const raw = JSON.stringify({ version: 3, active: "x", order: ["x"], profiles: { x: { meta: { name: "Future" }, data: withPrio("future") } }, ui: {} });
  const storage = memoryStorage({ [STORE_KEY]: raw });
  const { store } = setup({ storage });
  assert.equal(prio(store.load()), "future");
  assert.equal(store.status().state, "error");
  assert.match(store.status().message ?? "", /newer version/);
  store.save(withPrio("edited"));
  store.create("New");
  store.saveUi({ tab: "roster" });
  store.flush();
  assert.equal(storage.map.get(STORE_KEY), raw);
  assert.equal(prio(store.load()), "Equal"); // the new profile, kept in memory only
  assert.equal(store.list().length, 2);

  // an older tab that sees a newer version arrive stops writing too
  const s2 = memoryStorage();
  const a = setup({ storage: s2 });
  s2.map.set(STORE_KEY, raw);
  a.events.dispatchEvent(storageEvent(STORE_KEY, s2));
  a.store.save(withPrio("old tab"));
  a.store.flush();
  assert.equal(s2.map.get(STORE_KEY), raw);
  assert.match(a.store.status().message ?? "", /newer version/);
});

test("a write merges another tab's change whose storage event has not arrived yet", async () => {
  const storage = memoryStorage();
  const a = setup({ storage });
  const main = a.store.activeId();
  const b = createStore({ defaults, normalize, storage, events: null, uid: () => "fromB" });
  const seen: string[] = [];
  b.subscribe((e) => seen.push(e.type));

  a.store.create("Created in A");
  const created = a.store.activeId();
  // B, not yet notified, edits Main and writes: A's new profile must survive
  b.save(withPrio("b edit"));
  b.flush();
  let file = stored(storage);
  assert.deepEqual(file.order, [main, created]);
  assert.equal(prio(normalize(file.profiles[main].data)), "b edit");
  assert.equal(file.active, main); // B's own active profile
  await Promise.resolve();
  assert.deepEqual(seen.filter((t) => t === "external"), ["external"]); // B's UI reloads the merged list
  assert.deepEqual(b.list().map((m) => m.name), ["Main", "Created in A"]);

  // a removal in this tab wins over the other tab's stale copy
  a.events.dispatchEvent(storageEvent(STORE_KEY, storage));
  b.remove(created);
  a.store.rename(main, "Renamed in A");
  file = stored(storage);
  assert.deepEqual(file.order, [main]);
  assert.equal(file.profiles[main].meta.name, "Renamed in A");
  assert.equal(prio(normalize(file.profiles[main].data)), "b edit");
});

test("a newer version's data is never overwritten, even in a layout this version cannot read", () => {
  for (const v3 of [{ version: 3, profiles: [{ name: "Future" }] }, { version: 3, slots: { a: {} } }]) {
    const raw = JSON.stringify(v3);
    const storage = memoryStorage({ [STORE_KEY]: raw });
    const { store } = setup({ storage });
    assert.match(store.status().message ?? "", /newer version/);
    assert.deepEqual(store.list().map((m) => m.name), ["Main"]); // in memory only
    store.save(withPrio("edited"));
    store.flush();
    assert.equal(storage.map.get(STORE_KEY), raw);
    assert.deepEqual([...storage.map.keys()], [STORE_KEY]); // not treated as corrupt: no backup

    // a tab that is already open stops writing when such data arrives (event or not)
    const s2 = memoryStorage();
    const a = setup({ storage: s2 });
    s2.map.set(STORE_KEY, raw);
    a.store.save(withPrio("old tab"));
    a.store.flush();
    assert.equal(s2.map.get(STORE_KEY), raw);
    assert.match(a.store.status().message ?? "", /newer version/);
  }
});

test("unreadable data another tab left behind is backed up before a write replaces it", () => {
  const storage = memoryStorage();
  const { store, clock } = setup({ storage });
  storage.map.set(STORE_KEY, "{not json");
  clock.t += 1000;
  store.save(withPrio("mine"));
  store.flush();
  assert.equal(storage.map.get(`${STORE_KEY}/corrupt-${NOW + 1000}`), "{not json");
  assert.equal(prio(normalize(stored(storage).profiles[store.activeId()].data)), "mine");
});

test("an unreadable profile is backed up once, not on every reload of a nearly full storage", () => {
  const entry = { meta: { id: "x", name: "Half", createdAt: 1, updatedAt: 1 }, data: { note: "half-written" } };
  const file = JSON.stringify({ version: 2, active: "a", order: ["a", "x"], profiles: { a: { meta: { id: "a", name: "Main" }, data: defaults() }, x: entry }, ui: {} });
  const storage = memoryStorage({ [STORE_KEY]: file });
  // room for one backup, not for the repaired store
  const room = JSON.stringify(entry).length + 64;
  const used = () => [...storage.map].reduce((n, [k, v]) => n + k.length + v.length, 0);
  const limit = used() + room;
  const setItem = storage.setItem;
  storage.setItem = (k: string, v: string) => {
    if (used() - (storage.map.get(k)?.length ?? 0) + v.length + k.length > limit) throw new DOMException("full", "QuotaExceededError");
    setItem(k, v);
  };
  const backups = () => [...storage.map.keys()].filter((k) => k.startsWith(`${STORE_KEY}/corrupt-x-`));
  for (let reload = 0; reload < 4; reload++) {
    const { store } = setup({ storage, now: () => NOW + reload * 1000 });
    assert.match(store.status().message ?? "", /"Half" could not be read.*corrupt-x-/);
    assert.equal(backups().length, 1, `reload ${reload}`);
  }
});

test("a pending edit in one tab does not undo a rename in another, and the other way round", () => {
  const storage = memoryStorage();
  const a = setup({ storage });
  const main = a.store.activeId();
  const b = createStore({ defaults, normalize, storage, events: null, uid: () => "fromB" });

  b.save(withPrio("b edit")); // debounced, not written yet
  a.store.rename(main, "Weekly plan");
  b.flush();
  let file = stored(storage);
  assert.equal(file.profiles[main].meta.name, "Weekly plan");
  assert.equal(prio(normalize(file.profiles[main].data)), "b edit");
  assert.equal(b.active().name, "Weekly plan");

  // A's pending edit, then B renames: A's write keeps B's name
  a.events.dispatchEvent(storageEvent(STORE_KEY, storage));
  a.store.save(withPrio("a edit"));
  b.rename(main, "Daily plan");
  a.store.flush();
  file = stored(storage);
  assert.equal(file.profiles[main].meta.name, "Daily plan");
  assert.equal(prio(normalize(file.profiles[main].data)), "a edit");
});

test("a profile removed in another tab comes back only for unsaved data, not for a rename", () => {
  const storage = memoryStorage();
  const a = setup({ storage });
  const keep = a.store.activeId();
  const gone = a.store.create("Gone");
  const b = createStore({ defaults, normalize, storage, events: null, uid: () => "fromB" });
  b.switchTo(gone);

  // B renames, its write fails (full), A removes the profile: the rename alone does not bring it back
  storage.full = true;
  b.rename(gone, "Renamed in B");
  storage.full = false;
  a.store.remove(gone);
  b.flush();
  assert.deepEqual(stored(storage).order, [keep]);
  assert.deepEqual(b.list().map((m) => m.id), [keep]);

  // unsaved data does bring it back, so no edit is lost
  const again = a.store.create("Again");
  a.events.dispatchEvent(storageEvent(STORE_KEY, storage));
  const c = createStore({ defaults, normalize, storage, events: null, uid: () => "fromC" });
  c.switchTo(again);
  c.save(withPrio("c edit"));
  a.store.remove(again);
  c.flush();
  assert.deepEqual(stored(storage).order, [keep, again]);
  assert.equal(prio(normalize(stored(storage).profiles[again].data)), "c edit");
});
