// Game constants and room data (see the formula notes in calc.ts).
import type { ItemInfo, RoomInfo, RoomType } from "./types.ts";

export const BREAK_TIME = 30000; // seconds, zero -> max mood at base mood regen
export const WORK_TIME = 50000; // seconds, max -> zero mood at base mood drop
export const OPERATOR_BONUS = 0.4; // +40% production per working operator
export const DAY_MIN = 24 * 60;
export const LATEST_VERSION = "py-1.0";

export const ROOM_DATA: {
  CN: RoomInfo;
  MFG: RoomInfo & { items: Record<string, ItemInfo & { value: number }> };
  GC: RoomInfo & { items: Record<string, ItemInfo> };
  RR: RoomInfo & { duration: number };
} = {
  CN: { name: "Control Nexus", background: "rgba(58, 107, 175, 0.25)", border: "#2f4f7a" },
  MFG: {
    name: "Manufacturing Cabin",
    background: "rgba(217, 184, 74, 0.25)",
    border: "#c4a83c",
    items: {
      Advanced_Combat_Record: { name: "Advanced Combat Record", duration: 35200, type: "operator xp", value: 10000 },
      Elementary_Combat_Record: { name: "Elementary Combat Record", duration: 920, type: "operator xp", value: 200 },
      Intermediate_Combat_Record: { name: "Intermediate Combat Record", duration: 4200, type: "operator xp", value: 1000 },
      Elementary_Cognitive_Carrier: { name: "Elementary Cognitive Carrier", duration: 10500, type: "operator xp", value: 1000 },
      Advanced_Cognitive_Carrier: { name: "Advanced Cognitive Carrier", duration: 88000, type: "operator xp", value: 10000 },
      Arms_Inspector: { name: "Arms Inspector", duration: 920, type: "weapon xp", value: 200 },
      Arms_INSP_Kit: { name: "Arms INSP Kit", duration: 4200, type: "weapon xp", value: 1000 },
      Arms_INSP_Set: { name: "Arms INSP Set", duration: 35200, type: "weapon xp", value: 10000 },
    },
  },
  GC: {
    name: "Growth Chamber",
    background: "rgba(109, 174, 95, 0.25)",
    border: "#5c9e4b",
    items: {
      Pink_Bolete: { name: "Pink Bolete", duration: 62500, type: "fungus" },
      Red_Bolete: { name: "Red Bolete", duration: 100000, type: "fungus" },
      Ruby_Bolete: { name: "Ruby Bolete", duration: 220000, type: "fungus" },
      Bloodcap: { name: "Bloodcap", duration: 450000, type: "fungus" },
      Cosmagaric: { name: "Cosmagaric", duration: 450000, type: "fungus" },
      Kalkodendra: { name: "Kalkodendra", duration: 62500, type: "plant" },
      Chrysodendra: { name: "Chrysodendra", duration: 100000, type: "plant" },
      Vitrodendra: { name: "Vitrodendra", duration: 220000, type: "plant" },
      Blighted_Jadeleaf: { name: "Blighted Jadeleaf", duration: 450000, type: "plant" },
      False_Aggela: { name: "False Aggela", duration: 450000, type: "plant" },
      Kalkonyx: { name: "Kalkonyx", duration: 62500, type: "mineral" },
      Auronyx: { name: "Auronyx", duration: 100000, type: "mineral" },
      Umbronyx: { name: "Umbronyx", duration: 220000, type: "mineral" },
      Igneosite: { name: "Igneosite", duration: 450000, type: "mineral" },
      Wulingstone: { name: "Wulingstone", duration: 450000, type: "mineral" },
    },
  },
  RR: { name: "Reception Room", background: "rgba(124, 93, 163, 0.25)", border: "#6a4e8a", duration: 88000 },
};

export const ROOM_IDS: readonly string[] = ["CN", "MFG-I", "MFG-II", "GC", "RR"];
export const ALIGNMENT_OPTIONS: readonly string[] = ["Staggered", "Aligned"];
export const PRIORITY_OPTIONS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  Equal: { MFG: 1, GC: 1, RR: 1 },
  "MFG & GC > RR": { MFG: 2, GC: 2, RR: 1 },
  "MFG & RR > GC": { MFG: 2, GC: 1, RR: 2 },
  "GC & RR > MFG": { MFG: 1, GC: 2, RR: 2 },
  "MFG > GC > RR": { MFG: 3, GC: 2, RR: 1 },
  "MFG > RR > GC": { MFG: 3, GC: 1, RR: 2 },
  "GC > MFG > RR": { MFG: 2, GC: 3, RR: 1 },
  "GC > RR > MFG": { MFG: 1, GC: 3, RR: 2 },
  "RR > MFG > GC": { MFG: 2, GC: 1, RR: 3 },
  "RR > GC > MFG": { MFG: 1, GC: 2, RR: 3 },
};
export const SKILL_ICON_TYPE: Readonly<Record<string, string>> = {
  "mood drain": "mood drain",
  "mood regen": "mood regen",
  "clue efficiency": "efficiency",
  "clue rate up": "clue up",
  "operator xp": "efficiency",
  "weapon xp": "efficiency",
  mineral: "mineral",
  fungus: "fungus",
  plant: "plant",
};

/** "MFG-II#B" -> "MFG". Typed as RoomType for indexing ROOM_DATA; unknown ids pass through. */
export function roomType(roomId: string): RoomType {
  return roomId.split("#")[0].split("-")[0] as RoomType;
}

/** "MFG-I#B" -> "MFG-I". */
export function baseRoom(slotId: string): string {
  return slotId.split("#")[0];
}

export function shiftSlot(roomId: string, shift: string): string {
  return shift === "A" ? roomId : `${roomId}#B`;
}
