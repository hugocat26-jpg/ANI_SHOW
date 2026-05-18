from .logger import Logger, LogLevel
from .compliance import ComplianceChecker
from .validators import LinkValidator


def __getattr__(name):
    if name == "CryptoUtil":
        from .crypto import CryptoUtil
        return CryptoUtil
    raise AttributeError(name)
