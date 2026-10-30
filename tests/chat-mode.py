#!/usr/bin/env python3
"""Chat mode: threads, validate-then-apply batches, and a tool turn that does not write early."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "Engine"))

from fastapi.testclient import TestClient  # noqa: E402

from server import catalog, chat_agent, chat_apply, chat_models, chat_store, chat_tools, config, local_auth, migrations, operation_nav, packages, spaces  # noqa: E402

_NUDGE_MARK = "Do not call another read tool."
from server.app import app  # noqa: E402
from server.auth import Principal  # noqa: E402


class ChatModeTest(unittest.TestCase):
    BASE = "http://127.0.0.1"

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.db_path = Path(self._tmpdir.name) / "catalog.db"
        env = patch.dict(
            os.environ,
            {
                "SQLITE_DATABASE_PATH": str(self.db_path),
                "PONA_FLOW_CATALOG_SQLITE_KEY": "SQLITE_DATABASE_PATH",
                "PONA_FLOW_AUTH_MODE": "local",
                "PONA_FLOW_DISABLE_AUTH": "",
                "PONA_FLOW_ALLOW_OPEN_SIGNUP": "",
                "SUPERADMIN_EMAIL": "",
                "SUPERADMIN_CLERK_ID": "",
                "PONA_FLOW_CHAT_API_KEY": "",
            },
            clear=False,
        )
        env.start()
        self.addCleanup(env.stop)
        catalog_path = patch.object(config, "catalog_sqlite_path", return_value=self.db_path)
        catalog_path.start()
        self.addCleanup(catalog_path.stop)
        # catalog_conn and chat_store remember which files they already ensured.
        catalog._ensured_catalog_paths.discard(str(self.db_path))
        chat_store._ensured_paths.discard(str(self.db_path))
        migrations.run_startup_migrations()
        local_auth.reset_login_throttle()
        self.client = TestClient(app, base_url=self.BASE)
        setup = self.client.post(
            "/api/auth/setup",
            json={"email": "admin@example.com", "password": "a strong password"},
        )
        self.assertEqual(setup.status_code, 200, setup.text)
        me = self.client.get("/api/me").json()
        self.principal = Principal(
            user_id=me["principal_id"],
            clerk_user_id=me["principal_id"],
            email=me.get("email"),
            is_instance_admin=True,
            is_superadmin=True,
            can_create_spaces=True,
        )
        created = self.client.post(
            "/api/spaces/create",
            json={"name": "Home"},
            headers={"Origin": self.BASE},
        )
        self.assertEqual(created.status_code, 200, created.text)
        self.space_id = created.json()["id"]

    def test_new_account_defaults_to_chat_mode(self) -> None:
        self.assertEqual(self.client.get("/api/me").json()["workbench_mode"], "chat")
        saved = self.client.post(
            "/api/me/settings",
            json={"workbench_mode": "classic"},
            headers={"Origin": self.BASE},
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["workbench_mode"], "classic")
        self.assertEqual(self.client.get("/api/me").json()["workbench_mode"], "classic")
        rejected = self.client.post(
            "/api/me/settings",
            json={"workbench_mode": "vibes"},
            headers={"Origin": self.BASE},
        )
        self.assertEqual(rejected.status_code, 400)

    def test_turn_without_a_model_is_rejected(self) -> None:
        response = self.client.post(
            f"/api/spaces/{self.space_id}/chat/turns",
            json={"content": "hello"},
            headers={"Origin": self.BASE},
        )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("not configured", response.json()["error"])

    def test_validation_failure_writes_nothing(self) -> None:
        before = {row["id"] for row in self.client.get("/api/spaces").json()["spaces"]}
        result = chat_apply.apply_batch(
            self.principal,
            self.space_id,
            [chat_apply.normalize_item({"kind": "create_space", "summary": "no name", "payload": {}})],
        )
        self.assertFalse(result["ok"])
        self.assertTrue(result["validation_errors"])
        after = {row["id"] for row in self.client.get("/api/spaces").json()["spaces"]}
        self.assertEqual(before, after)

    def test_accept_creates_a_space(self) -> None:
        item = chat_apply.normalize_item(
            {"kind": "create_space", "summary": "Create Demo", "payload": {"name": "Demo"}}
        )
        result = chat_apply.apply_batch(self.principal, self.space_id, [item])
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["created_space_id"], "DEMO")
        names = {row["id"] for row in self.client.get("/api/spaces").json()["spaces"]}
        self.assertIn("DEMO", names)

    def test_operation_is_filed_as_a_nav_sequence(self) -> None:
        calls: list[dict] = []

        def fake_execute(space_id, cypher, sqlite, params, catalog_row, labels, owners):
            calls.append({"space_id": space_id, "labels": labels, "cypher": cypher, "sqlite": sqlite})
            return {}

        item = chat_apply.normalize_item(
            {
                "kind": "upsert_query",
                "summary": "Count people",
                "payload": {
                    "id": "ID_op_count",
                    "name": "count people",
                    "kind": "operation",
                    "operation": "read",
                    "cypher": [
                        "MATCH (p:INSTANCE { attributive_label: 'person' }) RETURN count(p) AS text"
                    ],
                },
            }
        )
        with patch.object(packages, "execute_create_package", fake_execute):
            result = chat_apply.apply_batch(self.principal, self.space_id, [item])
            self.assertTrue(result["ok"], result)
            again = chat_apply.apply_batch(self.principal, self.space_id, [item])
            self.assertTrue(again["ok"], again)
        sequence = catalog.find_query_by_name("count people")
        self.assertIsNotNone(sequence)
        self.assertEqual(sequence["kind"], "sequence")
        self.assertIn("attributive_label: 'count people'", sequence["cypher"][0])
        operation = catalog.fetch_query_for_compose("ID_op_count")
        self.assertEqual(operation["kind"], "operation")
        named = [
            row
            for row in catalog.fetch_saved_queries()
            if row["kind"] == "sequence" and row["name"] == "count people"
        ]
        self.assertEqual(len(named), 1)
        self.assertEqual(calls[0]["labels"], ["count people"])
        self.assertIn("ID_op_count", calls[0]["sqlite"][0])

    def test_query_cypher_must_open_in_the_builder(self) -> None:
        def problems(cypher: list[str], kind: str = "operation") -> list[str]:
            item = chat_apply.normalize_item(
                {
                    "kind": "upsert_query",
                    "summary": "Count",
                    "payload": {
                        "id": "ID_shape",
                        "name": "shape check",
                        "kind": kind,
                        "operation": "read",
                        "cypher": cypher,
                    },
                }
            )
            return chat_apply.validate_item(self.principal, self.space_id, item)

        piped = problems(
            ["MATCH (n:INSTANCE { attributive_label: 'person' }) WITH n RETURN n"]
        )
        self.assertTrue(any("WITH" in problem for problem in piped), piped)
        custom = problems(["MATCH (p:Person) RETURN p"])
        self.assertTrue(any("attributive_label" in problem for problem in custom), custom)
        stacked = problems(
            [
                "MATCH (a:INSTANCE { attributive_label: 'nurse' }) RETURN a.name AS name "
                "UNION MATCH (b:INSTANCE { attributive_label: 'doctor' }) RETURN b.name AS name"
            ]
        )
        self.assertTrue(any("UNION" in problem for problem in stacked), stacked)
        self.assertEqual(
            problems(
                ["MATCH (p:INSTANCE { attributive_label: 'person' }) WHERE p.at > datetime() RETURN p"]
            ),
            [],
        )

    def test_sequence_label_is_registered_on_the_space(self) -> None:
        item = chat_apply.normalize_item(
            {
                "kind": "upsert_query",
                "summary": "Wait",
                "payload": {
                    "id": "ID_seq_wait",
                    "name": "WAIT",
                    "kind": "sequence",
                    "operation": "read",
                    "cypher": ["MATCH (step:STEP { attributive_label: 'STEP1' }) RETURN *"],
                },
            }
        )
        with patch.object(packages, "execute_create_package", side_effect=AssertionError("no wrap")):
            result = chat_apply.apply_batch(self.principal, self.space_id, [item])
        self.assertTrue(result["ok"], result)
        self.assertIn("STEP1", spaces.fetch_space_labels(self.space_id))

    def test_accepted_chat_operation_is_filed_when_the_space_loads(self) -> None:
        catalog.upsert_queries_catalog_row(
            "ID_op_world",
            "INIT_POPULATION_WORLD",
            ["RETURN 1"],
            [],
            [],
            kind="operation",
            operation="create",
        )
        thread = chat_store.create_thread(self.space_id, self.principal.user_id, "population")
        chat_store.append_message(
            thread["id"],
            "assistant",
            "Saved.",
            batch={
                "status": "accepted",
                "items": [
                    {
                        "kind": "upsert_query",
                        "summary": "Init",
                        "payload": {
                            "id": "ID_op_world",
                            "name": "INIT_POPULATION_WORLD",
                            "kind": "operation",
                            "operation": "create",
                            "cypher": ["RETURN 1"],
                        },
                    }
                ],
            },
        )

        def fake_execute(*_args, **_kwargs):
            return {}

        with patch.object(packages, "execute_create_package", fake_execute):
            operation_nav.publish_chat_operations(self.space_id)
        sequence = catalog.find_query_by_name("INIT_POPULATION_WORLD")
        self.assertEqual(sequence["kind"], "sequence")
        self.assertIn("INIT_POPULATION_WORLD", sequence["cypher"][0])

    def test_apply_stops_after_a_later_failure(self) -> None:
        calls = {"n": 0}
        real = catalog.upsert_console

        def flaky(*args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("disk full")
            return real(*args, **kwargs)

        items = [
            chat_apply.normalize_item(
                {
                    "kind": "upsert_console",
                    "summary": "First",
                    "payload": {"name": "First", "id": "ID_console_one"},
                }
            ),
            chat_apply.normalize_item(
                {
                    "kind": "upsert_console",
                    "summary": "Second",
                    "payload": {"name": "Second", "id": "ID_console_two"},
                }
            ),
            chat_apply.normalize_item(
                {
                    "kind": "upsert_console",
                    "summary": "Third",
                    "payload": {"name": "Third", "id": "ID_console_three"},
                }
            ),
        ]
        with patch.object(catalog, "upsert_console", flaky):
            result = chat_apply.apply_batch(self.principal, self.space_id, items)
        self.assertFalse(result["ok"])
        self.assertEqual([entry["summary"] for entry in result["applied"]], ["First"])
        self.assertEqual(result["failed"]["summary"], "Second")
        self.assertIn("disk full", result["failed"]["error"])
        self.assertEqual([entry["summary"] for entry in result["not_applied"]], ["Third"])
        self.assertIsNotNone(catalog.get_console("ID_console_one"))
        self.assertIsNone(catalog.get_console("ID_console_three"))

    def test_agent_queues_a_space_until_accept(self) -> None:
        def complete(_cfg, _key, messages, _tools):
            if not any(message.get("role") == "tool" for message in messages):
                yield {
                    "type": "tool_call",
                    "id": "call_1",
                    "name": "propose_change",
                    "arguments": {
                        "kind": "create_space",
                        "summary": "Create Queued",
                        "payload": {"name": "Queued"},
                    },
                }
                return
            yield {"type": "text", "delta": "Ready for you to confirm."}

        events = list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="make a space called Queued",
                thread_id=None,
                model=({"provider": "openai", "model": "test", "base_url": ""}, "test-key"),
                complete=complete,
            )
        )
        kinds = [event["event"] for event in events]
        self.assertIn("batch", kinds)
        self.assertIn("done", kinds)
        names = {row["id"] for row in self.client.get("/api/spaces").json()["spaces"]}
        self.assertNotIn("QUEUED", names)
        thread_id = next(event["data"]["thread_id"] for event in events if event["event"] == "start")
        accepted = self.client.post(
            f"/api/spaces/{self.space_id}/chat/threads/{thread_id}/batch/accept",
            headers={"Origin": self.BASE},
        )
        self.assertEqual(accepted.status_code, 200, accepted.text)
        self.assertEqual(accepted.json()["created_space_id"], "QUEUED")

    def test_tool_only_turn_asks_for_a_reply(self) -> None:
        def complete(_cfg, _key, messages, _tools):
            last = messages[-1] if messages else {}
            if _NUDGE_MARK in str(last.get("content") or ""):
                yield {"type": "text", "delta": "The space is empty. I can propose the schemas next."}
                return
            yield {
                "type": "tool_call",
                "id": "call_read",
                "name": "list_catalog",
                "arguments": {},
            }

        events = list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="design a small world",
                thread_id=None,
                model=({"provider": "openai", "model": "test", "base_url": ""}, "test-key"),
                complete=complete,
            )
        )
        text = "".join(
            event["data"].get("delta", "") for event in events if event["event"] == "text"
        )
        self.assertIn("propose the schemas", text)
        self.assertIn("done", [event["event"] for event in events])

    def test_max_rounds_is_clamped_and_shown(self) -> None:
        saved = chat_store.set_chat_model(self.space_id, {"provider": "platform", "max_rounds": 99})
        self.assertEqual(saved["max_rounds"], 48)
        saved = chat_store.set_chat_model(self.space_id, {"max_rounds": 1})
        self.assertEqual(saved["max_rounds"], 4)
        self.assertEqual(chat_store.get_chat_model(self.space_id)["max_rounds"], 4)

        def complete(_cfg, _key, messages, _tools):
            last = messages[-1] if messages else {}
            if _NUDGE_MARK in str(last.get("content") or ""):
                yield {"type": "text", "delta": "Done looking."}
                return
            yield {"type": "tool_call", "id": "call_read", "name": "list_catalog", "arguments": {}}

        events = list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="look around",
                thread_id=None,
                model=({"provider": "openai", "model": "test", "base_url": "", "max_rounds": 4}, "test-key"),
                complete=complete,
            )
        )
        rounds = [event["data"] for event in events if event["event"] == "round"]
        self.assertEqual(rounds, [{"index": 1, "max": 4}, {"index": 2, "max": 4}, {"index": 3, "max": 4}, {"index": 4, "max": 4}])
        tools = [event["data"] for event in events if event["event"] == "tool"]
        self.assertTrue(all(tool.get("read_index") == index for index, tool in enumerate(tools[:4])))
        kinds = [event["data"]["item"]["kind"] for event in events if event["event"] in ("canvas", "canvas_update")]
        self.assertIn("reasoning", kinds)
        self.assertIn("reads", kinds)
        thread_id = next(event["data"]["thread_id"] for event in events if event["event"] == "start")
        thread = chat_store.get_thread(thread_id, self.space_id, self.principal.user_id)
        self.assertIsNotNone(thread)
        self.assertIsNone(thread["active_stack_item_id"])
        assistant = next(message for message in reversed(thread["messages"]) if message["role"] == "assistant")
        reasoning = next(item for item in thread["stack"] if item["kind"] == "reasoning")
        reads = next(item for item in thread["stack"] if item["kind"] == "reads")
        self.assertEqual(reasoning["payload"]["message_id"], assistant["id"])
        self.assertEqual(reads["payload"]["message_id"], assistant["id"])

    def test_propose_change_keeps_field_annotations(self) -> None:
        proposals: list = []
        result = chat_tools.execute(
            "propose_change",
            {
                "kind": "upsert_event",
                "summary": "External webhook event for nurse-call unit badge-in auto-assignment",
                "note": "Badge-in from the nurse-call unit starts assignment.",
                "pins": [
                    {"target": "event_type", "note": "External, because the unit posts a webhook."},
                    {"target": "filters", "note": ""},
                ],
                "payload": {
                    "name": "Nurse call badge-in",
                    "type": "external",
                    "sequences": ["assign-nurse"],
                    "external_package": {
                        "filters": [{"path": "event", "operator": "equals", "value": "badge-in"}]
                    },
                },
            },
            self.principal,
            self.space_id,
            proposals,
        )
        self.assertTrue(result.result["ok"], result.result)
        self.assertEqual(proposals[0]["note"], "Badge-in from the nurse-call unit starts assignment.")
        self.assertEqual(proposals[0]["pins"], [
            {"target": "event_type", "note": "External, because the unit posts a webhook."}
        ])
        self.assertEqual(proposals[0]["payload"]["type"], "external")
        self.assertEqual(
            proposals[0]["payload"]["external_package"]["filters"][0]["value"],
            "badge-in",
        )

    def test_proposal_turn_does_not_open_a_console(self) -> None:
        def complete(_cfg, _key, messages, _tools):
            if not any(message.get("role") == "tool" for message in messages):
                yield {
                    "type": "tool_call",
                    "id": "call_console",
                    "name": "open_ephemeral_console",
                    "arguments": {"title": "Floor", "modules": []},
                }
                yield {
                    "type": "tool_call",
                    "id": "call_walk",
                    "name": "show_walkthrough",
                    "arguments": {
                        "title": "Design",
                        "frames": [
                            {
                                "view": "console",
                                "title": "Floor",
                                "document": json.dumps({"views": []}),
                            },
                            {
                                "view": "event",
                                "title": "Badge-in",
                                "document": json.dumps({"name": "Badge-in", "event_type": "external"}),
                            },
                        ],
                    },
                }
                yield {
                    "type": "tool_call",
                    "id": "call_change",
                    "name": "propose_change",
                    "arguments": {
                        "kind": "upsert_event",
                        "summary": "External webhook event for nurse-call unit badge-in auto-assignment",
                        "note": "The unit posts badge-in here.",
                        "pins": [{"target": "name", "note": "Name the event for the unit."}],
                        "payload": {"name": "Nurse call badge-in", "type": "external"},
                    },
                }
                return
            yield {"type": "text", "delta": "Review the proposal before anything is saved."}

        events = list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="set up nurse call badge-in",
                thread_id=None,
                model=({"provider": "openai", "model": "test", "base_url": ""}, "test-key"),
                complete=complete,
            )
        )
        canvases = [event["data"]["item"] for event in events if event["event"] == "canvas"]
        kinds = [item["kind"] for item in canvases]
        self.assertNotIn("ephemeral_console", kinds)
        self.assertNotIn("saved_console", kinds)
        walkthroughs = [item for item in canvases if item["kind"] == "walkthrough"]
        self.assertEqual(len(walkthroughs), 1)
        views = [frame["view"] for frame in walkthroughs[0]["payload"]["frames"]]
        self.assertEqual(views, ["event"])
        proposal = next(item for item in canvases if item["kind"] == "proposal")
        self.assertEqual(proposal["payload"]["items"][0]["note"], "The unit posts badge-in here.")
        self.assertEqual(proposal["payload"]["items"][0]["pins"][0]["target"], "name")
        self.assertEqual(kinds[-1], "proposal")

    def test_console_still_opens_when_nothing_is_proposed(self) -> None:
        def complete(_cfg, _key, messages, _tools):
            if not any(message.get("role") == "tool" for message in messages):
                yield {
                    "type": "tool_call",
                    "id": "call_console",
                    "name": "open_ephemeral_console",
                    "arguments": {"title": "Floor", "modules": []},
                }
                return
            yield {"type": "text", "delta": "The floor console is open."}

        events = list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="open a floor console",
                thread_id=None,
                model=({"provider": "openai", "model": "test", "base_url": ""}, "test-key"),
                complete=complete,
            )
        )
        kinds = [event["data"]["item"]["kind"] for event in events if event["event"] == "canvas"]
        self.assertIn("ephemeral_console", kinds)
        self.assertNotIn("proposal", kinds)

    def test_walkthrough_does_not_queue_a_change(self) -> None:
        proposals: list = []
        result = chat_tools.execute(
            "show_walkthrough",
            {
                "title": "Customers",
                "frames": [
                    {
                        "view": "workbench",
                        "title": "Schema",
                        "note": "Customers",
                        "pins": [{"target": "full_name", "note": "Display name"}],
                        "document": {"operation": "create", "name": "customer"},
                    }
                ],
            },
            self.principal,
            self.space_id,
            proposals,
        )
        self.assertEqual(proposals, [])
        self.assertIsNone(result.proposal)
        self.assertTrue(result.result["ok"])
        self.assertEqual(result.canvases[0]["kind"], "walkthrough")
        self.assertEqual(result.canvases[0]["payload"]["frames"][0]["pins"][0]["target"], "full_name")
        encoded = chat_tools.execute(
            "show_walkthrough",
            {
                "frames": [
                    {
                        "view": "event",
                        "document": json.dumps({"name": "Nightly", "event_type": "time"}),
                    }
                ]
            },
            self.principal,
            self.space_id,
            proposals,
        )
        self.assertEqual(encoded.canvases[0]["payload"]["frames"][0]["document"]["name"], "Nightly")

    def test_upsert_schema_is_a_change_kind(self) -> None:
        import sqlite3

        from server import spaces

        item = chat_apply.normalize_item(
            {
                "kind": "upsert_schema",
                "summary": "Add customer",
                "payload": {
                    "attributive_label": "Customer",
                    "properties": [
                        {"key": "Full Name", "value_type": "string", "is_label": True}
                    ],
                },
            }
        )
        self.assertEqual(item["payload"]["attributive_label"], "customer")
        names = [prop["name"] for prop in item["payload"]["properties"]]
        self.assertEqual(names, ["id", "full_name"])
        with patch("server.chat_apply.graph.attributive_label_owner_ids", return_value=set()):
            self.assertEqual(
                chat_apply.validate_item(self.principal, self.space_id, item), []
            )
        db_path = Path(self._tmpdir.name) / "schema-entities.db"
        conn = sqlite3.connect(db_path)
        spaces._ensure_entities_schema(conn)
        conn.commit()
        conn.close()

        def open_entities(_space_id: str) -> sqlite3.Connection:
            return sqlite3.connect(db_path)
        statements: list[str] = []

        def record(_space_id: str, statement: str, _params: dict) -> dict:
            statements.append(statement)
            return {"records": []}

        with patch("server.chat_apply.graph.attributive_label_owner_ids", return_value=set()), patch(
            "server.chat_apply.graph.run_cypher_for_space", side_effect=record
        ), patch("server.chat_apply.spaces.connect_sqlite_for_space", side_effect=open_entities):
            applied = chat_apply._apply_one(self.principal, self.space_id, item)
        self.assertEqual(applied["attributive_label"], "customer")
        self.assertTrue(statements and statements[0].startswith("CREATE (n:SCHEMA"))
        saved = sqlite3.connect(db_path)
        row = saved.execute(
            "SELECT node_label, common_label, payload FROM entities"
        ).fetchone()
        saved.close()
        self.assertEqual((row[0], row[1]), ("SCHEMA", "customer"))
        stored = [entry["property_schema"]["name"] for entry in json.loads(row[2])["schemata"]]
        self.assertEqual(stored, ["id", "full_name"])
        with self.assertRaises(ValueError):
            chat_apply.normalize_item(
                {
                    "kind": "upsert_schema",
                    "payload": {
                        "attributive_label": "other",
                        "properties": [{"key": "id", "value_type": "string"}],
                    },
                }
            )

    def test_follow_up_after_accept_stays_hidden_and_asks_for_a_next_step(self) -> None:
        seen: dict[str, list] = {}

        def complete(_cfg, _key, messages, _tools):
            seen["messages"] = messages
            yield {"type": "text", "delta": "The schema is in. Want me to add a console for it?"}

        content = (
            "[[pona-follow-up]]\n"
            "The user accepted the proposed changes and they have been applied.\n"
            "Applied: Person schema.\n"
            "Continue the conversation. Ask one question."
        )
        events = list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content=content,
                thread_id=None,
                model=({"provider": "openai", "model": "test", "base_url": ""}, "test-key"),
                complete=complete,
            )
        )
        text = "".join(event["data"].get("delta", "") for event in events if event["event"] == "text")
        self.assertIn("console", text)
        shown = [message.get("content") or "" for message in seen["messages"]]
        self.assertTrue(any("accepted the proposed changes" in item for item in shown))
        self.assertFalse(any("[[pona-follow-up]]" in item for item in shown))
        start = next(event for event in events if event["event"] == "start")
        self.assertEqual(start["data"]["title"], "Next step")
        thread = chat_store.get_thread(start["data"]["thread_id"], self.space_id, self.principal.user_id)
        self.assertIsNotNone(thread)
        stored = thread["messages"][0]["content"]
        self.assertTrue(stored.startswith("[[pona-follow-up]]"))


class GeminiToolSchemaTest(unittest.TestCase):
    def test_declarations_omit_additional_properties(self) -> None:
        declarations = chat_models._gemini_declarations(chat_tools.TOOLS)
        encoded = json.dumps(declarations)
        self.assertNotIn("additionalProperties", encoded)
        self.assertGreaterEqual(len(declarations), 5)
        self.assertEqual(declarations[0]["parameters"]["type"], "object")
        self._assert_arrays_have_items(declarations)

    def _assert_arrays_have_items(self, node: object, path: str = "declarations") -> None:
        if isinstance(node, dict):
            if node.get("type") == "array":
                self.assertIsInstance(node.get("items"), dict, path)
            for key, value in node.items():
                self._assert_arrays_have_items(value, f"{path}.{key}")
        elif isinstance(node, list):
            for index, value in enumerate(node):
                self._assert_arrays_have_items(value, f"{path}[{index}]")

    def test_function_calls_keep_thought_signatures(self) -> None:
        _system, contents = chat_models._gemini_contents(
            [
                {"role": "user", "content": "What is in this space?"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "gemini_0",
                            "name": "describe_space",
                            "arguments": {},
                            "thought_signature": "sig-a",
                        },
                        {"id": "gemini_1", "name": "list_schemas", "arguments": {}},
                    ],
                },
                {"role": "tool", "name": "describe_space", "tool_call_id": "gemini_0", "content": "{}"},
                {"role": "tool", "name": "list_schemas", "tool_call_id": "gemini_1", "content": "[]"},
            ]
        )
        model = contents[1]
        self.assertEqual(model["role"], "model")
        self.assertEqual(model["parts"][0]["thoughtSignature"], "sig-a")
        self.assertNotIn("thoughtSignature", model["parts"][1])
        self.assertNotIn("id", model["parts"][0]["functionCall"])
        replies = contents[2]
        self.assertEqual(replies["role"], "user")
        self.assertEqual(
            [part["functionResponse"]["name"] for part in replies["parts"]],
            ["describe_space", "list_schemas"],
        )

    def test_empty_candidate_with_a_block_reason_raises(self) -> None:
        payload = {
            "candidates": [{"finishReason": "SAFETY", "content": {"role": "model", "parts": []}}]
        }
        with patch.object(chat_models, "_post_json", return_value=json.dumps(payload).encode()):
            with self.assertRaises(RuntimeError) as caught:
                chat_models._gemini(
                    {"model": "gemini-3.8-flash"},
                    "key",
                    [{"role": "user", "content": "hi"}],
                    [],
                )
        self.assertIn("SAFETY", str(caught.exception))

    def test_empty_stop_is_not_an_error(self) -> None:
        payload = {
            "candidates": [{"finishReason": "STOP", "content": {"role": "model", "parts": []}}]
        }
        with patch.object(chat_models, "_post_json", return_value=json.dumps(payload).encode()):
            parsed = chat_models._gemini(
                {"model": "gemini-3.8-flash"},
                "key",
                [{"role": "user", "content": "hi"}],
                [],
            )
        self.assertEqual(parsed["text"], "")
        self.assertEqual(parsed["tool_calls"], [])

    def test_thought_summaries_stay_out_of_the_reply(self) -> None:
        payload = {
            "candidates": [
                {
                    "finishReason": "STOP",
                    "content": {
                        "role": "model",
                        "parts": [
                            {"text": "scratch", "thought": True},
                            {"text": "hello"},
                        ],
                    },
                }
            ]
        }
        with patch.object(chat_models, "_post_json", return_value=json.dumps(payload).encode()) as posted:
            parsed = chat_models._gemini(
                {"model": "gemini-3.8-flash"},
                "key",
                [{"role": "user", "content": "hi"}],
                chat_tools.TOOLS,
            )
        body = posted.call_args.args[1]
        self.assertTrue(body["generationConfig"]["thinkingConfig"]["includeThoughts"])
        self.assertEqual(parsed["text"], "hello")
        self.assertEqual(parsed["thought"], "scratch")


if __name__ == "__main__":
    unittest.main()
