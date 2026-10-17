// The ship planner behind Optimize: its fast scoring matches the results, its plans are
// valid (each operator once, fixed ones kept, only available ones used) and they never
// score below the original planner's optimizer.
// @ts-ignore -- this repo has no @types/node; node:test is untyped here
import { describe, test } from "node:test";
// @ts-ignore -- as above
import assert from "node:assert/strict";
import * as dc from "../src/core/index.ts";
import type { Profile, ShiftSettings } from "../src/core/index.ts";

const ops = dc.OPS;
const ALL = Object.keys(ops);
const ROOMS = ["CN", "MFG-I", "MFG-II", "GC", "RR"];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function base(prio = "Equal"): Profile {
  const p = dc.defaultProfile();
  p.dijiangPlanner.settings.prio = prio;
  p.dijiangPlanner.roomSettings = {
    "MFG-I": { item: "Advanced_Combat_Record" }, "MFG-II": { item: "Arms_INSP_Set" },
    GC: { items: ["Kalkodendra", "Kalkonyx", null] }, RR: {}, CN: {},
  };
  return dc.syncSlots(p);
}

function withShifts(p: Profile, sh: Partial<ShiftSettings>): Profile {
  const q = structuredClone(p);
  for (const r of ROOMS) q.dijiangPlanner.roomSettings[r] = { ...(q.dijiangPlanner.roomSettings[r] ?? {}), shift: { ...dc.defaultShiftSettings(), enabled: true, ...sh } };
  return dc.syncSlots(q);
}

function oldOptimize(p: Profile, available: string[]): number {
  const q = structuredClone(p);
  q.dijiangPlanner.roomAssignments = dc.optimizeOperators(ops, q, available);
  return dc.planScore(ops, q);
}

function placed(p: Profile): string[] {
  return Object.values(p.dijiangPlanner.roomAssignments).flatMap((slots) => slots.filter((o) => o).map((o) => o!.id));
}

describe("planner scoring", () => {
  test("its fast score equals the score from the results, for random plans", () => {
    const r = rng(11);
    for (let k = 0; k < 60; k++) {
      let p = base(Object.keys(dc.PRIORITY_OPTIONS)[k % 10]);
      const dp = p.dijiangPlanner;
      if (k % 3 === 1) dp.settings.align = "Aligned";
      if (k % 5 === 2) dp.settings.cnModel = "always";
      for (const room of ROOMS) {
        if (r() < 0.5) continue;
        const a = Math.floor(r() * 23) + 1;
        const b = Math.min(24, a + 1 + Math.floor(r() * (24 - a)));
        dp.roomSettings[room].shift = { ...dc.defaultShiftSettings(), enabled: true, p: a * 60, q: b * 60, inner: r() < 0.5 ? "A" : "B" };
      }
      p = dc.syncSlots(p);
      const pool = [...ALL].sort(() => r() - 0.5);
      for (const slot of Object.keys(p.dijiangPlanner.roomAssignments)) {
        p.dijiangPlanner.roomAssignments[slot] = [0, 1, 2].map(() => {
          if (r() < 0.25 || !pool.length) return null;
          const id = pool.pop()!;
          // the planner only places Mood Regen operators in the Control Nexus
          if (slot.startsWith("CN") && !ops[id].baseSkills.some((s) => s.room === "CN")) return null;
          return { id, fixed: false };
        });
      }
      for (const id of ALL) if (r() < 0.3) dp.operatorSkills[id] = [Math.floor(r() * 3), Math.floor(r() * 3)];
      const fast = dc.fastScore(ops, p, ALL);
      const exact = dc.planScore(ops, p);
      assert.ok(Math.abs(fast - exact) < 1e-9 * Math.max(1, exact), `${k}: ${fast} vs ${exact}`);
    }
  });
});

