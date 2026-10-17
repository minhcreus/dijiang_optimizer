// UI helpers and views, rendered to strings in plain Node (no DOM needed).
// @ts-ignore -- this repo has no @types/node; node:test is untyped here
import { describe, test } from "node:test";
// @ts-ignore -- as above
import assert from "node:assert/strict";
import * as dc from "../src/core/index.ts";
import type { Profile } from "../src/core/index.ts";
import { createStore } from "../src/storage.ts";
import { nameFromFile } from "../src/ui/files.ts";
import { normalizeProfile, sanitizeProfile } from "../src/ui/guard.ts";
import { esc, failedArt, img } from "../src/ui/html.ts";
import { S, initState, uiFromPrefs } from "../src/ui/state.ts";
import { nowMinute, relTime, utcLabel } from "../src/ui/time.ts";
import { saveInfo } from "../src/ui/views/appbar.ts";
import { barOf, draftOf, overviewView, sameBar, scheduler } from "../src/ui/views/overview.ts";
import { pickerView } from "../src/ui/views/picker.ts";
import { rosterCards, rosterView } from "../src/ui/views/roster.ts";
import { settingsView } from "../src/ui/views/settings.ts";

const normalize = normalizeProfile;
const XSS = '<img src=x onerror="alert(1)">';

function busyProfile(): Profile {
  let p = dc.defaultProfile();
  const rs = p.dijiangPlanner.roomSettings;
  rs["MFG-I"] = { item: "Arms_INSP_Set", shift: { ...dc.defaultShiftSettings(), enabled: true, p: 360, q: 1080 } };
  rs["MFG-II"] = { item: "Advanced_Combat_Record" };
  rs.GC = { items: ["Kalkodendra", null, "Pink_Bolete"] };
  p = dc.syncSlots(p);
  p.dijiangPlanner.operatorSkills.akekuri = [1, null];
  p.operators.alesh = { disabled: true };
  const available = Object.keys(dc.OPS).filter((o) => o !== "alesh");
  p.dijiangPlanner.roomAssignments = dc.optimizeOperators(dc.OPS, p, available);
  return p;
}

function freshState(): void {
  initState(createStore({ defaults: dc.defaultProfile, normalize, storage: null, events: null }), dc.ROOM_IDS);
}

describe("html helpers", () => {
  test("esc escapes markup and quotes", () => {
    assert.equal(esc(`a<b>&"c"'`), "a&lt;b&gt;&amp;&quot;c&quot;&#39;");
    assert.equal(esc(3), "3");
  });
  test("img is lazy, async and sized like its CSS class", () => {
    const html = img("base_icons", "MFG-mood drain", "bi", 'x"y');
    assert.match(html, /src="https:\/\/raw\.githubusercontent\.com\/.+\/base_icons\/MFG-mood%20drain\.png"/);
    assert.match(html, /width="20" height="20" loading="lazy" decoding="async"/);
    assert.match(html, /alt="x&quot;y"/);
    assert.match(img("operators", "ember", "slot-img"), /width="76" height="90"/);
  });
  test("art that failed to load is drawn from the fallback, then hidden, so re-rendered markup matches the page", () => {
    const local = "assets/operators/ember.webp";
    const remote = "https://raw.githubusercontent.com/eldritchtools/endfield-assets/main/assets/operators/ember.png";
    const src = () => img("operators", "ember", "oc-img").match(/src="[^"]*"( data-fallback="[^"]*")?( style="[^"]*")?/)?.[0];
    assert.equal(src(), `src="${local}" data-fallback="${remote}"`);
    failedArt.add(local);
    assert.equal(src(), `src="${remote}"`);
    failedArt.add(remote);
    assert.equal(src(), `src="${remote}" style="visibility:hidden"`);
    failedArt.clear();
  });
  test("nameFromFile", () => {
    assert.equal(nameFromFile("dijiang-main-2026-10-15.json"), "Main");
    assert.equal(nameFromFile("dijiang-alt-plan-2026-01-02.json"), "Alt plan");
    assert.equal(nameFromFile("dijiang-all-profiles-2026-10-15.json"), undefined);
    assert.equal(nameFromFile("my_export.json"), "My export");
    assert.equal(nameFromFile(".json"), undefined);
    // a second download of the same export, or a copy made in a file manager
    for (const f of ["dijiang-main-2026-10-15 (1).json", "dijiang-main-2026-10-15(2).json", "dijiang-main-2026-10-15-1.json",
      "dijiang-main-2026-10-15 - Copy.json", "dijiang-main-2026-10-15 copy 2.json"]) assert.equal(nameFromFile(f), "Main", f);
    assert.equal(nameFromFile("dijiang-all-profiles-2026-10-15 (1).json"), undefined);
    assert.equal(nameFromFile("plan (1).json"), "Plan (1)"); // no date stamp: the name is kept as it is
  });
});

