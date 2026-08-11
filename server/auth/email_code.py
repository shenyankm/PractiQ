"""Email verification codes for registration (Redis + SMTP).

Mirrors backend/internal/auth/email_code.go.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
import smtplib

from .. import envelope, redisx
from . import runtime

logger = logging.getLogger('practiq.auth')

EMAIL_CODE_TTL_SECONDS = 600


def _email_code_key(email: str) -> str:
    digest = hashlib.sha256(email.lower().encode()).hexdigest()
    return redisx.redis_key('email-verify', digest)


def _new_email_code() -> str:
    return f'{secrets.randbelow(1_000_000):06d}'


async def send_code(email: str) -> None:
    rdb = redisx.client()
    if rdb is None:
        raise runtime.session_store_unavailable()
    code = _new_email_code()
    try:
        await rdb.set(_email_code_key(email), code, ex=EMAIL_CODE_TTL_SECONDS)
    except Exception as exc:
        raise runtime.session_store_unavailable() from exc
    try:
        deliver_email_code(email, code)
    except Exception as exc:
        raise envelope.new_error(502, 'EMAIL_DELIVERY_FAILED', 'Could not send the verification email') from exc


async def verify_email_code(email: str, code: str) -> None:
    invalid = envelope.validation_error(
        [envelope.ValidationDetail('code', 'Verification code is invalid or expired')]
    )
    if len(code) != 6:
        raise invalid
    rdb = redisx.client()
    if rdb is None:
        raise runtime.session_store_unavailable()
    key = _email_code_key(email)
    stored = await redisx.get_text(rdb, key)
    if stored is None or not hmac.compare_digest(stored, code):
        raise invalid
    try:
        await rdb.delete(key)
    except Exception:
        pass


def deliver_email_code(email: str, code: str) -> None:
    host = os.environ.get('SMTP_HOST', '').strip()
    if not host:
        # Local development fallback only; never leave SMTP_HOST unset in production.
        logger.info('SMTP_HOST is not configured; verification code for %s is %s', email, code)
        return
    port = os.environ.get('SMTP_PORT', '').strip() or '587'
    from_address = os.environ.get('SMTP_FROM', '').strip()
    username = os.environ.get('SMTP_USERNAME', '').strip()
    password = os.environ.get('SMTP_PASSWORD', '')
    message = (
        f'From: {from_address}\r\nTo: {email}\r\nSubject: PractiQ verification code\r\n'
        'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n'
        f'Your PractiQ verification code is {code}. It expires in 10 minutes.\r\n'
    )
    with smtplib.SMTP(host, int(port)) as smtp:
        if username:
            smtp.starttls()
            smtp.login(username, password)
        smtp.sendmail(from_address, [email], message.encode())
