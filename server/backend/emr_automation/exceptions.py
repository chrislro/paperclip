"""
Custom exceptions for EMR Automation.
"""


class EMRAutomationError(Exception):
    """Base exception for EMR automation errors."""
    pass


class SessionLostError(EMRAutomationError):
    """Raised when the WebDriver session is lost or invalid."""
    pass


class PatientNotFoundError(EMRAutomationError):
    """Raised when patient information cannot be found or extracted."""
    pass


class PrescriptionError(EMRAutomationError):
    """Raised when prescription processing fails."""
    pass


class LoginError(EMRAutomationError):
    """Raised when login fails."""
    pass


class AccountLockedError(Exception):
    """EMR account is locked by Devise after too many failed attempts.

    Deliberately does NOT inherit from EMRAutomationError, so the @retry
    decorator's default exception list does not catch and multiply attempts.
    """
    pass


class BadCredentialsError(Exception):
    """EMR rejected the submitted credentials (Devise "invalid email or password").

    Deliberately does NOT inherit from EMRAutomationError. Devise locks the
    account after 3 failed attempts; every retry against a wrong password
    is one strike closer to a lockout that requires IT to unlock. Callers
    MUST halt the script — no retry, no manual-login fallback.
    """
    pass


class ConfigurationError(EMRAutomationError):
    """Raised when configuration is invalid or missing."""
    pass


class PrintError(EMRAutomationError):
    """Raised when printing fails."""
    pass
