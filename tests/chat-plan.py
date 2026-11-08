#!/usr/bin/env python3
"""Consultation brief: readiness, assumed features, compilation, and model triage."""

from __future__ import annotations

import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "Engine"))

from fastapi.testclient import TestClient  # noqa: E402

from server import catalog, chat_agent, chat_apply, chat_models, chat_plan, chat_store, chat_tools, config, graph, local_auth, migrations  # noqa: E402
from server.app import app  # noqa: E402
from server.auth import Principal  # noqa: E402


def _brief(**overrides: object) -> dict:
    brief = {
        "routine": "Assign the nurse who is on the unit.",
        "reconstruction": {
            "avoids_runtime_guess": True,
            "because": "Load the nurse and the unit the nurse points to.",
        },
        "ontology": {
            "types": [
                {"label": "nurse", "label_property": "name"},
                {"label": "unit", "label_property": "name"},
            ],
            "links": [
                {
                    "from": "nurse",
                    "to": "unit",
                    "label": "nurse_unit",
                    "infers": "the nurse's unit",
                }
            ],
        },
        "multi_hop": {
            "needed": True,
            "path": ["nurse", "unit"],
            "why": "The unit is not stored on the nurse.",
        },
        "inputs": [
            {"name": "charge nurse", "source": "person", "confirmed": True},
        ],
        "outputs": [{"name": "assign nurse", "results": ["assigned"]}],
        "vector": {"used": False, "only_to_name_the_subject": False, "text": ""},
        "open_questions": [],
    }
    brief.update(overrides)
    return brief


