// Overview tab: KPI strip, ship deck tiles and the selected room's detail
// panel, including the Cabin Shift screen and its 24h work-schedule bar.
import {
  DAY_MIN, ROOM_DATA, ROOM_IDS, cnModel, fmt3, formatFixed, getShiftSettings, inWindow, minutesToClock, pct3,
  productionMultiplier, roomType, shiftSlot, shiftWindows, windowLabel, windowLength,
} from "../../core/index.ts";
import type { RoomResult, RoomType, Results, ShiftId, ShiftInfo, ShiftSettings, Window } from "../../core/index.ts";
import { esc, img, pad2, tip, title } from "../html.ts";
import { S, dp, nowMin, results, shiftOn, utc } from "../state.ts";
import type { Bar } from "../state.ts";
import { itemButton, opImg, slotsRow } from "../widgets.ts";

const ROOM_CODES: Record<RoomType, string> = { CN: "CTRL", MFG: "MFG", GC: "GROW", RR: "RECP" };
const BLURBS: Record<RoomType, string> = {
  CN: "Control Nexus operators speed up Mood recovery for the whole ship.",
  MFG: "Produces EXP items. Each working operator adds 40% speed, skills add more.",
  GC: "Grows minerals, plants and fungi on three plots.",
  RR: "Collects clues. Rate-up operators steer which clue you get.",
};
const RESULT_HELP: Record<string, string> = {
  "Work Time": "Time from max Mood to zero Mood: 50000 s / (1 - Mood Drop reductions).",
  "Global Break Time": "Time for a resting operator to go from zero to max Mood: 30000 s / Mood Regen.",
  "Mood Regen": "Recovery speed for resting operators: 100% + Control Nexus bonuses.",
  "Avg. Mood Regen": "Average recovery speed for resting operators. Control Nexus operators tire and rest like everyone else, and their Mood Regen only counts while they work.",
  "Regen While Working": "Mood Regen while the whole Control Nexus team works: 100% + its Mood Regen skills, the value the game shows.",
  "Regen Uptime": "Share of the time at least one Control Nexus operator with a Mood Regen skill is working.",
  "Avg. Break Time": "Average time an operator without Mood skills takes from zero to max Mood. Rests while the Control Nexus team works are shorter, rests while it rests take the full 8h 20min.",
  "Operator Uptime": "Share of the day operators in this room are working rather than resting.",
  "Shift Uptime": "Share of the day this cabin is producing: the hours Shift A and Shift B actually work, out of 24h.",
  "Avg. Efficiency": "Average production speed over a full cycle: (1 + 40% per working operator) x (1 + skill bonuses) x time working.",
  "Duration per Item": "Base production time of the product divided by the average efficiency.",
  "XP per Second": "EXP value of the product divided by its duration.",
  "XP per Hour": "EXP value of the product per hour at the average efficiency.",
  "Time per Clue": "88000 s base divided by the average efficiency.",
};
const SHIFTS: readonly ShiftId[] = ["A", "B"];
const other = (s: ShiftId): ShiftId => (s === "A" ? "B" : "A");

function roomControls(roomId: string): string {
  const rtype = roomType(roomId);
  const rs = dp().roomSettings[roomId] ?? {};
  if (rtype === "CN") {
    return '<div class="muted small">Optimize decides how many Mood Regen operators are worth it here: each one in a room adds at least 40% there instead.</div>';
  }
  if (rtype === "MFG") return itemButton(roomId, "mfg", rs.item);
  if (rtype === "GC") {
    const items = rs.items ?? [null, null, null];
    return [0, 1, 2].map((i) => itemButton(roomId, "gc", items[i], i, `Plot ${i + 1}`)).join("");
  }
  return '<div class="muted small">Assign a matching rate-up operator if you want a specific clue.</div>';
}

