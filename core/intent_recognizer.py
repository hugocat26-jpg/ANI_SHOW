"""
意向识别模块
通过"关键词匹配 + 大模型校验"双重机制识别购买意向评论
"""
import re
from typing import Optional

from storage.models import CommentInfo, LeadInfo, IntentLevel
from llm.base import BaseLLM
from config.settings import get_settings
from utils.logger import Logger


class IntentRecognizer:
    """意向识别器 — 关键词粗筛 + 大模型精筛"""

    # 购买意图正则模式（补充纯文本关键词匹配的盲区）
    PRICE_PATTERNS = [
        re.compile(r"多少?[钱米元块]"),          # 多少钱/多少米/多少块
        re.compile(r"[钱价][格位]?[是多少]"),     # 价格多少/价钱多少
        re.compile(r"[多啥什么][少]?[钱米]"),     # 多钱/多少钱/啥价
        re.compile(r"报价|价格|价位"),            # 报价/价格/价位
    ]
    BUY_PATTERNS = [
        re.compile(r"想[要买搞入整弄弄个整一].*"),   # 想要/想买/想搞/想入
        re.compile(r"求[购买链接推].*"),             # 求购/求链接/求推
        re.compile(r"[哪有]?[里能]?[买搞入弄整].*"),  # 哪里买/能买吗/搞一个
        re.compile(r"[上下]单|下单|拍[了下]|付款"),   # 下单/拍下/付款
        re.compile(r"已?[买拍入手搞].*[了啦]"),       # 买了/拍了/入手了
    ]
    CONTACT_PATTERNS = [
        re.compile(r"私[我信聊]|联系|加[我微信Vv]"),  # 私我/加我/加微信
        re.compile(r"联系[方式方]|店铺名|链接"),      # 联系方式/店铺名/链接
    ]

    def __init__(self, llm: Optional[BaseLLM] = None):
        self.llm = llm
        self.logger = Logger()
        self._load_keywords()

    def _load_keywords(self) -> None:
        """加载关键词配置"""
        config = get_settings().config.keywords
        self.high_keywords = set(config.high_intent)
        self.medium_keywords = set(config.medium_intent)
        self.low_keywords = set(config.low_intent)

    def reload_keywords(self) -> None:
        """重新加载关键词（配置更新后调用）"""
        self._load_keywords()

    # ==================== 主识别流程 ====================

    def recognize(self, comment: CommentInfo) -> Optional[LeadInfo]:
        """
        识别单条评论的购买意向
        1. 关键词 + 正则模式初筛
        2. 大模型语义分析（可选）
        3. 意向度分级合并
        """
        comment_text = comment.comment_text
        if not comment_text or len(comment_text) < 2:
            return None

        # 第一步：关键词 + 正则双重匹配
        matched_keywords = self._match_keywords(comment_text)
        regex_level = self._match_regex_patterns(comment_text)

        if not matched_keywords and not regex_level:
            return None  # 完全无关，跳过

        # 关键词等级 vs 正则等级，取较高者
        keyword_level = self._keyword_intent_level(matched_keywords) if matched_keywords else "低"
        preliminary_level = self._higher_level(keyword_level, regex_level) if regex_level else keyword_level

        # 第二步：大模型校验
        llm_verified = False
        llm_analysis = ""
        final_level = preliminary_level

        if self.llm:
            try:
                llm_config = get_settings().config.llm
                if llm_config.enable_llm_check:
                    llm_response = self.llm.analyze_intent(comment_text)
                    if llm_response.success:
                        llm_verified = True
                        llm_analysis = llm_response.analysis
                        final_level = self._merge_intent_level(
                            preliminary_level, llm_response.intent_level, llm_response.confidence
                        )
            except Exception as e:
                self.logger.debug(f"LLM校验失败: {str(e)[:100]}")

        # 构建 LeadInfo
        intent_keywords_str = ",".join(matched_keywords) if matched_keywords else f"regex:{regex_level}"
        lead = LeadInfo(
            user_id=comment.user_id,
            nickname=comment.nickname,
            gender=comment.gender,
            comment_text=comment_text,
            comment_time=comment.comment_time,
            intent_level=IntentLevel(final_level),
            intent_keywords=intent_keywords_str,
            llm_verified=llm_verified,
            llm_analysis=llm_analysis,
            platform=comment.platform,
            platform_name=comment.platform_name,
            source_url=comment.content_url,
            content_id=comment.content_id,
            content_type=comment.content_type,
            likes=comment.likes,
        )
        return lead

    # ==================== 关键词匹配 ====================

    def _match_keywords(self, text: str) -> list[str]:
        """匹配意向关键词（包含子串匹配）"""
        matched = []
        # 优先匹配高意向关键词
        for kw in self.high_keywords:
            if kw in text:
                matched.append(kw)
        for kw in self.medium_keywords:
            if kw in text:
                matched.append(kw)
        for kw in self.low_keywords:
            if kw in text:
                matched.append(kw)
        return matched

    # ==================== 正则模式匹配（新增）====================

    def _match_regex_patterns(self, text: str) -> Optional[str]:
        """
        用正则模式补充纯文本关键词匹配的盲区
        返回匹配到的最高意向等级，无匹配返回 None
        """
        # 询价 → 高意向
        for p in self.PRICE_PATTERNS:
            if p.search(text):
                return "高"
        # 明确购买 → 高意向
        for p in self.BUY_PATTERNS:
            if p.search(text):
                return "高"
        # 联系方式 → 高意向
        for p in self.CONTACT_PATTERNS:
            if p.search(text):
                return "高"
        return None

    # ==================== 等级判定 ====================

    def _keyword_intent_level(self, keywords: list[str]) -> str:
        """根据匹配到的关键词判断意向等级"""
        for k in keywords:
            if k in self.high_keywords:
                return "高"
        for k in keywords:
            if k in self.medium_keywords:
                return "中"
        for k in keywords:
            if k in self.low_keywords:
                return "低"
        return "低"

    @staticmethod
    def _higher_level(a: str, b: str) -> str:
        """返回两个等级中较高者"""
        order = {"高": 3, "中": 2, "低": 1, "无": 0}
        return "高" if order.get(a, 0) >= 3 or order.get(b, 0) >= 3 else \
               "中" if order.get(a, 0) >= 2 or order.get(b, 0) >= 2 else \
               "低"

    # ==================== 大模型结果合并 ====================

    def _merge_intent_level(self, keyword_level: str, llm_level: str, confidence: float) -> str:
        """
        合并关键词和大模型的意向判断结果
        策略：大模型善于排除误报，但不轻易否定关键词的发现
        """
        level_order = {"高": 3, "中": 2, "低": 1, "无": 0}
        kw_score = level_order.get(keyword_level, 0)
        llm_score = level_order.get(llm_level, 0)

        # 大模型高置信度（>0.85）→ 以大模型为准
        if confidence > 0.85:
            return llm_level

        # 两者一致 → 直接返回
        if keyword_level == llm_level:
            return keyword_level

        # 大模型判定为"无"但关键词匹配到 → 不直接否定，降一级处理
        # 因为大模型可能对某些口语化表达理解偏差
        if llm_level == "无" and kw_score > 0:
            if kw_score >= 3:       # 关键词高意向 → 降为中
                return "中"
            elif kw_score == 2:     # 关键词中意向 → 降为低
                return "低"
            else:                   # 关键词低意向 → 保留低
                return "低"

        # 大模型判定更高 → 采纳大模型（新发现了意图信号）
        if llm_score > kw_score:
            return llm_level

        # 大模型判定更低但非"无" → 取中间值
        reverse = {3: "高", 2: "中", 1: "低", 0: "无"}
        avg = round((kw_score + llm_score) / 2)
        return reverse.get(avg, keyword_level)
