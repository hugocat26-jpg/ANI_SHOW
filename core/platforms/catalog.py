"""Platform catalog and expansion planning helpers."""
from __future__ import annotations

from dataclasses import dataclass

from .base import PlatformCapability, PlatformSpec
from .registry import PlatformRegistry, platform_registry


@dataclass(frozen=True)
class PlatformIntegrationTarget:
    key: str
    name: str
    category: str
    priority: int
    requires_login: bool = False
    notes: str = ""


DEFAULT_EXPANSION_TARGETS = (
    PlatformIntegrationTarget("google", "Google", "search_engine", 1, notes="国际搜索引擎入口"),
    PlatformIntegrationTarget("tiktok", "TikTok", "social", 1, True, "海外短视频主平台"),
    PlatformIntegrationTarget("twitter", "X/Twitter", "social", 2, True, "海外热点与品牌讨论"),
    PlatformIntegrationTarget("reddit", "Reddit", "forum", 2, False, "海外社区需求发现"),
    PlatformIntegrationTarget("weibo", "微博", "social", 2, True, "国内公开话题和评论"),
    PlatformIntegrationTarget("zhihu", "知乎", "forum", 2, True, "问答场景线索"),
    PlatformIntegrationTarget("kuaishou", "快手", "social", 2, True, "国内短视频补充"),
    PlatformIntegrationTarget("wechat_channels", "视频号", "social", 3, True, "生态封闭，需人工登录与合规限制"),
)


class PlatformCatalog:
    """Read-only platform capability inventory used by UI and planning."""

    def __init__(self, registry: PlatformRegistry = platform_registry):
        self.registry = registry

    def supported(self) -> list[PlatformSpec]:
        return self.registry.list_specs()

    def by_capability(self, capability: PlatformCapability) -> list[PlatformSpec]:
        return [spec for spec in self.supported() if capability in spec.capabilities]

    def expansion_targets(self) -> list[PlatformIntegrationTarget]:
        existing = set(self.registry.keys())
        targets = [target for target in DEFAULT_EXPANSION_TARGETS if target.key not in existing]
        return sorted(targets, key=lambda item: (item.priority, item.key))

    def capability_matrix(self) -> list[dict]:
        rows = []
        for spec in self.supported():
            rows.append({
                "key": spec.key,
                "name": spec.name,
                "category": spec.category,
                "requires_login": spec.requires_login,
                "capabilities": sorted(capability.value for capability in spec.capabilities),
            })
        return rows
