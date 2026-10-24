// Operator optimizer: CN first (optional), then a min-cost max-flow over
// operators x room slots.
import { PRIORITY_OPTIONS, ROOM_DATA, baseRoom, roomType, shiftSlot } from "./constants.ts";
import { skillValue } from "./calc.ts";
import { getShiftSettings } from "./profile.ts";
import { at, cmp, field, lookup, pyMin, req, truthy } from "./py.ts";
import { shiftWindows, windowLength } from "./shifts.ts";
import type { Assigned, OperatorsData, Profile, RoomSettings, Slots, UsedEdge } from "./types.ts";

/** [to, cap, cost, rev index, from, original cap] */
type Edge = [number, number, number, number, number, number];

/** Successive shortest paths (Bellman-Ford / SPFA) min-cost max-flow. */
export class MinCostFlow {
  readonly n: number;
  readonly g: number[][];
  readonly edges: Edge[] = [];

  constructor(n: number) {
    this.n = n;
    this.g = Array.from({ length: n }, () => []);
  }

  addEdge(u: number, v: number, cap: number, cost: number): void {
    const e = this.edges;
    this.g[u].push(e.length);
    e.push([v, cap, cost, e.length + 1, u, cap]);
    this.g[v].push(e.length);
    e.push([u, 0, -cost, e.length - 1, v, 0]);
  }

  /** [flow, cost] */
  solve(s: number, t: number): [number, number] {
    const { n, g, edges } = this;
    let flow = 0.0;
    let cost = 0.0;
    const dist = new Float64Array(n);
    const inQ = new Uint8Array(n);
    const prev = new Int32Array(n);
    for (;;) {
      dist.fill(Infinity);
      inQ.fill(0);
      prev.fill(-1);
      dist[s] = 0;
      const q = [s]; // FIFO, like list.pop(0)
      inQ[s] = 1;
      for (let head = 0; head < q.length; head++) {
        const u = q[head];
        inQ[u] = 0;
        for (const ei of g[u]) {
          const [v, cap, c] = edges[ei];
          if (cap > 0 && dist[u] + c < dist[v] - 1e-12) {
            dist[v] = dist[u] + c;
            prev[v] = ei;
            if (!inQ[v]) {
              q.push(v);
              inQ[v] = 1;
            }
          }
        }
      }
      if (dist[t] === Infinity) return [flow, cost];
      let f = Infinity;
      for (let v = t; v !== s; v = edges[prev[v]][4]) f = pyMin(f, edges[prev[v]][1]);
      for (let v = t; v !== s; v = edges[prev[v]][4]) {
        const e = edges[prev[v]];
        e[1] -= f;
        edges[e[3]][1] += f;
      }
      flow += f;
      cost += f * dist[t];
    }
  }

  usedEdges(): UsedEdge[] {
    return this.edges.filter((e) => e[5] > 0 && e[1] < e[5]).map((e) => ({ from: e[4], to: e[0], cost: e[2] }));
  }
}

const SCORED_TYPES = new Set(["operator xp", "weapon xp", "mineral", "fungus", "plant"]);

/** Expected value of each operator in each slot (0 when it has nothing to give there). */
export function roomScores(
  ops: OperatorsData, profile: Profile, prio: Readonly<Record<string, number>>, slotIds: readonly string[],
): Record<string, Record<string, number>> {
  const roomSettings = profile.dijiangPlanner.roomSettings;
  const scores: Record<string, Record<string, number>> = {};
  for (const [opId, op] of Object.entries(ops)) {
    const skills = op.baseSkills;
    const vals = skills.map((s, i) => skillValue(profile, opId, i, s));
    const sd: Record<string, number> = {};
    for (const slot of slotIds) {
      const rid = baseRoom(slot);
      const rtype = roomType(rid);
      let effB = 0.0;
      let moodB = 0.0;
      for (let i = 0; i < skills.length; i++) {
        const skill = skills[i];
        if (skill.room !== rtype || vals[i] === 0) continue;
        const t = skill.type;
        if (t === "mood regen" || t === "mood drain") {
          moodB += vals[i];
        } else if (t === "clue efficiency") {
          effB += vals[i] * req(prio, rtype);
        } else if (SCORED_TYPES.has(t)) {
          const rs = lookup(roomSettings, rid, null);
          if (rs == null) continue;
          if (skill.room === "MFG") {
            const item = lookup(ROOM_DATA.MFG.items, field(rs, "item", null), null);
            if (item && t === item.type) effB += vals[i] * req(prio, rtype);
          } else if (skill.room === "GC") {
            const items = field(rs, "items", []).filter(truthy) as string[];
            const match = items.filter((x) => req(ROOM_DATA.GC.items, x).type === t).length;
            if (match) effB += ((vals[i] * match) / items.length) * req(prio, rtype);
          }
        }
      }
      if (effB === 0 && moodB === 0) {
        sd[slot] = 0.0;
      } else {
        const baseUp = 5 / 8;
        sd[slot] = (1 + effB * baseUp) * (1 + (moodB * (1 - baseUp)) / (1 + baseUp * moodB));
      }
    }
    sd["CN"] = lookup(sd, "CN", 0.0);
    scores[opId] = sd;
  }
  return scores;
}

