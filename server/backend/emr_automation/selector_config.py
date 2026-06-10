"""Load and serve DOM selector configurations for different EMR systems.

Supports two backends:
- JSON files in data/selectors/ (Phase 1, always available)
- PostgreSQL via SelectorConfig model (Phase 2, optional)

DB is tried first, then falls back to JSON file.
"""
import json
import os
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

SELECTORS_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "selectors")
_cache = {}


def load_selectors_from_db(emr_name):
    """Try loading selectors from PostgreSQL. Returns None if unavailable."""
    try:
        from emr_automation.database import get_session
        from emr_automation.models import SelectorConfig
        session = get_session()
        config = session.query(SelectorConfig).filter_by(
            emr_name=emr_name, is_active=True
        ).order_by(SelectorConfig.created_at.desc()).first()
        if config:
            return {
                "emr": config.emr_name,
                "version": config.emr_version,
                "selectors": config.selectors,
            }
    except Exception:
        pass  # DB not available — fall through to JSON
    return None


def save_selectors_to_db(emr_name, version, selectors, user_id=None):
    """Save a selector config to PostgreSQL. Returns the new row ID."""
    from emr_automation.database import get_session
    from emr_automation.models import SelectorConfig
    session = get_session()
    config = SelectorConfig(
        emr_name=emr_name,
        emr_version=version,
        selectors=selectors,
        created_by=user_id,
        is_active=True,
    )
    session.add(config)
    session.commit()
    return config.id


def load_selectors(emr_name):
    """Load selector config for an EMR. Tries DB first, then JSON file."""
    if emr_name in _cache:
        return _cache[emr_name]

    # Try DB first (Phase 2)
    db_config = load_selectors_from_db(emr_name)
    if db_config:
        _cache[emr_name] = db_config
        return db_config

    # Fall back to JSON file (Phase 1)
    filepath = os.path.join(SELECTORS_DIR, f"{emr_name}.json")
    if not os.path.exists(filepath):
        logger.warning("No selector config found for EMR: %s", emr_name)
        return None

    with open(filepath, "r", encoding="utf-8") as f:
        config = json.load(f)

    _cache[emr_name] = config
    return config


def get_selector(emr_name, key, default=None):
    """Get a specific selector value from an EMR config."""
    config = load_selectors(emr_name)
    if config is None:
        return default
    return config.get("selectors", {}).get(key, default)


def clear_cache():
    """Clear the selector config cache."""
    _cache.clear()
