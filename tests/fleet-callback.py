#!/usr/bin/env python3
"""Fleet presence callback and local-Neo4j export guard."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "Engine"))

from fastapi.testclient import TestClient  # noqa: E402

from control_plane.app import create_app  # noqa: E402
from control_plane.db import Database  # noqa: E402
from control_plane.util import hash_password, hash_token  # noqa: E402
from server import fleet, instance_export  # noqa: E402


class FleetCallbackTest(unittest.TestCase):
    def test_unset_env_does_not_call_out(self) -> None:
        calls: list[tuple] = []
        with patch.dict(
            os.environ,
            {
                "PONA_FLOW_FLEET_URL": "",
                "PONA_FLOW_FLEET_TOKEN": "",
                "PONA_FLOW_FLEET_INSTANCE_ID": "",
            },
            clear=False,
        ):
            fleet.notify_event_count(sender=lambda *args: calls.append(args))
        self.assertEqual(calls, [])

    def test_configured_env_posts_the_count(self) -> None:
        calls: list[tuple] = []
        with patch.dict(
            os.environ,
            {
                "PONA_FLOW_FLEET_URL": "https://start.example",
                "PONA_FLOW_FLEET_TOKEN": "fleet-token",
                "PONA_FLOW_FLEET_INSTANCE_ID": "inst_1",
            },
            clear=False,
        ):
            with patch.object(fleet, "_event_count", return_value=2):
                fleet.notify_event_count(sender=lambda *args: calls.append(args))
        self.assertEqual(calls, [("https://start.example", "fleet-token", "inst_1", 2)])

    def test_bad_fleet_token_is_rejected(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = Database(Path(tmp.name) / "control.db")
        account = db.create_account("ada@example.com", hash_password("long-password"), "Ada")
        row = db.insert_instance(
            account["id"],
            tier="sandbox",
            status="running",
            app_name="pf-ada",
            region="iad",
            fly_machine_id="mach_test",
            fleet_token_hash=hash_token("good-token"),
            event_count=0,
            sleep_allowed=1,
        )
        calls: list[tuple] = []

        class Fly:
            def set_mode(self, app: str, machine_id: str, mode: str) -> None:
                calls.append((app, machine_id, mode))

        client = TestClient(
            create_app(
                database=db,
                fly_factory=lambda _token: Fly(),
                inline_jobs=True,
                start_scheduler=False,
            )
        )
        with patch.dict(os.environ, {"FLY_API_TOKEN": "org-token"}, clear=False):
            bad = client.post(
                f"/api/internal/instances/{row['id']}/presence",
                json={"event_count": 3},
                headers={"Authorization": "Bearer wrong-token"},
            )
        self.assertEqual(bad.status_code, 401, bad.text)
        self.assertEqual(calls, [])
        self.assertEqual(db.instance(row["id"])["event_count"], 0)

    def test_remote_neo4j_is_not_a_local_export(self) -> None:
        self.assertTrue(instance_export.neo4j_is_local("bolt://127.0.0.1:7687"))
        self.assertFalse(instance_export.neo4j_is_local("neo4j+s://example.databases.neo4j.io"))


if __name__ == "__main__":
    unittest.main()
