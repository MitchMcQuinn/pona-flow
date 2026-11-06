"""Fly Machines API and the GraphQL calls that create an app, a volume's secrets, and the app itself.

Tokens are held on the client for the request. Callers do not persist them.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Callable

GRAPHQL_URL = "https://api.fly.io/graphql"
MACHINES_URL = "https://api.machines.dev/v1"

Transport = Callable[[str, str, dict[str, str], bytes | None], tuple[int, bytes]]


class FlyError(RuntimeError):
    pass


def urllib_transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


class FlyClient:
    def __init__(self, token: str, transport: Transport | None = None, org_slug: str = ""):
        self.token = token
        self.transport = transport or urllib_transport
        self.org_slug = (org_slug or "").strip()

    def _headers(self, content_json: bool = False) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
            "User-Agent": "pona-flow-control-plane",
        }
        if content_json:
            headers["Content-Type"] = "application/json"
        return headers

    def _json(self, method: str, url: str, payload: dict[str, Any] | None = None) -> Any:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        status, raw = self.transport(method, url, self._headers(payload is not None), body)
        if status >= 400:
            raise FlyError(f"Fly request failed (HTTP {status})")
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise FlyError("Fly returned a non-JSON body") from exc

    def graphql(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = self._json("POST", GRAPHQL_URL, {"query": query, "variables": variables or {}})
        if not isinstance(payload, dict):
            raise FlyError("Fly GraphQL returned an unexpected body")
        errors = payload.get("errors")
        if errors:
            message = ""
            if isinstance(errors, list) and errors and isinstance(errors[0], dict):
                message = str(errors[0].get("message") or "")
            lowered = message.lower()
            if "already exists" in lowered or "name is already taken" in lowered:
                return {"already_exists": True}
            raise FlyError("Fly GraphQL failed" + (f": {message}" if message else ""))
        data = payload.get("data")
        return data if isinstance(data, dict) else {}

    def organization_id(self) -> str:
        if self.org_slug:
            data = self.graphql(
                "query($slug: String!) { organization(slug: $slug) { id } }",
                {"slug": self.org_slug},
            )
            org = data.get("organization") if isinstance(data.get("organization"), dict) else {}
            org_id = str(org.get("id") or "")
            if org_id:
                return org_id
            raise FlyError("Fly organization was not found")
        data = self.graphql("query { organizations { nodes { id slug } } }")
        nodes = ((data.get("organizations") or {}) if isinstance(data.get("organizations"), dict) else {}).get("nodes")
        if isinstance(nodes, list):
            for node in nodes:
                if isinstance(node, dict) and node.get("id"):
                    return str(node["id"])
        raise FlyError("Fly organization was not found")

    def create_app(self, name: str) -> None:
        org_id = self.organization_id()
        self.graphql(
            "mutation($input: CreateAppInput!) { createApp(input: $input) { app { name } } }",
            {"input": {"name": name, "organizationId": org_id}},
        )

    def allocate_public_ips(self, app: str) -> None:
        """Assign the addresses that publish ``<app>.fly.dev``.

        An app created through this API does not receive them. A shared IPv4 is
        what a normal browser looks up. IPv6 is assigned with it. Repeating the
        call after the addresses exist is safe.
        """
        for kind in ("shared_v4", "v6"):
            status, raw = self.transport(
                "POST",
                f"{MACHINES_URL}/apps/{app}/ip_assignments",
                self._headers(True),
                json.dumps({"type": kind}).encode("utf-8"),
            )
            if status < 400:
                continue
            detail = raw.decode("utf-8", errors="replace").lower()
            if "already" in detail:
                continue
            raise FlyError(f"Fly address was not assigned (HTTP {status})")

    def set_secrets(self, app: str, secrets: dict[str, str]) -> None:
        items = [{"key": key, "value": value} for key, value in secrets.items()]
        self.graphql(
            "mutation($input: SetSecretsInput!) { setSecrets(input: $input) { app { name } } }",
            {"input": {"appId": app, "secrets": items}},
        )

    def create_volume(self, app: str, region: str, size_gb: int = 1) -> str:
        payload = self._json(
            "POST",
            f"{MACHINES_URL}/apps/{app}/volumes",
            {"name": "pona_data", "region": region, "size_gb": size_gb},
        )
        volume_id = ""
        if isinstance(payload, dict):
            volume_id = str(payload.get("id") or "")
            nested = payload.get("volume")
            if not volume_id and isinstance(nested, dict):
                volume_id = str(nested.get("id") or "")
        if not volume_id:
            raise FlyError("Fly volume was not created")
        return volume_id

    def create_machine(self, app: str, config: dict[str, Any], region: str) -> str:
        payload = self._json(
            "POST",
            f"{MACHINES_URL}/apps/{app}/machines",
            {"region": region, "config": config},
        )
        machine_id = str(payload.get("id") or "") if isinstance(payload, dict) else ""
        if not machine_id:
            raise FlyError("Fly machine was not created")
        return machine_id

    def list_machines(self, app: str) -> list[dict[str, Any]]:
        status, raw = self.transport(
            "GET",
            f"{MACHINES_URL}/apps/{app}/machines",
            self._headers(),
            None,
        )
        if status >= 400:
            raise FlyError(f"Fly request failed (HTTP {status})")
        payload = json.loads(raw.decode("utf-8") or "[]")
        if not isinstance(payload, list):
            raise FlyError("Fly machine list was unexpected")
        return [item for item in payload if isinstance(item, dict)]

    def update_machine(self, app: str, machine_id: str, config: dict[str, Any]) -> None:
        self._json(
            "POST",
            f"{MACHINES_URL}/apps/{app}/machines/{machine_id}",
            {"config": config},
        )

    def start_machine(self, app: str, machine_id: str) -> None:
        self._json("POST", f"{MACHINES_URL}/apps/{app}/machines/{machine_id}/start", {})

    def stop_machine(self, app: str, machine_id: str) -> None:
        self._json("POST", f"{MACHINES_URL}/apps/{app}/machines/{machine_id}/stop", {})

    def delete_volume(self, app: str, volume_id: str) -> None:
        status, _raw = self.transport(
            "DELETE",
            f"{MACHINES_URL}/apps/{app}/volumes/{volume_id}",
            self._headers(),
            None,
        )
        if status >= 400 and status != 404:
            raise FlyError(f"Fly request failed (HTTP {status})")

    def delete_app(self, name: str) -> None:
        self.graphql("mutation($appId: ID!) { deleteApp(appId: $appId) { organization { id } } }", {"appId": name})

    def set_mode(self, app: str, machine_id: str, mode: str) -> None:
        from .machines import apply_mode

        machines = self.list_machines(app)
        target = next((item for item in machines if str(item.get("id") or "") == machine_id), None)
        if target is None and machines:
            target = machines[0]
            machine_id = str(target.get("id") or machine_id)
        config = dict(target.get("config") or {}) if target else {}
        self.update_machine(app, machine_id, apply_mode(config, mode))
        if mode == "on":
            self.start_machine(app, machine_id)
        elif mode == "suspended":
            self.stop_machine(app, machine_id)
