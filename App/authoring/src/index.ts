/**
 * Public authoring API — the rules and choreography for turning intent into saved
 * pona flow artifacts (operations, STEP nodes, sequences).
 *
 * This package is the single definition of what a valid QueryObject is and what has to
 * happen, in what order, to persist one. It is consumed by the React builder (which
 * projects its BuilderState into an AuthoringContext) and by the MCP authoring server
 * (which constructs one from tool arguments), so an agent-authored operation and a
 * human-authored operation are byte-identical and equally editable in the visual builder.
 *
 * Everything here must run in both the browser and Node: no window, no localStorage, no
 * React. Network access goes through @pona-flow/connector, which is configured per host.
 */

export * from "./types.js";
export * from "./defaults.js";
export * from "./normalizeField.js";
export * from "./stepBodyParams.js";
export * from "./stepResponseParams.js";
export * from "./matchAlias.js";
export * from "./parameterRefs.js";
export * from "./schemaRules.js";
export * from "./instanceRules.js";
export * from "./sequenceRules.js";
export * from "./matchMode.js";
export * from "./returnProjections.js";
export * from "./attributiveLabels.js";
export * from "./uniqueAttributiveLabel.js";
export * from "./validation.js";
export * from "./builderConfig.js";
export * from "./normalize.js";
export * from "./stepWrapLabel.js";
export * from "./packages.js";
export * from "./preflight.js";
export * from "./operations.js";
export * from "./sequences.js";
