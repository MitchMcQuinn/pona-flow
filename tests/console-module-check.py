#!/usr/bin/env python3
"""A console module check reports what the module would show, or which sequence it runs.

Run from the repo root:
    .venv/bin/python tests/console-module-check.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "Engine"))

from server import catalog, console_check  # noqa: E402

READ = {"id": "OP_open", "name": "READ_OPEN", "kind": "operation", "operation": "read"}
TICK = {"id": "OP_tick", "name": "SIMULATE_WORLD_TICK", "kind": "operation", "operation": "update"}


def resolve(ref: str):
    if ref in ("READ_OPEN", "OP_open"):
        return READ
    if ref in ("SIMULATE_WORLD_TICK", "OP_tick"):
        return TICK
    return None


def live(modules: list[dict]) -> dict:
    return {"views": [{"id": "live", "kind": "live", "modules": modules}]}


class DescribeModuleTest(unittest.TestCase):
    def test_stat_uses_the_one_number_in_a_row(self) -> None:
        data = {"kind": "table", "columns": ["count"], "rows": [{"count": 12}]}
        ok, shows = console_check.describe_module("stat", data, {}, loaded=True)
        self.assertTrue(ok)
        self.assertIn("12", shows)
        self.assertIn("count", shows)

    def test_stat_rejects_two_numbers(self) -> None:
        data = {"kind": "table", "rows": [{"open": 4, "closed": 9}]}
        ok, shows = console_check.describe_module("stat", data, {}, loaded=True)
        self.assertFalse(ok)
        self.assertIn("expected-shape", shows)
        self.assertIn("open=4", shows)

    def test_text_shows_row_fields_and_badge_does_not(self) -> None:
        data = {"kind": "table", "rows": [{"status": "Packed"}]}
        text_ok, text = console_check.describe_module("text", data, {}, loaded=True)
        badge_ok, badge = console_check.describe_module("badge", data, {}, loaded=True)
        self.assertTrue(text_ok)
        self.assertIn("Packed", text)
        self.assertFalse(badge_ok)
        self.assertIn("text module", badge)

    def test_table_names_the_first_row(self) -> None:
        data = {"kind": "table", "rows": [{"status": "Packed", "owner": "Ada"}, {"status": "Open", "owner": "Bea"}]}
        ok, shows = console_check.describe_module("table", data, {}, loaded=True)
        self.assertTrue(ok)
        self.assertIn("2 rows", shows)
        self.assertIn("status=Packed", shows)

    def test_graph_counts_nodes(self) -> None:
        data = {
            "kind": "graph",
            "graph": {
                "nodes": [{"id": "a", "label": "Order"}],
                "relationships": [{"source": "a", "target": "b", "type": "PLACED"}],
            },
        }
        ok, shows = console_check.describe_module("graph", data, {}, loaded=True)
        self.assertTrue(ok)
        self.assertIn("Order", shows)
        self.assertIn("1 relationships", shows)

    def test_chart_asks_for_the_numeric_column(self) -> None:
        data = {"kind": "table", "rows": [{"status": "Packed", "count": 4}]}
        ok, shows = console_check.describe_module("bar", data, {}, loaded=True)
        self.assertFalse(ok)
        self.assertIn("valueKey", shows)
        fixed, fixed_shows = console_check.describe_module(
            "bar", data, {"categoryKey": "status", "valueKey": "count"}, loaded=True
        )
        self.assertTrue(fixed)
        self.assertIn("status by count", fixed_shows)

    def test_progress_needs_a_top_level_value(self) -> None:
        row = {"kind": "table", "rows": [{"count": 64}]}
        ok, shows = console_check.describe_module("progress", row, {}, loaded=True)
        self.assertFalse(ok)
        self.assertIn("stat", shows)
        meter, meter_shows = console_check.describe_module("progress", {"value": 64, "label": "Pick rate"}, {}, loaded=True)
        self.assertTrue(meter)
        self.assertIn("64%", meter_shows)

    def test_data_path_picks_one_number_out_of_a_wide_row(self) -> None:
        data = {"rows": [{"count": 12, "other": 3}]}
        wide, _shows = console_check.describe_module("stat", data, {}, loaded=True)
        picked, shows = console_check.describe_module("stat", data, {"dataPath": "rows.0.count"}, loaded=True)
        self.assertFalse(wide)
        self.assertTrue(picked)
        self.assertIn("12", shows)


class CheckDocumentTest(unittest.TestCase):
    def test_stat_check_runs_the_read_and_reports_the_value(self) -> None:
        seen: list[str] = []

        def execute(query, view_id):
            seen.append(query["id"])
            self.assertEqual(view_id, "live")
            return {"status": "inactive", "final_result": {"kind": "table", "rows": [{"count": 12}]}}

        report = console_check.check_document(
            "space",
            live([{"id": "m1", "type": "stat", "title": "Open", "dataSequenceId": "READ_OPEN", "dataSource": "sequence"}]),
            resolve=resolve,
            execute=execute,
        )
        self.assertTrue(report["ok"], report["summary"])
        self.assertEqual(seen, ["OP_open"])
        self.assertIn("12", report["modules"][0]["shows"])
        self.assertEqual(report["modules"][0]["data_sequence"]["name"], "READ_OPEN")

    def test_button_names_its_sequence_and_does_not_run_it(self) -> None:
        def execute(_query, _view_id):
            raise AssertionError("action sequences are not executed")

        report = console_check.check_document(
            "space",
            live(
                [
                    {
                        "id": "go",
                        "type": "button",
                        "title": "Advance",
                        "actionSequenceId": "SIMULATE_WORLD_TICK",
                        "config": {"label": "Advance"},
                    }
                ]
            ),
            resolve=resolve,
            execute=execute,
        )
        self.assertTrue(report["ok"], report["summary"])
        self.assertEqual(report["modules"][0]["runs"], "SIMULATE_WORLD_TICK")
        self.assertIn("Pressing it runs", report["modules"][0]["shows"])

    def test_form_module_warns_when_its_read_would_not_fill_the_fields(self) -> None:
        def execute(_query, _view_id):
            return {"status": "inactive", "final_result": {"kind": "table", "rows": [{"note": "Dock 2"}]}}

        report = console_check.check_document(
            "space",
            live(
                [
                    {
                        "id": "birth",
                        "type": "form",
                        "title": "Person",
                        "dataSequenceId": "READ_OPEN",
                        "actionSequenceId": "SIMULATE_WORLD_TICK",
                        "dataSource": "sequence",
                        "actionSource": "sequence",
                        "config": {"fields": '[{"name":"note","label":"Note","type":"text"}]'},
                    }
                ]
            ),
            resolve=resolve,
            execute=execute,
        )
        self.assertFalse(report["ok"])
        self.assertIn("stay blank", report["modules"][0]["shows"])
        self.assertEqual(report["modules"][0]["runs"], "SIMULATE_WORLD_TICK")

    def test_form_does_not_run_the_submit_sequence_as_its_data(self) -> None:
        def execute(_query, _view_id):
            raise AssertionError("a form does not load the sequence it submits")

        report = console_check.check_document(
            "space",
            live(
                [
                    {
                        "id": "birth",
                        "type": "form",
                        "title": "Person",
                        "actionSequenceId": "SIMULATE_WORLD_TICK",
                        "config": {"fields": '[{"name":"note","label":"Note","type":"text"}]'},
                    }
                ]
            ),
            resolve=resolve,
            execute=execute,
        )
        self.assertTrue(report["ok"], report["summary"])
        self.assertIn("note", report["modules"][0]["shows"])
        self.assertEqual(report["modules"][0]["runs"], "SIMULATE_WORLD_TICK")

    def test_missing_sequence_waits_until_it_exists(self) -> None:
        report = console_check.check_document(
            "space",
            live([{"id": "m", "type": "table", "title": "Later", "dataSequenceId": "NOT_YET", "dataSource": "sequence"}]),
            defer_missing=True,
            resolve=resolve,
            execute=lambda *_args: (_ for _ in ()).throw(AssertionError("missing sequence was run")),
        )
        self.assertTrue(report["ok"])
        self.assertTrue(report["modules"][0]["deferred"])
        refused = console_check.check_document(
            "space",
            live([{"id": "m", "type": "table", "title": "Later", "dataSequenceId": "NOT_YET", "dataSource": "sequence"}]),
            resolve=resolve,
            execute=lambda *_args: (_ for _ in ()).throw(AssertionError("missing sequence was run")),
        )
        self.assertFalse(refused["ok"])
        self.assertIn("NOT_YET", refused["summary"])

    def test_form_view_warns_when_a_row_would_not_fill_the_fields(self) -> None:
        def execute(_query, _view_id):
            return {"status": "inactive", "final_result": {"kind": "table", "rows": [{"full_name": "Ada"}]}}

        report = console_check.check_document(
            "space",
            {
                "views": [
                    {
                        "id": "form",
                        "kind": "form",
                        "name": "Person",
                        "fields": [{"name": "full_name"}],
                        "dataSequenceId": "READ_OPEN",
                        "actionSequenceId": "SIMULATE_WORLD_TICK",
                    }
                ]
            },
            resolve=resolve,
            execute=execute,
        )
        self.assertFalse(report["ok"])
        self.assertIn("stay blank", report["modules"][0]["shows"])
        self.assertIn("Submit runs SIMULATE_WORLD_TICK", report["modules"][0]["shows"])

    def test_a_views_object_keeps_its_modules(self) -> None:
        document = catalog._normalize_console_document(
            {
                "views": {
                    "view_main": {
                        "id": "view_main",
                        "name": "On-Call",
                        "modules": [
                            {
                                "id": "mod_form",
                                "type": "form",
                                "title": "File",
                                "fields": '[{"name":"note"}]',
                                "dataSequenceId": "READ_OPEN",
                            }
                        ],
                    }
                },
                "activeViewId": "view_main",
            }
        )
        module = document["views"][0]["modules"][0]
        self.assertEqual(module["id"], "mod_form")
        self.assertEqual(module["config"]["fields"], '[{"name":"note"}]')
        self.assertEqual(module["layout"]["x"], 0)
        report = console_check.check_document(
            "space",
            {
                "views": {
                    "view_main": {
                        "id": "view_main",
                        "name": "On-Call",
                        "modules": [
                            {
                                "id": "mod_open",
                                "type": "stat",
                                "title": "Open",
                                "dataSequenceId": "READ_OPEN",
                            }
                        ],
                    }
                },
                "activeViewId": "view_main",
            },
            resolve=resolve,
            execute=lambda *_args: {
                "status": "inactive",
                "final_result": {"kind": "table", "columns": ["count"], "rows": [{"count": 12}]},
            },
        )
        self.assertTrue(report["ok"], report["summary"])
        self.assertEqual(report["modules"][0]["title"], "Open")

    def test_an_empty_console_is_not_verified(self) -> None:
        report = console_check.check_document("space", {"views": [], "activeViewId": ""}, resolve=resolve)
        self.assertFalse(report["ok"])
        self.assertIn("no modules", report["summary"])


if __name__ == "__main__":
    unittest.main()
