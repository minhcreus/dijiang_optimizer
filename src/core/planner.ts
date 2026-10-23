// Planner behind Optimize: who works where, each room's Shift A/B hours and how many
// Control Nexus operators are worth it, for the highest total output the model gives.
//
// Score = the sum over the production rooms of room priority x efficiency, where the
// Growth Chamber counts the average over its chosen plots (all three types when none are
// chosen). Rooms only depend on each other through the ship's Mood Regen, which only
// depends on the Control Nexus, so the planner:
// 1. tries Control Nexus line-ups (empty, 1-3 operators working through breaks, or two
//    shifts of 1-3 operators), best Mood Regen first, and builds each ship once;
// 2. fills the production rooms against that ship from two starts, no Shift B anywhere
//    and a long Shift A everywhere: one operator at a time where it adds the most (a
//    room's first operator adds 40% even without a matching skill), then moves, swaps,
//    every Shift A length and opening or closing Shift B, until nothing improves;
// 3. polishes the best plan: Control Nexus operators swapped with the others, and other
//    start times when the Control Nexus schedule makes the time of day matter.
// A room's value only depends on each team's size, skill bonuses and work time, so the
// minutes a shift works are cached per ship, work time and window: most tries cost a few
// multiplications. Every number comes from the same functions as the results (calc.ts).
import { BREAK_TIME, DAY_MIN, OPERATOR_BONUS, ROOM_DATA, ROOM_IDS, WORK_TIME, roomType, shiftSlot } from "./constants.ts";
import { roomEfficiency, shiftWorked, shipState, skillValue, teamBreak } from "./calc.ts";
import type { ShipState } from "./calc.ts";
import { getShiftSettings, roomOn, roomWeights, syncSlots } from "./profile.ts";
import { field, lookup, truthy } from "./py.ts";
import { shiftWindows, windowLength } from "./shifts.ts";
import type { Assigned, OperatorsData, Profile, RoomSettings, ShiftSettings, Slots, Window } from "./types.ts";

export interface PlanOptions {
  /** keep every room's Shift A/B settings and only pick operators */
  keepHours?: boolean;
  /** stop improving after this long (ms); the best plan so far is returned */
  budgetMs?: number;
}

export interface PlanResult {
  profile: Profile;
  /** planner score (sum of room priority x efficiency) of the new plan and of the profile it started from */
  score: number;
  before: number;
}

const PROD = ROOM_IDS.filter((r) => r !== "CN");
const NR = PROD.length;
/** room index of the Control Nexus: positions (g * 2 + shift) * 3 + slot, production rooms first */
const CN = NR;
const NPOS = (NR + 1) * 6;
const EPS = 1e-9;
/** Shift A ends at midnight unless the user's plan says otherwise; Control Nexus Shift A covers the night */
const CN_HOURS = 20 * 24 + 12;
const LONG_A = 16;
/** a Control Nexus change this close to the best gets a full search */
const CLOSE = 0.005;
/** weight of the resting team in a room rotated by hand: filled with the best of the rest */
const RESERVE = 0.05;
/** an empty Shift B worth less than this share is closed (below it the gain is rounding) */
const TIDY = 0.001;

const at3 = (g: number, s: number): number => (g * 2 + s) * 3;
const roomOf = (p: number): number => (p / 6) | 0;
const teamOf = (p: number): number => (p / 3) | 0;
const roomId = (g: number): string => (g === CN ? "CN" : PROD[g]);

// ---------------------------------------------------------------- shift hours

/** Shift A on duty [start, start + len) hours (wrapping past midnight) as id start * 24 + len; -1 = no Shift B. */
const hoursId = (start: number, len: number): number => (((start % 24) + 24) % 24) * 24 + len;
const startOf = (h: number): number => Math.floor(h / 24);
const lenOf = (h: number): number => h % 24;
const endOf = (h: number): number => (startOf(h) + lenOf(h)) % 24;

function barOf(h: number): Pick<ShiftSettings, "p" | "q" | "inner"> {
  const start = startOf(h);
  const end = start + lenOf(h);
  return end <= 24 ? { inner: "A", p: start * 60, q: end * 60 } : { inner: "B", p: (end - 24) * 60, q: start * 60 };
}


/** The hours id of a shift bar with whole-hour windows, else null. */
function hoursOfBar(sh: ShiftSettings): number | null {
  const a = shiftWindows(sh).A;
  const len = windowLength(a);
  if (a[0] % 60 || len % 60 || len >= DAY_MIN) return null;
  return hoursId(a[0] / 60, len / 60);
}

// ---------------------------------------------------------------- operators

/** How a production room runs: without Shift B, with auto-rotating shifts, or rotated by hand. */
interface Run {
  kind: "none" | "auto" | "hand";
  a: Window;
  b: Window;
  active: number;
}
const NO_RUN: Run = { kind: "none", a: [0, DAY_MIN], b: [0, DAY_MIN], active: 0 };
/** auto-rotating runs by hours id */
const AUTO: Run[] = [];
for (let h = 0; h < 24 * 24; h++) {
  if (lenOf(h) === 0) continue;
  const w = shiftWindows(barOf(h));
  AUTO[h] = { kind: "auto", a: w.A, b: w.B, active: 0 };
}

