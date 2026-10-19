// Shared data shapes for the planner core, storage and UI.
// They mirror the profile format of the original endfield-planners site so
// exported profiles stay compatible in both directions.

export type ShiftId = "A" | "B";
/** How the Control Nexus Mood Regen works: "game" (its team tires and rests) or "always" (original planner). */
export type CnModel = "game" | "always";
/** Whether Optimize picks the Shift A/B hours ("optimize") or keeps the user's ("keep"). */
export type ShiftHours = "optimize" | "keep";
export type RoomType = "CN" | "MFG" | "GC" | "RR";
/** [start, end] in minutes; start in [0, 1440), end in (0, 1440]; end < start wraps past midnight. */
export type Window = [number, number];

export interface Skill {
  name: string;
  room: RoomType;
  texts: [string, string];
  type: string;
  values: [number, number];
}

export interface OperatorData {
  name: string;
  baseSkills: Skill[];
  /** stars (4-6) */
  rarity?: number;
  /** art for operators the asset repo does not have yet (from warfarin.wiki), and a second image
   *  scripts/fetch-art.mjs tries; the site shows its copy in assets/operators first */
  art?: string;
  artFallback?: string;
}

export type OperatorsData = Record<string, OperatorData>;

export interface Assigned {
  id: string;
  fixed: boolean;
  filler?: boolean;
}

export type Slots = (Assigned | null)[];

export interface ShiftSettings {
  enabled: boolean;
  autoRotate: boolean;
  active: ShiftId;
  /** Bar handles: p < q. [p, q] belongs to `inner`, the rest of the day to the other shift. */
  p: number;
  q: number;
  inner: ShiftId;
}

export interface RoomSettings {
  item?: string | null;
  items?: (string | null)[];
  firstPrio?: boolean;
  shift?: Partial<ShiftSettings>;
}

export interface PlannerSettings {
  defaultLevels: [number, number];
  prio: string;
  align: string;
  utcOffset: number;
  cnModel?: CnModel;
  /** "optimize" (default): Optimize also picks each room's Shift A/B hours; "keep": it only picks operators */
  shiftHours?: ShiftHours;
  /** room priority switched on or off; missing in older profiles, which use the `prio` preset */
  prioOn?: boolean;
  /** production room id -> priority level 1-5 (how many times the room counts when Optimize compares plans) */
  roomPrio?: Record<string, number>;
}

export interface DijiangPlanner {
  roomAssignments: Record<string, Slots>;
  roomSettings: Record<string, RoomSettings>;
  operatorSkills: Record<string, [number | null, number | null]>;
  settings: PlannerSettings;
}

export interface Profile {
  latestVersion: string;
  dijiangPlanner: DijiangPlanner;
  operators: Record<string, { disabled?: boolean }>;
}

export interface ShiftInfo {
  window: Window;
  workTime: number;
  workTimeLabel: string;
  moodDropPerHour: number;
  operators: number;
  multipliers: Record<string, number>;
  scheduledMin: number;
  covers: boolean;
  /** Seconds from zero to max Mood at the ship's Mood Regen. */
  breakTime: number;
  restAvailableMin: number;
  restNeededMin: number;
  // present when auto-rotate is on (from the steady-state simulation, daily averages)
  scheduled?: number;
  worked?: number;
  halted?: number;
  haltedSpans?: [number, number][];
}

export interface GCItemResult {
  name: string;
  duration: string;
}

export interface RoomResult {
  workTime: string;
  operatorUptime?: string;
  // CN only: moodRegen is the average when it changes over time
  globalBreakTime?: string;
  moodRegen?: string;
  /** Mood Regen while the whole team works, and the share of time any Mood Regen is active (when it changes over time) */
  teamMoodRegen?: string;
  regenUptime?: string;
  // rooms with Shift B enabled
  shifts?: Record<ShiftId, ShiftInfo>;
  // MFG / RR
  efficiency?: string;
  duration?: string;
  // MFG with a product
  xpPerSecond?: string;
  xpPerHour?: string;
  xpPerHourNum?: number;
  xpType?: string;
  itemsPerDay?: string;
  // GC
  fungus?: string;
  plant?: string;
  mineral?: string;
  items?: (GCItemResult | null)[];
  // RR
  cluesPerDay?: string;
}

export type Results = Record<string, RoomResult>;

// ---------------------------------------------------------------- core internals

export interface ItemInfo {
  name: string;
  /** seconds at 100% efficiency */
  duration: number;
  type: string;
  /** EXP per item (MFG only) */
  value?: number;
}

export interface RoomInfo {
  name: string;
  background: string;
  border: string;
  items?: Record<string, ItemInfo>;
  duration?: number;
}

/** Per-slot efficiency bonuses by type ("efficiency", or "fungus" / "plant" / "mineral" in the GC). */
export type Bonuses = Record<string, number[]>;

/** One shift's operators for simulateShifts. */
export interface ShiftGroup {
  n: number;
  work: number;
  mult: Record<string, number>;
}

/** Daily averages in minutes, in steady state. */
export interface ShiftStats {
  scheduled: number;
  worked: number;
  halted: number;
  /** [start, end) minutes on schedule but resting at zero mood; only when every day is the same. */
  haltedSpans?: [number, number][];
}

export interface UsedEdge {
  from: number;
  to: number;
  cost: number;
}
