// Rendering into #app. A full render replaces the tab view and the picker;
// typing, dragging, roster edits and save-status changes re-render only their own region.
import { getShiftSettings, shiftWindows } from "../core/index.ts";
import type { ShiftId } from "../core/index.ts";
import { esc } from "./html.ts";
import { fromHtml, morph, patchList } from "./patch.ts";
import type { Pooled } from "./patch.ts";
import { S, dp, results } from "./state.ts";
import { hideTip } from "./tooltip.ts";
import { appBar, saveBadge, tabsHtml } from "./views/appbar.ts";
import { draftOf, haltWarning, overviewView, roomCard, scheduler, windowLines } from "./views/overview.ts";
import { pickerEntries, pickerView } from "./views/picker.ts";
import { NO_MATCH, rosterCardList, rosterDefaults, rosterMeta, rosterView } from "./views/roster.ts";
import { settingsView } from "./views/settings.ts";

const FOOTER = "<footer>Fan-made planner for the OMV Dijiang. Logic based on the Dijiang Planner in endfield-planners. "
  + "Not affiliated with the game.</footer>";
/** Text fields whose focus and caret survive a re-render. */
const FOCUS_IDS = new Set(["op-search", "picker-search", "rename-input", "io-text"]);

const byId = (id: string): HTMLElement | null => document.getElementById(id);

export function renderShell(root: HTMLElement): void {
  root.innerHTML = `${appBar()}<main id="view"></main><div id="picker-root"></div>${FOOTER}<div id="tip" class="tip" role="tooltip"></div>`;
}

/**
 * A selector that finds the same control (button, checkbox, select) again after a re-render.
 * The tooltip is left out: it describes the content (e.g. the operator in a slot), not the control.
 */
export function focusKey(el: Element | null): string | null {
  if (!(el instanceof HTMLElement) || !(el.dataset.act || el.dataset.change)) return null;
  return Object.entries(el.dataset)
    .filter(([k]) => k !== "tip")
    .map(([k, v]) => `[data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${CSS.escape(v ?? "")}"]`).join("");
}

export function focusSelector(sel: string | null): void {
  const el = sel ? document.querySelector<HTMLElement>(sel) : null;
  el?.focus({ preventScroll: true });
}

/** Focus `el`; when it is disabled now (e.g. RESET after a reset), the nearest enabled button around it. */
function focusOrNear(el: HTMLElement): void {
  if (!el.matches(":disabled")) return el.focus({ preventScroll: true });
  for (let box = el.parentElement; box && box.id !== "view"; box = box.parentElement) {
    const b = box.querySelector<HTMLElement>("button:not(:disabled)");
    if (b) return b.focus({ preventScroll: true });
  }
}

/**
 * After a re-render, when focus was lost: back on `prev` if it is still in the page (a pooled
 * roster card that was moved or put back), else on the control `sel` finds now.
 */
function regainFocus(prev: Element | null, sel: string | null | undefined): void {
  const now = document.activeElement;
  if (!prev || prev === document.body || (now && now !== document.body)) return; // not lost, or taken by something else
  const el = prev.isConnected ? prev : sel ? document.querySelector(sel) : null;
  if (el instanceof HTMLElement) focusOrNear(el);
}

interface Kept {
  active: Element | null; focusId?: string; sel?: [number | null, number | null]; focusSel?: string | null; ioText?: string; rename?: string;
}

/** Focus, caret and typed text that a re-render would otherwise lose. */
function keep(): Kept {
  const a = document.activeElement;
  const k: Kept = { active: a };
  const text = a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement;
  if (text && FOCUS_IDS.has(a.id)) [k.focusId, k.sel] = [a.id, [a.selectionStart, a.selectionEnd]];
  else if (a && a !== document.body) k.focusSel = focusKey(a);
  // pasted text survives re-renders until another profile is shown (e.g. after a successful import)
  const io = byId("io-text") as HTMLTextAreaElement | null;
  if (io && io.value !== io.defaultValue && io.dataset.profile === S.profileId) k.ioText = io.value;
  const rn = byId("rename-input") as HTMLInputElement | null;
  if (rn) k.rename = rn.value;
  return k;
}

function restore(k: Kept): void {
  const io = byId("io-text") as HTMLTextAreaElement | null;
  if (io && k.ioText !== undefined) io.value = k.ioText;
  const rn = byId("rename-input") as HTMLInputElement | null;
  if (rn && k.rename !== undefined) rn.value = k.rename;
  // still focused (not re-rendered, e.g. OPTIMIZE): focusing again would only force a layout
  if (document.activeElement === k.active) return;
  const el = k.focusId ? (byId(k.focusId) as HTMLInputElement | HTMLTextAreaElement | null) : null;
  if (!el) return regainFocus(k.active, k.focusSel);
  el.focus({ preventScroll: true });
  const [start, end] = k.sel ?? [null, null];
  el.setSelectionRange(start ?? el.value.length, end ?? start ?? el.value.length);
}

function noticeBanner(): string {
  if (!S.notice) return "";
  return `<div class="prof-notice app-notice" role="alert"><span>${esc(S.notice)}</span><button class="mini" data-act="dismiss-notice">OK</button></div>`;
}

function optBanner(): string {
  if (!S.optNote) return "";
  return `<div class="app-notice opt-note" role="status"><span>${esc(S.optNote)}</span><button class="mini" data-act="dismiss-opt">OK</button></div>`;
}