interface Prep {
  ops: OperatorsData;
  profile: Profile;
  keep: boolean;
  ids: string[];
  /** [o * NR + r]: bonus that counts in production room r (Growth Chamber: averaged over its plots) and Mood Drop reduction there */
  beta: Float64Array;
  drain: Float64Array;
  /** Control Nexus Mood Regen and Mood Drop reduction */
  regen: Float64Array;
  cnDrain: Float64Array;
  weight: number[];
  /** [g]: room g is switched off (production rooms, then the Control Nexus) */
  off: boolean[];
  /** operators the planner places */
  pool: number[];
  /** fixed operator per position, -1 where none */
  fixed: Int16Array;
  /** the fixed Assigned entries, to put back unchanged */
  fixedEntry: (Assigned | null)[];
  /** keep mode: how each room runs, and whether the Control Nexus has Shift B */
  runs: Run[];
  cnShift: boolean;
}

function prepare(ops: OperatorsData, profile: Profile, available: readonly string[], keep: boolean): Prep {
  const dp = profile.dijiangPlanner;
  const ids: string[] = [];
  const index = new Map<string, number>();
  const add = (id: string): number => {
    let o = index.get(id);
    if (o === undefined) {
      o = ids.length;
      index.set(id, o);
      ids.push(id);
    }
    return o;
  };
  const fixed = new Int16Array(NPOS).fill(-1);
  const fixedEntry: (Assigned | null)[] = new Array(NPOS).fill(null);
  const off = [...PROD, "CN"].map((rid) => !roomOn(profile, rid));
  for (let g = 0; g <= NR; g++) {
    if (off[g]) continue;
    for (let s = 0; s < 2; s++) {
      const slots = lookup(dp.roomAssignments, shiftSlot(roomId(g), s ? "B" : "A"), [] as Slots);
      for (let i = 0; i < 3; i++) {
        const op = slots[i];
        if (!truthy(op) || !truthy(op!.fixed) || !Object.hasOwn(ops, op!.id)) continue;
        fixed[at3(g, s) + i] = add(op!.id);
        fixedEntry[at3(g, s) + i] = op!;
      }
    }
  }
  const isFixed = new Set(fixedEntry.filter((x) => x).map((x) => x!.id));
  const pool = [...new Set(available)].filter((id) => Object.hasOwn(ops, id) && !isFixed.has(id)).map(add);

  const n = ids.length;
  const beta = new Float64Array(n * NR);
  const drain = new Float64Array(n * NR);
  const regen = new Float64Array(n);
  const cnDrain = new Float64Array(n);
  const settings = (rid: string): RoomSettings => lookup(dp.roomSettings, rid, {} as RoomSettings);
  const plots = (field(settings("GC"), "items", []) ?? []).filter((x) => truthy(x) && Object.hasOwn(ROOM_DATA.GC.items, x as string)) as string[];
  const gcWeight: Record<string, number> = {};
  for (const t of ["fungus", "plant", "mineral"]) {
    gcWeight[t] = plots.length ? plots.filter((x) => ROOM_DATA.GC.items[x].type === t).length / plots.length : 1 / 3;
  }
  ids.forEach((id, o) => {
    ops[id].baseSkills.forEach((skill, i) => {
      if (skill.room === "CN") {
        const v = skillValue(profile, id, i, skill);
        if (skill.type === "mood regen") regen[o] += v;
        else if (skill.type === "mood drain") cnDrain[o] += v;
        return;
      }
      for (let r = 0; r < NR; r++) {
        const rid = PROD[r];
        if (skill.room !== roomType(rid)) continue;
        const v = skillValue(profile, id, i, skill);
        if (v === 0) continue;
        if (skill.type === "mood drain") drain[o * NR + r] += v;
        else if (skill.room === "MFG") {
          const item = lookup(ROOM_DATA.MFG.items, field(settings(rid), "item", null), null);
          if (item && skill.type === item.type) beta[o * NR + r] += v;
        } else if (skill.room === "GC") {
          if (Object.hasOwn(gcWeight, skill.type)) beta[o * NR + r] += gcWeight[skill.type] * v;
        } else if (skill.room === "RR" && skill.type === "clue efficiency") beta[o * NR + r] += v;
      }
    });
  });
  const prio = roomWeights(profile);
  const runs = PROD.map((rid): Run => {
    const sh = getShiftSettings(profile, rid);
    if (!truthy(sh.enabled)) return NO_RUN;
    const w = shiftWindows(sh);
    return { kind: truthy(sh.autoRotate) ? "auto" : "hand", a: w.A, b: w.B, active: sh.active === "B" ? 1 : 0 };
  });
  return {
    ops, profile, keep, ids, beta, drain, regen, cnDrain, weight: PROD.map((r, g) => (off[g] ? 0 : prio[r] ?? 1)), off, pool, fixed, fixedEntry,
    runs, cnShift: truthy(getShiftSettings(profile, "CN").enabled),
  };
}

// ---------------------------------------------------------------- one ship

/** Work time of a team from its Mood Drop reductions (rounded so equal teams share cache entries). */
const workOf = (d: number): number => WORK_TIME / (1 - Math.round(d * 1e9) / 1e9);

/** A built ship and the minutes its shifts work, cached by work time and window. */
class ShipEval {
  readonly st: ShipState;
  private readonly varying: boolean;
  private readonly worked = new Map<number, Map<number, number>>();
  private readonly breaks = new Map<number, Float64Array>();

