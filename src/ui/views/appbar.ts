// App bar: brand, tabs, save indicator and the global actions.
import type { SaveStatus } from "../../storage.ts";
import { esc, tip } from "../html.ts";
import { S, TABS } from "../state.ts";
import { clockTime } from "../time.ts";

/** [css state, label, short reason, tooltip] for the save indicator. */
export function saveInfo(st: SaveStatus): [string, string, string, string] {
  const note = st.message ? `\n\n${st.message}` : "";
  switch (st.state) {
    case "pending":
      return ["pending", "Saving…", "", "Your changes are being saved in this browser."];
    case "unavailable":
      return ["bad", "Not saved", "storage blocked", st.message ?? "Browser storage is blocked here, so changes last only until this tab closes."];
    case "error": {
      const msg = st.message ?? "";
      const why = /full/i.test(msg) ? "storage full" : /newer version/i.test(msg) ? "newer version" : "write failed";
      return ["bad", "Not saved", why, st.message ?? "Could not save to browser storage."];
    }
    default: {
      const when = st.at === null ? "" : ` at ${clockTime(st.at)}`;
      return [st.message ? "notice" : "ok", "Saved", "", `All changes are saved in this browser${when}.${note}`];
    }
  }
}

export function saveBadge(): string {
  const st = S.store.status();
  const [cls, label, why, t] = saveInfo(S.notice && st.state === "saved" ? { ...st, message: S.notice } : st);
  const reason = why ? `<span class="save-why">: ${esc(why)}</span>` : "";
  return `<span id="save-state" class="save-state ${cls}" role="status" ${tip(t)}><i></i><span>${esc(label)}${reason}</span></span>`;
}

export function tabsHtml(): string {
  return TABS.map(([k, l]) => `<button class="tab${S.tab === k ? " on" : ""}" data-act="tab" data-val="${k}">${l}</button>`).join("");
}

export function appBar(): string {
  return `<header class="appbar">
      <div class="brand"><span class="brand-mark"></span><div><b>DIJIANG</b><i>OPTIMIZER</i></div></div>
      <nav class="tabs" id="tabs">${tabsHtml()}</nav>
      <div class="appbar-actions">
        ${saveBadge()}
        <button class="ghost" data-act="clear" data-all="0" ${tip("Remove optimizer picks, keep operators you fixed")}>Clear</button>
        <button class="ghost" data-act="clear" data-all="1" ${tip("Empty every slot, fixed ones too")}>Clear all</button>
        <button class="primary" data-act="optimize" ${tip("Plan the ship for your available operators: who works where, each room's Shift A/B hours and how many Control Nexus operators are worth it. Fixed operators stay where they are. Settings > Shift hours can keep your own hours.")}>▶ OPTIMIZE</button>
      </div>
    </header>`;
}
