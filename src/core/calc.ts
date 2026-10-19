// Productivity model, ported from the legacy dijiang_core.py.
//
// * Work time = 50000 s / (1 - sum(mood drop reductions)); break time = 30000 s / mood regen.
//   Checked against the in-game Shift screen: A 10% + 18% -> 19h 17min, B 18% -> 16h 56min.
// * Mood Drop / Hour = 100% / (work time / 3600 s): 7.2 %/h at base, 5.904 %/h with 18%.
// * Production efficiency = (1 + 0.4 * working operators) * (1 + sum(skill bonuses)):
//   3 operators -> 220%, with 30 + 20 + 20% bonuses -> 374% (both as in game).
// * Operators at zero mood rest until max mood and give no effects meanwhile
//   (https://endfield.wiki.gg/wiki/OMV_Dijiang); shift rules from the in-game
//   "Cabin Shift Rotation Details" help text.
// Float operations keep the Python order so results are bit-identical.
import { BREAK_TIME, DAY_MIN, OPERATOR_BONUS, ROOM_DATA, WORK_TIME, roomType, shiftSlot } from "./constants.ts";
import { fmt3, pct3, secondsToHmin, secondsToHms } from "./format.ts";
import { getShiftSettings } from "./profile.ts";
import { at, cmp, field, lookup, pyMin, pySum, req, truthy } from "./py.ts";
import { constantFrom, followTimeline, measured, recoverTime, runShip, staggeredStart } from "./ship.ts";
import type { Timeline, Unit } from "./ship.ts";
import { shiftWindows, windowLength, windowMask } from "./shifts.ts";
import type {
  Assigned, Bonuses, CnModel, GCItemResult, OperatorsData, Profile, RoomResult, RoomSettings, Results, ShiftGroup, ShiftId,
  ShiftInfo, ShiftSettings, ShiftStats, Skill, Slots, Window,
} from "./types.ts";

const NO_LEVELS: readonly (number | null)[] = [null, null];
const SHIFTS: readonly ShiftId[] = ["A", "B"];

const isOp = (op: Assigned | null | undefined): op is Assigned => truthy(op);
const countOps = (slots: Slots): number => slots.reduce((n, op) => (isOp(op) ? n + 1 : n), 0);

export function mergeOperatorData(
  operators: Readonly<Record<string, { name: string; rarity?: number; art?: string; artFallback?: string }>>,
  baseSkills: Readonly<Record<string, { baseSkills: Skill[] }>>,
): OperatorsData {
  const out: OperatorsData = {};
  for (const oid of Object.keys(baseSkills)) out[oid] = { ...baseSkills[oid], ...lookup(operators, oid, { name: oid }) };
  return out;
}

export function skillLevel(profile: Profile, opId: string, i: number): number {
  const dp = profile.dijiangPlanner;
  const lv = at(lookup(dp.operatorSkills, opId, NO_LEVELS), i);
  return lv == null ? at(dp.settings.defaultLevels, i) : lv;
}

export function skillValue(profile: Profile, opId: string, i: number, skill: Skill): number {
  const lv: unknown = skillLevel(profile, opId, i);
  // Python: `0 if lv == 0 else values[lv - 1]`, where False == 0 and True == 1.
  // A stored 1.0 raises in Python (float index) but reads as 1 here: JSON.parse cannot tell them apart.
  if (lv === 0 || lv === false) return 0;
  if (lv === true) return at(skill.values, 0);
  if (typeof lv !== "number") throw new TypeError("unsupported operand type(s) for -");
  return at(skill.values, lv - 1);
}

interface CnTeam {
  /** Mood Regen bonus of each slot */
  per: number[];
  /** 1 + the team's Mood Regen bonuses */
  regen: number;
  /** Mood drain multiplier of the team */
  drain: number;
  n: number;
}

function cnTeam(ops: OperatorsData, profile: Profile, slots: Slots): CnTeam {
  const per = [0.0, 0.0, 0.0];
  let regen = 1.0;
  let drain = 1.0;
  for (let oi = 0; oi < slots.length; oi++) {
    const op = slots[oi];
    if (!isOp(op)) continue;
    const skills = req(ops, op.id).baseSkills;
    for (let i = 0; i < skills.length; i++) {
      const skill = skills[i];
      if (skill.room !== "CN") continue;
      const v = skillValue(profile, op.id, i, skill);
      if (skill.type === "mood regen") {
        regen += v;
        addAt(per, oi, v);
      } else if (skill.type === "mood drain") drain -= v;
    }
  }
  return { per, regen, drain, n: countOps(slots) };
}

