// App state and data derived from the profile. Derived data is cached until
// the profile changes (every change bumps S.rev).
import { OPS, ROOM_DATA, baseRoom, computeProductivity, getShiftSettings, roomType } from "../core/index.ts";
import type { DijiangPlanner, Profile, Results, ShiftSettings } from "../core/index.ts";
import type { Store, UiPrefs } from "../storage.ts";
import { cmpStr } from "./html.ts";
import { nowMinute, utcLabel } from "./time.ts";

export type Tab = "overview" | "roster" | "settings";
export type Picker = { kind: "op"; slot: string; i: number } | { kind: "mfg" | "gc"; room: string; i: number };
export interface Drag { room: string; handle: "p" | "q" }
/** The part of a room's shift settings edited on the 24h bar. */
export type Bar = Pick<ShiftSettings, "p" | "q" | "inner">;
export interface IoMsg { text: string; error: boolean }

export interface State {
  store: Store;
  profile: Profile;
  /** store id of `profile` */
  profileId: string;
  rev: number;
  search: string;
  picker: Picker | null;
  pickerSearch: string;
  /** room id -> bar being edited, applied on Confirm */
  drafts: Record<string, Bar>;
  drag: Drag | null;
  ioMsg: IoMsg | null;
  /** profile id being renamed inline */
  renaming: string | null;
  /** one-off store notice from startup (unreadable data recovered), shown until dismissed */
  notice: string | null;
  /** what the last Optimize did, shown until dismissed */
  optNote: string | null;
  tab: Tab;
  room: string;
  filterRoom: string;
  filterStatus: string;
}

export const TABS: readonly [Tab, string][] = [["overview", "OVERVIEW"], ["roster", "ROSTER"], ["settings", "SETTINGS"]];
export const ROOM_FILTERS: readonly [string, string][] = [
  ["ALL", "All"], ["CN", "Control Nexus"], ["MFG", "Manufacturing"], ["GC", "Growth"], ["RR", "Reception"],
];
export const STATUS_FILTERS: readonly [string, string][] = [
  ["all", "Any status"], ["free", "Free"], ["assigned", "Assigned"], ["disabled", "Disabled"],
];

export let S: State;

const oneOf = <T extends string>(v: string, options: readonly (readonly [T, string])[], fallback: T): T =>
  options.find(([k]) => k === v)?.[0] ?? fallback;

/** Stored UI prefs, falling back to the defaults for values this version does not know. */
export function uiFromPrefs(ui: UiPrefs, roomIds: readonly string[]): Pick<State, "tab" | "room" | "filterRoom" | "filterStatus"> {
  return {
    tab: oneOf(ui.tab, TABS, "overview"),
    room: roomIds.includes(ui.room) ? ui.room : "MFG-I",
    filterRoom: oneOf(ui.filterRoom, ROOM_FILTERS, "ALL"),
    filterStatus: oneOf(ui.filterStatus, STATUS_FILTERS, "all"),
  };
}

export function initState(store: Store, roomIds: readonly string[]): void {
  const st = store.status();
  const notice = st.state === "saved" || st.state === "pending" ? st.message ?? null : null;
  S = {
    store, profile: store.load(), profileId: store.activeId(), rev: 0, search: "", picker: null, pickerSearch: "", drafts: {}, drag: null,
    ioMsg: null, renaming: null, notice, optNote: null, ...uiFromPrefs(store.loadUi(), roomIds),
  };
}

export const dp = (): DijiangPlanner => S.profile.dijiangPlanner;

export interface OpLists { available: string[]; fixed: string[]; disabled: string[] }

interface Derived { rev: number; profile?: Profile; results?: Results; lists?: OpLists; where?: Map<string, string> }
let memo: Derived = { rev: -1 };

function derived(): Derived {
  if (memo.rev !== S.rev || memo.profile !== S.profile) memo = { rev: S.rev, profile: S.profile };
  return memo;
}

export function results(): Results {
  const d = derived();
  return (d.results ??= computeProductivity(OPS, S.profile));
}

export const isDisabled = (opId: string): boolean => Boolean(S.profile.operators[opId]?.disabled);

export function opLists(): OpLists {
  const d = derived();
  if (!d.lists) {
    const fixedSet = new Set<string>();
    for (const slots of Object.values(dp().roomAssignments)) for (const op of slots) if (op?.fixed) fixedSet.add(op.id);
    const fixed = [...fixedSet].sort(cmpStr);
    const disabled = Object.keys(OPS).filter(isDisabled).sort(cmpStr);
    const available = Object.keys(OPS).filter((o) => !fixedSet.has(o) && !isDisabled(o));
    d.lists = { available, fixed, disabled };
  }
  return d.lists;
}

/** The first slot holding the operator, like the legacy where_is(). */
export function whereIs(opId: string): string | null {
  const d = derived();
  if (!d.where) {
    d.where = new Map();
    for (const [slot, ops] of Object.entries(dp().roomAssignments)) {
      for (const op of ops) if (op && !d.where.has(op.id)) d.where.set(op.id, slot);
    }
  }
  return d.where.get(opId) ?? null;
}

export const shiftOn = (roomId: string): boolean => Boolean(getShiftSettings(S.profile, roomId).enabled);

export function slotLabel(slot: string): string {
  const rid = baseRoom(slot);
  const name = ROOM_DATA[roomType(rid)].name;
  if (slot.includes("#B")) return `${name} (${rid}) · Shift B`;
  if (shiftOn(rid)) return `${name} (${rid}) · Shift A`;
  return `${name} (${rid})`;
}

const utcOffset = (): number => dp().settings.utcOffset ?? 8;
export const nowMin = (): number => nowMinute(utcOffset());
export const utc = (): string => utcLabel(utcOffset());