function resultsGrid(roomId: string, res: RoomResult | undefined): string {
  if (!res) return "";
  const rtype = roomType(roomId);
  let cells: [string, string][];
  let autoShifts = false;
  if (rtype === "CN") {
    // Mood Regen that comes and goes (Control Nexus operators tire): its average and how often it is on
    const varying = res.regenUptime !== undefined;
    cells = [["Work Time", res.workTime], [varying ? "Avg. Mood Regen" : "Mood Regen", res.moodRegen ?? ""]];
    if (res.teamMoodRegen) cells.push(["Regen While Working", res.teamMoodRegen]);
    if (varying) cells.push(["Regen Uptime", res.regenUptime!]);
    cells.push([varying ? "Avg. Break Time" : "Global Break Time", res.globalBreakTime ?? ""]);
  } else {
    cells = [["Work Time", res.workTime], ["Operator Uptime", res.operatorUptime ?? ""]];
    autoShifts = Boolean(res.shifts && getShiftSettings(S.profile, roomId).autoRotate);
    if (rtype === "MFG") {
      const keys = [["efficiency", "Avg. Efficiency"], ["duration", "Duration per Item"], ["xpPerSecond", "XP per Second"], ["xpPerHour", "XP per Hour"]] as const;
      for (const [k, label] of keys) if (res[k] !== undefined) cells.push([label, res[k]]);
    } else if (rtype === "GC") {
      for (const t of ["mineral", "plant", "fungus"] as const) cells.push([`${title(t)} Efficiency`, res[t] ?? "--"]);
      for (const it of res.items ?? []) if (it) cells.push([`${it.name} Time`, it.duration]);
    } else {
      cells.push(["Avg. Efficiency", res.efficiency ?? "--"], ["Time per Clue", res.duration ?? "--"]);
    }
  }
  const out = cells.map(([k, v]) => {
    const key = k === "Operator Uptime" && autoShifts ? "Shift Uptime" : k;
    const h = RESULT_HELP[key] || (k.includes("Efficiency") ? "Average growth speed for this item type." : "Base growth time divided by the efficiency for its type.");
    return `<div class="stat" ${tip(h)}><span class="stat-k">${esc(k)}</span><span class="stat-v">${esc(v)}</span></div>`;
  });
  return `<div class="results">${out.join("")}</div>`;
}

const hoursLabel = (minutes: number): string => `${fmt3(minutes / 60)}h`;
const pct = (m: number): string => `${formatFixed((m / DAY_MIN) * 100, 4)}%`;
const sameWindow = (a: Window, b: Window): boolean => a[0] === b[0] && a[1] === b[1];

export const barOf = ({ p, q, inner }: Bar): Bar => ({ p, q, inner });
export const sameBar = (a: Bar, b: Bar): boolean => a.p === b.p && a.q === b.q && a.inner === b.inner;

/** The room's confirmed shift settings with the bar being edited, if any (only p, q and inner are drafted). */
export const draftOf = (roomId: string): ShiftSettings => ({ ...getShiftSettings(S.profile, roomId), ...S.drafts[roomId] });

/** Confirmed window, with the pending draft below it when they differ. */
export function windowLines(roomId: string, s: ShiftId, win: Window, draftWin: Window, auto = true): string {
  const id = `id="win-${esc(roomId)}-${s}"`;
  const help = auto ? "Confirmed work schedule" : "Work schedule, used while Auto-Rotate is on";
  if (sameWindow(draftWin, win)) return `<div class="win" ${id} ${tip(help)}>⧗ ${windowLabel(win)} (${utc()})</div>`;
  return `<div class="win stack" ${id} ${tip("Top: current schedule. Bottom: new schedule, applied when you press Confirm.")}>`
    + `<span class="old">${windowLabel(win)} (${utc()})</span><span class="new">${windowLabel(draftWin)} (${utc()})</span></div>`;
}

/** Minutes a shift needs off duty to win back the Mood it uses in a window of `sched` minutes, at the average Mood Regen. */
const restNeeded = (info: ShiftInfo, sched: number): number => ((Math.min(sched * 60, info.workTime) / info.workTime) * info.breakTime) / 60;

/**
 * Why a shift with operators stops while on schedule: "work" when its Mood runs out within one
 * window, "rest" when it covers the window but its off-duty hours are too short to recover, so
 * Mood sinks a little every day until it runs out. The confirmed window uses the simulation.
 */
