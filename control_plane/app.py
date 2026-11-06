"""HTTP API for the guide, onboarding, Stripe, and fleet callbacks."""

from __future__ import annotations

import logging
import os
import threading
import hmac
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import mail
from .billing import StripeError, create_checkout, verify_event
from .db import Database
from .fly import FlyClient, FlyError, urllib_transport
from .guide import MAX_MESSAGE_CHARS, RateLimiter, default_complete, guide_reply
from .lifecycle import (
    classify_code,
    presence_fields,
    sandbox_expiry,
    upgrade_fields,
    vip_code_hash,
    cancel_fields,
)
from .provision import Provisioner, UrllibInstanceClient, prepare_fleet_row
from .scheduler import note_events, tick
from .util import (
    GITHUB_REPO,
    REGIONS,
    SANDBOX_DAYS,
    aura_uri_ok,
    hash_password,
    hash_token,
    iso,
    new_id,
    normalize_email,
    plus_days,
    utcnow,
    valid_app_slug,
    valid_email,
    valid_region,
    verify_password,
)

log = logging.getLogger("pona_flow.control_plane")


def provision_failure_message(detail: str) -> str:
    """Turn a Fly client error into a sentence the setup form can show."""
    text = " ".join((detail or "").split())
    lowered = text.lower()
    if "already been taken" in lowered or "already taken" in lowered or "already exists" in lowered:
        return "That app name is already taken on Fly. Choose a different name."
    if (
        "not authorized" in lowered
        or "unauthorized" in lowered
        or "http 401" in lowered
        or "http 403" in lowered
        or "organization was not found" in lowered
    ):
        return (
            "This token cannot create a Fly app. Run fly tokens create org and paste only the token it prints. "
            "The Fly dashboard asks you to pick an app, and this app does not exist yet."
        )
    if text and len(text) <= 240 and not any(word in lowered for word in ("secret", "password", "token", "bearer")):
        return text
    return "Could not configure the Fly app."


def _fly_token(value: object) -> str:
    token = str(value or "").strip()
    if len(token) >= 2 and token[0] == token[-1] and token[0] in {'"', "'"}:
        token = token[1:-1].strip()
    return token

COOKIE = "pf_start"
PUBLIC_INSTANCE_FIELDS = (
    "id",
    "tier",
    "status",
    "app_name",
    "region",
    "public_url",
    "subscription_status",
    "expires_at",
    "suspended_at",
    "delete_after",
    "admin_ready",
    "sleep_allowed",
    "event_count",
    "error",
    "created_at",
)


def public_instance(row: dict[str, Any]) -> dict[str, Any]:
    return {key: row.get(key) for key in PUBLIC_INSTANCE_FIELDS}


def public_account(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "email": row["email"],
        "display_name": row.get("display_name"),
        "email_verified": bool(row.get("email_verified")),
    }


