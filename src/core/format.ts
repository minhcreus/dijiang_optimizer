// Display formatting, matching the Python f-strings exactly.
import { divmod, pyFixed } from "./py.ts";

/** f"{x:.{digits}f}" (half-even on exact ties, unlike toFixed). */
export const formatFixed = pyFixed;

/** Round to 3 decimals and drop trailing zeros: 374.000 -> "374", 62.500 -> "62.5". */
export function fmt3(x: number): string {
  const out = pyFixed(x, 3).replace(/0+$/, "").replace(/\.+$/, "");
  return out === "-0" || out === "" ? "0" : out;
}

export function pct3(x: number): string {
  return `${fmt3(x * 100)}%`;
}

/** f"{n:02d}" */
const pad2 = (n: bigint): string => (n < 0n ? n.toString() : n.toString().padStart(2, "0"));

/**
 * Whole seconds, rounded down. The 1e-6 s nudge keeps float noise from losing a second
 * (35200 / 2.2 is 15999.999999999998 in floats, but 16000 s exactly). BigInt keeps huge
 * values exact and throws on NaN / inf like Python.
 */
const floorInt = (x: number): bigint => BigInt(Math.floor(x + 1e-6));

export function secondsToHms(total: number): string {
  const [h, rest] = divmod(floorInt(total), 3600n);
  const [m, s] = divmod(rest, 60n);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/** In-game style "EST. Work Time: 19h 17min" (truncated like the game). */
export function secondsToHmin(total: number): string {
  const [h, rest] = divmod(floorInt(total), 3600n);
  return `${h}h ${divmod(rest, 60n)[0]}min`;
}

export function minutesToClock(m: number): string {
  const [h, min] = divmod(BigInt(Math.trunc(m)), 60n);
  return `${pad2(h)}:${pad2(min)}`;
}
