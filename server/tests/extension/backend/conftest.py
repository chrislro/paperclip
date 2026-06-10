"""conftest for backend integration tests.

Adds the backend/ package directory to sys.path so that
`import emr_automation` resolves to backend/emr_automation without
needing to install the package or set PYTHONPATH manually.
"""
import sys
import os

# backend/ lives at the repo root, three levels above this file
_backend_dir = os.path.join(os.path.dirname(__file__), "..", "..", "..", "backend")
_backend_dir = os.path.normpath(_backend_dir)

if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)
