import assert from "node:assert/strict";
import {
  formatPreviewSqlBlock,
  formatSqlForPreview
} from "../App/ui/src/utils/formatSqlForPreview.ts";

const catalogSql =
  "INSERT INTO queries (id, name, kind) VALUES ('a', 'b', 'operation') ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind;";

const formatted = formatSqlForPreview(catalogSql);
assert.match(formatted, /^INSERT INTO queries \(\n/);
assert.match(formatted, /\n\) VALUES \(\n/);
assert.match(formatted, /\nON CONFLICT\(id\) DO UPDATE SET\n/);
assert.match(formatted, /\n  name = excluded\.name,/);

const withHeader = formatPreviewSqlBlock(`-- catalog data.db: queries table\n${catalogSql}`);
assert.match(withHeader, /^-- catalog data\.db: queries table\n/);
assert.match(withHeader, /\nON CONFLICT\(id\) DO UPDATE SET\n/);

const updateSql =
  "UPDATE spaces SET labels = '{\"labels\":[\"A\"]}' WHERE id = 'space-1';";
const formattedUpdate = formatSqlForPreview(updateSql);
assert.match(formattedUpdate, /^UPDATE spaces SET\n/);
assert.match(formattedUpdate, /\nWHERE id = 'space-1';$/);

console.log("format-sql-preview: ok");