export function haltCause(info: ShiftInfo, win: Window, confirmed: boolean): "work" | "rest" | "" {
  if (!info.operators) return "";
  const sched = windowLength(win);
  if (info.workTime < sched * 60) return "work";
  if (confirmed && info.halted !== undefined) return info.halted > 0 ? "rest" : "";
  return restNeeded(info, sched) > DAY_MIN - sched ? "rest" : "";
}

/** Control Nexus operators rest at zero Mood (unless the Always-on model is picked). */
const tires = (roomId: string): boolean => roomType(roomId) !== "CN" || cnModel(S.profile) === "game";

/** The halt warning; an empty hidden placeholder keeps its place for partial re-renders. */
export function haltWarning(roomId: string, s: ShiftId, info: ShiftInfo, draftWin: Window, auto: boolean): string {
  const id = `id="warn-${esc(roomId)}-${s}"`;
  const sched = windowLength(draftWin);
  const cause = auto && tires(roomId) ? haltCause(info, draftWin, sameWindow(draftWin, info.window)) : "";
  const cn = roomType(roomId) === "CN";
  const stops = cn ? "this shift gives no Mood Regen" : "the cabin stops";
  const what = cn ? "Mood Regen may stop" : "Production may be halted";
  if (cause === "work") {
    const t = `EST. Work Time ${info.workTimeLabel} is shorter than the ${hoursLabel(sched)} schedule. `
      + `Operators hit zero Mood and rest, so ${stops} until they are back at max Mood.`;
    return `<div class="warn" ${id} ${tip(t)}><b>!</b> ${what} as assignment work duration does not fully cover the work schedule</div>`;
  }
  if (cause === "rest") {
    const need = sameWindow(draftWin, info.window) ? info.restNeededMin : restNeeded(info, sched);
    const t = `This shift works all ${hoursLabel(sched)} of its schedule, then needs ${hoursLabel(need)} off duty to recover `
      + `but gets ${hoursLabel(DAY_MIN - sched)}. Its Mood starts each shift a little lower until it runs out, and ${stops} until the operators are back at max Mood.`;
    return `<div class="warn" ${id} ${tip(t)}><b>!</b> ${what} as off-duty hours are too short to recover Mood</div>`;
  }
  return `<div class="warn" ${id} hidden></div>`;
}

/** On schedule but resting at zero Mood at this minute (known only when every day is the same). */
const haltedNow = (info: ShiftInfo): boolean => {
  const nm = nowMin();
  return (info.haltedSpans ?? []).some(([a, b]) => a <= nm && nm < b);
};

const EFF_HELP = "(1 + 40% per operator) x (1 + matching skill bonuses), while this shift is working.";
const REGEN_HELP = "100% + Mood Regen skills of this shift. While it works, every resting or off-duty operator on the ship recovers Mood this much faster.";
const EMPTY_HELP = "No operators in this shift, so nothing is produced while it is on duty. In the game, Auto-Rotate needs operators in both shifts.";
const EMPTY_CN_HELP = "No operators in this shift, so there is no Mood Regen bonus while it is on duty. In the game, Auto-Rotate needs operators in both shifts.";
const emptyHelp = (roomId: string): string => (roomType(roomId) === "CN" ? EMPTY_CN_HELP : EMPTY_HELP);

function shiftBadge(roomId: string, info: ShiftInfo, workingNow: boolean, auto: boolean): string {
  if (!workingNow) return `<span class="badge rest" ${tip("This shift is off duty and recovering Mood.")}>RESTING</span>`;
  if (auto && !info.operators) return `<span class="badge rest" ${tip(emptyHelp(roomId))}>IDLE</span>`;
  if (auto && haltedNow(info)) {
    return `<span class="badge halt" ${tip("On schedule, but its operators are resting at zero Mood until they are back at max Mood.")}>HALTED</span>`;
  }
  return `<span class="badge" ${tip(auto ? "This shift is on duty right now (server time)." : "This shift is on duty until you activate the other one.")}>ON DUTY</span>`;
}

