"""CHRA-2423 Bug 43 — the credential-setup CLI must not echo the EMR password.

`input()` renders the typed password in plaintext on the terminal (shoulder-surf
+ scrollback exposure); `getpass.getpass()` reads it without echo. The CLI is
interactive, so a behavioral test isn't meaningful — this is a source tripwire
that fails if someone reverts the password prompt to input().
"""
import re
from pathlib import Path

SRC = (
    Path(__file__).resolve().parents[1] / "emr_automation" / "credential_manager.py"
).read_text()


def test_password_prompt_uses_getpass_not_input():
    assert "import getpass" in SRC, "getpass must be imported"
    assert re.search(r'getpass\.getpass\(\s*["\']EMR Password', SRC), \
        "the EMR password must be read via getpass.getpass (no terminal echo)"
    assert not re.search(r'input\(\s*["\']EMR Password', SRC), \
        "the EMR password must NOT be read via input() (echoes to the terminal)"
