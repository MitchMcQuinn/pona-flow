#!/usr/bin/env python3
"""Phase-2 hardening contract: /healthz, security headers, generic 500 bodies, data dir, MCP hosts."""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "Engine"))

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server import config, http_utils, local_auth, mcp_gateway, migrations  # noqa: E402
from server.app import app  # noqa: E402


class HardeningTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.data_dir = Path(self._tmpdir.name)
        env = patch.dict(
            os.environ,
            {
                "PONA_FLOW_DATA_DIR": str(self.data_dir),
                "SQLITE_DATABASE_PATH": "",
                "PONA_FLOW_AUTH_MODE": "local",
                "PONA_FLOW_DISABLE_AUTH": "",
                "PONA_FLOW_DEBUG_ERRORS": "",
                "PONA_FLOW_PUBLIC_URL": "",
                "PONA_FLOW_MCP_ALLOWED_HOSTS": "",
            },
            clear=False,
        )
        env.start()
        self.addCleanup(env.stop)
        migrations.run_startup_migrations()
        local_auth.reset_login_throttle()
        self.client = TestClient(app, base_url="http://127.0.0.1")

    # --- data directory ---------------------------------------------------------

    def test_catalog_defaults_into_data_dir(self) -> None:
        self.assertEqual(config.catalog_sqlite_path(), self.data_dir / "data.db")
        self.assertTrue((self.data_dir / "data.db").exists())
        self.assertEqual(config.env_file_path(), self.data_dir / ".env")

    def test_relative_sqlite_key_resolves_under_data_dir(self) -> None:
        with patch.dict(os.environ, {"SPACE_DB": "spaces/alpha.db"}):
            self.assertEqual(
                config.sqlite_path_for_env_key("SPACE_DB"), self.data_dir / "spaces" / "alpha.db"
            )

    def test_space_sqlite_falls_back_like_catalog_when_unset(self) -> None:
        # Fly/Docker often set only NEO4J_*; space ops must not require SQLITE_DATABASE_PATH.
        path = config.sqlite_path_for_env_key(
            "MISSING_SPACE_SQLITE", fallback_key="SQLITE_DATABASE_PATH"
        )
        self.assertEqual(path, self.data_dir / "data.db")

    # --- /healthz ------------------------------------------------------------------

    def test_healthz_is_unauthenticated_and_reports_catalog(self) -> None:
        r = self.client.get("/healthz")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["auth_mode"], "local")
        self.assertTrue(body["checks"]["catalog"]["ok"])
        self.assertNotIn("neo4j", body["checks"])

    def test_healthz_deep_reports_neo4j_without_leaking_config(self) -> None:
        with patch.dict(os.environ, {"NEO4J_URI": "", "NEO4J_USER": "", "NEO4J_PASSWORD": ""}):
            r = self.client.get("/healthz?deep=1")
        self.assertEqual(r.status_code, 503, r.text)
        body = r.json()
        self.assertEqual(body["status"], "degraded")
        self.assertFalse(body["checks"]["neo4j"]["ok"])
        self.assertNotIn("bolt://", r.text)

    def test_healthz_degrades_when_catalog_unreachable(self) -> None:
        def boom(*_a, **_k):
            raise sqlite3.OperationalError("unable to open database file /secret/path.db")

        with patch.object(config, "connect_sqlite", boom):
            r = self.client.get("/healthz")
        self.assertEqual(r.status_code, 503)
        self.assertNotIn("/secret/path.db", r.text)

    # --- security headers ---------------------------------------------------------

    def test_security_headers_on_api_and_static(self) -> None:
        for path in ("/healthz", "/api/auth/status", "/"):
            r = self.client.get(path)
            self.assertEqual(r.headers.get("X-Content-Type-Options"), "nosniff", path)
            self.assertEqual(r.headers.get("X-Frame-Options"), "DENY", path)
            self.assertIn("Referrer-Policy", r.headers, path)
            self.assertNotIn("Strict-Transport-Security", r.headers, path)

    def test_hsts_only_when_forwarded_https(self) -> None:
        r = self.client.get("/healthz", headers={"X-Forwarded-Proto": "https"})
        self.assertIn("Strict-Transport-Security", r.headers)

    # --- generic 500 bodies ------------------------------------------------------------

    def test_domain_500_hides_detail_by_default(self) -> None:
        with self.assertRaises(HTTPException) as cm:
            with http_utils.domain_500():
                raise sqlite3.OperationalError("no such table: secrets at /var/lib/x.db")
        self.assertEqual(cm.exception.status_code, 500)
        self.assertNotIn("/var/lib", cm.exception.detail)
        self.assertIn("server log", cm.exception.detail)

    def test_domain_500_echoes_detail_in_debug_mode(self) -> None:
        with patch.dict(os.environ, {"PONA_FLOW_DEBUG_ERRORS": "1"}):
            with self.assertRaises(HTTPException) as cm:
                with http_utils.value_400_domain_500():
                    raise sqlite3.OperationalError("no such table: secrets")
        self.assertIn("no such table", cm.exception.detail)

    def test_value_error_still_400(self) -> None:
        with self.assertRaises(HTTPException) as cm:
            with http_utils.value_400_domain_500():
                raise ValueError("bad label")
        self.assertEqual(cm.exception.status_code, 400)
        self.assertEqual(cm.exception.detail, "bad label")

    # --- MCP host protection -------------------------------------------------------

    @unittest.skipUnless(mcp_gateway.MCP_AVAILABLE, "mcp SDK not installed")
    def test_mcp_hosts_derived_from_public_url(self) -> None:
        with patch.dict(os.environ, {"PONA_FLOW_PUBLIC_URL": "https://flow.example.com"}):
            s = mcp_gateway._security_settings()
        self.assertTrue(s.enable_dns_rebinding_protection)
        self.assertIn("flow.example.com", s.allowed_hosts)
        self.assertIn("127.0.0.1:*", s.allowed_hosts)

    @unittest.skipUnless(mcp_gateway.MCP_AVAILABLE, "mcp SDK not installed")
    def test_mcp_hosts_explicit_list_wins(self) -> None:
        with patch.dict(
            os.environ,
            {"PONA_FLOW_PUBLIC_URL": "https://flow.example.com", "PONA_FLOW_MCP_ALLOWED_HOSTS": "a.test,b.test:*"},
        ):
            s = mcp_gateway._security_settings()
        self.assertEqual(s.allowed_hosts, ["a.test", "b.test:*"])

    @unittest.skipUnless(mcp_gateway.MCP_AVAILABLE, "mcp SDK not installed")
    def test_mcp_hosts_off_without_config(self) -> None:
        s = mcp_gateway._security_settings()
        self.assertFalse(s.enable_dns_rebinding_protection)


if __name__ == "__main__":
    unittest.main(verbosity=2)
