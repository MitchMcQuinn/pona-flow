/**
 * Create-SCHEMA form defaults: a new node starts with NAME flagged is_label.
 */
import assert from "node:assert/strict";

import {
  applySchemaCreateDefaults,
  DEFAULT_SCHEMA_LABEL_PROPERTY_NAME,
  newMatchClause,
  newQuery,
  newSchemaLabelProperty,
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

console.log("schema-create-defaults: ok");
