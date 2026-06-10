#!/usr/bin/env python3
"""Launch the EMR Automation web dashboard."""

import os
from pathlib import Path

from emr_automation.dashboard import create_app

if __name__ == "__main__":
    app = create_app()
    host = os.environ.get("DASHBOARD_HOST")
    if not host and Path("/.dockerenv").exists():
        host = "0.0.0.0"
    # Default to "::" (dual-stack IPv6) so the server accepts both ::1 and
    # 127.0.0.1 connections. On macOS, "localhost" resolves to ::1 first and
    # Chrome's fetch() does not fall back to IPv4, causing "Failed to fetch".
    host = host or "::"

    display_host = "localhost" if host in ("0.0.0.0", "::") else host
    print(f"Dashboard running at http://{display_host}:5050")
    app.run(host=host, port=5050, debug=False)