describe("time", () => {
  test("server clock minute and label", () => {
    const t = Date.UTC(2026, 9, 15, 19, 19, 52);
    assert.equal(nowMinute(8, t), 3 * 60 + 19);
    assert.equal(nowMinute(-5, t), 14 * 60 + 19);
    assert.equal(utcLabel(8), "UTC+8");
    assert.equal(utcLabel(0), "UTC+0");
    assert.equal(utcLabel(-5), "UTC-5");
  });
  test("relTime", () => {
    const now = Date.UTC(2026, 9, 15, 12);
    assert.equal(relTime(now - 10_000, now), "just now");
    assert.equal(relTime(now - 90_000, now), "1 min ago");
    assert.equal(relTime(now - 3_599_000, now), "59 min ago");
    assert.equal(relTime(now - 5 * 3_600_000, now), "5 h ago");
    assert.match(relTime(now - 3 * 86_400_000, now), /^2026-10-1\d$/);
  });
});

describe("sanitizeProfile", () => {
  test("valid profiles come back unchanged", () => {
    for (const p of [dc.syncSlots(dc.defaultProfile()), busyProfile()]) {
      const before = JSON.stringify(p);
      assert.equal(JSON.stringify(sanitizeProfile(structuredClone(p))), before);
    }
  });
  test("repairs data the planner cannot use", () => {
    const raw = {
      dijiangPlanner: {
        roomAssignments: {
          CN: [{ id: XSS, fixed: true }, { id: "ember", fixed: true }],
          "MFG-I": [null, null, null, { id: "snowshine", fixed: true }],
          "MFG-II": "nope",
        },
        roomSettings: {
          "MFG-I": { item: "Future_Item", shift: { enabled: true, p: "x", q: 99999, inner: "C" } },
          GC: { items: ["Kalkodendra", "Nope"] },
          RR: 5,
        },
        operatorSkills: { ember: [7, 1, 2], akekuri: "x", arclight: [null, 0] },
        settings: { defaultLevels: [5], utcOffset: "8" },
      },
      operators: { ember: "yes", alesh: { disabled: true } },
    };
    const p = normalize(raw);
    const dp = p.dijiangPlanner;
    assert.deepEqual(dp.roomAssignments.CN, [null, { id: "ember", fixed: true }, null]);
    assert.deepEqual(dp.roomAssignments["MFG-I"], [null, null, null]);
    assert.deepEqual(dp.roomAssignments["MFG-II"], [null, null, null]);
    assert.equal(dp.roomSettings["MFG-I"].item, null);
    assert.deepEqual(dp.roomSettings["MFG-I"].shift, { enabled: true, p: 0, q: 720 });
    assert.deepEqual(dp.roomSettings.GC.items, ["Kalkodendra", null, null]);
    assert.equal("RR" in dp.roomSettings, false);
    assert.deepEqual(dp.operatorSkills, { ember: [null, 1], arclight: [null, 0] });
    assert.deepEqual(dp.settings.defaultLevels, [2, 2]);
    assert.equal(dp.settings.utcOffset, 8);
    assert.deepEqual(p.operators, { alesh: { disabled: true } });
    // the repaired profile works with the planner core
    dc.computeProductivity(dc.OPS, p);
    dc.optimizeOperators(dc.OPS, p, Object.keys(dc.OPS));
  });
  test("shift handles snap to whole hours like the bar, and each shift keeps at least an hour", () => {
    const shiftOf = (p: unknown, q: unknown) =>
      normalize({ dijiangPlanner: { roomSettings: { "MFG-I": { shift: { enabled: true, p, q } } } } }).dijiangPlanner.roomSettings["MFG-I"].shift;
    assert.deepEqual(shiftOf(0, 1440), { enabled: true, p: 0, q: 1380 });
    assert.deepEqual(shiftOf(30, 90.5), { enabled: true, p: 0, q: 120 });
    assert.deepEqual(shiftOf(450, 1110), { enabled: true, p: 480, q: 1080 });
    assert.deepEqual(shiftOf(10, 20), { enabled: true, p: 0, q: 720 });
    assert.deepEqual(shiftOf(-60, 600), { enabled: true, p: 0, q: 720 });
    // the other shift never gets the whole day too
    const w = dc.shiftWindows({ ...dc.defaultShiftSettings(), ...shiftOf(0, 1440) });
    assert.equal(dc.windowLength(w.A) + dc.windowLength(w.B), 1440);
  });
});

