// Small HTML pieces shared by the views.
import { OPS, PRIO_MAX, ROOM_DATA, SKILL_ICON_TYPE, fmt3, priorityLevels, priorityOn, roomOn, roomType, secondsToHms, skillLevel } from "../core/index.ts";
import type { RoomType, Skill } from "../core/index.ts";
import { asset, cmpStr, esc, img, remoteImg, tip } from "./html.ts";
import { S, dp, slotLabel, whereIs } from "./state.ts";

export const LEVEL_NAMES = ["Off", "Lv 1", "Lv 2"];

export const opName = (opId: string): string => OPS[opId]?.name ?? opId;

export function opImg(opId: string, cls = "op-img"): string {
  const op = OPS[opId];
  // the site's own copy of the warfarin.wiki picture (scripts/fetch-art.mjs), else the picture
  // itself, else the asset repo's older art
  if (op?.art) return remoteImg(`assets/portraits/${encodeURIComponent(opId)}.webp`, [op.art, asset("operators", opId)], cls, opName(opId));
  return img("operators", opId, cls, opName(opId));
}

export const rarityOf = (opId: string): number => OPS[opId]?.rarity ?? 0;

/** The operator's stars, colored by rarity like the game. */
export function stars(opId: string): string {
  const n = rarityOf(opId);
  return n ? `<span class="stars r${n}" ${tip(`${n}-star operator`)}>${"★".repeat(n)}</span>` : "";
}

/** A skill's value at a level, as the game words it: +16%, -18% Mood Drop, Clue 3. */
export function skillValueLabel(sk: Skill, lv: number): string {
  if (!lv) return "Off";
  const v = sk.values[lv - 1];
  if (sk.type === "clue rate up") return `Clue ${v}`;
  return sk.type === "mood drain" ? `-${fmt3(v * 100)}%` : `+${fmt3(v * 100)}%`;
}

/** Skill types that raise a room's output with its product or plots (weights add up to 1 per room). */
function outputTypes(rtype: RoomType, roomId: string | null): Record<string, number> {
  if (rtype === "CN") return { "mood regen": 1 };
  if (rtype === "RR") return { "clue efficiency": 1 };
  const rs = roomId ? dp().roomSettings[roomId] ?? {} : {};
  if (rtype === "MFG") {
    const item = rs.item ? ROOM_DATA.MFG.items[rs.item] : undefined;
    return item ? { [item.type]: 1 } : { "operator xp": 1, "weapon xp": 1 };
  }
  const plots = (rs.items ?? []).filter((x): x is string => typeof x === "string" && Object.hasOwn(ROOM_DATA.GC.items, x));
  if (!plots.length) return { mineral: 1, plant: 1, fungus: 1 };
  const w: Record<string, number> = {};
  for (const x of plots) {
    const t = ROOM_DATA.GC.items[x].type;
    w[t] = (w[t] ?? 0) + 1 / plots.length;
  }
  return w;
}

const clean = (x: number): number => Math.round(x * 1e9) / 1e9;

/**
 * How well an operator fits a room, compared key by key (higher first): its skills that raise
 * the room's output (matched to the product or plots), then Mood Drop, then its other skills
 * there, at the levels set. `roomId` null: the room type in general (the Roster filter).
 */
export function fitKey(opId: string, rtype: RoomType, roomId: string | null): number[] {
  const w = outputTypes(rtype, roomId);
  let [main, drain, other, has] = [0, 0, 0, 0];
  OPS[opId].baseSkills.forEach((sk, i) => {
    if (sk.room !== rtype) return;
    has = 1;
    const lv = skillLevel(S.profile, opId, i);
    const v = lv ? sk.values[lv - 1] : 0;
    if (sk.type === "mood drain") drain += v;
    else if (Object.hasOwn(w, sk.type)) main += w[sk.type] * v;
    else other += sk.type === "clue rate up" ? (lv ? 0.001 : 0) : v; // rate-up values are clue numbers
  });
  return [clean(main), clean(drain), clean(other), has];
}

const byKeys = (a: number[], b: number[]): number => {
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return b[k] - a[k];
  return 0;
};

/** Operators in display order: by fit for a room type when given (best first), then by stars or name. */
export function sortOps(ids: readonly string[], by: string, fit?: (o: string) => number[]): string[] {
  const keys = fit ? new Map(ids.map((o) => [o, fit(o)])) : null;
  return [...ids].sort((a, b) => (keys ? byKeys(keys.get(a)!, keys.get(b)!) : 0)
    || (by === "name" ? 0 : rarityOf(b) - rarityOf(a))
    || cmpStr(opName(a), opName(b)));
}

export function skillIcons(skill: Skill): string {
  const t = SKILL_ICON_TYPE[skill.type] ?? skill.type;
  return `<span class="sk-icons">${img("base_icons", skill.room, "bi")}${img("base_icons", `${skill.room}-${t}`, "bi")}</span>`;
}

export function opTip(opId: string): string {
  const lines = [opName(opId).toUpperCase()];
  OPS[opId].baseSkills.forEach((sk, i) => {
    const lv = skillLevel(S.profile, opId, i);
    const text = lv ? sk.texts[lv - 1] : "Skill turned off";
    lines.push(`[${sk.room}] ${sk.name} (${LEVEL_NAMES[lv]})\n${text}`);
  });
  const loc = whereIs(opId);
  if (loc) lines.push(`Assigned: ${slotLabel(loc)}`);
  return lines.join("\n\n");
}

