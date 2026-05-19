"""内置平台元信息注册。"""
from __future__ import annotations

from core.searcher import check_platform_status, login_search_platform

from .base import PlatformAdapter, PlatformCapability, PlatformErrorCode, PlatformSpec, PlatformStatus
from .registry import platform_registry


class BuiltinStatusAdapter(PlatformAdapter):
    """复用现有状态检测/登录逻辑的过渡适配器。"""

    spec: PlatformSpec

    def check_status(self) -> PlatformStatus:
        raw = check_platform_status(self.spec.key)
        return PlatformStatus(
            platform=self.spec.key,
            available=bool(raw.get("available")),
            logged_in=bool(raw.get("logged_in")),
            latency_ms=raw.get("latency_ms"),
            error_code=PlatformErrorCode.OK if raw.get("available") else PlatformErrorCode.LOGIN_REQUIRED
            if self.spec.requires_login and not raw.get("logged_in") else PlatformErrorCode.NETWORK_ERROR,
            message=raw.get("message", ""),
        )

    def login(self) -> bool:
        if not self.spec.requires_login:
            return True
        login_search_platform(self.spec.key)
        return True


def _make_adapter(spec: PlatformSpec) -> type[BuiltinStatusAdapter]:
    return type(
        f"{spec.key.title().replace('_', '')}Adapter",
        (BuiltinStatusAdapter,),
        {"spec": spec},
    )


BUILTIN_PLATFORM_SPECS = [
    PlatformSpec(
        key="douyin",
        name="抖音",
        domains=("douyin.com", "iesdouyin.com"),
        login_url="https://www.douyin.com/",
        ping_url="https://www.douyin.com/",
        requires_login=True,
        capabilities=frozenset({PlatformCapability.SEARCH, PlatformCapability.LOGIN, PlatformCapability.STATUS, PlatformCapability.COMMENTS}),
    ),
    PlatformSpec(
        key="bilibili",
        name="B站",
        domains=("bilibili.com", "b23.tv"),
        ping_url="https://www.bilibili.com/",
        capabilities=frozenset({PlatformCapability.SEARCH, PlatformCapability.STATUS, PlatformCapability.COMMENTS}),
    ),
    PlatformSpec(
        key="xiaohongshu",
        name="小红书",
        domains=("xiaohongshu.com", "xhslink.com"),
        login_url="https://www.xiaohongshu.com/explore",
        ping_url="https://www.xiaohongshu.com/",
        requires_login=True,
        capabilities=frozenset({PlatformCapability.SEARCH, PlatformCapability.LOGIN, PlatformCapability.STATUS, PlatformCapability.COMMENTS}),
    ),
    PlatformSpec(
        key="youtube",
        name="YouTube",
        domains=("youtube.com", "youtu.be"),
        ping_url="https://www.youtube.com/",
        capabilities=frozenset({PlatformCapability.SEARCH, PlatformCapability.STATUS, PlatformCapability.COMMENTS}),
    ),
    PlatformSpec(
        key="instagram",
        name="Instagram",
        domains=("instagram.com",),
        login_url="https://www.instagram.com/",
        ping_url="https://www.instagram.com/",
        requires_login=True,
        capabilities=frozenset({PlatformCapability.SEARCH, PlatformCapability.LOGIN, PlatformCapability.STATUS, PlatformCapability.COMMENTS}),
    ),
    PlatformSpec(
        key="facebook",
        name="Facebook",
        domains=("facebook.com", "fb.com", "fb.watch"),
        login_url="https://zh-cn.facebook.com/",
        ping_url="https://zh-cn.facebook.com/",
        requires_login=True,
        capabilities=frozenset({PlatformCapability.SEARCH, PlatformCapability.LOGIN, PlatformCapability.STATUS, PlatformCapability.COMMENTS}),
    ),
    PlatformSpec(
        key="google",
        name="Google",
        domains=("google.com",),
        ping_url="https://www.google.com/",
        capabilities=frozenset({PlatformCapability.SEARCH, PlatformCapability.STATUS}),
        category="search_engine",
    ),
    PlatformSpec(
        key="bing",
        name="Bing",
        domains=("bing.com",),
        ping_url="https://www.bing.com/",
        capabilities=frozenset({PlatformCapability.SEARCH, PlatformCapability.STATUS}),
        category="search_engine",
    ),
]


def register_builtin_platforms() -> None:
    for spec in BUILTIN_PLATFORM_SPECS:
        platform_registry.register(_make_adapter(spec))


register_builtin_platforms()
