#!/usr/bin/env python3
"""Superadmin is resolved after Clerk email backfill when the session JWT omits email."""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "Engine"))

from server import auth, config  # noqa: E402


class SuperadminEmailBackfillTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.db_path = Path(self._tmpdir.name) / "catalog.db"
        conn = sqlite3.connect(self.db_path)
        conn.executescript(
            (Path(__file__).resolve().parents[1] / "Engine/schema/users-table.sql").read_text(
                encoding="utf-8"
            )
        )
        conn.commit()
        conn.close()

        self._env = patch.dict(
            os.environ,
            {
                "SQLITE_DATABASE_PATH": str(self.db_path),
                "PONA_FLOW_CATALOG_SQLITE_KEY": "SQLITE_DATABASE_PATH",
                "SUPERADMIN_EMAIL": "e2e-test@example.com",
                "SUPERADMIN_CLERK_ID": "",
            },
            clear=False,
        )
        self._env.start()
        self.addCleanup(self._env.stop)

        self._catalog = patch.object(config, "catalog_sqlite_path", return_value=self.db_path)
        self._catalog.start()
        self.addCleanup(self._catalog.stop)

    def test_superadmin_by_email_after_clerk_identity_backfill(self) -> None:
        with patch.object(
            auth.clerk_api,
            "fetch_identity",
            return_value={"email": "e2e-test@example.com", "name": "E2E Test"},
        ), patch.object(auth.rbac, "claim_pending_invites"):
            principal = auth.get_or_create_user("user_clerk_e2e", None)

        self.assertTrue(principal.is_superadmin)
        self.assertTrue(principal.can_create_spaces)


if __name__ == "__main__":
    raise SystemExit(unittest.main())
