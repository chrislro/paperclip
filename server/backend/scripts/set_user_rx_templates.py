#!/usr/bin/env python3
"""Reset one user's Receita shortcuts to the current DEFAULT_RX_TEMPLATES."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from emr_automation.constants import DEFAULT_RX_TEMPLATES
from emr_automation.database import get_session, init_db
from emr_automation.models import User, UserConfig


def _copy_defaults():
    return json.loads(json.dumps(DEFAULT_RX_TEMPLATES))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True, help="User email to update")
    args = parser.parse_args()
    email = args.email.strip().lower()
    if not email:
        print("empty email", file=sys.stderr)
        return 2

    init_db()
    session = get_session()
    try:
        user = session.query(User).filter(User.email == email).first()
        if not user:
            print(f"user not found: {email}", file=sys.stderr)
            return 1

        cfg = session.query(UserConfig).filter_by(user_id=user.id).first()
        if cfg is None:
            cfg = UserConfig(user_id=user.id)
            session.add(cfg)

        cfg.rx_templates = _copy_defaults()
        session.commit()
        print(f"updated rx_templates for {email}: {len(cfg.rx_templates)} templates")
        return 0
    except Exception as exc:
        session.rollback()
        print(f"failed to update {email}: {exc}", file=sys.stderr)
        return 1
    finally:
        session.close()


if __name__ == "__main__":
    raise SystemExit(main())
