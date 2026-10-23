// Profile data: defaults, migration, skill levels and shift slots.
// Every function that returns a profile works on a copy.
import { LATEST_VERSION, PRIORITY_OPTIONS, ROOM_IDS, roomType, shiftSlot } from "./constants.ts";
import { at, field, isDict, lookup, pyMax, pyMin, pyUpdate, setAt, subscript, truthy } from "./py.ts";
import type { DijiangPlanner, Profile, RoomSettings, ShiftSettings } from "./types.ts";

type Dict = Record<string, unknown>;
type Levels = [number | null, number | null];

export function defaultShiftSettings(): ShiftSettings {
  // Default: A 00:00-12:00, B the rest of the day.
  return { enabled: false, autoRotate: true, active: "A", p: 0, q: 720, inner: "A" };
}

export function defaultProfile(): Profile {
  const roomAssignments: DijiangPlanner["roomAssignments"] = {};
  for (const rid of ROOM_IDS) roomAssignments[rid] = [null, null, null];
  return {
    latestVersion: LATEST_VERSION,
    dijiangPlanner: {
      roomAssignments,
      roomSettings: {},
      operatorSkills: {},
      settings: { defaultLevels: [2, 2], prio: "Equal", align: "Staggered", utcOffset: 8 },
    },
    operators: {},
  };
}

const clampLevel = (level: number): number => pyMax(0, pyMin(2, level));
const isUnset = (levels: (number | null)[]): boolean =>
  levels.length === 2 && levels[0] == null && levels[1] == null;

/**
 * Change the default level of skill i and apply it to every operator.
 * The original planner kept per-operator overrides; here the default wins for
 * skill i and the other skill's overrides are kept.
 */
export function setDefaultLevel(profile: Profile, i: number, level: number): Profile {
  const p = structuredClone(profile);
  const dp = p.dijiangPlanner;
  setAt(dp.settings.defaultLevels, i, clampLevel(level));
  for (const opId of Object.keys(dp.operatorSkills)) {
    const levels = [...dp.operatorSkills[opId]];
    setAt(levels, i, null);
    if (isUnset(levels)) delete dp.operatorSkills[opId];
    else dp.operatorSkills[opId] = levels as Levels;
  }
  return p;
}

export function setSkillLevel(profile: Profile, opId: string, i: number, level: number): Profile {
  const p = structuredClone(profile);
  const dp = p.dijiangPlanner;
  const levels: (number | null)[] = [...lookup(dp.operatorSkills, opId, [null, null] as Levels)];
  setAt(levels, i, clampLevel(level));
  if (at(levels, i) === at(dp.settings.defaultLevels, i)) setAt(levels, i, null);
  if (isUnset(levels)) delete dp.operatorSkills[opId];
  else dp.operatorSkills[opId] = levels as Levels;
  return p;
}

/** dict.setdefault(k, v); like Python it fails on anything but a dict. */
function setDefault(o: unknown, k: string, v: unknown): unknown {
  if (!isDict(o)) throw new TypeError(`'${Array.isArray(o) ? "list" : typeof o}' object has no attribute 'setdefault'`);
  if (!Object.hasOwn(o, k)) o[k] = v;
  return o[k];
}

/**
 * Accept a profile saved by this app or exported by the original site.
 * Corrupt shapes raise like the Python version; the app repairs them first (ui/guard.ts).
 */
export function migrateProfile(raw: unknown): Profile {
  const base = defaultProfile();
  if (!truthy(raw)) return base;
  if (!isDict(raw)) {
    // Python: `"dijiangPlanner" in raw` then raw["dijiangPlanner"] fail, unless a str / list lacks that key
    if ((typeof raw === "string" || Array.isArray(raw)) && !raw.includes("dijiangPlanner")) return base;
    throw new TypeError("profile is not a dict");
  }
  if (!Object.hasOwn(raw, "dijiangPlanner")) return base;
  const p = structuredClone(raw);
  const dp = p.dijiangPlanner as Dict;
  const ra = setDefault(dp, "roomAssignments", {}) as Dict;
  for (const rid of ROOM_IDS) setDefault(ra, rid, [null, null, null]);
  setDefault(dp, "roomSettings", {});
  setDefault(dp, "operatorSkills", {});
  const s = setDefault(dp, "settings", {}) as Dict;
  for (const [k, v] of Object.entries(base.dijiangPlanner.settings)) setDefault(s, k, v);
  const operators = setDefault(p, "operators", {}) as Profile["operators"];
  // keep only the Dijiang planner + operator settings
  return { latestVersion: LATEST_VERSION, dijiangPlanner: dp as unknown as DijiangPlanner, operators };
}

