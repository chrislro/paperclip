#!/bin/bash
# Run Toca Ficha Dr. Cloud API server
set -e
cd "${TOCAFICHADR_BACKEND_DIR:-/Users/christianoliveira/Dev/tocafichadr-extension/backend}"

# Legacy .env fallback (no longer needed — secrets loaded via keychain_helper.py)
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Activate venv
if [ -d "venv/bin" ]; then
    source venv/bin/activate
elif [ -d "venv 2/bin" ]; then
    source "venv 2/bin/activate"
fi

export FLASK_APP=emr_automation.dashboard.app:create_app
exec python -m flask run --host=0.0.0.0 --port=${PORT:-5050}