  constructor(st: ShipState) {
    this.st = st;
    this.varying = st.ship.timeline !== undefined;
  }

  /** Share of the day a shift with operators works. Without a changing Mood Regen it only depends on the window's length. */
  hours(work: number, win: Window): number {
    let m = this.worked.get(work);
    if (!m) this.worked.set(work, (m = new Map()));
    const key = this.varying ? win[0] * 2048 + win[1] : windowLength(win);
    let h = m.get(key);
    if (h === undefined) {
      h = shiftWorked(this.st, work, win) / DAY_MIN;
      m.set(key, h);
    }
    return h;
  }

  /** Average break of a team working through its breaks; mask = its filled slots. */
  rest(work: number, mask: number): number {
    if (!this.varying) return BREAK_TIME / this.st.ship.regen;
    if (this.st.align !== "Staggered") mask = 1;
    let a = this.breaks.get(work);
    if (!a) this.breaks.set(work, (a = new Float64Array(8).fill(NaN)));
    if (Number.isNaN(a[mask])) a[mask] = teamBreak(this.st, [1, 2, 4].map((b) => (mask & b) !== 0), work);
    return a[mask];
  }
}

// up to 4 events per operator: start, end of the cycle, start of the cycle, end
const ev = new Float64Array(36);

/** continuousEfficiency for one Staggered team, with the skill bonus of each slot in b. */
function staggered(mask: number, b: readonly number[], work: number, rest: number): number {
  const cycle = work + rest;
  let m = 0;
  for (let i = 0; i < 3; i++) {
    if (!(mask & (1 << i))) continue;
    const start = Math.floor(i * (cycle / 3));
    const end = start + work;
    ev[m * 3] = start; ev[m * 3 + 1] = 1; ev[m * 3 + 2] = b[i]; m++;
    if (end <= cycle) {
      ev[m * 3] = end; ev[m * 3 + 1] = -1; ev[m * 3 + 2] = -b[i]; m++;
    } else {
      ev[m * 3] = cycle; ev[m * 3 + 1] = -1; ev[m * 3 + 2] = -b[i]; m++;
      ev[m * 3] = 0; ev[m * 3 + 1] = 1; ev[m * 3 + 2] = b[i]; m++;
      ev[m * 3] = end % cycle; ev[m * 3 + 1] = -1; ev[m * 3 + 2] = -b[i]; m++;
    }
  }
  // stable insertion sort by time, like the sort in continuousEfficiency
  for (let k = 1; k < m; k++) {
    const t = ev[k * 3], dn = ev[k * 3 + 1], db = ev[k * 3 + 2];
    let j = k - 1;
    while (j >= 0 && ev[j * 3] > t) {
      ev[(j + 1) * 3] = ev[j * 3]; ev[(j + 1) * 3 + 1] = ev[j * 3 + 1]; ev[(j + 1) * 3 + 2] = ev[j * 3 + 2];
      j--;
    }
    ev[(j + 1) * 3] = t; ev[(j + 1) * 3 + 1] = dn; ev[(j + 1) * 3 + 2] = db;
  }
  let total = 0.0;
  let n = 0.0;
  let bonus = 0.0;
  for (let k = 0; k < m; k++) {
    const tm = ev[k * 3];
    if (k > 0 && tm > ev[(k - 1) * 3] && n > 0) total += (1 + n * OPERATOR_BONUS) * (1 + bonus) * (tm - ev[(k - 1) * 3]);
    n += ev[k * 3 + 1];
    bonus += ev[k * 3 + 2];
  }
  return total / cycle;
}

// ---------------------------------------------------------------- plans

interface Plan {
  /** operator per position, -1 = empty */
  pos: Int16Array;
  /** full mode: hours id of each room's Shift A (Control Nexus last), -1 = no Shift B */
  hours: Int16Array;
}

const clonePlan = (x: Plan): Plan => ({ pos: x.pos.slice(), hours: x.hours.slice() });

const bslot = [0, 0, 0];

class Planner {
  readonly P: Prep;
  private readonly ships = new Map<string, ShipEval>();
  private readonly scratch: Profile;
  private readonly deadline: number;
  shipBuilds = 0;

  constructor(P: Prep, budgetMs: number) {
    this.P = P;
    this.scratch = structuredClone(P.profile);
    this.deadline = performance.now() + budgetMs;
  }

  timeUp(): boolean {
    return performance.now() > this.deadline;
  }

  run(plan: Plan, r: number): Run {
    if (this.P.keep) return this.P.runs[r];
    const h = plan.hours[r];
    return h < 0 ? NO_RUN : AUTO[h];
  }

  /** Can shift s of room g hold operators? */
  usable(plan: Plan, g: number, s: number): boolean {
    if (this.P.off[g]) return false;
    if (s === 0) return true;
    if (g === CN) return this.P.keep ? this.P.cnShift : plan.hours[CN] >= 0;
    return this.P.keep ? this.P.runs[g].kind !== "none" : plan.hours[g] >= 0;
  }

