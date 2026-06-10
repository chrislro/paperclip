"""
Core EMR Automation class.

Contains the main EMRAutomation class with WebDriver setup, login,
session management, and patient info extraction.

Supports both Selenium and Playwright backends via configuration.
"""

import os
import re
import sys
import time
import threading
import configparser
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Optional, Tuple, Union

from keychain_helper import keychain_secret

# Keep browser dependencies lazy-loaded to avoid startup stalls at module import.
ChromeOptions = Any  # type: ignore
ChromeWebDriver = Any  # type: ignore
By = None  # type: ignore
Keys = None  # type: ignore
WebElement = Any  # type: ignore
WebDriverWait = None  # type: ignore
EC = None  # type: ignore
Service = None  # type: ignore
TimeoutException = Exception  # type: ignore
NoSuchElementException = Exception  # type: ignore
StaleElementReferenceException = Exception  # type: ignore
WebDriverException = Exception  # type: ignore
InvalidSessionIdException = Exception  # type: ignore
SELENIUM_AVAILABLE = False

Page = Any  # type: ignore
Browser = Any  # type: ignore
BrowserContext = Any  # type: ignore

from emr_automation.constants import (
    VERSION,
    Timeouts,
    SleepDurations,
    PrescriptionTemplate,
    Locators,
    PlaywrightLocators,
    URLPatterns,
    DEFAULT_CONFIG,
    get_locators,
)
from emr_automation.exceptions import (
    AccountLockedError,
    BadCredentialsError,
    ConfigurationError,
    SessionLostError,
    LoginError,
    PatientNotFoundError,
)
from emr_automation.utils import setup_logging, retry, timed, switch_to_iframe
from emr_automation.credential_manager import get_credential_manager
from emr_automation.openai_auth import build_openai_client, has_openai_oauth_config
from emr_automation.prescription import PrescriptionMixin
from emr_automation.discharge import DischargeMixin
from emr_automation.audio import AudioMixin
from emr_automation.openai_integration import OpenAIMixin