/** [mood regen multiplier, CN mood drain multiplier]. */
export function globalMoodRegen(ops: OperatorsData, profile: Profile): [number, number] {
  const t = cnTeam(ops, profile, profile.dijiangPlanner.roomAssignments["CN"]);
  return [t.regen, t.drain];
}

/** "game": Control Nexus operators tire and rest, so their Mood Regen comes and goes. "always": the original planner's always-on Mood Regen. */
export function cnModel(profile: Profile): CnModel {
  return lookup(profile.dijiangPlanner.settings as unknown as Record<string, unknown>, "cnModel", "game") === "always" ? "always" : "game";
}

const efficiencyTypes = (rtype: string): string[] => (rtype === "GC" ? ["fungus", "plant", "mineral"] : ["efficiency"]);

function addAt(a: number[], i: number, v: number): void {
  a[i] = at(a, i) + v;
}

/** [mood drain multiplier, per-slot efficiency bonuses] for one set of 3 slots. */
export function collectBonuses(ops: OperatorsData, profile: Profile, roomId: string, slots: Slots): [number, Bonuses] {
  const rtype = roomType(roomId);
  const settings = lookup(profile.dijiangPlanner.roomSettings, roomId, {} as RoomSettings);
  let drain = 1.0;
  const bonuses: Bonuses = {};
  for (const t of efficiencyTypes(rtype)) bonuses[t] = [0.0, 0.0, 0.0];
  for (let oi = 0; oi < slots.length; oi++) {
    const op = slots[oi];
    if (!isOp(op)) continue;
    const skills = req(ops, op.id).baseSkills;
    for (let i = 0; i < skills.length; i++) {
      const skill = skills[i];
      if (skill.room !== rtype) continue;
      const v = skillValue(profile, op.id, i, skill);
      if (v === 0) continue;
      if (skill.type === "mood drain") {
        drain -= v;
      } else if (rtype === "MFG") {
        const item = lookup(ROOM_DATA.MFG.items, field(settings, "item", null), null);
        if (item && skill.type === item.type) addAt(bonuses.efficiency, oi, v);
      } else if (rtype === "GC") {
        if (Object.hasOwn(bonuses, skill.type)) addAt(bonuses[skill.type], oi, v);
      } else if (rtype === "RR" && skill.type === "clue efficiency") {
        addAt(bonuses.efficiency, oi, v);
      }
    }
  }
  return [drain, bonuses];
}

export function productionMultiplier(nOps: number, bonus: number): number {
  return (1 + nOps * OPERATOR_BONUS) * (1 + bonus);
}

/** Original planner model: one group of operators working through breaks forever. */
export function continuousEfficiency(
  slots: Slots, bonuses: Bonuses, workTime: number, breakTime: number, align: string,
): [Record<string, number>, number] {
  const cycle = workTime + breakTime;
  const uptime = workTime / cycle;
  const eff: Record<string, number> = {};
  for (const [t, b] of Object.entries(bonuses)) {
    if (align === "Staggered") {
      const events: [number, number, number][] = [];
      for (let i = 0; i < 3; i++) {
        if (!isOp(at(slots, i))) continue;
        const start = Math.floor(i * (cycle / 3));
        const end = start + workTime;
        events.push([start, 1, b[i]]);
        if (end <= cycle) events.push([end, -1, -b[i]]);
        else events.push([cycle, -1, -b[i]], [0, 1, b[i]], [end % cycle, -1, -b[i]]);
      }
      events.sort((x, y) => cmp(x[0], y[0])); // stable, like Python's sort
      let total = 0.0;
      let nOps = 0.0;
      let bonus = 0.0;
      for (let k = 0; k < events.length; k++) {
        const [tm, dOps, dB] = events[k];
        if (k > 0 && tm > events[k - 1][0] && nOps > 0) total += productionMultiplier(nOps, bonus) * (tm - events[k - 1][0]);
        nOps += dOps;
        bonus += dB;
      }
      eff[t] = total / cycle;
    } else {
      const picked: number[] = [];
      for (let i = 0; i < 3; i++) if (isOp(at(slots, i))) picked.push(b[i]);
      eff[t] = productionMultiplier(countOps(slots), pySum(picked)) * uptime;
    }
  }
  return [eff, uptime];
}