describe("normalizeProfile", () => {
  test("sections of the wrong type count as missing, so later edits are saved", () => {
    const cases: unknown[] = [
      { latestVersion: "1.6", dijiangPlanner: [] },
      { dijiangPlanner: null },
      { dijiangPlanner: "x" },
      { dijiangPlanner: { roomAssignments: [], roomSettings: [], operatorSkills: "x", settings: [] }, operators: [] },
      { dijiangPlanner: { roomAssignments: "x", settings: null } },
    ];
    for (const raw of cases) {
      const before = JSON.stringify(raw);
      const p = normalize(raw);
      assert.equal(JSON.stringify(raw), before); // input untouched
      // a JSON round trip (what the store saves) keeps everything
      assert.deepEqual(JSON.parse(JSON.stringify(p)), dc.syncSlots(dc.defaultProfile()), JSON.stringify(raw));
    }
    const p = normalize({ dijiangPlanner: { settings: [], roomSettings: { RR: { firstPrio: 1 } } } });
    p.dijiangPlanner.settings.prio = "MFG & GC > RR";
    assert.equal(JSON.parse(JSON.stringify(p)).dijiangPlanner.settings.prio, "MFG & GC > RR");
  });
  test("values the views and the core read differently are made consistent", () => {
    const raw = {
      dijiangPlanner: {
        roomAssignments: { GC: [{ id: "akekuri", fixed: {} }, { id: "ember", fixed: "yes" }, null] },
        roomSettings: {
          GC: { items: null },
          "MFG-I": { shift: { enabled: {}, autoRotate: [] } },
          "MFG-II": { shift: { enabled: [1], autoRotate: 0, p: 120 } },
          CN: { firstPrio: {}, shift: { enabled: 1, p: 0, q: 1440 } },
        },
        settings: { cnModel: "sometimes" },
      },
      operators: { alesh: { disabled: {} }, ember: { disabled: "y" } },
    };
    const p = normalize(raw);
    const dp = p.dijiangPlanner;
    assert.equal(Object.hasOwn(dp.settings, "cnModel"), false); // unknown model: the default (game) applies
    assert.equal(dc.cnModel(p), "game");
    assert.deepEqual(dp.roomSettings.CN.shift, { enabled: true, p: 0, q: 1380 });
    assert.deepEqual(dp.roomSettings.GC.items, [null, null, null]);
    assert.deepEqual(dp.roomSettings["MFG-I"].shift, { enabled: false, autoRotate: false });
    assert.deepEqual(dp.roomSettings["MFG-II"].shift, { enabled: true, autoRotate: false, p: 120 }); // q defaults to 720
    assert.equal(dp.roomSettings.CN.firstPrio, false);
    assert.deepEqual(dp.roomAssignments.GC, [{ id: "akekuri", fixed: false }, { id: "ember", fixed: true }, null]);
    assert.deepEqual(p.operators, { alesh: { disabled: false }, ember: { disabled: true } });
    assert.deepEqual(dc.assignmentSlots(p), ["CN", "CN#B", "MFG-I", "MFG-II", "MFG-II#B", "GC", "RR"]);
    // every view renders it
    freshState();
    S.profile = p;
    S.rev++;
    for (const room of dc.ROOM_IDS) {
      S.room = room;
      assert.ok(overviewView().includes("detail"));
    }
    assert.ok(rosterView().includes("oc-grid"));
    assert.ok(settingsView().includes("PROFILES"));
  });
  test("values that are not profiles at all raise", () => {
    assert.throws(() => normalize(5));
    assert.deepEqual(normalize({}), dc.syncSlots(dc.defaultProfile()));
  });
});

