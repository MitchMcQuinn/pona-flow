"""
Diagnostic test for Local LLM STEP execution and payload round-trip.

Covers:
  - ``_execute_local_llm_step`` requires ``prompt`` in resolved params;
  - run uses the saved config's model/system/options (via stubbed Ollama generate);
  - optional override parameters (system prompt, sampling options, response format,
    JSON schema) replace the saved config for one run, including type coercion,
    option merging, and the failure messages for a bad format/schema;
  - ``_execute_step`` routes ``kind=local_llm``;
  - compose ``_build_step`` preserves ``kind`` + ``config_id`` and declares ``prompt``
    plus every override parameter;
  - entity payload shape ``{kind, config_id}`` (via local_llms store + compose helpers).

No network: Ollama and catalog are stubbed / temp SQLite.

Run: ``.venv/bin/python tests/local-llm-step.py`` from the repo root.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import config  # noqa: E402
from Engine.server import execution_compose as compose  # noqa: E402
from Engine.server import execution_run as run  # noqa: E402
from Engine.server import local_llms as llms  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


tmpdir = tempfile.mkdtemp(prefix="local-llm-step-")
db_path = Path(tmpdir) / "catalog.db"
saved_catalog_path = config.catalog_sqlite_path
config.catalog_sqlite_path = lambda: db_path  # type: ignore[assignment]

generate_calls: list[dict[str, Any]] = []


def fake_generate(**kwargs: Any) -> dict[str, Any]:
    generate_calls.append(kwargs)
    return {
        "model": kwargs["model"],
        "response": '{"label":"ok"}',
        "done_reason": "stop",
        "eval_count": 12,
    }


llms.generate = fake_generate  # type: ignore[assignment]
llms._ollama_base_url = lambda space_id: "http://127.0.0.1:11434"  # type: ignore[assignment]

try:
    cfg = llms.create_config(
        "SPACE_A",
        {
            "name": "Labeler",
            "model": "llama3.2",
            "system_prompt": "Return JSON.",
            "options": {"temperature": 0.1},
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "type": "object",
                    "properties": {"label": {"type": "string"}},
                },
            },
        },
    )

    missing = run._execute_local_llm_step(
        "SPACE_A",
        {"id": "ID_step", "kind": "local_llm", "config_id": cfg["id"]},
        {},
    )
    check("missing prompt fails clearly", missing.get("_ok") is False and "prompt" in str(missing.get("_error")))

    empty = run._execute_local_llm_step(
        "SPACE_A",
        {"id": "ID_step", "kind": "local_llm", "config_id": cfg["id"]},
        {"prompt": "   "},
    )
    check("blank prompt fails", empty.get("_ok") is False)

    out = run._execute_local_llm_step(
        "SPACE_A",
        {"id": "ID_step", "kind": "local_llm", "config_id": cfg["id"]},
        {"prompt": "classify this"},
    )
    check("run succeeds", out.get("_ok") is True)
    check("response text present", out.get("response") == '{"label":"ok"}')
    check("parsed JSON when schema mode", out.get("parsed") == {"label": "ok"})
    check("one generate call", len(generate_calls) == 1)
    call = generate_calls[0]
    check("generate uses config model", call.get("model") == "llama3.2")
    check("generate uses config system", call.get("system") == "Return JSON.")
    check("generate uses prompt param", call.get("prompt") == "classify this")
    check("generate passes format schema", isinstance(call.get("format_payload"), dict))
    check(
        "generate passes temperature option",
        (call.get("options") or {}).get("temperature") == 0.1,
    )

    routed = run._execute_step(
        "SPACE_A",
        {"id": "ID_step", "kind": "local_llm", "config_id": cfg["id"]},
        {"prompt": "again"},
    )
    check("_execute_step routes local_llm", routed.get("_ok") is True and len(generate_calls) == 2)

    # --- parameter overrides -------------------------------------------------
    step = {"id": "ID_step", "kind": "local_llm", "config_id": cfg["id"]}

    def run_step(resolved: dict[str, Any]) -> dict[str, Any]:
        return run._execute_local_llm_step("SPACE_A", step, resolved)

    def last_call() -> dict[str, Any]:
        """The kwargs of the most recent (stubbed) Ollama generate call."""
        return generate_calls[-1]

    blank = run._local_llm_overrides({"prompt": "p", "temperature": "", "seed": None})
    check("blank overrides are dropped", blank == {})

    run_step({"prompt": "p", "top_p": "0.5"})
    check(
        "option override merges over the saved config",
        (last_call().get("options") or {}) == {"temperature": 0.1, "top_p": 0.5},
    )

    run_step({"prompt": "p", "temperature": "0.9", "num_ctx": "4096"})
    opts = last_call().get("options") or {}
    check("number override coerced from string", opts.get("temperature") == 0.9)
    check("integer override coerced from string", opts.get("num_ctx") == 4096)
    check("saved option kept when not overridden", "top_p" not in opts)

    run_step({"prompt": "p", "stop": "END, ###"})
    check(
        "stop accepts a comma-separated string",
        (last_call().get("options") or {}).get("stop") == ["END", "###"],
    )

    run_step({"prompt": "p", "stop": ["A", "B"]})
    check(
        "stop accepts a list",
        (last_call().get("options") or {}).get("stop") == ["A", "B"],
    )

    run_step({"prompt": "p", "system_prompt": "Be terse."})
    check("system_prompt override replaces the config", last_call().get("system") == "Be terse.")
    run_step({"prompt": "p", "system_prompt": "   "})
    check("blank system_prompt keeps the config", last_call().get("system") == "Return JSON.")

    text_mode = run_step({"prompt": "p", "response_format": "text"})
    check("response_format text suppresses the saved schema", last_call().get("format_payload") is None)
    check("text mode does not parse the response", text_mode.get("parsed") is None)

    schema_text = '{"type": "object", "properties": {"label": {"type": "number"}}}'
    override_schema = run_step({"prompt": "p", "json_schema": schema_text})
    check(
        "json_schema override implies schema mode",
        last_call().get("format_payload") == json.loads(schema_text),
    )
    check("schema mode parses the response", override_schema.get("parsed") == {"label": "ok"})

    run_step({"prompt": "p", "response_format": "json_schema", "json_schema": schema_text})
    check(
        "explicit json_schema mode uses the override schema",
        last_call().get("format_payload") == json.loads(schema_text),
    )

    run_step({"prompt": "p", "response_format": "json_schema"})
    check(
        "json_schema mode falls back to the config schema",
        (last_call().get("format_payload") or {}).get("properties", {}).get("label")
        == {"type": "string"},
    )

    calls_before = len(generate_calls)
    bad_json = run_step({"prompt": "p", "json_schema": "{not json"})
    check(
        "malformed json_schema fails clearly",
        bad_json.get("_ok") is False and "json_schema" in str(bad_json.get("_error")),
    )
    bad_format = run_step({"prompt": "p", "response_format": "yaml"})
    check(
        "unknown response_format fails clearly",
        bad_format.get("_ok") is False and "response_format" in str(bad_format.get("_error")),
    )
    check("failed overrides never call Ollama", len(generate_calls) == calls_before)

    text_cfg = llms.create_config(
        "SPACE_A", {"name": "Plain", "model": "llama3.2", "response_format": {"type": "text"}}
    )
    no_schema = run._execute_local_llm_step(
        "SPACE_A",
        {"id": "ID_step2", "kind": "local_llm", "config_id": text_cfg["id"]},
        {"prompt": "p", "response_format": "json_schema"},
    )
    check(
        "json_schema mode without any schema fails clearly",
        no_schema.get("_ok") is False and "json_schema" in str(no_schema.get("_error")),
    )

    built = compose._build_step(
        "ID_step",
        {
            "payload": {
                "kind": "local_llm",
                "config_id": cfg["id"],
                "response_parameters": [
                    {"property_path": "$.response", "parameter": "answer"}
                ],
            },
            "parameters": [],
        },
        {},
    )
    check("compose sets kind local_llm", built.get("kind") == "local_llm")
    check("compose sets config_id", built.get("config_id") == cfg["id"])
    prompt_params = [
        p for p in (built.get("parameters") or []) if isinstance(p, dict) and p.get("name") == "prompt"
    ]
    check("compose injects required prompt param", len(prompt_params) == 1 and prompt_params[0].get("is_required") is True)

    by_name = {
        str(p.get("name")): p
        for p in (built.get("parameters") or [])
        if isinstance(p, dict)
    }
    check(
        "compose injects every override param",
        all(key in by_name for key in llms.OVERRIDE_KEYS),
    )
    check(
        "override params are optional",
        all(by_name[key].get("is_required") is False for key in llms.OVERRIDE_KEYS),
    )
    check(
        "override value types are declared",
        by_name["system_prompt"].get("value_type") == "string"
        and by_name["temperature"].get("value_type") == "number"
        and by_name["num_ctx"].get("value_type") == "integer"
        and by_name["stop"].get("value_type") == "array"
        and by_name["json_schema"].get("value_type") == "string",
    )
    check(
        "response_format is a radio with both choices",
        by_name["response_format"].get("value_type") == "radio"
        and by_name["response_format"].get("options") == ["text", "json_schema"],
    )

    built_with_optional = compose._build_step(
        "ID_step",
        {
            "payload": {"kind": "local_llm", "config_id": cfg["id"]},
            "parameters": [
                {"name": "prompt", "value_type": "string", "is_required": False},
                {"name": "temperature", "value_type": "string", "is_required": True, "value": "0.2"},
            ],
        },
        {},
    )
    saved = {
        str(p.get("name")): p
        for p in (built_with_optional.get("parameters") or [])
        if isinstance(p, dict)
    }
    check(
        "compose forces prompt required even if saved optional",
        saved["prompt"].get("is_required") is True,
    )
    check(
        "compose forces an override optional and re-types it",
        saved["temperature"].get("is_required") is False
        and saved["temperature"].get("value_type") == "number",
    )
    check(
        "an author-saved override default is preserved",
        saved["temperature"].get("default_value") == "0.2",
    )
    check(
        "override params are not duplicated",
        len([p for p in (built_with_optional.get("parameters") or []) if p.get("name") == "temperature"])
        == 1,
    )

    # Payload shape the composer writes (mirrors App/composer stepEntityPayload).
    payload = {
        "kind": "local_llm",
        "config_id": cfg["id"],
        "response_parameters": [{"property_path": "$.parsed", "parameter": "obj"}],
    }
    check(
        "entity payload round-trips through JSON",
        json.loads(json.dumps(payload))["kind"] == "local_llm"
        and json.loads(json.dumps(payload))["config_id"] == cfg["id"],
    )

finally:
    config.catalog_sqlite_path = saved_catalog_path  # type: ignore[assignment]

if failures:
    print(f"\n{len(failures)} failure(s): {failures}")
    sys.exit(1)
print("\nAll local-llm-step checks passed.")
