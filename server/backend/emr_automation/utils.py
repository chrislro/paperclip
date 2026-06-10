"""
Utility functions and decorators for EMR Automation.
"""

from __future__ import annotations

import contextlib
import functools
import logging
import os
import subprocess
import sys
import time
from datetime import datetime
from logging.handlers import RotatingFileHandler
from urllib.parse import parse_qs, urlparse
from typing import (
    Any,
    Callable,
    Generator,
    List,
    Optional,
    Tuple,
    Type,
    TypeVar,
    Union,
)

# Conditional Selenium imports (may not be installed after full Playwright migration)
try:
    from selenium.webdriver.remote.webdriver import WebDriver
    from selenium.webdriver.remote.webelement import WebElement
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.common.exceptions import (
        TimeoutException,
        NoSuchElementException,
        WebDriverException,
    )
    SELENIUM_AVAILABLE = True
except Exception:
    # Any Selenium import failure (including timeouts / I/O errors)
    # will disable Selenium utilities and rely on Playwright instead.
    WebDriver = Any  # type: ignore
    WebElement = Any  # type: ignore
    WebDriverWait = None  # type: ignore
    EC = None  # type: ignore
    TimeoutException = Exception  # type: ignore
    NoSuchElementException = Exception  # type: ignore
    WebDriverException = Exception  # type: ignore
    SELENIUM_AVAILABLE = False

# Conditional Playwright imports
try:
    from playwright.sync_api import Page, FrameLocator, Locator
    from playwright._impl._errors import TimeoutError as PlaywrightTimeoutError
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    Page = Any  # type: ignore
    FrameLocator = Any  # type: ignore
    Locator = Any  # type: ignore
    PlaywrightTimeoutError = Exception  # type: ignore
    PLAYWRIGHT_AVAILABLE = False

from emr_automation.exceptions import EMRAutomationError

# Type variable for generic function return
F = TypeVar('F', bound=Callable[..., Any])


def setup_logging(
    log_dir: str = 'logs',
    log_name: str = 'emr_automation',
    level: int = logging.INFO,
    json_format: bool = False,
) -> logging.Logger:
    """
    Configure logging to both file and console with rotation.

    Args:
        log_dir: Directory for log files
        log_name: Base name for the logger
        level: Logging level (default: INFO)
        json_format: If True, use JSON format for logs (for structured logging)

    Returns:
        Configured logging object
    """
    if not os.path.exists(log_dir):
        os.makedirs(log_dir)

    logger = logging.getLogger(log_name)

    # Avoid adding handlers multiple times
    if logger.handlers:
        return logger

    logger.setLevel(level)

    # File handler (10 MB max size, 5 backup files)
    log_file = os.path.join(log_dir, f'{log_name}_{datetime.now().strftime("%Y%m%d")}.log')
    file_handler = RotatingFileHandler(
        log_file, maxBytes=10*1024*1024, backupCount=5, encoding='utf-8'
    )

    if json_format:
        # Simple JSON format for structured logging
        file_format = logging.Formatter(
            '{"timestamp": "%(asctime)s", "name": "%(name)s", '
            '"level": "%(levelname)s", "message": "%(message)s"}'
        )
    else:
        file_format = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    
    file_handler.setFormatter(file_format)

    # Console handler (always text format for readability)
    console_handler = logging.StreamHandler(stream=sys.stdout)
    console_format = logging.Formatter('%(levelname)s: %(message)s')
    console_handler.setFormatter(console_format)

    logger.addHandler(file_handler)
    logger.addHandler(console_handler)

    return logger


def run_applescript(script_lines: Union[str, List[str]]) -> bool:
    """
    Execute one or more AppleScript lines via osascript on macOS.

    Args:
        script_lines: A single string or list of AppleScript commands

    Returns:
        True if execution succeeded, False otherwise
    """
    try:
        if isinstance(script_lines, str):
            script_lines = [script_lines]
        cmd = ["osascript"]
        for line in script_lines:
            cmd.extend(["-e", line])
        result = subprocess.run(cmd, check=False, capture_output=True)
        return result.returncode == 0
    except Exception:
        return False


def _get_retry_exceptions() -> Tuple[Type[Exception], ...]:
    """Get exception types for retry based on available backends."""
    exceptions = [EMRAutomationError]

    if SELENIUM_AVAILABLE:
        exceptions.extend([TimeoutException, NoSuchElementException, WebDriverException])

    if PLAYWRIGHT_AVAILABLE:
        exceptions.append(PlaywrightTimeoutError)

    return tuple(exceptions)