class EMRAutomation(PrescriptionMixin, DischargeMixin, AudioMixin, OpenAIMixin):
    """
    Main class for EMR automation handling all interactions with the EMR system.

    This class provides automated workflows for pediatric consultations including:
    - Browser automation with Selenium WebDriver
    - Patient data extraction (weight, chief complaint)
    - Prescription template processing
    - Discharge automation
    - Audio-to-SOAP transcription
    - AI clinical suggestions via OpenAI

    Examples:
        Basic usage with context manager (recommended):
            >>> with EMRAutomation() as emr:
            ...     emr.login()
            ...     emr.wait_for_atendimento()
            ...     weight = emr.extract_patient_weight()
            ...     print(f"Patient weight: {weight}kg")

        Manual usage:
            >>> emr = EMRAutomation()
            >>> emr.setup_driver()
            >>> emr.login()
            >>> emr.handle_gastroenteritis("12345", template_num=1)
            >>> emr.driver.quit()

        Check version:
            >>> from emr_automation import __version__
            >>> print(__version__)
            2.1.1
    """

    VERSION = VERSION
    
    # Timeouts (for backward compatibility)
    ATENDIMENTO_MAX_WAIT_SECONDS = Timeouts.ATENDIMENTO_MAX_WAIT
    MANUAL_LOGIN_DEFAULT_TIMEOUT = Timeouts.MANUAL_LOGIN_DEFAULT
    DEFAULT_TIMEOUT = Timeouts.DEFAULT
    PRESCRIPTION_WAIT_TIMEOUT = Timeouts.PRESCRIPTION_WAIT
    
    # Sleep durations (for backward compatibility)
    PAGE_LOAD_DELAY = SleepDurations.PAGE_LOAD
    FORM_SUBMIT_DELAY = SleepDurations.FORM_SUBMIT
    BUTTON_CLICK_DELAY = SleepDurations.BUTTON_CLICK
    SCROLL_ANIMATION_DELAY = SleepDurations.SCROLL_ANIMATION
    PRINT_DIALOG_DELAY = SleepDurations.PRINT_DIALOG
    SUBPROCESS_STARTUP_DELAY = SleepDurations.SUBPROCESS_STARTUP
    CLIPBOARD_POLL_INTERVAL = SleepDurations.CLIPBOARD_POLL
    ATENDIMENTO_POLL_INTERVAL = SleepDurations.ATENDIMENTO_POLL

    def __init__(self, config: Optional[configparser.ConfigParser] = None, headless: Optional[bool] = None):
        """Initialize the EMR automation with configuration and logging."""
        self.logger = setup_logging()
        self.logger.info("Initializing EMR Automation v%s", self.VERSION)

        # Load configuration
        self.config = config if config is not None else self.load_config()

        # Apply headless override if provided
        if headless is not None:
            if not self.config.has_section('Browser'):
                self.config.add_section('Browser')
            self.config.set('Browser', 'headless', str(headless))

        # Validate configuration
        if not self.validate_config():
            raise ConfigurationError(
                "Invalid configuration. Please check your config.ini and environment variables."
            )

        # Initialize variables
        self.driver = None
        self.intern_id: Optional[str] = None
        self.weight: Optional[float] = None
        self.chief_complaint: Optional[str] = None
        self.patient_name: Optional[str] = None
        self.patient_age: Optional[str] = None
        self.gui = None
        self.last_audio_error: Optional[str] = None
        # Optional callback: called with patient dict when intern_id changes.
        # Avoids a circular import — dashboard wires this up after instantiation.
        self.on_patient_changed: Optional[Callable[[dict], None]] = None
        self.audio_to_note_script = self._resolve_audio_to_note_script()
        self.audio_proc = None
        self._session_invalidated = False
        self._session_lock = threading.RLock()
        # Prevent overlapping EMR operations across hotkeys + dashboard actions.
        # This is a best-effort safety mechanism since the underlying browser
        # session is not designed for concurrent workflows.
        self._operation_lock = threading.Lock()

        # Browser backend tracking
        self._backend: Optional[str] = None  # "selenium" or "playwright"
        self._locators = Locators  # Default to Selenium locators
        self._playwright_instance = None
        self._browser = None
        self._context = None

        # Lazy-loaded OpenAI client
        self._openai_client = None
        self._openai_client_initialized = False

        # Check printer setup
        self.check_printer_setup()

    def __enter__(self):
        """Context manager entry - sets up the driver."""
        self.setup_driver()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit - cleans up the browser resources."""
        self._cleanup_browser()
        return False

    def _cleanup_browser(self) -> None:
        """Clean up browser resources for both Selenium and Playwright backends."""
        if self._backend == "playwright":
            # Playwright cleanup
            try:
                if self.driver:  # This is the Page in Playwright
                    self.driver.close()
            except Exception as e:
                self.logger.warning(f"Error closing Playwright page: {e}")

            try:
                if self._context:
                    self._context.close()
            except Exception as e:
                self.logger.warning(f"Error closing Playwright context: {e}")

            try:
                if self._browser:
                    self._browser.close()
            except Exception as e:
                self.logger.warning(f"Error closing Playwright browser: {e}")

            try:
                if self._playwright_instance:
                    self._playwright_instance.stop()
            except Exception as e:
                self.logger.warning(f"Error stopping Playwright: {e}")

        elif self.driver:
            # Selenium cleanup
            try:
                self.driver.quit()
            except Exception as e:
                self.logger.warning(f"Error closing Selenium driver: {e}")

        self.driver = None
        self._context = None
        self._browser = None
        self._playwright_instance = None

    @property
    def openai_client(self) -> Optional["OpenAI"]:
        """Lazy-load OpenAI client on first access."""
        if not self._openai_client_initialized:
            self._openai_client = self._init_openai_client()
            self._openai_client_initialized = True
        return self._openai_client

    def _init_openai_client(self) -> Optional["OpenAI"]:
        """
        Initialize the OpenAI client using OAuth config from env/config.ini.
        Returns None when OAuth configuration is missing.
        """
        from openai import OpenAI
        
        api_key = (
            keychain_secret("openai-api-key-pediatrics")
            or self.config.get('OpenAI', 'api_key', fallback='').strip()
        )
        if not api_key and not has_openai_oauth_config(self.config):
            self.logger.warning(
                "OpenAI API key not configured. Add to Keychain (openai-api-key-pediatrics) or configure OAuth in config.ini."
            )
            return None
        try:
            return build_openai_client(self.config)
        except Exception as exc:
            self.logger.error("Failed to initialize OpenAI client: %s", exc)
            return None

    def load_config(self) -> configparser.ConfigParser:
        """
        Load configuration from config.ini file or create with defaults if not exists.

        Returns:
            ConfigParser: Configuration object
        """
        config = configparser.ConfigParser()
        env_username = keychain_secret("emr-username")
        env_password = keychain_secret("emr-password")

        config_path = Path('config.ini')

        if config_path.exists():
            config.read(config_path)
            self.logger.info("Configuration loaded from config.ini")

            # Add any missing default sections/options
            updated = False
            for section, options in DEFAULT_CONFIG.items():
                if not config.has_section(section):
                    config.add_section(section)
                    updated = True
                for key, value in options.items():
                    if not config.has_option(section, key):
                        config.set(section, key, value)
                        updated = True
            if updated:
                with config_path.open('w') as configfile:
                    config.write(configfile)
                self.logger.info("Configuration updated with missing default values")
        else:
            # Create default config
            for section, options in DEFAULT_CONFIG.items():
                config[section] = options

            with config_path.open('w') as configfile:
                config.write(configfile)
            self.logger.info("Default configuration created in config.ini")

        # Warn if credentials are missing
        if not (env_username and env_password) and (
            not config.get('EMR', 'username', fallback='').strip()
            or not config.get('EMR', 'password', fallback='').strip()
        ):
            self.logger.warning(
                "EMR credentials not configured. Set EMR_USERNAME/EMR_PASSWORD environment variables "
                "or fill them in config.ini (file is not recommended for storing secrets)."
            )

        return config

    def validate_config(self) -> bool:
        """
        Validate configuration before use.

        Returns:
            bool: True if configuration is valid, False otherwise
        """
        errors = []
        warnings = []

        # Check EMR credentials (from env or config)
        username, password = self._get_credentials()
        if not username:
            errors.append("EMR username not configured. Set EMR_USERNAME environment variable or update config.ini")
        if not password:
            errors.append("EMR password not configured. Set EMR_PASSWORD environment variable or update config.ini")

        # Check EMR base URL
        base_url = self.config.get('EMR', 'base_url', fallback='').strip()
        if not base_url:
            errors.append("EMR base_url not configured in config.ini")
        elif not (base_url.startswith('http://') or base_url.startswith('https://')):
            errors.append(f"EMR base_url must start with http:// or https:// (got: {base_url})")

        # Check browser timeout (must be between 1 and 600 seconds)
        try:
            timeout = int(self.config.get('Browser', 'timeout', fallback='30'))
            if timeout <= 0:
                errors.append("Browser timeout must be greater than 0")
            elif timeout > 600:
                warnings.append(f"Browser timeout of {timeout}s is very high. Consider using 30-120s.")
        except ValueError:
            errors.append("Browser timeout must be a valid integer")

        # Check OpenAI API key / OAuth config (warning only, not required)
        openai_key = (
            keychain_secret("openai-api-key-pediatrics")
            or self.config.get('OpenAI', 'api_key', fallback='').strip()
        )
        if not openai_key and not has_openai_oauth_config(self.config):
            warnings.append("OpenAI API key not configured. AI clinical suggestions will be unavailable.")

        # Log warnings
        for warning in warnings:
            self.logger.warning(f"Configuration warning: {warning}")

        if errors:
            for error in errors:
                self.logger.error(f"Configuration error: {error}")
            return False

        self.logger.info("Configuration validated successfully")
        return True

    def _should_disable_ssl_verification(self) -> bool:
        """Return True when SSL verification should be disabled explicitly (dev only)."""
        env_flag = os.environ.get("EMR_DISABLE_SSL_VERIFY")
        if env_flag is not None:
            return env_flag.strip().lower() == "true"
        return self.config.getboolean('Browser', 'disable_ssl_verify', fallback=False)

    def _get_credentials(self) -> Tuple[str, str]:
        """
        Resolve EMR credentials using the priority chain:
        Keychain > environment variables > config.ini.

        Returns:
            tuple[str, str]: username, password (empty strings when missing)
        """
        cm = get_credential_manager()
        username, password = cm.get_credentials(config=self.config)

        if not username or not password:
            self.logger.error(
                "EMR credentials are missing. Use 'python -m emr_automation.credential_manager --store' "
                "to save in Keychain, or set EMR_USERNAME/EMR_PASSWORD env vars."
            )
        return username, password

    def _resolve_audio_to_note_script(self) -> Optional[Path]:
        """
        Resolve the configured path for the audio-to-note automation script.

        Returns:
            Optional[Path]: Absolute path to the script if available, otherwise None.
        """
        try:
            script_setting = self.config.get('ExternalScripts', 'audio_to_note_script', fallback='').strip()
        except (configparser.NoSectionError, configparser.NoOptionError):
            script_setting = ''

        if not script_setting:
            self.logger.warning("Audio-to-note script path not configured.")
            return None

        candidate_path = Path(script_setting).expanduser()
        if not candidate_path.is_absolute():
            candidate_path = (Path(__file__).resolve().parent.parent / candidate_path).resolve()

        if not candidate_path.exists():
            self.logger.error("Audio-to-note script not found at: %s", candidate_path)
            return None

        self.logger.info("Audio-to-note script resolved to: %s", candidate_path)
        return candidate_path

    def _use_playwright(self) -> bool:
        """Check if Playwright backend should be used."""
        # Environment variable takes precedence
        env_val = os.environ.get('EMR_USE_PLAYWRIGHT', '').lower()
        if env_val in ('true', '1', 'yes'):
            return True
        if env_val in ('false', '0', 'no'):
            return False
        # Fall back to config
        return self.config.getboolean('Browser', 'use_playwright', fallback=False)

    @timed
    def setup_driver(self) -> Any:
        """
        Initialize and configure the browser automation backend.

        Uses Playwright if configured (use_playwright=True or EMR_USE_PLAYWRIGHT env var),
        otherwise falls back to Selenium WebDriver.

        Returns:
            Browser driver/page instance
        """
        if self.driver is not None:
            self.logger.info("Browser already initialized; skipping setup.")
            return self.driver

        if self._use_playwright():
            return self._setup_playwright()

        try:
            return self._setup_selenium()
        except ModuleNotFoundError as e:
            # Graceful fallback when Selenium is not installed in the active venv.
            if "selenium" in str(e):
                self.logger.warning(
                    "Selenium unavailable (%s). Falling back to Playwright backend.",
                    e,
                )
                return self._setup_playwright()
            raise

    def _setup_playwright(self) -> Page:
        """Initialize Playwright browser."""
        try:
            from playwright.sync_api import sync_playwright as _sync_playwright

            self._playwright_instance = _sync_playwright().start()

            browser_args = [
                "--disable-gpu",
                "--no-sandbox",
                "--disable-dev-shm-usage",
            ]

            headless = self.config.getboolean('Browser', 'headless', fallback=False)
            self.logger.info("Playwright browser: headless=%s (set headless=False in config.ini to see the EMR window)", headless)
            ignore_https = False  # SSL verification forced ON


            self._browser = self._playwright_instance.chromium.launch(
                headless=headless,
                args=browser_args,
            )
            self._context = self._browser.new_context(
                viewport=None,  # Full window
                ignore_https_errors=ignore_https,
            )
            self.driver = self._context.new_page()

            # Store backend type for later checks
            self._backend = "playwright"
            self._locators = PlaywrightLocators

            self.logger.info("Playwright browser initialized successfully")
            return self.driver

        except Exception as e:
            self.logger.error(f"Failed to initialize Playwright: {e}")
            raise

    def _setup_selenium(self) -> "ChromeWebDriver":
        """Initialize Selenium WebDriver."""
        try:
            global SELENIUM_AVAILABLE, ChromeOptions, ChromeWebDriver, Service
            global By, Keys, WebElement, WebDriverWait, EC
            global TimeoutException, NoSuchElementException
            global StaleElementReferenceException, WebDriverException, InvalidSessionIdException

            if not SELENIUM_AVAILABLE:
                from selenium.webdriver.common.by import By as _By
                from selenium.webdriver.common.keys import Keys as _Keys
                from selenium.webdriver.remote.webelement import WebElement as _WebElement
                from selenium.webdriver.support.ui import WebDriverWait as _WebDriverWait
                from selenium.webdriver.support import expected_conditions as _EC
                from selenium.webdriver.chrome.options import Options as _ChromeOptions
                from selenium.webdriver.chrome.webdriver import WebDriver as _ChromeWebDriver
                from selenium.webdriver.chrome.service import Service as _Service
                from selenium.common.exceptions import (
                    TimeoutException as _TimeoutException,
                    NoSuchElementException as _NoSuchElementException,
                    StaleElementReferenceException as _StaleElementReferenceException,
                    WebDriverException as _WebDriverException,
                    InvalidSessionIdException as _InvalidSessionIdException,
                )

                By = _By  # type: ignore
                Keys = _Keys  # type: ignore
                WebElement = _WebElement  # type: ignore
                WebDriverWait = _WebDriverWait  # type: ignore
                EC = _EC  # type: ignore
                ChromeOptions = _ChromeOptions  # type: ignore
                ChromeWebDriver = _ChromeWebDriver  # type: ignore
                Service = _Service  # type: ignore
                TimeoutException = _TimeoutException  # type: ignore
                NoSuchElementException = _NoSuchElementException  # type: ignore
                StaleElementReferenceException = _StaleElementReferenceException  # type: ignore
                WebDriverException = _WebDriverException  # type: ignore
                InvalidSessionIdException = _InvalidSessionIdException  # type: ignore
                SELENIUM_AVAILABLE = True

            options = ChromeOptions()
            options.add_argument("--disable-gpu")
            # "--kiosk-printing" removed — it suppressed the print dialog for ALL
            # print operations including manual Cmd+P, preventing printer selection.
            # Automated window.print() calls now show the normal OS dialog.
            options.add_argument("--no-sandbox")
            options.add_argument("--disable-dev-shm-usage")

            headless = self.config.getboolean('Browser', 'headless', fallback=False)
            self.logger.info("Selenium Chrome: headless=%s (set headless=False in config.ini to see the EMR window)", headless)
            if headless:
                options.add_argument("--headless")

            # Configure SSL verification (Chrome-only, doesn't affect global Python SSL)
            # SSL verification is forced ON (ignore disable_ssl_verify).

            # macOS Chrome binary path
            default_mac_chrome_path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            if sys.platform == "darwin" and os.path.exists(default_mac_chrome_path):
                options.binary_location = default_mac_chrome_path

            driver_path_setting = self.config.get('Browser', 'chromedriver_path', fallback='').strip()
            service = None

            if driver_path_setting:
                resolved_path = Path(driver_path_setting).expanduser()
                if resolved_path.exists():
                    service = Service(str(resolved_path))
                    self.logger.info("Using configured ChromeDriver binary: %s", resolved_path)
                else:
                    self.logger.warning(
                        "Configured ChromeDriver path not found (%s). Falling back to automatic resolution.",
                        resolved_path
                    )

            if service:
                self.driver = ChromeWebDriver(service=service, options=options)
            else:
                try:
                    self.logger.info("Attempting to launch ChromeDriver via Selenium Manager.")
                    self.driver = ChromeWebDriver(options=options)
                except Exception as sm_error:
                    self.logger.warning(
                        "Selenium Manager failed to start ChromeDriver: %s. Falling back to webdriver_manager...",
                        sm_error
                    )
                    try:
                        from webdriver_manager.chrome import ChromeDriverManager
                        service = Service(ChromeDriverManager().install())
                        self.driver = ChromeWebDriver(service=service, options=options)
                    except Exception as wdm_error:
                        raise WebDriverException(
                            f"Failed to initialize WebDriver via Selenium Manager and webdriver_manager: {wdm_error}"
                        )

            self.driver.maximize_window()

            # Store backend type for later checks
            self._backend = "selenium"
            self._locators = Locators

            self.logger.info("Chrome WebDriver initialized successfully")
            return self.driver

        except Exception as e:
            self.logger.error(f"Failed to initialize WebDriver: {e}")
            raise

    def health_check(self) -> bool:
        """
        Verify EMR connectivity before starting work.

        Returns:
            bool: True if EMR is reachable, False otherwise
        """
        try:
            if hasattr(self, "_ensure_driver_session"):
                self._ensure_driver_session("health_check")

            if not self.driver:
                self.setup_driver()

            login_url = URLPatterns.login_url(self.config['EMR']['base_url'])
            post_login_paths = tuple(URLPatterns.POST_LOGIN_PATHS)

            if self._backend == "playwright":
                self.driver.goto(login_url)
                try:
                    self.driver.locator(self._locators.LOGIN_EMAIL).wait_for(
                        state="attached", timeout=10000
                    )
                except Exception:
                    current_url = getattr(self.driver, "url", "")
                    if not any(path in current_url for path in post_login_paths):
                        raise
                current_url = getattr(self.driver, "url", "")
            else:
                self.driver.get(login_url)
                WebDriverWait(self.driver, 10).until(
                    lambda drv: (
                        any(path in (drv.current_url or "") for path in post_login_paths)
                        or len(drv.find_elements(*Locators.LOGIN_EMAIL)) > 0
                    )
                )
                current_url = self.driver.current_url

            if any(path in current_url for path in post_login_paths):
                self.logger.info("Health check passed: EMR reachable with active authenticated session")
            else:
                self.logger.info("Health check passed: EMR login page is reachable")
            return True
        except Exception as e:
            self.logger.error(f"Health check failed: {e}")
            handled = self._handle_driver_exception(e, "health_check")
            if not handled and isinstance(e, WebDriverException):
                self.logger.warning("Marking browser session invalid after WebDriver health check failure.")
                self._mark_session_lost()
            return False

    def _handle_driver_exception(self, exception, context: str) -> bool:
        """
        Inspect a WebDriver exception to determine if the browser session was lost.
        Returns True when a recovery attempt was triggered.
        """
        message = str(exception).lower()
        is_invalid_session = (
            isinstance(exception, InvalidSessionIdException)
            or "invalid session id" in message
            or "no such window" in message
            or "target window already closed" in message
            or "web view not found" in message
            or "disconnected: not connected to devtools" in message
        )
        if not is_invalid_session:
            return False

        self.logger.error("WebDriver session lost during %s: %s", context, exception)
        self._mark_session_lost()
        return True

    def _mark_session_lost(self):
        """Mark the current WebDriver session as invalid and dispose of the stale driver."""
        with self._session_lock:
            if self._session_invalidated:
                return
            driver_to_close = self.driver
            self.driver = None
            self._session_invalidated = True

        if driver_to_close:
            try:
                driver_to_close.quit()
            except Exception as quit_error:
                self.logger.debug("Error while closing invalid WebDriver session: %s", quit_error)

    def _ensure_driver_session(self, caller_name: str):
        """
        Ensure there is an active WebDriver session before executing an automation step.
        Recreates the driver and logs back in when necessary.
        """
        with self._session_lock:
            if caller_name == "login":
                needs_restart = self.driver is None
                reason_flag = "driver not initialized"
            else:
                needs_restart = self.driver is None or self._session_invalidated
                reason_flag = (
                    "session invalidated" if self._session_invalidated else "driver not initialized"
                )

        if not needs_restart:
            return

        skip_login = caller_name == "login"
        if skip_login:
            self.logger.warning(
                "Reinitializing Chrome WebDriver before %s (%s). Login will continue in caller.",
                caller_name, reason_flag
            )
        else:
            self.logger.warning(
                "Reinitializing Chrome WebDriver before %s (%s).", caller_name, reason_flag
            )
        self._restart_driver_session(skip_login=skip_login, trigger_name=caller_name)

    def _restart_driver_session(self, skip_login: bool = False, trigger_name: str = "unknown"):
        """Recreate the Chrome WebDriver session and optionally perform a fresh login."""
        with self._session_lock:
            driver_to_close = self.driver
            self.driver = None
            self._session_invalidated = True

            if driver_to_close:
                try:
                    driver_to_close.quit()
                except Exception as quit_error:
                    self.logger.debug("Error while shutting down prior WebDriver instance: %s", quit_error)

            self.logger.info("Starting new Chrome WebDriver session (triggered by %s).", trigger_name)
            try:
                self.setup_driver()
                # Mark the browser session as active immediately after setup.
                # Authentication may still be pending, but nested helper calls
                # during login should not recursively restart the driver.
                self._session_invalidated = False

                if skip_login:
                    return

                self.logger.info("Re-authenticating after WebDriver restart.")
                if not self.login():
                    raise LoginError("Failed to log back into EMR after restarting the WebDriver session.")
            except Exception:
                self._session_invalidated = True
                raise

    def _get_atendimento_locators(self) -> list:
        """Get locator strategies for atendimento button."""
        return Locators.ATENDIMENTO

    def find_element_safely(
        self,
        locator_strategies: list,
        timeout: int = 30
    ) -> Optional[WebElement]:
        """
        Find an element using multiple locator strategies.

        Args:
            locator_strategies: List of tuples (By.X, "locator_string")
            timeout: Timeout in seconds

        Returns:
            WebElement or None
        """
        if hasattr(self, "_ensure_driver_session"):
            self._ensure_driver_session("find_element_safely")

        for by_method, locator in locator_strategies:
            try:
                element = WebDriverWait(self.driver, timeout).until(
                    EC.presence_of_element_located((by_method, locator))
                )
                return element
            except (TimeoutException, NoSuchElementException, StaleElementReferenceException) as exc:
                self.logger.debug("Element not found with %s %s: %s", by_method, locator, exc)
                continue
        self.logger.debug("All locator strategies failed after %s seconds.", timeout)
        return None

    @retry(max_tries=3, delay_seconds=1)
    def login(self) -> bool:
        """Log into the EMR system."""
        login_start = time.perf_counter()
        success = False
        try:
            self.logger.info("Attempting to log in...")
            if self.driver is None:
                self.logger.info("WebDriver not initialized; invoking setup_driver() before login.")
                self.setup_driver()

            # Navigate to login page
            login_url = URLPatterns.login_url(self.config['EMR']['base_url'])
            self.logger.info(f"Navigating to {login_url}")
            self.driver.get(login_url)

            timeout_seconds = int(self.config['Browser']['timeout'])

            # Resolve credentials
            username, password = self._get_credentials()
            if not username or not password:
                return False

            # Fill in email field
            email_field = WebDriverWait(self.driver, timeout_seconds).until(
                EC.presence_of_element_located(Locators.LOGIN_EMAIL)
            )
            email_field.clear()
            email_field.send_keys(username)

            # Fill in password field
            password_field = WebDriverWait(self.driver, timeout_seconds).until(
                EC.presence_of_element_located(Locators.LOGIN_PASSWORD)
            )
            password_field.clear()
            password_field.send_keys(password)

            # Click submit button
            submit_button = WebDriverWait(self.driver, timeout_seconds).until(
                EC.element_to_be_clickable(Locators.LOGIN_SUBMIT)
            )
            submit_button.click()

            # Wait for post-login transition
            try:
                WebDriverWait(self.driver, timeout_seconds).until(
                    lambda drv: (
                        any(path in drv.current_url for path in URLPatterns.POST_LOGIN_PATHS)
                        or drv.find_elements(*Locators.LOGIN_SUCCESS_NOTICE)
                    )
                )
            except TimeoutException:
                self.logger.warning("Post-login transition did not complete within %s seconds.", timeout_seconds)

            # Check for success
            success_notice = None
            try:
                success_notice = WebDriverWait(self.driver, timeout_seconds).until(
                    EC.presence_of_element_located(Locators.LOGIN_SUCCESS_NOTICE)
                )
            except TimeoutException:
                pass

            current_url = self.driver.current_url
            success = (
                (success_notice is not None and "Login efetuado com sucesso" in success_notice.text)
                or any(path in current_url for path in URLPatterns.POST_LOGIN_PATHS)
            )

            if success:
                consultations_url = URLPatterns.consultations_url(self.config['EMR']['base_url'])
                if consultations_url != current_url:
                    self.driver.get(consultations_url)

                if self.find_element_safely(self._get_atendimento_locators(), timeout=timeout_seconds):
                    self.logger.info("Consultations page ready after login.")
            else:
                # Devise lockout: bail before the 120s manual-login wait — manual login
                # cannot succeed while the account is locked, and continuing to submit
                # may extend the lockout window in some Devise configs.
                try:
                    page = self.driver.page_source or ""
                except Exception:
                    page = ""
                page_lower = page.lower()
                if "está bloqueada" in page or "account is locked" in page_lower:
                    raise AccountLockedError(
                        "EMR account is locked. Check email for unlock instructions, "
                        "visit /users/unlock/new to resend, or contact IT."
                    )
                # Devise "invalid email or password": halt immediately. Three strikes
                # locks the account and requires IT to unlock — never retry, never
                # fall through to the manual-login wait (the user could resubmit the
                # same wrong password without realising).
                bad_cred_markers = (
                    "senha inválid", "senha invalid", "e-mail ou senha",
                    "email ou senha", "invalid email or password",
                    "invalid_credentials",
                )
                if any(m in page_lower for m in bad_cred_markers):
                    raise BadCredentialsError(
                        "EMR rejected credentials. Halting to protect against "
                        "Devise account lockout (locks after 3 failed attempts)."
                    )
                # Manual login fallback (no automatic credential resubmission)
                success = self._wait_for_manual_login(timeout_seconds)

        except AccountLockedError as e:
            self.logger.error("EMR account locked: %s", e)
            self._save_error_screenshot("account_locked")
            raise
        except BadCredentialsError as e:
            self.logger.error("EMR credentials rejected: %s", e)
            self._save_error_screenshot("bad_credentials")
            raise
        except Exception as e:
            self.logger.error(f"Login failed: {e}")
            self._save_error_screenshot("login_error")
            success = False
        finally:
            duration = time.perf_counter() - login_start
            if success:
                self.logger.info("Login workflow completed successfully in %.2f seconds.", duration)
            else:
                self.logger.info("Login workflow finished without success in %.2f seconds.", duration)
        return success

    def _wait_for_manual_login(self, timeout_seconds: int) -> bool:
        """Wait for user to complete manual login."""
        manual_timeout = self.MANUAL_LOGIN_DEFAULT_TIMEOUT
        try:
            manual_timeout = int(os.environ.get(
                'EMR_MANUAL_LOGIN_TIMEOUT',
                str(self.config.getint('Browser', 'manual_login_timeout', fallback=self.MANUAL_LOGIN_DEFAULT_TIMEOUT))
            ))
        except Exception:
            pass

        self.logger.warning("Automatic login did not complete. Waiting up to %s seconds for manual login...", manual_timeout)

        start_wait = time.time()
        while time.time() - start_wait <= manual_timeout:
            try:
                current = self.driver.current_url
                if ("/users/sign_in" not in current) and (
                    any(path in current for path in URLPatterns.POST_LOGIN_PATHS + ["/"])
                ):
                    self.logger.info("Manual login detected at URL: %s", current)
                    consultations_url = URLPatterns.consultations_url(self.config['EMR']['base_url'])
                    try:
                        self.driver.get(consultations_url)
                        self.find_element_safely(self._get_atendimento_locators(), timeout=timeout_seconds)
                    except Exception:
                        pass
                    return True
            except Exception:
                pass
            time.sleep(SleepDurations.ERROR_RECOVERY)

        self.logger.error("Manual login window timed out after %s seconds.", manual_timeout)
        return False

    def _save_error_screenshot(self, prefix: str):
        """Save a screenshot for debugging."""
        try:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            screenshot_path = f"logs/{prefix}_{timestamp}.png"
            self.driver.save_screenshot(screenshot_path)
            self.logger.info(f"Screenshot saved to {screenshot_path}")
        except Exception as e:
            self.logger.error(f"Failed to save error screenshot: {e}")

    def wait_for_atendimento(self) -> bool:
        """
        Wait for the 'Atendimento' button to appear on the main Consultas page.
        
        Waits indefinitely, refreshing the page every 5 minutes if no patient
        is selected. If session expires (redirected to login), automatically
        re-authenticates and navigates back to consultations.

        Returns:
            bool: True when button is found
        """
        if hasattr(self, "_ensure_driver_session"):
            self._ensure_driver_session("wait_for_atendimento")

        self.logger.info("Waiting for 'Atendimento' button...")
        wait_start = time.perf_counter()
        
        # Refresh interval: 5 minutes
        refresh_interval_seconds = 300
        last_refresh = time.monotonic()
        
        while True:
            # Check if session expired (redirected to login page)
            try:
                current_url = self.driver.current_url
                if "/users/sign_in" in current_url:
                    self.logger.warning("Session expired — redirected to login page. Re-authenticating...")
                    # BadCredentialsError / AccountLockedError MUST propagate — they are
                    # terminal conditions. Retrying re-auth against a wrong password
                    # is exactly how the account gets locked.
                    if self.login():
                        self.logger.info("Re-authentication successful. Returning to consultations page.")
                        consultations_url = URLPatterns.consultations_url(self.config['EMR']['base_url'])
                        self.driver.get(consultations_url)
                        time.sleep(SleepDurations.PAGE_LOAD)
                        last_refresh = time.monotonic()  # Reset refresh timer
                    else:
                        self.logger.error("Re-authentication failed. Waiting before retry...")
                        time.sleep(SleepDurations.RELOGIN_WAIT)
                    continue
            except Exception as url_error:
                self.logger.debug("Could not check current URL: %s", url_error)
            
            try:
                element = self.find_element_safely(self._get_atendimento_locators(), timeout=5)
                if element:
                    elapsed = time.perf_counter() - wait_start
                    self.logger.info("'Atendimento' button detected after %.2f seconds.", elapsed)
                    self.check_and_update_patient_info()
                    return True
            except Exception as wait_error:
                self.logger.debug("Waiting for 'Atendimento' button: %s", wait_error)
            
            # Check if it's time to refresh the page
            if time.monotonic() - last_refresh >= refresh_interval_seconds:
                self.logger.info("No patient selected for 5 minutes. Refreshing page...")
                try:
                    self.driver.refresh()
                    time.sleep(SleepDurations.PAGE_LOAD)  # Wait for page to reload
                except Exception as refresh_error:
                    self.logger.warning("Failed to refresh page: %s", refresh_error)
                    handled = self._handle_driver_exception(refresh_error, "wait_for_atendimento_refresh")
                    if handled:
                        try:
                            self._ensure_driver_session("wait_for_atendimento")
                        except Exception as recover_error:
                            self.logger.error("Failed to recover browser session: %s", recover_error)
                last_refresh = time.monotonic()
            
            time.sleep(self.ATENDIMENTO_POLL_INTERVAL)

    def check_and_update_patient_info(self) -> None:
        """Check current URL for intern_id and update patient information if needed."""
        try:
            current_url = self.driver.current_url
            self.logger.info(f"Checking URL for patient info: {current_url}")

            new_intern_id = self._extract_intern_id_from_url(current_url)
            if not new_intern_id:
                self.logger.info("No intern_id found in URL")
                return

            if new_intern_id == self.intern_id:
                self.logger.info("Same patient, no update needed")
                return

            self.logger.info(f"New patient detected. Previous ID: {self.intern_id}, New ID: {new_intern_id}")
            self.intern_id = new_intern_id

            # Reset derived fields for new patient
            self.patient_name = None
            self.patient_age = None

            # Navigate to patient chart if not already there
            if "/interns/" not in current_url:
                patient_chart_url = URLPatterns.patient_chart_url(
                    self.config['EMR']['base_url'], self.intern_id
                )
                self.logger.info(f"Navigating to patient chart: {patient_chart_url}")
                self.driver.get(patient_chart_url)
                WebDriverWait(self.driver, int(self.config['Browser']['timeout'])).until(
                    EC.presence_of_element_located((By.TAG_NAME, "body"))
                )

            # Extract patient information
            self.weight = self.extract_patient_weight()
            self.chief_complaint = self.extract_chief_complaint()
            self.extract_patient_name()
            self.extract_patient_age()

            # Clear consultation text for the new patient
            if self.fill_consultation_text():
                self.logger.info("Consultation text box cleared successfully for new patient")
            else:
                self.logger.error("Failed to clear consultation text box for new patient")

            # Calculate dosages if weight is available
            if self.weight:
                dosages = self.calculate_dosages(self.weight)
                if dosages:
                    self.logger.info("Calculated dosages for reference")

            # Update GUI if available
            if self.gui:
                self.gui.update_patient_info()

            self.logger.info(
                "Patient info updated - Name: %s, Age: %s, Weight: %s, Chief Complaint: %s",
                self.patient_name, self.patient_age, self.weight, self.chief_complaint,
            )

            # Notify dashboard (if wired up) without importing from dashboard package
            if callable(self.on_patient_changed):
                try:
                    self.on_patient_changed({
                        "intern_id": self.intern_id,
                        "patient_name": self.patient_name,
                        "patient_age": self.patient_age,
                        "weight": self.weight,
                        "chief_complaint": self.chief_complaint,
                    })
                except Exception as cb_err:
                    self.logger.debug("on_patient_changed callback error: %s", cb_err)

        except Exception as e:
            self.logger.error(f"Failed to update patient info: {e}")

    @staticmethod
    def _extract_intern_id_from_url(url: str) -> str | None:
        """Extract intern_id from legacy query-param or new path-based G-Hosp URLs."""
        if "intern_id=" in url:
            return url.split("intern_id=")[-1].split("&")[0]
        m = __import__("re").search(r"/interns/(\d+)", url)
        return m.group(1) if m else None

    def _validate_intern_id(self, intern_id: str) -> bool:
        """
        Validate and sync intern_id from the current browser URL.
        """
        if not intern_id:
            self.logger.error("No intern_id provided for this operation.")
            return False

        try:
            current_url = self.driver.current_url
            url_intern_id = self._extract_intern_id_from_url(current_url)
            if url_intern_id and url_intern_id != self.intern_id:
                self.logger.info("Auto-syncing intern_id from URL: %s -> %s", self.intern_id, url_intern_id)
                self.intern_id = url_intern_id
                if self.gui:
                    self.gui.root.after(0, self.gui.update_patient_info)
        except Exception as e:
            self.logger.warning("Could not sync intern_id from URL: %s", e)

        return True

    @retry(max_tries=3, delay_seconds=1)
    def extract_patient_weight(self) -> Optional[float]:
        """Extract the patient's weight from the consultation page."""
        try:
            self.logger.info("Extracting patient weight...")

            info_element = WebDriverWait(self.driver, int(self.config['Browser']['timeout'])).until(
                EC.presence_of_element_located(Locators.PATIENT_INFO)
            )
            info_text = info_element.text.strip()
            self.logger.info(f"Found info text: {info_text}")

            weight_match = re.search(r'(\d+[,\.]\d+|\d+)\s*kg', info_text)
            if weight_match:
                weight_str = weight_match.group(1).replace(',', '.')
                self.weight = float(weight_str)
                self.logger.info(f"Weight extracted: {self.weight} kg")
                return self.weight
            else:
                self.logger.warning("Could not find weight in text")
                self.weight = None
                return None

        except Exception as e:
            self.logger.error(f"Failed to extract weight: {e}")
            self.weight = None
            return None

    @retry(max_tries=3, delay_seconds=1)
    def extract_chief_complaint(self) -> Optional[str]:
        """Extract the chief complaint from the consultation page."""
        try:
            self.logger.info("Extracting chief complaint...")

            complaint_element = WebDriverWait(self.driver, int(self.config['Browser']['timeout'])).until(
                EC.presence_of_element_located(Locators.CHIEF_COMPLAINT)
            )
            complaint_text = complaint_element.text.strip()

            if complaint_text:
                self.chief_complaint = complaint_text
                self.logger.info(f"Chief complaint extracted: {self.chief_complaint}")
                return self.chief_complaint
            else:
                self.logger.warning("Chief complaint field is empty")
                self.chief_complaint = None
                return None

        except Exception as e:
            self.logger.error(f"Failed to extract chief complaint: {e}")
            self.chief_complaint = None
            return None

    # Texts that appear in G-HOSP UI buttons/labels and must not be treated as patient names
    _NAME_BLACKLIST = frozenset({
        "chamar", "consultar", "editar", "salvar", "voltar", "fechar", "imprimir",
        "cancelar", "confirmar", "atualizar", "novo", "inserir", "excluir",
        "ok", "sim", "não", "nao", "visualizar", "selecionar", "adicionar",
    })

    def extract_patient_name(self) -> Optional[str]:
        """
        Extract the patient name from the G-HOSP consultation page.

        Priority order:
        1. Sibling paragraphs of PATIENT_INFO (same container already proven to
           contain structured patient data).
        2. Class-based selectors for name fields.
        3. Headings inside #paciente, skipping known button/label texts.

        Texts in _NAME_BLACKLIST (buttons etc.) are always rejected.
        """
        # PATIENT_INFO is at #paciente/div[2]/div/div[2]/p[1]
        # The name often lives in an adjacent p or in div[1] of the same container.
        xpath_candidates = [
            '//*[@id="paciente"]/div[2]/div/div[1]',          # sibling div before info block
            '//*[@id="paciente"]/div[2]/div/div[2]/p[2]',     # p[2] right after info text
            '//*[@id="paciente"]/div[2]/div/div[2]/p[3]',
            '//*[contains(@class,"nome") or contains(@class,"paciente") or contains(@class,"patient-name")]',
            '//*[@id="paciente"]//h1',
            '//*[@id="paciente"]//h2',
            '//*[@id="paciente"]//h3',
        ]

        def _is_valid_name(text: str) -> bool:
            """Reject empty, too-long, blacklisted, or purely numeric strings."""
            if not text or not (4 < len(text) < 80):
                return False
            if text.lower() in self._NAME_BLACKLIST:
                return False
            if re.match(r'^[\d\s/|.:,-]+$', text):  # purely numeric/punctuation
                return False
            return True

        try:
            if self._backend == "playwright":
                for xpath in xpath_candidates:
                    try:
                        el = self.driver.locator(f"xpath={xpath}").first
                        text = el.inner_text(timeout=2000).strip()
                        if _is_valid_name(text):
                            self.patient_name = text
                            self.logger.info("Patient name extracted (Playwright): %s", text)
                            return text
                    except Exception:
                        continue
            else:
                for xpath in xpath_candidates:
                    try:
                        elements = self.driver.find_elements(By.XPATH, xpath)
                        for el in elements:
                            text = el.text.strip()
                            if _is_valid_name(text):
                                self.patient_name = text
                                self.logger.info("Patient name extracted (Selenium): %s", text)
                                return text
                    except Exception:
                        continue
        except Exception as e:
            self.logger.debug("extract_patient_name failed: %s", e)

        self.patient_name = None
        return None

    def extract_patient_age(self) -> Optional[str]:
        """
        Extract patient age from the PATIENT_INFO element already used for weight.

        G-HOSP encodes age in that element as e.g. "6a 1m  68,0 kg | CID: ..."
        where Xa = anos, Ym = meses.  We parse that directly instead of doing a
        separate DOM search, which was matching unrelated elements like buttons.
        """
        try:
            info_element = self.driver.find_element(*Locators.PATIENT_INFO) \
                if self._backend != "playwright" \
                else self.driver.locator(PlaywrightLocators.PATIENT_INFO).first
            info_text = (
                info_element.text.strip()
                if self._backend != "playwright"
                else info_element.inner_text(timeout=3000).strip()
            )

            # Pattern: "6a 1m" or "6a" or "10m" (without years)
            m = re.search(r'(\d+)a(?:\s+(\d+)m)?|(\d+)m\b', info_text)
            if m:
                if m.group(3):                          # months-only e.g. "8m"
                    age_str = f"{m.group(3)} meses"
                else:
                    years = int(m.group(1))
                    months = int(m.group(2)) if m.group(2) else 0
                    age_str = f"{years} anos" + (f" {months} meses" if months else "")
                self.patient_age = age_str
                self.logger.info("Patient age extracted: %s", age_str)
                return age_str

        except Exception as e:
            self.logger.debug("extract_patient_age failed: %s", e)

        self.patient_age = None
        return None

    @retry(max_tries=3, delay_seconds=1)
    def extract_intern_id(self) -> Optional[str]:
        """Extract the intern_id from the current URL."""
        try:
            self.logger.info("Extracting intern_id from URL...")
            current_url = self.driver.current_url
            intern_id = self._extract_intern_id_from_url(current_url)
            if intern_id:
                self.logger.info(f"Extracted intern_id: {intern_id}")
                return intern_id
            else:
                self.logger.error("'intern_id' not found in the URL")
                return None
        except Exception as e:
            self.logger.error(f"Failed to extract intern_id: {e}")
            return None

    @retry(max_tries=3, delay_seconds=1)
    def fill_consultation_text(self) -> bool:
        """Clear the consultation text box in the iframe."""
        try:
            self.logger.info("Clearing consultation text box...")

            # Use shorter timeout for iframe - it should load quickly if available
            iframe_timeout = min(10, int(self.config['Browser']['timeout']))
            
            # First verify we're on a page that has the consultation iframe
            try:
                WebDriverWait(self.driver, 5).until(
                    EC.presence_of_element_located((By.TAG_NAME, "body"))
                )
            except TimeoutException:
                self.logger.warning("Page not ready for consultation text clearing")
                return False

            try:
                with switch_to_iframe(self.driver, Locators.CONSULTATION_IFRAME, iframe_timeout):
                    # Wait briefly for iframe content to be ready
                    time.sleep(0.5)
                    
                    text_box = WebDriverWait(self.driver, 5).until(
                        EC.presence_of_element_located((By.TAG_NAME, "body"))
                    )

                    # Clear using JavaScript (TinyMCE/contentEditable-friendly).
                    # Retry briefly because G-Hosp may repopulate asynchronously.
                    cleared = False
                    for _ in range(3):
                        cleared = bool(self.driver.execute_script("""
                            try {
                                const body = document.body;
                                if (!body) return false;
                                body.focus();
                                body.innerHTML = '<p><br></p>';
                                body.textContent = '';
                                ['input', 'change', 'keyup', 'blur'].forEach((evt) => {
                                    body.dispatchEvent(new Event(evt, { bubbles: true }));
                                });
                                return (body.textContent || '').trim().length === 0;
                            } catch (e) { return false; }
                        """))
                        if cleared:
                            break
                        time.sleep(0.2)

                    if not cleared:
                        # Fallback to keyboard clear
                        try:
                            text_box.click()
                            text_box.send_keys(Keys.COMMAND, 'a')
                            text_box.send_keys(Keys.DELETE)
                            # Final DOM-level fallback in case editor ignores key events.
                            self.driver.execute_script(
                                "if (document.body) { document.body.textContent=''; document.body.innerHTML='<p><br></p>'; }"
                            )
                        except Exception as kb_err:
                            self.logger.debug(f"Keyboard fallback failed: {kb_err}")

                    self.logger.info("Consultation text box cleared successfully")
                    return True
                    
            except TimeoutException:
                self.logger.warning("Consultation iframe not found - may not be on patient chart page")
                return False
            except StaleElementReferenceException:
                self.logger.warning("Iframe became stale - page may have reloaded")
                return False

        except Exception as e:
            self.logger.error(f"Failed to clear consultation text box: {e}")
            try:
                self.driver.switch_to.default_content()
            except Exception:
                pass
            return False

    def calculate_dosages(self, weight: float) -> Optional[str]:
        """
        Calculate medication dosages based on patient weight.

        Calculates appropriate dosages for amoxicillin (strep throat and pneumonia)
        and cephalexin based on pediatric weight-based dosing guidelines.

        Args:
            weight: Patient weight in kg

        Returns:
            str: Formatted dosage text with instructions, or None if weight is invalid

        Example:
            >>> emr = EMRAutomation()
            >>> emr.weight = 15.5
            >>> dosages = emr.calculate_dosages(emr.weight)
            >>> print(dosages)
            === Dosagens Calculadas ===
            1. Amoxicilina para faringite estreptocócica:
               Dosagem calculada: 775 mg/dia
               Tomar 7.8 mL a cada 12 horas por 7 dias.
            ...
        """
        if weight is None:
            self.logger.warning("Cannot calculate dosages: weight is None")
            return None

        try:
            amox_strep_dose = self.config.getfloat('Dosages', 'amoxicillin_strep_dose', fallback=50)
            amox_strep_max = self.config.getfloat('Dosages', 'amoxicillin_strep_max', fallback=1000)
            amox_pneum_dose = self.config.getfloat('Dosages', 'amoxicillin_pneumonia_dose', fallback=90)
            amox_pneum_max = self.config.getfloat('Dosages', 'amoxicillin_pneumonia_max', fallback=4000)
            ceph_dose = self.config.getfloat('Dosages', 'cephalexin_dose', fallback=50)
            ceph_max = self.config.getfloat('Dosages', 'cephalexin_max', fallback=2000)
            concentration = self.config.getfloat('Dosages', 'concentration', fallback=50)

            dosage_strep = min(amox_strep_dose * weight, amox_strep_max)
            dose_strep = dosage_strep / 2
            dose_ml_strep = dose_strep / concentration

            dosage_pneumonia = min(amox_pneum_dose * weight, amox_pneum_max)
            dose_pneumonia = dosage_pneumonia / 2
            dose_ml_pneumonia = dose_pneumonia / concentration

            dosage_ceph = min(ceph_dose * weight, ceph_max)
            dose_ceph = dosage_ceph / 3
            dose_ml_ceph = dose_ceph / concentration

            dosages = f"""
=== Dosagens Calculadas ===
1. Amoxicilina para faringite estreptocócica:
   Dosagem calculada: {dosage_strep:.0f} mg/dia
   Tomar {dose_ml_strep:.1f} mL a cada 12 horas por 7 dias.

2. Amoxicilina para pneumonia:
   Dosagem calculada: {dosage_pneumonia:.0f} mg/dia
   Tomar {dose_ml_pneumonia:.1f} mL a cada 12 horas por 7 dias.

3. Cefalexina:
   Dosagem calculada: {dosage_ceph:.0f} mg/dia
   Tomar {dose_ml_ceph:.1f} mL a cada 8 horas por 7 dias.
===========================
"""
            self.logger.info("Dosages calculated successfully")
            return dosages
        except Exception as e:
            self.logger.error(f"Error calculating dosages: {e}")
            return None

    # ──────────────────────────────────────────────────────────────
    # Dashboard-oriented non-blocking workflow methods
    # ──────────────────────────────────────────────────────────────

    def prescribe_and_print(self, intern_id: str, template_type: str) -> bool:
        """
        Execute prescription template selection, save, and print only.

        Unlike handle_prescription_template, this does NOT show attestation
        dialogs or process discharge. Designed for dashboard/API use.

        Args:
            intern_id: Patient intern ID
            template_type: Template code (e.g. 'gastro1', 'cold2')

        Returns:
            True if prescription was saved and printed successfully
        """
        try:
            self.check_and_update_patient_info()
            if not self._validate_intern_id(intern_id):
                return False

            self.logger.info(f"[Dashboard] Prescribe+print: {template_type} for {intern_id}")

            # Navigate to patient chart, click AJAX button, wait for dialog
            # Direct goto /receitaaltas/new returns empty body (AJAX-only endpoint).
            patient_url = URLPatterns.patient_chart_return_url(
                self.config['EMR']['base_url'], intern_id
            )
            timeout = int(self.config['Browser']['timeout'])

            if self._backend == "playwright":
                self.driver.goto(patient_url)
                self.driver.locator("body").wait_for(state="attached", timeout=timeout * 1000)
                self.driver.wait_for_timeout(2000)
                presc_btn = self.driver.locator("#link_new_receitaalta")
                presc_btn.wait_for(state="visible", timeout=timeout * 1000)
                presc_btn.click()
                self.driver.wait_for_timeout(2000)
                self.driver.locator("#dialog_formularios").locator(
                    self._locators.TEMPLATE_CHECKBOXES).first.wait_for(state="attached", timeout=10000)
            else:
                self.driver.get(patient_url)
                WebDriverWait(self.driver, timeout).until(
                    EC.presence_of_element_located((By.TAG_NAME, "body"))
                )
                time.sleep(2)
                presc_btn = WebDriverWait(self.driver, timeout).until(
                    EC.element_to_be_clickable((By.ID, "link_new_receitaalta"))
                )
                presc_btn.click()
                time.sleep(2)
                WebDriverWait(self.driver, 10).until(
                    EC.presence_of_element_located(Locators.TEMPLATE_CHECKBOXES)
                )

            self._select_normal_prescription_type()

            try:
                template = PrescriptionTemplate.from_code(template_type)
            except ValueError:
                self.logger.error(f"Invalid template type: {template_type}")
                return False

            if not self._select_template_checkbox(template.display_name, template_id=template.checkbox_id):
                self.logger.error(f"Could not find template for {template_type}")
                return False

            if not self._submit_prescription_form():
                return False

            self._wait_for_prescription_and_print()

            self.logger.info(f"[Dashboard] Prescribe+print completed: {template_type}")
            return True

        except Exception as e:
            self.logger.error(f"[Dashboard] Prescribe+print failed for {intern_id}: {e}")
            self._save_error_screenshot(f"dashboard_rx_error_{template_type}")
            return False

    def print_medication_only(self, intern_id: str) -> bool:
        """
        Print the medication page only. Does not navigate back or wait.
        Designed for dashboard/API use as part of a workflow.

        Args:
            intern_id: Patient intern ID

        Returns:
            True if medication page was printed successfully
        """
        try:
            if not self._validate_intern_id(intern_id):
                return False

            self.logger.info(f"[Dashboard] Print medication for {intern_id}")
            timeout = int(self.config['Browser']['timeout'])

            medication_url = URLPatterns.medication_url(
                self.config['EMR']['base_url'], intern_id
            )

            if self._backend == "playwright":
                self.driver.goto(medication_url)
                self.driver.locator("body").wait_for(state="attached", timeout=timeout * 1000)
            else:
                self.driver.get(medication_url)
                WebDriverWait(self.driver, timeout).until(
                    EC.presence_of_element_located((By.TAG_NAME, "body"))
                )

            self._print_medication_page()
            self.logger.info("[Dashboard] Medication printed successfully")
            return True

        except Exception as e:
            self.logger.error(f"[Dashboard] Print medication failed for {intern_id}: {e}")
            return False

    def discharge_and_return(self, intern_id: str) -> bool:
        """
        Process discharge and return to consultations without blocking.

        Unlike process_discharge, this does NOT call wait_for_atendimento().
        Designed for dashboard/API use.

        Args:
            intern_id: Patient intern ID

        Returns:
            True if discharge was processed successfully
        """
        try:
            if not self._validate_intern_id(intern_id):
                return False

            self.logger.info(f"[Dashboard] Discharge for {intern_id}")
            timeout = int(self.config['Browser']['timeout'])

            discharge_url = URLPatterns.discharge_url(
                self.config['EMR']['base_url'], intern_id
            )

            def _open_discharge_form() -> None:
                """
                Best-effort click on 'Inserir Alta'.

                Some deployments open the form immediately; in that case we can
                proceed directly to filling/saving discharge fields.
                """
                if self._backend == "playwright":
                    try:
                        discharge_button = self.driver.locator(self._locators.DISCHARGE_INSERT_BUTTON)
                        discharge_button.wait_for(state="visible", timeout=timeout * 1000)
                        discharge_button.click()
                    except Exception as exc:
                        self.logger.warning(
                            "[Dashboard] Could not click 'Inserir Alta'; continuing: %s",
                            exc,
                        )
                else:
                    try:
                        discharge_button = WebDriverWait(self.driver, timeout).until(
                            EC.element_to_be_clickable(Locators.DISCHARGE_INSERT_BUTTON)
                        )
                        discharge_button.click()
                    except TimeoutException:
                        self.logger.warning(
                            "[Dashboard] 'Inserir Alta' not clickable; continuing anyway"
                        )
                    except Exception as exc:
                        self.logger.warning(
                            "[Dashboard] Error clicking 'Inserir Alta'; continuing: %s",
                            exc,
                        )

            if self._backend == "playwright":
                self.driver.goto(discharge_url)
                self.driver.locator("body").wait_for(state="attached", timeout=timeout * 1000)
                _open_discharge_form()
            else:
                self.driver.get(discharge_url)
                WebDriverWait(self.driver, timeout).until(
                    EC.presence_of_element_located((By.TAG_NAME, "body"))
                )
                _open_discharge_form()

            time.sleep(SleepDurations.BUTTON_CLICK)

            if not self._click_today_button():
                raise Exception("'Hoje' button not found in datepicker")

            time.sleep(SleepDurations.BUTTON_CLICK)

            if not self._click_discharge_save_button(intern_id):
                raise Exception("'Salvar' button not found on discharge form")

            self._wait_for_discharge_save()

            # Return to consultations (non-blocking — no wait_for_atendimento)
            self._navigate_to_consultations()

            # Reset patient state
            self.intern_id = None
            self.weight = None
            self.chief_complaint = None
            self.patient_name = None
            self.patient_age = None

            self.logger.info("[Dashboard] Discharge completed, returned to consultations")
            return True

        except Exception as e:
            self.logger.error(f"[Dashboard] Discharge failed for {intern_id}: {e}")
            self._save_error_screenshot(f"dashboard_discharge_error_{intern_id}")
            self._navigate_to_consultations()
            return False

    def complete_workflow(
        self,
        intern_id: str,
        template_type: str,
        include_medication: bool = False,
        include_attestation: bool = False,
        include_discharge: bool = True,
        progress_cb: Optional[Callable[[str, list[str]], None]] = None,
    ) -> dict:
        """
        Execute the complete patient workflow in a single call.

        Orchestrates: prescription -> medication -> attestation -> discharge.
        Each step is optional (except prescription). Returns detailed results.

        Args:
            intern_id: Patient intern ID
            template_type: Prescription template code
            include_medication: Whether to print the medication page
            include_attestation: Whether to print an attestation
            include_discharge: Whether to process discharge and return

        Returns:
            dict with per-step results and overall success status
        """
        results = {
            "prescription": False,
            "medication": None,
            "attestation": None,
            "discharge": None,
            "overall": False,
            "steps_completed": [],
            "error": None,
        }

        try:
            self.logger.info(f"[Workflow] Starting: {template_type} for {intern_id}")

            def _report(step: str) -> None:
                """Best-effort progress reporting (never breaks the workflow)."""
                if not progress_cb:
                    return
                try:
                    progress_cb(step, list(results["steps_completed"]))
                except Exception:
                    pass

            # Step 1: Prescription (always)
            results["prescription"] = self.prescribe_and_print(intern_id, template_type)
            if not results["prescription"]:
                results["error"] = "Prescription failed"
                return results
            results["steps_completed"].append("prescription")
            _report("prescription")

            # Step 2: Medication (optional)
            if include_medication:
                results["medication"] = self.print_medication_only(intern_id)
                if results["medication"]:
                    results["steps_completed"].append("medication")
                    _report("medication")
                else:
                    self.logger.warning("[Workflow] Medication print failed, continuing...")

            # Step 3: Attestation (optional)
            if include_attestation:
                results["attestation"] = self.handle_attestation(intern_id)
                if results["attestation"]:
                    results["steps_completed"].append("attestation")
                    _report("attestation")
                else:
                    self.logger.warning("[Workflow] Attestation print failed, continuing...")

            # Step 4: Discharge (optional, default True)
            if include_discharge:
                results["discharge"] = self.discharge_and_return(intern_id)
                if results["discharge"]:
                    results["steps_completed"].append("discharge")
                    _report("discharge")
                else:
                    results["error"] = "Discharge failed"
                    self.logger.warning("[Workflow] Discharge failed")

            results["overall"] = results["prescription"] and (
                not include_discharge or results["discharge"]
            )

            self.logger.info(
                "[Workflow] Completed: %s (steps: %s)",
                "SUCCESS" if results["overall"] else "PARTIAL",
                ", ".join(results["steps_completed"]),
            )
            return results

        except Exception as e:
            results["error"] = str(e)[:200]
            self.logger.error(f"[Workflow] Failed: {e}")
            self._navigate_to_consultations()
            return results

    def check_printer_setup(self) -> None:
        """Verify default printer on Windows; no-op on other OSes."""
        try:
            import win32print
            WINDOWS_PRINT = True
        except ImportError:
            self.logger.info("win32print not available – skipping printer setup (non-Windows OS).")
            return

        try:
            default_printer = win32print.GetDefaultPrinter()
            self.logger.info(f"Default printer: {default_printer}")

            printers = [printer[2] for printer in win32print.EnumPrinters(2)]
            self.logger.info(f"Available printers: {printers}")

            if not default_printer and printers:
                win32print.SetDefaultPrinter(printers[0])
                self.logger.info(f"Set default printer to: {printers[0]}")

        except Exception as e:
            self.logger.error(f"Failed to check printer setup: {e}")
