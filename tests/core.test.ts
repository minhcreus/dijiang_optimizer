// Port of the legacy tests/test_core.py (expectations come from the in-game
// MFG Cabin shift screen), plus checks for the Python-vs-JS number traps.
// @ts-ignore -- this repo has no @types/node; node:test is untyped here
import { describe, test } from "node:test";
// @ts-ignore -- as above
import assert from "node:assert/strict";
import * as dc from "../src/core/index.ts";
import * as ship_ from "../src/core/ship.ts";
import { pyRound, pySum } from "../src/core/py.ts";
import type { Profile, Window } from "../src/core/index.ts";

const ops = dc.OPS;
const op = (id: string) => ({ id, fixed: true });

function screenshotProfile(): Profile {
  let p = dc.defaultProfile();
  p.dijiangPlanner.roomSettings["MFG-I"] = {
    item: "Advanced_Combat_Record",
    shift: { ...dc.defaultShiftSettings(), enabled: true, p: 360, q: 1080 },
  };
  p = dc.syncSlots(p);
  const dp = p.dijiangPlanner;
  dp.roomAssignments["MFG-I"] = [op("snowshine"), op("laevatain"), op("ember")];
  dp.roomAssignments["MFG-I#B"] = [op("zhuang-fangyi"), op("wulfgard"), op("xaihi")];
  dp.operatorSkills["snowshine"] = [1, null];
  return p;
}

describe("screenshot", () => {
  const p = screenshotProfile();
  const res = dc.computeProductivity(ops, p)["MFG-I"];

  test("work time matches game", () => {
    assert.equal(res.shifts!.A.workTimeLabel, "19h 17min");
    assert.equal(res.shifts!.B.workTimeLabel, "16h 56min");
  });

  test("mood drop per hour", () => {
    assert.equal(dc.fmt3(res.shifts!.B.moodDropPerHour), "5.904");
  });

  test("efficiency matches game", () => {
    assert.equal(dc.fmt3(res.shifts!.B.multipliers.efficiency), "3.74");
    assert.equal(dc.fmt3(dc.productionMultiplier(3, 0)), "2.2");
  });

  test("windows and warning", () => {
    let w = dc.shiftWindows(dc.getShiftSettings(p, "MFG-I"));
    assert.equal(dc.windowLabel(w.A), "06:00 - 18:00");
    assert.equal(dc.windowLabel(w.B), "18:00 - 06:00");
    assert.equal(res.shifts!.A.covers, true);
    // second screenshot: A 00:00-23:00 -> warning on A only
    const sh = { ...dc.defaultShiftSettings(), enabled: true, p: 0, q: 1380 };
    const p2 = structuredClone(p);
    p2.dijiangPlanner.roomSettings["MFG-I"].shift = sh;
    const res2 = dc.computeProductivity(ops, p2)["MFG-I"];
    w = dc.shiftWindows(sh);
    assert.equal(dc.windowLabel(w.A), "00:00 - 23:00");
    assert.equal(dc.windowLabel(w.B), "23:00 - 00:00");
    assert.equal(res2.shifts!.A.covers, false);
    assert.equal(res2.shifts!.B.covers, true);
    assert.ok(res2.shifts!.A.halted! > 0);
  });
});

describe("shift bar", () => {
  test("reset, swap, drag", () => {
    const sh = dc.defaultShiftSettings();
    const w = dc.shiftWindows(sh);
    assert.deepEqual([w.A, w.B], [[0, 720], [720, 1440]]);
    const sw = dc.shiftWindows(dc.swapShift(sh));
    assert.deepEqual([sw.A, sw.B], [[720, 1440], [0, 720]]);
    let d = dc.dragHandle(sh, "q", 1000);
    assert.equal(d.q, 1020); // snapped to the hour
    d = dc.dragHandle(sh, "p", 900); // cannot pass q
    assert.equal(d.p, 660);
    assert.deepEqual(dc.resetShift(dc.swapShift(d)), { ...sh });
  });

  test("lengths sum to day", () => {
    const w = dc.shiftWindows({ ...dc.defaultShiftSettings(), p: 360, q: 1080 });
    assert.equal(dc.windowLength(w.A) + dc.windowLength(w.B), 1440);
  });

  test("drag rounds half hours to the even hour like Python round()", () => {
    const sh = dc.defaultShiftSettings();
    assert.equal(dc.dragHandle(sh, "q", 1050).q, 1080); // 17.5h -> 18h
    assert.equal(dc.dragHandle(sh, "q", 990).q, 960); // 16.5h -> 16h
    assert.equal(dc.dragHandle(sh, "p", 90).p, 120); // 1.5h -> 2h
    assert.equal(dc.dragHandle(sh, "p", 150).p, 120); // 2.5h -> 2h
    assert.equal(dc.dragHandle(sh, "p", 30).p, 0); // 0.5h -> 0h
    assert.equal(dc.dragHandle(sh, "q", 1439.9).q, 1380); // A cannot cover the whole day
    assert.equal(dc.dragHandle(sh, "p", -45).p, 0);
    assert.deepEqual([pyRound(0.5), pyRound(1.5), pyRound(2.5), pyRound(-0.5), pyRound(-1.5), pyRound(2.4999)], [0, 2, 2, 0, -2, 2]);
  });
});

