"""
Regression tests for the CORS fail-closed boot guard (CHRA-2135).

Before this fix, ``create_app`` fell back to ``CORS_ORIGINS="*"`` whenever the
env var was unset, so any web page could make credentialed Private Network
Access requests to the local API (allow_private_network=True). The dashboard now
refuses to start unless an explicit allow-list is provided.
"""

import logging

import pytest

from emr_automation.dashboard.app import _resolve_cors_origins, create_app


def test_resolve_cors_origins_unset_raises(monkeypatch):
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    with pytest.raises(RuntimeError, match="CORS_ORIGINS must be set"):
        _resolve_cors_origins()


def test_resolve_cors_origins_empty_raises(monkeypatch):
    # An env var present but blank (or only commas/whitespace) is still "unset".
    monkeypatch.setenv("CORS_ORIGINS", "  , ,")
    with pytest.raises(RuntimeError, match="CORS_ORIGINS must be set"):
        _resolve_cors_origins()


def test_resolve_cors_origins_parses_and_strips(monkeypatch):
    monkeypatch.setenv(
        "CORS_ORIGINS",
        "chrome-extension://abc, https://api.tocafichadr.com.br ,",
    )
    assert _resolve_cors_origins() == [
        "chrome-extension://abc",
        "https://api.tocafichadr.com.br",
    ]


def test_resolve_cors_origins_explicit_wildcard_warns(monkeypatch, caplog):
    monkeypatch.setenv("CORS_ORIGINS", "*")
    with caplog.at_level(logging.CRITICAL, logger="emr_automation.dashboard"):
        assert _resolve_cors_origins() == ["*"]
    assert any(
        "wildcard" in r.message and r.levelno == logging.CRITICAL
        for r in caplog.records
    )


def test_create_app_fails_closed_without_cors_origins(monkeypatch):
    # The autouse backend_test_env fixture sets CORS_ORIGINS; remove it so the
    # app factory exercises the fail-closed path end to end.
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    with pytest.raises(RuntimeError, match="CORS_ORIGINS must be set"):
        create_app()
