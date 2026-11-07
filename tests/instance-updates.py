#!/usr/bin/env python3
"""Instance update status + Fly, Docker, and git apply, without calling remotes."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
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
                "FLY_MACHINE_ID": "",
                "PONA_FLOW_LOCAL_UPDATE": "",
                "PONA_FLOW_VERSION": "",
                "PONA_FLOW_UPDATE_BRANCH": "",
                "PONA_FLOW_COMPOSE_DIR": "",
            },
            clear=False,
        )
        env.start()
        self.addCleanup(env.stop)
        # This repo is a git checkout. Keep tests from treating that as the update path
        # unless a case opts in.
        git_off = patch.object(updates, "git_checkout_available", return_value=False)
        git_off.start()
        self.addCleanup(git_off.stop)
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

    def _behind(self, latest: str = "bbb2222newsha00000000000000000000000000", ci: str = "success"):
        def http_get(url: str, _headers: dict[str, str]):
            if "/actions/workflows/ci.yml/runs" in url:
                if ci == "success":
                    run = {"status": "completed", "conclusion": "success", "html_url": "https://github.com/x/y/actions/runs/1"}
                elif ci == "failure":
                    run = {"status": "completed", "conclusion": "failure", "html_url": "https://github.com/x/y/actions/runs/9"}
                else:
                    run = {"status": "in_progress", "conclusion": None, "html_url": "https://github.com/x/y/actions/runs/8"}
                return 200, {"workflow_runs": [run]}
            if "/compare/" in url:
                return 200, {"commits": []}
            return 200, {"sha": latest, "commit": {"message": "tip"}, "html_url": ""}

        return http_get

    def test_docker_update_offered_without_fly_token(self) -> None:
        watcher = self.data_dir / "update-watcher"
        watcher.write_text(f"{time.time()}\n", encoding="utf-8")
        with patch.dict(
            os.environ,
            {"PONA_FLOW_LOCAL_UPDATE": "1", "PONA_FLOW_VERSION": "main", "FLY_API_TOKEN": "", "FLY_APP_NAME": ""},
        ):
            payload = updates.status_payload(http_get=self._behind())
        self.assertEqual(payload["update_method"], "docker")
        self.assertTrue(payload["can_update"])
        self.assertTrue(payload["local_updater_ready"])
        self.assertIsNone(payload["version_pin"])
        self.assertNotIn("fly_token_test", str(payload))

    def test_docker_update_wins_over_a_saved_fly_token(self) -> None:
        (self.data_dir / "update-watcher").write_text(f"{time.time()}\n", encoding="utf-8")
        with patch.dict(os.environ, {"PONA_FLOW_LOCAL_UPDATE": "1", "PONA_FLOW_VERSION": "main"}):
            payload = updates.status_payload(http_get=self._behind())
        self.assertEqual(payload["update_method"], "docker")
        self.assertTrue(payload["can_update"])

    def test_docker_update_waits_for_the_updater(self) -> None:
        with patch.dict(os.environ, {"PONA_FLOW_LOCAL_UPDATE": "1", "PONA_FLOW_VERSION": "main"}):
            payload = updates.status_payload(http_get=self._behind())
        self.assertEqual(payload["update_method"], "docker")
        self.assertFalse(payload["local_updater_ready"])
        self.assertFalse(payload["can_update"])

    def test_stale_updater_heartbeat_is_not_ready(self) -> None:
        (self.data_dir / "update-watcher").write_text(f"{time.time() - 120}\n", encoding="utf-8")
        with patch.dict(os.environ, {"PONA_FLOW_LOCAL_UPDATE": "1"}):
            self.assertFalse(updates.local_watcher_ready())

    def test_pinned_compose_tag_is_not_a_one_click_update(self) -> None:
        (self.data_dir / "update-watcher").write_text(f"{time.time()}\n", encoding="utf-8")
        with patch.dict(os.environ, {"PONA_FLOW_LOCAL_UPDATE": "1", "PONA_FLOW_VERSION": "0.1.0"}):
            payload = updates.status_payload(http_get=self._behind())
        self.assertEqual(payload["version_pin"], "0.1.0")
        self.assertFalse(payload["can_update"])

    def test_failed_ci_blocks_docker_update(self) -> None:
        (self.data_dir / "update-watcher").write_text(f"{time.time()}\n", encoding="utf-8")
        with patch.dict(os.environ, {"PONA_FLOW_LOCAL_UPDATE": "1", "PONA_FLOW_VERSION": "main"}):
            payload = updates.status_payload(http_get=self._behind(ci="failure"))
        self.assertFalse(payload["can_update"])
        self.assertEqual(payload["publish_status"], "failure")

    def test_apply_docker_writes_request_and_skips_fly(self) -> None:
        (self.data_dir / "update-watcher").write_text(f"{time.time()}\n", encoding="utf-8")
        (self.data_dir / "update-result").write_text("fail\nold\n", encoding="utf-8")

        def explode(*_args, **_kwargs):
            self.fail("docker update must not call Fly")

        with patch.dict(os.environ, {"PONA_FLOW_LOCAL_UPDATE": "1", "PONA_FLOW_VERSION": "main"}):
            result = updates.apply_update(http_get=explode, http_post=explode)
        self.assertEqual(result["method"], "docker")
        self.assertEqual((self.data_dir / "update-request").read_text(encoding="utf-8").strip(), "update")
        self.assertFalse((self.data_dir / "update-result").exists())

    def test_apply_docker_requires_a_live_updater(self) -> None:
        with patch.dict(os.environ, {"PONA_FLOW_LOCAL_UPDATE": "1", "PONA_FLOW_VERSION": "main"}):
            with self.assertRaises(ValueError):
                updates.apply_update()
        self.assertFalse((self.data_dir / "update-request").exists())

    def test_update_result_failure_is_reported(self) -> None:
        (self.data_dir / "update-result").write_text(
            "fail\ndocker compose could not pull or restart pona-flow\n",
            encoding="utf-8",
        )
        parsed = updates.read_update_result()
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertFalse(parsed["ok"])
        self.assertIn("docker compose", parsed["error"])
        self.assertFalse(updates.version_payload()["update_result"]["ok"])
        (self.data_dir / "update-watcher").write_text(f"{time.time()}\n", encoding="utf-8")
        with patch.dict(os.environ, {"PONA_FLOW_LOCAL_UPDATE": "1", "PONA_FLOW_VERSION": "main"}):
            payload = updates.status_payload(http_get=self._behind())
        self.assertEqual(payload["local_update_error"], parsed["error"])

    def test_git_update_offered_for_a_clean_checkout(self) -> None:
        with patch.dict(os.environ, {"FLY_API_TOKEN": "", "FLY_APP_NAME": ""}):
            with patch.object(updates, "git_checkout_available", return_value=True):
                with patch.object(updates, "git_block_reason", return_value=None):
                    payload = updates.status_payload(http_get=self._behind(ci="failure"))
        self.assertEqual(payload["update_method"], "git")
        self.assertTrue(payload["can_update"])
        self.assertFalse(payload["on_fly"])
        self.assertIn("git pull", payload["manual_hint"])
        self.assertTrue(payload["project_dir"].endswith("pona-flow"))

    def test_git_update_reports_a_dirty_checkout(self) -> None:
        reason = "this checkout has uncommitted changes. commit or stash them, then update."
        with patch.dict(os.environ, {"FLY_API_TOKEN": "", "FLY_APP_NAME": ""}):
            with patch.object(updates, "git_checkout_available", return_value=True):
                with patch.object(updates, "git_block_reason", return_value=reason):
                    payload = updates.status_payload(http_get=self._behind())
        self.assertEqual(payload["update_method"], "git")
        self.assertFalse(payload["can_update"])
        self.assertEqual(payload["git_error"], reason)

    def test_git_block_reason_sees_local_edits(self) -> None:
        def run(args: list[str]) -> subprocess.CompletedProcess[str]:
            if args[:2] == ["rev-parse", "--abbrev-ref"]:
                return subprocess.CompletedProcess(args, 0, "main\n", "")
            if args[:2] == ["diff", "--quiet"]:
                return subprocess.CompletedProcess(args, 1, "", "")
            return subprocess.CompletedProcess(args, 0, "", "")

        reason = updates.git_block_reason(run)
        self.assertIsNotNone(reason)
        assert reason is not None
        self.assertIn("uncommitted", reason)

    def test_git_block_reason_rejects_another_branch(self) -> None:
        def run(args: list[str]) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(args, 0, "feature\n", "")

        reason = updates.git_block_reason(run)
        self.assertIsNotNone(reason)
        assert reason is not None
        self.assertIn("feature", reason)

    def test_apply_git_fast_forwards_and_restarts(self) -> None:
        calls: list[list[str]] = []
        restarted: list[bool] = []

        def run(args: list[str]) -> subprocess.CompletedProcess[str]:
            calls.append(list(args))
            if args[:2] == ["rev-parse", "--abbrev-ref"]:
                return subprocess.CompletedProcess(args, 0, "main\n", "")
            return subprocess.CompletedProcess(args, 0, "", "")

        with patch.dict(os.environ, {"FLY_API_TOKEN": "", "FLY_APP_NAME": "", "PONA_FLOW_LOCAL_UPDATE": ""}):
            with patch.object(updates, "git_checkout_available", return_value=True):
                result = updates.apply_update(run_git=run, restart=lambda: restarted.append(True))
        self.assertEqual(result["method"], "git")
        self.assertEqual(calls[-2], ["fetch", "origin", "main"])
        self.assertEqual(calls[-1], ["merge", "--ff-only", "origin/main"])
        self.assertEqual(restarted, [True])

    def test_empty_build_sha_uses_git_head(self) -> None:
        with patch.dict(os.environ, {"PONA_FLOW_BUILD_SHA": ""}):
            with patch.object(updates, "git_checkout_available", return_value=True):
                with patch.object(updates, "_git_head_sha", return_value="abc123"):
                    self.assertEqual(updates.build_sha(), "abc123")

    def test_manual_hint_without_fly_is_compose(self) -> None:
        with patch.dict(os.environ, {"FLY_API_TOKEN": "", "FLY_APP_NAME": ""}):
            payload = updates.status_payload(http_get=self._behind())
        self.assertEqual(payload["update_method"], "manual")
        self.assertEqual(payload["manual_hint"], "docker compose pull && docker compose up -d")
        self.assertFalse(payload["on_fly"])


if __name__ == "__main__":
    unittest.main()
