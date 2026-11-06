#!/usr/bin/env python3
"""Browser tab title follows the app name, and the icon is a wave or a short label."""

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

from server import branding, config, local_auth, migrations  # noqa: E402
from server.app import app  # noqa: E402


class TabChromeTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.root = Path(self._tmpdir.name)
        self.db_path = self.root / "catalog.db"
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
                "FLY_APP_NAME": "pona-flow-instance",
                "FLY_APP": "",
            },
            clear=False,
        )
        env.start()
        self.addCleanup(env.stop)
        catalog = patch.object(config, "catalog_sqlite_path", return_value=self.db_path)
        catalog.start()
        self.addCleanup(catalog.stop)
        data = patch.object(config, "data_dir", return_value=self.root)
        data.start()
        self.addCleanup(data.stop)
        migrations.run_startup_migrations()
        local_auth.reset_login_throttle()
        self.client = TestClient(app, base_url="http://127.0.0.1")

    def _setup_admin(self) -> None:
        response = self.client.post(
            "/api/auth/setup",
            json={"email": "admin@example.com", "password": "a strong password", "display_name": "Admin"},
        )
        self.assertEqual(response.status_code, 200, response.text)

    def test_status_and_served_title_use_the_app_name(self) -> None:
        status = self.client.get("/api/auth/status")
        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.json()["app_name"], "pona-flow-instance")
        self.assertEqual(status.json()["icon_label"], "")
        self.assertEqual(branding.tab_title(), "pona-flow-instance")
        html = branding.with_tab_title("<html><head><title>pona flow</title></head></html>")
        self.assertIn("<title>pona-flow-instance</title>", html)
        escaped = branding.with_tab_title("<title>pona flow</title>")
        with patch.dict(os.environ, {"FLY_APP_NAME": "a<b"}):
            self.assertIn("<title>a&lt;b</title>", branding.with_tab_title("<title>old</title>"))
        self.assertIn("<title>pona-flow-instance</title>", escaped)

    def test_wave_icon_until_a_label_is_saved(self) -> None:
        icon = self.client.get("/favicon.svg")
        self.assertEqual(icon.status_code, 200)
        self.assertIn("image/svg+xml", icon.headers["content-type"])
        body = icon.text
        for color in ("#6366f1", "#8b5cf6", "#d946ef", "#06b6d4"):
            self.assertIn(color, body)
        self.assertIn("<path", body)
        self.assertNotIn("<text", body)

        self._setup_admin()
        saved = self.client.post("/api/instance/branding", json={"icon_label": "  ac "})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["icon_label"], "ac")
        labeled = self.client.get("/favicon.svg?v=ignored").text
        self.assertIn(">ac</text>", labeled)
        self.assertNotIn("<path", labeled)
        self.assertNotIn("ignored", labeled)

        nasty = self.client.post("/api/instance/branding", json={"icon_label": "<s>"})
        self.assertEqual(nasty.status_code, 200, nasty.text)
        svg = self.client.get("/favicon.svg").text
        self.assertNotIn("<script", svg)
        self.assertIn("&lt;s&gt;", svg)

        cleared = self.client.post("/api/instance/branding", json={"icon_label": "   "})
        self.assertEqual(cleared.status_code, 200, cleared.text)
        self.assertEqual(cleared.json()["icon_label"], "")
        self.assertIn("<path", self.client.get("/favicon.svg").text)

    def test_label_is_limited_and_admin_only(self) -> None:
        self.assertEqual(self.client.post("/api/instance/branding", json={"icon_label": "ac"}).status_code, 401)
        self._setup_admin()
        too_long = self.client.post("/api/instance/branding", json={"icon_label": "abcdefghij"})
        self.assertEqual(too_long.status_code, 400)
        self.client.post("/api/auth/logout")
        local_auth.create_local_user("member@example.com", "a strong password", "Member")
        signed_in = self.client.post(
            "/api/auth/login",
            json={"email": "member@example.com", "password": "a strong password"},
        )
        self.assertEqual(signed_in.status_code, 200, signed_in.text)
        forbidden = self.client.post("/api/instance/branding", json={"icon_label": "ac"})
        self.assertEqual(forbidden.status_code, 403)


if __name__ == "__main__":
    unittest.main()
