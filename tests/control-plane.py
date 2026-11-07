#!/usr/bin/env python3
"""Control plane: codes, secret handling, sandbox lifecycle, and Stripe."""

from __future__ import annotations

import io
import json
import logging
import os
import sys
import tempfile
import unittest
from unittest.mock import patch
from datetime import timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "Engine"))

from fastapi.testclient import TestClient  # noqa: E402

from control_plane.app import create_app, provision_failure_message  # noqa: E402
from control_plane.fly import FlyClient, FlyError  # noqa: E402
from control_plane.billing import sign_payload  # noqa: E402
from control_plane.db import Database  # noqa: E402
from control_plane.lifecycle import should_delete, upgrade_fields  # noqa: E402
from control_plane.provision import Provisioner  # noqa: E402
from control_plane.scheduler import note_events, tick  # noqa: E402
from control_plane.util import hash_password, hash_token, iso, utcnow  # noqa: E402
from server import chat_agent  # noqa: E402
from control_plane.guide import SYSTEM  # noqa: E402


FLY_TOKEN = "fly-token-SECRET-VALUE-do-not-store"
AURA_PASSWORD = "aura-SECRET-VALUE-do-not-store"
ADMIN_PASSWORD = "admin-SECRET-VALUE-do-not-store"


class FakeFly:
    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.secrets: dict[str, str] = {}

    def create_app(self, name: str) -> None:
        self.calls.append(("create_app", name))

    def allocate_public_ips(self, app: str) -> None:
        self.calls.append(("addresses", app))

    def create_volume(self, app: str, region: str, size_gb: int = 1) -> str:
        self.calls.append(("volume", app, region))
        return "vol_test"

    def set_secrets(self, app: str, secrets: dict[str, str]) -> None:
        self.calls.append(("secrets", app, tuple(sorted(secrets))))
        self.secrets = dict(secrets)

    def create_machine(self, app: str, config: dict, region: str) -> str:
        self.calls.append(("machine", app, config["services"][0]["autostop"], config["services"][0]["min_machines_running"]))
        self.config = config
        return "mach_test"

    def set_mode(self, app: str, machine_id: str, mode: str) -> None:
        self.calls.append(("mode", app, machine_id, mode))

    def list_machines(self, app: str) -> list[dict]:
        return [{"id": "mach_test", "config": {"services": [{}]}}]

    def update_machine(self, app: str, machine_id: str, config: dict) -> None:
        self.calls.append(("update", app, machine_id))

    def start_machine(self, app: str, machine_id: str) -> None:
        self.calls.append(("start", machine_id))

    def stop_machine(self, app: str, machine_id: str) -> None:
        self.calls.append(("stop", machine_id))

    def delete_volume(self, app: str, volume_id: str) -> None:
        self.calls.append(("delete_volume", app, volume_id))

    def delete_app(self, name: str) -> None:
        self.calls.append(("delete_app", name))


class FakeHttp:
    def wait_healthy(self, public_url: str) -> None:
        return None

    def setup_admin(self, public_url: str, email: str, password: str, display_name: str | None) -> None:
        return None


class ControlPlaneTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = Database(Path(self.tmp.name) / "control.db")
        self.fly = FakeFly()
        self.http = FakeHttp()
        self.provisions: list[str] = []
        env = {
            "CONTROL_PLANE_SECRET": "test-secret",
            "CONTROL_PLANE_ENV": "test",
            "CONTROL_PLANE_DEV_INBOX": "1",
            "FLY_API_TOKEN": "org-fly-token",
            "STRIPE_SECRET_KEY": "sk_test",
            "STRIPE_PRICE_BASIC": "price_test",
            "STRIPE_WEBHOOK_SECRET": "whsec_test",
            "SANDBOX_MAX_ACTIVE": "20",
            "CONTROL_PLANE_PUBLIC_URL": "http://127.0.0.1:8090",
        }
        self.addCleanup(lambda: None)
        self._patch = patch.dict(os.environ, env, clear=False)
        self._patch.start()
        self.addCleanup(self._patch.stop)

    def _app(self, limit: int = 20):
        from control_plane.guide import RateLimiter

        return create_app(
            database=self.db,
            fly_factory=lambda _token: self.fly,
            http=self.http,
            stripe_transport=self._stripe,
            guide_complete=self._guide,
            limiter=RateLimiter(limit, 3600),
            inline_jobs=True,
            start_scheduler=False,
        )

    def _stripe(self, method: str, url: str, headers: dict, body: bytes | None):
        return 200, json.dumps({"url": "https://checkout.stripe.test/session"}).encode()

    def _guide(self, system: str, messages: list[dict[str, str]]) -> str:
        self.assertIn("Get started", system)
        return "Use Get started when you want an instance."

    def _account(self, client: TestClient, email: str = "ada@example.com") -> None:
        created = client.post(
            "/api/signup",
            json={"email": email, "password": ADMIN_PASSWORD, "display_name": "Ada"},
        )
        self.assertEqual(created.status_code, 201, created.text)
        link = created.json()["dev_verify_url"]
        token = link.split("verify=")[1]
        verified = client.post("/api/verify", json={"token": token})
        self.assertEqual(verified.status_code, 200, verified.text)

    def test_unknown_code_and_one_sandbox_and_vip_once(self) -> None:
        client = TestClient(self._app())
        self._account(client)
        unknown = client.post(
            "/api/instances",
            json={"code": "not-a-real-code", "app_name": "ada-flow", "region": "iad", "password": ADMIN_PASSWORD},
        )
        self.assertEqual(unknown.status_code, 400, unknown.text)

        from control_plane.lifecycle import vip_code_hash

        self.db.insert_vip(vip_code_hash("VIP-ONCE"))
        first = client.post(
            "/api/instances",
            json={"code": "VIP-ONCE", "app_name": "ada-vip", "region": "iad", "password": ADMIN_PASSWORD},
        )
        self.assertEqual(first.status_code, 201, first.text)
        self.assertEqual(first.json()["instance"]["tier"], "vip")
        again = client.post(
            "/api/instances",
            json={"code": "VIP-ONCE", "app_name": "ada-vip2", "region": "iad", "password": ADMIN_PASSWORD},
        )
        self.assertEqual(again.status_code, 400, again.text)

        client2 = TestClient(self._app())
        self._account(client2, "bea@example.com")
        sandbox = client2.post(
            "/api/instances",
            json={"code": "Sandbox", "app_name": "bea-box", "region": "iad", "password": ADMIN_PASSWORD},
        )
        self.assertEqual(sandbox.status_code, 201, sandbox.text)
        self.assertEqual(sandbox.json()["instance"]["tier"], "sandbox")
        second = client2.post(
            "/api/instances",
            json={"code": "sandbox", "app_name": "bea-box2", "region": "iad", "password": ADMIN_PASSWORD},
        )
        self.assertEqual(second.status_code, 400, second.text)
        self.assertIn("already has a sandbox", second.text)

    def test_self_hosted_secrets_are_not_stored(self) -> None:
        account = self.db.create_account("ada@example.com", hash_password(ADMIN_PASSWORD), "Ada")
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        logger = logging.getLogger("pona_flow.control_plane")
        logger.addHandler(handler)
        self.addCleanup(logger.removeHandler, handler)
        provisioner = Provisioner(self.db, lambda _token: self.fly, self.http, fleet_url="http://127.0.0.1:8090")
        provisioner.provision_self_hosted(
            account=account,
            app_name="ada-flow",
            region="iad",
            fly_token=FLY_TOKEN,
            neo4j_uri="neo4j+s://example.databases.neo4j.io",
            neo4j_user="neo4j",
            neo4j_password=AURA_PASSWORD,
            admin_password=ADMIN_PASSWORD,
            display_name="Ada",
        )
        raw = Path(self.db.path).read_bytes()
        self.assertNotIn(FLY_TOKEN.encode(), raw)
        self.assertNotIn(AURA_PASSWORD.encode(), raw)
        self.assertNotIn(ADMIN_PASSWORD.encode(), raw)
        logged = stream.getvalue()
        self.assertNotIn(FLY_TOKEN, logged)
        self.assertNotIn(AURA_PASSWORD, logged)
        env = self.fly.config["env"]
        self.assertNotIn("NEO4J_PASSWORD", env)
        self.assertNotIn("FLY_API_TOKEN", env)
        self.assertEqual(
            self.fly.config["metadata"],
            {"fly_platform_version": "v2", "fly_process_group": "app"},
        )
        self.assertEqual(self.fly.config["mounts"], [{"volume": "vol_test", "path": "/data", "name": "pona_data"}])
        secret_keys = next(call[2] for call in self.fly.calls if call[0] == "secrets")
        self.assertNotIn("FLY_API_TOKEN", secret_keys)
        self.assertEqual(self.fly.secrets["NEO4J_USER"], "neo4j")
        steps = [call[0] for call in self.fly.calls]
        self.assertLess(steps.index("create_app"), steps.index("addresses"))
        self.assertLess(steps.index("addresses"), steps.index("volume"))

    def test_self_hosted_app_token_is_a_secret_and_blank_user_uses_instance_id(self) -> None:
        account = self.db.create_account("ada@example.com", hash_password(ADMIN_PASSWORD), "Ada")
        provisioner = Provisioner(self.db, lambda _token: self.fly, self.http, fleet_url="http://127.0.0.1:8090")
        app_token = "app-deploy-SECRET-do-not-store"
        provisioner.provision_self_hosted(
            account=account,
            app_name="ada-flow",
            region="iad",
            fly_token=FLY_TOKEN,
            neo4j_uri="neo4j+s://abcd1234.databases.neo4j.io",
            neo4j_user="",
            neo4j_password="aura-\r\nsecret",
            admin_password=ADMIN_PASSWORD,
            display_name="Ada",
            fly_app_token=f"  {app_token}  ",
        )
        self.assertEqual(self.fly.secrets["NEO4J_USER"], "abcd1234")
        self.assertEqual(self.fly.secrets["NEO4J_PASSWORD"], "aura-secret")
        self.assertEqual(self.fly.secrets["FLY_API_TOKEN"], app_token)
        self.assertNotIn("FLY_API_TOKEN", self.fly.config["env"])
        raw = Path(self.db.path).read_bytes()
        self.assertNotIn(app_token.encode(), raw)
        self.assertNotIn(b"aura-secret", raw)

    def test_public_addresses_are_assigned_and_a_repeat_is_safe(self) -> None:
        calls: list[tuple[str, str]] = []

        def transport(method: str, url: str, headers: dict[str, str], body: bytes | None):
            payload = json.loads(body.decode("utf-8"))
            calls.append((url, payload["type"]))
            if payload["type"] == "v6":
                return 422, b'{"error":"address already allocated"}'
            return 201, b'{"ip":"66.241.124.246","shared":true}'

        FlyClient("token", transport).allocate_public_ips("ada-flow")
        self.assertEqual(
            calls,
            [
                ("https://api.machines.dev/v1/apps/ada-flow/ip_assignments", "shared_v4"),
                ("https://api.machines.dev/v1/apps/ada-flow/ip_assignments", "v6"),
            ],
        )

        def reject(method: str, url: str, headers: dict[str, str], body: bytes | None):
            return 422, b'{"error":"region is full"}'

        with self.assertRaises(FlyError):
            FlyClient("token", reject).allocate_public_ips("ada-flow")

    def test_self_hosted_reports_a_taken_fly_name(self) -> None:
        def reject(name: str) -> None:
            raise FlyError("Fly GraphQL failed: Validation failed: Name has already been taken")

        self.fly.create_app = reject
        client = TestClient(self._app())
        self._account(client)
        response = client.post(
            "/api/instances",
            json={
                "tier": "self_hosted",
                "app_name": "ada-flow",
                "region": "iad",
                "password": ADMIN_PASSWORD,
                "fly_token": f"  {FLY_TOKEN}  ",
                "neo4j_uri": "neo4j+s://example.databases.neo4j.io",
                "neo4j_user": "neo4j",
                "neo4j_password": AURA_PASSWORD,
            },
        )
        self.assertEqual(response.status_code, 502, response.text)
        self.assertIn("already taken", response.text)
        self.assertNotIn(FLY_TOKEN, response.text)
        self.assertIn("fly tokens create org", provision_failure_message("Fly request failed (HTTP 401)"))
        self.assertEqual(
            provision_failure_message("something unexpected"),
            "something unexpected",
        )

    def test_events_keep_sandbox_awake_until_day_seven_then_upgrade_and_delete(self) -> None:
        account = self.db.create_account("ada@example.com", hash_password(ADMIN_PASSWORD), "Ada")
        past = iso(utcnow() - timedelta(days=1))
        future = iso(utcnow() + timedelta(days=2))
        row = self.db.insert_instance(
            account["id"],
            tier="sandbox",
            status="running",
            app_name="pf-ada",
            region="iad",
            fly_machine_id="mach_test",
            volume_id="vol_test",
            expires_at=future,
            event_count=0,
            sleep_allowed=1,
            subscription_status="none",
        )
        awake = note_events(self.db, self.fly, row, 1)
        self.assertEqual(awake["sleep_allowed"], 0)
        self.assertIn(("mode", "pf-ada", "mach_test", "on"), self.fly.calls)
        asleep = note_events(self.db, self.fly, awake, 0)
        self.assertEqual(asleep["sleep_allowed"], 1)
        self.assertIn(("mode", "pf-ada", "mach_test", "sleep"), self.fly.calls)

        self.db.update_instance(row["id"], expires_at=past, event_count=1, sleep_allowed=0, status="running")
        result = tick(self.db, self.fly, utcnow())
        self.assertEqual(result["suspended"], 1)
        suspended = self.db.instance(row["id"])
        assert suspended is not None
        self.assertEqual(suspended["status"], "suspended")
        self.assertTrue(suspended["delete_after"])

        upgraded = self.db.update_instance(row["id"], **upgrade_fields())
        self.assertEqual(upgraded["tier"], "basic")
        self.assertEqual(upgraded["status"], "running")
        self.assertIsNone(upgraded["expires_at"])
        self.assertFalse(should_delete(upgraded, utcnow() + timedelta(days=30)))

        other = self.db.insert_instance(
            account["id"],
            tier="sandbox",
            status="suspended",
            app_name="pf-old",
            region="iad",
            fly_machine_id="mach_old",
            volume_id="vol_old",
            delete_after=past,
            subscription_status="none",
        )
        kept = self.db.insert_instance(
            account["id"],
            tier="basic",
            status="suspended",
            app_name="pf-paid",
            region="iad",
            volume_id="vol_paid",
            delete_after=past,
            subscription_status="active",
        )
        deleted = tick(self.db, self.fly, utcnow())
        self.assertEqual(deleted["deleted"], 1)
        self.assertEqual(self.db.instance(other["id"])["status"], "deleted")
        self.assertEqual(self.db.instance(kept["id"])["status"], "suspended")
        self.assertIn(("delete_app", "pf-old"), self.fly.calls)

    def test_stripe_signature_and_idempotent_provision(self) -> None:
        account = self.db.create_account("ada@example.com", hash_password(ADMIN_PASSWORD), "Ada")
        row = self.db.insert_instance(
            account["id"],
            tier="basic",
            status="pending_payment",
            app_name="pf-ada",
            region="iad",
            subscription_status="none",
        )
        client = TestClient(self._app())
        payload = json.dumps(
            {
                "id": "evt_1",
                "type": "checkout.session.completed",
                "data": {
                    "object": {
                        "metadata": {"instance_id": row["id"]},
                        "customer": "cus_1",
                        "subscription": "sub_1",
                    }
                },
            }
        ).encode()
        bad = client.post("/api/stripe/webhook", content=payload, headers={"Stripe-Signature": "t=1,v1=nope"})
        self.assertEqual(bad.status_code, 400, bad.text)
        self.assertEqual(self.fly.calls, [])

        stamp = int(utcnow().timestamp())
        header = sign_payload(payload, "whsec_test", stamp)
        ok = client.post("/api/stripe/webhook", content=payload, headers={"Stripe-Signature": header})
        self.assertEqual(ok.status_code, 200, ok.text)
        creates = [call for call in self.fly.calls if call[0] == "create_app"]
        self.assertEqual(len(creates), 1)
        again = client.post("/api/stripe/webhook", content=payload, headers={"Stripe-Signature": header})
        self.assertEqual(again.status_code, 200, again.text)
        creates = [call for call in self.fly.calls if call[0] == "create_app"]
        self.assertEqual(len(creates), 1)
        stored = self.db.instance(row["id"])
        assert stored is not None
        self.assertEqual(stored["status"], "running")
        self.assertNotIn(b"whsec_test", Path(self.db.path).read_bytes())

    def test_guide_refuses_tools_and_rate_limits(self) -> None:
        self.assertIn("propose_change", chat_agent._SYSTEM)
        self.assertNotIn("propose_change", SYSTEM)
        client = TestClient(self._app(limit=2))
        tools = client.post(
            "/api/guide/chat",
            json={"tools": [{"name": "propose_change"}], "messages": [{"role": "user", "content": "hi"}]},
        )
        self.assertEqual(tools.status_code, 400, tools.text)
        first = client.post("/api/guide/chat", json={"messages": [{"role": "user", "content": "What is pona flow?"}]})
        self.assertEqual(first.status_code, 200, first.text)
        second = client.post("/api/guide/chat", json={"messages": [{"role": "user", "content": "And editions?"}]})
        self.assertEqual(second.status_code, 200, second.text)
        third = client.post("/api/guide/chat", json={"messages": [{"role": "user", "content": "Again"}]})
        self.assertEqual(third.status_code, 429, third.text)


if __name__ == "__main__":
    unittest.main()
