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

from server import catalog, chat_agent, chat_apply, chat_models, chat_store, chat_tools, config, console_service, local_auth, migrations, operation_nav, packages, spaces  # noqa: E402

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

    def test_cypher_upsert_is_rejected(self) -> None:
        item = chat_apply.normalize_item(
            {
                "kind": "upsert_query",
                "summary": "Count people",
                "payload": {
                    "name": "count people",
                    "kind": "operation",
                    "operation": "read",
                    "node_label": "INSTANCE",
                    "cypher": [
                        "MATCH (p:INSTANCE { attributive_label: 'person' }) RETURN count(p) AS text"
                    ],
                },
            }
        )
        problems = chat_apply.validate_item(self.principal, self.space_id, item)
        self.assertTrue(any("cypher" in problem for problem in problems), problems)
        for escape in ("sqlite", "builder_config", "query"):
            escaped = chat_apply.normalize_item(
                {
                    "kind": "upsert_query",
                    "summary": "Count people",
                    "payload": {
                        "name": "count people",
                        "kind": "operation",
                        "operation": "read",
                        "node_label": "INSTANCE",
                        escape: ["MATCH (n) RETURN n"],
                    },
                }
            )
            refused = chat_apply.validate_item(self.principal, self.space_id, escaped)
            self.assertTrue(any(escape in problem for problem in refused), refused)

    def test_builder_intent_waits_for_the_browser(self) -> None:
        operation = chat_apply.normalize_item(
            {
                "kind": "upsert_query",
                "summary": "Log shipment",
                "payload": {
                    "name": "Log shipment",
                    "kind": "operation",
                    "operation": "create",
                    "node_label": "STEP",
                    "attributive_label": "log shipment",
                    "http_step": {"endpoint": "https://example.test/shipments", "method": "POST"},
                },
            }
        )
        sequence = chat_apply.normalize_item(
            {
                "kind": "upsert_query",
                "summary": "Ship it",
                "payload": {
                    "name": "Ship it",
                    "kind": "sequence",
                    "entry_step": "log shipment",
                    "traversal": "downstream",
                },
            }
        )
        transition = chat_apply.normalize_item(
            {
                "kind": "create_transition",
                "summary": "then pack",
                "payload": {"from_step": "log shipment", "to_step": "pack shipment"},
            }
        )
        for item in (operation, sequence, transition):
            self.assertEqual(chat_apply.validate_item(self.principal, self.space_id, item), [], item)
        self.assertEqual(operation["payload"]["attributive_label"], "log_shipment")
        self.assertEqual(sequence["payload"]["entry_step"], "log_shipment")
        console = chat_apply.normalize_item(
            {
                "kind": "upsert_console",
                "summary": "Desk",
                "payload": {"name": "Desk", "id": "ID_console_desk"},
            }
        )
        result = chat_apply.apply_batch(
            self.principal, self.space_id, [operation, transition, sequence, console]
        )
        self.assertTrue(result["ok"], result)
        self.assertFalse(result["finished"])
        self.assertEqual(
            [item["kind"] for item in result["authoring_pending"]],
            ["upsert_query", "upsert_query", "create_transition"],
        )
        self.assertIsNone(catalog.find_query_by_name("Log shipment"))
        self.assertIsNone(catalog.find_query_by_name("Ship it"))
        self.assertIsNone(catalog.get_console("ID_console_desk"))
        with self.assertRaises(ValueError):
            chat_apply._apply_one(self.principal, self.space_id, operation)

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

    def test_a_feed_names_where_each_input_lands(self) -> None:
        event = chat_apply.normalize_item(
            {
                "kind": "upsert_event",
                "summary": "Badge-in",
                "payload": {"name": "Badge-in", "type": "external"},
            }
        )
        missing = chat_apply.input_inventory_problems([event])
        self.assertTrue(missing)
        self.assertIn("does not name its inputs", missing[0])

        described = chat_apply.normalize_item(
            {
                "kind": "upsert_event",
                "summary": "Badge-in",
                "payload": {"name": "Badge-in", "type": "external"},
                "inputs": [{"name": "badge-in", "source": "simulated", "lands_as": "simulated_event"}],
            }
        )
        mismatched = chat_apply.input_inventory_problems([described])
        self.assertTrue(any("external" in problem for problem in mismatched))

        live = chat_apply.normalize_item(
            {
                "kind": "upsert_event",
                "summary": "Badge-in",
                "payload": {"name": "Badge-in", "type": "external"},
                "inputs": [{"name": "badge-in", "source": "external", "lands_as": "external_event"}],
            }
        )
        self.assertEqual(chat_apply.input_inventory_problems([live]), [])

        clock = chat_apply.normalize_item(
            {
                "kind": "upsert_event",
                "summary": "6pm",
                "payload": {"name": "Overdue", "type": "time"},
                "inputs": [{"name": "6pm", "source": "clock", "lands_as": "time_event"}],
            }
        )
        self.assertEqual(chat_apply.input_inventory_problems([clock]), [])

        form = {
            "views": [
                {
                    "id": "live",
                    "kind": "live",
                    "modules": [{"id": "m", "type": "form", "title": "File"}],
                }
            ]
        }
        console = chat_apply.normalize_item(
            {
                "kind": "upsert_console",
                "summary": "Desk",
                "payload": {"name": "Desk", "document": form},
            }
        )
        self.assertTrue(chat_apply.input_inventory_problems([console]))
        console["inputs"] = [{"name": "phone call", "source": "person", "lands_as": "console"}]
        self.assertEqual(chat_apply.input_inventory_problems([console]), [])

        display = chat_apply.normalize_item(
            {
                "kind": "upsert_console",
                "summary": "Board",
                "payload": {
                    "name": "Board",
                    "document": {
                        "views": [
                            {
                                "id": "live",
                                "kind": "live",
                                "modules": [{"id": "m", "type": "table", "title": "Open"}],
                            }
                        ]
                    },
                },
            }
        )
        self.assertEqual(chat_apply.input_inventory_problems([display]), [])

    def test_implied_inputs_cover_a_seed_a_simulation_and_a_console(self) -> None:
        form = {
            "views": [
                {
                    "id": "control",
                    "kind": "live",
                    "modules": [{"id": "reset", "type": "button", "title": "Reset"}],
                }
            ]
        }
        items = [
            chat_apply.normalize_item(
                {
                    "kind": "upsert_query",
                    "summary": "Seed founding kikis",
                    "payload": {
                        "name": "seed_ecosystem_entities",
                        "kind": "operation",
                        "operation": "create",
                        "node_label": "INSTANCE",
                        "execute": True,
                    },
                }
            ),
            chat_apply.normalize_item(
                {
                    "kind": "upsert_event",
                    "summary": "Generation tick",
                    "payload": {"name": "Generation tick", "type": "simulated"},
                }
            ),
            chat_apply.normalize_item(
                {
                    "kind": "upsert_console",
                    "summary": "Ecosystem",
                    "payload": {"name": "Ecosystem", "document": form},
                }
            ),
        ]
        self.assertTrue(chat_apply.input_inventory_problems(items))
        chat_apply.supply_implied_inputs(items)
        self.assertEqual(chat_apply.input_inventory_problems(items), [])
        landed = {entry["lands_as"] for entry in chat_apply.collect_inputs(items)}
        self.assertEqual(landed, {"execute_package", "simulated_event", "console"})

    def test_a_follow_up_can_name_a_simulated_event_already_in_the_space(self) -> None:
        follow_up = chat_apply.normalize_item(
            {
                "kind": "upsert_query",
                "summary": "Create read_ecosystem_casualties_count operation",
                "payload": {
                    "name": "read_ecosystem_casualties_count",
                    "kind": "operation",
                    "operation": "create",
                    "node_label": "INSTANCE",
                    "attributive_label": "ecosystem_entity",
                    "execute": True,
                },
                "inputs": [
                    {"name": "starting rows", "source": "seed", "lands_as": "execute_package"},
                    {"name": "generation", "source": "simulated", "lands_as": "simulated_event"},
                ],
            }
        )
        problems = chat_apply.input_inventory_problems([follow_up])
        self.assertTrue(any("no simulated event" in problem for problem in problems))
        self.assertFalse(any(chat_apply.input_problem_blocks_accept(problem) for problem in problems))
        self.assertEqual(chat_apply.validate_batch(self.principal, self.space_id, [follow_up]), [])

        external = chat_apply.normalize_item(
            {
                "kind": "upsert_event",
                "summary": "Badge-in",
                "payload": {"name": "Badge-in", "type": "external"},
            }
        )
        blocked = chat_apply.validate_batch(self.principal, self.space_id, [external])
        self.assertTrue(any("does not name its inputs" in problem for problem in blocked))

    def test_an_executed_instance_create_is_the_seed(self) -> None:
        seed = chat_apply.normalize_item(
            {
                "kind": "upsert_query",
                "summary": "Seed founding kikis",
                "payload": {
                    "name": "seed_ecosystem_entities",
                    "kind": "operation",
                    "operation": "create",
                    "node_label": "INSTANCE",
                    "attributive_label": "ecosystem_entity",
                    "execute": True,
                    "instance_properties": [{"key": "kind", "value": "kiki"}],
                },
                "inputs": [
                    {
                        "name": "founding population",
                        "source": "seed",
                        "lands_as": "execute_package",
                    }
                ],
            }
        )
        self.assertEqual(chat_apply.input_inventory_problems([seed]), [])

        form = {
            "views": [
                {
                    "id": "control",
                    "kind": "live",
                    "modules": [{"id": "reset", "type": "form", "title": "Reset"}],
                }
            ]
        }
        console = chat_apply.normalize_item(
            {
                "kind": "upsert_console",
                "summary": "Ecosystem console",
                "payload": {"name": "Ecosystem", "document": form},
                "inputs": [{"name": "reset", "source": "person", "lands_as": "console"}],
            }
        )
        saved_only = {
            **seed,
            "payload": {**seed["payload"], "execute": False},
        }
        withheld = chat_apply.input_inventory_problems([saved_only, console])
        self.assertTrue(any("does not seed rows" in problem for problem in withheld))
        self.assertTrue(any("execute true" in problem for problem in withheld))

        step = chat_apply.normalize_item(
            {
                "kind": "upsert_query",
                "summary": "Grow apples",
                "payload": {
                    "name": "step_grow_and_forage_apples",
                    "kind": "operation",
                    "operation": "create",
                    "node_label": "STEP",
                    "execute": True,
                },
            }
        )
        self.assertEqual(chat_apply.input_inventory_problems([step]), [])

    def test_an_executed_seed_is_proposed(self) -> None:
        def complete(_cfg, _key, messages, _tools):
            if not any(message.get("role") == "tool" for message in messages):
                yield {
                    "type": "tool_call",
                    "id": "call_seed",
                    "name": "propose_change",
                    "arguments": {
                        "kind": "upsert_query",
                        "summary": "Seed founding kikis and boobas",
                        "payload": {
                            "name": "seed_ecosystem_entities",
                            "kind": "operation",
                            "operation": "create",
                            "node_label": "INSTANCE",
                            "attributive_label": "ecosystem_entity",
                            "execute": True,
                        },
                        "inputs": [
                            {
                                "name": "founding population",
                                "source": "seed",
                                "lands_as": "execute_package",
                            }
                        ],
                    },
                }
                return
            yield {"type": "text", "delta": "Accept the proposal to seed the founding population."}

        events = list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="seed the ecosystem and show me the proposal",
                thread_id=None,
                model=({"provider": "openai", "model": "test", "base_url": ""}, "test-key"),
                complete=complete,
            )
        )
        kinds = [
            event["data"]["item"]["kind"]
            for event in events
            if event["event"] in ("canvas", "canvas_update")
        ]
        self.assertIn("proposal", kinds)
        text = "".join(event["data"].get("delta", "") for event in events if event["event"] == "text")
        self.assertNotIn("I did not show the proposal", text)

    def test_a_feed_without_inputs_is_still_proposed(self) -> None:
        calls = {"n": 0}

        def complete(_cfg, _key, messages, _tools):
            calls["n"] += 1
            if calls["n"] > 2:
                raise RuntimeError(
                    'Chat model request failed (400): { "error": { "code": 400, '
                    '"message": "Request contains an invalid argument.", "status": "INVALID_ARGUMENT" } }'
                )
            last = messages[-1] if messages else {}
            if "was not shown" in str(last.get("content") or ""):
                yield {"type": "text", "delta": "Still missing inputs."}
                return
            if not any(message.get("role") == "tool" for message in messages):
                yield {
                    "type": "tool_call",
                    "id": "call_event",
                    "name": "propose_change",
                    "arguments": {
                        "kind": "upsert_event",
                        "summary": "Badge-in",
                        "payload": {"name": "Badge-in", "type": "external"},
                    },
                }
                return
            yield {"type": "text", "delta": "Proposed."}

        events = list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="wire badge-in",
                thread_id=None,
                model=({"provider": "openai", "model": "test", "base_url": ""}, "test-key"),
                complete=complete,
            )
        )
        kinds = [
            event["data"]["item"]["kind"]
            for event in events
            if event["event"] in ("canvas", "canvas_update")
        ]
        self.assertIn("proposal", kinds)
        self.assertLessEqual(calls["n"], 2)
        proposal = next(event["data"]["item"] for event in events if event["event"] == "canvas" and event["data"]["item"]["kind"] == "proposal")
        self.assertTrue(proposal["payload"]["problems"])
        text = "".join(event["data"].get("delta", "") for event in events if event["event"] == "text")
        self.assertIn("does not name its inputs", text)

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
                        "inputs": [
                            {
                                "name": "badge-in",
                                "source": "external",
                                "lands_as": "external_event",
                            }
                        ],
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

    def test_ephemeral_console_stays_closed_when_a_module_would_show_the_shape_note(self) -> None:
        def resolve(ref: str):
            if ref in ("READ_OPEN", "OP_open"):
                return {"id": "OP_open", "name": "READ_OPEN", "kind": "operation", "operation": "read"}
            raise console_service.ConsoleRunError("sequence was not found")

        def run(*_args, **_kwargs):
            return {
                "status": "inactive",
                "final_result": {"kind": "table", "columns": ["a", "b"], "rows": [{"a": 1, "b": 2}]},
            }

        with (
            patch.object(console_service, "resolve_console_target", resolve),
            patch.object(console_service, "execute_console_sequence", run),
        ):
            refused = chat_tools.execute(
                "open_ephemeral_console",
                {
                    "title": "Floor",
                    "modules": [{"type": "stat", "title": "Open", "data_sequence_id": "READ_OPEN"}],
                },
                self.principal,
                self.space_id,
                [],
            )
            opened = chat_tools.execute(
                "open_ephemeral_console",
                {
                    "title": "Floor",
                    "modules": [{"type": "table", "title": "Open", "data_sequence_id": "READ_OPEN"}],
                },
                self.principal,
                self.space_id,
                [],
            )
        self.assertFalse(refused.result["ok"])
        self.assertEqual(refused.canvases, [])
        self.assertIn("not ok", refused.result["error"])
        self.assertTrue(opened.result["ok"])
        self.assertEqual(opened.canvases[0]["kind"], "ephemeral_console")
        self.assertIn("a=1", opened.result["check"]["modules"][0]["shows"])
        self.assertIn("check_console_modules", chat_agent._SYSTEM)

    def test_proposal_rejects_a_module_that_would_show_the_shape_note(self) -> None:
        def resolve(ref: str):
            if ref in ("READ_OPEN", "OP_open"):
                return {"id": "OP_open", "name": "READ_OPEN", "kind": "operation", "operation": "read"}
            raise console_service.ConsoleRunError("sequence was not found")

        def run(*_args, **_kwargs):
            return {
                "status": "inactive",
                "final_result": {"kind": "table", "rows": [{"open": 4, "closed": 9}]},
            }

        proposals: list = []
        document = {
            "views": [
                {
                    "id": "live",
                    "kind": "live",
                    "modules": [
                        {
                            "id": "m1",
                            "type": "stat",
                            "title": "Open",
                            "dataSequenceId": "READ_OPEN",
                            "dataSource": "sequence",
                            "config": {},
                        }
                    ],
                }
            ]
        }
        with (
            patch.object(console_service, "resolve_console_target", resolve),
            patch.object(console_service, "execute_console_sequence", run),
        ):
            refused = chat_tools.execute(
                "propose_change",
                {
                    "kind": "upsert_console",
                    "summary": "Floor",
                    "payload": {"name": "Floor", "document": document},
                },
                self.principal,
                self.space_id,
                proposals,
            )
        self.assertFalse(refused.result["ok"])
        self.assertEqual(proposals, [])
        self.assertIn("not ok", refused.result["errors"][0])

        waiting: list = []
        later = {
            "views": [
                {
                    "id": "live",
                    "kind": "live",
                    "modules": [
                        {
                            "id": "m1",
                            "type": "table",
                            "title": "Later",
                            "dataSequenceId": "NOT_YET",
                            "dataSource": "sequence",
                            "config": {},
                        }
                    ],
                }
            ]
        }
        queued = chat_tools.execute(
            "propose_change",
            {
                "kind": "upsert_console",
                "summary": "Floor",
                "payload": {"name": "Floor", "document": later},
            },
            self.principal,
            self.space_id,
            waiting,
        )
        self.assertTrue(queued.result["ok"], queued.result)
        self.assertTrue(queued.result["module_check"]["modules"][0]["deferred"])
        self.assertEqual(len(waiting), 1)

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
            held = chat_apply.apply_batch(self.principal, self.space_id, [item], phase="settings")
        self.assertTrue(held["ok"], held)
        self.assertFalse(held["finished"])
        self.assertEqual(held["authoring_pending"][0]["payload"]["attributive_label"], "customer")
        with self.assertRaises(ValueError):
            chat_apply._apply_one(self.principal, self.space_id, item)
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

    def test_upsert_schema_marks_a_display_name_when_is_label_is_omitted(self) -> None:
        item = chat_apply.normalize_item(
            {
                "kind": "upsert_schema",
                "summary": "Create SIMULATION_STATE schema",
                "payload": {
                    "attributive_label": "simulation_state",
                    "properties": [
                        {"key": "tick", "value_type": "integer"},
                        {"key": "growth_rate", "value_type": "number"},
                        {"key": "season_name", "value_type": "string"},
                    ],
                },
            }
        )
        flags = {prop["name"]: prop["is_label"] for prop in item["payload"]["properties"]}
        self.assertEqual(flags["season_name"], True)
        self.assertEqual(flags["tick"], False)
        self.assertEqual(flags["id"], False)
        season = next(prop for prop in item["payload"]["properties"] if prop["name"] == "season_name")
        self.assertFalse(season["is_required"])

        numbers = chat_apply.normalize_item(
            {
                "kind": "upsert_schema",
                "payload": {
                    "attributive_label": "clock",
                    "properties": [
                        {"key": "tick", "value_type": "integer"},
                        {"key": "rate", "value_type": "number"},
                    ],
                },
            }
        )
        labeled = [prop["name"] for prop in numbers["payload"]["properties"] if prop["is_label"]]
        self.assertEqual(labeled, ["tick"])

        blank = chat_apply.normalize_item(
            {
                "kind": "upsert_schema",
                "payload": {"attributive_label": "blank", "properties": []},
            }
        )
        blank_flags = {prop["name"]: prop for prop in blank["payload"]["properties"]}
        self.assertEqual(set(blank_flags), {"id", "name"})
        self.assertTrue(blank_flags["name"]["is_label"])
        self.assertTrue(blank_flags["name"]["is_required"])

        both = chat_apply.normalize_item(
            {
                "kind": "upsert_schema",
                "payload": {
                    "attributive_label": "creature",
                    "properties": [
                        {"key": "notes", "value_type": "string", "is_label": True},
                        {"key": "name", "value_type": "string", "is_label": True},
                    ],
                },
            }
        )
        both_flags = {prop["name"]: prop["is_label"] for prop in both["payload"]["properties"]}
        self.assertEqual(both_flags["name"], True)
        self.assertEqual(both_flags["notes"], False)

    def test_console_event_trigger_without_an_id_is_opened_by_hand(self) -> None:
        item = chat_apply.normalize_item(
            {
                "kind": "upsert_console",
                "summary": "Create Kiki & Booba Evolutionary Ecosystem Console",
                "payload": {
                    "name": "Kiki & Booba",
                    "trigger_kind": "event",
                    "document": {"views": [{"id": "story", "name": "Story", "kind": "live", "modules": []}]},
                },
            }
        )
        self.assertEqual(item["payload"]["trigger_kind"], "")
        self.assertEqual(item["payload"]["trigger_event_id"], "")
        kept = chat_apply.normalize_item(
            {
                "kind": "upsert_console",
                "payload": {
                    "name": "Nightly",
                    "trigger_kind": "event",
                    "trigger_event_id": "EV_time",
                },
            }
        )
        self.assertEqual(kept["payload"]["trigger_kind"], "event")
        self.assertEqual(kept["payload"]["trigger_event_id"], "EV_time")
        named = chat_apply.normalize_item(
            {
                "kind": "upsert_console",
                "payload": {
                    "name": "Desk",
                    "triggerKind": "url",
                    "listenUrl": "https://example.test/hook",
                },
            }
        )
        self.assertEqual(named["payload"]["trigger_kind"], "url")
        self.assertEqual(named["payload"]["listen_url"], "https://example.test/hook")
        result = chat_apply.apply_batch(self.principal, self.space_id, [item])
        self.assertTrue(result["ok"], result)
        saved = catalog.get_console(item["payload"]["id"])
        self.assertIsNotNone(saved)
        self.assertEqual(saved.get("trigger_kind"), "")
        self.assertEqual(saved.get("trigger_event_id"), "")

    def test_settings_kinds_apply_through_the_existing_functions(self) -> None:
        from server import agent_keys, credentials, rbac

        class MemoryStore:
            writable = True
            backend = "local"

            def __init__(self) -> None:
                self.values: dict[str, str] = {}

            def get(self, key: str) -> str | None:
                return self.values.get(key)

            def set(self, key: str, value: str) -> None:
                self.values[key] = value

            def delete(self, key: str) -> None:
                self.values.pop(key, None)

            def is_configured(self, key: str) -> bool:
                return key in self.values

        store = MemoryStore()
        embed_calls: list[tuple] = []

        def save_embed(space_id: str, **kwargs):
            embed_calls.append(("save", space_id, kwargs))
            return {"provider": kwargs.get("provider") or "ollama", "enabled": kwargs.get("enabled")}

        def reindex(space_id: str):
            embed_calls.append(("reindex", space_id))
            return {"embedded": 0}

        record = spaces.fetch_space_record(self.space_id)
        label_path = Path(self._tmpdir.name) / "icon-label"
        leaked = chat_apply.normalize_item(
            {
                "kind": "upsert_credential",
                "summary": "OpenAI",
                "payload": {"name": "OPENAI", "value": "nope"},
            }
        )
        self.assertTrue(chat_apply.validate_item(self.principal, self.space_id, leaked))
        cloud = chat_apply.normalize_item(
            {
                "kind": "update_chat_model",
                "summary": "cloud",
                "payload": {"provider": "openai", "credential_name": "MISSING", "api_key": "secret"},
            }
        )
        cloud_problems = chat_apply.validate_item(self.principal, self.space_id, cloud)
        self.assertTrue(any("API key" in problem for problem in cloud_problems), cloud_problems)

        items = [
            chat_apply.normalize_item(
                {
                    "kind": "update_space",
                    "summary": "dev",
                    "payload": {
                        "name": record["name"],
                        "description": "home desk",
                        "dev_mode": True,
                    },
                }
            ),
            chat_apply.normalize_item(
                {
                    "kind": "upsert_credential",
                    "summary": "OpenAI",
                    "payload": {"name": "OPENAI", "description": "chat"},
                }
            ),
            chat_apply.normalize_item(
                {
                    "kind": "update_chat_model",
                    "summary": "model",
                    "payload": {"provider": "platform", "model": "test-model", "max_rounds": 8},
                }
            ),
            chat_apply.normalize_item(
                {
                    "kind": "update_embeddings",
                    "summary": "vectors",
                    "payload": {"enabled": False, "provider": "ollama"},
                }
            ),
            chat_apply.normalize_item(
                {
                    "kind": "update_role",
                    "summary": "Clerk",
                    "payload": {
                        "name": "Clerk",
                        "permissions": {
                            "flows": ["read:STEP", "read:SCHEMA", "read:INSTANCE"],
                            "sequences": {"all": True, "ids": []},
                            "manage_space": False,
                        },
                    },
                }
            ),
            chat_apply.normalize_item(
                {
                    "kind": "invite_member",
                    "summary": "guest",
                    "payload": {"email": "guest@example.com", "role": "Admin"},
                }
            ),
            chat_apply.normalize_item(
                {
                    "kind": "create_agent_key",
                    "summary": "worker",
                    "payload": {"name": "worker"},
                }
            ),
            chat_apply.normalize_item(
                {
                    "kind": "update_tab_chrome",
                    "summary": "tab",
                    "payload": {"icon_label": "Pona"},
                }
            ),
        ]
        patches = (
            patch("server.credentials.get_store", return_value=store),
            patch("server.chat_apply.embeddings.apply_space_config", side_effect=save_embed),
            patch("server.chat_apply.embeddings.reindex_space", side_effect=reindex),
            patch("server.branding._label_path", return_value=label_path),
        )
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        result = chat_apply.apply_batch(
            self.principal,
            self.space_id,
            items,
            credential_secrets={"OPENAI": "sk-test-value"},
        )
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["finished"], result)
        self.assertEqual(list(store.values.values()), ["sk-test-value"])
        self.assertNotIn(("reindex", self.space_id), [(row[0], row[1]) for row in embed_calls])
        saved = spaces.fetch_space_record(self.space_id)
        self.assertEqual(saved["description"], "home desk")
        self.assertTrue(saved["dev_mode"])
        self.assertEqual(chat_store.get_chat_model(self.space_id)["model"], "test-model")
        self.assertEqual(chat_store.get_chat_model(self.space_id)["max_rounds"], 8)
        self.assertFalse(embed_calls[0][2]["enabled"])
        listed = credentials.list_credentials(self.space_id)
        self.assertEqual(listed[0]["name"], "OPENAI")
        self.assertNotIn("sk-test-value", json.dumps(listed))
        self.assertIn("Clerk", {role["name"] for role in rbac.list_roles(self.space_id)})
        invited = next(entry for entry in result["applied"] if entry["kind"] == "invite_member")
        minted = next(entry for entry in result["applied"] if entry["kind"] == "create_agent_key")
        self.assertTrue(str(minted["token"]).startswith("stg_"))
        self.assertEqual(label_path.read_text(encoding="utf-8"), "Pona")

        follow = chat_apply.apply_batch(
            self.principal,
            self.space_id,
            [
                chat_apply.normalize_item(
                    {
                        "kind": "update_member",
                        "summary": "guest role",
                        "payload": {"member_id": invited["id"], "role": "Clerk"},
                    }
                ),
                chat_apply.normalize_item(
                    {
                        "kind": "revoke_agent_key",
                        "summary": "revoke",
                        "payload": {"id": minted["id"]},
                    }
                ),
                chat_apply.normalize_item(
                    {"kind": "reindex_embeddings", "summary": "reindex", "payload": {}}
                ),
            ],
        )
        self.assertTrue(follow["ok"], follow)
        self.assertIn(("reindex", self.space_id), [(row[0], row[1]) for row in embed_calls])
        revoked = next(key for key in agent_keys.list_keys(self.space_id) if key["id"] == minted["id"])
        self.assertTrue(revoked["revoked"])
        members = rbac.list_members(self.space_id)
        guest_row = next(row for row in members if row.get("email") == "guest@example.com" or row.get("invited_email") == "guest@example.com")
        self.assertEqual(guest_row.get("role_name") or guest_row.get("role"), "Clerk")

        described = chat_tools.execute("describe_settings", {}, self.principal, self.space_id, [])
        self.assertTrue(described.result["ok"], described.result)
        self.assertNotIn("api_key", described.result["chat_model"])
        self.assertNotIn("token", json.dumps(described.result["agent_keys"]))
        self.assertIn("OPENAI", described.result["credentials"])
        self.assertEqual(described.result["space"]["description"], "home desk")

        opened = chat_tools.execute(
            "open_settings", {"tab": "embeddings"}, self.principal, self.space_id, []
        )
        self.assertEqual(opened.canvases[0]["kind"], "settings")
        self.assertEqual(opened.canvases[0]["payload"]["tab"], "embeddings")
        from server import auth, local_auth

        clerk_id = local_auth.create_local_user("clerk@example.com", "a strong password")
        clerk_role = next(role["id"] for role in rbac.list_roles(self.space_id) if role["name"] == "Clerk")
        auth.add_space_member(self.space_id, clerk_id, is_owner=False, role_id=clerk_role)
        guest = Principal(
            user_id=clerk_id,
            clerk_user_id=clerk_id,
            email="clerk@example.com",
            is_instance_admin=False,
            is_superadmin=False,
        )
        denied = chat_tools.execute("open_settings", {"tab": "update"}, guest, self.space_id, [])
        self.assertFalse(denied.result["ok"])
        account = chat_tools.execute("open_settings", {"tab": "account"}, guest, self.space_id, [])
        self.assertTrue(account.result["ok"], account.result)
        self.assertEqual(account.canvases[0]["payload"]["tab"], "account")
        manage = chat_tools.execute("open_settings", {"tab": "chat"}, guest, self.space_id, [])
        self.assertFalse(manage.result["ok"])

        self.assertIn("describe_settings", chat_agent._SYSTEM)
        self.assertIn("open_settings", chat_agent._SYSTEM)
        self.assertIn("Do not send cypher", chat_agent._SYSTEM)
        self.assertIn("reindex_embeddings", chat_agent._SYSTEM)

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
        with patch.object(chat_models, "_read_gemini", return_value=[payload]):
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
        with patch.object(chat_models, "_read_gemini", return_value=[payload]):
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
        with patch.object(chat_models, "_read_gemini", return_value=[payload]) as posted:
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
        self.assertIn("streamGenerateContent", posted.call_args.args[0])

    def test_streamed_chunks_fold_into_one_reply(self) -> None:
        events = list(
            chat_models._iter_sse_json(
                [
                    b'data: {"candidates":[{"content":{"parts":[{"text":"hel"}]}}]}\n',
                    b"\n",
                    b'data: {"candidates":[{"content":{"parts":[{"text":"lo"},{"functionCall":{"name":"list_schemas","args":{}}}]},"finishReason":"STOP"}]}\n',
                ]
            )
        )
        parsed = chat_models._gemini_from_events(events)
        self.assertEqual(parsed["text"], "hello")
        self.assertEqual(parsed["tool_calls"][0]["name"], "list_schemas")

    def test_socket_read_timeout_names_the_plan(self) -> None:
        with patch("server.chat_models.urllib.request.urlopen", side_effect=TimeoutError("The read operation timed out")):
            with self.assertRaises(RuntimeError) as caught:
                chat_models._post_json("http://example.test", {}, {})
        self.assertNotEqual(str(caught.exception), "The read operation timed out")
        self.assertIn("plan", str(caught.exception).lower())


if __name__ == "__main__":
    unittest.main()