  ship(plan: Plan): ShipEval {
    const P = this.P;
    const shift = this.usable(plan, CN, 1);
    let key = this.P.keep ? "" : `${plan.hours[CN]}`;
    for (let s = 0; s < (shift ? 2 : 1); s++) {
      for (let i = 0; i < 3; i++) {
        const o = plan.pos[at3(CN, s) + i];
        key += o < 0 ? "|-" : `|${P.regen[o]},${P.cnDrain[o]}`;
      }
    }
    let se = this.ships.get(key);
    if (!se) {
      const dp = this.scratch.dijiangPlanner;
      const slots = (s: number): Slots => [0, 1, 2].map((i) => {
        const o = plan.pos[at3(CN, s) + i];
        return o < 0 ? null : { id: P.ids[o], fixed: false };
      });
      dp.roomAssignments.CN = slots(0);
      if (shift) dp.roomAssignments["CN#B"] = slots(1);
      else delete dp.roomAssignments["CN#B"];
      if (!P.keep) {
        const sh = getShiftSettings(P.profile, "CN");
        const h = plan.hours[CN];
        dp.roomSettings.CN = { ...(dp.roomSettings.CN ?? {}), shift: h < 0 ? { ...sh, enabled: false } : { ...sh, enabled: true, autoRotate: true, ...barOf(h) } };
      }
      se = new ShipEval(shipState(P.ops, this.scratch));
      this.ships.set(key, se);
      this.shipBuilds++;
    }
    return se;
  }

  /** Weighted value of production room r. */
  value(se: ShipEval, plan: Plan, r: number): number {
    const run = this.run(plan, r);
    let v: number;
    if (run.kind === "auto") v = this.shiftValue(se, plan, r, 0, run.a) + this.shiftValue(se, plan, r, 1, run.b);
    // rotated by hand: the active team works through its breaks (as in the results); the other one is the reserve
    else if (run.kind === "hand") v = this.breaksValue(se, plan, r, run.active) + RESERVE * this.breaksValue(se, plan, r, 1 - run.active);
    else v = this.breaksValue(se, plan, r, 0);
    return this.P.weight[r] * v;
  }

  /** Auto-rotating shifts of room r with operators that run out of Mood on duty (the results warn about these). */
  halts(se: ShipEval, plan: Plan, r: number): number {
    const run = this.run(plan, r);
    if (run.kind !== "auto") return 0;
    let n = 0;
    for (const [s, win] of [[0, run.a], [1, run.b]] as const) {
      let d = 0;
      let any = false;
      for (let i = 0; i < 3; i++) {
        const o = plan.pos[at3(r, s) + i];
        if (o < 0) continue;
        any = true;
        d += this.P.drain[o * NR + r];
      }
      if (any && se.hours(workOf(d), win) * DAY_MIN < windowLength(win) - 1e-6) n++;
    }
    return n;
  }

  private shiftValue(se: ShipEval, plan: Plan, r: number, s: number, win: Window): number {
    const { beta, drain } = this.P;
    const base = at3(r, s);
    let n = 0;
    let b = 0;
    let d = 0;
    for (let i = 0; i < 3; i++) {
      const o = plan.pos[base + i];
      if (o < 0) continue;
      n++;
      b += beta[o * NR + r];
      d += drain[o * NR + r];
    }
    if (n === 0) return 0;
    return (1 + n * OPERATOR_BONUS) * (1 + b) * se.hours(workOf(d), win);
  }

  private breaksValue(se: ShipEval, plan: Plan, r: number, s: number): number {
    const { beta, drain } = this.P;
    const base = at3(r, s);
    let n = 0;
    let b = 0;
    let d = 0;
    let mask = 0;
    for (let i = 0; i < 3; i++) {
      const o = plan.pos[base + i];
      bslot[i] = 0;
      if (o < 0) continue;
      n++;
      mask |= 1 << i;
      bslot[i] = beta[o * NR + r];
      b += bslot[i];
      d += drain[o * NR + r];
    }
    if (n === 0) return 0;
    const work = workOf(d);
    const rest = se.rest(work, mask);
    if (se.st.align === "Staggered") return staggered(mask, bslot, work, rest);
    return (1 + n * OPERATOR_BONUS) * (1 + b) * (work / (work + rest));
  }

  total(se: ShipEval, plan: Plan): number {
    let j = 0;
    for (let r = 0; r < NR; r++) j += this.value(se, plan, r);
    return j;
  }
}

/** Local search on the production rooms of one plan against one ship. */
class Search {
  readonly pl: Planner;
  readonly plan: Plan;
  se: ShipEval;
  readonly val = new Float64Array(NR);
  /** position of each operator, -1 = not placed */
  readonly where: Int16Array;

  constructor(pl: Planner, plan: Plan) {
    this.pl = pl;
    this.plan = plan;
    this.se = pl.ship(plan);
    this.where = new Int16Array(pl.P.ids.length).fill(-1);
    plan.pos.forEach((o, p) => {
      if (o >= 0) this.where[o] = p;
    });
    this.refresh();
  }

  refresh(): void {
    for (let r = 0; r < NR; r++) this.val[r] = this.pl.value(this.se, this.plan, r);
  }

  get score(): number {
    let j = 0;
    for (let r = 0; r < NR; r++) j += this.val[r];
    return j;
  }

  private v(r: number): number {
    return this.pl.value(this.se, this.plan, r);
  }

  bench(): number[] {
    return this.pl.P.pool.filter((o) => this.where[o] < 0);
  }

  put(p: number, o: number): void {
    const old = this.plan.pos[p];
    if (old >= 0) this.where[old] = -1;
    this.plan.pos[p] = o;
    if (o >= 0) this.where[o] = p;
  }

