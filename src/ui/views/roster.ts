// Roster tab: search, room/status filters, default skill levels and one card
// per operator with per-skill level segments.
import { OPS, baseRoom, getShiftSettings, skillLevel } from "../../core/index.ts";
import { cmpStr, esc, img, tip } from "../html.ts";
import { ROOM_FILTERS, S, STATUS_FILTERS, dp, opLists, slotLabel, whereIs } from "../state.ts";
import { LEVEL_NAMES, attrs, levelSeg, opImg, opName, opTip, skillIcons } from "../widgets.ts";

const SKILL_HELP: Record<string, string> = {
  "mood drain": "Slows Mood Drop for everyone working in the room, so they work longer before resting.",
  "mood regen": "Speeds up Mood recovery for every resting operator on the ship.",
  "operator xp": "Raises production efficiency when the cabin makes operator EXP items.",
  "weapon xp": "Raises production efficiency when the cabin makes weapon EXP items.",
  "clue efficiency": "Speeds up clue collection in the Reception Room.",
  "clue rate up": "Raises the chance of one specific clue. Not counted by the optimizer.",
  mineral: "Speeds up mineral growth in the Growth Chamber.",
  plant: "Speeds up plant growth in the Growth Chamber.",
  fungus: "Speeds up fungus growth in the Growth Chamber.",
};

type Kind = "available" | "fixed" | "disabled";

function skillLine(opId: string, i: number): string {
  const sk = OPS[opId].baseSkills[i];
  const lv = skillLevel(S.profile, opId, i);
  const custom = (dp().operatorSkills[opId]?.[i] ?? null) !== null;
  const t = `${sk.name}  [${sk.room} · ${sk.type}]\n\nLv 1: ${sk.texts[0]}\nLv 2: ${sk.texts[1]}\n\n${SKILL_HELP[sk.type] ?? ""}`;
  const lvTip = LEVEL_NAMES[lv] + (custom ? " · set for this operator" : " · follows the default");
  return `<div class="sl${custom ? " custom" : ""}${lv === 0 ? " off" : ""}">`
    + `<div class="sl-info" ${tip(t)}>${skillIcons(sk)}<div class="sl-text"><b>${esc(sk.name)}</b>`
    + `<span>${esc(sk.room)} · ${esc(sk.type)}</span></div></div>`
    + `${levelSeg(lv, "set-level", { op: opId, i }, lvTip)}</div>`;
}

function opCard(opId: string, kind: Kind): string {
  const custom = Object.hasOwn(dp().operatorSkills, opId);
  const loc = whereIs(opId);
  const data = attrs({ op: opId });
  let tag = "";
  if (loc) {
    const rid = baseRoom(loc);
    const short = rid + (loc.includes("#B") ? " · B" : getShiftSettings(S.profile, rid).enabled ? " · A" : "");
    const t = (kind === "fixed" ? "Fixed in " : "Assigned to ") + slotLabel(loc);
    tag = `<span class="oc-tag${kind === "fixed" ? " fixed" : ""}" ${tip(t)}>${esc(short)}</span>`;
  }
  let toggle = "";
  if (kind === "disabled") toggle = `<button class="mini plus" ${tip("Enable: allow this operator to be assigned")} data-act="enable-op" ${data}>ENABLE</button>`;
  else if (kind !== "fixed") toggle = `<button class="mini" ${tip("Disable: keep this operator out of every room")} data-act="disable-op" ${data}>DISABLE</button>`;
  const skills = OPS[opId].baseSkills.map((_, i) => skillLine(opId, i)).join("");
  return `<div class="oc oc-${kind}">`
    + `<div class="oc-top"><div class="oc-portrait" ${tip(opTip(opId))}>${opImg(opId, "oc-img")}${tag}</div>`
    + `<div class="oc-main"><div class="oc-name">${esc(opName(opId))}</div>${skills}</div></div>`
    + `<div class="oc-actions"><button class="mini" ${tip("Reset both skills to the default levels")} data-act="reset-levels" `
    + `${data} ${custom ? "" : "disabled"}>↺ RESET</button>${toggle}</div></div>`;
}

