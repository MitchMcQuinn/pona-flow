"""
Diagnostic test for local LLM config store + option/format normalization.

Covers:
  - create / get / list / replace / delete scoped by space_id;
  - options nulls stripped and stop lists cleaned;
  - response_format requires json_schema when type is json_schema;
  - ConfigNotFound on missing ids.

No Ollama or network. Uses a temp catalog SQLite.

Run: ``.venv/bin/python tests/local-llm-store.py`` from the repo root.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import config  # noqa: E402
from Engine.server import local_llms as llms  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


tmpdir = tempfile.mkdtemp(prefix="local-llm-store-")
db_path = Path(tmpdir) / "catalog.db"
saved_catalog_path = config.catalog_sqlite_path
config.catalog_sqlite_path = lambda: db_path  # type: ignore[assignment]

try:
    check(
        "options drop empties and coerce ints",
        llms.normalize_options(
            {
                "temperature": "0.7",
                "top_k": "40",
                "seed": "",
                "stop": ["END", "", "###"],
                "unknown": 1,
            }
        )
        == {"temperature": 0.7, "top_k": 40, "stop": ["END", "###"]},
    )
    check(
        "text response_format is default",
        llms.normalize_response_format({}) == {"type": "text"},
    )
    try:
        llms.normalize_response_format({"type": "json_schema"})
        check("json_schema without schema raises", False)
    except ValueError:
        check("json_schema without schema raises", True)

    created = llms.create_config(
        "SPACE_A",
        {
            "name": "Classifier",
            "model": "llama3.2",
            "system_prompt": "Be brief.",
            "options": {"temperature": 0.2},
            "response_format": {"type": "text"},
        },
    )
    check("create returns id and fields", bool(created.get("id")) and created["name"] == "Classifier")
    check("create stores options", created["options"] == {"temperature": 0.2})

    listed = llms.list_configs("SPACE_A")
    check("list finds the config", len(listed) == 1 and listed[0]["id"] == created["id"])
    check("list is space-scoped", llms.list_configs("SPACE_B") == [])

    fetched = llms.get_config("SPACE_A", created["id"])
    check("get returns the same config", fetched["model"] == "llama3.2")

    updated = llms.replace_config(
        "SPACE_A",
        created["id"],
        {
            "name": "Classifier v2",
            "model": "mistral",
            "system_prompt": "Be careful.",
            "options": {"top_p": 0.9},
            "response_format": {
                "type": "json_schema",
                "json_schema": {"type": "object", "properties": {"ok": {"type": "boolean"}}},
            },
        },
    )
    check("replace updates name/model", updated["name"] == "Classifier v2" and updated["model"] == "mistral")
    check(
        "replace stores json_schema format",
        updated["response_format"]["type"] == "json_schema"
        and "properties" in (updated["response_format"].get("json_schema") or {}),
    )

    try:
        llms.get_config("SPACE_A", "ID_missing")
        check("missing get raises ConfigNotFound", False)
    except llms.ConfigNotFound:
        check("missing get raises ConfigNotFound", True)

    llms.delete_config("SPACE_A", created["id"])
    check("delete removes the config", llms.list_configs("SPACE_A") == [])
    try:
        llms.delete_config("SPACE_A", created["id"])
        check("second delete raises ConfigNotFound", False)
    except llms.ConfigNotFound:
        check("second delete raises ConfigNotFound", True)

finally:
    config.catalog_sqlite_path = saved_catalog_path  # type: ignore[assignment]

if failures:
    print(f"\n{len(failures)} failure(s): {failures}")
    sys.exit(1)
print("\nAll local-llm-store checks passed.")