describe("planner plans", () => {
  test("four operators without skills: one per room, since a room's first operator adds the most", () => {
    const p = base();
    const res = dc.planShip(ops, p, ["lifeng", "alesh", "avywenna", "arclight"]);
    const ra = res.profile.dijiangPlanner.roomAssignments;
    for (const r of ["MFG-I", "MFG-II", "GC", "RR"]) assert.equal(ra[r].filter((o) => o).length, 1, r);
    assert.equal(ra.CN.filter((o) => o).length, 0);
  });

  test("valid plans that never score below the original optimizer", () => {
    const r = rng(5);
    for (const size of [5, 12, 20, 29]) {
      for (const keep of [false, true]) {
        // Shift B everywhere to start with (keep mode keeps these hours, full mode may change them)
        const p = withShifts(base(Object.keys(dc.PRIORITY_OPTIONS)[size % 10]), keep ? { p: 360, q: 1320 } : { p: 0, q: 720 });
        const pool = [...ALL].sort(() => r() - 0.5).slice(0, size);
        // one fixed operator in Shift B of a cabin (so its Shift B must stay on), one in the Control Nexus
        const fixedB = pool.pop()!;
        const fixedCn = pool.find((o) => ops[o].baseSkills.some((s) => s.room === "CN"));
        p.dijiangPlanner.roomAssignments["GC#B"] = [{ id: fixedB, fixed: true }, null, null];
        if (fixedCn) {
          pool.splice(pool.indexOf(fixedCn), 1);
          p.dijiangPlanner.roomAssignments.CN = [null, { id: fixedCn, fixed: true }, null];
        }
        const res = dc.planShip(ops, p, pool, { keepHours: keep });
        const q = res.profile;
        const ids = placed(q);
        assert.equal(new Set(ids).size, ids.length, "each operator once");
        for (const id of ids) assert.ok(pool.includes(id) || id === fixedB || id === fixedCn, `${id} available`);
        assert.equal(q.dijiangPlanner.roomAssignments["GC#B"]?.[0]?.id, fixedB, "fixed Shift B operator kept");
        if (fixedCn) assert.equal(q.dijiangPlanner.roomAssignments.CN[1]?.id, fixedCn, "fixed Control Nexus operator kept");
        assert.deepEqual(Object.keys(q.dijiangPlanner.roomAssignments), Object.keys(dc.syncSlots(q).dijiangPlanner.roomAssignments));
        if (keep) for (const room of ROOMS) assert.deepEqual(dc.getShiftSettings(q, room), dc.getShiftSettings(p, room), `${room} hours kept`);
        assert.ok(Math.abs(res.score - dc.planScore(ops, q)) < 1e-12);
        const avail = [...pool];
        const old = keep ? oldOptimize(p, avail) : Math.max(oldOptimize(p, avail), oldOptimize(withShifts(p, { enabled: false }), avail));
        assert.ok(res.score >= old - 1e-9, `${size} keep=${keep}: ${res.score} < ${old}`);
      }
    }
  });

  test("with every operator: Shift B everywhere, long Shift A, and a Control Nexus", () => {
    const res = dc.planShip(ops, base(), ALL);
    const q = res.profile;
    for (const r of ["MFG-I", "MFG-II", "GC", "RR"]) {
      const sh = dc.getShiftSettings(q, r);
      assert.ok(sh.enabled && sh.autoRotate, r);
      const len = dc.windowLength(dc.shiftWindows(sh).A) / 60;
      assert.ok(len >= 14 && len <= 20, `${r} Shift A ${len}h`);
    }
    const ra = q.dijiangPlanner.roomAssignments;
    assert.ok([...ra.CN, ...(ra["CN#B"] ?? [])].filter((o) => o).length >= 3);
    // about 10% above the original optimizer's best (no Shift B: 12.629, 12h/12h: 13.66)
    assert.ok(res.score > 15, `${res.score}`);
    // a shift that never halts shows enough rest, at the Mood Regen it gets while off duty
    const out = dc.computeProductivity(ops, q);
    for (const r of ROOMS) {
      for (const info of Object.values(out[r].shifts ?? {})) {
        if (info.operators && info.halted === 0) assert.ok(info.restNeededMin <= info.restAvailableMin + 1, `${r}: ${info.restNeededMin} > ${info.restAvailableMin}`);
      }
    }
  });

  test("no operators is a valid input, and planning a planned ship again never does worse", () => {
    const empty = dc.planShip(ops, base(), []);
    assert.equal(placed(empty.profile).length, 0);
    assert.equal(empty.score, 0);
    const once = dc.planShip(ops, base("GC > RR > MFG"), ALL.slice(0, 17));
    const twice = dc.planShip(ops, once.profile, ALL.slice(0, 17));
    assert.ok(Math.abs(twice.before - once.score) < 1e-12);
    assert.ok(twice.score >= once.score - 1e-9, `${twice.score} < ${once.score}`);
  });

  test("the whole roster plans in well under the time limit", () => {
    const t0 = performance.now();
    dc.planShip(ops, base("MFG > GC > RR"), ALL);
    const ms = performance.now() - t0;
    assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
  });
});
