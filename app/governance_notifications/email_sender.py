"""SMTP delivery for governance and platform operational notifications.

When SMTP is disabled or not configured, senders skip delivery and return False
without raising. Failures are isolated from Stream processing.
"""

from __future__ import annotations

import logging
import smtplib
import ssl
from email.message import EmailMessage
from typing import Protocol

logger = logging.getLogger(__name__)


class EmailSender(Protocol):
    def send_email(self, *, recipients: list[str], subject: str, body: str) -> bool:
        """Deliver email; return True on success."""

    def is_configured(self) -> bool:
        """True when this sender will attempt a real or test delivery."""


def smtp_delivery_enabled() -> bool:
    """True when platform SMTP is enabled and a host is configured."""

    from app.config import settings

    if not bool(getattr(settings, "SMTP_ENABLED", False)):
        return False
    host = str(getattr(settings, "SMTP_HOST", "") or "").strip()
    return bool(host)


class MockEmailSender:
    """In-memory email sender for unit tests."""

    def __init__(self) -> None:
        self.sent: list[dict[str, object]] = []
        self.should_fail = False

    def is_configured(self) -> bool:
        return True

    def send_email(self, *, recipients: list[str], subject: str, body: str) -> bool:
        if self.should_fail:
            return False
        self.sent.append(
            {
                "recipients": list(recipients),
                "subject": subject,
                "body": body,
            }
        )
        return True


class SmtpEmailSender:
    """smtplib-backed sender. Never raises to callers."""

    def is_configured(self) -> bool:
        return smtp_delivery_enabled()

    def send_email(self, *, recipients: list[str], subject: str, body: str) -> bool:
        cleaned = [str(r).strip() for r in recipients if str(r).strip()]
        if not cleaned:
            return False
        if not self.is_configured():
            logger.info("%s", {"stage": "smtp_email_skipped", "reason": "smtp_not_configured"})
            return False

        from app.config import settings

        host = str(settings.SMTP_HOST or "").strip()
        port = int(getattr(settings, "SMTP_PORT", 587) or 587)
        timeout = float(getattr(settings, "SMTP_TIMEOUT", 10.0) or 10.0)
        mail_from = str(getattr(settings, "SMTP_FROM", "") or "").strip() or f"noreply@{host}"
        username = str(getattr(settings, "SMTP_USERNAME", "") or "").strip()
        password = str(getattr(settings, "SMTP_PASSWORD", "") or "")
        use_ssl = bool(getattr(settings, "SMTP_SSL", False))
        starttls = bool(getattr(settings, "SMTP_STARTTLS", True)) and not use_ssl

        msg = EmailMessage()
        msg["From"] = mail_from
        msg["To"] = ", ".join(cleaned)
        msg["Subject"] = str(subject)
        msg.set_content(str(body))

        try:
            if use_ssl:
                client: smtplib.SMTP = smtplib.SMTP_SSL(
                    host,
                    port,
                    timeout=timeout,
                    context=ssl.create_default_context(),
                )
            else:
                client = smtplib.SMTP(host, port, timeout=timeout)
            with client:
                client.ehlo()
                if starttls:
                    client.starttls(context=ssl.create_default_context())
                    client.ehlo()
                if username:
                    client.login(username, password)
                client.send_message(msg)
            return True
        except Exception:
            logger.exception(
                "%s",
                {
                    "stage": "smtp_email_send_failed",
                    "host": host,
                    "port": port,
                    "recipient_count": len(cleaned),
                },
            )
            return False


_default_email_sender: EmailSender = MockEmailSender()


def get_email_sender() -> EmailSender:
    return _default_email_sender


def set_email_sender(sender: EmailSender) -> None:
    global _default_email_sender
    _default_email_sender = sender


def reset_email_sender() -> None:
    global _default_email_sender
    _default_email_sender = MockEmailSender()