export function getShiftSettings(profile: Profile, roomId: string): ShiftSettings {
  const rs = lookup(profile.dijiangPlanner.roomSettings, roomId, {} as RoomSettings);
  const out = defaultShiftSettings();
  pyUpdate(out as unknown as Dict, field(rs, "shift", {}));
  return out;
}

/** Slot ids the optimizer fills: rooms, plus "<room>#B" for rooms with Shift B. */
export function assignmentSlots(profile: Profile): string[] {
  const slots: string[] = [];
  for (const rid of ROOM_IDS) {
    slots.push(rid);
    if (truthy(getShiftSettings(profile, rid).enabled)) slots.push(shiftSlot(rid, "B"));
  }
  return slots;
}

/** Is the room in use? A room switched off holds no operators and Optimize leaves it empty. */
export function roomOn(profile: Profile, roomId: string): boolean {
  return !truthy(field(lookup(profile.dijiangPlanner.roomSettings, roomId, {} as RoomSettings), "off", false));
}

/** Make roomAssignments match enabled shifts (create / remove "#B" slots); rooms that are off are emptied. */
export function syncSlots(profile: Profile): Profile {
  const p = structuredClone(profile);
  const ra = p.dijiangPlanner.roomAssignments;
  const out: DijiangPlanner["roomAssignments"] = {};
  for (const slot of assignmentSlots(p)) out[slot] = roomOn(p, slot.split("#")[0]) ? lookup(ra, slot, [null, null, null]) : [null, null, null];
  p.dijiangPlanner.roomAssignments = out;
  return p;
}

export function usedOperatorIds(profile: Profile): Set<string> {
  const ids = new Set<string>();
  for (const slots of Object.values(profile.dijiangPlanner.roomAssignments)) {
    for (const op of slots) if (truthy(op)) ids.add(subscript<string>(op, "id"));
  }
  return ids;
}

/** Rooms with a priority (the Control Nexus only helps the others) and the highest level. */
export const PRIO_ROOMS: readonly string[] = ROOM_IDS.filter((r) => r !== "CN");
export const PRIO_MAX = 5;

const prioLevel = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(PRIO_MAX, Math.max(1, Math.round(v))) : 1);

/** Room priority switched on. Older profiles without the switch count as on when their preset is not Equal. */
export function priorityOn(profile: Profile): boolean {
  const s = profile.dijiangPlanner.settings;
  if (typeof s.prioOn === "boolean") return s.prioOn;
  return lookup(PRIORITY_OPTIONS, field(s, "prio", "Equal"), PRIORITY_OPTIONS.Equal) !== PRIORITY_OPTIONS.Equal;
}

/** Each production room's priority level, kept while priority is off; older profiles take it from their preset. */
export function priorityLevels(profile: Profile): Record<string, number> {
  const s = profile.dijiangPlanner.settings;
  if (isDict(s.roomPrio)) {
    const lv = s.roomPrio as Record<string, unknown>;
    return Object.fromEntries(PRIO_ROOMS.map((r) => [r, prioLevel(lv[r])]));
  }
  const preset = lookup(PRIORITY_OPTIONS, field(s, "prio", "Equal"), PRIORITY_OPTIONS.Equal);
  return Object.fromEntries(PRIO_ROOMS.map((r) => [r, preset[roomType(r)] ?? 1]));
}

/** How many times each production room counts when Optimize compares plans (1 each while priority is off). */
export function roomWeights(profile: Profile): Record<string, number> {
  if (!priorityOn(profile)) return Object.fromEntries(PRIO_ROOMS.map((r) => [r, 1]));
  return priorityLevels(profile);
}
