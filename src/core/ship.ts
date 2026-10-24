// Whole-ship Mood timeline, for when the Control Nexus Mood Regen changes over time.
//
// In the game, Control Nexus operators lose Mood and rest like everyone else, and
// their Mood Regen bonus only counts while they work. So the ship's Mood Regen R(t)
// changes over time, and every operator who is resting or off duty recovers at
// 1/30000 of max Mood per second x R(t). R(t) depends only on the Control Nexus
// team, so runShip simulates that team first (its members affect each other), and
// every other team then follows R(t) on its own (followTimeline).
//
// Event-driven: time jumps to the next schedule boundary, or Mood reaching zero or
// max. Results average the days after a warm-up (HORIZON): the warm-up lets rooms settle into
// their rhythm against the Control Nexus (an operator who rests while it rests stays
// in step with it), and the long average smooths out patterns that never repeat exactly.
import { BREAK_TIME, DAY_MIN } from "./constants.ts";
import { inWindow, windowLength } from "./shifts.ts";
import type { Window } from "./types.ts";

export interface Horizon {
  days?: number;
  warmDays?: number;
}

/** Simulated and warm-up days (an object so tests can lengthen it). */
export const HORIZON: Required<Horizon> = { days: 360, warmDays: 60 };
const DAY_S = DAY_MIN * 60;
/** Mood within this of zero or max counts as there, so float noise cannot stall time */
const EPS = 1e-9;

/** Operators that share one Mood: a team that started together, or one operator. */
export interface Unit {
  n: number;
  /** seconds from max to zero Mood while working */
  work: number;
  /** Mood Regen bonus the ship gets while this unit works (Control Nexus) */
  regen: number;
  /** on-duty window; null when on duty all day */
  window: Window | null;
  /** state at time 0 */
  mood: number;
  resting: boolean;
}

/** R(t) = r[k] on [t[k], t[k + 1]); the last value holds to the end. c[k] = integral of R over [0, t[k]). */
export interface Timeline {
  t: number[];
  r: number[];
  c: number[];
}

export type Spans = [number, number][];

export interface CnRun {
  timeline: Timeline;
  /** measured seconds */
  span: number;
  /** seconds each unit worked within the measured span */
  worked: number[];
  /**
   * average R and the share of time R > 1: over whole cycles of the first unit when no
   * unit has a window (no partial cycle at the ends), else over the measured span
   */
  regenAvg: number;
  regenOn: number;
  /** per unit with a window: minutes of the day on duty but resting, when the last two days match */
  halted: (Spans | undefined)[];
}

export interface Followed {
  /** seconds worked within the measured span */
  worked: number;
  /** share of time working: over whole work-rest cycles without a window (no partial cycle at the ends), else over the measured span */
  uptime: number;
  /** with a window: minutes of the day on duty but resting, when the last two days match */
  halted?: Spans;
}

const activeWindow = (u: Unit): Window | null => (u.window && windowLength(u.window) < DAY_MIN ? u.window : null);

function onDuty(win: Window, t: number): boolean {
  const sec = t - Math.floor(t / DAY_S) * DAY_S;
  return inWindow(Math.floor(sec / 60), win);
}

/** First schedule boundary after t (boundaries fall on whole seconds, so they are exact). */
function boundaryAfter(win: Window, t: number): number {
  const day = Math.floor(t / DAY_S) * DAY_S;
  let best = Infinity;
  for (let d = day; d <= day + DAY_S; d += DAY_S) {
    for (const m of win) {
      const b = d + m * 60;
      if (b > t && b < best) best = b;
    }
  }
  return best;
}

/** Halted seconds of the last two days, by day, from spans [a, b) of absolute time. */
class LastDays {
  readonly start: number;
  readonly days: Spans[] = [[], []];

  constructor(days: number) {
    this.start = (days - 2) * DAY_S;
  }

  add(a: number, b: number): void {
    if (b <= this.start) return;
    for (let d = 0; d < 2; d++) {
      const base = this.start + d * DAY_S;
      const x = Math.max(a, base) - base;
      const y = Math.min(b, base + DAY_S) - base;
      if (y <= x) continue;
      const spans = this.days[d];
      const last = spans[spans.length - 1];
      if (last && Math.abs(last[1] - x) < 1e-6) last[1] = y;
      else spans.push([x, y]);
    }
  }

  /** Whole minutes of the last day, when the day before was the same. */
  daily(): Spans | undefined {
    const [a, b] = this.days.map(toMinutes);
    return a.length === b.length && a.every(([x, y], i) => x === b[i][0] && y === b[i][1]) ? b : undefined;
  }
}

