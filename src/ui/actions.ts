// Event handlers: every change goes through commit(), which keeps the slots in
// sync with the shifts, autosaves and re-renders.
import {
  OPS, PRIO_MAX, ROOM_DATA, ROOM_IDS, defaultProfile, fmt3, getShiftSettings, keepsHours, planShip, priorityLevels, priorityOn, resetShift, roomOn, roomType,
  setDefaultLevel, setSkillLevel, shiftSlot, shiftWindows, swapShift, syncSlots, windowLength,
} from "../core/index.ts";
import type { PlanResult, Profile, RoomSettings, ShiftSettings } from "../core/index.ts";
import { download, nameFromFile } from "./files.ts";
import {
  focusKey, focusSelector, render, renderDraft, renderPickGrid, renderPicker, renderRoster, renderRosterFilters, renderRosterGrid,
  renderSelectedRoom, updateSaveBadge,
} from "./render.ts";
import { S, dp, opLists } from "./state.ts";
import type { Tab } from "./state.ts";
import { hideTip } from "./tooltip.ts";
import { barOf, draftOf, sameBar } from "./views/overview.ts";

/** Where focus returns when the picker closes. */
let pickerReturn: string | null = null;

/** `paint`: renderRoster for roster edits, which re-render only what changed. */
export function commit(paint: () => void = render): void {
  S.profile = syncSlots(S.profile);
  S.rev++;
  S.store.save(S.profile);
  paint();
}

/** The store's active profile changed (switch, import, delete, another tab). */
export function loadActive(): void {
  S.profile = S.store.load();
  S.profileId = S.store.activeId();
  S.rev++;
  S.drafts = {};
  S.picker = null;
  S.optNote = null;
}

