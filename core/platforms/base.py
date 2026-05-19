"""
平台适配器基础定义。

这一层只定义能力边界，不绑定具体 UI 或 Playwright 实现，便于后续接入
Google、TikTok、微博、知乎等平台时保持统一入口。
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

from storage.models import SearchResult


class PlatformCapability(str, Enum):
    """平台能力标识。"""

    SEARCH = "search"
    LOGIN = "login"
    STATUS = "status"
    COMMENTS = "comments"
    AUTHOR = "author"


class PlatformErrorCode(str, Enum):
    """统一平台错误码，供 UI、日志和重试策略复用。"""

    OK = "ok"
    LOGIN_REQUIRED = "login_required"
    CAPTCHA_REQUIRED = "captcha_required"
    RATE_LIMITED = "rate_limited"
    NETWORK_ERROR = "network_error"
    SELECTOR_CHANGED = "selector_changed"
    NO_RESULTS = "no_results"
    PARSE_ERROR = "parse_error"
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True)
class PlatformSpec:
    """平台元信息和能力描述。"""

    key: str
    name: str
    domains: tuple[str, ...]
    login_url: str = ""
    ping_url: str = ""
    requires_login: bool = False
    capabilities: frozenset[PlatformCapability] = field(default_factory=frozenset)
    category: str = "social"  # social / search_engine / ecommerce / forum


@dataclass
class PlatformStatus:
    """平台状态检测结果。"""

    platform: str
    available: bool
    logged_in: bool = False
    latency_ms: Optional[int] = None
    error_code: PlatformErrorCode = PlatformErrorCode.OK
    message: str = ""

    def to_dict(self) -> dict:
        return {
            "available": self.available,
            "logged_in": self.logged_in,
            "latency_ms": self.latency_ms,
            "error_code": self.error_code.value,
            "message": self.message,
        }


class PlatformAdapter(ABC):
    """平台适配器接口。"""

    spec: PlatformSpec

    def __init__(self, settings=None):
        self.settings = settings

    @abstractmethod
    def check_status(self) -> PlatformStatus:
        """检测平台登录态、可访问性和延迟。"""
        ...

    def login(self) -> bool:
        """打开登录流程。默认表示该平台不支持自动登录入口。"""
        raise NotImplementedError(f"{self.spec.name} 暂不支持登录流程")

    def search(self, keyword: str, max_results: int = 20) -> list[SearchResult]:
        """搜索内容。默认不支持，由具体平台覆盖。"""
        raise NotImplementedError(f"{self.spec.name} 暂不支持搜索")

    def supports(self, capability: PlatformCapability) -> bool:
        return capability in self.spec.capabilities
