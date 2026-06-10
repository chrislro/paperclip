"""Backend package for the repo-owned Toca Ficha Dr. cloud API.

The initial repo consolidation keeps the historical ``emr_automation`` package
name so copied routes, tests, and deploy scripts remain mostly mechanical. This
initializer is intentionally light: importing ``emr_automation.auth`` or
``emr_automation.dashboard`` should not pull in desktop automation dependencies.
"""

from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)

from emr_automation._version import __version__  # noqa: E402


def run_dashboard(port: int = 5050) -> None:
    """Run the Flask dashboard/API without starting desktop EMR automation."""
    import os
    from pathlib import Path

    from emr_automation.dashboard import create_app

    host = os.environ.get("DASHBOARD_HOST")
    if not host and Path("/.dockerenv").exists():
        host = "0.0.0.0"
    host = host or "127.0.0.1"

    app = create_app()
    app.run(host=host, port=port, debug=False)


def main() -> None:
    """Backend-safe CLI entry point."""
    run_dashboard()


__all__ = ["__version__", "main", "run_dashboard"]
