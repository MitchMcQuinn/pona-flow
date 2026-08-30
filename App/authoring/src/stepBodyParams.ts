import type { Parameter } from "./types.js";

/** Parameter names: letter or underscore first; never a leading digit. */
export const PARAMETER_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Body parameter references ($name). Excludes dollar amounts ($100, $3.14) and
 * numeric placeholders (${42}) — only $ followed by a param-shaped identifier.
 */
export const STEP_BODY_PARAM_REF_RE =
  /\$(?![0-9])(?!\{[0-9]+\})[A-Za-z_][A-Za-z0-9_]*/g;

export function isValidParameterName(name: string): boolean {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return false;
  if (/^[0-9]/.test(trimmed)) return false;
  return PARAMETER_NAME_RE.test(trimmed);
}

export function findStepBodyParameterRefs(bodyRaw: string): string[] {
  const names: string[] = [];
  STEP_BODY_PARAM_REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STEP_BODY_PARAM_REF_RE.exec(bodyRaw)) !== null) {
    names.push(match[0].slice(1));
  }
  return names;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function configuredParameterNames(parameters: Parameter[]): Set<string> {
  const names = new Set<string>();
  parameters.forEach((p) => {
    const name = (p.name ?? "").trim();
    if (name && isValidParameterName(name)) names.add(name);
  });
  return names;
}

/** Highlight $param tokens: green when defined in the panel, yellow when not. */
export function buildStepBodyHighlightHtml(raw: string, parameters: Parameter[]): string {
  const configured = configuredParameterNames(parameters);
  let html = "";
  let last = 0;
  STEP_BODY_PARAM_REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STEP_BODY_PARAM_REF_RE.exec(raw)) !== null) {
    html += escapeHtml(raw.slice(last, match.index));
    const token = match[0];
    const name = token.slice(1);
    const cls = configured.has(name) ? "builderBodyTokenKnown" : "builderBodyTokenUnknown";
    html += `<span class="${cls}">${escapeHtml(token)}</span>`;
    last = match.index + token.length;
  }
  html += escapeHtml(raw.slice(last));
  return html;
}

export function validateStepBodyParameters(
  bodyRaw: string,
  parameters: Parameter[]
): string[] {
  const warnings: string[] = [];
  const configured = configuredParameterNames(parameters);
  const seenUnknown = new Set<string>();

  for (const name of findStepBodyParameterRefs(bodyRaw)) {
    if (!configured.has(name) && !seenUnknown.has(name)) {
      seenUnknown.add(name);
      warnings.push(`Body references unknown parameter "$${name}".`);
    }
  }

  const referenced = new Set(findStepBodyParameterRefs(bodyRaw));
  parameters.forEach((p) => {
    if (!p.is_required) return;
    // A hand-declared input is collected for the run as a whole (a later step, or a
    // transition guard, reads it) and is not expected to appear in this step's body.
    if (p.declared) return;
    const name = (p.name ?? "").trim();
    if (!name) return;
    if (!referenced.has(name)) {
      warnings.push(`Required parameter "$${name}" is not referenced in the body.`);
    }
  });

  return warnings;
}
