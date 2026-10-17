// Operator data bundled with the app (snapshot of eldritchtools/endfield-assets).
import operators from "../data/operators.json" with { type: "json" };
import baseSkills from "../data/base_skills.json" with { type: "json" };
import { mergeOperatorData } from "./calc.ts";
import type { OperatorsData, Skill } from "./types.ts";

export const OPS: OperatorsData = mergeOperatorData(operators, baseSkills as unknown as Record<string, { baseSkills: Skill[] }>);
