"""Opt-in server-only Alipay configuration; keys never leave this boundary."""
import json
import os
import re
import stat
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[2]
SANDBOX_GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do'
PRODUCTION_GATEWAY = 'https://openapi.alipay.com/gateway.do'


def cents(value: str) -> int:
    if not re.fullmatch(r'[0-9]{1,9}(?:\.[0-9]{1,2})?', value):
        raise ValueError('Invalid decimal payment amount')
    result = int(Decimal(value) * 100)
    if not 1 <= result <= 10_000_000_000:
        raise ValueError('Payment amount is outside supported limits')
    return result


def money(value: int) -> str:
    return f'{value // 100}.{value % 100:02d}'


@dataclass(frozen=True, repr=False)
class PaymentConfig:
    mode: str
    app_id: str
    seller_id: str
    private_key: str
    public_key: str
    base_url: str
    notify_url: str | None
    amount: int
    subject: str

    @property
    def gateway(self) -> str:
        return SANDBOX_GATEWAY if self.mode == 'sandbox' else PRODUCTION_GATEWAY

    @property
    def return_url(self) -> str:
        return self.base_url + '/payments/return'


def load() -> PaymentConfig:
    if os.environ.get('ALIPAY_ENABLED') != 'true':
        raise HTTPException(503, {'code': 'PAYMENTS_DISABLED'})
    try:
        mode = os.environ.get('ALIPAY_MODE', 'sandbox')
        if mode not in {'sandbox', 'production'}:
            raise ValueError('Invalid mode')
        # Production has an explicit protected file, never a fallback to sandbox keys.
        path = ROOT / '.alipay-sandbox.json' if mode == 'sandbox' else Path(os.environ['ALIPAY_PRODUCTION_CONFIG'])
        if not path.is_absolute() or path.is_symlink():
            raise ValueError('Configuration must be an absolute regular file')
        with path.open('r', encoding='utf-8') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 128 * 1024:
                raise ValueError('Configuration protection is invalid')
            app = json.load(stream)['appIds'][0]
        fields = [app[key] for key in ('appId', 'pid', 'appPrivatePkcsKey', 'alipayPublicKey')]
        if any(not isinstance(value, str) or not value or value != value.strip() for value in fields):
            raise ValueError('Configuration fields are invalid')
        if not all(re.fullmatch(r'[0-9]{16}', value) for value in fields[:2]):
            raise ValueError('Invalid application or seller identifier')
        if any(not re.fullmatch(r'[A-Za-z0-9+/=]+', value) for value in fields[2:]):
            raise ValueError('Use the original SDK key fields without PEM wrapping')
        base = os.environ.get('ALIPAY_BASE_URL', 'http://127.0.0.1:8090' if mode == 'sandbox' else '').rstrip('/')
        url = urlsplit(base)
        if url.username or url.password or url.query or url.fragment or url.path or not url.hostname:
            raise ValueError('Invalid public origin')
        if url.scheme != 'https' and not (mode == 'sandbox' and url.scheme == 'http' and url.hostname in {'127.0.0.1', 'localhost', '::1'}):
            raise ValueError('HTTPS is required')
        notify = os.environ.get('ALIPAY_NOTIFY_URL') or None
        if notify and notify != base + '/payments/notify':
            raise ValueError('Notify URL must be the deployed HTTPS notification route')
        if notify and url.scheme != 'https':
            raise ValueError('Notify URL requires HTTPS')
        amount = cents(os.environ.get('ALIPAY_AMOUNT', '0.01' if mode == 'sandbox' else ''))
        subject = os.environ.get('ALIPAY_SUBJECT', 'PractiQ 沙箱收款' if mode == 'sandbox' else '')
        if not 1 <= len(subject) <= 128 or any(ord(char) < 32 for char in subject):
            raise ValueError('Invalid payment subject')
        return PaymentConfig(mode, fields[0], fields[1], fields[2], fields[3], base, notify, amount, subject)
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        # JSON/key exceptions may contain secret values: never expose or log them.
        raise HTTPException(503, {'code': 'PAYMENT_CONFIGURATION_INVALID'}) from None