/** Another tab changed the store: show its data, keep this tab's view of the same profile. */
export function reloadFromStore(): void {
  const { drafts, picker } = S;
  const same = S.store.activeId() === S.profileId;
  const confirmed = Object.fromEntries(Object.keys(drafts).map((r) => [r, getShiftSettings(S.profile, r)]));
  loadActive();
  if (same) {
    S.picker = picker;
    // a bar edit survives unless the other tab changed that room's schedule or hid the bar (as this tab would drop it then)
    for (const [room, bar] of Object.entries(drafts)) {
      const sh = getShiftSettings(S.profile, room);
      if (sh.enabled && sh.autoRotate && sameBar(sh, confirmed[room])) S.drafts[room] = bar;
    }
  }
  render();
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function setRoomSetting<K extends keyof RoomSettings>(roomId: string, key: K, value: RoomSettings[K]): void {
  (dp().roomSettings[roomId] ??= {})[key] = value;
}

const setShift = (roomId: string, sh: ShiftSettings): void => setRoomSetting(roomId, "shift", sh);

/** An operator can only be in one place. */
function removeEverywhere(opId: string): void {
  for (const slots of Object.values(dp().roomAssignments)) {
    slots.forEach((op, k) => {
      if (op && op.id === opId) slots[k] = null;
    });
  }
}

function assign(slot: string, i: number, opId: string | null): void {
  const ra = dp().roomAssignments;
  if (opId) removeEverywhere(opId);
  if (ra[slot]) ra[slot][i] = opId ? { id: opId, fixed: true } : null;
}

/** One line on what Optimize did: the gain, and in full mode the shifts and Control Nexus it chose. */
export function optimizeNote(res: PlanResult, keep: boolean, changed: boolean, drafted = false): string {
  if (!changed) return `Optimize found no better plan than the one you have.${drafted ? " Press Confirm to keep your new shift hours." : ""}`;
  const gain = res.before > 0 ? (res.score / res.before - 1) * 100 : null;
  const weighted = priorityOn(res.profile) ? " (rooms weighted by your room priority)" : "";
  let out = gain === null ? "Optimized: new plan." : `Optimized: ${fmt3(gain)}% more output than before${weighted}.`;
  if (keep) return `${out} Your shift hours were kept.`;
  const p: Profile = res.profile;
  const lens: number[] = [];
  for (const rid of ROOM_IDS) {
    const sh = getShiftSettings(p, rid);
    if (rid !== "CN" && sh.enabled) lens.push(windowLength(shiftWindows(sh).A) / 60);
  }
  const [lo, hi] = [Math.min(...lens), Math.max(...lens)];
  out += lens.length ? ` Shift B in ${lens.length} room${lens.length > 1 ? "s" : ""}, Shift A ${lo === hi ? lo : `${lo}-${hi}`}h.` : " No Shift B.";
  const ra = p.dijiangPlanner.roomAssignments;
  const cn = [...(ra.CN ?? []), ...(ra[shiftSlot("CN", "B")] ?? [])].filter(Boolean).length;
  const cnShift = getShiftSettings(p, "CN").enabled;
  if (roomOn(p, "CN")) out += cn ? ` Control Nexus: ${cn} operator${cn > 1 ? "s" : ""}${cnShift ? " in 2 shifts" : ""}.` : " Control Nexus left empty: those operators give more in the rooms.";
  const off = ROOM_IDS.filter((rid) => !roomOn(p, rid)).map((rid) => `${ROOM_DATA[roomType(rid)].name} (${rid})`);
  if (off.length) out += ` Switched off: ${off.join(", ")}.`;
  return out;
}

/** The profile as the page shows it, with bars moved but not confirmed yet, so Optimize starts from what you see. */
export function withDrafts(profile: Profile): Profile {
  if (!Object.keys(S.drafts).length) return profile;
  const p = structuredClone(profile);
  for (const room of Object.keys(S.drafts)) (p.dijiangPlanner.roomSettings[room] ??= {}).shift = draftOf(room);
  return p;
}

/** Plan the whole ship. It can take a moment on a slow device, so the button shows it is working first. */
function optimize(btn: HTMLElement): void {
  if (btn.hasAttribute("disabled")) return;
  const label = btn.innerHTML;
  btn.setAttribute("disabled", "");
  btn.textContent = "PLANNING…";
  window.setTimeout(() => {
    try {
      const keep = keepsHours(S.profile);
      const drafted = Object.keys(S.drafts).length > 0;
      const res = planShip(OPS, withDrafts(S.profile), opLists().available, { keepHours: keep });
      const changed = res.score > res.before + 1e-9;
      if (changed) {
        S.profile = res.profile; // with "Keep mine" this holds the moved bars too
        S.drafts = {};
      }
      S.optNote = optimizeNote(res, keep, changed, drafted);
    } finally {
      btn.removeAttribute("disabled");
      btn.innerHTML = label;
    }
    commit();
  }, 30);
}

function closePicker(): void {
  S.picker = null;
  renderPicker();
  focusSelector(pickerReturn);
}

function startRename(id: string): void {
  S.renaming = id;
  render();
  const input = document.getElementById("rename-input") as HTMLInputElement | null;
  input?.focus();
  input?.select();
}

function finishRename(save: boolean): void {
  const input = document.getElementById("rename-input") as HTMLInputElement | null;
  const id = S.renaming;
  S.renaming = null;
  if (save && id && input) S.store.rename(id, input.value);
  render();
  if (id) focusSelector(`[data-act="profile-rename"][data-id="${CSS.escape(id)}"]`);
}

function afterImport(id: string): void {
  loadActive();
  const name = S.store.list().find((m) => m.id === id)?.name ?? "profile";
  S.ioMsg = { text: `Imported "${name}" as a new profile and switched to it.`, error: false };
}

async function importFile(input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  if (!file) return;
  try {
    afterImport(S.store.importProfile(await file.text(), nameFromFile(file.name)));
  } catch (e) {
    S.ioMsg = { text: errorText(e), error: true };
  }
  render();
}

function exportFile(out: { filename: string; json: string }): void {
  download(out.filename, out.json);
  S.ioMsg = { text: `Downloaded ${out.filename}.`, error: false };
  render();
}

/** Profile manager actions; they write to the store right away. */
function profileAction(act: string, id: string): void {
  const { store } = S;
  const name = (): string => store.list().find((m) => m.id === id)?.name ?? "";
  switch (act) {
    case "profile-switch":
      store.switchTo(id);
      loadActive();
      break;
    case "profile-new":
      store.create("");
      loadActive();
      startRename(store.activeId());
      return;
    case "profile-duplicate":
      store.duplicate(id);
      loadActive();
      break;
    case "profile-rename":
      startRename(id);
      return;
    case "profile-rename-save":
    case "profile-rename-cancel":
      finishRename(act === "profile-rename-save");
      return;
    case "profile-delete":
      if (!window.confirm(`Delete the profile "${name()}"? This cannot be undone. Export it first if you may need it again.`)) return;
      store.remove(id);
      loadActive();
      break;
    case "profile-export":
      exportFile(store.exportProfile(id));
      return;
    case "profile-export-all":
      exportFile(store.exportAll());
      return;
    default:
      return;
  }
  S.ioMsg = null;
  render();
}

export function onClick(evt: MouseEvent): void {
  const target = evt.target instanceof Element ? evt.target : null;
  const el = target?.closest<HTMLElement>("[data-act]");
  if (!target || !el) return;
  const act = el.dataset.act ?? "";
  const d = el.dataset;
  if (act === "close-picker" && el.classList.contains("modal-bg") && target.closest("[data-stop]")) return;
  hideTip();
  if (act.startsWith("profile-")) {
    try {
      profileAction(act, d.id ?? "");
    } catch (e) {
      // e.g. the profile was deleted in another tab a moment ago
      S.ioMsg = { text: errorText(e), error: true };
      render();
    }
    return;
  }
  const p = S.profile;
  const room = d.room ?? "";
  switch (act) {
    case "set-level":
      S.profile = setSkillLevel(p, d.op ?? "", Number(d.i), Number(d.lv));
      return commit(renderRoster);
    case "set-default":
      S.profile = setDefaultLevel(p, Number(d.i), Number(d.lv));
      return commit(renderRoster);
    case "reset-all-levels":
      dp().operatorSkills = {};
      return commit(renderRoster);
    case "tab":
      S.tab = (d.val ?? "overview") as Tab;
      S.renaming = null;
      S.store.saveUi({ tab: S.tab });
      render();
      window.scrollTo(0, 0);
      return;
    case "select-room":
      S.room = room;
      S.store.saveUi({ room });
      renderSelectedRoom();
      return;
    case "filter":
      if (d.group === "room") S.filterRoom = d.val ?? "ALL";
      else if (d.group === "sort") S.sortBy = d.val === "name" ? "name" : "rarity";
      else S.filterStatus = d.val ?? "all";
      S.store.saveUi({ filterRoom: S.filterRoom, filterStatus: S.filterStatus, sortBy: S.sortBy });
      renderRosterFilters();
      return;
    case "prio-step": {
      // first use on an older profile: start from the levels of its Room priority preset
      const lv = priorityLevels(p);
      const cur = lv[room] ?? 1;
      const next = Math.min(PRIO_MAX, Math.max(1, cur + (d.d === "-1" ? -1 : 1)));
      if (next === cur) return;
      dp().settings.roomPrio = { ...lv, [room]: next };
      dp().settings.prioOn = true;
      break;
    }
    case "reset-levels":
      delete dp().operatorSkills[d.op ?? ""];
      return commit(renderRoster);
    case "disable-op":
      (p.operators[d.op ?? ""] ??= {}).disabled = true;
      removeEverywhere(d.op ?? "");
      return commit(renderRoster);
    case "enable-op":
      delete p.operators[d.op ?? ""]?.disabled;
      return commit(renderRoster);
    case "open-picker":
    case "open-item":
      S.picker = act === "open-picker"
        ? { kind: "op", slot: d.slot ?? "", i: Number(d.i) }
        : { kind: d.kind === "gc" ? "gc" : "mfg", room, i: el.hasAttribute("data-i") ? Number(d.i) : 0 };
      S.pickerSearch = "";
      pickerReturn = focusKey(el);
      renderPicker();
      return;
    case "close-picker":
      closePicker();
      return;
    case "pick": {
      const pk = S.picker;
      if (!pk) return;
      const val = d.val || null;
      if (pk.kind === "op") assign(pk.slot, pk.i, val);
      else if (pk.kind === "mfg") setRoomSetting(pk.room, "item", val);
      else {
        const items = [...(dp().roomSettings[pk.room]?.items ?? [null, null, null])];
        items[pk.i] = val;
        setRoomSetting(pk.room, "items", items);
      }
      S.picker = null;
      commit();
      focusSelector(pickerReturn);
      return;
    }
    case "optimize":
      optimize(el);
      return;
    case "dismiss-opt":
      S.optNote = null;
      render();
      return;
    case "clear": {
      const keepFixed = d.all === "0";
      const ra = dp().roomAssignments;
      for (const [sid, slots] of Object.entries(ra)) ra[sid] = slots.map((op) => (op && keepFixed && op.fixed ? op : null));
      break;
    }
    case "add-shift":
      setShift(room, { ...getShiftSettings(p, room), enabled: true });
      break;
    case "remove-shift":
      setShift(room, { ...getShiftSettings(p, room), enabled: false });
      delete S.drafts[room];
      break;
    case "activate-shift": {
      const sh = getShiftSettings(p, room);
      setShift(room, { ...sh, active: sh.active === "A" ? "B" : "A" });
      break;
    }
    case "shift-reset":
    case "shift-swap":
      S.drafts[room] = barOf(act === "shift-reset" ? resetShift(draftOf(room)) : swapShift(draftOf(room)));
      renderDraft(room);
      focusSelector(`[data-act="${act}"][data-room="${CSS.escape(room)}"]`);
      return;
    case "shift-confirm":
      // only the bar comes from the draft: e.g. an Activate Shift since then is kept
      if (S.drafts[room]) {
        setShift(room, draftOf(room));
        delete S.drafts[room];
      }
      break;
    case "import": {
      const text = (document.getElementById("io-text") as HTMLTextAreaElement | null)?.value ?? "";
      try {
        afterImport(S.store.importProfile(text));
      } catch (e) {
        S.ioMsg = { text: errorText(e), error: true };
      }
      render();
      return;
    }
    case "dismiss-notice":
      S.notice = null;
      render();
      updateSaveBadge();
      return;
    case "reset-profile":
      if (!window.confirm(`Reset all planner settings in "${S.store.active().name}"?`)) return;
      S.profile = defaultProfile();
      S.drafts = {};
      break;
    default:
      return;
  }
  commit();
}

export function onChange(evt: Event): void {
  const el = evt.target;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return;
  const kind = el.dataset.change;
  const s = dp().settings;
  const checked = el instanceof HTMLInputElement && el.checked;
  switch (kind) {
    case "prio-on":
      s.roomPrio = priorityLevels(S.profile);
      s.prioOn = checked;
      break;
    case "align":
      s.align = el.value;
      break;
    case "cn-model":
      s.cnModel = el.value === "always" ? "always" : "game";
      break;
    case "utc":
      s.utcOffset = parseInt(el.value, 10);
      break;
    case "shift-hours":
      s.shiftHours = el.value === "keep" ? "keep" : "optimize";
      break;
    case "room-on": {
      const room = el.dataset.room ?? "";
      if (checked) delete dp().roomSettings[room]?.off;
      else {
        setRoomSetting(room, "off", true);
        delete S.drafts[room];
      }
      break;
    }
    case "auto-rotate": {
      const room = el.dataset.room ?? "";
      setShift(room, { ...getShiftSettings(S.profile, room), autoRotate: checked });
      if (!checked) delete S.drafts[room]; // the bar (and Confirm) is hidden without auto-rotate
      break;
    }
    case "import-file":
      if (el instanceof HTMLInputElement) void importFile(el);
      return;
    default:
      return;
  }
  commit();
}

export function onInput(evt: Event): void {
  const el = evt.target;
  if (!(el instanceof HTMLInputElement)) return;
  if (el.dataset.input === "search") {
    S.search = el.value;
    hideTip();
    renderRosterGrid();
  } else if (el.dataset.input === "picker-search") {
    S.pickerSearch = el.value;
    hideTip();
    renderPickGrid();
  }
}

export function onKeydown(evt: KeyboardEvent): void {
  const renaming = evt.target instanceof HTMLElement && evt.target.id === "rename-input";
  if (renaming && evt.key === "Enter") {
    evt.preventDefault();
    finishRename(true);
  } else if (evt.key === "Escape" && S.renaming) {
    finishRename(false);
  } else if (evt.key === "Escape" && S.picker) {
    closePicker();
  }
}
