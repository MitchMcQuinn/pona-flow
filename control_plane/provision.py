"""Create a Fly app and the first admin. Secrets stay in the request and in Fly."""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from typing import Any, Callable

from .db import Database
from .fly import FlyClient, FlyError
from .lifecycle import machine_awake
from .machines import machine_config
from .util import decrypt_secret, encrypt_secret, fleet_app_name, hash_token, new_id

log = logging.getLogger("pona_flow.control_plane.provision")

FlyFactory = Callable[[str], Any]


class UrllibInstanceClient:
    def __init__(self, attempts: int = 40, pause: float = 3.0):
        self.attempts = attempts
        self.pause = pause

    def wait_healthy(self, public_url: str) -> None:
        url = public_url.rstrip("/") + "/healthz"
        last = "health check failed"
        for _ in range(self.attempts):
            try:
                with urllib.request.urlopen(url, timeout=5) as response:
                    if response.status == 200:
                        return
                    last = f"health check returned HTTP {response.status}"
            except (urllib.error.URLError, TimeoutError) as exc:
                last = "health check failed"
                log.info("health check not ready: %s", exc.__class__.__name__)
            time.sleep(self.pause)
        raise FlyError(last)

    def setup_admin(self, public_url: str, email: str, password: str, display_name: str | None) -> None:
        origin = public_url.rstrip("/")
        body = json.dumps(
            {"email": email, "password": password, "display_name": display_name or None}
        ).encode("utf-8")
        request = urllib.request.Request(
            origin + "/api/auth/setup",
            data=body,
            headers={"Content-Type": "application/json", "Origin": origin},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                if response.status >= 400:
                    raise FlyError(f"admin setup failed (HTTP {response.status})")
        except urllib.error.HTTPError as exc:
            raise FlyError(f"admin setup failed (HTTP {exc.code})") from exc


class Provisioner:
    def __init__(
        self,
        database: Database,
        fly_factory: FlyFactory,
        http: Any,
        fleet_url: str = "",
    ):
        self.db = database
        self.fly_factory = fly_factory
        self.http = http
        self.fleet_url = fleet_url.rstrip("/")

    def provision_self_hosted(
        self,
        *,
        account: dict[str, Any],
        app_name: str,
        region: str,
        fly_token: str,
        neo4j_uri: str,
        neo4j_user: str,
        neo4j_password: str,
        admin_password: str,
        display_name: str | None,
    ) -> dict[str, Any]:
        app = app_name.strip().lower()
        public_url = f"https://{app}.fly.dev"
        fly = self.fly_factory(fly_token)
        fly.create_app(app)
        volume_id = fly.create_volume(app, region)
        fly.set_secrets(
            app,
            {
                "NEO4J_URI": neo4j_uri.strip(),
                "NEO4J_USER": (neo4j_user or "neo4j").strip() or "neo4j",
                "NEO4J_PASSWORD": neo4j_password,
            },
        )
        config = machine_config(
            hosted=False,
            app=app,
            public_url=public_url,
            volume_id=volume_id,
            mode="on",
        )
        machine_id = fly.create_machine(app, config, region)
        self.http.wait_healthy(public_url)
        self.http.setup_admin(public_url, account["email"], admin_password, display_name)
        return self.db.insert_instance(
            account["id"],
            tier="self_hosted",
            status="running",
            app_name=app,
            region=region,
            public_url=public_url,
            fly_machine_id=machine_id,
            volume_id=volume_id,
            subscription_status="none",
            secrets_configured=1,
            admin_ready=1,
            sleep_allowed=0,
        )

    def provision_fleet(self, instance_id: str, admin_password: str | None) -> dict[str, Any]:
        row = self.db.instance(instance_id)
        if row is None:
            raise KeyError(instance_id)
        import os

        token = (os.environ.get("FLY_API_TOKEN") or "").strip()
        if not token:
            raise FlyError("FLY_API_TOKEN is not set")
        fly = self.fly_factory(token)
        app = str(row.get("app_name") or "")
        region = str(row.get("region") or "")
        public_url = f"https://{app}.fly.dev"
        self.db.update_instance(instance_id, status="provisioning", public_url=public_url, error=None)
        try:
            volume_id = str(row.get("volume_id") or "")
            if not volume_id:
                fly.create_app(app)
                volume_id = fly.create_volume(app, region)
            neo_password = (
                decrypt_secret(str(row["neo4j_password_enc"]))
                if row.get("neo4j_password_enc")
                else new_id() + new_id()
            )
            fleet_token = new_id() + new_id()
            fly.set_secrets(
                app,
                {
                    "NEO4J_URI": "bolt://127.0.0.1:7687",
                    "NEO4J_USER": "neo4j",
                    "NEO4J_PASSWORD": neo_password,
                    "PONA_FLOW_FLEET_TOKEN": fleet_token,
                },
            )
            awake = machine_awake(str(row.get("tier") or ""), int(row.get("event_count") or 0))
            mode = "on" if awake else "sleep"
            machine_id = str(row.get("fly_machine_id") or "")
            if not machine_id:
                config = machine_config(
                    hosted=True,
                    app=app,
                    public_url=public_url,
                    volume_id=volume_id,
                    mode=mode,
                    fleet_url=self.fleet_url,
                    instance_id=instance_id,
                )
                machine_id = fly.create_machine(app, config, region)
            else:
                fly.set_mode(app, machine_id, mode)
            self.db.update_instance(
                instance_id,
                volume_id=volume_id,
                fly_machine_id=machine_id,
                neo4j_password_enc=encrypt_secret(neo_password),
                fleet_token_hash=hash_token(fleet_token),
                secrets_configured=1,
                sleep_allowed=0 if awake else 1,
                public_url=public_url,
            )
            self.http.wait_healthy(public_url)
            admin_ready = int(row.get("admin_ready") or 0)
            if admin_password and not admin_ready:
                account = self.db.account_by_id(str(row["account_id"]))
                if account is None:
                    raise FlyError("account is missing")
                self.http.setup_admin(public_url, account["email"], admin_password, account.get("display_name"))
                admin_ready = 1
            return self.db.update_instance(
                instance_id,
                status="running",
                admin_ready=admin_ready,
                public_url=public_url,
                error=None,
            )
        except Exception as exc:
            message = exc.__class__.__name__ if not isinstance(exc, FlyError) else str(exc)
            self.db.update_instance(instance_id, status="failed", error=message[:300])
            raise


def prepare_fleet_row(database: Database, account_id: str, tier: str, slug: str, region: str, expires_at: str | None) -> dict[str, Any]:
    return database.insert_instance(
        account_id,
        tier=tier,
        status="pending_payment" if tier == "basic" else "provisioning",
        app_name=fleet_app_name(slug),
        region=region,
        subscription_status="none" if tier != "basic" else "none",
        expires_at=expires_at,
        sleep_allowed=1 if tier == "sandbox" else 0,
        admin_ready=0,
        secrets_configured=0,
    )
