# ADR 0002: Request-Scoped Database Session Cleanup

Status: Accepted

Date: 2026-05-08

## Context

The backend uses SQLAlchemy `scoped_session` through
`backend/emr_automation/database.py`. Auth, billing, idempotency, and webhook
helpers open sessions internally. Without an app-level teardown hook, repeated
requests can hold connections until the SQLAlchemy pool is exhausted.

Observed production symptom:

```text
QueuePool limit of size 5 overflow 10 reached, connection timed out
```

User-facing symptom:

```text
Servidor nao respondeu. Tente novamente.
```

The actual transcription endpoint could still work, but popup billing/auth calls
to `/billing/subscription` timed out and made the extension look offline.

## Decision

Add `remove_session()` to `database.py` and register a Flask
`teardown_appcontext` handler in `dashboard/app.py`:

```python
@app.teardown_appcontext
def _remove_db_session(_exception=None):
    remove_session()
```

This returns request-scoped DB connections to the pool after every request,
including error paths.

## Consequences

- Request handlers can continue to use helper functions that call
  `get_session()`.
- The running backend process must be restarted after deploy to clear any
  already-exhausted pool.
- Tests that monkeypatch `get_session()` remain valid because teardown removal is
  no-op when no global session factory exists.

## Verification

Local focused loop:

```bash
ALLOW_MISSING_OPENAI=1 \
SECRET_KEY=test-secret \
DATABASE_URL=sqlite:////tmp/tocafichadr-loop.db \
python3 - <<'PY'
from unittest.mock import MagicMock, patch
from emr_automation import auth as auth_module
from emr_automation.dashboard.app import create_app

app = create_app()
app.config['TESTING'] = True
state = MagicMock()
state.is_signed_in = True
state.payload = {'sub': 'user_loop_001', 'email': 'loop@test.local'}
mock_clerk = MagicMock()
mock_clerk.authenticate_request.return_value = state
with patch.object(auth_module, '_get_clerk_client', return_value=mock_clerk):
    client = app.test_client()
    for i in range(30):
        r = client.get('/billing/subscription', headers={'Authorization': 'Bearer token'})
        assert r.status_code == 200, (i, r.status_code, r.get_data(as_text=True))
print('30 subscription requests OK')
PY
```

Full backend gate:

```bash
ALLOW_MISSING_OPENAI=1 \
SECRET_KEY=test-secret \
DATABASE_URL=sqlite:////tmp/tocafichadr-test.db \
python3 -m pytest -q
```

Production smoke after deploy:

```bash
ssh mac-mini launchctl kickstart -k gui/501/com.tocafichadr.cloud-api
curl -sS -w '\nHTTP %{http_code} total=%{time_total}s\n' \
  https://api.tocafichadr.com.br/api/health
curl -sS -w '\nHTTP %{http_code} total=%{time_total}s\n' \
  https://api.tocafichadr.com.br/billing/subscription
```

Expected without auth: `/billing/subscription` returns `401` quickly, not a
timeout.
