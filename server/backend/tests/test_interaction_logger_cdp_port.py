"""CHRA-2423 Bug 47 — interaction logger must use a FREE CDP port, not hardcoded 9222.

The hardcoded `--remote-debugging-port=9222` (and `connect_over_cdp` on 9222)
silently fails — or, worse, attaches to the WRONG Chrome — when 9222 is already
held. On this Mac Mini the gstack browser-harness runs a headless Chrome on
:9222, so launching the logger while it is up would make connect_over_cdp drive
browser-harness's Chrome instead of the logger's own instance.

The fix scans 9222-9230 for a free port and removes stale Chrome Singleton locks.
Ported from the sibling Pediatrics repo's 79f40d4 (the file had diverged — Bug 44
lives only here — so it was re-derived, not cherry-picked). These are pure helper
functions, so the tests exercise real behaviour; a source guard backs the wiring.
"""
import os
import socket
from pathlib import Path

import pytest

import emr_automation.interaction_logger as il

SRC = Path(il.__file__).read_text()


def test_find_free_cdp_port_skips_a_taken_port():
    # NB: the default range starts at 9222, which on this Mac Mini is genuinely
    # held by the browser-harness Chrome — the very collision this fix prevents —
    # so bind an OS-assigned port instead and scan a window starting on it.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as held:
        held.bind(("127.0.0.1", 0))
        taken = held.getsockname()[1]
        port = il._find_free_cdp_port(start=taken, end=taken + 30)
        assert port != taken, "must not return a port already bound"
        assert taken < port <= taken + 30
        # The returned port must actually be bindable (genuinely free).
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", port))


def test_find_free_cdp_port_raises_when_no_port_free():
    # Bind an OS-assigned free port, then ask for a 1-port range over it — the
    # only candidate is taken, so the scan must raise rather than return it.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as held:
        held.bind(("127.0.0.1", 0))
        taken = held.getsockname()[1]
        with pytest.raises(RuntimeError):
            il._find_free_cdp_port(start=taken, end=taken)


def test_clean_stale_singleton_lock_removed_for_dead_pid(tmp_path):
    lock = tmp_path / "SingletonLock"
    # Chrome's symlink target format is "<host>-<pid>"; 2147480000 is ~certainly dead.
    os.symlink("somehost-2147480000", str(lock))
    il._clean_stale_singleton_locks(tmp_path)
    assert not lock.is_symlink() and not lock.exists(), \
        "a SingletonLock pointing at a dead pid must be removed"


def test_clean_stale_singleton_lock_kept_for_live_pid(tmp_path):
    lock = tmp_path / "SingletonLock"
    os.symlink(f"somehost-{os.getpid()}", str(lock))  # this process is alive
    il._clean_stale_singleton_locks(tmp_path)
    assert lock.is_symlink(), "a lock owned by a LIVE process must NOT be removed"


def test_clean_stale_singleton_lock_noop_when_absent(tmp_path):
    # No lock present — must not raise.
    il._clean_stale_singleton_locks(tmp_path)


def test_launch_uses_dynamic_cdp_url_not_hardcoded_9222():
    # Source guard: the launch path must not reintroduce a hardcoded-9222 attach.
    assert 'connect_over_cdp("http://127.0.0.1:9222")' not in SRC, \
        "connect_over_cdp must use the discovered cdp_url, not hardcoded 9222"
    assert "--remote-debugging-port=9222" not in SRC, \
        "Chrome must launch on the discovered cdp_port, not hardcoded 9222"
    assert "connect_over_cdp(cdp_url)" in SRC, \
        "the CDP attach must use the dynamically discovered cdp_url"