describe("levels", () => {
  test("default overrides individual", () => {
    let p = dc.defaultProfile();
    p = dc.setSkillLevel(p, "akekuri", 0, 1);
    p = dc.setSkillLevel(p, "akekuri", 1, 0);
    assert.equal(dc.skillLevel(p, "akekuri", 0), 1);
    p = dc.setDefaultLevel(p, 0, 2);
    assert.equal(dc.skillLevel(p, "akekuri", 0), 2); // follows the new default
    assert.equal(dc.skillLevel(p, "akekuri", 1), 0); // other skill untouched
  });

  test("level setters do not mutate their input", () => {
    const p = dc.defaultProfile();
    const before = structuredClone(p);
    dc.setDefaultLevel(dc.setSkillLevel(p, "akekuri", 0, 1), 1, 0);
    dc.setSkillLevel(p, "akekuri", 0, 1);
    dc.syncSlots(p);
    dc.migrateProfile(p);
    assert.deepEqual(p, before);
  });
});

describe("corrupt input raises where Python raises", () => {
  // The app repairs these before the core sees them (ui/guard.ts); the core stays a faithful port.
  test("migrateProfile", () => {
    for (const raw of [null, 0, false, "", [], {}, "x", [1, 2], { foo: 1 }]) assert.deepEqual(dc.migrateProfile(raw), dc.defaultProfile());
    for (const raw of [1, -3, 2.5, true, "has dijiangPlanner inside", ["dijiangPlanner"]]) assert.throws(() => dc.migrateProfile(raw), TypeError);
    // dict.setdefault on a list or None
    for (const dp of [[], null, "x", 5]) assert.throws(() => dc.migrateProfile({ dijiangPlanner: dp }), TypeError);
    assert.throws(() => dc.migrateProfile({ dijiangPlanner: { roomAssignments: [] } }), TypeError);
    assert.throws(() => dc.migrateProfile({ dijiangPlanner: { settings: [] } }), TypeError);
  });
  test("shift settings: dict.get / dict.update", () => {
    const withRs = (roomSettings: unknown) => ({ dijiangPlanner: { roomSettings } }) as unknown as Profile;
    assert.throws(() => dc.getShiftSettings(withRs([]), "GC"), TypeError);
    assert.throws(() => dc.getShiftSettings(withRs({ GC: [] }), "GC"), TypeError);
    assert.throws(() => dc.getShiftSettings(withRs({ GC: { shift: null } }), "GC"), TypeError);
    assert.throws(() => dc.getShiftSettings(withRs({ GC: { shift: 5 } }), "GC"), TypeError);
    assert.throws(() => dc.getShiftSettings(withRs({ GC: { shift: "abc" } }), "GC"), RangeError);
    assert.equal(dc.getShiftSettings(withRs({ GC: { shift: [["p", 60]] } }), "GC").p, 60); // pairs, like dict.update
    assert.deepEqual(dc.getShiftSettings(withRs({ GC: { shift: [] } }), "GC"), dc.defaultShiftSettings());
    assert.deepEqual(dc.getShiftSettings(withRs({ GC: { shift: { p: 60, zz: 1 } } }), "GC"), { ...dc.defaultShiftSettings(), p: 60, zz: 1 });
  });
  test("skill levels: False is 0, True is 1, other types raise", () => {
    const sk = dc.OPS.akekuri.baseSkills[0];
    const withLevels = (lv: unknown[]) => {
      const p = dc.defaultProfile();
      (p.dijiangPlanner.operatorSkills as Record<string, unknown>).akekuri = lv;
      return p;
    };
    assert.equal(dc.skillValue(withLevels([false, null]), "akekuri", 0, sk), 0);
    assert.equal(dc.skillValue(withLevels([true, null]), "akekuri", 0, sk), sk.values[0]);
    assert.equal(dc.skillValue(withLevels([1, null]), "akekuri", 0, sk), sk.values[0]);
    assert.throws(() => dc.skillValue(withLevels(["1", null]), "akekuri", 0, sk), TypeError);
    assert.throws(() => dc.skillValue(withLevels([1.5, null]), "akekuri", 0, sk));
    const p = dc.defaultProfile();
    (p.dijiangPlanner.operatorSkills as Record<string, unknown>).akekuri = 5; // 5[i]
    assert.throws(() => dc.skillLevel(p, "akekuri", 0), TypeError);
  });
  test("slot entries that are not operator dicts", () => {
    const withSlot = (entry: unknown) => {
      const p = dc.defaultProfile();
      (p.dijiangPlanner.roomAssignments as Record<string, unknown[]>)["MFG-I"] = [entry, null, null];
      return p;
    };
    // op.get("fixed") on a str / int / list: AttributeError ("akekuri".fixed is a String method in JS)
    for (const e of ["akekuri", 5, ["akekuri"], true]) assert.throws(() => dc.optimizeOperators(ops, withSlot(e), []), TypeError);
    // op["id"]: TypeError on a non-dict, KeyError on a dict without "id"
    for (const e of ["akekuri", 5, ["akekuri"]]) assert.throws(() => dc.usedOperatorIds(withSlot(e)), TypeError);
    assert.throws(() => dc.usedOperatorIds(withSlot({ fixed: true })), /KeyError/);
    assert.deepEqual([...dc.usedOperatorIds(withSlot(op("akekuri")))], ["akekuri"]);
  });
  test("round() of NaN or an infinity", () => {
    for (const x of [NaN, Infinity, -Infinity]) {
      assert.throws(() => pyRound(x), RangeError);
      assert.throws(() => dc.dragHandle(dc.defaultShiftSettings(), "p", x), RangeError);
    }
    assert.equal(dc.dragHandle({ ...dc.defaultShiftSettings(), p: 360, q: 1080 }, "q", 1e300).q, 1440);
  });
});

