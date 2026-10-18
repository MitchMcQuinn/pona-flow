#!/usr/bin/env python3
"""Product tour flag: new accounts start unseen, skip/finish persists, reset re-arms it."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "Engine"))

from fastapi.testclient import TestClient  # noqa: E402

from server import config, local_auth, migrations, rbac  # noqa: E402
from server.app import app  # noqa: E402


class OnboardingTourTest(unittest.TestCase):
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
            },
            clear=False,
        )
        env.start()
        self.addCleanup(env.stop)
        catalog = patch.object(config, "catalog_sqlite_path", return_value=self.db_path)
        catalog.start()
        self.addCleanup(catalog.stop)
        migrations.run_startup_migrations()
        local_auth.reset_login_throttle()
        self.client = TestClient(app, base_url=self.BASE)
        r = self.client.post(
            "/api/auth/setup",
            json={"email": "admin@example.com", "password": "a strong password"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.setup_payload = r.json()

    def _post(self, body: dict):
        return self.client.post(
            "/api/me/onboarding", json=body, headers={"Origin": self.BASE}
        )

    def test_new_account_has_not_seen_tour(self) -> None:
        self.assertIs(self.setup_payload["onboarding_tour_seen"], False)
        self.assertIs(self.client.get("/api/me").json()["onboarding_tour_seen"], False)

    def test_mark_seen_persists_across_login(self) -> None:
        r = self._post({"seen": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIs(self.client.get("/api/me").json()["onboarding_tour_seen"], True)
        self.client.post("/api/auth/logout", headers={"Origin": self.BASE})
        r = self.client.post(
            "/api/auth/login",
            json={"email": "admin@example.com", "password": "a strong password"},
        )
        self.assertIs(r.json()["onboarding_tour_seen"], True)

    def test_reset_rearms_tour(self) -> None:
        self._post({"seen": True})
        self.assertEqual(self._post({"seen": False}).status_code, 200)
        self.assertIs(self.client.get("/api/me").json()["onboarding_tour_seen"], False)

    def test_rejects_non_boolean(self) -> None:
        self.assertEqual(self._post({"seen": "yes"}).status_code, 400)
        self.assertEqual(self._post({}).status_code, 400)

    def test_requires_sign_in(self) -> None:
        self.client.post("/api/auth/logout", headers={"Origin": self.BASE})
        self.assertEqual(self._post({"seen": True}).status_code, 401)

    def test_agents_never_get_the_tour(self) -> None:
        self.assertTrue(rbac.onboarding_tour_seen_for("agent", "agent-1"))


if __name__ == "__main__":
    unittest.main()
