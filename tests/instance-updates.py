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
        updates.clear_github_cache()
        self.addCleanup(updates.clear_github_cache)

    def test_status_reuses_cached_github_answers(self) -> None:
        calls: list[str] = []
        sha = os.environ["PONA_FLOW_BUILD_SHA"]

        def http_get(url: str, _headers: dict[str, str]):
            calls.append(url)
            return 200, {"sha": sha, "commit": {"message": "same"}, "html_url": ""}

        updates.status_payload(http_get=http_get)
        updates.status_payload(http_get=http_get)
        self.assertEqual(len(calls), 1)

    def test_rate_limit_serves_stale_answer(self) -> None:
        sha = os.environ["PONA_FLOW_BUILD_SHA"]
        updates.status_payload(
            http_get=lambda *_: (200, {"sha": sha, "commit": {"message": "x"}, "html_url": ""})
        )
        with patch.object(updates, "GITHUB_CACHE_TTL_S", 0):
            payload = updates.status_payload(
                http_get=lambda *_: (403, {"message": "API rate limit exceeded for 1.2.3.4."})
            )
        self.assertIsNone(payload["github_error"])
        self.assertTrue(payload["up_to_date"])

    def test_rate_limit_without_cache_still_allows_update(self) -> None:
        with patch.dict(os.environ, {"PONA_FLOW_GITHUB_TOKEN": ""}):
            payload = updates.status_payload(
                http_get=lambda *_: (403, {"message": "API rate limit exceeded for 1.2.3.4."})
            )
        self.assertIn("hourly limit", payload["github_error"])
        self.assertIn("PONA_FLOW_GITHUB_TOKEN", payload["github_error"])
        self.assertEqual(payload["latest_sha"], "")
        self.assertTrue(payload["can_update"])

    def test_version_payload_is_cheap(self) -> None:
        payload = updates.version_payload()
        self.assertEqual(payload["build_sha"], os.environ["PONA_FLOW_BUILD_SHA"])
        self.assertIsInstance(payload["started_at"], float)

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
            if "/actions/workflows/ci.yml/runs" in url:
                return 200, {
                    "workflow_runs": [
                        {
                            "status": "completed",
                            "conclusion": "success",
                            "html_url": "https://github.com/x/y/actions/runs/1",
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
        self.assertEqual(payload["publish_status"], "success")
        self.assertIsNone(payload["publish_error"])
        self.assertNotIn("fly_token_test", str(payload))

    def test_failed_ci_does_not_offer_an_update(self) -> None:
        latest = "bbb2222newsha00000000000000000000000000"

        def http_get(url: str, _headers: dict[str, str]):
            if "/actions/workflows/ci.yml/runs" in url:
                return 200, {
                    "workflow_runs": [
                        {
                            "status": "completed",
                            "conclusion": "failure",
                            "html_url": "https://github.com/x/y/actions/runs/9",
                        }
                    ]
                }
            if "/compare/" in url:
                return 200, {"commits": []}
            return 200, {"sha": latest, "commit": {"message": "tip"}, "html_url": ""}

        payload = updates.status_payload(http_get=http_get)
        self.assertTrue(payload["behind"])
        self.assertFalse(payload["can_update"])
        self.assertEqual(payload["publish_status"], "failure")
        self.assertIn("did not publish", payload["publish_error"])
        self.assertEqual(payload["publish_url"], "https://github.com/x/y/actions/runs/9")

    def test_running_ci_does_not_offer_an_update(self) -> None:
        latest = "bbb2222newsha00000000000000000000000000"

        def http_get(url: str, _headers: dict[str, str]):
            if "/actions/workflows/ci.yml/runs" in url:
                return 200, {
                    "workflow_runs": [
                        {"status": "in_progress", "conclusion": None, "html_url": "https://github.com/x/y/actions/runs/8"}
                    ]
                }
            if "/compare/" in url:
                return 200, {"commits": []}
            return 200, {"sha": latest, "commit": {"message": "tip"}, "html_url": ""}

        payload = updates.status_payload(http_get=http_get)
        self.assertFalse(payload["can_update"])
        self.assertEqual(payload["publish_status"], "in_progress")

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