class ChatPlanTest(unittest.TestCase):
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
        catalog._ensured_catalog_paths.discard(str(self.db_path))
        chat_store._ensured_paths.discard(str(self.db_path))
        owners = patch.object(graph, "attributive_label_owner_ids", return_value=set())
        owners.start()
        self.addCleanup(owners.stop)
        def empty_space_names(_space_id: str) -> dict:
            return {"schemas": set(), "steps": set(), "sequences": set(), "consoles": set()}

        empty_names = patch.object(chat_plan, "load_space_names", side_effect=empty_space_names)
        empty_names.start()
        self.addCleanup(empty_names.stop)
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

    def _models(self) -> dict:
        surface = ({"provider": "openai", "model": "surface-model", "base_url": "", "max_rounds": 4}, "key")
        planner = ({"provider": "openai", "model": "planner-model", "base_url": "", "max_rounds": 4}, "key")
        builder = ({"provider": "openai", "model": "builder-model", "base_url": "", "max_rounds": 4}, "key")
        return {"surface": surface, "planner": planner, "builder": builder}

    def _open_plan(self, brief: dict) -> str:
        revised = chat_plan.update_brief(None, brief, "planner")
        thread = chat_store.create_thread(self.space_id, self.principal.user_id, "Plan")
        chat_store.add_stack_item(
            thread["id"],
            "plan",
            "Plan",
            {
                "status": "consulting",
                "brief": revised["brief"],
                "blocking": revised["blocking"],
                "ready": revised["ready"],
            },
        )
        return thread["id"]

    def test_unconfirmed_external_source_blocks_confirm(self) -> None:
        brief = _brief(
            inputs=[{"name": "badge reader", "source": "external", "confirmed": False}]
        )
        revised = chat_plan.update_brief(None, brief, "planner")
        self.assertFalse(revised["ready"])
        self.assertTrue(any("badge reader" in problem and "live" in problem for problem in revised["blocking"]))
        thread_id = self._open_plan(brief)
        response = self.client.post(
            f"/api/spaces/{self.space_id}/chat/threads/{thread_id}/plan/confirm",
            headers={"Origin": self.BASE},
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertFalse(body["ok"])
        self.assertTrue(any("badge reader" in problem for problem in body["blocking"]))
        thread = chat_store.get_thread(thread_id, self.space_id, self.principal.user_id)
        plan = next(item for item in thread["stack"] if item["kind"] == "plan")
        self.assertEqual(plan["payload"]["status"], "consulting")
        self.assertIsNone(chat_store.pending_batch(thread))

    def test_described_source_compiles_to_matching_simulated_outcomes(self) -> None:
        brief = _brief(
            inputs=[
                {
                    "name": "badge reader",
                    "source": "external",
                    "live": False,
                    "simulation": {
                        "tic_unit": "minutes",
                        "tic_duration": 1,
                        "situations": [
                            {"name": "admitted", "parameters": {"status": "in"}},
                            {"name": "discharged", "parameters": {"status": "out"}},
                        ],
                    },
                }
            ]
        )
        revised = chat_plan.update_brief(None, brief, "planner")
        source = next(entry for entry in revised["brief"]["inputs"] if entry["name"] == "badge reader")
        self.assertEqual(source["source"], "simulated")
        self.assertTrue(any(item["id"] == "simulate:badge reader" for item in revised["brief"]["assumptions"]))
        items = chat_plan.compile_brief(revised["brief"])
        event = next(
            item
            for item in items
            if item["kind"] == "upsert_event" and item["payload"].get("type") == "simulated"
        )
        probabilities = event["payload"]["simulation_package"]["probabilities"]
        self.assertEqual([row["name"] for row in probabilities], ["admitted", "discharged"])
        self.assertEqual(probabilities[0]["outcomes"][0]["payload"], {"status": "in"})
        self.assertEqual(probabilities[1]["outcomes"][0]["payload"], {"status": "out"})

    def test_two_outcomes_gain_an_assumed_branch(self) -> None:
        brief = _brief(outputs=[{"name": "assign nurse", "results": ["stay", "move"]}])
        revised = chat_plan.update_brief(None, brief, "planner")
        branch = revised["brief"]["outputs"][0]["branch"]
        self.assertEqual(branch["when_true"], "stay")
        self.assertEqual(branch["when_false"], "move")
        assumed = next(item for item in revised["brief"]["assumptions"] if item["id"].startswith("branch:"))
        self.assertIn("Branch", assumed["adds"])
        items = chat_plan.compile_brief(revised["brief"])
        expected = [
            item["payload"].get("condition_expected")
            for item in items
            if item["kind"] == "create_transition" and item["payload"].get("condition_type") == "parameter"
        ]
        self.assertEqual(expected, [True, False])
        self.assertTrue(any(isinstance(item["payload"].get("operation_step"), dict) for item in items))

    def test_vector_only_decision_is_not_ready(self) -> None:
        brief = _brief(
            ontology={"types": [{"label": "note"}], "links": []},
            multi_hop={"needed": False, "path": [], "why": ""},
            outputs=[{"name": "find note", "results": ["found"]}],
            vector={"used": True, "only_to_name_the_subject": False, "text": "a note"},
            inputs=[],
        )
        revised = chat_plan.update_brief(None, brief, "planner")
        self.assertFalse(revised["ready"])
        self.assertTrue(any("cannot be the decision" in problem for problem in revised["blocking"]))
        self.assertTrue(any("hop read" in problem for problem in revised["blocking"]))

    def test_two_type_path_compiles_to_a_link_and_a_hop_read(self) -> None:
        revised = chat_plan.update_brief(None, _brief(), "planner")
        self.assertTrue(revised["ready"], revised["blocking"])
        items = chat_plan.compile_brief(revised["brief"])
        problems = chat_plan.validation_problems(self.principal, self.space_id, items)
        self.assertEqual(problems, [], problems)
        link = next(item for item in items if item["summary"].startswith("Link "))
        self.assertEqual(link["payload"]["anchor_source"], "existing")
        self.assertEqual(link["payload"]["hops"][0]["target_label"], "unit")
        self.assertTrue(link["pins"])
        read = next(
            item
            for item in items
            if item["payload"].get("operation") == "read" and item["payload"].get("hops")
        )
        self.assertEqual(read["payload"]["hops"][0]["relationship_label"], "nurse_unit")
        self.assertIn("unit", read["note"])
        seed = next(item for item in items if item["payload"].get("execute") is True)
        self.assertEqual(seed["payload"]["hops"][0]["target_source"], "new")
        for schema in (item for item in items if item["kind"] == "upsert_schema"):
            labels = [prop for prop in schema["payload"]["properties"] if prop.get("is_label")]
            self.assertEqual(len(labels), 1, schema["payload"])
            self.assertTrue(labels[0]["is_required"], schema["payload"])

    def test_the_chain_points_at_the_read_step(self) -> None:
        brief = _brief(outputs=[{"name": "assign nurse", "results": ["stay", "move"]}])
        revised = chat_plan.update_brief(None, brief, "planner")
        items = chat_plan.compile_brief(revised["brief"])
        steps: set[str] = set()
        for item in items:
            payload = item["payload"]
            if item["kind"] != "upsert_query" or payload.get("kind") == "sequence":
                continue
            if payload.get("node_label") == "STEP":
                steps.add(str(payload.get("attributive_label") or payload.get("name")))
            elif payload.get("operation") == "read":
                steps.add(str(payload.get("name")))
        read = next(
            item
            for item in items
            if item["payload"].get("operation") == "read" and item["payload"].get("hops")
        )
        sequence = next(item for item in items if item["payload"].get("kind") == "sequence")
        self.assertEqual(sequence["payload"]["entry_step"], read["payload"]["name"])
        step_labels = [
            item["payload"].get("attributive_label")
            for item in items
            if item["payload"].get("node_label") == "STEP"
        ]
        self.assertNotIn(read["payload"]["name"], step_labels)
        for item in items:
            if item["kind"] != "create_transition":
                continue
            self.assertIn(item["payload"]["from_step"], steps)
            self.assertIn(item["payload"]["to_step"], steps)

    def test_vector_search_is_followed_by_the_hop_read(self) -> None:
        brief = _brief(
            vector={"used": True, "only_to_name_the_subject": True, "text": "the nurse on nights"}
        )
        revised = chat_plan.update_brief(None, brief, "planner")
        self.assertTrue(revised["ready"], revised["blocking"])
        items = chat_plan.compile_brief(revised["brief"])
        find = next(item for item in items if item["payload"].get("vector_search"))
        read = next(
            item
            for item in items
            if item["payload"].get("operation") == "read" and item["payload"].get("hops")
        )
        self.assertNotIn("hops", find["payload"])
        transition = next(
            item
            for item in items
            if item["kind"] == "create_transition" and item["payload"].get("from_step") == find["payload"]["name"]
        )
        self.assertEqual(transition["payload"]["to_step"], read["payload"]["name"])

    def test_confirm_queues_the_batch_and_hides_propose_change(self) -> None:
        names = [
            tool["function"]["name"]
            for tool in chat_tools.select_tools(role="surface", consulting=True, routing=False)
        ]
        self.assertNotIn("propose_change", names)
        self.assertIn("update_plan", names)
        planner_names = [
            tool["function"]["name"]
            for tool in chat_tools.select_tools(role="planner", consulting=True, routing=False)
        ]
        self.assertNotIn("propose_change", planner_names)

        thread_id = self._open_plan(_brief())
        offered: list[list[str]] = []

        def complete(_cfg, _key, messages, tools):
            offered.append([tool["function"]["name"] for tool in tools])
            last = str((messages[-1] or {}).get("content") or "")
            if last.startswith("Ask the user only this question"):
                yield {"type": "text", "delta": "Anything else?"}
                return
            if any(message.get("role") == "tool" for message in messages):
                yield {"type": "text", "delta": "The plan is on the canvas."}
                return
            if offered[-1] == ["choose_route"]:
                yield {
                    "type": "tool_call",
                    "id": "route",
                    "name": "choose_route",
                    "arguments": {"route": "surface", "reason": "the plan is open"},
                }
                return
            yield {"type": "text", "delta": "Which part should we change?"}

        list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="the charge nurse uses a console",
                thread_id=thread_id,
                models=self._models(),
                complete=complete,
            )
        )
        self.assertIn(["choose_route"], offered)
        self.assertTrue(any("propose_change" not in names and "update_plan" in names for names in offered))

        response = self.client.post(
            f"/api/spaces/{self.space_id}/chat/threads/{thread_id}/plan/confirm",
            headers={"Origin": self.BASE},
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["ok"], body)
        thread = chat_store.get_thread(thread_id, self.space_id, self.principal.user_id)
        pending = chat_store.pending_batch(thread)
        self.assertIsNotNone(pending)
        kinds = [item["kind"] for item in pending["items"]]
        self.assertIn("upsert_schema", kinds)
        self.assertIn("upsert_query", kinds)
        plan = next(item for item in thread["stack"] if item["kind"] == "plan")
        self.assertEqual(plan["payload"]["status"], "confirmed")

    def test_validation_failure_becomes_a_blocking_question(self) -> None:
        thread_id = self._open_plan(_brief())

        def bad_compile(_brief_doc):
            return [
                chat_apply.normalize_item(
                    {"kind": "create_space", "summary": "no name", "payload": {}}
                )
            ]

        with patch.object(chat_plan, "compile_brief", bad_compile):
            response = self.client.post(
                f"/api/spaces/{self.space_id}/chat/threads/{thread_id}/plan/confirm",
                headers={"Origin": self.BASE},
            )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertFalse(body["ok"])
        self.assertTrue(body["blocking"])
        thread = chat_store.get_thread(thread_id, self.space_id, self.principal.user_id)
        plan = next(item for item in thread["stack"] if item["kind"] == "plan")
        self.assertEqual(plan["payload"]["status"], "consulting")
        self.assertEqual(plan["payload"]["blocking"], body["blocking"])
        self.assertTrue(any(question.get("question") in body["blocking"] for question in plan["payload"]["brief"]["open_questions"]))

    def test_legacy_chat_model_is_used_for_both_roles(self) -> None:
        chat_store.set_chat_model(
            self.space_id,
            {
                "provider": "local_llm",
                "local_llm_config_id": "cfg-legacy",
                "local_llm_base_url": "http://127.0.0.1:8000",
            },
        )
        stored = chat_store.get_chat_model(self.space_id)
        self.assertIsNone(stored["surface"])
        self.assertIsNone(stored["builder"])
        self.assertEqual(stored["provider"], "local_llm")
        planner = chat_models.resolve_model(self.space_id, "planner")
        surface = chat_models.resolve_model(self.space_id, "surface")
        builder = chat_models.resolve_model(self.space_id, "builder")
        self.assertEqual(planner, surface)
        self.assertEqual(planner, builder)
        self.assertEqual(planner[0]["model"], "cfg-legacy")
        chat_store.set_chat_model(
            self.space_id,
            {
                "planner": {"provider": "local_llm", "local_llm_config_id": "cfg-deep"},
                "surface": {"provider": "local_llm", "local_llm_config_id": "cfg-surface"},
            },
        )
        self.assertEqual(chat_models.resolve_model(self.space_id, "planner")[0]["model"], "cfg-deep")
        self.assertEqual(chat_models.resolve_model(self.space_id, "surface")[0]["model"], "cfg-surface")

    def test_settings_form_keeps_a_separate_surface_model(self) -> None:
        saved = self.client.post(
            f"/api/spaces/{self.space_id}/chat-model",
            json={
                "planner": {
                    "provider": "gemini",
                    "model": "gemini-4-argon",
                    "credential_name": "API_KEY",
                    "local_llm_base_url": "http://127.0.0.1:8000",
                    "local_llm_config_id": "",
                    "max_rounds": 24,
                },
                "surface": {
                    "provider": "openai",
                    "model": "gpt-4.1",
                    "credential_name": "OPENAI",
                    "local_llm_base_url": "http://127.0.0.1:8000",
                    "local_llm_config_id": "",
                    "max_rounds": 8,
                },
            },
            headers={"Origin": self.BASE},
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        body = saved.json()
        self.assertEqual(body["planner"]["model"], "gemini-4-argon")
        self.assertEqual(body["surface"]["provider"], "openai")
        self.assertEqual(body["surface"]["model"], "gpt-4.1")
        again = self.client.get(f"/api/spaces/{self.space_id}/chat-model")
        self.assertEqual(again.status_code, 200, again.text)
        self.assertEqual(again.json()["surface"]["model"], "gpt-4.1")
        self.assertEqual(again.json()["model"], "gemini-4-argon")
        self.assertIsNone(again.json()["builder"])
        posted = self.client.post(
            f"/api/spaces/{self.space_id}/chat-model",
            json={
                "planner": body["planner"],
                "surface": body["surface"],
                "builder": {
                    "provider": "anthropic",
                    "model": "claude-builder",
                    "credential_name": "ANTHROPIC",
                    "local_llm_base_url": "http://127.0.0.1:8000",
                    "local_llm_config_id": "",
                    "max_rounds": 6,
                },
            },
            headers={"Origin": self.BASE},
        )
        self.assertEqual(posted.status_code, 200, posted.text)
        self.assertEqual(posted.json()["builder"]["model"], "claude-builder")
        self.assertEqual(posted.json()["builder"]["provider"], "anthropic")
        cleared = self.client.post(
            f"/api/spaces/{self.space_id}/chat-model",
            json={"planner": body["planner"], "surface": body["surface"], "builder": None},
            headers={"Origin": self.BASE},
        )
        self.assertEqual(cleared.status_code, 200, cleared.text)
        self.assertIsNone(cleared.json()["builder"])
        self.assertEqual(cleared.json()["surface"]["model"], "gpt-4.1")

    def test_slot_answer_stays_on_the_surface_model(self) -> None:
        thread_id = self._open_plan(_brief())
        seen: list[str] = []

        def complete(cfg, _key, messages, tools):
            seen.append(cfg["model"])
            last = str((messages[-1] or {}).get("content") or "")
            names = [tool["function"]["name"] for tool in tools]
            if last.startswith("Ask the user only this question"):
                yield {"type": "text", "delta": "Is the clock live?"}
                return
            if any(message.get("role") == "tool" for message in messages):
                yield {"type": "text", "delta": "Noted."}
                return
            if names == ["choose_route"]:
                yield {
                    "type": "tool_call",
                    "id": "route",
                    "name": "choose_route",
                    "arguments": {"route": "surface", "reason": "the user is answering"},
                }
                return
            yield {
                "type": "tool_call",
                "id": "plan",
                "name": "update_plan",
                "arguments": {
                    "inputs": [{"name": "shift clock", "source": "clock", "confirmed": True, "live": True}]
                },
            }

        list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="yes, the shift clock is live",
                thread_id=thread_id,
                models=self._models(),
                complete=complete,
            )
        )
        self.assertNotIn("planner-model", seen)
        self.assertNotIn("builder-model", seen)
        self.assertEqual(seen[0], "surface-model")
        thread = chat_store.get_thread(thread_id, self.space_id, self.principal.user_id)
        plan = next(item for item in thread["stack"] if item["kind"] == "plan")
        clock = next(entry for entry in plan["payload"]["brief"]["inputs"] if entry["name"] == "shift clock")
        self.assertTrue(clock["confirmed"])

    def test_plan_follow_up_asks_the_open_question(self) -> None:
        asked = "What decision should the blog context engine make?"
        brief = _brief(
            outputs=[],
            open_questions=[{"id": "routine", "question": asked}],
        )

        def complete(_cfg, _key, messages, tools):
            last = str((messages[-1] or {}).get("content") or "")
            names = [tool["function"]["name"] for tool in tools]
            if last.startswith("Ask the user only this question"):
                yield {"type": "text", "delta": ""}
                return
            if names == ["choose_route"]:
                yield {
                    "type": "tool_call",
                    "id": "route",
                    "name": "choose_route",
                    "arguments": {"route": "deep", "reason": "a routine to build"},
                }
                return
            yield {
                "type": "tool_call",
                "id": "plan",
                "name": "update_plan",
                "arguments": brief,
            }

        events = list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="I am building a blog and need a context engine",
                thread_id=None,
                models=self._models(),
                complete=complete,
            )
        )
        text = "".join(event["data"].get("delta", "") for event in events if event["event"] == "text")
        self.assertIn("The plan is on the canvas.", text)
        self.assertIn(asked, text)
        self.assertNotIn("Name the sequence that makes the decision.", text)
        thread_id = next(event["data"]["thread_id"] for event in events if event["event"] == "start")
        thread = chat_store.get_thread(thread_id, self.space_id, self.principal.user_id)
        assistant = next(message for message in reversed(thread["messages"]) if message["role"] == "assistant")
        self.assertIn(asked, assistant["content"])
        self.assertIn("The plan is on the canvas.", assistant["content"])

    def test_deep_route_runs_the_planner_on_the_same_message(self) -> None:
        planner_turns: list[list[dict]] = []

        def complete(cfg, _key, messages, tools):
            if cfg["model"] == "planner-model" and not any(message.get("role") == "tool" for message in messages):
                planner_turns.append(
                    [{"role": message.get("role"), "content": message.get("content")} for message in messages]
                )
            last = str((messages[-1] or {}).get("content") or "")
            names = [tool["function"]["name"] for tool in tools]
            if last.startswith("Ask the user only this question"):
                yield {"type": "text", "delta": "Who confirms the assignment?"}
                return
            if any(message.get("role") == "tool" for message in messages):
                yield {"type": "text", "delta": "Planned it."}
                return
            if names == ["choose_route"]:
                yield {"type": "text", "delta": "routing aside"}
                yield {
                    "type": "tool_call",
                    "id": "route",
                    "name": "choose_route",
                    "arguments": {"route": "deep", "reason": "a routine to build"},
                }
                return
            yield {
                "type": "tool_call",
                "id": "plan",
                "name": "update_plan",
                "arguments": _brief(),
            }

        events = list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="assign the nurse who is on the unit",
                thread_id=None,
                models=self._models(),
                complete=complete,
            )
        )
        text = "".join(event["data"].get("delta", "") for event in events if event["event"] == "text")
        self.assertNotIn("routing aside", text)
        self.assertEqual(len(planner_turns), 1)
        roles = [message.get("role") for message in planner_turns[0]]
        self.assertNotIn("tool", roles)
        self.assertNotIn("assistant", roles)
        self.assertTrue(any("assign the nurse who is on the unit" in str(message.get("content") or "") for message in planner_turns[0]))
        thread_id = next(event["data"]["thread_id"] for event in events if event["event"] == "start")
        thread = chat_store.get_thread(thread_id, self.space_id, self.principal.user_id)
        assistant = next(message for message in reversed(thread["messages"]) if message["role"] == "assistant")
        self.assertNotIn("routing aside", assistant["content"])
        reasoning = next(item for item in thread["stack"] if item["kind"] == "reasoning")
        roles_run = [entry.get("role") for entry in reasoning["payload"]["rounds"]]
        self.assertIn("planner", roles_run)

    def test_surface_ontology_patch_restarts_on_the_planner(self) -> None:
        thread_id = self._open_plan(_brief())
        planner_turns: list[list[dict]] = []

        def complete(cfg, _key, messages, tools):
            if cfg["model"] == "planner-model" and not any(message.get("role") == "tool" for message in messages):
                planner_turns.append(
                    [{"role": message.get("role"), "content": message.get("content")} for message in messages]
                )
            last = str((messages[-1] or {}).get("content") or "")
            names = [tool["function"]["name"] for tool in tools]
            if last.startswith("Ask the user only this question"):
                yield {"type": "text", "delta": "One question."}
                return
            if any(message.get("role") == "tool" for message in messages):
                yield {"type": "text", "delta": "Revised."}
                return
            if names == ["choose_route"]:
                yield {
                    "type": "tool_call",
                    "id": "route",
                    "name": "choose_route",
                    "arguments": {"route": "surface", "reason": "short reply"},
                }
                return
            if cfg["model"] == "surface-model":
                yield {
                    "type": "tool_call",
                    "id": "plan",
                    "name": "update_plan",
                    "arguments": {"ontology": {"types": [{"label": "other"}], "links": []}},
                }
                return
            revised = _brief()
            revised["routine"] = "Planner revised the assignment."
            yield {
                "type": "tool_call",
                "id": "plan",
                "name": "update_plan",
                "arguments": revised,
            }

        list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="use a different type",
                thread_id=thread_id,
                models=self._models(),
                complete=complete,
            )
        )
        self.assertEqual(len(planner_turns), 1)
        self.assertNotIn("tool", [message.get("role") for message in planner_turns[0]])
        self.assertTrue(
            any("use a different type" in str(message.get("content") or "") for message in planner_turns[0])
        )
        thread = chat_store.get_thread(thread_id, self.space_id, self.principal.user_id)
        plan = next(item for item in thread["stack"] if item["kind"] == "plan")
        self.assertEqual(plan["payload"]["brief"]["routine"], "Planner revised the assignment.")
        labels = [entry["label"] for entry in plan["payload"]["brief"]["ontology"]["types"]]
        self.assertIn("nurse", labels)
        self.assertNotIn("other", labels)

    def test_clearing_a_question_does_not_revise_the_routine(self) -> None:
        current = chat_plan.update_brief(
            None,
            _brief(open_questions=[{"id": "routine", "question": "Which decision?"}]),
            "planner",
        )["brief"]
        cleared = chat_plan.update_brief(current, {"open_questions": []}, "surface")
        self.assertTrue(cleared["escalate"])
        self.assertEqual(cleared["brief"]["routine"], current["routine"])
        self.assertTrue(cleared["brief"]["open_questions"])

    def test_decision_answer_revises_the_open_plan(self) -> None:
        asked = "What recurring decision should the routine make?"
        thread_id = self._open_plan(
            _brief(open_questions=[{"id": "routine", "question": asked}])
        )
        planner_seen: list[str] = []

        def complete(cfg, _key, messages, tools):
            last = str((messages[-1] or {}).get("content") or "")
            names = [tool["function"]["name"] for tool in tools]
            if cfg["model"] == "planner-model":
                planner_seen.append(
                    "\n".join(str(message.get("content") or "") for message in messages)
                )
            if last.startswith("Ask the user only this question"):
                yield {"type": "text", "delta": "The plan is on the canvas. Who approves a post?"}
                return
            if names == ["choose_route"]:
                yield {
                    "type": "tool_call",
                    "id": "route",
                    "name": "choose_route",
                    "arguments": {"route": "surface", "reason": "the user is answering"},
                }
                return
            if cfg["model"] == "surface-model":
                yield {
                    "type": "tool_call",
                    "id": "plan",
                    "name": "update_plan",
                    "arguments": {"open_questions": []},
                }
                return
            revised = _brief()
            revised["routine"] = "Approve a post against its topic guidelines."
            revised["open_questions"] = []
            yield {
                "type": "tool_call",
                "id": "plan",
                "name": "update_plan",
                "arguments": revised,
            }

        events = list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="Let's do approving posts against topic guidelines.",
                thread_id=thread_id,
                models=self._models(),
                complete=complete,
            )
        )
        text = "".join(event["data"].get("delta", "") for event in events if event["event"] == "text")
        self.assertNotIn("I stopped after those tool calls", text)
        self.assertIn("The plan is on the canvas.", text)
        self.assertTrue(planner_seen)
        self.assertIn("Assign the nurse who is on the unit.", planner_seen[0])
        self.assertIn("Let's do approving posts against topic guidelines.", planner_seen[0])
        thread = chat_store.get_thread(thread_id, self.space_id, self.principal.user_id)
        plan = next(item for item in thread["stack"] if item["kind"] == "plan")
        self.assertEqual(
            plan["payload"]["brief"]["routine"],
            "Approve a post against its topic guidelines.",
        )
        labels = [entry["label"] for entry in plan["payload"]["brief"]["ontology"]["types"]]
        self.assertIn("nurse", labels)

    def test_slot_update_without_text_asks_the_next_question(self) -> None:
        thread_id = self._open_plan(_brief())

        def complete(_cfg, _key, messages, tools):
            last = str((messages[-1] or {}).get("content") or "")
            names = [tool["function"]["name"] for tool in tools]
            if last.startswith("Ask the user only this question"):
                yield {"type": "text", "delta": ""}
                return
            if names == ["choose_route"]:
                yield {
                    "type": "tool_call",
                    "id": "route",
                    "name": "choose_route",
                    "arguments": {"route": "surface", "reason": "confirming a source"},
                }
                return
            if any(message.get("role") == "tool" for message in messages):
                return
            yield {
                "type": "tool_call",
                "id": "plan",
                "name": "update_plan",
                "arguments": {
                    "inputs": [{"name": "shift clock", "source": "clock", "confirmed": True, "live": True}]
                },
            }

        events = list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="yes, the shift clock is live",
                thread_id=thread_id,
                models=self._models(),
                complete=complete,
            )
        )
        text = "".join(event["data"].get("delta", "") for event in events if event["event"] == "text")
        self.assertNotIn("I stopped after those tool calls", text)
        self.assertIn("The plan is on the canvas.", text)
        thread = chat_store.get_thread(thread_id, self.space_id, self.principal.user_id)
        plan = next(item for item in thread["stack"] if item["kind"] == "plan")
        clock = next(entry for entry in plan["payload"]["brief"]["inputs"] if entry["name"] == "shift clock")
        self.assertTrue(clock["confirmed"])

    def test_surface_route_without_a_plan_uses_the_builder(self) -> None:
        seen: list[tuple[str, list[str]]] = []

        def complete(cfg, _key, messages, tools):
            names = [tool["function"]["name"] for tool in tools]
            seen.append((cfg["model"], names))
            if names == ["choose_route"]:
                yield {
                    "type": "tool_call",
                    "id": "route",
                    "name": "choose_route",
                    "arguments": {"route": "surface", "reason": "a small edit"},
                }
                return
            self.assertIn("propose_change", str(messages[0].get("content") or ""))
            self.assertNotIn("one blocking question", str(messages[0].get("content") or ""))
            yield {"type": "text", "delta": "What should change?"}

        thread = chat_store.create_thread(self.space_id, self.principal.user_id, "Edit")
        list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="rename the home sequence",
                thread_id=thread["id"],
                models=self._models(),
                complete=complete,
            )
        )
        self.assertEqual(seen[0][0], "surface-model")
        self.assertEqual(seen[0][1], ["choose_route"])
        self.assertEqual(seen[1][0], "builder-model")
        self.assertIn("propose_change", seen[1][1])
        builder_names = [
            tool["function"]["name"]
            for tool in chat_tools.select_tools(role="builder", consulting=False, routing=False)
        ]
        self.assertIn("propose_change", builder_names)
        self.assertNotIn("choose_route", builder_names)

    def test_follow_up_without_a_plan_starts_on_the_builder(self) -> None:
        seen: list[str] = []

        def complete(cfg, _key, messages, _tools):
            seen.append(cfg["model"])
            self.assertIn("check_console_modules", str(messages[0].get("content") or ""))
            yield {"type": "text", "delta": "Those changes are in. What should we do next?"}

        thread = chat_store.create_thread(self.space_id, self.principal.user_id, "Done")
        list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="[[pona-follow-up]]\nThe user accepted the change batch.",
                thread_id=thread["id"],
                models=self._models(),
                complete=complete,
            )
        )
        self.assertEqual(seen, ["builder-model"])

    def test_plan_update_stores_a_preview_without_a_batch(self) -> None:
        thread_id = self._open_plan(_brief())

        def complete(_cfg, _key, messages, tools):
            last = str((messages[-1] or {}).get("content") or "")
            names = [tool["function"]["name"] for tool in tools]
            if last.startswith("Ask the user only this question"):
                yield {"type": "text", "delta": "The plan is on the canvas."}
                return
            if names == ["choose_route"]:
                yield {
                    "type": "tool_call",
                    "id": "route",
                    "name": "choose_route",
                    "arguments": {"route": "deep", "reason": "revise the routine"},
                }
                return
            if any(message.get("role") == "tool" for message in messages):
                yield {"type": "text", "delta": "Revised."}
                return
            revised = _brief()
            revised["routine"] = "Approve a post against its topic guidelines."
            yield {
                "type": "tool_call",
                "id": "plan",
                "name": "update_plan",
                "arguments": revised,
            }

        list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="Let's do approving posts against topic guidelines.",
                thread_id=thread_id,
                models=self._models(),
                complete=complete,
            )
        )
        thread = chat_store.get_thread(thread_id, self.space_id, self.principal.user_id)
        self.assertIsNone(chat_store.pending_batch(thread))
        plan = next(item for item in thread["stack"] if item["kind"] == "plan")
        preview = plan["payload"]["preview"]
        self.assertTrue(preview["items"])
        self.assertIn("upsert_schema", [item["kind"] for item in preview["items"]])
        self.assertNotIn("batch_status", plan["payload"])

    def test_confirm_keeps_one_plan_card_and_accept_clears_the_batch(self) -> None:
        thread_id = self._open_plan(_brief())
        response = self.client.post(
            f"/api/spaces/{self.space_id}/chat/threads/{thread_id}/plan/confirm",
            headers={"Origin": self.BASE},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["ok"], response.json())
        thread = chat_store.get_thread(thread_id, self.space_id, self.principal.user_id)
        self.assertNotIn("proposal", [item["kind"] for item in thread["stack"]])
        plans = [item for item in thread["stack"] if item["kind"] == "plan"]
        self.assertEqual(len(plans), 1)
        plan = plans[0]
        self.assertEqual(plan["payload"]["status"], "confirmed")
        self.assertEqual(plan["payload"]["batch_status"], "pending")
        self.assertIn("upsert_schema", [item["kind"] for item in plan["payload"]["items"]])
        self.assertIsNotNone(chat_store.pending_batch(thread))
        accepted = self.client.post(
            f"/api/spaces/{self.space_id}/chat/threads/{thread_id}/batch/accept",
            json={"phase": "settings"},
            headers={"Origin": self.BASE},
        )
        self.assertEqual(accepted.status_code, 200, accepted.text)
        self.assertFalse(accepted.json()["finished"])
        finished = self.client.post(
            f"/api/spaces/{self.space_id}/chat/threads/{thread_id}/batch/accept",
            json={"phase": "rest", "authoring_applied": accepted.json()["authoring_pending"]},
            headers={"Origin": self.BASE},
        )
        self.assertEqual(finished.status_code, 200, finished.text)
        self.assertTrue(finished.json()["finished"])
        thread = chat_store.get_thread(thread_id, self.space_id, self.principal.user_id)
        plan = next(item for item in thread["stack"] if item["kind"] == "plan")
        self.assertNotEqual(plan["payload"]["batch_status"], "pending")
        self.assertIsNone(chat_store.pending_batch(thread))

    def test_answering_the_open_question_revises_the_plan(self) -> None:
        asked = "Which screen should open first?"
        thread_id = self._open_plan(_brief(open_questions=[{"id": "types", "question": asked}]))
        chat_store.append_message(thread_id, "assistant", f"The plan is on the canvas. {asked}")
        seen: list[str] = []

        def complete(cfg, _key, messages, _tools):
            seen.append(cfg["model"])
            last = str((messages[-1] or {}).get("content") or "")
            if last.startswith("Ask the user only this question"):
                yield {
                    "type": "text",
                    "delta": "The plan is on the canvas. How does a post relate to its category?",
                }
                return
            self.assertIn(asked, str(messages[0].get("content") or ""))
            revised = _brief()
            revised["ontology"] = {
                "types": [
                    {"label": "post", "label_property": "name"},
                    {"label": "category", "label_property": "name"},
                ],
                "links": [],
            }
            revised["multi_hop"] = {
                "needed": True,
                "path": ["post", "category"],
                "why": "The category is not on the post.",
            }
            revised["open_questions"] = []
            yield {
                "type": "tool_call",
                "id": "plan",
                "name": "update_plan",
                "arguments": revised,
            }

        events = list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="Yes, post and category are the types that should be registered in the schema",
                thread_id=thread_id,
                models=self._models(),
                complete=complete,
            )
        )
        self.assertEqual(seen[0], "planner-model")
        text = "".join(event["data"].get("delta", "") for event in events if event["event"] == "text")
        self.assertNotIn(asked, text)
        thread = chat_store.get_thread(thread_id, self.space_id, self.principal.user_id)
        plan = next(item for item in thread["stack"] if item["kind"] == "plan")
        labels = [entry["label"] for entry in plan["payload"]["brief"]["ontology"]["types"]]
        self.assertEqual(labels, ["post", "category"])
        questions = [entry.get("question") for entry in plan["payload"]["brief"]["open_questions"]]
        self.assertNotIn(asked, questions)

    def test_a_repeated_open_question_is_retired(self) -> None:
        asked = "Which screen should open first?"
        thread_id = self._open_plan(_brief(open_questions=[{"id": "types", "question": asked}]))
        chat_store.append_message(thread_id, "assistant", asked)

        def complete(_cfg, _key, messages, _tools):
            last = str((messages[-1] or {}).get("content") or "")
            if last.startswith("Ask the user only this question"):
                yield {"type": "text", "delta": "The plan is on the canvas. Confirm it when it looks right."}
                return
            if "remove that question" in last:
                yield {"type": "text", "delta": asked}
                return
            yield {"type": "text", "delta": asked}

        list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="I don't know",
                thread_id=thread_id,
                models=self._models(),
                complete=complete,
            )
        )
        thread = chat_store.get_thread(thread_id, self.space_id, self.principal.user_id)
        reply = next(message["content"] for message in reversed(thread["messages"]) if message["role"] == "assistant")
        self.assertNotIn(asked, reply)
        self.assertIn("Confirm it when it looks right.", reply)
        plan = next(item for item in thread["stack"] if item["kind"] == "plan")
        questions = [entry.get("question") for entry in plan["payload"]["brief"]["open_questions"]]
        self.assertNotIn(asked, questions)

    def test_a_source_question_stays_on_the_surface_model(self) -> None:
        asked = "Confirm that shift clock is a live clock source."
        thread_id = self._open_plan(
            _brief(inputs=[{"name": "shift clock", "source": "clock", "confirmed": False}])
        )
        chat_store.append_message(thread_id, "assistant", asked)
        seen: list[str] = []

        def complete(cfg, _key, messages, tools):
            seen.append(cfg["model"])
            names = [tool["function"]["name"] for tool in tools]
            last = str((messages[-1] or {}).get("content") or "")
            if last.startswith("Ask the user only this question"):
                yield {"type": "text", "delta": "The plan is on the canvas. Anything else?"}
                return
            if names == ["choose_route"]:
                yield {
                    "type": "tool_call",
                    "id": "route",
                    "name": "choose_route",
                    "arguments": {"route": "surface", "reason": "confirming a source"},
                }
                return
            yield {"type": "text", "delta": "Noted."}

        list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="yes, the shift clock is live",
                thread_id=thread_id,
                models=self._models(),
                complete=complete,
            )
        )
        self.assertEqual(seen[0], "surface-model")
        self.assertNotIn("planner-model", seen)

    def test_a_silent_plan_turn_asks_the_open_question(self) -> None:
        asked = "Which screen should open first?"
        thread_id = self._open_plan(_brief(open_questions=[{"id": "types", "question": asked}]))
        calls = {"n": 0}

        def complete(_cfg, _key, messages, tools):
            last = str((messages[-1] or {}).get("content") or "")
            names = [tool["function"]["name"] for tool in tools]
            if names == ["choose_route"]:
                yield {
                    "type": "tool_call",
                    "id": "route",
                    "name": "choose_route",
                    "arguments": {"route": "surface", "reason": "asking what exists"},
                }
                return
            if "Say where things stand" in last or tools == []:
                return
            if calls["n"]:
                return
            calls["n"] += 1
            yield {
                "type": "tool_call",
                "id": "read",
                "name": "list_schemas",
                "arguments": {},
            }

        events = list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="what records do we already have?",
                thread_id=thread_id,
                models=self._models(),
                complete=complete,
            )
        )
        text = "".join(event["data"].get("delta", "") for event in events if event["event"] == "text")
        self.assertNotIn("I stopped after those tool calls", text)
        self.assertIn("The plan is on the canvas.", text)
        self.assertIn(asked, text)

    def _ask(self, thread_id: str, question: str) -> None:
        thread = chat_store.get_thread(thread_id, self.space_id, self.principal.user_id)
        plan = next(item for item in thread["stack"] if item["kind"] == "plan")
        payload = dict(plan["payload"])
        payload["asked"] = question
        chat_store.update_stack_item(thread_id, plan["id"], payload=payload)

    def test_path_labels_become_rejectable_record_kinds(self) -> None:
        brief = _brief(
            ontology={"types": [], "links": []},
            multi_hop={"needed": True, "path": ["post", "author", "cat"], "why": "The author is not on the post."},
        )
        revised = chat_plan.update_brief(None, brief, "planner")
        labels = [entry["label"] for entry in revised["brief"]["ontology"]["types"]]
        self.assertEqual(labels, ["post", "author", "cat"])
        ids = [item["id"] for item in revised["brief"]["assumptions"]]
        self.assertIn("type:post", ids)
        self.assertIn("type:author", ids)
        self.assertIn("type:cat", ids)
        self.assertIn("link:post:author", ids)
        self.assertIn("link:author:cat", ids)
        self.assertFalse(any("which is not a type" in problem for problem in revised["blocking"]))
        self.assertNotEqual(
            chat_plan.consultation_question(revised["brief"]),
            chat_plan.RECORD_KINDS_QUESTION,
        )
        healed = chat_plan.heal_brief(revised["brief"])
        self.assertEqual(healed, chat_plan.normalize_brief(revised["brief"]))
        kept = [item for item in revised["brief"]["assumptions"] if item["id"] != "type:cat"]
        dropped = chat_plan.update_brief(revised["brief"], {"assumptions": kept}, "surface")
        self.assertTrue(dropped["ok"], dropped)
        self.assertNotIn("cat", [entry["label"] for entry in dropped["brief"]["ontology"]["types"]])
        self.assertNotIn("cat", dropped["brief"]["multi_hop"]["path"])
        self.assertNotIn("link:author:cat", [item["id"] for item in dropped["brief"]["assumptions"]])
        again = chat_plan.update_brief(
            dropped["brief"],
            {
                "multi_hop": {
                    "needed": True,
                    "path": ["post", "author", "cat"],
                    "why": "The author is not on the post.",
                }
            },
            "planner",
        )
        self.assertNotIn("cat", [entry["label"] for entry in again["brief"]["ontology"]["types"]])
        self.assertNotIn("cat", again["brief"]["multi_hop"]["path"])

    def test_an_operation_registers_its_record_kind(self) -> None:
        asked = (
            "Could you confirm the types and link structure you'd like to define "
            "for taxonomies (and authors)?"
        )
        brief = {
            "routine": "Run the blog.",
            "ontology": {
                "types": [
                    {
                        "label": "post",
                        "label_property": "title",
                        "properties": [{"key": "title", "value_type": "string"}],
                    }
                ],
                "links": [],
            },
            "operations": [
                {"type": "post", "operation": "list"},
                {"type": "taxonomy", "operation": "list"},
            ],
            "screens": [
                {
                    "name": "Blog",
                    "views": [{"name": "Authors", "module": "table", "subject": "author", "data": "list"}],
                }
            ],
            "inputs": [{"name": "editor", "source": "person", "confirmed": True}],
            "open_questions": [{"id": "ontology", "question": asked}],
        }
        revised = chat_plan.update_brief(None, brief, "planner")
        labels = [entry["label"] for entry in revised["brief"]["ontology"]["types"]]
        self.assertEqual(labels, ["post", "taxonomy", "author"])
        ids = [item["id"] for item in revised["brief"]["assumptions"]]
        self.assertIn("type:taxonomy", ids)
        self.assertIn("type:author", ids)
        self.assertTrue(revised["ready"], revised["blocking"])
        self.assertFalse(any("which is not a type" in problem for problem in revised["blocking"]))
        self.assertNotIn(asked, [item["question"] for item in revised["brief"]["open_questions"]])
        self.assertNotIn(asked, revised["blocking"])
        dropped = chat_plan.update_brief(revised["brief"], {"rejected": ["type:taxonomy"]}, "surface")
        self.assertTrue(dropped["ok"], dropped)
        self.assertNotIn("taxonomy", [entry["label"] for entry in dropped["brief"]["ontology"]["types"]])
        self.assertNotIn("taxonomy", [entry["type"] for entry in dropped["brief"]["operations"]])
        self.assertIn("author", [entry["label"] for entry in dropped["brief"]["ontology"]["types"]])

    def test_named_records_drop_the_type_question(self) -> None:
        brief = _brief(
            open_questions=[{"id": "types", "question": chat_plan.LEGACY_RECORD_KINDS_QUESTION}]
        )
        revised = chat_plan.update_brief(None, brief, "planner")
        questions = [item["question"] for item in revised["brief"]["open_questions"]]
        self.assertNotIn(chat_plan.LEGACY_RECORD_KINDS_QUESTION, questions)
        self.assertNotIn(chat_plan.LEGACY_RECORD_KINDS_QUESTION, revised["blocking"])
        self.assertNotEqual(
            chat_plan.consultation_question(revised["brief"]),
            chat_plan.LEGACY_RECORD_KINDS_QUESTION,
        )
        thread_id = self._open_plan(revised["brief"])
        calls = {"n": 0}

        def complete(_cfg, _key, messages, tools):
            names = [tool["function"]["name"] for tool in tools]
            if names == ["choose_route"]:
                yield {
                    "type": "tool_call",
                    "id": "route",
                    "name": "choose_route",
                    "arguments": {"route": "deep", "reason": "the records are already named"},
                }
                return
            if tools == [] or calls["n"]:
                return
            calls["n"] += 1
            yield {
                "type": "tool_call",
                "id": "plan",
                "name": "update_plan",
                "arguments": {
                    "open_questions": [
                        {"id": "types", "question": chat_plan.LEGACY_RECORD_KINDS_QUESTION}
                    ]
                },
            }

        events = list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="use the records already on the plan",
                thread_id=thread_id,
                models=self._models(),
                complete=complete,
            )
        )
        text = "".join(event["data"].get("delta", "") for event in events if event["event"] == "text")
        self.assertNotIn(chat_plan.LEGACY_RECORD_KINDS_QUESTION, text)
        self.assertIn("Confirm it when it looks right.", text)
        stored = chat_store.get_thread(thread_id, self.space_id, self.principal.user_id)
        plan = next(item for item in stored["stack"] if item["kind"] == "plan")
        kept = [item.get("question") for item in plan["payload"]["brief"]["open_questions"]]
        self.assertNotIn(chat_plan.LEGACY_RECORD_KINDS_QUESTION, kept)
        self.assertNotEqual(plan["payload"].get("asked"), chat_plan.LEGACY_RECORD_KINDS_QUESTION)

    def test_the_records_question_is_asked_only_when_nothing_is_named(self) -> None:
        brief = _brief(
            ontology={"types": [], "links": []},
            multi_hop={"needed": False, "path": [], "why": ""},
        )
        revised = chat_plan.update_brief(None, brief, "planner")
        self.assertEqual(chat_plan.consultation_question(revised["brief"]), chat_plan.RECORD_KINDS_QUESTION)
        self.assertEqual(chat_plan.record_labels("Cat"), ["cat"])
        self.assertEqual(chat_plan.record_labels("post and author"), ["post", "author"])
        self.assertEqual(chat_plan.record_labels("One type of what?"), [])

    def test_a_question_about_type_does_not_extend_the_path(self) -> None:
        raw = chat_plan.normalize_brief(
            _brief(
                ontology={"types": [], "links": []},
                multi_hop={
                    "needed": True,
                    "path": ["post", "author", "cat"],
                    "why": "The author is not on the post.",
                },
            )
        )
        self.assertEqual(raw["ontology"]["types"], [])
        thread = chat_store.create_thread(self.space_id, self.principal.user_id, "Plan")
        chat_store.add_stack_item(
            thread["id"],
            "plan",
            "Plan",
            {
                "status": "consulting",
                "brief": raw,
                "blocking": [chat_plan.LEGACY_RECORD_KINDS_QUESTION],
                "ready": False,
                "asked": chat_plan.LEGACY_RECORD_KINDS_QUESTION,
            },
        )

        def complete(*_args):
            raise AssertionError("the records question does not call the model")

        events = list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="One type of what?",
                thread_id=thread["id"],
                models=self._models(),
                complete=complete,
            )
        )
        text = "".join(event["data"].get("delta", "") for event in events if event["event"] == "text")
        self.assertIn("kind of record", text)
        self.assertIn("post, author, and cat", text)
        self.assertNotIn(chat_plan.LEGACY_RECORD_KINDS_QUESTION, text)
        stored = chat_store.get_thread(thread["id"], self.space_id, self.principal.user_id)
        plan = next(item for item in stored["stack"] if item["kind"] == "plan")
        labels = [entry["label"] for entry in plan["payload"]["brief"]["ontology"]["types"]]
        self.assertEqual(labels, ["post", "author", "cat"])
        self.assertEqual(plan["payload"]["brief"]["multi_hop"]["path"], ["post", "author", "cat"])

    def test_a_naming_reply_is_stored_as_record_kinds(self) -> None:
        brief = _brief(
            ontology={"types": [], "links": []},
            multi_hop={"needed": False, "path": [], "why": ""},
            reconstruction={"avoids_runtime_guess": False, "because": ""},
        )
        thread_id = self._open_plan(brief)
        self._ask(thread_id, chat_plan.RECORD_KINDS_QUESTION)

        def complete(*_args):
            raise AssertionError("the records question does not call the model")

        events = list(
            chat_agent.run_turn(
                space_id=self.space_id,
                principal=self.principal,
                content="post and author",
                thread_id=thread_id,
                models=self._models(),
                complete=complete,
            )
        )
        text = "".join(event["data"].get("delta", "") for event in events if event["event"] == "text")
        self.assertIn("The plan is on the canvas.", text)
        self.assertIn("Say which link the sequence loads", text)
        self.assertNotIn(chat_plan.RECORD_KINDS_QUESTION, text)
        stored = chat_store.get_thread(thread_id, self.space_id, self.principal.user_id)
        plan = next(item for item in stored["stack"] if item["kind"] == "plan")
        labels = [entry["label"] for entry in plan["payload"]["brief"]["ontology"]["types"]]
        self.assertEqual(labels, ["post", "author"])
        self.assertEqual(plan["payload"]["brief"]["multi_hop"]["path"], [])

    def test_the_routine_does_not_block_and_is_not_asked_again(self) -> None:
        brief = _brief(
            routine="Manage and publish the blog.",
            open_questions=[{"id": "routine", "question": "What routine should this decision carry?"}],
        )
        revised = chat_plan.update_brief(None, brief, "planner")
        self.assertTrue(revised["ready"], revised["blocking"])
        self.assertEqual(revised["brief"]["open_questions"], [])
        self.assertEqual(chat_plan.consultation_question(revised["brief"]), "")
        unnamed = chat_plan.update_brief(None, _brief(routine=""), "planner")
        self.assertTrue(unnamed["ready"], unnamed["blocking"])
        self.assertFalse(any("routine" in problem.lower() for problem in unnamed["blocking"]))

    def test_each_decision_compiles_to_its_own_sequence(self) -> None:
        brief = _brief(
            outputs=[
                {"name": "assign nurse", "results": ["stay", "move"]},
                {"name": "review staffing", "results": ["keep", "call"]},
            ]
        )
        revised = chat_plan.update_brief(None, brief, "planner")
        items = chat_plan.compile_brief(revised["brief"])
        sequences = [
            item["payload"]["name"]
            for item in items
            if item["payload"].get("kind") == "sequence"
        ]
        self.assertIn("assign_nurse", sequences)
        self.assertIn("review_staffing", sequences)
        problems = chat_plan.validation_problems(self.principal, self.space_id, items)
        self.assertEqual(problems, [], problems)

    def test_a_link_does_not_become_a_decision(self) -> None:
        brief = _brief(
            reconstruction={"avoids_runtime_guess": False, "because": ""},
            multi_hop={"needed": False, "path": [], "why": ""},
            outputs=[],
            operations=[{"type": "nurse", "operation": "list"}],
            screens=[
                {
                    "name": "Ward",
                    "views": [{"name": "Nurses", "module": "table", "subject": "nurse", "data": "list"}],
                }
            ],
        )
        revised = chat_plan.update_brief(None, brief, "planner")
        self.assertFalse(revised["brief"]["multi_hop"]["needed"])
        self.assertFalse(any(item["id"] == "hop" for item in revised["brief"]["assumptions"]))

    def test_a_content_system_compiles_instance_operations_and_screens(self) -> None:
        brief = {
            "routine": "Run the blog.",
            "ontology": {
                "types": [
                    {
                        "label": "post",
                        "label_property": "title",
                        "properties": [
                            {"key": "title", "value_type": "string"},
                            {"key": "body", "value_type": "string"},
                        ],
                    },
                    {"label": "author", "label_property": "name"},
                ],
                "links": [
                    {
                        "from": "post",
                        "to": "author",
                        "label": "post_author",
                        "infers": "the author of the post",
                    }
                ],
            },
            "operations": [
                {"type": "post", "operation": "list"},
                {"type": "post", "operation": "read"},
                {"type": "post", "operation": "create"},
                {"type": "post", "operation": "update"},
                {"type": "post", "operation": "delete"},
                {"type": "author", "operation": "list"},
                {"type": "author", "operation": "create"},
            ],
            "screens": [
                {
                    "name": "Blog",
                    "views": [
                        {"name": "Posts", "module": "table", "subject": "post", "data": "list"},
                        {"name": "Edit post", "module": "form", "subject": "post", "data": "read", "action": "update"},
                        {"name": "Authors", "module": "table", "subject": "author", "data": "list"},
                        {"name": "Taxonomy", "module": "graph", "subject": "post"},
                    ],
                }
            ],
            "inputs": [{"name": "editor", "source": "person", "confirmed": True}],
        }
        revised = chat_plan.update_brief(None, brief, "planner")
        self.assertTrue(revised["ready"], revised["blocking"])
        self.assertFalse(revised["brief"]["multi_hop"]["needed"])
        items = chat_plan.compile_brief(revised["brief"])
        problems = chat_plan.validation_problems(self.principal, self.space_id, items)
        self.assertEqual(problems, [], problems)
        names = [item["payload"].get("name") for item in items]
        self.assertIn("list_post", names)
        self.assertIn("read_post", names)
        self.assertIn("add_post", names)
        self.assertIn("update_post", names)
        self.assertIn("delete_post", names)
        self.assertIn("list_author", names)
        self.assertIn("add_author", names)
        self.assertNotIn("create_post", names)
        schemas = [item for item in items if item["kind"] == "upsert_schema"]
        self.assertEqual(
            [item["payload"]["attributive_label"] for item in schemas],
            ["post", "author"],
        )
        console = next(item for item in items if item["kind"] == "upsert_console")
        views = {view["name"]: view for view in console["payload"]["document"]["views"]}
        modules = [
            module
            for view in views.values()
            for module in view.get("modules") or []
        ]
        by_title = {module["title"]: module for module in modules}
        self.assertEqual(by_title["Posts"]["type"], "table")
        self.assertEqual(by_title["Posts"]["dataSequenceId"], "list_post")
        edit = views["Edit post"]
        self.assertEqual(edit["kind"], "form")
        self.assertEqual(edit.get("modules") or [], [])
        self.assertEqual(edit["dataSequenceId"], "read_post")
        self.assertEqual(edit["actionSequenceId"], "update_post")
        self.assertEqual([field["name"] for field in edit["fields"]], ["title", "body"])
        self.assertEqual(edit["fields"][0]["id"], "f_title")
        self.assertEqual(edit["fields"][1]["type"], "textarea")
        self.assertEqual(edit["fields"][0]["required"], True)
        self.assertEqual(by_title["Taxonomy"]["type"], "graph")
        self.assertEqual(by_title["Taxonomy"]["dataSequenceId"], "read_post_author")
        self.assertNotIn("number", [module["type"] for module in modules])

    def _blog_items(self) -> tuple[dict, list[dict]]:
        brief = {
            "routine": "Run the blog.",
            "ontology": {
                "types": [{"label": "post", "label_property": "title"}],
                "links": [],
            },
            "operations": [{"type": "post", "operation": "list"}],
            "screens": [
                {
                    "name": "Blog",
                    "views": [{"name": "Posts", "module": "table", "subject": "post", "data": "list"}],
                }
            ],
            "inputs": [{"name": "editor", "source": "person", "confirmed": True}],
        }
        revised = chat_plan.update_brief(None, brief, "planner")
        self.assertTrue(revised["ready"], revised["blocking"])
        return revised["brief"], chat_plan.compile_brief(revised["brief"])

    def test_existing_names_are_left_in_place(self) -> None:
        brief, items = self._blog_items()
        fitted = chat_plan.reconcile_compiled(
            items,
            schemas={"post"},
            steps={"create_post"},
            consoles=set(),
        )
        self.assertNotIn(
            "post",
            [
                item["payload"].get("attributive_label")
                for item in fitted["items"]
                if item["kind"] == "upsert_schema"
            ],
        )
        self.assertIn("list_post", [item["payload"].get("name") for item in fitted["items"]])
        self.assertIn("Type post", fitted["already"])
        self.assertFalse(fitted["configured"])
        self.assertEqual(fitted["conflicts"], [])
        checked = chat_plan.apply_name_check(brief, fitted)
        self.assertEqual(checked["open_questions"], [])
        self.assertFalse(chat_plan.readiness(checked))

    def test_a_covered_space_asks_what_to_add(self) -> None:
        brief, items = self._blog_items()
        fitted = chat_plan.reconcile_compiled(
            items,
            schemas={"post"},
            steps={"create_post", "list_post"},
            consoles={"Blog"},
        )
        self.assertEqual(fitted["items"], [])
        self.assertTrue(fitted["configured"], fitted)
        self.assertIn("Type post", fitted["already"])
        self.assertIn("List post", fitted["already"])
        self.assertIn("Blog", fitted["already"])
        checked = chat_plan.apply_name_check(brief, fitted)
        self.assertEqual(checked["open_questions"][0]["question"], chat_plan.ALREADY_CONFIGURED)
        self.assertEqual(chat_plan.readiness(checked), [chat_plan.ALREADY_CONFIGURED])
        self.assertEqual(chat_plan.consultation_question(checked), chat_plan.ALREADY_CONFIGURED)

    def test_a_taken_step_blocks_the_plan_before_confirm(self) -> None:
        brief, items = self._blog_items()
        brief = {
            **brief,
            "open_questions": [{"id": "screen", "question": "Which screen should open first?", "blocks": ""}],
        }
        fitted = chat_plan.reconcile_compiled(
            items,
            schemas=set(),
            steps={"create_post"},
            consoles=set(),
        )
        self.assertFalse(any(item["kind"] == "upsert_schema" for item in fitted["items"]))
        self.assertTrue(fitted["conflicts"])
        self.assertIn("create_post", fitted["conflicts"][0])
        checked = chat_plan.apply_name_check(brief, fitted)
        self.assertEqual(checked["open_questions"][0]["question"], fitted["conflicts"][0])
        self.assertEqual(checked["open_questions"][1]["question"], "Which screen should open first?")
        self.assertEqual(chat_plan.consultation_question(checked), fitted["conflicts"][0])
        cleared = chat_plan.reconcile_compiled(items, schemas=set(), steps=set(), consoles=set())
        self.assertFalse(cleared["conflicts"])
        restored = chat_plan.apply_name_check(checked, cleared)
        self.assertEqual(restored["open_questions"], brief["open_questions"])

    def test_a_link_between_existing_steps_is_not_recreated(self) -> None:
        items = [
            {
                "kind": "upsert_query",
                "summary": "Decide x",
                "payload": {
                    "name": "decide_x",
                    "kind": "operation",
                    "node_label": "STEP",
                    "attributive_label": "decide_x",
                },
            },
            {
                "kind": "create_transition",
                "summary": "read_post to decide_x",
                "payload": {"from_step": "read_post", "to_step": "decide_x"},
            },
            {
                "kind": "create_transition",
                "summary": "read_post to decide_old",
                "payload": {"from_step": "read_post", "to_step": "decide_old"},
            },
        ]
        fitted = chat_plan.reconcile_compiled(
            items,
            schemas=set(),
            steps={"read_post", "decide_old"},
        )
        summaries = [item["summary"] for item in fitted["items"]]
        self.assertEqual(summaries, ["Decide x", "read_post to decide_x"])
        self.assertIn("read_post to decide_old", fitted["already"])

    def test_preview_uses_the_live_names(self) -> None:
        brief, _items = self._blog_items()
        occupied = {
            "schemas": {"post"},
            "steps": {"create_post", "list_post"},
            "sequences": set(),
            "consoles": {"blog"},
        }
        empty_records = {"schemas": {}, "operations": {}, "consoles": {}}
        with (
            patch.object(chat_plan, "load_space_names", return_value=occupied),
            patch.object(chat_plan, "load_space_records", return_value=empty_records),
        ):
            fitted = chat_plan.preview_for_brief(self.space_id, brief)
        self.assertEqual(fitted["items"], [])
        self.assertTrue(fitted["configured"])
        self.assertEqual(fitted["brief"]["open_questions"][0]["question"], chat_plan.ALREADY_CONFIGURED)
        with patch.object(chat_plan, "load_space_names", return_value=None):
            failed = chat_plan.preview_for_brief(self.space_id, brief)
        self.assertTrue(failed["items"])
        self.assertFalse(failed["configured"])

    def _editor_items(self) -> tuple[dict, list[dict]]:
        brief = {
            "routine": "Run the blog.",
            "ontology": {
                "types": [
                    {
                        "label": "post",
                        "label_property": "title",
                        "properties": [
                            {"key": "title", "value_type": "string"},
                            {"key": "body", "value_type": "string"},
                        ],
                    }
                ],
                "links": [],
            },
            "operations": [
                {"type": "post", "operation": "list"},
                {"type": "post", "operation": "create"},
                {"type": "post", "operation": "update"},
            ],
            "screens": [
                {
                    "name": "Blog",
                    "views": [
                        {
                            "name": "Edit post",
                            "module": "form",
                            "subject": "post",
                            "data": "read",
                            "action": "update",
                        }
                    ],
                }
            ],
            "inputs": [{"name": "editor", "source": "person", "confirmed": True}],
        }
        revised = chat_plan.update_brief(None, brief, "planner")
        self.assertTrue(revised["ready"], revised["blocking"])
        return revised["brief"], chat_plan.compile_brief(revised["brief"])

    def _saved_operation(self, payload: dict, query_id: str) -> dict:
        node = {
            "attributive_label": payload.get("attributive_label"),
            "properties": payload.get("instance_properties") or [],
        }
        query = {
            "operation": payload.get("operation"),
            "parameters": payload.get("parameters") or [],
            "match": [{"patterns": [{"path": [{"kind": "node", "node": node}]}]}],
            "return": {"items": payload.get("return_items") or []},
            "set": [{"expression": expression} for expression in payload.get("set_expressions") or []],
        }
        return {
            "id": query_id,
            "operation": payload.get("operation"),
            "parameters": payload.get("parameters") or [],
            "builder_config": {"query": query},
        }

    def _records_from(self, items: list[dict]) -> tuple[dict, dict, dict, dict]:
        schemas: set[str] = set()
        steps: set[str] = set()
        records: dict[str, dict] = {"schemas": {}, "operations": {}, "consoles": {}}
        for item in items:
            payload = item["payload"]
            if item["kind"] == "upsert_schema":
                label = payload["attributive_label"]
                schemas.add(label)
                steps.add(f"create_{label}")
                records["schemas"][label] = {
                    "id": f"schema-{label}",
                    "properties": copy.deepcopy(payload["properties"]),
                }
            elif item["kind"] == "upsert_query" and payload.get("kind") != "sequence":
                name = payload.get("name") or payload.get("attributive_label")
                steps.add(name)
                records["operations"][name] = self._saved_operation(copy.deepcopy(payload), f"query-{name}")
            elif item["kind"] == "upsert_console":
                records["consoles"][payload["name"].lower()] = {
                    "id": "console-blog",
                    "document": copy.deepcopy(payload["document"]),
                }
        occupied = {
            "schemas": schemas,
            "steps": steps,
            "sequences": set(),
            "consoles": set(records["consoles"]),
        }
        return occupied, records

    def test_a_matching_space_is_already_configured(self) -> None:
        brief, items = self._editor_items()
        occupied, records = self._records_from(items)
        fitted = chat_plan.reconcile_compiled(items, **occupied, records=records)
        self.assertEqual(fitted["items"], [])
        self.assertTrue(fitted["configured"], fitted)
        checked = chat_plan.apply_name_check(brief, fitted)
        self.assertEqual(checked["open_questions"][0]["question"], chat_plan.ALREADY_CONFIGURED)

    def test_missing_fields_update_the_schema_operation_and_form(self) -> None:
        brief, items = self._editor_items()
        occupied, records = self._records_from(items)
        title_only = {
            "key": "title",
            "value_type": "string",
            "is_label": True,
            "is_required": True,
            "is_key": False,
            "is_indexed": False,
            "is_embedded": False,
        }
        records["schemas"]["post"]["properties"] = [
            {
                "key": "id",
                "value_type": "UID",
                "is_required": True,
                "is_key": True,
                "is_label": False,
                "is_indexed": False,
                "is_embedded": False,
            },
            title_only,
        ]
        for name, package in records["operations"].items():
            query = package["builder_config"]["query"]
            query["parameters"] = [param for param in query["parameters"] if param.get("name") in ("id", "title")]
            query["return"]["items"] = [item for item in query["return"]["items"] if item.get("alias") in ("id", "title")]
            query["set"] = [
                item for item in query["set"] if "body" not in str(item.get("expression") or "")
            ]
            node = query["match"][0]["patterns"][0]["path"][0]["node"]
            node["properties"] = [prop for prop in node["properties"] if prop.get("key") != "body"]
            package["parameters"] = query["parameters"]
        form = records["consoles"]["blog"]["document"]["views"][0]
        form["fields"] = [field for field in form["fields"] if field["name"] != "body"]
        fitted = chat_plan.reconcile_compiled(items, **occupied, records=records)
        self.assertFalse(fitted["configured"], fitted)
        schema = next(item for item in fitted["items"] if item["kind"] == "upsert_schema")
        self.assertEqual(schema["payload"]["schema_id"], "schema-post")
        self.assertTrue(schema["payload"]["update_existing"])
        keys = [prop.get("name") or prop.get("key") for prop in schema["payload"]["properties"]]
        self.assertEqual(keys, ["id", "title", "body"])
        self.assertTrue(
            next(prop["is_label"] for prop in schema["payload"]["properties"] if (prop.get("name") or prop.get("key")) == "title")
        )
        body = next(prop for prop in schema["payload"]["properties"] if (prop.get("name") or prop.get("key")) == "body")
        self.assertFalse(body["is_required"])
        self.assertFalse(body["is_label"])
        add_post = next(item for item in fitted["items"] if item["payload"].get("name") == "add_post")
        self.assertEqual(add_post["payload"]["id"], "query-add_post")
        self.assertIn("body", [param["name"] for param in add_post["payload"]["parameters"]])
        console = next(item for item in fitted["items"] if item["kind"] == "upsert_console")
        self.assertEqual(console["payload"]["id"], "console-blog")
        edit = console["payload"]["document"]["views"][0]
        self.assertEqual([field["name"] for field in edit["fields"]], ["title", "body"])
        checked = chat_plan.apply_name_check(brief, fitted)
        self.assertEqual(checked["open_questions"], [])
        self.assertEqual(chat_plan.readiness(checked), [])
        problems = chat_plan.validation_problems(self.principal, self.space_id, fitted["items"])
        self.assertEqual(problems, [], problems)


if __name__ == "__main__":
    unittest.main()