describe("number format", () => {
  test("legacy cases", () => {
    assert.equal(dc.pct3(3.74), "374%");
    assert.equal(dc.pct3(0.625), "62.5%");
    assert.equal(dc.fmt3(5.9036), "5.904");
    assert.equal(dc.fmt3(4050.0), "4050");
  });

  test("exact ties round half to even like Python, not up like toFixed", () => {
    assert.equal((0.0625).toFixed(3), "0.063"); // the JS trap
    assert.equal(dc.fmt3(0.0625), "0.062");
    assert.equal(dc.fmt3(0.1875), "0.188");
    assert.equal(dc.fmt3(0.3125), "0.312");
    assert.equal(dc.fmt3(-0.0625), "-0.062");
    assert.equal(dc.fmt3(12.3125), "12.312");
    assert.equal(dc.fmt3(1234.5625), "1234.562");
    assert.equal(dc.pct3(0.000625), "0.062%");
    assert.equal(dc.formatFixed(0.03125, 4), "0.0312");
    assert.equal(dc.formatFixed(0.09375, 4), "0.0938");
  });

  test("non-ties round on the exact binary value", () => {
    assert.equal(dc.fmt3(2.0005), "2.001");
    assert.equal(dc.fmt3(1.0005), "1");
    assert.equal(dc.fmt3(0.0025), "0.003");
    assert.equal(dc.fmt3(-0.0), "0");
    assert.equal(dc.fmt3(-0.0001), "0");
    assert.equal(dc.formatFixed(-0.0, 4), "-0.0000");
    assert.equal(dc.fmt3(1e21), "1000000000000000000000");
    assert.equal(dc.pct3(1.5e22), "1499999999999999974834176%");
  });

  test("time formats floor like Python // and %", () => {
    assert.equal(dc.secondsToHms(50000), "13:53:20");
    assert.equal(dc.secondsToHms(-1.5), "-1:59:58");
    assert.equal(dc.secondsToHms(1e20), "27777777777777777:46:40");
    assert.equal(dc.secondsToHmin(50000 / 0.72), "19h 17min");
    // float noise just under a whole second does not lose that second: 35200 / 2.2 is 16000 s
    assert.equal(35200 / 2.2 < 16000, true);
    assert.equal(dc.secondsToHms(35200 / 2.2), "04:26:40");
    assert.equal(dc.minutesToClock(-61), "-2:59");
    assert.equal(dc.minutesToClock(1380), "23:00");
  });

  test("float sum is compensated like CPython 3.12+", () => {
    assert.equal(pySum([1e16, 1.0, -1e16]), 1.0);
    assert.equal(pySum(Array(10).fill(0.1)), 1.0);
  });
});