def create_app(
    *,
    database: Database | None = None,
    fly_factory: Callable[[str], Any] | None = None,
    http: Any | None = None,
    stripe_transport: Callable[..., tuple[int, bytes]] | None = None,
    guide_complete: Callable[[str, list[dict[str, str]]], str] | None = None,
    limiter: RateLimiter | None = None,
    inline_jobs: bool = False,
    start_scheduler: bool = False,
) -> FastAPI:
    db_path = os.environ.get("CONTROL_PLANE_DB") or str(Path.cwd() / "control-plane.db")
    db = database or Database(db_path)
    factory = fly_factory or (lambda token: FlyClient(token, urllib_transport, os.environ.get("FLY_ORG") or ""))
    instance_http = http or UrllibInstanceClient()
    public_url = (os.environ.get("CONTROL_PLANE_PUBLIC_URL") or "http://127.0.0.1:8090").rstrip("/")
    site_url = (os.environ.get("CONTROL_PLANE_SITE_URL") or public_url).rstrip("/")
    provisioner = Provisioner(db, factory, instance_http, fleet_url=public_url)
    complete = guide_complete or default_complete
    rate = limiter or RateLimiter(
        int(os.environ.get("GUIDE_RATE_LIMIT") or "20"),
        int(os.environ.get("GUIDE_RATE_WINDOW") or "3600"),
    )
    app = FastAPI()
    origins = [
        origin.strip()
        for origin in (os.environ.get("CONTROL_PLANE_CORS") or "https://mitchmcquinn.github.io").split(",")
        if origin.strip()
    ]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )
    app.state.db = db
    app.state.provisioner = provisioner
    app.state.fly_factory = factory
    app.state.inline_jobs = inline_jobs
    app.state.stripe_transport = stripe_transport
    app.state.guide_complete = complete
    app.state.limiter = rate
    app.state.public_url = public_url

    def our_fly() -> Any:
        token = (os.environ.get("FLY_API_TOKEN") or "").strip()
        if not token:
            raise HTTPException(503, "FLY_API_TOKEN is not set")
        return factory(token)

    def spawn(job: Callable[[], None]) -> None:
        if inline_jobs:
            job()
            return
        threading.Thread(target=job, daemon=True).start()

    def account_from(request: Request) -> dict[str, Any]:
        token = _bearer(request) or request.cookies.get(COOKIE) or ""
        if not token:
            raise HTTPException(401, "Sign in is required.")
        account = db.account_for_session(hash_token(token))
        if account is None:
            raise HTTPException(401, "Sign in is required.")
        return account

    def issue_session(account_id: str) -> str:
        token = new_id() + new_id()
        db.create_session(hash_token(token), account_id)
        return token

    def attach_session(response: JSONResponse, token: str) -> None:
        response.set_cookie(
            COOKIE,
            token,
            httponly=True,
            samesite="lax",
            secure=public_url.startswith("https://"),
            path="/",
            max_age=60 * 60 * 24 * 30,
        )

    @app.get("/api/config")
    def config() -> dict[str, Any]:
        return {
            "regions": list(REGIONS),
            "support_url": (os.environ.get("SUPPORT_URL") or "").strip(),
            "github_url": GITHUB_REPO,
            "sandbox_days": SANDBOX_DAYS,
            "business": "coming_soon",
            "max_message_chars": MAX_MESSAGE_CHARS,
        }

    @app.post("/api/signup")
    async def signup(request: Request) -> JSONResponse:
        body = await _body(request)
        email = normalize_email(str(body.get("email") or ""))
        password = str(body.get("password") or "")
        display_name = str(body.get("display_name") or "").strip()
        if not valid_email(email):
            raise HTTPException(400, "Enter a valid email address.")
        if len(password) < 10:
            raise HTTPException(400, "Password must be at least 10 characters.")
        if db.account_by_email(email):
            raise HTTPException(409, "An account with that email already exists.")
        account = db.create_account(email, hash_password(password), display_name)
        token = new_id() + new_id()
        db.save_verify_token(hash_token(token), account["id"], plus_days(utcnow(), 1))
        link = f"{site_url}/?verify={token}"
        dev_link = None
        try:
            mail.send_verification(email, link)
        except RuntimeError as exc:
            log.info("verification mail was not sent: %s", exc)
        if mail.dev_inbox_enabled():
            dev_link = link
        session = issue_session(account["id"])
        response = JSONResponse(
            {
                "account": public_account(account),
                "dev_verify_url": dev_link,
                "session_token": session,
            },
            status_code=201,
        )
        attach_session(response, session)
        return response

    @app.post("/api/login")
    async def login(request: Request) -> JSONResponse:
        body = await _body(request)
        email = normalize_email(str(body.get("email") or ""))
        password = str(body.get("password") or "")
        account = db.account_by_email(email)
        if account is None or not verify_password(password, str(account["password_hash"])):
            raise HTTPException(401, "Incorrect email or password.")
        session = issue_session(account["id"])
        response = JSONResponse({"account": public_account(account), "session_token": session})
        attach_session(response, session)
        return response

    @app.post("/api/logout")
    def logout(request: Request) -> JSONResponse:
        token = _bearer(request) or request.cookies.get(COOKIE) or ""
        if token:
            db.delete_session(hash_token(token))
        response = JSONResponse({"ok": True})
        response.delete_cookie(COOKIE, path="/")
        return response

    @app.get("/api/me")
    def me(request: Request) -> dict[str, Any]:
        account = account_from(request)
        return {
            "account": public_account(account),
            "instances": [public_instance(row) for row in db.instances_for_account(account["id"])],
        }

    @app.post("/api/verify")
    async def verify(request: Request) -> dict[str, Any]:
        body = await _body(request)
        token = str(body.get("token") or "").strip()
        account_id = db.take_verify_token(hash_token(token), iso(utcnow())) if token else None
        if not account_id:
            raise HTTPException(400, "That verification link is invalid or expired.")
        db.mark_verified(account_id)
        account = db.account_by_id(account_id)
        if account is None:
            raise HTTPException(400, "That verification link is invalid or expired.")
        return {"account": public_account(account)}

    @app.post("/api/guide/chat")
    async def guide_chat(request: Request) -> dict[str, str]:
        body = await _body(request)
        if "tools" in body or any(
            isinstance(message, dict) and message.get("tool_calls") for message in body.get("messages") or []
        ):
            raise HTTPException(400, "Tool calls are not available.")
        ip = _client_ip(request)
        if not rate.allow(ip):
            raise HTTPException(429, "Too many messages. Try again later.")
        messages = body.get("messages")
        if not isinstance(messages, list):
            raise HTTPException(400, "A user message is required.")
        try:
            reply = guide_reply(messages, complete)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from exc
        return {"reply": reply}

    @app.post("/api/instances")
    async def create_instance(request: Request) -> JSONResponse:
        account = account_from(request)
        body = await _body(request)
        password = str(body.get("password") or "")
        if password and not verify_password(password, str(account["password_hash"])):
            raise HTTPException(401, "Incorrect email or password.")
        tier, code_error = _resolve_tier(db, account, body)
        if code_error:
            raise HTTPException(400, code_error)
        if tier == "business":
            raise HTTPException(400, "Hosted Business is coming soon.")
        if tier == "local":
            row = db.insert_instance(
                account["id"],
                tier="local",
                status="handed_off",
                subscription_status="none",
                public_url=GITHUB_REPO,
            )
            return JSONResponse(
                {
                    "instance": public_instance(row),
                    "github_url": GITHUB_REPO,
                    "support_url": (os.environ.get("SUPPORT_URL") or "").strip(),
                },
                status_code=201,
            )
        slug = str(body.get("app_name") or "")
        region = str(body.get("region") or "").strip().lower()
        if not valid_region(region):
            raise HTTPException(400, "Choose a region.")
        display_name = account.get("display_name")
        if tier == "self_hosted":
            if not valid_app_slug(slug):
                raise HTTPException(400, "App name: lowercase letters, numbers, and hyphens.")
            if not password:
                raise HTTPException(400, "Enter your password so we can create the admin account.")
            fly_token = _fly_token(body.get("fly_token"))
            neo4j_uri = str(body.get("neo4j_uri") or "")
            neo4j_password = str(body.get("neo4j_password") or "")
            if not fly_token or not neo4j_password or not aura_uri_ok(neo4j_uri):
                raise HTTPException(400, "A Fly org token and an Aura URI and password are required.")
            try:
                row = provisioner.provision_self_hosted(
                    account=account,
                    app_name=slug,
                    region=region,
                    fly_token=fly_token,
                    neo4j_uri=neo4j_uri,
                    neo4j_user=str(body.get("neo4j_user") or "neo4j"),
                    neo4j_password=neo4j_password,
                    admin_password=password,
                    display_name=str(display_name or "") or None,
                )
            except FlyError as exc:
                message = provision_failure_message(str(exc))
                log.info("self-hosted provision failed: %s", message)
                raise HTTPException(502, message) from exc
            except Exception as exc:
                log.info("self-hosted provision failed: %s", exc.__class__.__name__)
                raise HTTPException(502, "Could not configure the Fly app.") from exc
            return JSONResponse({"instance": public_instance(row)}, status_code=201)

        if not valid_app_slug(slug):
            raise HTTPException(400, "App name: lowercase letters, numbers, and hyphens.")
        if tier == "basic":
            row = prepare_fleet_row(db, account["id"], "basic", slug, region, None)
            try:
                checkout = create_checkout(
                    secret_key=(os.environ.get("STRIPE_SECRET_KEY") or "").strip(),
                    price_id=(os.environ.get("STRIPE_PRICE_BASIC") or "").strip(),
                    success_url=f"{site_url}/?checkout=success&instance={row['id']}",
                    cancel_url=f"{site_url}/?checkout=cancel&instance={row['id']}",
                    customer_email=account["email"],
                    instance_id=row["id"],
                    account_id=account["id"],
                    transport=stripe_transport,
                )
            except StripeError as exc:
                db.update_instance(row["id"], status="failed", error=str(exc)[:300])
                raise HTTPException(502, str(exc)) from exc
            return JSONResponse(
                {"instance": public_instance(db.instance(row["id"]) or row), "checkout_url": checkout},
                status_code=201,
            )

        if tier in ("sandbox", "vip") and not password:
            raise HTTPException(400, "Enter your password so we can create the admin account.")
        expires = sandbox_expiry(utcnow()) if tier == "sandbox" else None
        row = prepare_fleet_row(db, account["id"], tier, slug, region, expires)
        held_password = password

        def job() -> None:
            provisioner.provision_fleet(row["id"], held_password)

        spawn(job)
        return JSONResponse({"instance": public_instance(db.instance(row["id"]) or row)}, status_code=201)

    @app.get("/api/instances/{instance_id}")
    def get_instance(instance_id: str, request: Request) -> dict[str, Any]:
        account = account_from(request)
        row = _owned(db, account, instance_id)
        return {"instance": public_instance(row)}

    @app.post("/api/instances/{instance_id}/finish")
    async def finish(instance_id: str, request: Request) -> dict[str, Any]:
        account = account_from(request)
        body = await _body(request)
        row = _owned(db, account, instance_id)
        password = str(body.get("password") or "")
        if row.get("admin_ready"):
            return {"instance": public_instance(row)}
        if not password or not verify_password(password, str(account["password_hash"])):
            raise HTTPException(401, "Incorrect email or password.")
        if row.get("status") != "running" or not row.get("public_url"):
            return {"instance": public_instance(row)}
        try:
            instance_http.setup_admin(
                str(row["public_url"]),
                account["email"],
                password,
                account.get("display_name"),
            )
        except Exception as exc:
            log.info("admin setup failed: %s", exc.__class__.__name__)
            raise HTTPException(502, "The instance is up, but the admin account was not created.") from exc
        updated = db.update_instance(instance_id, admin_ready=1)
        return {"instance": public_instance(updated)}

    @app.post("/api/instances/{instance_id}/upgrade")
    async def upgrade(instance_id: str, request: Request) -> JSONResponse:
        account = account_from(request)
        row = _owned(db, account, instance_id)
        if row.get("tier") != "sandbox":
            raise HTTPException(400, "Only a sandbox can be upgraded in place.")
        updated = db.update_instance(instance_id, status="pending_payment")
        try:
            checkout = create_checkout(
                secret_key=(os.environ.get("STRIPE_SECRET_KEY") or "").strip(),
                price_id=(os.environ.get("STRIPE_PRICE_BASIC") or "").strip(),
                success_url=f"{site_url}/?checkout=success&instance={instance_id}",
                cancel_url=f"{site_url}/?checkout=cancel&instance={instance_id}",
                customer_email=account["email"],
                instance_id=instance_id,
                account_id=account["id"],
                transport=stripe_transport,
            )
        except StripeError as exc:
            db.update_instance(instance_id, **{key: row.get(key) for key in ("status",)})
            raise HTTPException(502, str(exc)) from exc
        return JSONResponse({"instance": public_instance(updated), "checkout_url": checkout})

    @app.post("/api/stripe/webhook")
    async def stripe_webhook(request: Request) -> dict[str, bool]:
        payload = await request.body()
        secret = (os.environ.get("STRIPE_WEBHOOK_SECRET") or "").strip()
        try:
            event = verify_event(payload, request.headers.get("stripe-signature") or "", secret)
        except StripeError as exc:
            raise HTTPException(400, str(exc)) from exc
        event_id = str(event.get("id") or "")
        if not event_id or not db.remember_stripe_event(event_id):
            return {"ok": True}
        kind = str(event.get("type") or "")
        data_object = ((event.get("data") or {}) if isinstance(event.get("data"), dict) else {}).get("object")
        if not isinstance(data_object, dict):
            return {"ok": True}
        if kind == "checkout.session.completed":
            instance_id = str((data_object.get("metadata") or {}).get("instance_id") or data_object.get("client_reference_id") or "")
            row = db.instance(instance_id) if instance_id else None
            if row is None:
                return {"ok": True}
            fields = upgrade_fields() if row.get("tier") == "sandbox" else {"subscription_status": "active"}
            fields["stripe_customer_id"] = str(data_object.get("customer") or "") or None
            fields["stripe_subscription_id"] = str(data_object.get("subscription") or "") or None
            if row.get("tier") != "sandbox":
                fields["status"] = "provisioning"
            updated = db.update_instance(instance_id, **fields)
            if row.get("tier") == "sandbox":
                spawn(lambda: _resume(factory, updated))
            elif not row.get("fly_machine_id"):
                spawn(lambda: provisioner.provision_fleet(instance_id, None))
            return {"ok": True}
        if kind == "customer.subscription.deleted":
            instance_id = str((data_object.get("metadata") or {}).get("instance_id") or "")
            row = db.instance(instance_id) if instance_id else None
            if row is None:
                return {"ok": True}
            db.update_instance(instance_id, **cancel_fields(utcnow()))
            spawn(lambda: _resume_stop(factory, row))
        return {"ok": True}

    @app.post("/api/internal/instances/{instance_id}/presence")
    async def presence(instance_id: str, request: Request) -> dict[str, Any]:
        row = db.instance(instance_id)
        if row is None:
            raise HTTPException(404, "Instance not found.")
        token = _bearer(request)
        expected = str(row.get("fleet_token_hash") or "")
        if not token or not expected or not hmac.compare_digest(hash_token(token), expected):
            raise HTTPException(401, "Fleet token was rejected.")
        body = await _body(request)
        try:
            count = int(body.get("event_count"))
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, "event_count is required.") from exc
        try:
            fly = our_fly()
        except HTTPException:
            fly = None
        if fly is None:
            updated = db.update_instance(instance_id, **presence_fields(row, count))
        else:
            updated = note_events(db, fly, row, count)
        return {"instance": public_instance(updated)}

    ui_dir = Path(os.environ.get("CONTROL_PLANE_UI_DIR") or Path(__file__).resolve().parents[1] / "App" / "ui" / "dist")
    guide_html = ui_dir / "guide.html"
    assets = ui_dir / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="guide-assets")

    @app.get("/")
    def homepage() -> FileResponse:
        if guide_html.is_file():
            return FileResponse(guide_html)
        raise HTTPException(404, "Guide UI is not built.")

    if start_scheduler:
        threading.Thread(target=_scheduler_loop, args=(db, factory), daemon=True).start()
    return app


