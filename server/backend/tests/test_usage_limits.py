from io import BytesIO
from unittest.mock import MagicMock, patch

import pytest

from emr_automation import auth as auth_module
import emr_automation.dashboard.routes as routes


@pytest.fixture
def app(monkeypatch):
    auth_module._CLERK_CLIENT = None
    auth_module._CLERK_IMPORT_FAILED = False
    routes._rate_limit_hits.clear()
    from emr_automation.dashboard.app import create_app

    application = create_app()
    application.config["TESTING"] = True
    yield application
    routes._rate_limit_hits.clear()


@pytest.fixture
def client(app):
    return app.test_client()


def _mock_signed_in_clerk():
    state = MagicMock()
    state.is_signed_in = True
    state.payload = {"sub": "user_limit_001", "email": "limit@test.local"}
    mock_clerk = MagicMock()
    mock_clerk.authenticate_request.return_value = state
    return patch.object(auth_module, "_get_clerk_client", return_value=mock_clerk)


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/api/suggest-cid", {"soap_text": "S: tosse"}),
        ("/api/format-soap", {"raw_text": "tosse e febre"}),
        (
            "/api/format-atestado-letter",
            {"doctor_intent": "Orientar repouso.", "patient_name": "Teste"},
        ),
        ("/api/soap-stream", {"raw_text": "tosse e febre"}),
    ],
)
def test_billable_endpoints_reject_over_limit_before_provider(client, path, body):
    with _mock_signed_in_clerk(), \
            patch("emr_automation.dashboard.routes.check_usage_limit", return_value=False), \
            patch("emr_automation.dashboard.routes._get_openai_client") as provider:
        response = client.post(path, json=body, headers={"Authorization": "Bearer valid"})

    assert response.status_code == 429
    assert response.get_json()["code"] == "USAGE_LIMIT"
    provider.assert_not_called()


def test_audio_upload_size_cap_runs_before_provider(client, monkeypatch):
    monkeypatch.setenv("EXTENSION_API_KEY", "test-extension-key")
    monkeypatch.setattr(routes, "_MAX_AUDIO_BYTES", 128)

    with patch("emr_automation.dashboard.routes._get_openai_client") as provider:
        response = client.post(
            "/api/transcribe",
            data={"audio": (BytesIO(b"x" * 200), "recording.webm")},
            headers={"Authorization": "Bearer test-extension-key"},
            content_type="multipart/form-data",
        )

    assert response.status_code == 413
    assert response.get_json()["code"] == "UPLOAD_TOO_LARGE"
    provider.assert_not_called()


def test_simple_rate_limit_uses_extension_or_ip_key(client, monkeypatch):
    monkeypatch.setenv("EXTENSION_API_KEY", "rate-key")
    monkeypatch.setattr(routes, "_RATE_LIMIT_MAX", 1)
    monkeypatch.setattr(routes, "_RATE_LIMIT_WINDOW_SECONDS", 60)
    routes._rate_limit_hits.clear()

    headers = {"Authorization": "Bearer rate-key"}
    first = client.post("/api/transcribe", data={}, headers=headers)
    second = client.post("/api/transcribe", data={}, headers=headers)

    assert first.status_code == 400
    assert second.status_code == 429
    assert second.get_json()["code"] == "RATE_LIMIT"