function shiftPanel(roomId: string, s: ShiftId, info: ShiftInfo, draftWin: Window, workingNow: boolean, auto: boolean): string {
  const stats: [string, string, string][] = [
    ["Mood Drop / Hour", `${fmt3(info.moodDropPerHour)}%`, "7.2% per hour at base, lowered by Mood Drop skills of this shift."],
  ];
  for (const [t, v] of Object.entries(info.multipliers)) {
    const help = !info.operators ? emptyHelp(roomId) : t === "mood regen" ? REGEN_HELP : EFF_HELP;
    stats.push([t === "efficiency" ? "Efficiency" : title(t), pct3(v), help]);
  }
  if (!auto) {
    // no schedule while rotating by hand: the active shift works around the clock, the other one rests
    stats.push(workingNow
      ? ["On Duty", "24h", "Auto-Rotate is off, so this shift stays on duty (resting only at zero Mood) until you activate the other one."]
      : ["On Duty", "0h", "Auto-Rotate is off, so this shift rests until you activate it."]);
  } else {
    stats.push(["Scheduled", hoursLabel(info.scheduledMin), "Hours per day this shift is on duty."]);
    if (!info.operators) {
      stats.push(["Idle", hoursLabel(info.scheduledMin), emptyHelp(roomId)]);
    } else if (info.worked !== undefined && tires(roomId)) {
      stats.push(["Working", hoursLabel(info.worked), "Average hours per day this shift actually works, once its daily pattern settles."]);
      if (info.halted) stats.push(["Halted", hoursLabel(info.halted), "Average hours per day on schedule but resting at zero Mood."]);
      stats.push(["Rest", `${hoursLabel(info.restAvailableMin)} / need ${hoursLabel(info.restNeededMin)}`,
        "Off-duty hours per day vs. hours needed to recover the Mood used in one shift, at the Mood Regen the ship gives while this shift is off duty."]);
    }
  }
  const statHtml = stats.map(([k, v, h]) => `<span class="ss" ${tip(h)}><i>${esc(k)}</i> ${esc(v)}</span>`).join("");
  const badge = shiftBadge(roomId, info, workingNow, auto);
  const estTip = "Time for this shift to go from max Mood to zero Mood: 50000 s / (1 - Mood Drop reductions).";
  return `<div class="shift shift-${s}${workingNow ? " active" : ""}">
      <div class="shift-head">
        <div><div class="shift-title"><span class="shift-letter">${s}</span>Assign to Shift ${s} ${badge}</div>
             <div class="est" ${tip(estTip)}>EST. Work Time: ${esc(info.workTimeLabel)}</div></div>
        ${windowLines(roomId, s, info.window, draftWin, auto)}
      </div>
      ${haltWarning(roomId, s, info, draftWin, auto)}
      ${slotsRow(shiftSlot(roomId, s))}
      <div class="shift-stats">${statHtml}</div>
    </div>`;
}

export function scheduler(roomId: string, sh: ShiftSettings): string {
  const draft = draftOf(roomId);
  const { p, q, inner } = draft;
  const outer = other(inner);
  let ticks = "";
  for (let h = 0; h <= 24; h++) ticks += `<span class="tick${h % 6 === 0 ? " major" : ""}" style="left:${pct(h * 60)}"></span>`;
  const labels = [0, 6, 12, 18, 24].map((h) => `<span class="tlabel" style="left:${pct(h * 60)}">${pad2(h)}:00</span>`).join("");
  let segs = "";
  for (const [a, b, who] of [[0, p, outer], [p, q, inner], [q, DAY_MIN, outer]] as const) {
    if (b > a) segs += `<div class="seg seg-${who}" style="left:${pct(a)};width:${pct(b - a)}"><span>${who}</span></div>`;
  }
  const r = esc(roomId);
  const handles = ([["p", p], ["q", q]] as const).map(([h, m]) =>
    `<div class="handle" data-handle="${h}" data-room="${r}" style="left:${pct(m)}" `
    + `${tip(`Drag to move this boundary (${minutesToClock(m)}). Snaps to the hour.`)}><i></i></div>`).join("");
  const hour = Math.floor(nowMin() / 60);
  const marker = `<div class="now" style="left:${pct(hour * 60 + 30)}"></div>`;
  const changed = !sameBar(draft, sh);
  return `<div class="sched" id="sched-${r}">
      <div class="hint"><span class="hint-bar"></span>Drag a shift's starting and finishing time to adjust work hours. The other shift will automatically work the remaining hours.</div>
      <div class="timeline">${labels}<div class="ticks">${ticks}</div>
        <div class="bar" id="bar-${r}">${segs}${handles}${marker}</div></div>
      <div class="now-label" ${tip("The hour slot the server clock is in now. Change the time zone in the settings above.")}>▼ Current Schedule: ${pad2(hour)}:00-${pad2((hour + 1) % 24)}:00 (${utc()})</div>
      <div class="sched-actions">
        <span class="sched-title">WORK SCHEDULING</span>
        <button class="link" data-act="shift-reset" data-room="${r}" ${tip("Shift A 00:00-12:00, Shift B 12:00-24:00")}>↺ Reset to Default</button>
        <span class="sep">|</span>
        <button class="link" data-act="shift-swap" data-room="${r}" ${tip("Give Shift A's hours to Shift B and the other way round")}>⇄ Swap Shift Hours</button>
        <button class="confirm" data-act="shift-confirm" data-room="${r}" ${changed ? "" : "disabled"} ${tip("Apply the new schedule")}>Confirm <span>✓</span></button>
      </div>
    </div>`;
}