/** Lowest priority among the rooms each operator is useful in (0 when none). */
export function worstRoomPrio(
  ops: OperatorsData, profile: Profile, prio: Readonly<Record<string, number>>,
): Record<string, number> {
  const rsAll = Object.entries(profile.dijiangPlanner.roomSettings);
  const mfgUnused = (type: string) =>
    rsAll.every(([k, v]) => roomType(k) !== "MFG" || !truthy(field(v, "item", null)) || req(ROOM_DATA.MFG.items, v.item!).type !== type);
  const gcUnused = (type: string) =>
    rsAll.every(([k, v]) => roomType(k) !== "GC" || !truthy(field(v, "items", null))
      || v.items!.every((x) => !truthy(x) || req(ROOM_DATA.GC.items, x!).type !== type));
  const out: Record<string, number> = {};
  for (const [opId, op] of Object.entries(ops)) {
    let score = 5;
    for (const skill of op.baseSkills) {
      const r = skill.room;
      if (r === "CN") continue;
      if (r === "MFG" && mfgUnused(skill.type)) continue;
      if (r === "GC" && gcUnused(skill.type)) continue;
      if (r === "RR" && skill.type === "clue rate up") continue;
      score = pyMin(score, req(prio, r));
    }
    out[opId] = score === 5 ? 0 : score;
  }
  return out;
}

export function optimizeOperators(ops: OperatorsData, profile: Profile, available: readonly string[]): Record<string, Slots> {
  const dp = profile.dijiangPlanner;
  const cnFirst = truthy(field(lookup(dp.roomSettings, "CN", {} as RoomSettings), "firstPrio", true));
  const prio = lookup(PRIORITY_OPTIONS, field(dp.settings, "prio", "Equal"), PRIORITY_OPTIONS["Equal"]);
  const assignments: Record<string, Slots> = {};
  for (const [rid, slots] of Object.entries(dp.roomAssignments)) {
    // field(): a slot entry that is not a dict raises, like Python's op.get("fixed")
    assignments[rid] = slots.map((op) => (truthy(op) && truthy(field(op!, "fixed", undefined)) ? op : null));
  }
  const slotIds = Object.keys(assignments);
  const scores = roomScores(ops, profile, prio, slotIds);
  const worst = worstRoomPrio(ops, profile, prio);
  const score = (o: string): Record<string, number> => req(scores, o);

  // with a Control Nexus Shift B, the shift on duty longer (or the active one) gets the best operators
  const cnB = shiftSlot("CN", "B");
  let cnSlots = ["CN"];
  if (Object.hasOwn(assignments, cnB)) {
    const sh = getShiftSettings(profile, "CN");
    const win = shiftWindows(sh);
    const bFirst = sh.autoRotate ? windowLength(win.B) > windowLength(win.A) : sh.active === "B";
    cnSlots = bFirst ? [cnB, "CN"] : ["CN", cnB];
  }
  const fillCn = (list: readonly string[], order: (a: string, b: string) => number): string[] => {
    let rest = [...list].sort(order);
    for (const slot of cnSlots) {
      for (let i = 0; i < 3; i++) {
        if (at(assignments[slot], i)) continue;
        if (rest.length === 0 || score(rest[0])["CN"] === 0) return rest;
        assignments[slot][i] = { id: rest[0], fixed: false };
        rest = rest.slice(1);
      }
    }
    return rest;
  };

  let operators = [...available];
  if (cnFirst) {
    // sort key (-CN score, worst room priority)
    operators = fillCn(operators, (a, b) => cmp(-score(a)["CN"], -score(b)["CN"]) || cmp(req(worst, a), req(worst, b)));
  }

  operators.sort(cmp);
  const rooms = slotIds.filter((s) => baseRoom(s) !== "CN");
  let n = 0;
  const SRC = n++;
  const opNode = new Map<string, number>();
  for (const o of operators) opNode.set(o, n++);
  const roomNode = new Map<string, number>();
  for (const r of rooms) roomNode.set(r, n++);
  const SNK = n++;
  const mcf = new MinCostFlow(n);
  for (const o of operators) mcf.addEdge(SRC, opNode.get(o)!, 1, 0);
  for (const o of operators) {
    for (const r of rooms) {
      const s = score(o)[r] - 0.000001 * score(o)["CN"];
      mcf.addEdge(opNode.get(o)!, roomNode.get(r)!, 1, 100 - s);
    }
  }
  for (const r of rooms) mcf.addEdge(roomNode.get(r)!, SNK, assignments[r].filter((x) => !truthy(x)).length, 0);
  mcf.solve(SRC, SNK);

  const revOp = new Map([...opNode].map(([k, v]) => [v, k]));
  const revRoom = new Map([...roomNode].map(([k, v]) => [v, k]));
  const assigned = new Set<string>();
  for (const e of mcf.usedEdges().sort((x, y) => cmp(x.cost, y.cost))) {
    const o = revOp.get(e.from);
    const r = revRoom.get(e.to);
    if (o === undefined || r === undefined) continue;
    for (let i = 0; i < 3; i++) {
      if (at(assignments[r], i)) continue;
      const a: Assigned = { id: o, fixed: false };
      // nothing to give in this room (cost === 100 alone would miss Control Nexus operators)
      if (score(o)[r] === 0) a.filler = true;
      assignments[r][i] = a;
      assigned.add(o);
      break;
    }
  }
  operators = operators.filter((o) => !assigned.has(o));
  if (!cnFirst) fillCn(operators, (a, b) => cmp(-score(a)["CN"], -score(b)["CN"]));
  return assignments;
}
