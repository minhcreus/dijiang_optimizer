// Small HTML pieces shared by the views.
import { OPS, ROOM_DATA, SKILL_ICON_TYPE, roomType, secondsToHms, skillLevel } from "../core/index.ts";
import type { Skill } from "../core/index.ts";
import { esc, img, tip } from "./html.ts";
import { S, dp, slotLabel, whereIs } from "./state.ts";

export const LEVEL_NAMES = ["Off", "Lv 1", "Lv 2"];

export const opName = (opId: string): string => OPS[opId]?.name ?? opId;

export function opImg(opId: string, cls = "op-img"): string {
  return img("operators", opId, cls, opName(opId));
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
