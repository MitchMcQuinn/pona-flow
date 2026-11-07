"""Machine config for a pona flow Fly app. Secrets are not placed in env."""

from __future__ import annotations

from typing import Any

from .util import HOSTED_IMAGE, SELF_HOSTED_IMAGE

# Fly Launch only restarts machines that carry this metadata. Without it,
# `fly secrets set` stages the values, finds no Launch machine, and stops with
# "app has no current release" instead of rolling the new secrets onto the VM.
VOLUME_NAME = "pona_data"
FLY_PLATFORM_VERSION = "v2"
FLY_PROCESS_GROUP = "app"


def service_mode(awake: bool, suspended: bool = False) -> str:
    if suspended:
        return "suspended"
    return "on" if awake else "sleep"


def http_service(mode: str) -> dict[str, Any]:
    if mode == "on":
        autostart, autostop, minimum = True, "off", 1
    elif mode == "sleep":
        autostart, autostop, minimum = True, "stop", 0
    else:
        autostart, autostop, minimum = False, "off", 0
    return {
        "protocol": "tcp",
        "internal_port": 8765,
        "autostart": autostart,
        "autostop": autostop,
        "min_machines_running": minimum,
        "ports": [
            {"port": 80, "handlers": ["http"], "force_https": True},
            {"port": 443, "handlers": ["tls", "http"]},
        ],
        "checks": [
            {
                "type": "http",
                "port": 8765,
                "interval": "30s",
                "timeout": "5s",
                "grace_period": "40s",
                "method": "GET",
                "path": "/healthz",
            }
        ],
    }


def apply_mode(config: dict[str, Any], mode: str) -> dict[str, Any]:
    updated = dict(config)
    desired = http_service(mode)
    services = list(updated.get("services") or [])
    if services and isinstance(services[0], dict):
        service = dict(services[0])
        service.update(
            {
                "autostart": desired["autostart"],
                "autostop": desired["autostop"],
                "min_machines_running": desired["min_machines_running"],
            }
        )
        services[0] = service
    else:
        services = [desired]
    updated["services"] = services
    return updated


def guest(hosted: bool) -> dict[str, Any]:
    if hosted:
        return {"cpu_kind": "shared", "cpus": 2, "memory_mb": 2048}
    return {"cpu_kind": "shared", "cpus": 1, "memory_mb": 1024}


def public_env(app: str, public_url: str, fleet_url: str = "", instance_id: str = "") -> dict[str, str]:
    env = {
        "PONA_FLOW_HOST": "0.0.0.0",
        "PONA_FLOW_PORT": "8765",
        "PONA_FLOW_DATA_DIR": "/data",
        "SQLITE_DATABASE_PATH": "data.db",
        "PONA_FLOW_AUTH_MODE": "local",
        "PONA_FLOW_ALLOW_OPEN_SIGNUP": "0",
        "PONA_FLOW_SIGNUP_CAN_CREATE_SPACES": "0",
        "PONA_FLOW_CREDENTIAL_BACKEND": "local",
        "PONA_FLOW_PUBLIC_URL": public_url,
        "FLY_APP_NAME": app,
        "FORWARDED_ALLOW_IPS": "*",
    }
    if fleet_url and instance_id:
        env["PONA_FLOW_FLEET_URL"] = fleet_url.rstrip("/")
        env["PONA_FLOW_FLEET_INSTANCE_ID"] = instance_id
    return env


def machine_config(
    *,
    hosted: bool,
    app: str,
    public_url: str,
    volume_id: str,
    mode: str,
    fleet_url: str = "",
    instance_id: str = "",
) -> dict[str, Any]:
    return {
        "image": HOSTED_IMAGE if hosted else SELF_HOSTED_IMAGE,
        "guest": guest(hosted),
        "env": public_env(app, public_url, fleet_url, instance_id),
        "metadata": {
            "fly_platform_version": FLY_PLATFORM_VERSION,
            "fly_process_group": FLY_PROCESS_GROUP,
        },
        "mounts": [{"volume": volume_id, "path": "/data", "name": VOLUME_NAME}],
        "services": [http_service(mode)],
    }
