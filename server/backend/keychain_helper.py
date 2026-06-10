"""macOS Keychain secret loader.

Add secrets via Terminal:
  security add-generic-password -a "$USER" -s "emr-password" -w "YOUR_PASSWORD" -U
  security add-generic-password -a "$USER" -s "emr-username" -w "YOUR_USERNAME" -U
  security add-generic-password -a "$USER" -s "openai-api-key-pediatrics" -w "sk-..." -U
  security add-generic-password -a "$USER" -s "telegram-bot-token" -w "123456:ABC..." -U

Verify:
  security find-generic-password -a "$USER" -s "emr-password" -w
"""

import os
import subprocess
from typing import Optional


def keychain_secret(service: str, account: Optional[str] = None) -> str:
    """Load a secret from macOS Keychain.

    Falls back to environment variable for backward compatibility during
    migration. After migration is complete, the env fallback can be removed.
    """
    acct = account or os.environ.get("USER", "")

    # 1. Try Keychain first (with timeout to avoid hangs when keychain is locked)
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", service, "-w"],
            capture_output=True,
            text=True,
            check=True,
            timeout=3,
        )
        return result.stdout.strip()
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        pass

    # 2. Fallback to environment variable (temporary during migration)
    env_map = {
        "emr-password": "EMR_PASSWORD",
        "emr-username": "EMR_USERNAME",
        "openai-api-key-pediatrics": "OPENAI_API_KEY",
        "telegram-bot-token": "TELEGRAM_BOT_TOKEN",
        "pedbot-secret-key": "SECRET_KEY",
        "pedbot-database-url": "DATABASE_URL",
        "pedbot-stripe-secret-key": "STRIPE_SECRET_KEY",
        "pedbot-stripe-webhook-secret": "STRIPE_WEBHOOK_SECRET",
        "pedbot-stripe-pro-price-id": "STRIPE_PRO_PRICE_ID",
        "pedbot-stripe-hospital-price-id": "STRIPE_HOSPITAL_PRICE_ID",
        "pedbot-clerk-secret-key": "CLERK_SECRET_KEY",
    }
    env_var = env_map.get(service)
    if env_var and os.environ.get(env_var):
        return os.environ[env_var]

    raise SystemExit(
        f"Secret '{service}' not found in Keychain and no env fallback.\n"
        f"Add it with:\n"
        f'  security add-generic-password -a "{acct}" -s "{service}" -w "..." -U'
    )
