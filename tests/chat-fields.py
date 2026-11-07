#!/usr/bin/env python3
"""Every field a chat proposal can set has a requirement, and an invalid value names that field."""

from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "Engine"))

from server import chat_fields, chat_tools  # noqa: E402


def _propose_kinds() -> tuple[str, ...]:
    for tool in chat_tools.TOOLS:
        function = tool["function"]
        if function["name"] == "propose_change":
            return tuple(function["parameters"]["properties"]["kind"]["enum"])
    raise AssertionError("propose_change is not a tool")


def _operation(**extra: object) -> dict:
    payload = {
        "name": "Example",
        "kind": "operation",
        "operation": "create",
        "node_label": "STEP",
        "attributive_label": "example",
    }
    payload.update(extra)
    return payload


class ChatFieldsTest(unittest.TestCase):
    def test_kinds_match_the_tool(self) -> None:
        self.assertEqual(_propose_kinds(), chat_fields.KINDS)

    def test_every_field_is_set_on_a_valid_sample(self) -> None:
        self.assertEqual(chat_fields.uncovered_fields(), [])

    def test_samples_pass(self) -> None:
        for kind, label, payload in chat_fields.samples():
            problems = chat_fields.payload_problems(kind, payload)
            self.assertEqual(problems, [], label)

    def test_invalid_values_name_the_field(self) -> None:
        missed = [
            (label, path, problems)
            for label, path, problems in chat_fields.invalid_probes()
            if not any(path in problem for problem in problems)
        ]
        self.assertEqual(missed, [])

    def test_unknown_keys_are_named(self) -> None:
        missed = []
        for label, path, problems in chat_fields.unknown_key_probes():
            needle = f"{path}.not_a_field"
            if not any(needle in problem and "is not a field" in problem for problem in problems):
                missed.append((label, path, problems))
        self.assertEqual(missed, [])

    def test_aliases_the_product_already_accepts_still_pass(self) -> None:
        cases = [
            (
                "upsert_query",
                _operation(
                    attributive_label="Log Shipment",
                    http_step={"endpoint": "$url", "method": "post"},
                ),
            ),
            (
                "upsert_query",
                {
                    "name": "Read",
                    "kind": "operation",
                    "operation": "read",
                    "node_label": "INSTANCE",
                    "attributive_label": "person",
                    "where": [{"property_key": "status", "operator": "IS NULL"}],
                },
            ),
            (
                "upsert_credential",
                {"name": "openai"},
            ),
            (
                "upsert_console",
                {
                    "name": "Desk",
                    "document": {
                        "views": [
                            {
                                "kind": "live",
                                "modules": [
                                    {
                                        "type": "Stat",
                                        "data_sequence_id": "READ_OPEN",
                                        "config": {},
                                    }
                                ],
                            }
                        ]
                    },
                },
            ),
            (
                "upsert_event",
                {"name": "Badge-in", "type": "external"},
            ),
        ]
        for kind, payload in cases:
            problems = chat_fields.payload_problems(kind, payload)
            self.assertEqual(problems, [], (kind, problems, payload))

    def test_cross_field_rules_name_the_field(self) -> None:
        schema = {
            "attributive_label": "person",
            "properties": [
                {"name": "id", "value_type": "UID", "is_key": True, "is_label": False},
                {"name": "status", "value_type": "radio", "is_label": True, "options": ["open"]},
            ],
        }
        cases = [
            ("upsert_event", {"name": "Overdue", "type": "time"}, "payload.event_package.groups"),
            (
                "upsert_event",
                {"name": "Overdue", "type": "time", "event_package": {"groups": [{"is_time": "6pm"}]}},
                "payload.event_package.groups[0].is_time",
            ),
            (
                "upsert_query",
                _operation(operation="create", node_label="INSTANCE", attributive_label="person", unwind={"alias": "row", "expressions": ["a", "b"]}),
                "payload.unwind",
            ),
            (
                "upsert_query",
                _operation(
                    operation="create",
                    node_label="INSTANCE",
                    attributive_label="person",
                    instance_properties=[{"key": "kind", "value": "row.kind"}, {"key": "name", "value": "row.name"}],
                ),
                "payload.instance_properties",
            ),
            (
                "upsert_query",
                _operation(http_step={"endpoint": "https://example.test"}, wait_step={"mode": "duration", "duration_seconds": 1}),
                "mutually exclusive",
            ),
            ("upsert_query", _operation(), "needs http_step"),
            ("upsert_query", _operation(execute=True), "payload.execute"),
            (
                "upsert_query",
                _operation(operation="create", node_label="INSTANCE", vector_search={"enabled": True, "text": "kiki", "k": 5}),
                "payload.vector_search",
            ),
            (
                "upsert_query",
                {
                    "name": "Search",
                    "kind": "operation",
                    "operation": "read",
                    "node_label": "INSTANCE",
                    "attributive_label": "person",
                    "return_items": [{"expression": "n.name", "alias": "name"}],
                    "vector_search": {"enabled": True, "text": "kiki", "k": 5},
                },
                "payload.return_items",
            ),
            ("upsert_credential", {"name": "OPENAI", "value": "sk-test"}, "do not send the secret"),
            ("update_chat_model", {"provider": "openai", "api_key": "sk-test"}, "API key"),
            ("upsert_query", _operation(operation="read", node_label="INSTANCE", cypher=["MATCH (n) RETURN n"]), "cypher"),
            (
                "update_role",
                {"name": "Clerk", "permissions": {"flows": ["read"], "sequences": {"all": True, "ids": []}, "manage_space": False}},
                "payload.permissions.flows[0]",
            ),
            (
                "update_role",
                {"name": "Clerk", "permissions": {"flows": ["read:STEP"], "sequences": {"all": True, "ids": []}, "manageSpace": False}},
                "manage_space",
            ),
            (
                "upsert_console",
                {"name": "Desk", "document": {"views": [{"kind": "live", "modules": [{"type": "gauge", "dataSequenceId": "READ"}]}]}},
                "payload.document.views[0].modules[0].type",
            ),
            (
                "upsert_console",
                {"name": "Desk", "document": {"views": [{"kind": "live", "modules": [{"type": "table", "config": {}}]}]}},
                "payload.document.views[0].modules[0].dataSequenceId",
            ),
            (
                "upsert_console",
                {
                    "name": "Desk",
                    "document": {
                        "views": [
                            {
                                "kind": "form",
                                "dataSequenceId": "READ",
                                "actionSequenceId": "READ",
                                "fields": [],
                            }
                        ]
                    },
                },
                "different sequence",
            ),
            (
                "upsert_console",
                {"name": "Desk", "document": {"views": [{"kind": "live", "modules": [{"type": "table", "dataUrl": "https://example.test", "dataSequenceId": "READ", "config": {}}]}]}},
                "dataSequenceId",
            ),
            (
                "upsert_console",
                {
                    "name": "Desk",
                    "document": {
                        "views": [
                            {
                                "kind": "live",
                                "modules": [
                                    {
                                        "type": "line",
                                        "dataSequenceId": "READ",
                                        "config": {"dataPath": "", "categoryKey": "name", "valueKey": "value", "color": "blue"},
                                    }
                                ],
                            }
                        ]
                    },
                },
                "payload.document.views[0].modules[0].config.color",
            ),
            (
                "upsert_query",
                _operation(wait_step={"mode": "until", "until": "tomorrow"}),
                "payload.wait_step.until",
            ),
            (
                "upsert_query",
                _operation(
                    operation_step={
                        "name": "passed",
                        "groups": [{"statements": [{"x": "$secret", "operator": "=", "y": "1"}]}],
                    }
                ),
                "$secret",
            ),
            (
                "upsert_query",
                {"name": "Seed", "kind": "operation", "operation": "create", "node_label": "INSTANCE", "execute": True},
                "payload.attributive_label",
            ),
            ("upsert_schema", {**schema, "properties": [schema["properties"][0], {**schema["properties"][1], "options": []}]}, "payload.properties[1].options"),
            (
                "upsert_schema",
                {
                    "attributive_label": "person",
                    "properties": [
                        {"name": "id", "value_type": "UID", "is_key": True, "is_label": False},
                        {"name": "full_name", "value_type": "string", "is_label": True, "format": "not-a-format"},
                    ],
                },
                "payload.properties[1].format",
            ),
            (
                "upsert_console",
                {
                    "name": "Desk",
                    "document": {"views": [{"kind": "live", "modules": [{"type": "table", "dataSequenceId": "READ", "config": {"dataPath": "", "limit": 5}}]}]},
                },
                "payload.document.views[0].modules[0].config.limit",
            ),
            ("update_embeddings", {"enabled": True, "provider": "gemini"}, "payload.credential"),
            (
                "upsert_query",
                {
                    "name": "Ship",
                    "kind": "sequence",
                    "entry_step": "log_shipment",
                    "loop": {"type": "for", "count": 20, "max_iterations": 3},
                },
                "payload.loop.count",
            ),
            (
                "upsert_query",
                _operation(
                    http_step={
                        "endpoint": "https://example.test",
                        "response_parameters": [
                            {"property_path": "id", "parameter": "remote_id"},
                            {"property_path": "code", "parameter": "remote_id"},
                        ],
                    }
                ),
                "already mapped",
            ),
        ]
        missed = []
        for kind, payload, needle in cases:
            problems = chat_fields.payload_problems(kind, copy.deepcopy(payload))
            if not any(needle in problem for problem in problems):
                missed.append((needle, problems))
        self.assertEqual(missed, [])


if __name__ == "__main__":
    unittest.main()
