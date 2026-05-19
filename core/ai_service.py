"""
统一 AI 服务层。

现有 LLM 类主要服务评论意向识别。该服务层把未来的关键词扩展、搜索结果
重排、线索评分、话术生成等能力集中到一个稳定入口，避免 UI 直接依赖各厂商模型。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

from llm.base import BaseLLM
from storage.models import LeadInfo, SearchResult


@dataclass
class LeadScore:
    score: int
    reason: str = ""
    suggested_action: str = ""


class AIService:
    """业务级 AI 能力门面。"""

    def __init__(self, llm: Optional[BaseLLM] = None):
        self.llm = llm

    def expand_keywords(self, keyword: str, locale: str = "zh-CN") -> list[str]:
        """生成搜索词扩展；无模型时使用可解释的规则兜底。"""
        base = keyword.strip()
        if not base:
            return []
        expansions = [
            base,
            f"{base} 推荐",
            f"{base} 怎么选",
            f"{base} 避坑",
            f"{base} 价格",
            f"{base} 好用吗",
            f"{base} 测评",
            f"{base} 求链接",
        ]
        if locale.lower().startswith("en"):
            expansions.extend([f"{base} review", f"best {base}", f"{base} price"])
        return list(dict.fromkeys(expansions))

    def rank_search_results(self, keyword: str, results: Iterable[SearchResult]) -> list[SearchResult]:
        """搜索结果排序。当前先用规则评分，后续可接 LLM/embedding。"""
        key = keyword.lower().strip()
        ranked: list[SearchResult] = []
        for result in results:
            text = f"{result.title} {result.snippet}".lower()
            score = result.relevance or 0.0
            if key and key in text:
                score += 0.5
            if any(signal in text for signal in ("推荐", "测评", "怎么买", "价格", "review", "best")):
                score += 0.2
            result.relevance = score
            ranked.append(result)
        return sorted(ranked, key=lambda item: item.relevance, reverse=True)

    def score_lead(self, lead: LeadInfo) -> LeadScore:
        """线索评分，先基于现有字段给出稳定兜底。"""
        intent_value = lead.intent_level.value if hasattr(lead.intent_level, "value") else str(lead.intent_level)
        base_scores = {"高": 90, "中": 65, "低": 35, "无": 0}
        score = base_scores.get(intent_value, 0)
        if lead.likes > 10:
            score += 5
        if lead.intent_keywords:
            score += 5
        score = max(0, min(100, score))
        action = "优先跟进" if score >= 80 else "加入跟进池" if score >= 50 else "低优先级观察"
        return LeadScore(score=score, reason=f"意向等级为{intent_value}", suggested_action=action)

    def generate_followup(self, lead: LeadInfo, product_info: str = "") -> str:
        """生成跟进话术。模型不可用时返回模板话术。"""
        text = lead.comment_text or ""
        intent_value = lead.intent_level.value if hasattr(lead.intent_level, "value") else str(lead.intent_level)
        if self.llm:
            try:
                return self.llm.generate_follow_up(text, intent_value, product_info)
            except Exception:
                pass
        nickname = lead.nickname or "您好"
        return f"{nickname}，看到您关注这个产品，我可以把价格、型号和购买方式整理给您，方便您对比选择。"

    def summarize_batch(self, leads: Iterable[LeadInfo]) -> str:
        leads = list(leads)
        total = len(leads)
        high = sum(1 for lead in leads if getattr(lead.intent_level, "value", lead.intent_level) == "高")
        medium = sum(1 for lead in leads if getattr(lead.intent_level, "value", lead.intent_level) == "中")
        return f"本批次共 {total} 条线索，其中高意向 {high} 条，中意向 {medium} 条。"
