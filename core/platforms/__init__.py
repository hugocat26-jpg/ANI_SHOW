"""平台适配器公共入口。"""
from .base import PlatformAdapter, PlatformCapability, PlatformErrorCode, PlatformSpec, PlatformStatus
from .builtin import BUILTIN_PLATFORM_SPECS, register_builtin_platforms
from .catalog import PlatformCatalog, PlatformIntegrationTarget
from .registry import PlatformRegistry, platform_registry

__all__ = [
    "PlatformAdapter",
    "PlatformCatalog",
    "PlatformCapability",
    "PlatformErrorCode",
    "PlatformIntegrationTarget",
    "PlatformRegistry",
    "PlatformSpec",
    "PlatformStatus",
    "BUILTIN_PLATFORM_SPECS",
    "platform_registry",
    "register_builtin_platforms",
]
