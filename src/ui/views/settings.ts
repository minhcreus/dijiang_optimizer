// Settings tab: optimizer and schedule options, the profiles manager and the
// formula notes.
import { ALIGNMENT_OPTIONS, PRIO_ROOMS, ROOM_DATA, ROOM_IDS, cnModel, keepsHours, roomType } from "../../core/index.ts";
import type { ProfileMeta } from "../../storage.ts";
import { esc, img, tip } from "../html.ts";
import { S, dp } from "../state.ts";
import { relTime } from "../time.ts";
import { prioStepper, prioSwitch, roomSwitch } from "../widgets.ts";

const options = (keys: readonly string[], cur: string): string =>
  keys.map((k) => `<option value="${esc(k)}"${k === cur ? " selected" : ""}>${esc(k)}</option>`).join("");

const CN_MODELS: readonly [string, string][] = [["game", "Tires and rests (like the game)"], ["always", "Always on (original planner)"]];
const SHIFT_HOURS: readonly [string, string][] = [["optimize", "Optimize picks them"], ["keep", "Keep mine"]];

function timezoneOptions(cur: number): string {
  let out = "";
  for (let o = -12; o <= 14; o++) out += `<option value="${o}"${o === cur ? " selected" : ""}>UTC${o >= 0 ? "+" : "-"}${Math.abs(o)}</option>`;
  return out;
}

function profileRow(m: ProfileMeta, active: boolean, single: boolean): string {
  const id = esc(m.id);
  const when = `<span class="prof-when" ${tip(`Last changed ${new Date(m.updatedAt).toLocaleString()}\nCreated ${new Date(m.createdAt).toLocaleString()}`)}>Updated ${relTime(m.updatedAt)}</span>`;
  const main = S.renaming === m.id
    ? `<div class="prof-main"><input id="rename-input" class="prof-input" value="${esc(m.name)}" maxlength="40" data-id="${id}" aria-label="Profile name">${when}</div>`
    : active
      ? `<div class="prof-main"><b class="prof-name">${esc(m.name)}</b>${when}</div>`
      : `<button class="prof-main prof-open" data-act="profile-switch" data-id="${id}" ${tip(`Switch to "${m.name}"`)}><b class="prof-name">${esc(m.name)}</b>${when}</button>`;
  const renameBtns = S.renaming === m.id
    ? `<button class="mini plus" data-act="profile-rename-save" data-id="${id}">SAVE</button><button class="mini" data-act="profile-rename-cancel">CANCEL</button>`
    : `<button class="mini" data-act="profile-rename" data-id="${id}" ${tip("Rename this profile")}>RENAME</button>`;
  return `<li class="prof${active ? " on" : ""}">${main}
      ${active ? '<span class="prof-tag">ACTIVE</span>' : ""}
      <div class="prof-actions">${renameBtns}
        <button class="mini" data-act="profile-duplicate" data-id="${id}" ${tip("Copy this profile into a new one and switch to it")}>DUPLICATE</button>
        <button class="mini" data-act="profile-export" data-id="${id}" ${tip("Download this profile as a .json file (the original planner can import it too)")}>EXPORT</button>
        <button class="mini danger" data-act="profile-delete" data-id="${id}" ${single ? "disabled" : ""} ${tip(single ? "The only profile cannot be deleted. Use Reset instead." : "Delete this profile from this browser")}>DELETE</button>
      </div></li>`;
}

function profilesCard(): string {
  const { store } = S;
  const list = store.list();
  const activeId = store.activeId();
  const rows = list.map((m) => profileRow(m, m.id === activeId, list.length === 1)).join("");
  const status = store.status();
  const bad = status.state === "unavailable" || status.state === "error";
  const notice = bad && status.message ? `<div class="prof-notice">${esc(status.message)}</div>` : "";
  const msg = S.ioMsg ? `<span class="io-msg${S.ioMsg.error ? " err" : ""}" role="status">${esc(S.ioMsg.text)}</span>` : "";
  const data = esc(JSON.stringify(S.profile, null, 1));
  return `<div class="card wide">
        <h3>PROFILES</h3>
        <small class="muted">Each profile is a separate plan, saved in this browser automatically. Export a profile to back it up or move it to another browser.</small>
        ${notice}
        <ul class="profiles">${rows}</ul>
        <div class="io-actions">
          <button data-act="profile-new" ${tip("Start a new profile with default settings")}>+ New profile</button>
          <label class="file-btn" ${tip("Import a profile from a .json file: an export from this planner or from the original planner")}>Import file<input type="file" id="import-file" accept=".json,application/json,text/plain" data-change="import-file"></label>
          <button data-act="profile-export-all" ${tip("Download every profile in one .json file")}>Export all</button>
          <button data-act="reset-profile" class="danger" ${tip("Reset the active profile to the default settings")}>Reset this profile</button>
        </div>
        <small class="muted">Profile data: copy the text to back it up, or paste a profile (also from the original planner) and import it as a new profile.</small>
        <textarea id="io-text" data-profile="${esc(S.profileId)}" spellcheck="false" aria-label="Profile JSON">${data}</textarea>
        <div class="io-actions"><button data-act="import">Import pasted profile</button>${msg}</div>
      </div>`;
}

