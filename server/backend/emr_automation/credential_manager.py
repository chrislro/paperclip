"""
Secure credential management using macOS Keychain.

Replaces plaintext password storage in config.ini with OS-level
secure storage via the `keyring` library.

Priority chain: Environment variables > config.ini > Keychain fallback
"""

import getpass
import logging
import os
import sys
from typing import Optional, Tuple

logger = logging.getLogger("emr_automation.credentials")

SERVICE_NAME = "emr-automation"
USERNAME_KEY = "emr_username"
PASSWORD_KEY = "emr_password"

# Check if keyring is available
try:
    import keyring
    KEYRING_AVAILABLE = True
except ImportError:
    keyring = None  # type: ignore
    KEYRING_AVAILABLE = False


class CredentialManager:
    """
    Manages EMR credentials with secure storage.

    Priority:
        1. Environment variables (EMR_USERNAME, EMR_PASSWORD)
        2. config.ini fallback
        3. macOS Keychain (via keyring library, fallback)

    Usage:
        cm = CredentialManager()
        cm.store_credentials("user@email.com", "password123")
        username, password = cm.get_credentials()
    """

    def __init__(self, service_name: str = SERVICE_NAME):
        self._service = service_name

    def store_credentials(self, username: str, password: str) -> bool:
        """
        Store credentials in the macOS Keychain.

        Returns:
            True if stored successfully, False if keyring unavailable.
        """
        if not KEYRING_AVAILABLE:
            logger.warning("keyring not installed. Cannot store in Keychain.")
            return False

        try:
            keyring.set_password(self._service, USERNAME_KEY, username)
            keyring.set_password(self._service, PASSWORD_KEY, password)
            logger.info("Credentials stored in macOS Keychain.")
            return True
        except Exception as e:
            logger.error(f"Failed to store credentials in Keychain: {e}")
            return False

    def get_credentials(
        self,
        config=None,
    ) -> Tuple[str, str]:
        """
        Retrieve credentials using the priority chain.

        Args:
            config: Optional ConfigParser instance for config.ini fallback.

        Returns:
            (username, password) tuple. Empty strings if not found.
        """
        username, password = "", ""

        # 1. Try environment variables first.
        # Keychain backend discovery can block on some macOS/Python setups.
        # Using env vars first keeps startup responsive when .env is configured.
        env_user = os.environ.get("EMR_USERNAME", "").strip()
        env_pass = os.environ.get("EMR_PASSWORD", "").strip()
        if env_user and env_pass:
            logger.debug("Credentials loaded from environment variables.")
            return env_user, env_pass

        # 2. Fall back to config.ini
        if config is not None:
            cfg_user = config.get("EMR", "username", fallback="").strip()
            cfg_pass = config.get("EMR", "password", fallback="").strip()
            if cfg_user and cfg_pass:
                logger.debug("Credentials loaded from config.ini (not recommended).")
                return cfg_user, cfg_pass

        # 3. Try Keychain last.
        if KEYRING_AVAILABLE:
            try:
                kc_user = keyring.get_password(self._service, USERNAME_KEY)
                kc_pass = keyring.get_password(self._service, PASSWORD_KEY)
                if kc_user and kc_pass:
                    logger.debug("Credentials loaded from macOS Keychain.")
                    return kc_user, kc_pass
            except Exception as e:
                logger.debug(f"Keychain read failed: {e}")

        return username, password

    def has_credentials(self) -> bool:
        """Check if credentials exist in the Keychain."""
        if not KEYRING_AVAILABLE:
            return False
        try:
            user = keyring.get_password(self._service, USERNAME_KEY)
            pwd = keyring.get_password(self._service, PASSWORD_KEY)
            return bool(user and pwd)
        except Exception:
            return False

    def delete_credentials(self) -> bool:
        """Remove credentials from the Keychain."""
        if not KEYRING_AVAILABLE:
            return False
        try:
            keyring.delete_password(self._service, USERNAME_KEY)
            keyring.delete_password(self._service, PASSWORD_KEY)
            logger.info("Credentials removed from macOS Keychain.")
            return True
        except Exception as e:
            logger.error(f"Failed to delete credentials: {e}")
            return False

    def migrate_from_config(self, config) -> bool:
        """
        Migrate credentials from config.ini to Keychain.

        If config.ini has credentials, move them to Keychain and
        clear them from the config file.

        Returns:
            True if migration happened, False otherwise.
        """
        if not KEYRING_AVAILABLE:
            return False

        cfg_user = config.get("EMR", "username", fallback="").strip()
        cfg_pass = config.get("EMR", "password", fallback="").strip()

        if not (cfg_user and cfg_pass):
            return False

        if self.has_credentials():
            logger.info("Keychain already has credentials, skipping migration.")
            return False

        if self.store_credentials(cfg_user, cfg_pass):
            # Clear from config (in memory — caller should save the file)
            config.set("EMR", "username", "")
            config.set("EMR", "password", "")
            logger.info(
                "Credentials migrated from config.ini to Keychain. "
                "config.ini credentials cleared (save file to persist)."
            )
            return True
        return False


# Convenience: global instance
_manager: Optional[CredentialManager] = None


def get_credential_manager() -> CredentialManager:
    """Get or create the global CredentialManager."""
    global _manager
    if _manager is None:
        _manager = CredentialManager()
    return _manager


# CLI entrypoint for initial credential setup
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="EMR Credential Manager")
    parser.add_argument("--store", action="store_true", help="Store credentials in Keychain")
    parser.add_argument("--check", action="store_true", help="Check if credentials exist")
    parser.add_argument("--delete", action="store_true", help="Delete credentials from Keychain")
    args = parser.parse_args()

    cm = CredentialManager()

    if args.store:
        if not KEYRING_AVAILABLE:
            print("Error: keyring not installed. Run: pip install keyring")
            sys.exit(1)
        username = input("EMR Username (email): ").strip()
        # getpass: never echo the password to the terminal (shoulder-surf /
        # scrollback). input() would render it in plaintext as typed.
        password = getpass.getpass("EMR Password: ").strip()
        if cm.store_credentials(username, password):
            print("Credentials stored in macOS Keychain.")
        else:
            print("Failed to store credentials.")
            sys.exit(1)

    elif args.check:
        if cm.has_credentials():
            print("Credentials found in Keychain.")
        else:
            print("No credentials in Keychain.")

    elif args.delete:
        if cm.delete_credentials():
            print("Credentials deleted from Keychain.")
        else:
            print("Failed to delete credentials (or none found).")

    else:
        parser.print_help()
