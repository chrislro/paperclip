"""Durable idempotency for model-backed endpoints.

Usage:
    from emr_automation.idempotency import idempotent

    @idempotent("transcribe")
    def api_transcribe():
        ...

Client must send X-Operation-Id (UUID v4) in the request header.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from functools import wraps
from typing import Callable, Optional

from flask import request, jsonify, g
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from emr_automation import database as _db_module
from emr_automation.models import IdempotentOperation


def _get_operation_id() -> Optional[str]:
    raw = request.headers.get("X-Operation-Id", "").strip()
    if not raw:
        return None
    try:
        # Validate UUID shape loosely (accepts UUID4 with or without dashes)
        val = uuid.UUID(raw)
        return str(val)
    except (ValueError, TypeError):
        return None


def _get_user_id() -> Optional[int]:
    # Prefer the user_id set by auth middleware on flask.g
    uid = getattr(g, "user_id", None)
    if uid is not None:
        return int(uid) if uid else None
    return None


def idempotent(endpoint_name: str, ttl_hours: int = 24):
    """Decorator that makes a Flask endpoint idempotent.

    If X-Operation-Id is missing, the endpoint runs normally (no idempotency).
    If present and a completed record exists, returns the cached response.
    If present and in_progress, returns 409 with a controlled message.
    Otherwise creates an in_progress record, runs the endpoint, and stores
    the result on success.
    """
    def decorator(fn: Callable):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            op_id = _get_operation_id()
            user_id = _get_user_id()
            if not op_id or not user_id:
                # Idempotency disabled when header or auth is missing
                return fn(*args, **kwargs)

            sess: Session = _db_module.get_session()
            existing = (
                sess.query(IdempotentOperation)
                .filter_by(user_id=user_id, operation_id=op_id)
                .first()
            )

            if existing:
                if existing.status == "completed":
                    try:
                        body = json.loads(existing.response_body) if existing.response_body else {"ok": True}
                    except Exception:
                        body = {"ok": True, "note": "cached"}
                    return jsonify(body), 200
                if existing.status == "in_progress":
                    return jsonify({
                        "ok": False,
                        "error": "Operação já em andamento. Aguarde a conclusão.",
                        "status": "in_progress",
                    }), 409
                if existing.status == "failed":
                    # Allow retry of failed operations by deleting the old record
                    sess.delete(existing)
                    sess.commit()

            # Create in_progress record. The UNIQUE (user_id, operation_id)
            # constraint makes this the ATOMIC gate (Bug 69): if a concurrent
            # request inserted the same row between our SELECT above and this
            # commit, the commit raises IntegrityError — we lost the race. Without
            # this guard both requests would proceed and run the provider call
            # twice (double billing), the exact thing idempotency exists to prevent.
            # Re-query and treat it as the existing-record case (mirrors the webhook
            # path's _acquire_webhook_lock). NB: requires the DB constraint to be
            # present; on a not-yet-migrated production table this is a no-op and
            # the pre-existing narrow race persists until the migration lands.
            record = IdempotentOperation(
                user_id=user_id,
                operation_id=op_id,
                endpoint=endpoint_name,
                status="in_progress",
                expires_at=(datetime.now(timezone.utc) + timedelta(hours=ttl_hours)).replace(tzinfo=None),
            )
            sess.add(record)
            try:
                sess.commit()
            except IntegrityError:
                sess.rollback()
                winner = (
                    sess.query(IdempotentOperation)
                    .filter_by(user_id=user_id, operation_id=op_id)
                    .first()
                )
                if winner and winner.status == "completed":
                    try:
                        body = json.loads(winner.response_body) if winner.response_body else {"ok": True}
                    except Exception:
                        body = {"ok": True, "note": "cached"}
                    return jsonify(body), 200
                # in_progress (or a failed row deleted by another retry mid-race) —
                # tell the client to wait rather than double-running the operation.
                return jsonify({
                    "ok": False,
                    "error": "Operação já em andamento. Aguarde a conclusão.",
                    "status": "in_progress",
                }), 409

            started_at = datetime.now(timezone.utc)
            try:
                response = fn(*args, **kwargs)
                # Normalize response: Flask returns (body, status) tuples or Response objects
                status_code = 200
                if isinstance(response, tuple):
                    resp_obj, status_code = response[0], response[1]
                else:
                    resp_obj = response

                # Extract JSON-serializable body if possible
                body_text = None
                try:
                    if hasattr(resp_obj, "get_json"):
                        body_text = json.dumps(resp_obj.get_json())
                    elif hasattr(resp_obj, "data"):
                        body_text = resp_obj.data.decode("utf-8")
                except Exception:
                    body_text = None

                # An idempotency layer must cache only SUCCESSES. The model-backed
                # routes RETURN error payloads / non-2xx status codes instead of
                # raising (see _is_billable_success; CHRA-2423 Bugs 36-37), so the
                # `except` below never fires for them — they reach here. Caching a
                # TRANSIENT failure (OpenAI timeout → {"error": ...}, a 503, etc.)
                # as "completed" would pin it for the whole TTL: a retry with the
                # same X-Operation-Id would get the cached error forever instead of
                # re-attempting. Mark non-success "failed" so the next retry hits
                # the failed-branch above (delete + re-run).
                try:
                    sc = int(status_code)
                except (TypeError, ValueError):
                    sc = 200
                is_success = 200 <= sc < 300
                if is_success and body_text:
                    try:
                        parsed = json.loads(body_text)
                        if isinstance(parsed, dict) and parsed.get("error"):
                            is_success = False
                    except Exception:
                        pass

                record.duration_ms = int((datetime.now(timezone.utc) - started_at).total_seconds() * 1000)
                record.completed_at = datetime.now(timezone.utc).replace(tzinfo=None)
                if is_success:
                    record.status = "completed"
                    record.response_body = body_text
                else:
                    record.status = "failed"
                    record.error_code = f"http_{sc}"
                sess.commit()
                return response
            except Exception as exc:
                record.status = "failed"
                record.error_code = getattr(exc, "__class__", type(exc)).__name__
                record.duration_ms = int((datetime.now(timezone.utc) - started_at).total_seconds() * 1000)
                record.completed_at = datetime.now(timezone.utc).replace(tzinfo=None)
                sess.commit()
                raise

        return wrapper
    return decorator
