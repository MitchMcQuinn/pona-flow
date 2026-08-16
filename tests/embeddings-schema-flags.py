"""
Diagnostic test for the engine's reading and rewriting of the vector-search SCHEMA flags.

Covers:
  - graph._schema_flags_from_payload / _normalize_property_schema reading is_vectorized
    (payload-level) and is_embedded (property-level);
  - schema_update._to_property_schema writing is_embedded only when on, so a SCHEMA that
    does not use vector search keeps the exact payload it had before;
  - schema_update._write_schema_payload preserving is_vectorized: an ordinary property edit
    that omits the flag must not silently switch vector search off;
  - _embedding_include_changed, which tells the caller when stored vectors no longer
    describe the text the schema now implies (they must be marked stale).

No database or network needed: the SQLite write is captured, not executed.

Run (from repo root, with the project venv so the package imports resolve):
    .venv/bin/python tests/embeddings-schema-flags.py
"""

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import graph, schema_update  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


# --- reading the flags out of a stored payload -------------------------------
check(
    "a payload without the flag reads as not vectorized",
    graph._schema_flags_from_payload({"schemata": []})["is_vectorized"] is False,
)
check(
    "a vectorized payload reads as vectorized",
    graph._schema_flags_from_payload({"schemata": [], "is_vectorized": True})["is_vectorized"]
    is True,
)
check(
    "a missing payload reads as not vectorized",
    graph._schema_flags_from_payload(None)["is_vectorized"] is False,
)

normalized = graph._normalize_property_schema(
    {"property_schema": {"name": "NOTES", "value_type": "string", "is_embedded": True}}
)
check("is_embedded is read off a property schema", normalized["is_embedded"] is True)
unmarked = graph._normalize_property_schema(
    {"property_schema": {"name": "NAME", "value_type": "string", "is_label": True}}
)
check("an unmarked property reads as not embedded", unmarked["is_embedded"] is False)

payload = {
    "schemata": [
        {"property_schema": {"name": "NAME", "value_type": "string", "is_label": True}},
        {"property_schema": {"name": "NOTES", "value_type": "string", "is_embedded": True}},
    ],
    "is_vectorized": True,
}
schemata = graph._schemata_from_payload(payload)
check(
    "the implicit key is injected without the embedding flag",
    schemata[0]["key"] == "id" and schemata[0]["is_embedded"] is False,
)
check(
    "flags survive a full payload parse",
    [s["key"] for s in schemata if s["is_embedded"]] == ["NOTES"],
)

# --- writing: only-when-on, and preserved across an unrelated edit -----------
plain = schema_update._to_property_schema(
    {"key": "NAME", "value_type": "string", "is_label": True}
)
check("is_embedded is absent when off", "is_embedded" not in plain)
marked = schema_update._to_property_schema(
    {"key": "NOTES", "value_type": "string", "is_embedded": True}
)
check("is_embedded is written when on", marked["is_embedded"] is True)

writes: list[str] = []


class FakeConnection:
    """Captures the payload UPDATE instead of touching SQLite."""

    class _Cursor:
        rowcount = 1

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> "FakeConnection._Cursor":
        if "UPDATE entities" in sql:
            writes.append(str(params[0]))
        return FakeConnection._Cursor()

    def commit(self) -> None:
        pass

    def close(self) -> None:
        pass


schema_update.spaces.connect_sqlite_for_space = lambda space_id: FakeConnection()  # type: ignore[assignment]
schema_update.spaces.entities_node_label_column = lambda conn: "node_label"  # type: ignore[assignment]

constraints = [
    {"key": "id", "value_type": "UID", "is_key": True},
    {"key": "NAME", "value_type": "string", "is_label": True},
]

writes.clear()
schema_update._write_schema_payload("TEST_SPACE", "ID_schema", constraints)
written = json.loads(writes[0])
check("a non-vectorized rewrite writes schemata only", list(written.keys()) == ["schemata"])

writes.clear()
schema_update._write_schema_payload(
    "TEST_SPACE", "ID_schema", constraints, is_vectorized=True
)
check("a vectorized rewrite keeps the flag", json.loads(writes[0])["is_vectorized"] is True)

# The resolution rule: omitted means "leave as stored", which is what stops an old client
# (or a property-only edit) from clearing the flag.
for stored, incoming, expected in (
    (True, None, True),
    (False, None, False),
    (True, False, False),
    (False, True, True),
):
    check(
        f"stored={stored} incoming={incoming} resolves to {expected}",
        schema_update._resolve_vectorized(stored, incoming) is expected,
    )

# --- when do stored vectors stop describing the record? ---------------------
name_only = {"NAME": {"key": "NAME", "is_label": True}}
name_and_notes = {
    "NAME": {"key": "NAME", "is_label": True},
    "NOTES": {"key": "NOTES", "is_embedded": True},
}
check(
    "turning vectorization on invalidates nothing yet but must reindex",
    schema_update._embedding_include_changed(name_only, name_only, False, True) is True,
)
check(
    "turning vectorization off is a change",
    schema_update._embedding_include_changed(name_only, name_only, True, False) is True,
)
check(
    "adding an embedded property invalidates stored vectors",
    schema_update._embedding_include_changed(name_only, name_and_notes, True, True) is True,
)
check(
    "removing an embedded property invalidates stored vectors",
    schema_update._embedding_include_changed(name_and_notes, name_only, True, True) is True,
)
check(
    "an unrelated property edit leaves vectors valid",
    schema_update._embedding_include_changed(name_only, name_only, True, True) is False,
)
check(
    "a non-vectorized schema never reports an embedding change",
    schema_update._embedding_include_changed(name_only, name_and_notes, False, False) is False,
)

print()
if failures:
    print(f"embeddings-schema-flags: {len(failures)} FAILED")
    for name in failures:
        print(f"  - {name}")
    sys.exit(1)
print("embeddings-schema-flags: ok")
