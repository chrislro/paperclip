#!/usr/bin/env python3
"""Initialize the Toca Ficha Dr. cloud database (PostgreSQL).

Usage:
    # Set DATABASE_URL first:
    export DATABASE_URL="postgresql://tocafichadr:PASSWORD@localhost:5432/tocafichadr"
    python scripts/init_cloud_db.py

    # Or for local SQLite (default):
    python scripts/init_cloud_db.py
"""
import sys
import os

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from emr_automation.database import get_engine, init_db, get_session
from emr_automation.models import User

def main():
    print(f"Database URL: {os.environ.get('DATABASE_URL', 'sqlite:///data/tocafichadr.db')}")

    # Create all tables
    init_db()
    print("Tables created successfully.")

    # Check if admin user exists
    session = get_session()
    admin = session.query(User).filter_by(email="christian@tocafichadr.com.br").first()
    if not admin:
        print("Creating admin user...")
        admin = User(
            email="christian@tocafichadr.com.br",
            name="Christian",
            plan="pro",  # Owner gets Pro
        )
        admin.set_password(os.environ.get("ADMIN_PASSWORD", "changeme"))
        session.add(admin)
        session.commit()
        print(f"Admin user created (id={admin.id})")
    else:
        print(f"Admin user already exists (id={admin.id})")

if __name__ == "__main__":
    main()