describe("state and appbar", () => {
  test("uiFromPrefs falls back for unknown values", () => {
    assert.deepEqual(uiFromPrefs({ tab: "roster", room: "GC", filterRoom: "RR", filterStatus: "free" }, dc.ROOM_IDS),
      { tab: "roster", room: "GC", filterRoom: "RR", filterStatus: "free" });
    assert.deepEqual(uiFromPrefs({ tab: "x", room: "MFG-III", filterRoom: "y", filterStatus: "z" }, dc.ROOM_IDS),
      { tab: "overview", room: "MFG-I", filterRoom: "ALL", filterStatus: "all" });
  });
  test("save indicator states", () => {
    assert.deepEqual(saveInfo({ state: "saved", at: null }).slice(0, 3), ["ok", "Saved", ""]);
    assert.equal(saveInfo({ state: "pending", at: 1 })[1], "Saving…");
    assert.deepEqual(saveInfo({ state: "unavailable", at: null, message: "blocked" }).slice(1), ["Not saved", "storage blocked", "blocked"]);
    assert.equal(saveInfo({ state: "error", at: 1, message: "Browser storage is full, so ..." })[2], "storage full");
    assert.equal(saveInfo({ state: "error", at: 1, message: "Could not save (SecurityError)." })[2], "write failed");
    assert.equal(saveInfo({ state: "error", at: 1, message: "The saved data is from a newer version of the planner, ..." })[2], "newer version");
    assert.equal(saveInfo({ state: "saved", at: 1, message: "recovered" })[0], "notice");
  });
  test("sameBar compares only the bar fields", () => {
    const a = dc.defaultShiftSettings();
    const other: dc.ShiftSettings = { ...a, active: "B", autoRotate: false };
    assert.equal(sameBar(a, other), true);
    assert.equal(sameBar(a, { ...a, q: 780 }), false);
    assert.equal(sameBar(a, dc.swapShift(a)), false);
  });
});

describe("views", () => {
  test("overview renders the deck, the detail and the shift screen", () => {
    freshState();
    S.profile = busyProfile();
    S.rev++;
    const html = overviewView();
    for (const cls of ["kpis", "tile tile-CN", "tile tile-MFG sel", "detail room-MFG", "shift-grid", "shift shift-A", "sched", "handle", "now-label", "results"]) {
      assert.ok(html.includes(cls), cls);
    }
    assert.match(html, /<button class="confirm" data-act="shift-confirm" data-room="MFG-I" disabled/);
    // a pending draft enables Confirm
    const sh = dc.getShiftSettings(S.profile, "MFG-I");
    S.drafts["MFG-I"] = barOf(dc.dragHandle(sh, "q", 1200));
    assert.doesNotMatch(scheduler("MFG-I", sh), /data-act="shift-confirm" data-room="MFG-I" disabled/);
    assert.match(overviewView(), /class="win stack" id="win-MFG-I-A"/);
    // a draft holds only the bar: settings changed since (e.g. Activate Shift) show through
    S.profile.dijiangPlanner.roomSettings["MFG-I"].shift!.active = "B";
    assert.deepEqual(draftOf("MFG-I"), { ...sh, active: "B", q: 1200 });
    // without auto-rotate there is no bar or Confirm, so a leftover draft is not shown
    S.profile.dijiangPlanner.roomSettings["MFG-I"].shift!.autoRotate = false;
    S.rev++;
    assert.doesNotMatch(overviewView(), /class="win stack"/);
  });

  test("roster filters and picker order", () => {
    freshState();
    S.profile = busyProfile();
    S.rev++;
    assert.match(rosterView(), /id="oc-grid"/);
    S.search = "akek";
    assert.equal((rosterCards().match(/class="oc oc-/g) ?? []).length, 1);
    S.search = "zzzz";
    assert.match(rosterCards(), /No operators match/);
    S.search = "";
    S.filterStatus = "disabled";
    assert.equal((rosterCards().match(/class="oc oc-disabled"/g) ?? []).length, 1);
    S.filterStatus = "all";
    S.picker = { kind: "op", slot: "GC", i: 0 };
    const fits = [...pickerView().matchAll(/class="pick( fits)?"/g)].map((m) => Boolean(m[1]));
    assert.ok(fits.length > 0 && fits.indexOf(false) > 0 && !fits.slice(fits.indexOf(false)).includes(true));
  });

  test("names from imported profiles are escaped", () => {
    freshState();
    const dump = JSON.stringify({
      version: 2, active: "a", order: ["a"],
      profiles: { a: { meta: { name: XSS }, data: { dijiangPlanner: { roomAssignments: { CN: [{ id: XSS, fixed: true }, null, null] } } } } },
    });
    S.store.importProfile(dump);
    S.profile = S.store.load();
    S.profileId = S.store.activeId();
    S.rev++;
    const html = settingsView() + overviewView() + rosterView();
    assert.ok(!html.includes("<img src=x"), "no raw markup");
    assert.ok(settingsView().includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
    assert.equal(S.profile.dijiangPlanner.roomAssignments.CN[0], null);
  });
});
