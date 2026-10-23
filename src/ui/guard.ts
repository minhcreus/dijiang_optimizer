// Turns any stored or imported profile into one the planner can use.
// The core (like the Python version) raises on corrupt shapes and keeps unknown
// values as-is, so before it runs: wrong containers are treated as missing,
// and unknown operators or products (e.g. from a newer version of the original
// site), wrong types and lengths are repaired. Valid profiles come back unchanged.
import { DAY_MIN, OPS, ROOM_DATA, migrateProfile, priorityLevels, roomType, syncSlots } from "../core/index.ts";
import type { Assigned, Profile, RoomSettings, ShiftSettings, Slots } from "../core/index.ts";
import { isDict, pyRound, truthy } from "../core/py.ts";

type Dict = Record<string, unknown>;
const isLevel = (v: unknown): v is number => v === 0 || v === 1 || v === 2;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const dict = <T>(v: unknown): Record<string, T> => (isDict(v) ? (v as Record<string, T>) : {});

/** Exactly n entries, padded with null. */
function fit<T>(v: unknown, n: number, keep: (x: unknown) => boolean): (T | null)[] {
  const a = Array.isArray(v) ? v : [];
  return Array.from({ length: n }, (_, i) => (keep(a[i]) ? (a[i] as T) : null));
}

/** Flags the UI reads with JS truthiness and the core with Python's ({} and [] differ): store real booleans. */
function toBool(o: object, ...keys: string[]): void {
  const d = o as Dict;
  for (const k of keys) if (Object.hasOwn(d, k) && typeof d[k] !== "boolean") d[k] = truthy(d[k]);
}

const knownOp = (x: unknown): boolean => isDict(x) && typeof x.id === "string" && Object.hasOwn(OPS, x.id);

function cleanSlots(v: unknown): Slots {
  const slots = fit<Assigned>(v, 3, knownOp);
  for (const op of slots) if (op) toBool(op, "fixed", "filler");
  return slots;
}

function cleanShift(v: unknown): Partial<ShiftSettings> | undefined {
  if (!isDict(v)) return undefined;
  const sh = v as Partial<ShiftSettings>;
  if (sh.p !== undefined || sh.q !== undefined) {
    const { p = 0, q = 720 } = sh; // a missing handle takes its default
    // whole hours, like the bar; each shift keeps at least an hour, so a handle pair covering the whole day is cut back
    const [hp, hq] = [isNum(p) ? pyRound(p / 60) * 60 + 0 : NaN, isNum(q) ? pyRound(q / 60) * 60 + 0 : NaN];
    if (!(hp >= 0 && hp < hq && hq <= DAY_MIN)) Object.assign(sh, { p: 0, q: 720 });
    else {
      if (sh.p !== undefined) sh.p = hp;
      if (sh.q !== undefined) sh.q = hp === 0 && hq === DAY_MIN ? DAY_MIN - 60 : hq;
    }
  }
  for (const k of ["inner", "active"] as const) if (k in sh && sh[k] !== "A" && sh[k] !== "B") delete sh[k];
  toBool(sh, "enabled", "autoRotate");
  return sh;
}

function cleanRoomSettings(roomId: string, v: unknown): RoomSettings | undefined {
  if (!isDict(v)) return undefined;
  const rs = v as RoomSettings;
  const rtype = roomType(roomId);
  if (rtype === "MFG" && rs.item != null && !(typeof rs.item === "string" && Object.hasOwn(ROOM_DATA.MFG.items, rs.item))) rs.item = null;
  if (rtype === "GC" && Object.hasOwn(rs, "items")) {
    rs.items = fit<string>(rs.items, 3, (x) => typeof x === "string" && Object.hasOwn(ROOM_DATA.GC.items, x));
  }
  if ("shift" in rs) {
    const sh = cleanShift(rs.shift);
    if (sh) rs.shift = sh;
    else delete rs.shift;
  }
  toBool(rs, "firstPrio", "off");
  return rs;
}

/** Repairs a migrated profile in place (its sections are known to be dicts). */
export function sanitizeProfile(profile: Profile): Profile {
  const dp = profile.dijiangPlanner;
  for (const [slot, ops] of Object.entries(dp.roomAssignments)) dp.roomAssignments[slot] = cleanSlots(ops);

  const rooms = dict<unknown>(dp.roomSettings);
  dp.roomSettings = {};
  for (const [rid, rs] of Object.entries(rooms)) {
    const clean = cleanRoomSettings(rid, rs);
    if (clean) dp.roomSettings[rid] = clean;
  }

  const skills = dict<unknown>(dp.operatorSkills);
  dp.operatorSkills = {};
  for (const [opId, lv] of Object.entries(skills)) {
    if (Array.isArray(lv)) dp.operatorSkills[opId] = fit<number>(lv, 2, isLevel) as [number | null, number | null];
  }

  const s = dp.settings;
  const dl = Array.isArray(s.defaultLevels) ? s.defaultLevels : [];
  s.defaultLevels = [isLevel(dl[0]) ? dl[0] : 2, isLevel(dl[1]) ? dl[1] : 2];
  if (!isNum(s.utcOffset) || Math.abs(s.utcOffset) > 24) s.utcOffset = 8;
  if (typeof s.prio !== "string") s.prio = "Equal";
  if (typeof s.align !== "string") s.align = "Staggered";
  if (Object.hasOwn(s, "cnModel") && s.cnModel !== "game" && s.cnModel !== "always") delete s.cnModel;
  if (Object.hasOwn(s, "shiftHours") && s.shiftHours !== "optimize" && s.shiftHours !== "keep") delete s.shiftHours;
  if (Object.hasOwn(s, "prioOn") && typeof s.prioOn !== "boolean") delete s.prioOn;
  if (Object.hasOwn(s, "roomPrio")) {
    if (isDict(s.roomPrio)) s.roomPrio = priorityLevels(profile);
    else delete s.roomPrio;
  }

  const ops = dict<unknown>(profile.operators);
  profile.operators = {};
  for (const [opId, o] of Object.entries(ops)) {
    if (!isDict(o)) continue;
    toBool(o, "disabled");
    profile.operators[opId] = o;
  }
  return profile;
}

/** Sections that are not dicts count as missing, so migrateProfile fills in the defaults. */
function repairShapes(raw: unknown): unknown {
  if (!isDict(raw) || !Object.hasOwn(raw, "dijiangPlanner")) return raw;
  const dp: Dict = isDict(raw.dijiangPlanner) ? { ...raw.dijiangPlanner } : {};
  for (const k of ["roomAssignments", "roomSettings", "operatorSkills", "settings"]) if (Object.hasOwn(dp, k) && !isDict(dp[k])) delete dp[k];
  const out: Dict = { ...raw, dijiangPlanner: dp };
  if (Object.hasOwn(out, "operators") && !isDict(out.operators)) delete out.operators;
  return out;
}

/**
 * Stored or imported data -> a profile the core and the views accept. The repairs
 * run before syncSlots, which reads the shift settings. Throws (like migrateProfile)
 * only for values that are not profiles at all, e.g. a number.
 */
export function normalizeProfile(raw: unknown): Profile {
  return syncSlots(sanitizeProfile(migrateProfile(repairShapes(raw))));
}
