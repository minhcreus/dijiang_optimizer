// The picker modal: operators for a slot, or a product / plot item.
import { OPS, ROOM_DATA, SKILL_ICON_TYPE, baseRoom, roomType, secondsToHms, skillLevel } from "../../core/index.ts";
import { esc, img, tip } from "../html.ts";
import { S, dp, opLists, slotLabel, whereIs } from "../state.ts";
import type { Picker } from "../state.ts";
import { fitKey, opImg, opName, opTip, rarityOf, skillValueLabel, sortOps, stars } from "../widgets.ts";

function opEntries(slot: string, q: string): string {
  const rtype = roomType(slot);
  const room = baseRoom(slot);
  // the best fits for this room first: higher bonus for its product or plots, then Mood Drop, then stars
  const ordered = sortOps(opLists().available, "rarity", (o) => fitKey(o, rtype, room));
  return ordered.filter((o) => !q || opName(o).toLowerCase().includes(q)).map((o) => {
    const skills = OPS[o].baseSkills.map((sk, i) => [sk, skillLevel(S.profile, o, i)] as const).filter(([sk]) => sk.room === rtype);
    const fits = skills.length
      ? img("base_icons", rtype, "bi") + skills.map(([sk, lv]) => img("base_icons", `${rtype}-${SKILL_ICON_TYPE[sk.type] ?? sk.type}`, "bi")
        + `<b class="pick-val${lv ? "" : " off"}">${esc(skillValueLabel(sk, lv))}</b>`).join("")
      : "";
    return `<button class="pick${fits ? " fits" : ""} r${rarityOf(o)}" data-act="pick" data-val="${esc(o)}" ${tip(opTip(o))}>`
      + `${opImg(o)}<span>${esc(opName(o))}</span>${stars(o)}`
      + `<span class="pick-fit">${fits}</span>${whereIs(o) ? '<span class="pick-loc">IN USE</span>' : ""}</button>`;
  }).join("");
}

function itemEntries(kind: "mfg" | "gc", q: string): string {
  const items: Record<string, { name: string; duration: number; type: string; value?: number }> = ROOM_DATA[kind === "mfg" ? "MFG" : "GC"].items;
  return Object.entries(items).filter(([, it]) => !q || it.name.toLowerCase().includes(q) || it.type.includes(q)).map(([k, it]) => {
    let t = `${it.name}\nBase time: ${secondsToHms(it.duration)}\nType: ${it.type}`;
    if (it.value !== undefined) t += `\nEXP value: ${it.value}`;
    return `<button class="pick item" data-act="pick" data-val="${esc(k)}" ${tip(t)}>`
      + `${img("items", k, "pick-item-img", it.name)}<span>${esc(it.name)}</span>`
      + `<span class="pick-type">${esc(it.type)}</span></button>`;
  }).join("");
}

/** The grid of choices (re-rendered alone while typing in the search box). */
export function pickerEntries(pk: Picker): string {
  const q = S.pickerSearch.trim().toLowerCase();
  const entries = pk.kind === "op" ? opEntries(pk.slot, q) : itemEntries(pk.kind, q);
  return entries || '<span class="muted">Nothing matches.</span>';
}

export function pickerView(): string {
  const pk = S.picker;
  if (!pk) return "";
  let heading: string;
  let clear: string;
  let hint = "";
  if (pk.kind === "op") {
    const cur = dp().roomAssignments[pk.slot]?.[pk.i] ?? null;
    heading = `${slotLabel(pk.slot)} · slot ${pk.i + 1}`;
    clear = cur ? '<button data-act="pick" data-val="">Clear slot</button>' : "";
    hint = '<div class="muted small pad-x">Operators with a skill for this room are highlighted, the highest bonus for its product first (at the skill levels you set), then by stars.</div>';
  } else {
    heading = pk.kind === "mfg" ? "Select Product" : `Growth Chamber · Plot ${pk.i + 1}`;
    clear = '<button data-act="pick" data-val="">Clear</button>';
  }
  return `<div class="modal-bg" data-act="close-picker"><div class="modal" data-stop="1" role="dialog" aria-modal="true" aria-label="${esc(heading)}">
      <div class="modal-head"><b>${esc(heading)}</b>
        <input id="picker-search" placeholder="Search..." value="${esc(S.pickerSearch)}" data-input="picker-search" aria-label="Search">
        ${clear}<button data-act="close-picker" aria-label="Close">✕</button></div>
      ${hint}
      <div class="pick-grid" id="pick-grid">${pickerEntries(pk)}</div></div></div>`;
}
