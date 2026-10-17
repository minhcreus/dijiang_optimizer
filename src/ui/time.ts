// Server-clock helpers (the game runs on a fixed UTC offset) and display times.
import { pad2 } from "./html.ts";

/** Minute of the day on the server clock. */
export function nowMinute(utcOffset: number, nowMs = Date.now()): number {
  const t = new Date(nowMs + utcOffset * 3_600_000);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}

export function utcLabel(utcOffset: number): string {
  return `UTC${utcOffset >= 0 ? "+" : "-"}${Math.abs(utcOffset)}`;
}

/** "just now", "5 min ago", "3 h ago", else the local date. */
export function relTime(ms: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
