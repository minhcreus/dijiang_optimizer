// The 24h work-schedule bar: two handles p < q, [p, q] belongs to `inner`.
import { DAY_MIN } from "./constants.ts";
import { minutesToClock } from "./format.ts";
import { pyMax, pyMin, pyMod, pyRound } from "./py.ts";
import type { ShiftId, ShiftSettings, Window } from "./types.ts";

type Bar = Pick<ShiftSettings, "p" | "q" | "inner">;

/**
 * {A: [start, end], B: [start, end]} in minutes, start in [0, 1440), end in (0, 1440].
 * The outer shift takes the rest of the day and wraps past midnight when 0 < p and q < 24:00.
 */
export function shiftWindows(sh: Bar): Record<ShiftId, Window> {
  const { p, q, inner } = sh;
  const outer: ShiftId = inner === "A" ? "B" : "A";
  return { [inner]: [p, q], [outer]: [pyMod(q, DAY_MIN), p > 0 ? p : DAY_MIN] } as Record<ShiftId, Window>;
}

export function windowLength(win: Window): number {
  const len = pyMod(win[1] - win[0], DAY_MIN);
  return len === 0 ? DAY_MIN : len;
}

/** Like the game header: "06:00 - 18:00", "18:00 - 06:00", "23:00 - 00:00". */
export function windowLabel(win: Window): string {
  return `${minutesToClock(pyMod(win[0], DAY_MIN))} - ${minutesToClock(pyMod(win[1], DAY_MIN))}`;
}

export function inWindow(minute: number, win: Window): boolean {
  const [s, e] = win;
  return s < e ? s <= minute && minute < e : minute >= s || minute < e;
}

const masks = new Map<string, Uint8Array>();

/** inWindow for every minute of the day, cached per window. */
export function windowMask(win: Window): Uint8Array {
  const key = `${win[0]},${win[1]}`;
  let mask = masks.get(key);
  if (!mask) {
    mask = new Uint8Array(DAY_MIN);
    for (let m = 0; m < DAY_MIN; m++) mask[m] = inWindow(m, win) ? 1 : 0;
    if (masks.size > 256) masks.clear();
    masks.set(key, mask);
  }
  return mask;
}

export function resetShift(sh: ShiftSettings): ShiftSettings {
  return { ...sh, p: 0, q: 720, inner: "A" };
}

export function swapShift(sh: ShiftSettings): ShiftSettings {
  return { ...sh, inner: sh.inner === "A" ? "B" : "A" };
}

/** Move handle "p" or "q" to `minute`, snapped to `step`; each shift keeps >= 1 step. */
export function dragHandle(sh: ShiftSettings, handle: "p" | "q", minute: number, step = 60): ShiftSettings {
  const m = Math.trunc(pyRound(minute / step) * step) + 0;
  let { p, q } = sh;
  if (handle === "p") {
    p = pyMax(0, pyMin(m, q - step));
    if (p === 0 && q === DAY_MIN) p = step;
  } else {
    q = pyMin(DAY_MIN, pyMax(m, p + step));
    if (p === 0 && q === DAY_MIN) q = DAY_MIN - step;
  }
  return { ...sh, p, q };
}
