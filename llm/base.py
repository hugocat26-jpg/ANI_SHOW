"""
大模型基类
定义统一的LLM调用接口，方便切换不同模型厂商
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional


@dataclass
class LLMResponse:
    """LLM返回结果"""
    success: bool
    intent_level: str = "无"           # 高/中/低/无
    confidence: float = 0.0             # 置信度 0-1
    analysis: str = ""                  # 分析说明
    keywords_matched: list = None       # 匹配到的购买意向关键词
    error_message: str = ""

    def __post_init__(self):
        if self.keywords_matched is None:
            self.keywords_matched = []


class BaseLLM(ABC):
    """LLM基础接口类"""

    def __init__(self, api_key: str, model: str = "", temperature: float = 0.3, max_tokens: int = 500):
        self.api_key = api_key
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens

    @abstractmethod
    def analyze_intent(self, comment_text: str, context: Optional[str] = None) -> LLMResponse:
        """
        分析评论的购买意向
        参数:
            comment_text: 评论内容
            context: 上下文（视频标题/图文内容等）
        返回: LLMResponse
        """
        ...

    def filter_search_results(self, keyword: str, results: list) -> list:
        """
        使用LLM判断搜索结果与关键词的相关性，返回过滤后的结果
        子类可覆盖以实现更精准的过滤
        """
        return results  # 默认不过滤

    def extract_company_info(self, html_text: str) -> dict:
        """
        从网页文本中提取结构化公司信息
        子类覆盖以实现实际提取逻辑
        """
        return {}  # 默认返回空

    @abstractmethod
    def generate_follow_up(self, comment_text: str, intent_level: str, product_info: str = "") -> str:
        """
        生成跟进话术（可选功能）
        参数:
            comment_text: 用户评论
            intent_level: 意向等级
            product_info: 产品信息
        返回: 跟进话术文本
        """
        ...

    @staticmethod
    def get_default_prompt(comment_text: str, context: str = "") -> str:
        """默认的意向分析提示词 — 偏向发现线索而非过滤"""
        prompt = f"""你是社交媒体销售线索分析专家。分析以下评论，判断用户是否对视频/图文中的产品有购买意向。

评论内容："{comment_text}"
{f"背景信息：{context}" if context else ""}

## 意向等级标准（宁可多抓，不要漏掉）

**高意向**（有明显购买信号）：
- 直接问价格/渠道："多少钱""哪里买""链接"
- 明确表达购买："想买""下单""我要""求购""拼单"
- 索要联系方式："私我""加微信""联系方式"
- 已购买反馈："已下单""买了""刚收到"

**中意向**（有购买倾向但不确定）：
- 询问产品体验/质量："好用吗""值得买吗""效果怎样"
- 犹豫对比："想要但""考虑中""和XX比哪个好"
- 价格敏感问询："有优惠吗""能便宜吗""包邮吗"
- 准备阶段："打算买""在看了""种草了想入手"

**低意向**（潜在兴趣，可能转化）：
- 表达好感："不错""喜欢""想要""好看""羡慕"
- 收藏/标记："先收藏""马克""码住""存了"
- 询问产品信息："什么牌子""哪有卖的""怎么买"
- 观望等待："等降价""到时候再说""先看看"

**无意向**：
- 纯吐槽、玩梗、刷存在感
- 讨论与产品无关的内容
- 替别人回答、科普

## 重要提醒

1. 社交媒体评论偏向口语化，"蹲一个""码住""上车"等网络用语都可能隐含购买意向
2. 询问产品信息类评论（"什么牌子""好用吗"）至少标记为中意向
3. 单纯表达喜欢但无行动的标记为低意向即可
4. 只有明确是调侃/与购买无关时才标记为无意向
5. **当不确定时，宁可升级不要降级**——后续人工会复核

请以JSON格式返回：
{{"intent_level": "高/中/低/无", "confidence": 0.0-1.0, "analysis": "一句话分析", "keywords": ["匹配到的购买信号词"]}}

仅返回JSON，不要添加其他内容。"""
        return prompt