/** Minute ranges [start, end) of the day where a shift is on schedule but resting at zero mood. */
type Spans = [number, number][];

/**
 * Steady state of one shift. Mood drops while it works inside its window; at
 * zero it rests until max mood, and it recovers whenever it is off schedule.
 * A day depends only on the (mood, resting) state it starts with, so once a
 * start state repeats the days cycle. Some schedules alternate long and short
 * days, so the result is the average over that cycle, not one day. Without an
 * exact repeat it averages the second half of the simulated days: checked against an
 * exact integer simulation, 240 days catch all but about 0.2% of cycles, and those stay
 * within 0.2% of the long-run average.
 * Returns [average minutes worked per day, halted spans when every day is the same].
 */
function simulateWorked(on: Uint8Array, drop: number, regen: number, days: number): [number, Spans | undefined] {
  let mood = 1.0;
  let resting = false;
  const startMood: number[] = [];
  const startResting: boolean[] = [];
  const workedOn: number[] = [];
  const haltedOn: Spans[] = [];
  const mean = (from: number, to: number): number => {
    let sum = 0;
    for (let d = from; d < to; d++) sum += workedOn[d];
    return sum / (to - from);
  };
  for (let day = 0; day < days; day++) {
    for (let k = 0; k < day; k++) {
      if (startMood[k] === mood && startResting[k] === resting) return [mean(k, day), day - k === 1 ? haltedOn[k] : undefined];
    }
    startMood.push(mood);
    startResting.push(resting);
    let today = 0;
    const halted: Spans = [];
    for (let minute = 0; minute < DAY_MIN; minute++) {
      if (on[minute] && !resting && mood > 0) {
        mood -= drop;
        today++;
        if (mood <= 1e-9) {
          mood = 0.0;
          resting = true;
        }
      } else {
        if (on[minute]) {
          const last = halted[halted.length - 1];
          if (last && last[1] === minute) last[1] = minute + 1;
          else halted.push([minute, minute + 1]);
        }
        // within 1e-9 of max counts as max, so float noise cannot cost a minute
        const m = mood + regen;
        mood = m < 1.0 - 1e-9 ? m : 1.0;
        if (resting && mood === 1.0) resting = false;
      }
    }
    workedOn.push(today);
    haltedOn.push(halted);
  }
  return [mean(Math.floor(days / 2), days), undefined];
}

/** Steady state for auto-rotating shifts: [efficiency by type, per-shift stats (daily averages)]. */
export function simulateShifts(
  groups: Readonly<Record<string, ShiftGroup>>, windows: Readonly<Record<string, Window>>, breakTime: number, days = 240,
): [Record<string, number>, Record<string, ShiftStats>] {
  const stats: Record<string, ShiftStats> = {};
  const total: Record<string, number> = {};
  for (const g of Object.values(groups)) for (const t of Object.keys(g.mult)) total[t] = 0.0;
  for (const [s, g] of Object.entries(groups)) {
    const win = req(windows, s);
    const sched = windowLength(win);
    if (g.n === 0 || sched === 0) {
      stats[s] = { scheduled: sched, worked: 0, halted: sched };
      continue;
    }
    const [worked, spans] = simulateWorked(windowMask(win), 60 / g.work, 60 / breakTime, days);
    stats[s] = { scheduled: sched, worked, halted: sched - worked };
    if (spans) stats[s].haltedSpans = spans;
    for (const [t, m] of Object.entries(g.mult)) total[t] += (m * worked) / DAY_MIN;
  }
  return [total, stats];
}

const zeros = (bonuses: Bonuses): Record<string, number> =>
  Object.fromEntries(Object.keys(bonuses).map((t) => [t, 0.0]));

/** The ship's Mood Regen: a constant multiplier, or R(t) when the Control Nexus team rests. */
export interface Ship {
  /** the constant Mood Regen multiplier, or its average when it changes over time */
  regen: number;
  timeline?: Timeline;
  /** working share of an operator without Mood skills or schedule, under R(t) */
  probeUptime?: number;
}

/**
 * One team working through breaks, as simulation units: one unit when Aligned, else one
 * per operator with operator i starting i/3 of a nominal cycle later, like continuousEfficiency.
 */