/** Data attributes from a record, escaped. */
export function attrs(data: Record<string, string | number>): string {
  return Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(" ");
}

/** Segmented Off / 1 / 2 control; click a segment to set that level directly. */
export function levelSeg(value: number, act: string, extra: Record<string, string | number>, label: string): string {
  let segs = "";
  for (const lv of [0, 1, 2]) {
    const cls = `seg-btn${lv === value ? " on" : ""}${lv > 0 && lv <= value ? " filled" : ""}`;
    segs += `<button class="${cls}" data-act="${act}" data-lv="${lv}" ${attrs(extra)}>${lv === 0 ? "OFF" : lv}</button>`;
  }
  return `<div class="lvseg" ${tip(label)}>${segs}</div>`;
}

export function slotHtml(slotId: string, i: number): string {
  const op = dp().roomAssignments[slotId]?.[i] ?? null;
  const data = attrs({ slot: slotId, i });
  if (!op) {
    return `<button class="slot empty" ${tip("Empty slot. Click to assign an operator.")} data-act="open-picker" ${data}>`
      + `<span class="slot-plus">+</span><span class="slot-no">0${i + 1}</span></button>`;
  }
  let cls = "slot";
  let note = "";
  if (op.fixed) [cls, note] = ["slot fixed", "\n\nFixed by you."];
  else if (op.filler) [cls, note] = ["slot filler", "\n\nNo matching skill here: adds the base 40% speed."];
  return `<button class="${cls}" ${tip(`${opTip(op.id)}${note}\nClick to change.`)} data-act="open-picker" ${data}>`
    + `${opImg(op.id, "slot-img")}<span class="slot-name">${esc(opName(op.id))}</span><span class="slot-no">0${i + 1}</span></button>`;
}

export function slotsRow(slotId: string): string {
  return `<div class="slots">${[0, 1, 2].map((i) => slotHtml(slotId, i)).join("")}</div>`;
}

export function itemButton(roomId: string, kind: "mfg" | "gc", itemId: string | null | undefined, i?: number, label = "Select Product"): string {
  const items: Record<string, { name: string; duration: number; type: string; value?: number }> = ROOM_DATA[roomType(roomId) as "MFG" | "GC"].items;
  const it = itemId ? items[itemId] : undefined;
  let t: string;
  let body: string;
  if (itemId && it) {
    t = `${it.name}\nBase time: ${secondsToHms(it.duration)}`;
    if (it.value !== undefined) t += `\nEXP value: ${it.value}`;
    t += `\nType: ${it.type}\n\nClick to change.`;
    body = `${img("items", itemId, "item-img", it.name)}<span>${esc(it.name)}</span>`;
  } else {
    [t, body] = ["Click to choose", `<span class="item-empty">${esc(label)}</span>`];
  }
  const extra = i === undefined ? "" : ` data-i="${i}"`;
  return `<button class="item-btn" ${tip(t)} data-act="open-item" ${attrs({ kind, room: roomId })}${extra}>${body}</button>`;
}

const PRIO_TIP = "How many times this room counts when Optimize compares plans. Higher-priority rooms get the strongest operators first.";

/** − xN + for a production room's priority (greyed out while room priority is off). */
export function prioStepper(roomId: string): string {
  const on = priorityOn(S.profile);
  const lv = priorityLevels(S.profile)[roomId] ?? 1;
  const r = esc(roomId);
  return `<div class="prio-step${on ? "" : " off"}" ${tip(on ? PRIO_TIP : "Room priority is off: every room counts x1. Switch it on to set this.")}>`
    + `<button class="mini" data-act="prio-step" data-room="${r}" data-d="-1" aria-label="Lower priority" ${on && lv > 1 ? "" : "disabled"}>−</button>`
    + `<b>x${on ? lv : 1}</b>`
    + `<button class="mini" data-act="prio-step" data-room="${r}" data-d="1" aria-label="Raise priority" ${on && lv < PRIO_MAX ? "" : "disabled"}>+</button></div>`;
}

/** The room priority switch: on, each room counts its own level; off, all count the same. */
export function prioSwitch(label = "ROOM PRIORITY"): string {
  const t = "On: rooms with a higher priority count more when Optimize compares plans, so they get the strongest operators. Off: every room counts the same.";
  return `<label class="check prio-switch" ${tip(t)}><input type="checkbox" data-change="prio-on" ${priorityOn(S.profile) ? "checked" : ""}><span>${label}</span></label>`;
}

/** A room's on/off switch: off, the room holds no operators and Optimize leaves it empty. */
export function roomSwitch(roomId: string, label = "IN USE"): string {
  const on = roomOn(S.profile, roomId);
  const t = on
    ? "Switch this room off: its operators are freed, and Optimize leaves it empty and uses them in the other rooms."
    : "This room is off: it holds no operators and Optimize leaves it empty. Switch it on to use it again.";
  return `<label class="check room-switch" ${tip(t)}><input type="checkbox" data-change="room-on" data-room="${esc(roomId)}" ${on ? "checked" : ""}><span>${label}</span></label>`;
}