function workingNow(sh: ShiftSettings, info: Record<ShiftId, ShiftInfo>): Record<ShiftId, boolean> {
  const nm = nowMin();
  if (sh.autoRotate) return { A: inWindow(nm, info.A.window), B: inWindow(nm, info.B.window) };
  return { A: sh.active === "A", B: sh.active === "B" };
}

function shiftSection(roomId: string, res: RoomResult): string {
  const sh = getShiftSettings(S.profile, roomId);
  const auto = Boolean(sh.autoRotate);
  // without auto-rotate there is no bar and no Confirm, so a leftover draft is not shown
  const dwin = shiftWindows(auto ? draftOf(roomId) : sh);
  const info = res.shifts!;
  const working = workingNow(sh, info);
  const cur: ShiftId = working.A ? "A" : "B";
  let top = "";
  const n = info[cur].operators;
  if (roomType(roomId) === "MFG") {
    const mult = info[cur].multipliers.efficiency ?? 0;
    const base = n ? productionMultiplier(n, 0) : 0;
    let chips: string;
    if (!n) chips = `<b class="chip" ${tip(EMPTY_HELP)}>NO OPERATORS</b> <b>0%</b>`;
    else {
      chips = `<b class="chip">+${n * 40}%</b> <b class="chip">+${fmt3((mult - base) * 100)}%</b> <b>${pct3(mult)}</b>`;
      if (auto && haltedNow(info[cur])) {
        chips += ` <b class="chip halt" ${tip(`Shift ${cur} is on schedule but resting at zero Mood right now, so the cabin is not producing until it is back at max Mood.`)}>HALTED NOW</b>`;
      }
    }
    top = `<div class="topbar">`
      + `<span ${tip("Production efficiency of the shift on duty now: 100% + 40% per operator, then x (1 + matching skill bonuses).")}>`
      + `<i>Material Efficiency · Shift ${cur}</i> ${chips}</span>`
      + `<span ${tip("Mood lost per hour by the shift on duty now.")}><i>Mood Drop / Hour</i> <b>${fmt3(info[cur].moodDropPerHour)}%</b></span></div>`;
  } else if (roomType(roomId) === "CN") {
    const regen = info[cur].multipliers["mood regen"] ?? 1;
    let chips: string;
    if (!n) chips = `<b class="chip" ${tip(EMPTY_CN_HELP)}>NO OPERATORS</b> <b>100%</b>`;
    else {
      chips = `<b class="chip">+${fmt3((regen - 1) * 100)}%</b> <b>${pct3(regen)}</b>`;
      if (auto && tires(roomId) && haltedNow(info[cur])) {
        chips += ` <b class="chip halt" ${tip(`Shift ${cur} is on schedule but resting at zero Mood right now, so it gives no Mood Regen until it is back at max Mood.`)}>HALTED NOW</b>`;
      }
    }
    top = `<div class="topbar">`
      + `<span ${tip("Mood Regen from the shift on duty now: 100% + its Mood Regen skills, for every resting operator on the ship.")}>`
      + `<i>Mood Regen · Shift ${cur}</i> ${chips}</span>`
      + `<span ${tip("Mood lost per hour by the shift on duty now.")}><i>Mood Drop / Hour</i> <b>${fmt3(info[cur].moodDropPerHour)}%</b></span></div>`;
  }
  const r = esc(roomId);
  let toggles = `<div class="shift-toggles"><label class="check" ${tip("ON: shifts rotate on the schedule below. OFF: rotate manually with Activate Shift.")}>`
    + `<input type="checkbox" data-change="auto-rotate" data-room="${r}" ${auto ? "checked" : ""}><span>AUTO-ROTATE</span></label>`;
  if (!auto) {
    const o = other(sh.active);
    toggles += `<button data-act="activate-shift" data-room="${r}" ${tip(`Put Shift ${o} on duty. The other shift rests.`)}>Activate Shift ${o}</button>`;
  } else {
    toggles += '<span class="muted small">Switch Auto-Rotate off to rotate shifts manually.</span>';
  }
  toggles += `<button class="danger" data-act="remove-shift" data-room="${r}" ${tip("Go back to a single team of 3 operators")}>Remove Shift B</button></div>`;
  const panels = SHIFTS.map((s) => shiftPanel(roomId, s, info[s], dwin[s], working[s], auto)).join("");
  return top + toggles + `<div class="shift-grid">${panels}</div>` + (auto ? scheduler(roomId, sh) : "");
}

