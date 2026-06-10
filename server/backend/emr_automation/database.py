"""PostgreSQL / SQLite database connection and session management."""
import os
import logging
from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, scoped_session, declarative_base
from keychain_helper import keychain_secret

logger = logging.getLogger(__name__)

Base = declarative_base()
_engine = None
_session_factory = None


def get_engine(db_url=None):
    """Create or return cached SQLAlchemy engine."""
    global _engine
    if _engine is not None:
        return _engine

    if db_url:
        url = db_url
    else:
        try:
            url = keychain_secret("pedbot-database-url")
        except SystemExit:
            default_db = Path(__file__).resolve().parent.parent / "data" / "tocafichadr.db"
            url = os.environ.get("DATABASE_URL", f"sqlite:///{default_db}")
    _engine = create_engine(url, echo=False)
    logger.info("Database engine created: %s", url.split("@")[-1] if "@" in url else url)
    return _engine


def get_session():
    """Return a scoped session."""
    global _session_factory
    if _session_factory is None:
        _session_factory = scoped_session(sessionmaker(bind=get_engine()))
    return _session_factory()


def remove_session():
    """Remove the current scoped session and return its connection to the pool."""
    if _session_factory:
        _session_factory.remove()


def init_db(engine=None):
    """Create all tables."""
    eng = engine or get_engine()
    Base.metadata.create_all(eng)
    logger.info("Database tables created")


def reset_engine():
    """Reset engine and session factory (for testing)."""
    global _engine, _session_factory
    if _session_factory:
        _session_factory.remove()
    _engine = None
    _session_factory = None