  private swap(a: number, b: number): void {
    const pos = this.plan.pos;
    [pos[a], pos[b]] = [pos[b], pos[a]];
    if (pos[a] >= 0) this.where[pos[a]] = a;
    if (pos[b] >= 0) this.where[pos[b]] = b;
  }

  /** Movable production positions in shifts that can hold operators. */
  private positions(): number[] {
    const out: number[] = [];
    const { fixed } = this.pl.P;
    for (let r = 0; r < NR; r++) {
      for (let s = 0; s < 2; s++) {
        if (!this.pl.usable(this.plan, r, s)) continue;
        for (let i = 0; i < 3; i++) if (fixed[at3(r, s) + i] < 0) out.push(at3(r, s) + i);
      }
    }
    return out;
  }

  /** Add operators one at a time where they add the most, while that helps. */
  fill(): boolean {
    let any = false;
    for (;;) {
      const bench = this.bench();
      if (!bench.length) return any;
      let best = -1;
      let bestOp = -1;
      let bestGain = EPS;
      let bestV = 0;
      for (let r = 0; r < NR; r++) {
        for (let s = 0; s < 2; s++) {
          if (!this.pl.usable(this.plan, r, s)) continue;
          const base = at3(r, s);
          let p = -1;
          for (let i = 0; i < 3 && p < 0; i++) if (this.plan.pos[base + i] < 0) p = base + i;
          if (p < 0) continue;
          for (const o of bench) {
            this.plan.pos[p] = o;
            const v = this.v(r);
            this.plan.pos[p] = -1;
            if (v - this.val[r] > bestGain) [best, bestOp, bestGain, bestV] = [p, o, v - this.val[r], v];
          }
        }
      }
      if (best < 0) return any;
      this.put(best, bestOp);
      this.val[roomOf(best)] = bestV;
      any = true;
    }
  }

  /** Swap any two operators (or an operator and an empty slot), or swap one for an unplaced operator, while that helps. */
  swaps(): boolean {
    let any = false;
    const pos = this.plan.pos;
    for (let round = 0; round < 20; round++) {
      let better = false;
      const ps = this.positions();
      for (let x = 0; x < ps.length; x++) {
        for (let y = x + 1; y < ps.length; y++) {
          const a = ps[x];
          const b = ps[y];
          const oa = pos[a];
          const ob = pos[b];
          if ((oa < 0 && ob < 0) || teamOf(a) === teamOf(b)) continue;
          const ra = roomOf(a);
          const rb = roomOf(b);
          pos[a] = ob;
          pos[b] = oa;
          const va = this.v(ra);
          const vb = ra === rb ? va : this.v(rb);
          const gain = ra === rb ? va - this.val[ra] : va + vb - this.val[ra] - this.val[rb];
          pos[a] = oa;
          pos[b] = ob;
          if (gain > EPS) {
            this.swap(a, b);
            this.val[ra] = va;
            this.val[rb] = vb;
            better = true;
          }
        }
        const a = ps[x];
        const r = roomOf(a);
        for (const o of this.bench()) {
          const old = pos[a];
          pos[a] = o;
          const v = this.v(r);
          pos[a] = old;
          if (v - this.val[r] > EPS) {
            this.put(a, o);
            this.val[r] = v;
            better = true;
          }
        }
      }
      if (!better) break;
      any = true;
      if (this.pl.timeUp()) break;
    }
    return any;
  }

  /** Close Shift B of room r: its operators leave. */
  private closeB(r: number): void {
    const base = at3(r, 1);
    for (let i = 0; i < 3; i++) if (this.pl.P.fixed[base + i] < 0 && this.plan.pos[base + i] >= 0) this.put(base + i, -1);
  }

  private hasFixedB(r: number): boolean {
    const base = at3(r, 1);
    return [0, 1, 2].some((i) => this.pl.P.fixed[base + i] >= 0);
  }

  /** Best Shift A length for each room (or no Shift B), keeping where its Shift A ends. */
  windows(): boolean {
    let any = false;
    const { hours } = this.plan;
    for (let r = 0; r < NR; r++) {
      if (this.pl.P.off[r]) continue;
      const cur = hours[r];
      const end = cur < 0 ? 0 : endOf(cur);
      let best = cur;
      let bestV = this.val[r];
      for (let len = 0; len < 24; len++) {
        const h = len === 0 ? -1 : hoursId(end - len, len);
        if (h === cur || (h < 0 && this.hasFixedB(r))) continue;
        hours[r] = h;
        const v = this.v(r);
        if (v > bestV + EPS) [best, bestV] = [h, v];
      }
      hours[r] = best;
      if (best !== cur) {
        if (best < 0) this.closeB(r);
        this.val[r] = bestV;
        any = true;
      }
    }
    return any;
  }