function teamUnits(slots: Slots, regen: readonly number[], work: number, align: string, rest: number): Unit[] {
  const idx = [0, 1, 2].filter((i) => isOp(at(slots, i)));
  if (idx.length === 0) return [];
  if (align === "Staggered") {
    const cycle = work + rest;
    return idx.map((i) => ({ n: 1, work, regen: regen[i], window: null, ...staggeredStart(Math.floor(i * (cycle / 3)), work, rest) }));
  }
  return [{ n: idx.length, work, regen: idx.reduce((n, i) => n + regen[i], 0), window: null, mood: 1, resting: false }];
}

/**
 * A team working through breaks under R(t): [average efficiency by type, operator uptime].
 * The simulation gives each operator's work-rest rhythm; a Staggered team is taken to keep
 * its even spacing (operators following the same R(t) would slowly drift into step over
 * months, which a player would undo), so its efficiency uses the original planner's
 * staggered timeline with the simulated average break.
 */
function timelineTeam(slots: Slots, bonuses: Bonuses, work: number, align: string, ship: Ship): [Record<string, number>, number] {
  const units = teamUnits(slots, [0, 0, 0], work, align, BREAK_TIME / ship.regen);
  const up = units.reduce((n, u) => n + followTimeline(u, ship.timeline!).uptime, 0) / units.length;
  return continuousEfficiency(slots, bonuses, work, work * (1 / up - 1), align);
}

/** Units for auto-rotating shifts (empty shifts have none): [shift of each unit, units]. */
function shiftUnits(
  groups: Readonly<Record<string, ShiftGroup>>, windows: Readonly<Record<string, Window>>, regen: Readonly<Record<string, number>>,
): [ShiftId[], Unit[]] {
  const ids = SHIFTS.filter((s) => req(groups, s).n > 0);
  return [ids, ids.map((s) => ({
    n: groups[s].n, work: groups[s].work, regen: req(regen, s), window: req(windows, s), mood: 1, resting: false,
  }))];
}

/** Daily averages per shift, from the seconds each shift unit worked and its halted minutes. */
function shiftStats(
  ids: readonly ShiftId[], worked: readonly number[], halted: readonly (Spans | undefined)[], windows: Readonly<Record<string, Window>>,
): Record<ShiftId, ShiftStats> {
  const days = measured() / (DAY_MIN * 60);
  const stats = {} as Record<ShiftId, ShiftStats>;
  for (const s of SHIFTS) {
    const sched = windowLength(req(windows, s));
    const j = ids.indexOf(s);
    if (j < 0) {
      stats[s] = { scheduled: sched, worked: 0, halted: sched };
      continue;
    }
    // a shift that never stops sums to its schedule up to float noise
    let w = worked[j] / 60 / days;
    if (sched - w < 1e-6) w = sched;
    stats[s] = { scheduled: sched, worked: w, halted: sched - w };
    const spans = halted[j];
    if (spans) stats[s].haltedSpans = spans;
  }
  return stats;
}

const NO_SKILL_UNIT: Unit = { n: 1, work: WORK_TIME, regen: 0, window: null, mood: 1, resting: false };

/**
 * Minutes a shift on duty in `win` needs off duty to win back the Mood one shift uses
 * (`work` seconds from max to zero Mood). When the ship's Mood Regen changes over the day it
 * follows R(t) from the shift's rest start, so a Control Nexus timed for that rest counts.
 */
function restNeeded(ship: Ship, win: Window, work: number): number {
  const sched = windowLength(win) * 60;
  const used = pyMin(sched, work) / work;
  if (!ship.timeline) return (used * (BREAK_TIME / ship.regen)) / 60;
  // the rest starts at the end of the window, or at zero Mood when that comes first
  return recoverTime(ship.timeline, work < sched ? win[0] * 60 + work : win[1] * 60, used) / 60;
}

/** Ship from a Control Nexus run: constant when its Mood Regen no longer changes once settled. */
function tiredNexus(res: RoomResult, run: ReturnType<typeof runShip>): [RoomResult, Ship] {
  const tl = run.timeline;
  const r0 = constantFrom(tl);
  if (r0 !== null) {
    res.moodRegen = pct3(r0);
    res.globalBreakTime = secondsToHms(BREAK_TIME / r0);
    return [res, { regen: r0 }];
  }
  const up = followTimeline(NO_SKILL_UNIT, tl).uptime;
  res.moodRegen = pct3(run.regenAvg);
  res.regenUptime = pct3(run.regenOn);
  // average rest of an operator without Mood skills: rests while the Control Nexus team works are shorter
  res.globalBreakTime = secondsToHms(WORK_TIME * (1 / up - 1));
  return [res, { regen: run.regenAvg, timeline: tl, probeUptime: up }];
}

