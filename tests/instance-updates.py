#!/usr/bin/env python3
"""Instance update status + Fly apply, without calling GitHub or Fly."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "Engine"))

from server import config, updates  # noqa: E402


class InstanceUpdatesTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.data_dir = Path(self._tmpdir.name)
        env = patch.dict(
            os.environ,
            {
                "PONA_FLOW_DATA_DIR": str(self.data_dir),
                "PONA_FLOW_BUILD_SHA": "aaa1111oldsha00000000000000000000000000",
                "PONA_FLOW_GITHUB_REPO": "MitchMcQuinn/pona-flow",
                "PONA_FLOW_IMAGE": "ghcr.io/mitchmcquinn/pona-flow:main",
                "FLY_APP_NAME": "pona-flow-instance",
                "FLY_API_TOKEN": "fly_token_test",
            },
            clear=False,
        )
        env.start()
        self.addCleanup(env.stop)

    def test_status_behind_lists_compare_commits(self) -> None:
        latest = "bbb2222newsha00000000000000000000000000"

        def http_get(url: str, _headers: dict[str, str]):
            if "/commits/main" in url and "compare" not in url:
                return 200, {
                    "sha": latest,
                    "commit": {"message": "tip\n", "author": {"date": "2026-10-18T00:00:00Z"}},
                    "html_url": "https://github.com/x/y/commit/" + latest,
                }
            if "/compare/" in url:
                return 200, {
                    "commits": [
                        {
                            "sha": latest,
                            "commit": {
                                "message": "Fix missing SQLITE_DATABASE_PATH\n\nlonger body",
                                "author": {"date": "2026-10-18T12:00:00Z"},
                            },
                            "html_url": "https://github.com/x/y/commit/" + latest,
                        }
                    ]
                }
            self.fail(f"unexpected url {url}")

        payload = updates.status_payload(http_get=http_get)
        self.assertTrue(payload["behind"])
        self.assertFalse(payload["up_to_date"])
        self.assertTrue(payload["can_update"])
        self.assertEqual(payload["update_method"], "fly")
        self.assertEqual(payload["latest_sha"], latest)
        self.assertEqual(len(payload["commits"]), 1)
        self.assertEqual(payload["commits"][0]["message"], "Fix missing SQLITE_DATABASE_PATH")
        self.assertTrue(payload["fly_token_configured"])
        self.assertNotIn("fly_token_test", str(payload))

    def test_status_up_to_date(self) -> None:
        sha = os.environ["PONA_FLOW_BUILD_SHA"]

        def http_get(url: str, _headers: dict[str, str]):
            self.assertIn("/commits/main", url)
            return 200, {"sha": sha, "commit": {"message": "same"}, "html_url": ""}

        payload = updates.status_payload(http_get=http_get)
        self.assertTrue(payload["up_to_date"])
        self.assertFalse(payload["behind"])
        self.assertFalse(payload["can_update"])
        self.assertEqual(payload["commits"], [])

    def test_status_without_token_is_manual(self) -> None:
        with patch.dict(os.environ, {"FLY_API_TOKEN": ""}):

            def http_get(url: str, _headers: dict[str, str]):
                return 200, {"sha": "ccc", "commit": {"message": "x"}, "html_url": ""}

            payload = updates.status_payload(http_get=http_get)
        self.assertEqual(payload["update_method"], "manual")
        self.assertFalse(payload["can_update"])
        self.assertFalse(payload["fly_token_configured"])

    def test_save_fly_credentials_writes_env(self) -> None:
        with patch.dict(os.environ, {"FLY_API_TOKEN": "", "FLY_APP_NAME": ""}):
            saved = updates.save_fly_credentials("  secret-token  ", "my-app")
            self.assertTrue(saved["fly_token_configured"])
            self.assertEqual(saved["fly_app_name"], "my-app")
            self.assertEqual(os.environ["FLY_API_TOKEN"], "secret-token")
            text = config.env_file_path().read_text(encoding="utf-8")
            self.assertIn("FLY_API_TOKEN=secret-token", text)
            self.assertIn("FLY_APP_NAME=my-app", text)

    def test_apply_update_rewrites_machine_image(self) -> None:
        posted: list[tuple[str, dict]] = []

        def http_get(url: str, _headers: dict[str, str]):
            if url.endswith("/machines"):
                return 200, [
                    {
                        "id": "1857ee3a",
                        "config": {"image": "old:tag", "env": {"X": "1"}},
                    }
                ]
            if "/wait" in url:
                return 200, {"ok": True}
            self.fail(f"unexpected get {url}")

        def http_post(url: str, _headers: dict[str, str], payload: dict):
            posted.append((url, payload))
            return 200, {"ok": True}

        result = updates.apply_update(http_get=http_get, http_post=http_post)
        self.assertTrue(result["ok"])
        self.assertEqual(result["machines"], ["1857ee3a"])
        self.assertTrue(posted)
        self.assertEqual(posted[0][1]["config"]["image"], "ghcr.io/mitchmcquinn/pona-flow:main")
        self.assertEqual(posted[0][1]["config"]["env"]["X"], "1")

    def test_apply_update_requires_token(self) -> None:
        with patch.dict(os.environ, {"FLY_API_TOKEN": ""}):
            with self.assertRaises(ValueError):
                updates.apply_update(http_get=lambda *_: (200, []), http_post=lambda *_: (200, {}))


if __name__ == "__main__":
    unittest.main()
