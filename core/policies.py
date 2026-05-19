"""Business policies shared by UI, server mode, and future automation jobs."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from core.platforms import PlatformSpec
from utils.compliance import ComplianceChecker


@dataclass(frozen=True)
class PolicyDecision:
    allowed: bool
    reason: str = ""


class CompliancePolicy:
    """Central place for data, platform, and export policy decisions."""

    def __init__(self, daily_limit: int = 10000):
        self.daily_limit = daily_limit

    def can_collect_platform(self, spec: PlatformSpec, daily_count: int = 0) -> PolicyDecision:
        if not ComplianceChecker.check_usage_limit(daily_count, self.daily_limit):
            return PolicyDecision(False, "已达到单日合规采集上限")
        if spec.requires_login and not spec.login_url:
            return PolicyDecision(False, f"{spec.name} 需要登录但未配置登录入口")
        return PolicyDecision(True, "")

    def filter_export_record(self, record: dict) -> dict:
        return ComplianceChecker.filter_private_fields(record)

    def filter_export_records(self, records: Iterable[dict]) -> list[dict]:
        return [self.filter_export_record(record) for record in records]

    def validate_requested_fields(self, fields: Iterable[str]) -> PolicyDecision:
        ok, violations = ComplianceChecker.check_fields(list(fields))
        if not ok:
            return PolicyDecision(False, f"包含隐私字段: {', '.join(violations)}")
        return PolicyDecision(True, "")