function roomKeyStat(roomId: string, res: RoomResult | undefined): [string, string] {
  const rtype = roomType(roomId);
  if (!res) return ["--", ""];
  if (rtype === "CN") return [res.moodRegen ?? "--", res.regenUptime !== undefined ? "avg mood regen" : "Mood regen"];
  if (rtype === "MFG") {
    if (res.xpPerHour !== undefined) return [res.xpPerHour, "EXP / hour"];
    return ["--", dp().roomSettings[roomId]?.item ? "No operators" : "Pick a product"];
  }
  if (rtype === "GC") {
    let best: [string, string] | null = null;
    let bestNum = -Infinity;
    for (const t of ["mineral", "plant", "fungus"] as const) {
      const v = res[t] ?? "0%";
      const num = parseFloat(v.replace(/%+$/, "")) || 0;
      if (num > bestNum) [best, bestNum] = [[v, t], num];
    }
    return [best![0], `${best![1]} speed`];
  }
  return [res.duration ?? "--", "per clue"];
}

export function roomAlert(roomId: string, res: RoomResult | undefined): string {
  if (!res?.shifts) return "";
  if (!getShiftSettings(S.profile, roomId).autoRotate) return "";
  const shifts = res.shifts;
  // halted time from the simulation: Mood running out within a shift, or too little rest between shifts
  const bad = SHIFTS.filter((s) => shifts[s].operators && (shifts[s].halted ?? 0) > 0);
  return bad.length ? `Shift ${bad.join(" & ")} may halt` : "";
}

function shipTile(roomId: string, res: RoomResult | undefined): string {
  const rtype = roomType(roomId);
  const slots = [roomId, ...(shiftOn(roomId) ? [shiftSlot(roomId, "B")] : [])];
  let faces = "";
  for (const sl of slots) {
    const ops = dp().roomAssignments[sl] ?? [null, null, null];
    const mark = sl.includes("#B") ? '<i class="shift-mark">B</i>' : slots.length > 1 ? '<i class="shift-mark">A</i>' : "";
    faces += `<div class="faces">${mark}${ops.map((o) => (o ? opImg(o.id, "face") : '<span class="face empty"></span>')).join("")}</div>`;
  }
  const [val, label] = roomKeyStat(roomId, res);
  const alert = roomAlert(roomId, res);
  const name = ROOM_DATA[rtype].name;
  return `<button class="tile tile-${rtype}${S.room === roomId ? " sel" : ""}" data-act="select-room" data-room="${esc(roomId)}" `
    + `${tip(`${name} (${roomId})\nClick to open`)}>`
    + `<div class="tile-head">${img("base_icons", rtype, "tile-icon")}<span class="tile-name">${name}</span>`
    + `<span class="tile-code">${esc(roomId)}</span></div>`
    + `<div class="tile-body"><div class="faces-wrap">${faces}</div><div class="tile-stat"><b>${esc(val)}</b><span>${esc(label)}</span></div></div>`
    + `${alert ? `<div class="tile-alert">! ${esc(alert)}</div>` : ""}</button>`;
}

