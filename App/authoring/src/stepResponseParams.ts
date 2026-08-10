import type { StepResponseParameter } from "./types.js";
import { isValidParameterName } from "./stepBodyParams.js";

export function validateStepResponseParameters(
  items: StepResponseParameter[] | undefined
): string[] {
  const warnings: string[] = [];
  const seenParameters = new Set<string>();

  for (const item of items ?? []) {
    const property_path = String(item.property_path ?? "").trim();
    const parameter = String(item.parameter ?? "").trim();
    if (!property_path && !parameter) continue;

    if (!property_path) {
      warnings.push("Each response parameter needs a property path.");
      continue;
    }
    if (!parameter) {
      warnings.push("Each response parameter needs a parameter name.");
      continue;
    }
    if (!isValidParameterName(parameter)) {
      warnings.push(`Response parameter name "${parameter}" is invalid.`);
      continue;
    }
    if (seenParameters.has(parameter)) {
      warnings.push(`Duplicate response parameter "${parameter}".`);
      continue;
    }
    seenParameters.add(parameter);
  }

  return warnings;
}