describe("original model", () => {
  test("empty profile", () => {
    const res = dc.computeProductivity(ops, dc.defaultProfile());
    assert.equal(res["MFG-I"].workTime, "13:53:20");
    assert.equal(res["MFG-I"].operatorUptime, "62.5%");
    assert.equal(res.CN.globalBreakTime, "08:20:00");
  });

  test("optimizer fills rooms", () => {
    const p = dc.defaultProfile();
    p.dijiangPlanner.roomSettings = {
      "MFG-I": { item: "Advanced_Combat_Record" },
      "MFG-II": { item: "Arms_INSP_Set" },
      GC: { items: ["Kalkonyx", "Pink_Bolete", "Kalkodendra"] },
    };
    const a = dc.optimizeOperators(ops, p, Object.keys(ops));
    const used = Object.values(a).flatMap((s) => s.filter((o) => o !== null).map((o) => o.id));
    assert.equal(used.length, new Set(used).size);
    assert.equal(used.length, 15);
    p.dijiangPlanner.roomAssignments = a;
    const res = dc.computeProductivity(ops, p);
    assert.ok("xpPerHour" in res["MFG-I"]);
  });

  test("optimizer with shift B", () => {
    let p = dc.defaultProfile();
    p.dijiangPlanner.roomSettings = {
      "MFG-I": { item: "Advanced_Combat_Record", shift: { ...dc.defaultShiftSettings(), enabled: true } },
    };
    p = dc.syncSlots(p);
    const a = dc.optimizeOperators(ops, p, Object.keys(ops));
    assert.ok("MFG-I#B" in a);
    assert.ok(a["MFG-I#B"].every((o) => o));
  });
});