function viewHtml(): string {
  const top = noticeBanner() + optBanner();
  if (S.tab === "roster") return top + rosterView(false); // cards: see patchRosterGrid
  if (S.tab === "settings") return top + settingsView();
  return top + overviewView();
}

/** While the picker is open the page behind it is inert: no focus, no clicks. */
function syncModal(): void {
  const open = S.picker !== null;
  for (const el of document.querySelectorAll<HTMLElement>("#app > header, #view, #app > footer")) el.inert = open;
}

function paint(): void {
  if (S.picker?.kind === "op" && !dp().roomAssignments[S.picker.slot]) S.picker = null;
  byId("tabs")!.innerHTML = tabsHtml();
  byId("view")!.innerHTML = viewHtml();
  patchRosterGrid();
  byId("picker-root")!.innerHTML = pickerView();
  syncModal();
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function render(): void {
  const kept = keep();
  hideTip();
  try {
    paint();
  } catch (e) {
    // Data this version cannot show must not leave a blank page: Settings can export, reset or delete the profile.
    console.error(e);
    if (S.tab === "settings") throw e;
    S.tab = "settings";
    S.picker = null;
    S.notice = `The active profile could not be displayed (${errorText(e)}). Export it to keep a copy, then reset or delete it below.`;
    S.store.saveUi({ tab: "settings" });
    paint();
  }
  restore(kept);
}

/** A partial re-render; if anything goes wrong there, the full render (with its error fallback) takes over. */
function partial<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  return (...args) => {
    try {
      fn(...args);
    } catch (e) {
      console.error(e);
      render();
    }
  };
}

export const renderPicker = partial((): void => {
  hideTip();
  byId("picker-root")!.innerHTML = pickerView();
  syncModal();
  byId("picker-search")?.focus();
});

export const renderPickGrid = partial((): void => {
  const grid = byId("pick-grid");
  if (grid && S.picker) grid.innerHTML = pickerEntries(S.picker);
});

/** Roster cards by operator, kept across renders: unchanged cards (and their art) are reused as they are. */
const cardPool = new Map<string, Pooled>();

function patchRosterGrid(): void {
  const grid = byId("oc-grid");
  if (grid) patchList(grid, rosterCardList(), cardPool, NO_MATCH);
}

/** Search typed: the cards. */
export const renderRosterGrid = partial((): void => {
  if (!byId("oc-grid")) return render();
  patchRosterGrid();
});

/**
 * A roster edit (levels, enable/disable): the defaults with RESET ALL (n), the counts and every
 * card whose markup changed (all of them after a default level change). Nothing else on the
 * Roster tab depends on the profile.
 */
export const renderRoster = partial((): void => {
  const defs = document.querySelector("#view .defaults");
  const meta = document.querySelector("#view .roster-meta");
  if (S.tab !== "roster" || !defs || !meta || !byId("oc-grid")) return render();
  const active = document.activeElement;
  const sel = focusKey(active);
  hideTip();
  morph(defs, fromHtml(rosterDefaults()));
  morph(meta, fromHtml(rosterMeta()));
  patchRosterGrid();
  regainFocus(active, sel);
});

/** Roster filter chips changed: their state and the grid. */
export const renderRosterFilters = partial((): void => {
  if (!byId("oc-grid")) return render();
  hideTip();
  const cur: Record<string, string> = { room: S.filterRoom, status: S.filterStatus, sort: S.sortBy };
  for (const chip of document.querySelectorAll<HTMLElement>(".chip-btn[data-act=filter]")) {
    chip.classList.toggle("on", chip.dataset.val === cur[chip.dataset.group ?? ""]);
  }
  const meta = document.querySelector("#view .roster-meta");
  if (meta) morph(meta, fromHtml(rosterMeta()));
  patchRosterGrid();
});

/** Another room picked on the ship deck: the tile highlight and the detail panel. */
export const renderSelectedRoom = partial((): void => {
  const detail = document.querySelector("#view section.detail");
  if (!detail) return render();
  hideTip();
  for (const tile of document.querySelectorAll<HTMLElement>(".tile[data-room]")) tile.classList.toggle("sel", tile.dataset.room === S.room);
  detail.outerHTML = roomCard(S.room, results()[S.room]);
});

/** After a drag / reset / swap: the bar, the window lines and the halt warnings of one room. */
export const renderDraft = partial((roomId: string): void => {
  const sched = byId(`sched-${roomId}`);
  const info = results()[roomId]?.shifts;
  if (!sched || !info) return render();
  const sh = getShiftSettings(S.profile, roomId);
  sched.outerHTML = scheduler(roomId, sh);
  const dwin = shiftWindows(draftOf(roomId));
  for (const s of ["A", "B"] as ShiftId[]) {
    const win = byId(`win-${roomId}-${s}`);
    if (win) win.outerHTML = windowLines(roomId, s, info[s].window, dwin[s]);
    const warn = byId(`warn-${roomId}-${s}`);
    if (warn) warn.outerHTML = haltWarning(roomId, s, info[s], dwin[s], Boolean(sh.autoRotate));
  }
});

export function updateSaveBadge(): void {
  const el = byId("save-state");
  if (el) el.outerHTML = saveBadge();
}