function kpis(res: Results): string {
  // at most two cabins, so plain addition matches Python's sum()
  const xp = (type: string): number => Object.values(res).reduce((n, r) => (r?.xpType === type ? n + (r.xpPerHourNum ?? 0) : n), 0);
  const slots = Object.values(dp().roomAssignments);
  const filled = slots.reduce((n, ops) => n + ops.filter(Boolean).length, 0);
  const total = slots.reduce((n, ops) => n + ops.length, 0);
  const alerts = ROOM_IDS.filter((rid) => roomAlert(rid, res[rid])).length;
  const tiles: [string, string, string, string][] = [
    ["OPERATOR EXP / H", fmt3(xp("operator xp")), "Operator EXP per hour from all Manufacturing Cabins making operator EXP items. Combat Records (Lv 1-60) and Cognitive Carriers (Lv 61-90) are added together.", ""],
    ["WEAPON EXP / H", fmt3(xp("weapon xp")), "Weapon EXP per hour from all Manufacturing Cabins making weapon EXP items.", ""],
    ["CLUES / DAY", res.RR?.cluesPerDay ?? "0", "Clues collected per day in the Reception Room at the average efficiency.", ""],
    ["MOOD REGEN", res.CN.moodRegen ?? "", "Recovery speed for resting operators, from Control Nexus skills. When Control Nexus operators tire and rest (as in the game), this is the average over time.", ""],
    ["STAFFED", `${filled}/${total}`, "Filled operator slots across all rooms and shifts.", ""],
    ["ALERTS", String(alerts), "Cabins where a shift runs out of Mood while on schedule (work time shorter than the schedule, or too little rest between shifts), so production stops until it is back at max Mood.", alerts ? " warn" : " ok"],
  ];
  return `<div class="kpis">${tiles.map(([k, v, h, c]) => `<div class="kpi${c}" ${tip(h)}><span>${k}</span><b>${esc(v)}</b></div>`).join("")}</div>`;
}

/** Detail panel for the selected room. */
export function roomCard(roomId: string, res: RoomResult | undefined): string {
  const rtype = roomType(roomId);
  let body = `<div class="room-controls">${roomControls(roomId)}</div>`;
  if (shiftOn(roomId) && res) {
    body += shiftSection(roomId, res);
  } else {
    body += slotsRow(roomId);
    const addTip = rtype === "CN"
      ? "Add a second Control Nexus team (Shift B). The teams rotate on a schedule, so one can rest while the other keeps Mood Regen going."
      : "Add a second team (Shift B). Each cabin can run 2 shifts that rotate on a schedule.";
    body += `<button class="add-shift" data-act="add-shift" data-room="${esc(roomId)}" ${tip(addTip)}>+ Add Shift B</button>`;
  }
  body += resultsGrid(roomId, res);
  return `<section class="detail room-${rtype}" id="room-${esc(roomId)}">`
    + `<div class="detail-head">${img("base_icons", rtype, "detail-icon")}`
    + `<div><h2>${ROOM_DATA[rtype].name}</h2><p>${BLURBS[rtype]}</p></div><span class="room-code">${ROOM_CODES[rtype]} // ${esc(roomId)}</span></div>`
    + `<div class="detail-body">${body}</div></section>`;
}

/** Ship deck order: the Reception Room sits under the Control Nexus, above the cabins. */
const DECK_ORDER: readonly string[] = ["CN", "RR", ...ROOM_IDS.filter((rid) => rid !== "CN" && rid !== "RR")];

export function overviewView(): string {
  const res = results();
  const tiles = DECK_ORDER.map((rid) => shipTile(rid, res[rid])).join("");
  return `<div class="view overview">${kpis(res)}`
    + `<div class="ov-grid"><aside class="ship"><div class="ship-label">SHIP DECK</div>${tiles}</aside>`
    + `${roomCard(S.room, res[S.room])}</div></div>`;
}
