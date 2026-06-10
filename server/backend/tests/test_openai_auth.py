from unittest.mock import MagicMock

import pytest

from emr_automation.openai_auth import get_openai_access_token


def test_get_openai_access_token_prefers_direct_env_token(monkeypatch):
    monkeypatch.setenv("OPENAI_OAUTH_ACCESS_TOKEN", "direct-token")

    assert get_openai_access_token() == "direct-token"


def test_get_openai_access_token_uses_client_credentials(monkeypatch):
    monkeypatch.delenv("OPENAI_OAUTH_ACCESS_TOKEN", raising=False)
    monkeypatch.setenv("OPENAI_OAUTH_TOKEN_URL", "https://auth.example.com/oauth/token")
    monkeypatch.setenv("OPENAI_OAUTH_CLIENT_ID", "client-id")
    monkeypatch.setenv("OPENAI_OAUTH_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv("OPENAI_OAUTH_SCOPES", "api.read api.write")

    session = MagicMock()
    response = MagicMock()
    response.json.return_value = {
        "access_token": "oauth-token",
        "expires_in": 1800,
    }
    session.post.return_value = response

    token = get_openai_access_token(session=session)

    assert token == "oauth-token"
    session.post.assert_called_once()
    _, kwargs = session.post.call_args
    assert kwargs["data"]["grant_type"] == "client_credentials"
    assert kwargs["data"]["scope"] == "api.read api.write"


def test_get_openai_access_token_returns_empty_when_unconfigured(monkeypatch):
    monkeypatch.delenv("OPENAI_OAUTH_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("OPENAI_OAUTH_TOKEN_URL", raising=False)
    monkeypatch.delenv("OPENAI_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("OPENAI_OAUTH_CLIENT_SECRET", raising=False)

    assert get_openai_access_token() == ""