/** The Control Nexus result and the Mood Regen it gives the ship. */
function controlNexus(ops: OperatorsData, profile: Profile, align: string): [RoomResult, Ship] {
  const ra = profile.dijiangPlanner.roomAssignments;
  const game = cnModel(profile) === "game";
  const sh: ShiftSettings = getShiftSettings(profile, "CN");
  if (!truthy(sh.enabled)) {
    const team = cnTeam(ops, profile, ra["CN"]);
    const wt = WORK_TIME / team.drain;
    const res: RoomResult = { globalBreakTime: secondsToHms(BREAK_TIME / team.regen), workTime: secondsToHms(wt), moodRegen: pct3(team.regen) };
    if (!game || team.regen === 1.0) return [res, { regen: team.regen }];
    res.teamMoodRegen = pct3(team.regen);
    return tiredNexus(res, runShip(teamUnits(ra["CN"], team.per, wt, align, BREAK_TIME / team.regen)));
  }

  const windows = shiftWindows(sh);
  const slots: Record<ShiftId, Slots> = { A: ra["CN"], B: lookup(ra, shiftSlot("CN", "B"), [null, null, null]) };
  const teams: Record<ShiftId, CnTeam> = { A: cnTeam(ops, profile, slots.A), B: cnTeam(ops, profile, slots.B) };
  const info = {} as Record<ShiftId, ShiftInfo>;
  for (const s of SHIFTS) {
    const { n, regen, drain } = teams[s];
    const wt = WORK_TIME / drain;
    const sched = windowLength(windows[s]);
    info[s] = {
      window: windows[s], workTime: wt, workTimeLabel: secondsToHmin(wt), moodDropPerHour: (100 * 3600) / wt, operators: n,
      multipliers: { "mood regen": regen }, scheduledMin: sched, covers: n === 0 || wt >= sched * 60,
      breakTime: BREAK_TIME, restAvailableMin: DAY_MIN - sched, restNeededMin: 0,
    };
  }
  let res: RoomResult = { workTime: SHIFTS.map((s) => info[s].workTimeLabel).join(" / "), shifts: info };
  let ship: Ship;
  if (truthy(sh.autoRotate)) {
    if (!game) {
      // always on: each shift gives its Mood Regen through all of its hours
      const regen = 1 + (teams.A.regen - 1) * (info.A.scheduledMin / DAY_MIN) + (teams.B.regen - 1) * (info.B.scheduledMin / DAY_MIN);
      for (const s of SHIFTS) {
        const sched = info[s].scheduledMin;
        Object.assign(info[s], teams[s].n ? { scheduled: sched, worked: sched, halted: 0, haltedSpans: [] } : { scheduled: sched, worked: 0, halted: sched });
      }
      res.moodRegen = pct3(regen);
      res.globalBreakTime = secondsToHms(BREAK_TIME / regen);
      ship = { regen };
    } else {
      const groups = Object.fromEntries(SHIFTS.map((s) => [s, { n: teams[s].n, work: info[s].workTime, mult: {} }]));
      const [ids, units] = shiftUnits(groups, windows, { A: teams.A.regen - 1, B: teams.B.regen - 1 });
      const run = runShip(units);
      const stats = shiftStats(ids, run.worked, run.halted, windows);
      for (const s of SHIFTS) Object.assign(info[s], stats[s]);
      [res, ship] = tiredNexus(res, run);
    }
  } else {
    // rotating by hand: the active shift works through its breaks, the other one rests
    const team = teams[sh.active];
    const wt = WORK_TIME / team.drain;
    res.moodRegen = pct3(team.regen);
    res.globalBreakTime = secondsToHms(BREAK_TIME / team.regen);
    if (!game || team.regen === 1.0) ship = { regen: team.regen };
    else {
      res.teamMoodRegen = pct3(team.regen);
      [res, ship] = tiredNexus(res, runShip(teamUnits(slots[sh.active], team.per, wt, align, BREAK_TIME / team.regen)));
    }
  }
  for (const s of SHIFTS) {
    info[s].breakTime = BREAK_TIME / ship.regen;
    info[s].restNeededMin = restNeeded(ship, info[s].window, info[s].workTime);
  }
  return [res, ship];
}

