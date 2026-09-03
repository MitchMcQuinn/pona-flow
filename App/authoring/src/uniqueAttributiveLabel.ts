/**
 * Pick a unique STEP/SCHEMA-style attributive_label when the requested base name is
 * already taken. Appends a sequential suffix starting at 1: FOO -> FOO1 -> FOO2 …
 */
export function nextUniqueAttributiveLabel(
  baseName: string,
  taken: ReadonlySet<string>
): string {
  const base = (baseName || "").trim();
  if (!base) return base;
  if (!taken.has(base)) return base;
  let n = 1;
  while (taken.has(base + String(n))) {
    n += 1;
  }
  return base + String(n);
}

/**
 * Whether a sequence title change should also SET the wrapping STEP node's attributive_label.
 *
 * The catalog name is the workspace title and always saves. The wrap label is graph identity
 * and only follows when a wrap already exists, the title actually changed, and no other
 * STEP/SCHEMA/POINTS_TO already holds that label.
 */
export function shouldRetargetSequenceWrap(opts: {
  requestedName: string;
  wrapEntityId: string;
  currentWrapLabel: string;
  labelTakenByOther: boolean;
}): boolean {
  const name = (opts.requestedName || "").trim();
  if (!name || !(opts.wrapEntityId || "").trim()) return false;
  if (name === (opts.currentWrapLabel || "").trim()) return false;
  return !opts.labelTakenByOther;
}

/**
 * Operation wrap retarget: same as the sequence hybrid, plus a gate that keeps the wrap
 * put when a multi-step sequence MATCHES the current wrap label (those queries bind by
 * attributive_label, so renaming the node would break them).
 */
export function shouldRetargetOperationWrap(opts: {
  requestedName: string;
  wrapEntityId: string;
  currentWrapLabel: string;
  labelTakenByOther: boolean;
  multiStepReferencesWrap: boolean;
}): boolean {
  if (opts.multiStepReferencesWrap) return false;
  return shouldRetargetSequenceWrap(opts);
}