  /** Open Shift B in a room without it, moving in one operator (unplaced, or from another room). */
  openB(): boolean {
    const { hours, pos } = this.plan;
    let best: { r: number; h: number; o: number; from: number; gain: number; v: number; vf: number } | null = null;
    const movable = [...this.bench(), ...this.positions().filter((p) => pos[p] >= 0).map((p) => pos[p])];
    for (let r = 0; r < NR; r++) {
      if (hours[r] >= 0 || this.pl.P.off[r]) continue;
      const p = at3(r, 1);
      for (let len = 1; len < 24; len++) {
        hours[r] = hoursId(24 - len, len);
        for (const o of movable) {
          const from = this.where[o];
          if (from >= 0 && roomOf(from) === r) continue;
          if (from >= 0) pos[from] = -1;
          pos[p] = o;
          const v = this.v(r);
          const vf = from >= 0 ? this.v(roomOf(from)) : 0;
          pos[p] = -1;
          if (from >= 0) pos[from] = o;
          const gain = v - this.val[r] + (from >= 0 ? vf - this.val[roomOf(from)] : 0);
          if (gain > (best?.gain ?? EPS)) best = { r, h: hours[r], o, from, gain, v, vf };
        }
      }
      hours[r] = -1;
    }
    if (!best) return false;
    hours[best.r] = best.h;
    if (best.from >= 0) {
      this.put(best.from, -1);
      this.val[roomOf(best.from)] = best.vf;
    }
    this.put(at3(best.r, 1), best.o);
    this.val[best.r] = best.v;
    return true;
  }

  /** Improve until nothing helps. */
  improve(): void {
    for (let k = 0; k < 40; k++) {
      let better = this.fill();
      better = this.swaps() || better;
      if (!this.pl.P.keep) {
        better = this.windows() || better;
        better = this.openB() || better;
      }
      if (!better || this.pl.timeUp()) return;
    }
  }

  /** Close Shift B in rooms where nobody works it, when that costs the room almost nothing: simpler plans read better. */
  tidy(): void {
    const { hours, pos } = this.plan;
    for (let r = 0; r < NR; r++) {
      const h = hours[r];
      if (h < 0 || [0, 1, 2].some((i) => pos[at3(r, 1) + i] >= 0)) continue;
      hours[r] = -1;
      const v = this.v(r);
      if (v >= this.val[r] * (1 - TIDY)) this.val[r] = v;
      else hours[r] = h;
    }
    // a shift that runs out of Mood a few minutes a day shows a warning for a tiny gain: move its
    // boundary an hour at a time (keeping Shift A's end) while that costs at most TIDY of the score
    const total = this.score;
    for (let r = 0; r < NR; r++) {
      const floor = this.val[r] - TIDY * total;
      for (let step = 0; step < 3 && hours[r] >= 0; step++) {
        const halts = this.pl.halts(this.se, this.plan, r);
        if (!halts) break;
        const h = hours[r];
        const [start, len] = [startOf(h), lenOf(h)];
        let best: [number, number, number] | null = null; // hours, halts, value
        for (const [s, l] of [[start + 1, len - 1], [start - 1, len + 1]]) {
          if (l < 1 || l > 23) continue;
          hours[r] = hoursId(s, l);
          const n = this.pl.halts(this.se, this.plan, r);
          const v = this.v(r);
          if (n < halts && v >= floor && (!best || n < best[1] || (n === best[1] && v > best[2]))) best = [hours[r], n, v];
        }
        hours[r] = best ? best[0] : h;
        if (!best) break;
        this.val[r] = best[2];
      }
    }
  }

  /** Try every start time for each room's Shift A, keeping its length. */
  starts(): boolean {
    let any = false;
    const { hours } = this.plan;
    for (let r = 0; r < NR; r++) {
      const cur = hours[r];
      if (cur < 0) continue;
      let best = cur;
      let bestV = this.val[r];
      for (let st = 0; st < 24; st++) {
        const h = hoursId(st, lenOf(cur));
        if (h === cur) continue;
        hours[r] = h;
        const v = this.v(r);
        if (v > bestV + EPS) [best, bestV] = [h, v];
      }
      hours[r] = best;
      if (best !== cur) {
        this.val[r] = bestV;
        any = true;
      }
    }
    return any;
  }
}

// ---------------------------------------------------------------- the whole ship

/** Settings > Shift hours: does Optimize keep the user's Shift A/B hours? */
export function keepsHours(profile: Profile): boolean {
  return lookup(profile.dijiangPlanner.settings as unknown as Record<string, unknown>, "shiftHours", "optimize") === "keep";
}

/** Planner score of a profile: the sum of room priority x efficiency, with the results' numbers before rounding. */
export function planScore(ops: OperatorsData, profile: Profile): number {
  const dp = profile.dijiangPlanner;
  const prio = roomWeights(profile);
  const rs = lookup(dp.roomSettings, "GC", {} as RoomSettings);
  const plots = (field(rs, "items", []) ?? []).filter((x) => truthy(x) && Object.hasOwn(ROOM_DATA.GC.items, x as string)) as string[];
  const types = plots.length ? plots.map((x) => ROOM_DATA.GC.items[x].type) : ["fungus", "plant", "mineral"];
  const st = shipState(ops, profile);
  let j = 0;
  for (const r of PROD) {
    if (!Object.hasOwn(dp.roomAssignments, r) || !roomOn(profile, r)) continue;
    const [eff] = roomEfficiency(ops, profile, r, st);
    if (!eff) continue;
    const t = roomType(r);
    const v = t === "GC" ? types.reduce((n, x) => n + (eff[x] ?? 0), 0) / types.length : eff.efficiency ?? 0;
    j += (prio[r] ?? 1) * v;
  }
  return j;
}

