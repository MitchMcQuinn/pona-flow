"""Verification mail. Production refuses the dev inbox."""

from __future__ import annotations

import logging
import os
import smtplib
from email.message import EmailMessage

log = logging.getLogger("pona_flow.control_plane.mail")


def dev_inbox_enabled() -> bool:
    if (os.environ.get("CONTROL_PLANE_ENV") or "").strip().lower() == "production":
        return False
    return (os.environ.get("CONTROL_PLANE_DEV_INBOX") or "").strip() == "1"


def send_verification(email: str, link: str) -> None:
    if dev_inbox_enabled():
        log.info("verification link for %s: %s", email, link)
        return
    host = (os.environ.get("SMTP_HOST") or "").strip()
    if not host:
        raise RuntimeError("SMTP is not configured")
    port = int((os.environ.get("SMTP_PORT") or "587").strip() or "587")
    sender = (os.environ.get("SMTP_FROM") or "").strip() or "pona flow <no-reply@localhost>"
    message = EmailMessage()
    message["Subject"] = "Confirm your pona flow account"
    message["From"] = sender
    message["To"] = email
    message.set_content(
        "Confirm your email to start a sandbox or redeem a VIP code.\n\n" + link + "\n"
    )
    user = (os.environ.get("SMTP_USER") or "").strip()
    password = os.environ.get("SMTP_PASSWORD") or ""
    with smtplib.SMTP(host, port, timeout=20) as smtp:
        smtp.starttls()
        if user:
            smtp.login(user, password)
        smtp.send_message(message)
