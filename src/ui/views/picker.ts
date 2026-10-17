// The picker modal: operators for a slot, or a product / plot item.
import { OPS, ROOM_DATA, SKILL_ICON_TYPE, roomType, secondsToHms } from "../../core/index.ts";
import { cmpStr, esc, img, tip } from "../html.ts";
import { S, dp, opLists, slotLabel, whereIs } from "../state.ts";
import type { Picker } from "../state.ts";
import { opImg, opName, opTip } from "../widgets.ts";

function opEntries(slot: string, q: string): string {
  const rtype = roomType(slot);
  const hasSkill = (o: string): boolean => OPS[o].baseSkills.some((sk) => sk.room === rtype);
  const ordered = [...opLists().available].sort((a, b) => Number(!hasSkill(a)) - Number(!hasSkill(b)) || cmpStr(opName(a), opName(b)));
  return ordered.filter((o) => !q || opName(o).toLowerCase().includes(q)).map((o) => {
    const types = OPS[o].baseSkills.filter((sk) => sk.room === rtype).map((sk) => SKILL_ICON_TYPE[sk.type] ?? sk.type);
    const fits = types.length ? img("base_icons", rtype, "bi") + types.map((t) => img("base_icons", `${rtype}-${t}`, "bi")).join("") : "";
    return `<button class="pick${fits ? " fits" : ""}" data-act="pick" data-val="${esc(o)}" ${tip(opTip(o))}>`
      + `${opImg(o)}<span>${esc(opName(o))}</span>`
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
    hint = '<div class="muted small pad-x">Operators with a skill for this room come first and are highlighted.</div>';
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