/** What every room depends on: the Control Nexus result and the Mood Regen it gives the ship. */
export interface ShipState {
  cn: RoomResult;
  ship: Ship;
  align: string;
}

export function shipState(ops: OperatorsData, profile: Profile): ShipState {
  const align = field(profile.dijiangPlanner.settings, "align", "Staggered");
  const [cn, ship] = controlNexus(ops, profile, align);
  return { cn, ship, align };
}

const PRESENT: Assigned = { id: "", fixed: false };

/**
 * Minutes a day an auto-rotating shift with operators works, as roomEfficiency counts them:
 * `work` seconds from max to zero Mood, on duty in `win`. Used by the planner.
 */
export function shiftWorked(st: ShipState, work: number, win: Window): number {
  const { ship } = st;
  if (ship.timeline) {
    const f = followTimeline({ n: 1, work, regen: 0, window: win, mood: 1, resting: false }, ship.timeline);
    const sched = windowLength(win);
    const w = f.worked / 60 / (measured() / (DAY_MIN * 60));
    return sched - w < 1e-6 ? sched : w;
  }
  return simulateWorked(windowMask(win), 60 / work, 60 / (BREAK_TIME / ship.regen), 240)[0];
}

/**
 * Average break of a team that works through its breaks, as roomEfficiency counts it:
 * `present` marks the slots with an operator (they start staggered by slot).
 */
export function teamBreak(st: ShipState, present: readonly boolean[], work: number): number {
  const { ship, align } = st;
  const breakTime = BREAK_TIME / ship.regen;
  if (!ship.timeline) return breakTime;
  const units = teamUnits(present.map((p) => (p ? PRESENT : null)), [0, 0, 0], work, align, breakTime);
  const up = units.reduce((n, u) => n + followTimeline(u, ship.timeline!).uptime, 0) / units.length;
  return work * (1 / up - 1);
}

/**
 * One room's average efficiency by type (null for an empty room without Shift B) and its
 * uptime, work time and shift details. Rooms only depend on each other through the ship,
 * so an optimizer can try changes to one room against the same ShipState.
 */
export function roomEfficiency(
  ops: OperatorsData, profile: Profile, roomId: string, st: ShipState,
): [Record<string, number> | null, Partial<RoomResult>] {
  const { ship, align } = st;
  const breakTime = BREAK_TIME / ship.regen;
  const assignments = profile.dijiangPlanner.roomAssignments;
  const assignment = assignments[roomId];
  const sh = getShiftSettings(profile, roomId);
  const res: Partial<RoomResult> = {};
  let eff: Record<string, number>;
  if (truthy(sh.enabled)) {
    const windows = shiftWindows(sh);
    const slots: Record<ShiftId, Slots> = { A: assignment, B: lookup(assignments, shiftSlot(roomId, "B"), [null, null, null]) };
    const groups: Record<string, ShiftGroup> = {};
    const collected: Record<string, [number, Bonuses]> = {};
    const info = {} as Record<ShiftId, ShiftInfo>;
    for (const s of SHIFTS) {
      const [drain, bonuses] = (collected[s] = collectBonuses(ops, profile, roomId, slots[s]));
      const n = countOps(slots[s]);
      const wt = WORK_TIME / drain;
      const mult: Record<string, number> = {};
      for (const [t, b] of Object.entries(bonuses)) mult[t] = n ? productionMultiplier(n, pySum(b)) : 0.0;
      groups[s] = { n, work: wt, mult };
      const sched = windowLength(windows[s]);
      info[s] = {
        window: windows[s], workTime: wt, workTimeLabel: secondsToHmin(wt),
        moodDropPerHour: (100 * 3600) / wt, operators: n,
        multipliers: mult, scheduledMin: sched,
        covers: n === 0 || wt >= sched * 60,
        breakTime,
        restAvailableMin: DAY_MIN - sched,
        restNeededMin: restNeeded(ship, windows[s], wt),
      };
    }
    if (truthy(sh.autoRotate)) {
      let stats: Record<string, ShiftStats>;
      if (ship.timeline) {
        const types = Object.keys(groups.A.mult);
        const [ids, units] = shiftUnits(groups, windows, { A: 0, B: 0 });
        const runs = units.map((u) => followTimeline(u, ship.timeline!));
        stats = shiftStats(ids, runs.map((f) => f.worked), runs.map((f) => f.halted), windows);
        // the shifts never overlap, so each one adds its multiplier while it works (as in simulateShifts)
        eff = Object.fromEntries(types.map((t) => [t, 0.0]));
        for (const s of SHIFTS) for (const t of types) eff[t] += (groups[s].mult[t] * stats[s].worked) / DAY_MIN;
      } else {
        [eff, stats] = simulateShifts(groups, windows, breakTime);
      }
      for (const s of SHIFTS) Object.assign(info[s], stats[s]);
      res.operatorUptime = pct3((stats.A.worked + stats.B.worked) / DAY_MIN);
    } else {
      // the Python version recomputes collect_bonuses here; it is pure, so reuse it
      const act = sh.active;
      const [drain, bonuses] = req(collected, act);
      const wt = WORK_TIME / drain;
      let up: number;
      if (!req(groups, act).n) [eff, up] = [zeros(bonuses), 0.0];
      else if (ship.timeline) [eff, up] = timelineTeam(slots[act], bonuses, wt, align, ship);
      else [eff, up] = continuousEfficiency(slots[act], bonuses, wt, breakTime, align);
      res.operatorUptime = pct3(up);
    }
    res.shifts = info;
    res.workTime = SHIFTS.map((s) => info[s].workTimeLabel).join(" / ");
  } else {
    if (assignment.every((x) => x == null)) {
      return [null, { workTime: secondsToHms(WORK_TIME), operatorUptime: pct3(ship.probeUptime ?? WORK_TIME / (WORK_TIME + breakTime)) }];
    }
    const [drain, bonuses] = collectBonuses(ops, profile, roomId, assignment);
    const wt = WORK_TIME / drain;
    let up: number;
    if (ship.timeline) [eff, up] = timelineTeam(assignment, bonuses, wt, align, ship);
    else [eff, up] = continuousEfficiency(assignment, bonuses, wt, breakTime, align);
    res.workTime = secondsToHms(wt);
    res.operatorUptime = pct3(up);
  }
  return [eff, res];
}