def retry(
    max_tries: int = 3,
    delay_seconds: float = 1.0,
    exceptions: Optional[Tuple[Type[Exception], ...]] = None,
    backoff_multiplier: float = 2.0,
) -> Callable[[F], F]:
    """
    Retry decorator with exponential backoff for handling transient errors.

    Args:
        max_tries: Maximum number of retry attempts
        delay_seconds: Initial delay between retries
        exceptions: Tuple of exception types to catch and retry
        backoff_multiplier: Multiplier for exponential backoff (default: 2.0)

    Returns:
        Decorated function

    Example:
        @retry(max_tries=3, delay_seconds=1)
        def flaky_operation():
            ...
    """
    # Use dynamic exceptions if not explicitly provided
    retry_exceptions = exceptions if exceptions is not None else _get_retry_exceptions()

    def decorator(func: F) -> F:
        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            tries = 0
            instance = args[0] if args else None

            # Try to get config-based retry settings if available
            actual_max_tries = max_tries
            actual_delay = delay_seconds

            if instance and hasattr(instance, 'config'):
                try:
                    actual_max_tries = instance.config.getint(
                        'Reliability', 'max_retries', fallback=max_tries
                    )
                    actual_delay = instance.config.getfloat(
                        'Reliability', 'retry_delay', fallback=delay_seconds
                    )
                except Exception:
                    pass

            while tries < actual_max_tries:
                try:
                    # Ensure driver session is valid before executing
                    if instance and hasattr(instance, "_ensure_driver_session"):
                        # Avoid recursive restart loops for login/re-auth flows.
                        if func.__name__ != "login":
                            instance._ensure_driver_session(func.__name__)
                    return func(*args, **kwargs)

                except retry_exceptions as e:
                    tries += 1
                    handled = False

                    # Check if this is a session-lost error
                    if instance and hasattr(instance, "_handle_driver_exception"):
                        handled = instance._handle_driver_exception(e, func.__name__)

                    if tries == actual_max_tries:
                        if instance and hasattr(instance, "logger"):
                            instance.logger.error(
                                f"Failed after {actual_max_tries} attempts: {e}"
                            )
                        raise

                    wait_time = actual_delay * (backoff_multiplier ** (tries - 1))

                    if instance and hasattr(instance, "logger"):
                        if handled:
                            instance.logger.warning(
                                f"Retrying {func.__name__} after session recovery. "
                                f"Waiting {wait_time:.1f}s... (attempt {tries}/{actual_max_tries})"
                            )
                        else:
                            instance.logger.warning(
                                f"Retrying {func.__name__} after error: {e}. "
                                f"Waiting {wait_time:.1f}s... (attempt {tries}/{actual_max_tries})"
                            )
                    time.sleep(wait_time)

            return None
        return wrapper  # type: ignore
    return decorator


def timed(func: F) -> F:
    """
    Decorator that logs the execution time of a function.

    Args:
        func: Function to wrap

    Returns:
        Wrapped function that logs timing
    """
    @functools.wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        start = time.perf_counter()
        instance = args[0] if args else None
        logger = getattr(instance, 'logger', None) or logging.getLogger('emr_automation')

        try:
            result = func(*args, **kwargs)
            elapsed = time.perf_counter() - start
            logger.info(f"{func.__name__} completed in {elapsed:.2f}s")
            return result
        except Exception as e:
            elapsed = time.perf_counter() - start
            logger.error(f"{func.__name__} failed after {elapsed:.2f}s: {e}")
            raise
    return wrapper  # type: ignore


@contextlib.contextmanager
def switch_to_iframe(
    driver: WebDriver,
    locator: Tuple[Any, str],
    timeout: int = 30,
) -> Generator[WebElement, None, None]:
    """
    Context manager for switching to an iframe and back (Selenium).

    Args:
        driver: Selenium WebDriver instance
        locator: Tuple of (By method, locator string)
        timeout: Timeout in seconds for finding the iframe

    Yields:
        The iframe element

    Example:
        with switch_to_iframe(driver, (By.XPATH, '//iframe')) as iframe:
            # Interact with content inside iframe
            ...
        # Automatically switched back to default content
    """
    if not SELENIUM_AVAILABLE:
        raise RuntimeError("Selenium is not available. Use switch_to_iframe_playwright instead.")

    iframe = WebDriverWait(driver, timeout).until(
        EC.presence_of_element_located(locator)
    )
    driver.switch_to.frame(iframe)
    try:
        yield iframe
    finally:
        driver.switch_to.default_content()


@contextlib.contextmanager
def switch_to_iframe_playwright(
    page: Page,
    selector: str,
    timeout: int = 30,
) -> Generator[FrameLocator, None, None]:
    """
    Context manager for working within an iframe (Playwright).

    With Playwright, frame_locator scopes operations to the iframe
    automatically - no explicit switching back needed.

    Args:
        page: Playwright Page instance
        selector: CSS/XPath selector for the iframe
        timeout: Timeout in seconds for finding the iframe

    Yields:
        FrameLocator for interacting with iframe content

    Example:
        with switch_to_iframe_playwright(page, '#my-iframe') as frame:
            frame.locator('button').click()
        # No manual switch back needed
    """
    if not PLAYWRIGHT_AVAILABLE:
        raise RuntimeError("Playwright is not available. Use switch_to_iframe instead.")

    frame = page.frame_locator(selector)
    # Wait for iframe body to be ready
    frame.locator("body").wait_for(state="attached", timeout=timeout * 1000)
    yield frame


