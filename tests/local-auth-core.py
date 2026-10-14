#!/usr/bin/env python3
"""Built-in auth storage layer: password hashing, setup-once, sessions, throttling."""

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

from server import config, local_auth, rbac  # noqa: E402


class LocalAuthCoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.db_path = Path(self._tmpdir.name) / "catalog.db"
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.executescript((ROOT / "Engine/schema/users-table.sql").read_text(encoding="utf-8"))
        local_auth.ensure_schema(conn)
        rbac.ensure_rbac_schema(conn)
        conn.close()

        env = patch.dict(
            os.environ,
            {
                "SQLITE_DATABASE_PATH": str(self.db_path),
                "PONA_FLOW_CATALOG_SQLITE_KEY": "SQLITE_DATABASE_PATH",
                "PONA_FLOW_AUTH_MODE": "local",
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
        local_auth.reset_login_throttle()

    # --- passwords -------------------------------------------------------------------
    def test_hash_roundtrip_and_tamper(self) -> None:
        h = local_auth.hash_password("correct horse battery")
        self.assertTrue(h.startswith("scrypt$"))
        self.assertTrue(local_auth.verify_password("correct horse battery", h))
        self.assertFalse(local_auth.verify_password("wrong", h))
        self.assertFalse(local_auth.verify_password("correct horse battery", h[:-2] + "zz"))
        self.assertFalse(local_auth.verify_password("x", "garbage"))

    def test_password_policy(self) -> None:
        with self.assertRaises(ValueError):
            local_auth.validate_password("short")
        local_auth.validate_password("long enough password")

    # --- setup / users ----------------------------------------------------------------
    def test_setup_required_until_first_account(self) -> None:
        self.assertTrue(local_auth.setup_required())
        uid = local_auth.create_local_user(
            "Admin@Example.com", "a strong password", "Admin",
            is_instance_admin=True, can_create_spaces=True,
        )
        self.assertFalse(local_auth.setup_required())
        from server import auth

        principal = auth.principal_from_user_id(uid)
        assert principal is not None
        self.assertTrue(principal.is_instance_admin)
        self.assertTrue(principal.can_create_spaces)
        self.assertEqual(principal.email, "admin@example.com")
        self.assertEqual(principal.display_name, "Admin")

    def test_duplicate_email_rejected_case_insensitively(self) -> None:
        local_auth.create_local_user("someone@example.com", "a strong password")
        with self.assertRaises(ValueError):
            local_auth.create_local_user("SOMEONE@example.com", "another strong one")

    def test_invited_user_row_is_adopted(self) -> None:
        # An admin invites by email before the person has an account: the users row is
        # created on signup and the pending invite should be claimable by that id.
        conn = config.connect_sqlite(self.db_path)
        conn.execute("CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY)")
        conn.execute("INSERT INTO spaces (id) VALUES ('S1')")
        conn.commit()
        conn.close()
        rbac.seed_default_roles("S1")
        rbac.invite_member("S1", "new@example.com")
        self.assertTrue(local_auth.has_pending_invite("NEW@example.com"))
        uid = local_auth.create_local_user("new@example.com", "a strong password")
        self.assertEqual(rbac.claim_pending_invites(uid, "new@example.com"), 1)
        self.assertTrue(rbac.is_space_member(uid, "S1"))
        self.assertFalse(local_auth.has_pending_invite("new@example.com"))

    def test_authenticate(self) -> None:
        uid = local_auth.create_local_user("u@example.com", "a strong password")
        self.assertEqual(local_auth.authenticate("U@EXAMPLE.COM", "a strong password"), uid)
        self.assertIsNone(local_auth.authenticate("u@example.com", "nope nope nope"))
        self.assertIsNone(local_auth.authenticate("ghost@example.com", "a strong password"))

    # --- sessions ---------------------------------------------------------------------
    def test_session_lifecycle(self) -> None:
        uid = local_auth.create_local_user("u@example.com", "a strong password")
        token = local_auth.create_session(uid)
        self.assertTrue(token.startswith("pfs_"))
        self.assertEqual(local_auth.resolve_session(token), uid)
        self.assertIsNone(local_auth.resolve_session("pfs_not_a_real_token"))
        self.assertIsNone(local_auth.resolve_session("stg_wrong_prefix"))
        local_auth.revoke_session(token)
        self.assertIsNone(local_auth.resolve_session(token))

    def test_expired_session_is_rejected(self) -> None:
        uid = local_auth.create_local_user("u@example.com", "a strong password")
        token = local_auth.create_session(uid)
        conn = config.connect_sqlite(self.db_path)
        conn.execute("UPDATE sessions SET expires_at = '2000-01-01 00:00:00'")
        conn.commit()
        conn.close()
        self.assertIsNone(local_auth.resolve_session(token))

    def test_set_password_revokes_sessions(self) -> None:
        uid = local_auth.create_local_user("u@example.com", "a strong password")
        token = local_auth.create_session(uid)
        local_auth.set_password(uid, "a different strong password")
        self.assertIsNone(local_auth.resolve_session(token))
        self.assertEqual(local_auth.authenticate("u@example.com", "a different strong password"), uid)

    # --- throttling -------------------------------------------------------------------
    def test_login_throttle_per_email_and_ip(self) -> None:
        for _ in range(local_auth.LOGIN_MAX_FAILURES_PER_EMAIL):
            self.assertEqual(local_auth.login_retry_after("1.1.1.1", "a@example.com"), 0)
            local_auth.record_login_failure("1.1.1.1", "a@example.com")
        self.assertGreater(local_auth.login_retry_after("1.1.1.1", "a@example.com"), 0)
        # Same email from another IP is still throttled; another email from the same IP is not (yet).
        self.assertGreater(local_auth.login_retry_after("2.2.2.2", "a@example.com"), 0)
        self.assertEqual(local_auth.login_retry_after("1.1.1.1", "b@example.com"), 0)
        local_auth.record_login_success("1.1.1.1", "a@example.com")
        self.assertEqual(local_auth.login_retry_after("1.1.1.1", "a@example.com"), 0)


if __name__ == "__main__":
    unittest.main()