export function computeProductivity(ops: OperatorsData, profile: Profile): Results {
  const dp = profile.dijiangPlanner;
  const st = shipState(ops, profile);
  const result: Results = { CN: st.cn };

  for (const roomId of Object.keys(dp.roomAssignments)) {
    if (roomId === "CN" || roomId.includes("#")) continue;
    const rtype = roomType(roomId);
    const [eff, res] = roomEfficiency(ops, profile, roomId, st);
    if (eff === null) {
      result[roomId] = res as RoomResult;
      continue;
    }

    const settings = lookup(dp.roomSettings, roomId, {} as RoomSettings);
    if (rtype === "MFG") {
      const e = lookup(eff, "efficiency", 0.0);
      res.efficiency = pct3(e);
      const item = lookup(ROOM_DATA.MFG.items, field(settings, "item", null), null);
      if (item && e > 0) {
        const dur = item.duration / e;
        res.duration = secondsToHms(dur);
        res.xpPerSecond = fmt3(item.value / dur);
        res.xpPerHour = fmt3((3600 * item.value) / dur);
        res.xpPerHourNum = (3600 * item.value) / dur;
        res.xpType = item.type;
        res.itemsPerDay = fmt3(86400 / dur);
      }
    } else if (rtype === "GC") {
      for (const t of ["fungus", "plant", "mineral"] as const) res[t] = pct3(lookup(eff, t, 0.0));
      const items: (GCItemResult | null)[] = [];
      for (const itemId of field(settings, "items", [null, null, null])) {
        const item = truthy(itemId) ? lookup(ROOM_DATA.GC.items, itemId, null) : null;
        if (!item) {
          items.push(null);
          continue;
        }
        const e = lookup(eff, item.type, 0.0);
        items.push({ name: item.name, duration: e > 0 ? secondsToHms(item.duration / e) : "--" });
      }
      res.items = items;
    } else if (rtype === "RR") {
      const e = lookup(eff, "efficiency", 0.0);
      res.efficiency = pct3(e);
      res.duration = e > 0 ? secondsToHms(ROOM_DATA.RR.duration / e) : "--";
      res.cluesPerDay = fmt3((86400 * e) / ROOM_DATA.RR.duration);
    }
    result[roomId] = res as RoomResult;
  }
  return result;
}