describe("shift simulation", () => {
  // Independent reference in exact integers: every skill value is a whole percent, so with
  // MAX = 15,000,000 Mood units a working minute costs 180 * (100 - drain%) and a resting
  // minute gives 300 * (100 + regen%). No float drift, so a repeated day-start state is exact.
  const MAX = 15_000_000;
  function exactAverage(win: Window, drainPct: number, regenPct: number): { avg: number; period: number; need: number; halted: [number, number][] } {
    const drop = 180 * (100 - drainPct);
    const regen = 300 * (100 + regenPct);
    let mood = MAX;
    let resting = false;
    const seen = new Map<string, number>();
    const worked: number[] = [];
    const haltedOn: [number, number][][] = [];
    for (let day = 0; day < 2000; day++) {
      const key = `${mood}:${resting}`;
      const k = seen.get(key);
      if (k !== undefined) {
        const cycle = worked.slice(k);
        return { avg: cycle.reduce((a, b) => a + b, 0) / cycle.length, period: cycle.length, need: day, halted: haltedOn[k] };
      }
      seen.set(key, day);
      let today = 0;
      const halted: [number, number][] = [];
      for (let m = 0; m < 1440; m++) {
        const on = dc.inWindow(m, win);
        if (on && !resting) {
          today++;
          mood -= drop;
          if (mood <= 0) [mood, resting] = [0, true];
        } else {
          if (on) {
            const last = halted[halted.length - 1];
            if (last && last[1] === m) last[1] = m + 1;
            else halted.push([m, m + 1]);
          }
          mood = Math.min(MAX, mood + regen);
          if (resting && mood === MAX) resting = false;
        }
      }
      worked.push(today);
      haltedOn.push(halted);
    }
    throw new Error("no cycle in 2000 days");
  }

  const groupsFor = (drainA: number, drainB: number) => ({
    A: { n: 3, work: 50000 / (1 - drainA / 100), mult: { efficiency: 2 } },
    B: { n: 2, work: 50000 / (1 - drainB / 100), mult: { efficiency: 1.5 } },
  });

  test("averages the repeating days and matches an exact integer simulation", () => {
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let multiDay = 0;
    for (let k = 0; k < 400; k++) {
      const p = 60 * Math.floor(rand() * 24);
      const q = 60 * (p / 60 + 1 + Math.floor(rand() * (24 - p / 60)));
      if (p === 0 && q === 1440) continue;
      const sh = { ...dc.defaultShiftSettings(), p, q, inner: rand() < 0.5 ? "A" as const : "B" as const };
      const windows = dc.shiftWindows(sh);
      const [drainA, drainB] = [Math.floor(rand() * 60), Math.floor(rand() * 60)];
      const regenPct = Math.floor(rand() * 90);
      const [, stats] = dc.simulateShifts(groupsFor(drainA, drainB), windows, 30000 / (1 + regenPct / 100));
      for (const [s, drain] of [["A", drainA], ["B", drainB]] as const) {
        const ref = exactAverage(windows[s], drain, regenPct);
        const ctx = JSON.stringify({ sh, drain, regenPct, s, period: ref.period });
        // exact whenever the cycle fits in the 240 simulated days; rare longer ones within 2 min a day
        const tol = ref.need < 240 ? 1e-9 : 2;
        assert.ok(Math.abs(stats[s].worked - ref.avg) < tol, `${ctx}: ${stats[s].worked} vs ${ref.avg}`);
        assert.ok(Math.abs(stats[s].halted - (stats[s].scheduled - stats[s].worked)) < 1e-9, ctx);
        if (ref.need >= 240) continue;
        if (ref.period === 1) assert.deepEqual(stats[s].haltedSpans ?? [], ref.halted, ctx);
        else {
          multiDay++;
          assert.equal(stats[s].haltedSpans, undefined, ctx);
        }
      }
    }
    assert.ok(multiDay > 0, "the sample should include schedules that alternate days");
  });

  test("a schedule that alternates long and short days shows their average", () => {
    // A 02:00-22:00 with 36% Mood Drop reduction (EST 21h 42min), no Control Nexus regen:
    // it rests 4h a day but needs 7.68h, so it works 20h one day and 12.133h the next.
    const windows = dc.shiftWindows({ p: 120, q: 1320, inner: "A" });
    const [eff, stats] = dc.simulateShifts(groupsFor(36, 0), windows, 30000);
    assert.equal(dc.secondsToHmin(50000 / 0.64), "21h 42min");
    assert.equal(stats.A.worked, (1200 + 728) / 2);
    assert.equal(stats.A.haltedSpans, undefined);
    assert.equal(dc.fmt3(stats.A.worked / 60), "16.067");
    assert.ok(Math.abs(eff.efficiency - (2 * stats.A.worked + 1.5 * stats.B.worked) / 1440) < 1e-12);
  });

  test("halted minutes of a daily pattern", () => {
    // A 00:00-17:00 with no skills (EST 13h 53min) runs out of Mood at 13:54 every day and
    // rests 8h 20min, so it is halted until 17:00 and back at max Mood before midnight
    const windows = dc.shiftWindows({ p: 0, q: 1020, inner: "A" });
    const [, stats] = dc.simulateShifts(groupsFor(0, 18), windows, 30000);
    const ref = exactAverage(windows.A, 0, 0);
    assert.equal(ref.period, 1);
    assert.deepEqual(ref.halted, [[834, 1020]]);
    assert.deepEqual(stats.A.haltedSpans, ref.halted);
    assert.equal(stats.A.halted, 1020 - 834);
  });
});

describe("optimizer fillers", () => {
  test("an operator with nothing to give in its room is marked as a filler, even with a Control Nexus skill", () => {
    const p = dc.defaultProfile();
    p.dijiangPlanner.roomSettings = { "MFG-I": { item: "Advanced_Combat_Record" } };
    const a = dc.optimizeOperators(ops, p, ["lifeng", "liino", "alesh", "avywenna"]);
    const cn = a.CN.filter((o) => o).map((o) => o!.id);
    assert.ok(cn.includes("lifeng") && cn.includes("liino"));
    const placed = Object.entries(a).filter(([slot]) => slot !== "CN").flatMap(([, s]) => s.filter((o) => o));
    assert.equal(placed.length, 1);
    assert.ok(["alesh", "avywenna"].includes(placed[0]!.id));
    assert.equal(placed[0]!.filler, true);
  });
});