export const NO_MATCH = '<div class="empty-note">No operators match these filters.</div>';

/** [operator id, card] for the operators matching the search and filters, in display order. */
export function rosterCardList(): [string, string][] {
  const { available, fixed, disabled } = opLists();
  const kinds = new Map<string, Kind>();
  for (const o of available) kinds.set(o, "available");
  for (const o of fixed) kinds.set(o, "fixed");
  for (const o of disabled) kinds.set(o, "disabled");
  const kind = (o: string): Kind => kinds.get(o) ?? "available";
  const q = S.search.trim().toLowerCase();
  const { filterRoom: froom, filterStatus: fstat } = S;
  const keep = (o: string): boolean => {
    if (q && !opName(o).toLowerCase().includes(q)) return false;
    if (froom !== "ALL" && !OPS[o].baseSkills.some((sk) => sk.room === froom)) return false;
    const loc = whereIs(o);
    if (fstat === "free" && (loc || kind(o) === "disabled")) return false;
    if (fstat === "assigned" && !loc) return false;
    if (fstat === "disabled" && kind(o) !== "disabled") return false;
    return true;
  };
  const rank = (o: string): number => (kind(o) === "disabled" ? 1 : 0);
  const order = Object.keys(OPS).sort((a, b) => rank(a) - rank(b) || cmpStr(opName(a), opName(b)));
  return order.filter(keep).map((o) => [o, opCard(o, kind(o))]);
}

/** The cards as one string (the DOM keeps and patches them one by one, see render.ts). */
export function rosterCards(): string {
  return rosterCardList().map(([, html]) => html).join("") || NO_MATCH;
}

function chip(group: string, val: string, label: string, cur: string): string {
  return `<button class="chip-btn${val === cur ? " on" : ""}" data-act="filter" data-group="${group}" data-val="${val}">${label}</button>`;
}

/** Default skill levels and RESET ALL. */
export function rosterDefaults(): string {
  const [d0, d1] = dp().settings.defaultLevels;
  const dtip = (s: string): string => `Default level for every operator's ${s}. Changing it applies to everyone, including operators you set individually.`;
  const nCustom = Object.keys(dp().operatorSkills).length;
  return `<div class="defaults">
            <div class="def"><span>E1/3 DEFAULT</span>${levelSeg(d0, "set-default", { i: 0 }, dtip("E1/3 skill"))}</div>
            <div class="def"><span>E2/4 DEFAULT</span>${levelSeg(d1, "set-default", { i: 1 }, dtip("E2/4 skill"))}</div>
            <button class="mini" data-act="reset-all-levels" ${nCustom ? "" : "disabled"} ${tip("Clear every per-operator level so all follow the defaults")}>↺ RESET ALL (${nCustom})</button>
          </div>`;
}

export function rosterMeta(): string {
  const { available, fixed, disabled } = opLists();
  return `<div class="roster-meta">${available.length + fixed.length} usable · ${disabled.length} disabled · hover a portrait or skill for details</div>`;
}

/** `cards: false` leaves the grid empty for the DOM renderer to fill. */
export function rosterView(cards = true): string {
  const roomChips = ROOM_FILTERS.map(([v, l]) => chip("room", v, (v !== "ALL" ? img("base_icons", v, "chip-icon") : "") + l, S.filterRoom)).join("");
  const statChips = STATUS_FILTERS.map(([v, l]) => chip("status", v, l, S.filterStatus)).join("");
  return `
    <div class="view roster">
      <div class="toolbar">
        <div class="tb-row">
          <label class="search"><span>⌕</span><input id="op-search" value="${esc(S.search)}" data-input="search" placeholder="Search operators" aria-label="Search operators"></label>
          ${rosterDefaults()}
        </div>
        <div class="tb-row chips">${roomChips}<span class="chip-sep"></span>${statChips}</div>
      </div>
      ${rosterMeta()}
      <div class="oc-grid" id="oc-grid">${cards ? rosterCards() : ""}</div>
    </div>`;
}
