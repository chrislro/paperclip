"""Cloud backend test defaults.

These tests should never need production Keychain entries, real OpenAI tokens,
or local PHI-bearing SQLite files.
"""

import sys
import types

import pytest


try:
    import svix.webhooks  # noqa: F401
except ImportError:
    svix_module = types.ModuleType("svix")
    webhooks_module = types.ModuleType("svix.webhooks")

    class Webhook:  # pragma: no cover - patched by tests
        def __init__(self, *args, **kwargs):
            pass

        def verify(self, *args, **kwargs):
            raise RuntimeError("svix Webhook test stub was not patched")

    class WebhookVerificationError(Exception):
        pass

    webhooks_module.Webhook = Webhook
    webhooks_module.WebhookVerificationError = WebhookVerificationError
    svix_module.webhooks = webhooks_module
    sys.modules.setdefault("svix", svix_module)
    sys.modules.setdefault("svix.webhooks", webhooks_module)


@pytest.fixture(autouse=True)
def backend_test_env(monkeypatch, tmp_path):
    # Strip any real secrets the developer's shell / .env injected. The fixture
    # docstring promises "never need production Keychain entries or real OpenAI
    # tokens" but without these delenv calls a developer with OPENAI_API_KEY
    # exported (or .env loaded via emr_automation.__init__) sees ~13 tests fail
    # because the real key leaks through monkeypatch.setenv calls below.
    for var in (
        "OPENAI_API_KEY",
        "OPENAI_OAUTH_ACCESS_TOKEN",
        "OPENAI_OAUTH_CLIENT_ID",
        "OPENAI_OAUTH_CLIENT_SECRET",
        "OPENAI_OAUTH_TOKEN_URL",
        "OPENAI_OAUTH_AUDIENCE",
        "GROQ_API_KEY",
    ):
        monkeypatch.delenv(var, raising=False)

    monkeypatch.setenv("ALLOW_MISSING_OPENAI", "1")
    monkeypatch.setenv("SECRET_KEY", "test-secret")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'tocafichadr-test.db'}")
    # create_app() now fails closed when CORS_ORIGINS is unset (CHRA-2135); give the
    # test app an explicit, non-wildcard allow-list. Tests that exercise the
    # fail-closed behaviour itself delenv this inside the test.
    monkeypatch.setenv("CORS_ORIGINS", "chrome-extension://testextensionid")
    # Tests pre-date Bearer auth enforcement (CSO-001). Without this,
    # routes like /api/suggest-cid return 401 for unauthenticated test
    # clients and the test asserts on the mocked response shape instead.
    monkeypatch.delenv("TOCAFICHADR_AUTH_REQUIRED", raising=False)

    from emr_automation.database import reset_engine

    reset_engine()
    yield
    reset_engine()
