/**
 * Create-SCHEMA form defaults: a new node starts with NAME flagged is_label.
 */
import assert from "node:assert/strict";

import {
  applySchemaCreateDefaults,
  DEFAULT_SCHEMA_LABEL_PROPERTY_NAME,
  ensureSchemaLabelProperties,
  newMatchClause,
  newQuery,
  newSchemaLabelProperty,
  newSchematicProperties,
  previewChatIntent,
} from "../App/authoring/src/index.ts";

const prop = newSchemaLabelProperty();
assert.equal(prop.key, DEFAULT_SCHEMA_LABEL_PROPERTY_NAME);
assert.equal(prop.schematic_properties?.is_label, true);
assert.equal(prop.schematic_properties?.is_required, true);
assert.equal(prop.schematic_properties?.value_type, "string");

const seeded = applySchemaCreateDefaults(
  { ...newQuery("create"), match: [newMatchClause("SCHEMA")] },
  "create",
  "SCHEMA"
);
const node = seeded.match[0].patterns[0].path[0].node;
assert.equal(node.properties.length, 1);
assert.deepEqual(node.properties[0], prop);

const untouched = applySchemaCreateDefaults(
  { ...newQuery("create"), match: [newMatchClause("STEP")] },
  "create",
  "STEP"
);
assert.equal(untouched.match[0].patterns[0].path[0].node.properties.length, 0);

const repaired = ensureSchemaLabelProperties([
  {
    key: "name",
    value: "",
    schematic_properties: { ...newSchematicProperties(), is_label: true, is_required: false },
  },
  {
    key: "notes",
    value: "",
    schematic_properties: { ...newSchematicProperties(), is_label: false, is_required: false },
  },
]);
assert.equal(repaired[0].schematic_properties?.is_label, true);
assert.equal(repaired[0].schematic_properties?.is_required, true);
assert.equal(repaired[1].schematic_properties?.is_required, false);

const preview = previewChatIntent({
  kind: "upsert_schema",
  summary: "Type post",
  payload: {
    attributive_label: "post",
    properties: [{ key: "name", value_type: "string", is_label: true }],
  },
});
const name = preview?.query.match[0].patterns[0].path[0].node.properties.find(
  (property) => property.key === "name"
);
assert.equal(name?.schematic_properties?.is_label, true);
assert.equal(name?.schematic_properties?.is_required, true);

console.log("schema-create-defaults: ok");