function toMinutes(spans: Spans): Spans {
  const out: Spans = [];
  for (const [a, b] of spans) {
    const [ma, mb] = [Math.round(a / 60), Math.round(b / 60)];
    if (mb <= ma) continue;
    const last = out[out.length - 1];
    if (last && last[1] >= ma) last[1] = Math.max(last[1], mb);
    else out.push([ma, mb]);
  }
  return out;
}

/**
 * The Control Nexus team(s): R(t) = 1 + Mood Regen of the units working at t. Units
 * that are resting or off duty recover at R(t) too, so they are simulated together.
 */
export function runShip(units: readonly Unit[], h: Horizon = {}): CnRun {
  const days = h.days ?? HORIZON.days;
  const end = days * DAY_S;
  const from = (h.warmDays ?? HORIZON.warmDays) * DAY_S;
  const nu = units.length;
  const wins = units.map(activeWindow);
  const mood = Float64Array.from(units, (u) => u.mood);
  const resting = Uint8Array.from(units, (u) => (u.resting ? 1 : 0));
  const on = Uint8Array.from(wins, (w) => (w === null || onDuty(w, 0) ? 1 : 0));
  const bnd = Float64Array.from(wins, (w) => (w === null ? Infinity : boundaryAfter(w, 0)));
  const working = new Uint8Array(nu);
  const worked = new Float64Array(nu);
  const last = units.map(() => new LastDays(days));
  const tl: Timeline = { t: [], r: [], c: [] };
  let integral = 0;
  let regenInt = 0;
  let regenOn = 0;
  // without windows: the sums at the first and last work start of unit 0 in the measured days
  const cycles = wins.every((w) => w === null);
  let was0 = false;
  let c0 = -1;
  let c0Int = 0;
  let c0On = 0;
  let c1 = -1;
  let c1Int = 0;
  let c1On = 0;
  let t = 0;
  for (let guard = 0; t < end && guard < 1e6; guard++) {
    let R = 1;
    for (let i = 0; i < nu; i++) {
      if (bnd[i] <= t) {
        on[i] = onDuty(wins[i]!, t) ? 1 : 0;
        bnd[i] = boundaryAfter(wins[i]!, t);
      }
      working[i] = on[i] && !resting[i] && mood[i] > 0 ? 1 : 0;
      if (working[i]) R += units[i].regen;
    }
    if (cycles && nu > 0) {
      if (working[0] && !was0 && t >= from) {
        if (c0 < 0) {
          c0 = t;
          c0Int = regenInt;
          c0On = regenOn;
        }
        c1 = t;
        c1Int = regenInt;
        c1On = regenOn;
      }
      was0 = working[0] === 1;
    }
    if (tl.r.length === 0 || tl.r[tl.r.length - 1] !== R) {
      tl.t.push(t);
      tl.r.push(R);
      tl.c.push(integral);
    }
    let next = end;
    for (let i = 0; i < nu; i++) {
      if (working[i]) next = Math.min(next, t + mood[i] * units[i].work);
      else if (mood[i] < 1) next = Math.min(next, t + ((1 - mood[i]) * BREAK_TIME) / R);
      next = Math.min(next, bnd[i]);
    }
    const dt = next - t;
    integral += R * dt;
    const a = Math.max(t, from);
    if (next > a) {
      regenInt += R * (next - a);
      if (R > 1 + 1e-12) regenOn += next - a;
      for (let i = 0; i < nu; i++) {
        if (working[i]) worked[i] += next - a;
        else if (wins[i] && on[i]) last[i].add(t, next);
      }
    }
    for (let i = 0; i < nu; i++) {
      if (working[i]) {
        const m = mood[i] - dt / units[i].work;
        if (m <= EPS) {
          mood[i] = 0;
          resting[i] = 1;
        } else mood[i] = m;
      } else if (mood[i] < 1) {
        const m = mood[i] + (dt * R) / BREAK_TIME;
        if (m >= 1 - EPS) {
          mood[i] = 1;
          resting[i] = 0;
        } else mood[i] = m;
      } else resting[i] = 0;
    }
    t = next;
  }
  const span = measured(h);
  const whole = c1 > c0;
  return {
    timeline: tl, span, worked: [...worked],
    regenAvg: whole ? (c1Int - c0Int) / (c1 - c0) : regenInt / span,
    regenOn: whole ? (c1On - c0On) / (c1 - c0) : regenOn / span,
    halted: units.map((_, i) => (wins[i] ? last[i].daily() : undefined)),
  };
}

