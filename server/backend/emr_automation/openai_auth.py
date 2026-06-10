"""
Shared OpenAI OAuth helpers.

This project only supports OAuth-style bearer tokens for OpenAI access.
Tokens can be supplied directly or fetched via the client credentials grant.
"""

from __future__ import annotations

import configparser
import os
import threading
import time
from typing import Optional

import requests
from openai import OpenAI

_TOKEN_REFRESH_SKEW_SECONDS = 60
_TOKEN_CACHE_LOCK = threading.Lock()
_TOKEN_CACHE: dict[tuple[str, str, str, str], tuple[str, float]] = {}


def _config_value(
    config: Optional[configparser.ConfigParser],
    option: str,
    env_name: str,
) -> str:
    env_value = os.environ.get(env_name, "").strip()
    if env_value:
        return env_value
    if config is None:
        return ""
    return config.get("OpenAI", option, fallback="").strip()


def _resolve_base_url(config: Optional[configparser.ConfigParser]) -> Optional[str]:
    base_url = _config_value(config, "base_url", "OPENAI_BASE_URL")
    return base_url or None


def _resolve_direct_access_token(config: Optional[configparser.ConfigParser]) -> str:
    # OPENAI_API_KEY is the standard name; OPENAI_OAUTH_ACCESS_TOKEN was the
    # legacy name from the OAuth-first design and is kept as a fallback so
    # callers can migrate at their own pace.
    return (
        _config_value(config, "api_key", "OPENAI_API_KEY")
        or _config_value(config, "oauth_access_token", "OPENAI_OAUTH_ACCESS_TOKEN")
    )


def has_openai_oauth_config(config: Optional[configparser.ConfigParser] = None) -> bool:
    """Return True when enough config exists to create an OpenAI OAuth client."""
    if _resolve_direct_access_token(config):
        return True

    token_url = _config_value(config, "oauth_token_url", "OPENAI_OAUTH_TOKEN_URL")
    client_id = _config_value(config, "oauth_client_id", "OPENAI_OAUTH_CLIENT_ID")
    client_secret = _config_value(
        config,
        "oauth_client_secret",
        "OPENAI_OAUTH_CLIENT_SECRET",
    )
    return all([token_url, client_id, client_secret])


def get_openai_access_token(
    config: Optional[configparser.ConfigParser] = None,
    *,
    session: Optional[requests.sessions.Session] = None,
) -> str:
    """
    Resolve an OpenAI bearer token.

    Resolution order:
    1. Direct access token from env/config
    2. OAuth client credentials flow
    """
    direct_token = _resolve_direct_access_token(config)
    if direct_token:
        return direct_token

    token_url = _config_value(config, "oauth_token_url", "OPENAI_OAUTH_TOKEN_URL")
    client_id = _config_value(config, "oauth_client_id", "OPENAI_OAUTH_CLIENT_ID")
    client_secret = _config_value(
        config,
        "oauth_client_secret",
        "OPENAI_OAUTH_CLIENT_SECRET",
    )
    scopes = _config_value(config, "oauth_scopes", "OPENAI_OAUTH_SCOPES")
    audience = _config_value(config, "oauth_audience", "OPENAI_OAUTH_AUDIENCE")

    if not all([token_url, client_id, client_secret]):
        return ""

    cache_key = (token_url, client_id, scopes, audience)
    now = time.time()

    with _TOKEN_CACHE_LOCK:
        cached = _TOKEN_CACHE.get(cache_key)
        if cached and cached[1] > now + _TOKEN_REFRESH_SKEW_SECONDS:
            return cached[0]

    payload = {"grant_type": "client_credentials"}
    if scopes:
        payload["scope"] = scopes
    if audience:
        payload["audience"] = audience

    http = session or requests
    response = http.post(
        token_url,
        data=payload,
        auth=(client_id, client_secret),
        timeout=15,
    )
    response.raise_for_status()

    token_payload = response.json()
    access_token = (token_payload.get("access_token") or "").strip()
    if not access_token:
        raise RuntimeError("OAuth token response did not include access_token")

    expires_in = int(token_payload.get("expires_in") or 3600)
    expires_at = now + max(expires_in, _TOKEN_REFRESH_SKEW_SECONDS + 1)

    with _TOKEN_CACHE_LOCK:
        _TOKEN_CACHE[cache_key] = (access_token, expires_at)

    return access_token


def build_openai_client(
    config: Optional[configparser.ConfigParser] = None,
    *,
    http_client=None,
) -> Optional[OpenAI]:
    """Create an OpenAI client backed by an OAuth bearer token."""
    access_token = get_openai_access_token(config)
    if not access_token:
        return None

    base_url = _resolve_base_url(config)
    # max_retries=0, timeout=30: convert upstream Whisper stalls (saw a real
    # 89.6s call in phase-001 UAT) into a clean error path the SW can retry
    # via its own AbortSignal.timeout(30000), rather than letting the SDK
    # silently retry and compound the latency.
    kwargs = {"api_key": access_token, "max_retries": 0, "timeout": 30.0}
    if base_url:
        kwargs["base_url"] = base_url
    if http_client is not None:
        kwargs["http_client"] = http_client
    return OpenAI(**kwargs)
