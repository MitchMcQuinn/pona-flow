#!/usr/bin/env python3
"""Built-in auth HTTP contract: setup once, login/logout cookies, CSRF, invites, mode gating."""

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


class LocalAuthRoutesTest(unittest.TestCase):
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
        # No lifespan: we only exercise routes against the temp catalog. A loopback
        # base_url makes the ASGI ``server`` scope look like a local uvicorn listener.
        self.client = TestClient(app, base_url=self.BASE)

    BASE = "http://127.0.0.1"

    def _setup_admin(self) -> dict:
        r = self.client.post(
            "/api/auth/setup",
            json={"email": "admin@example.com", "password": "a strong password", "display_name": "Admin"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_status_reports_setup_required(self) -> None:
        r = self.client.get("/api/auth/status")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["mode"], "local")
        self.assertTrue(r.json()["setup_required"])
        self._setup_admin()
        self.assertFalse(self.client.get("/api/auth/status").json()["setup_required"])

    def test_setup_once_sets_cookie_and_grants_admin(self) -> None:
        me = self._setup_admin()
        self.assertTrue(me["is_superadmin"])
        self.assertTrue(me["can_create_spaces"])
        self.assertEqual(me["auth_mode"], "local")
        cookie = self.client.cookies.get("pona_session")
        self.assertTrue(cookie and cookie.startswith("pfs_"))
        # Cookie authenticates /api/me.
        self.assertEqual(self.client.get("/api/me").json()["email"], "admin@example.com")
        # Second setup attempt is refused.
        r = self.client.post("/api/auth/setup", json={"email": "x@example.com", "password": "a strong password"})
        self.assertEqual(r.status_code, 409)

    def test_cookie_flags(self) -> None:
        r = self.client.post(
            "/api/auth/setup", json={"email": "admin@example.com", "password": "a strong password"}
        )
        set_cookie = r.headers.get("set-cookie", "").lower()
        self.assertIn("httponly", set_cookie)
        self.assertIn("samesite=lax", set_cookie)
        self.assertNotIn("secure", set_cookie)  # plain http test server
        # Behind a TLS-terminating proxy the cookie becomes Secure.
        self.client.post("/api/auth/logout")
        r = self.client.post(
            "/api/auth/login",
            json={"email": "admin@example.com", "password": "a strong password"},
            headers={"X-Forwarded-Proto": "https"},
        )
        self.assertIn("secure", r.headers.get("set-cookie", "").lower())

    def test_login_logout_and_unauthorized(self) -> None:
        self._setup_admin()
        self.client.post("/api/auth/logout")
        self.assertEqual(self.client.get("/api/me").status_code, 401)
        r = self.client.post("/api/auth/login", json={"email": "admin@example.com", "password": "wrong password"})
        self.assertEqual(r.status_code, 401)
        r = self.client.post("/api/auth/login", json={"email": "ADMIN@example.com", "password": "a strong password"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.client.get("/api/me").status_code, 200)
        self.assertEqual(self.client.post("/api/auth/logout").status_code, 200)
        self.assertEqual(self.client.get("/api/me").status_code, 401)

    def test_bearer_session_token_for_scripts(self) -> None:
        me = self._setup_admin()
        token = self.client.cookies.get("pona_session")
        fresh = TestClient(app, base_url=self.BASE)
        r = fresh.get("/api/me", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["principal_id"], me["principal_id"])

    def test_cross_site_post_with_cookie_is_rejected(self) -> None:
        self._setup_admin()
        # A same-origin browser POST passes.
        r = self.client.post(
            "/api/me/settings", json={"timezone": "UTC"},
            headers={"Origin": self.BASE, "Sec-Fetch-Site": "same-origin"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        # A cross-site POST (as a browser would label it) is refused even with the cookie.
        r = self.client.post(
            "/api/me/settings", json={"timezone": "UTC"},
            headers={"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"},
        )
        self.assertEqual(r.status_code, 403)
        r = self.client.post(
            "/api/me/settings", json={"timezone": "UTC"}, headers={"Origin": "https://evil.example"},
        )
        self.assertEqual(r.status_code, 403)
        # GETs are never blocked by the CSRF check.
        self.assertEqual(self.client.get("/api/me", headers={"Sec-Fetch-Site": "cross-site"}).status_code, 200)

    def test_login_rate_limit(self) -> None:
        self._setup_admin()
        self.client.post("/api/auth/logout")
        for _ in range(local_auth.LOGIN_MAX_FAILURES_PER_EMAIL):
            r = self.client.post("/api/auth/login", json={"email": "admin@example.com", "password": "wrong password"})
            self.assertEqual(r.status_code, 401)
        r = self.client.post("/api/auth/login", json={"email": "admin@example.com", "password": "a strong password"})
        self.assertEqual(r.status_code, 429)
        self.assertTrue(int(r.headers.get("retry-after", "0")) > 0)

    def test_signup_requires_invite_unless_open(self) -> None:
        self._setup_admin()
        anon = TestClient(app, base_url=self.BASE)
        r = anon.post("/api/auth/signup", json={"email": "friend@example.com", "password": "a strong password"})
        self.assertEqual(r.status_code, 403)
        # Invite the email into a space, then signup succeeds and the invite is claimed.
        conn = config.connect_sqlite(self.db_path)
        conn.execute("CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, name TEXT)")
        conn.execute("INSERT INTO spaces (id, name) VALUES ('S1', 'S1')")
        conn.commit()
        conn.close()
        rbac.seed_default_roles("S1")
        rbac.invite_member("S1", "friend@example.com")
        r = anon.post("/api/auth/signup", json={"email": "Friend@example.com", "password": "a strong password"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["is_superadmin"])
        self.assertTrue(rbac.is_space_member(r.json()["principal_id"], "S1"))
        # Open signup flag lifts the invite requirement.
        with patch.dict(os.environ, {"PONA_FLOW_ALLOW_OPEN_SIGNUP": "1"}):
            r = TestClient(app, base_url=self.BASE).post(
                "/api/auth/signup", json={"email": "walkin@example.com", "password": "a strong password"}
            )
            self.assertEqual(r.status_code, 200, r.text)

    def test_change_password(self) -> None:
        self._setup_admin()
        r = self.client.post(
            "/api/auth/password", json={"current_password": "wrong password", "new_password": "a new strong password"}
        )
        self.assertEqual(r.status_code, 401)
        r = self.client.post(
            "/api/auth/password",
            json={"current_password": "a strong password", "new_password": "a new strong password"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.client.get("/api/me").status_code, 200)
        self.client.post("/api/auth/logout")
        r = self.client.post("/api/auth/login", json={"email": "admin@example.com", "password": "a new strong password"})
        self.assertEqual(r.status_code, 200)

    def test_clerk_mode_disables_local_routes(self) -> None:
        with patch.dict(os.environ, {"PONA_FLOW_AUTH_MODE": "clerk", "CLERK_PUBLISHABLE_KEY": "pk_test_abc"}):
            status = self.client.get("/api/auth/status").json()
            self.assertEqual(status["mode"], "clerk")
            self.assertEqual(status["clerk_publishable_key"], "pk_test_abc")
            self.assertFalse(status["setup_required"])
            r = self.client.post("/api/auth/setup", json={"email": "a@example.com", "password": "a strong password"})
            self.assertEqual(r.status_code, 404)

    def test_dev_bypass_ignored_on_non_loopback_listener(self) -> None:
        from server import auth

        with patch.dict(os.environ, {"PONA_FLOW_DISABLE_AUTH": "1"}):
            # Loopback listener (TestClient default): bypass active.
            self.assertEqual(self.client.get("/api/me").status_code, 200)
            # Non-loopback listener: bypass ignored, so the request needs real credentials.
            with patch.object(auth, "_dev_bypass_allowed_for", return_value=False):
                self.assertEqual(self.client.get("/api/me").status_code, 401)
            with self.assertRaises(RuntimeError):
                auth.assert_dev_bypass_safe("0.0.0.0")
            auth.assert_dev_bypass_safe("127.0.0.1")  # fine


if __name__ == "__main__":
    unittest.main()