/** One unit that recovers at R(t) and gives nothing to it (any room but the Control Nexus). */
export function followTimeline(u: Unit, tl: Timeline, h: Horizon = {}): Followed {
  const days = h.days ?? HORIZON.days;
  const end = days * DAY_S;
  const from = (h.warmDays ?? HORIZON.warmDays) * DAY_S;
  const { t: tt, r, c } = tl;
  const n = tt.length;
  const win = activeWindow(u);
  const last = new LastDays(days);
  let worked = 0;
  // without a window: whole cycles, from the first work start in the measured span to the last
  let first = -1;
  let firstWorked = 0;
  let lastStart = -1;
  let lastWorked = 0;
  let wasWorking = false;
  let mood = u.mood;
  let resting = u.resting;
  let t = 0;
  let k = 0; // segment holding t
  const seek = (x: number): number => {
    let j = k;
    while (j + 1 < n && tt[j + 1] <= x) j++;
    return j;
  };
  const integralTo = (x: number, j: number): number => c[j] + r[j] * (x - tt[j]);
  let on = win === null || onDuty(win, 0);
  let bnd = win === null ? Infinity : boundaryAfter(win, 0);
  for (let guard = 0; t < end && guard < 1e6; guard++) {
    if (mood >= 1) resting = false;
    if (bnd <= t) {
      on = onDuty(win!, t);
      bnd = boundaryAfter(win!, t);
    }
    const limit = Math.min(bnd, end);
    let next: number;
    if (on && !resting && mood > 0) {
      if (!wasWorking && t >= from) {
        if (first < 0) {
          first = t;
          firstWorked = worked;
        }
        lastStart = t;
        lastWorked = worked;
      }
      wasWorking = true;
      next = Math.min(t + mood * u.work, limit);
      const a = Math.max(t, from);
      if (next > a) worked += next - a;
      mood -= (next - t) / u.work;
      if (mood <= EPS) {
        mood = 0;
        resting = true;
      }
    } else {
      wasWorking = false;
      if (mood >= 1) {
        next = limit; // off duty at max Mood
      } else {
        // recover until max Mood, or until the schedule changes
        const target = integralTo(t, k) + (1 - mood) * BREAK_TIME;
        let lo = k;
        let hi = n - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (c[mid] <= target) lo = mid;
          else hi = mid - 1;
        }
        const full = tt[lo] + (target - c[lo]) / r[lo];
        if (full <= limit) {
          next = full;
          mood = 1;
          resting = false;
        } else {
          next = limit;
          const m = mood + (integralTo(limit, seek(limit)) - integralTo(t, k)) / BREAK_TIME;
          mood = m >= 1 - EPS ? 1 : m;
          if (mood === 1) resting = false;
        }
      }
      if (on) last.add(t, next);
    }
    t = Math.max(next, t);
    k = seek(t);
  }
  const span = measured(h);
  if (win) return { worked, uptime: worked / span, halted: last.daily() };
  return { worked, uptime: lastStart > first ? (lastWorked - firstWorked) / (lastStart - first) : worked / span };
}

/** Seconds in the measured days. */
export const measured = (h: Horizon = {}): number => ((h.days ?? HORIZON.days) - (h.warmDays ?? HORIZON.warmDays)) * DAY_S;

/** Largest k with key[k] <= x (key ascending, key[0] <= x). */
function floorIndex(key: number[], x: number): number {
  let lo = 0;
  let hi = key.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (key[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Average seconds to win back `mood` (a share of max Mood) at R(t), when the rest starts
 * `start` seconds after midnight on each measured day.
 */
export function recoverTime(tl: Timeline, start: number, mood: number, h: Horizon = {}): number {
  if (mood <= 0) return 0;
  const days = h.days ?? HORIZON.days;
  const warm = h.warmDays ?? HORIZON.warmDays;
  const { t: tt, r, c } = tl;
  let sum = 0;
  for (let d = warm; d < days; d++) {
    const t0 = d * DAY_S + start;
    const j = floorIndex(tt, t0);
    const target = c[j] + r[j] * (t0 - tt[j]) + mood * BREAK_TIME;
    const k = floorIndex(c, target);
    sum += tt[k] + (target - c[k]) / r[k] - t0;
  }
  return sum / (days - warm);
}

/** R once the measured days start, when it never changes from then on; else null. */
export function constantFrom(tl: Timeline, from = HORIZON.warmDays * DAY_S): number | null {
  let k = 0;
  while (k + 1 < tl.t.length && tl.t[k + 1] <= from) k++;
  const r0 = tl.r[k];
  for (let j = k + 1; j < tl.r.length; j++) if (Math.abs(tl.r[j] - r0) > 1e-12) return null;
  return r0;
}

/**
 * Initial state of an operator that starts working `offset` seconds into a nominal
 * cycle of `work` seconds working and `rest` seconds resting (Staggered start:
 * operator i starts i/3 of a cycle later).
 */
export function staggeredStart(offset: number, work: number, rest: number): Pick<Unit, "mood" | "resting"> {
  if (offset <= 0) return { mood: 1, resting: false };
  if (offset <= rest) return { mood: 1 - offset / rest, resting: true };
  return { mood: (offset - rest) / work, resting: false };
}