def _resume(factory: Callable[[str], Any], row: dict[str, Any]) -> None:
    token = (os.environ.get("FLY_API_TOKEN") or "").strip()
    if not token or not row.get("app_name") or not row.get("fly_machine_id"):
        return
    factory(token).set_mode(str(row["app_name"]), str(row["fly_machine_id"]), "on")


def _resume_stop(factory: Callable[[str], Any], row: dict[str, Any]) -> None:
    token = (os.environ.get("FLY_API_TOKEN") or "").strip()
    if not token or not row.get("app_name") or not row.get("fly_machine_id"):
        return
    factory(token).set_mode(str(row["app_name"]), str(row["fly_machine_id"]), "suspended")


def _scheduler_loop(database: Database, factory: Callable[[str], Any]) -> None:
    import time

    while True:
        time.sleep(3600)
        token = (os.environ.get("FLY_API_TOKEN") or "").strip()
        if not token:
            continue
        try:
            tick(database, factory(token))
        except Exception:
            log.exception("scheduler tick failed")


def _resolve_tier(database: Database, account: dict[str, Any], body: dict[str, Any]) -> tuple[str, str | None]:
    code = str(body.get("code") or "")
    kind = classify_code(code)
    if kind == "unknown":
        return "", "That code is not valid."
    if kind == "vip":
        if not account.get("email_verified"):
            return "", "Verify your email before redeeming a code."
        if not database.redeem_vip(vip_code_hash(code), account["id"], iso(utcnow())):
            return "", "That code is not valid."
        return "vip", None
    tier = str(body.get("tier") or "").strip().lower()
    if kind == "sandbox":
        tier = "sandbox"
    if tier == "sandbox":
        if not account.get("email_verified"):
            return "", "Verify your email before starting a sandbox."
        cap = int(os.environ.get("SANDBOX_MAX_ACTIVE") or "20")
        if database.has_active_sandbox(account["id"]):
            return "", "This account already has a sandbox."
        if database.count_active_sandboxes() >= cap:
            return "", "Sandbox previews are full right now."
        return "sandbox", None
    if tier not in ("local", "self_hosted", "basic", "business"):
        return "", "Choose an edition."
    return tier, None


def _owned(database: Database, account: dict[str, Any], instance_id: str) -> dict[str, Any]:
    row = database.instance(instance_id)
    if row is None or row.get("account_id") != account["id"]:
        raise HTTPException(404, "Instance not found.")
    return row


async def _body(request: Request) -> dict[str, Any]:
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(400, "Expected JSON.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(400, "Expected JSON.")
    return payload


def _client_ip(request: Request) -> str:
    forwarded = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if forwarded:
        return forwarded
    return request.client.host if request.client else "unknown"


def _bearer(request: Request) -> str:
    header = (request.headers.get("authorization") or "").strip()
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return ""


class _LazyApp:
    """Build the ASGI app on first request so imports do not open a database."""

    def __init__(self) -> None:
        self._app: FastAPI | None = None

    def _get(self) -> FastAPI:
        if self._app is None:
            enabled = (os.environ.get("CONTROL_PLANE_SCHEDULER") or "1").strip() != "0"
            self._app = create_app(start_scheduler=enabled)
        return self._app

    def __getattr__(self, name: str) -> Any:
        return getattr(self._get(), name)

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        await self._get()(scope, receive, send)


app = _LazyApp()