/** Production rooms in deck order (Reception Room first), each with its priority buttons. */
function prioRows(): string {
  const order = ["RR", ...PRIO_ROOMS.filter((r) => r !== "RR")];
  return order.map((rid) => {
    const t = roomType(rid);
    return `<div class="prio-row">${img("base_icons", t, "bi")}<span>${esc(ROOM_DATA[t].name)} <i>${esc(rid)}</i></span>${prioStepper(rid)}</div>`;
  }).join("");
}

/** Every room in deck order, each with its on/off switch. */
function roomRows(): string {
  const order = ["CN", "RR", ...ROOM_IDS.filter((r) => r !== "CN" && r !== "RR")];
  return order.map((rid) => {
    const t = roomType(rid);
    return `<div class="prio-row">${img("base_icons", t, "bi")}<span>${esc(ROOM_DATA[t].name)} <i>${esc(rid)}</i></span>${roomSwitch(rid)}</div>`;
  }).join("");
}

export function settingsView(): string {
  const s = dp().settings;
  return `
    <div class="view settings">
      <div class="card">
        <h3>OPTIMIZER</h3>
        <div class="field"><span>Rooms in use</span>
          <div class="prio-rows">${roomRows()}</div>
          <small>Untick a room you don't use: its operators are freed, and Optimize leaves it empty and puts them in the other rooms. The same switch is on each room's panel.</small></div>
        <div class="field"><span>Room priority</span>${prioSwitch("USE ROOM PRIORITY")}
          <div class="prio-rows">${prioRows()}</div>
          <small>Press + to make a room count more when Optimize compares plans (x1 to x5), so it gets the strongest operators. Off: every room counts x1. The same buttons are on each room's panel.</small></div>
        <label class="field"><span>Shift hours</span><select data-change="shift-hours">${SHIFT_HOURS.map(([k, label]) => `<option value="${k}"${(k === "keep") === keepsHours(S.profile) ? " selected" : ""}>${label}</option>`).join("")}</select>
          <small>Optimize picks them: it also sets each room's Shift A/B hours and how many Control Nexus operators to use. Keep mine: it only picks operators for the shifts you set.</small></label>
        <label class="field"><span>Operator alignment</span><select data-change="align">${options(ALIGNMENT_OPTIONS, s.align ?? "Staggered")}</select>
          <small>Staggered: operators start one at a time so someone is always working. Aligned: all start and rest together. Used for the Control Nexus and for rooms without auto-rotating shifts.</small></label>
        <label class="field"><span>Control Nexus Mood</span><select data-change="cn-model">${CN_MODELS.map(([k, label]) => `<option value="${k}"${k === cnModel(S.profile) ? " selected" : ""}>${label}</option>`).join("")}</select>
          <small>Like the game: Control Nexus operators lose Mood and rest like everyone else, and their Mood Regen only counts while they work. A Shift B on the Control Nexus keeps it going. Always on: the original planner's shortcut, Mood Regen never stops.</small></label>
      </div>
      <div class="card">
        <h3>SCHEDULE</h3>
        <label class="field"><span>Server time zone</span><select data-change="utc">${timezoneOptions(s.utcOffset ?? 8)}</select>
          <small>Used for shift schedules and the current-hour marker.</small></label>
      </div>
      ${profilesCard()}
      <div class="card wide">
        <h3>HOW THE NUMBERS WORK</h3>
        <ul class="formulas">
          <li><b>Work time</b> = 50000 s / (1 - Mood Drop reductions). Matches the in-game EST. Work Time.</li>
          <li><b>Break time</b> = 30000 s (8h 20min, 12% Mood per hour at base) / Mood Regen.</li>
          <li><b>Mood Regen</b> = 100% + Mood Regen skills of the Control Nexus operators who are working. They tire and rest like everyone else, so the planner follows the whole ship's Mood through a year and averages the last 10 months, with Staggered operators kept evenly spaced.</li>
          <li><b>Production speed</b> = (1 + 40% per working operator) x (1 + matching skill bonuses).</li>
          <li><b>Mood drop per hour</b> = 7.2% x (1 - Mood Drop reductions).</li>
          <li>Operators at zero Mood rest until max Mood, then return to work. Shift results simulate this minute by minute and average the days once the pattern repeats.</li>
          <li><b>Optimize</b> scores a plan as the sum of the rooms' efficiency, each times its room priority when that is on (the Growth Chamber counts the average over its plots), from the same numbers shown here. It tries Control Nexus line-ups (empty, 1-3 operators, or two shifts) and, for each, fills the rooms one operator at a time where that adds the most, then moves and swaps operators and tries every Shift A length, with or without Shift B, until nothing improves. Fixed operators stay where they are.</li>
          <li>Values are rounded to 3 decimals and trailing zeros are dropped.</li>
        </ul>
      </div>
    </div>`;
}