def extract_intern_id_from_url(url: str) -> Optional[str]:
    """
    Extract intern_id from a URL.

    Args:
        url: URL containing intern_id parameter

    Returns:
        The intern_id or None if not found
    """
    parsed = urlparse(url)
    values = parse_qs(parsed.query).get("intern_id")
    if not values:
        return None
    intern_id = values[0].strip()
    return intern_id or None


def wait_for_element_with_retry(
    driver: WebDriver,
    locator: Tuple[Any, str],
    timeout: int = 30,
    poll_frequency: float = 0.5,
) -> Optional[WebElement]:
    """
    Wait for an element with built-in retry logic.

    Args:
        driver: Selenium WebDriver instance
        locator: Tuple of (By method, locator string)
        timeout: Maximum wait time in seconds
        poll_frequency: How often to poll for the element

    Returns:
        WebElement if found, None otherwise
    """
    try:
        return WebDriverWait(driver, timeout, poll_frequency=poll_frequency).until(
            EC.presence_of_element_located(locator)
        )
    except TimeoutException:
        return None


def safe_click(
    driver: WebDriver,
    element: WebElement,
    scroll_first: bool = True,
    use_js: bool = False,
) -> bool:
    """
    Safely click an element with optional scrolling and JS fallback.

    Args:
        driver: Selenium WebDriver instance
        element: Element to click
        scroll_first: Whether to scroll element into view first
        use_js: Whether to use JavaScript click instead of native

    Returns:
        True if click succeeded, False otherwise
    """
    try:
        if scroll_first:
            driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", element)
            time.sleep(0.3)  # Brief pause for scroll animation

        if use_js:
            driver.execute_script("arguments[0].click();", element)
        else:
            element.click()
        return True
    except Exception:
        # Try JS click as fallback
        try:
            driver.execute_script("arguments[0].click();", element)
            return True
        except Exception:
            return False


def normalize_text(text: str) -> str:
    """
    Normalize text for fuzzy matching.
    - Lowercase
    - Remove accents
    - Remove extra whitespace
    
    Args:
        text: Input string
        
    Returns:
        Normalized string
    """
    if not text:
        return ""
        
    import unicodedata

    # Normalize unicode characters (split accents from letters)
    text = unicodedata.normalize('NFD', text)
    # Filter out non-spacing mark characters (accents)
    text = "".join(c for c in text if unicodedata.category(c) != 'Mn')
    # Lowercase and strip
    return " ".join(text.lower().split())


# ==============================================================================
# GUI-SAFE DIALOGS (works in headless mode)
# ==============================================================================

def _has_display() -> bool:
    """Check if a display is available for GUI dialogs."""
    if sys.platform == "darwin":
        # macOS always has a display when running locally
        return True
    # Check DISPLAY env var on Linux
    return bool(os.environ.get("DISPLAY"))


def show_message(title: str, message: str, level: str = "info") -> None:
    """
    Show a message dialog if display available, otherwise print to console.

    Args:
        title: Dialog title
        message: Message content
        level: One of "info", "warning", "error"
    """
    if _has_display():
        try:
            from tkinter import messagebox
            import tkinter as tk
            # Create hidden root window if none exists
            try:
                root = tk._default_root
                if root is None:
                    root = tk.Tk()
                    root.withdraw()
            except Exception:
                pass

            if level == "error":
                messagebox.showerror(title, message)
            elif level == "warning":
                messagebox.showwarning(title, message)
            else:
                messagebox.showinfo(title, message)
            return
        except Exception:
            pass

    # Fallback to console
    prefix = {"info": "INFO", "warning": "WARNING", "error": "ERROR"}.get(level, "INFO")
    print(f"[{prefix}] {title}: {message}")


def ask_yes_no(title: str, message: str) -> bool:
    """
    Ask a yes/no question if display available, otherwise default to False.

    Args:
        title: Dialog title
        message: Question to ask

    Returns:
        True for yes, False for no (defaults to False in headless mode)
    """
    if _has_display():
        try:
            from tkinter import messagebox
            import tkinter as tk
            # Create hidden root window if none exists
            try:
                root = tk._default_root
                if root is None:
                    root = tk.Tk()
                    root.withdraw()
            except Exception:
                pass

            return messagebox.askyesno(title, message)
        except Exception:
            pass

    # Fallback: print question and return False (safe default)
    print(f"[QUESTION] {title}: {message}")
    print("[AUTO-ANSWER] No (headless mode)")
    return False
