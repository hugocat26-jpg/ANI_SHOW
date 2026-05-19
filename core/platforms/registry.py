"""平台适配器注册表。"""
from __future__ import annotations

from typing import Iterable

from .base import PlatformAdapter, PlatformSpec


class PlatformRegistry:
    """集中管理平台元信息和适配器类。"""

    def __init__(self):
        self._adapters: dict[str, type[PlatformAdapter]] = {}
        self._specs: dict[str, PlatformSpec] = {}

    def register(self, adapter_cls: type[PlatformAdapter]) -> None:
        spec = adapter_cls.spec
        self._adapters[spec.key] = adapter_cls
        self._specs[spec.key] = spec

    def get_spec(self, key: str) -> PlatformSpec | None:
        return self._specs.get(key)

    def list_specs(self, category: str | None = None) -> list[PlatformSpec]:
        specs = list(self._specs.values())
        if category:
            specs = [spec for spec in specs if spec.category == category]
        return sorted(specs, key=lambda spec: spec.key)

    def create(self, key: str, settings=None) -> PlatformAdapter:
        adapter_cls = self._adapters.get(key)
        if not adapter_cls:
            raise ValueError(f"未注册的平台适配器: {key}")
        return adapter_cls(settings=settings)

    def keys(self) -> Iterable[str]:
        return self._specs.keys()


platform_registry = PlatformRegistry()