describe("Control Nexus that tires (game model)", () => {
  /** Control Nexus with three +16% operators; the Reception Room operators have no skill there */
  function ship(align: string, model?: "game" | "always"): Profile {
    const p = dc.defaultProfile();
    p.dijiangPlanner.settings.align = align;
    if (model) p.dijiangPlanner.settings.cnModel = model;
    p.dijiangPlanner.roomAssignments.CN = [op("da-pan"), op("lifeng"), op("liino")];
    p.dijiangPlanner.roomAssignments.RR = [op("catcher"), op("alesh"), op("avywenna")];
    return p;
  }
  const withCnShifts = (p: Profile, shift: Partial<dc.ShiftSettings> = {}): Profile => {
    p.dijiangPlanner.roomSettings.CN = { shift: { ...dc.defaultShiftSettings(), enabled: true, ...shift } };
    return dc.syncSlots(p);
  };

  test("Always on keeps the original planner's numbers", () => {
    const r = dc.computeProductivity(ops, ship("Staggered", "always"));
    assert.deepEqual(r.CN, { globalBreakTime: "05:37:50", workTime: "13:53:20", moodRegen: "148%" });
    assert.equal(r.RR.operatorUptime, "71.154%");
    assert.equal(r.RR.efficiency, "185.385%");
  });

  test("one aligned team: everyone rests while the Control Nexus team rests", () => {
    // everyone starts together and works 13h 53min, so every rest falls while the Control Nexus team rests too
    const r = dc.computeProductivity(ops, ship("Aligned"));
    assert.deepEqual(r.CN, { globalBreakTime: "08:20:00", workTime: "13:53:20", moodRegen: "130%", teamMoodRegen: "148%", regenUptime: "62.5%" });
    assert.equal(r.RR.operatorUptime, "62.5%");
    assert.equal(r.GC.operatorUptime, "62.5%");
  });

  test("staggered team: regen never stops but averages less than the full team", () => {
    const r = dc.computeProductivity(ops, ship("Staggered"));
    assert.equal(r.CN.regenUptime, "100%");
    // each one rests while the other two work: rest = 30000 s / 1.32, so each works 50000 of every
    // 72727 s (68.75%) and the average is 1 + 0.48 x 0.6875 = 133%
    assert.equal(r.CN.moodRegen, "133%");
    assert.equal(r.CN.globalBreakTime, "06:18:47");
    const up = parseFloat(r.RR.operatorUptime!);
    assert.ok(up > 62.5 && up < 71.154, r.RR.operatorUptime);
  });

  test("two shifts that never run out of Mood match an always-on team", () => {
    const p = withCnShifts(ship("Staggered"));
    p.dijiangPlanner.roomAssignments.CN = [op("da-pan"), op("lifeng"), null];
    p.dijiangPlanner.roomAssignments["CN#B"] = [op("snowshine"), op("fluorite"), null];
    const r = dc.computeProductivity(ops, p);
    const q = ship("Staggered", "always");
    q.dijiangPlanner.roomAssignments.CN = [op("da-pan"), op("lifeng"), null];
    const o = dc.computeProductivity(ops, q);
    assert.equal(r.CN.moodRegen, "132%");
    assert.equal(r.CN.regenUptime, undefined);
    assert.equal(r.CN.globalBreakTime, o.CN.globalBreakTime);
    for (const k of ["operatorUptime", "efficiency", "duration"] as const) assert.equal(r.RR[k], o.RR[k]);
    assert.equal(r.CN.shifts!.A.halted, 0);
    assert.equal(r.CN.shifts!.B.halted, 0);
  });

  test("a Control Nexus shift longer than its work time rests on duty", () => {
    const p = withCnShifts(ship("Staggered"), { p: 0, q: 1200 });
    p.dijiangPlanner.roomAssignments["CN#B"] = [op("snowshine"), null, null];
    const r = dc.computeProductivity(ops, p);
    const { A, B } = r.CN.shifts!;
    // A works 13h 53min of its 20h and is back at max Mood by midnight; the 4h Shift B never tires
    assert.ok(Math.abs(A.worked! - 50000 / 60) < 0.01, String(A.worked));
    assert.deepEqual(A.haltedSpans, [[833, 1200]]);
    assert.equal(B.halted, 0);
    assert.equal(r.CN.regenUptime, dc.pct3((50000 / 60 + 240) / 1440));
  });

  test("a room following R(t) matches one simulated together with the Control Nexus", () => {
    const h = { days: 90, warmDays: 20 };
    const cn = [0, 1, 2].map((i) => ({ n: 1, work: 50000, regen: 0.16, window: null, ...ship_.staggeredStart(i * 24000, 50000, 22000) }));
    const rooms = [
      { n: 3, work: 69444.4, regen: 0, window: null, mood: 1, resting: false },
      { n: 2, work: 60000, regen: 0, window: [300, 1260] as Window, mood: 1, resting: false },
      { n: 1, work: 50000, regen: 0, window: [1260, 300] as Window, mood: 0.4, resting: true },
    ];
    const joint = ship_.runShip([...cn, ...rooms], h);
    const alone = ship_.runShip(cn, h);
    rooms.forEach((u, i) => {
      const f = ship_.followTimeline(u, alone.timeline, h);
      assert.ok(Math.abs(f.worked - joint.worked[3 + i]) < 1e-6 * joint.span, `${i}: ${f.worked} vs ${joint.worked[3 + i]}`);
      assert.deepEqual(f.halted, joint.halted[3 + i]);
    });
  });

  test("rest needed follows the Mood Regen during the rest itself", () => {
    const flat = { t: [0], r: [1.5], c: [0] };
    assert.ok(Math.abs(ship_.recoverTime(flat, 3600, 0.6) - (0.6 * 30000) / 1.5) < 1e-6);
    // R = 2 for the first 4 hours of every day, then 1
    const tl = { t: [] as number[], r: [] as number[], c: [] as number[] };
    for (let d = 0, c = 0; d <= 360; d++) {
      tl.t.push(d * 86400, d * 86400 + 14400);
      tl.r.push(2, 1);
      tl.c.push(c, c + 28800);
      c += 28800 + 72000;
    }
    const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
    near(ship_.recoverTime(tl, 0, 0.5), 7500);
    near(ship_.recoverTime(tl, 0, 1), 14400 + 1200);
    near(ship_.recoverTime(tl, 14400, 0.5), 15000);
    near(ship_.recoverTime(tl, 82800, 1), 3600 + 13200);
  });

  test("Optimize fills Control Nexus Shift B, the longer shift first", () => {
    const p = withCnShifts(dc.defaultProfile(), { p: 0, q: 1080 });
    assert.deepEqual(dc.assignmentSlots(p), ["CN", "CN#B", "MFG-I", "MFG-II", "GC", "RR"]);
    const a = dc.optimizeOperators(ops, p, Object.keys(ops));
    const regen = (slot: string) => a[slot].map((o) => {
      const sk = ops[o!.id].baseSkills.find((x) => x.room === "CN" && x.type === "mood regen");
      return sk ? sk.values[1] : 0;
    });
    assert.ok([...regen("CN"), ...regen("CN#B")].every((v) => v > 0));
    assert.ok(pySum(regen("CN")) >= pySum(regen("CN#B")));
    p.dijiangPlanner.roomAssignments = a;
    const r = dc.computeProductivity(ops, p);
    assert.ok(r.CN.shifts && r.CN.shifts.A.operators === 3 && r.CN.shifts.B.operators === 3);
  });
});

describe("performance", () => {
  test("computeProductivity with every shift on stays well under 5 ms", () => {
    let p = dc.defaultProfile();
    const dp = p.dijiangPlanner;
    dp.roomSettings = {
      "MFG-I": { item: "Advanced_Combat_Record", shift: { ...dc.defaultShiftSettings(), enabled: true, p: 300, q: 1260 } },
      "MFG-II": { item: "Arms_INSP_Set", shift: { ...dc.defaultShiftSettings(), enabled: true, p: 0, q: 1380 } },
      GC: { items: ["Kalkonyx", "Pink_Bolete", "Kalkodendra"], shift: { ...dc.defaultShiftSettings(), enabled: true, autoRotate: true } },
      RR: { shift: { ...dc.defaultShiftSettings(), enabled: true, p: 120, q: 600, inner: "B" } },
    };
    p = dc.syncSlots(p);
    p.dijiangPlanner.roomAssignments = dc.optimizeOperators(ops, p, Object.keys(ops));
    const runs = 200;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) dc.computeProductivity(ops, p);
    const avg = (performance.now() - t0) / runs;
    assert.ok(avg < 5, `average ${avg.toFixed(3)} ms`);
  });
});