/** The plan in a profile: its operators, and in full mode its whole-hour shift windows. */
function planOf(pl: Planner, profile: Profile, index: Map<string, number>): Plan {
  const P = pl.P;
  const plan: Plan = { pos: P.fixed.slice(), hours: new Int16Array(NR + 1).fill(-1) };
  const dp = profile.dijiangPlanner;
  for (let g = 0; g <= NR; g++) {
    const sh = getShiftSettings(profile, roomId(g));
    if (!P.keep && truthy(sh.enabled) && !P.off[g]) plan.hours[g] = hoursOfBar(sh) ?? (g === CN ? CN_HOURS : hoursId(24 - LONG_A, LONG_A));
    for (let s = 0; s < 2; s++) {
      if (!pl.usable(plan, g, s)) continue;
      const slots = lookup(dp.roomAssignments, shiftSlot(roomId(g), s ? "B" : "A"), [] as Slots);
      for (let i = 0; i < 3; i++) {
        const p = at3(g, s) + i;
        const op = slots[i];
        if (plan.pos[p] >= 0 || !truthy(op)) continue;
        const o = index.get(op!.id);
        // only pool operators, each once, and Control Nexus operators only where they give Mood Regen
        if (o === undefined || plan.pos.includes(o) || (g === CN && P.regen[o] === 0 && P.cnDrain[o] === 0)) continue;
        plan.pos[p] = o;
      }
    }
  }
  return plan;
}

/** Control Nexus line-ups to try, each as a plan with only the Control Nexus (and fixed operators) filled. */
function lineups(pl: Planner): Plan[] {
  const P = pl.P;
  const cost = (o: number): number => {
    let c = 0;
    for (let r = 0; r < NR; r++) c = Math.max(c, P.weight[r] * (P.beta[o * NR + r] + P.drain[o * NR + r]));
    return c;
  };
  const cands = P.pool.filter((o) => P.regen[o] > 0 || P.cnDrain[o] > 0)
    .sort((a, b) => P.regen[b] - P.regen[a] || cost(a) - cost(b) || (P.ids[a] < P.ids[b] ? -1 : 1));
  const free = (s: number): number[] => [0, 1, 2].map((i) => at3(CN, s) + i).filter((p) => P.fixed[p] < 0);
  const fixedIn = (s: number): number => 3 - free(s).length;
  const out: Plan[] = [];
  const shiftOk = !P.off[CN] && (P.keep ? P.cnShift : true);
  for (let kA = fixedIn(0); kA <= (P.off[CN] ? fixedIn(0) : 3); kA++) {
    for (let kB = shiftOk ? fixedIn(1) : 0; kB <= (shiftOk ? 3 : 0); kB++) {
      if (!P.keep && kA === 0 && kB > 0) continue;
      const add = kA - fixedIn(0) + Math.max(0, kB - fixedIn(1));
      if (add > cands.length) continue;
      const plan: Plan = { pos: P.fixed.slice(), hours: new Int16Array(NR + 1).fill(-1) };
      let k = 0;
      free(0).slice(0, kA - fixedIn(0)).forEach((p) => (plan.pos[p] = cands[k++]));
      free(1).slice(0, Math.max(0, kB - fixedIn(1))).forEach((p) => (plan.pos[p] = cands[k++]));
      if (!P.keep && (kB > 0 || fixedIn(1) > 0)) plan.hours[CN] = CN_HOURS;
      out.push(plan);
    }
  }
  return out;
}

/** Fill the production rooms of a Control Nexus line-up from each start; the best result. */
function production(pl: Planner, cn: Plan, extra: Plan[] = []): Search {
  const starts: Plan[] = [];
  if (pl.P.keep) starts.push(clonePlan(cn));
  else {
    for (const len of [0, LONG_A]) {
      const x = clonePlan(cn);
      for (let r = 0; r < NR; r++) {
        const fixedB = [0, 1, 2].some((i) => pl.P.fixed[at3(r, 1) + i] >= 0);
        x.hours[r] = pl.P.off[r] ? -1 : len || fixedB ? hoursId(24 - (len || LONG_A), len || LONG_A) : -1;
      }
      starts.push(x);
    }
  }
  starts.push(...extra);
  let best: Search | null = null;
  for (const x of starts) {
    const s = new Search(pl, x);
    s.improve();
    if (!best || s.score > best.score + EPS) best = s;
    if (pl.timeUp()) break;
  }
  return best!;
}

/** Swap Control Nexus operators with the others (or leave a slot empty) while that helps. */
function polishCn(pl: Planner, best: Search): Search {
  const P = pl.P;
  for (let round = 0; round < 4 && !pl.timeUp(); round++) {
    let better = false;
    for (let s = 0; s < 2; s++) {
      if (!pl.usable(best.plan, CN, s)) continue;
      for (let i = 0; i < 3; i++) {
        const c = at3(CN, s) + i;
        if (P.fixed[c] >= 0) continue;
        const cands = [-1, ...P.pool.filter((o) => (P.regen[o] > 0 || P.cnDrain[o] > 0) && best.where[o] !== c)];
        for (const o of cands) {
          const cur = best.plan.pos[c];
          if (o === cur) continue;
          const trial = clonePlan(best.plan);
          const from = o >= 0 ? best.where[o] : -1;
          trial.pos[c] = o;
          if (from >= 0) trial.pos[from] = cur;
          const t = new Search(pl, trial);
          // the freed operator first goes where it adds the most; a full search only for close calls
          t.fill();
          if (t.score > best.score * (1 - CLOSE)) t.improve();
          if (t.score > best.score + EPS) {
            best = t;
            better = true;
          }
          if (pl.timeUp()) return best;
        }
      }
    }
    if (!better) break;
  }
  return best;
}

