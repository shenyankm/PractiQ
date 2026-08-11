import pytest


@pytest.fixture(autouse=True)
def billing_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv('REVENUECAT_PROJECT_ID', 'proj_test')
    monkeypatch.setenv('REVENUECAT_SECRET_API_KEY', 'sk_test')
    monkeypatch.setenv('REVENUECAT_PRO_ENTITLEMENT_ID', 'entl_test_pro')
    monkeypatch.setenv('REVENUECAT_WEBHOOK_AUTHORIZATION', 'Bearer webhook-test')
    monkeypatch.setenv('LLM_KEY_ENCRYPTION_SECRET', 'test-encryption-secret')
