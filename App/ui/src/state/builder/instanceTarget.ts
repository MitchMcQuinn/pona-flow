/** Picker value when the user chooses to create a new INSTANCE (not an existing graph node). */
export const INSTANCE_TARGET_NEW_VALUE = "__new_instance__";

export function instanceTargetPickerValue(
  nodeSource: "new" | "existing" | undefined,
  idBinding: string | undefined
): string {
  if (nodeSource === "new") return INSTANCE_TARGET_NEW_VALUE;
  if (nodeSource === "existing") return (idBinding ?? "").trim();
  return "";
}

export function isInstanceTargetResolved(
  nodeSource: "new" | "existing" | undefined
): boolean {
  return nodeSource === "new" || nodeSource === "existing";
}