/** Try other start times for every Shift A and the Control Nexus, when its schedule makes the time of day matter. */
function polishStarts(pl: Planner, best: Search): Search {
  if (pl.P.keep || !best.se.st.ship.timeline) return best;
  if (best.plan.hours[CN] >= 0) {
    const len = lenOf(best.plan.hours[CN]);
    for (let st = 0; st < 24 && !pl.timeUp(); st++) {
      const h = hoursId(st, len);
      if (h === best.plan.hours[CN]) continue;
      const trial = clonePlan(best.plan);
      trial.hours[CN] = h;
      const t = new Search(pl, trial);
      if (t.score > best.score + EPS) best = t;
    }
  }
  best.starts();
  return best;
}

/** A Control Nexus rotated by hand only counts its active team; give the resting one the best Mood Regen left. */
function fillReserveCn(pl: Planner, best: Search): void {
  const P = pl.P;
  const rest = 1 - (getShiftSettings(P.profile, "CN").active === "B" ? 1 : 0);
  const left = best.bench().filter((o) => P.regen[o] > 0).sort((a, b) => P.regen[b] - P.regen[a]);
  for (let i = 0; i < 3 && left.length; i++) {
    const p = at3(CN, rest) + i;
    if (best.plan.pos[p] < 0) best.put(p, left.shift()!);
  }
}

function toProfile(pl: Planner, plan: Plan): Profile {
  const P = pl.P;
  const q = structuredClone(P.profile);
  const dp = q.dijiangPlanner;
  if (!P.keep) {
    for (let g = 0; g <= NR; g++) {
      const rid = roomId(g);
      const sh = getShiftSettings(P.profile, rid);
      const h = plan.hours[g];
      dp.roomSettings[rid] = { ...(dp.roomSettings[rid] ?? {}), shift: h < 0 ? { ...sh, enabled: false } : { ...sh, enabled: true, autoRotate: true, ...barOf(h) } };
    }
  }
  const ra: Record<string, Slots> = {};
  for (const rid of ROOM_IDS) {
    const g = rid === "CN" ? CN : PROD.indexOf(rid);
    for (let s = 0; s < 2; s++) {
      if (!pl.usable(plan, g, s)) continue;
      ra[shiftSlot(rid, s ? "B" : "A")] = [0, 1, 2].map((i) => {
        const p = at3(g, s) + i;
        if (P.fixed[p] >= 0) return P.fixedEntry[p];
        const o = plan.pos[p];
        if (o < 0) return null;
        const useful = g === CN ? P.regen[o] > 0 || P.cnDrain[o] > 0 : P.beta[o * NR + g] > 0 || P.drain[o * NR + g] > 0;
        return useful ? { id: P.ids[o], fixed: false } : { id: P.ids[o], fixed: false, filler: true };
      });
    }
  }
  dp.roomAssignments = ra;
  return syncSlots(q);
}

/**
 * The best plan the planner finds for the available operators: every room's teams, and
 * (unless keepHours) each room's Shift A/B hours and the Control Nexus line-up. Operators
 * marked fixed stay where they are.
 */
export function planShip(ops: OperatorsData, profile: Profile, available: readonly string[], opts: PlanOptions = {}): PlanResult {
  const P = prepare(ops, profile, available, opts.keepHours === true);
  const pl = new Planner(P, opts.budgetMs ?? 4000);
  const index = new Map(P.ids.map((id, o) => [id, o]));
  const current = planOf(pl, profile, index);

  let best: Search | null = null;
  const consider = (s: Search): void => {
    if (!best || s.score > best.score + EPS) best = s;
  };
  for (const cn of lineups(pl)) {
    consider(production(pl, cn));
    if (pl.timeUp()) break;
  }
  // the current plan, improved, so Optimize never does worse than what is there
  const now = new Search(pl, clonePlan(current));
  now.improve();
  consider(now);
  best = polishCn(pl, best!);
  best = polishStarts(pl, best);
  if (!P.keep) {
    best.tidy();
    const { pos, hours } = best.plan;
    if (hours[CN] >= 0 && [0, 1, 2].every((i) => pos[at3(CN, 1) + i] < 0)) {
      const trial = clonePlan(best.plan);
      trial.hours[CN] = -1;
      const t = new Search(pl, trial);
      if (t.score >= best.score * (1 - TIDY)) best = t;
    }
  }
  if (P.keep && P.cnShift && !P.off[CN] && !truthy(getShiftSettings(profile, "CN").autoRotate)) fillReserveCn(pl, best);
  const out = toProfile(pl, best.plan);
  return { profile: out, score: planScore(ops, out), before: planScore(ops, profile) };
}

/**
 * The planner's own score of the plan in a profile, from its cached shift hours: equal to
 * planScore unless a room is rotated by hand (its resting team counts a little). For tests.
 */
export function fastScore(ops: OperatorsData, profile: Profile, available: readonly string[], keepHours = true): number {
  const P = prepare(ops, profile, available, keepHours);
  const pl = new Planner(P, Infinity);
  return new Search(pl, planOf(pl, profile, new Map(P.ids.map((id, o) => [id, o])))).score;
}
