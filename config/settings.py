"""
全局配置管理模块
管理应用所有可配置参数，支持JSON文件持久化和默认值回退
"""
import json
import os
from pathlib import Path
from typing import Any, Optional
from dataclasses import dataclass, field, asdict


@dataclass
class ScraperConfig:
    """采集器配置"""
    request_interval: float = 2.0          # 请求间隔（秒）
    max_retries: int = 3                   # 最大重试次数
    scroll_delay: float = 1.5              # 滚动加载延迟
    max_comments_per_item: int = 500       # 单条内容最大评论数
    concurrent_tasks: int = 3              # 并发采集任务数
    headless: bool = True                  # 浏览器无头模式
    simulate_human: bool = True            # 是否模拟真人操作
    random_delay_range: tuple = (1.0, 3.0) # 随机延迟范围


@dataclass
class LLMConfig:
    """大模型配置"""
    provider: str = "tongyi"               # 默认模型: tongyi / wenxin / openai / deepseek / kimi
    tongyi_api_key: str = ""
    tongyi_model: str = "qwen-turbo"
    wenxin_api_key: str = ""
    wenxin_secret_key: str = ""
    wenxin_model: str = "ernie-3.5"
    openai_api_key: str = ""
    openai_model: str = "gpt-3.5-turbo"
    deepseek_api_key: str = ""
    deepseek_model: str = "deepseek-chat"
    kimi_api_key: str = ""
    kimi_model: str = "moonshot-v1-8k"
    temperature: float = 0.3
    max_tokens: int = 500
    enable_llm_check: bool = True          # 是否启用大模型校验


@dataclass
class KeywordConfig:
    """意向关键词配置"""
    high_intent: list = field(default_factory=lambda: [
        # 直接购买意图
        "想买", "求链接", "多少钱", "哪里买", "入手", "下单",
        "购买", "我要", "链接发我", "怎么买", "价格多少",
        "买一个", "来一个", "搞一个", "在哪买", "求购",
        # 询价询渠道
        "怎么卖", "卖吗", "有卖吗", "报价", "包邮吗",
        "有链接吗", "私我", "私信", "联系我", "加微信",
        "加我", "哪里卖", "有货吗", "能发货吗", "接单吗",
        "联系方式", "店铺名", "店铺", "上车", "拼单",
        "拼团", "团购", "代购", "代买", "转卖吗",
        # 明确购买动作
        "已下单", "已买", "买了", "刚下单", "拍下了",
        "付了", "付款", "秒了", "冲了", "已拍",
        "拿下", "带一个", "带一件", "帮忙带", "代购费",
        # 强烈意向
        "必须买", "一定要买", "非买不可", "必入", "果断入手",
        "立马下单", "马上下单", "立刻下单", "马上下单",
        "太想买了", "好想买", "真想要", "求推荐链接",
        "谁能代", "有偿代", "蹲链接", "等链接", "上链接",
    ])
    medium_intent: list = field(default_factory=lambda: [
        # 犹豫考虑中
        "考虑入手", "想入手", "想买但", "纠结要不要",
        "要不要买", "犹豫", "到底买不买", "想冲",
        # 产品询问
        "好用吗", "值得买吗", "推荐吗", "质量怎么样",
        "效果如何", "性价比", "适合吗", "实用吗",
        "耐用吗", "会不会", "容易坏吗", "保修",
        "售后", "退换", "安全吗", "靠谱吗", "真的假的",
        # 对比研究
        "对比", "比较", "和", "哪个好", "区别",
        "选哪个", "二选一", "纠结中", "在考虑",
        # 价格关注
        "看看价格", "什么价", "贵吗", "便宜吗",
        "有优惠吗", "能便宜点吗", "打折吗", "包邮",
        "最低多少", "预算", "有点贵", "便宜点",
        # 购买倾向
        "有点心动", "感兴趣", "想了解", "想试试",
        "打算买", "准备入手", "种草", "长草",
        "被种草", "看起来不错", "好像不错", "貌似不错",
        "想搞", "想整一个", "想弄一个", "有点想要",
    ])
    low_intent: list = field(default_factory=lambda: [
        # 关注/兴趣
        "收藏", "先看看", "观望", "等等", "下次一定",
        "看看", "不错", "喜欢", "想要", "羡慕",
        "先马", "码住", "马克", "标记", "留名",
        "占位", "先记下", "记下来", "存着", "存了",
        # 轻度兴趣
        "好看", "真好", "厉害", "牛", "赞",
        "种草了", "心动", "爱了", "想要同款", "求同款",
        "哪里能", "什么牌子", "哪个牌子", "啥牌子",
        "关注了", "已关注", "先关注", "好的", "可",
        "可以有", "有意思", "好玩", "长见识", "学到了",
        # 观望/等待
        "等降价", "等优惠", "等等看", "再观望", "先不急",
        "到时候", "等有钱", "攒钱", "蹲一个", "蹲一波",
        "期待", "期待一下", "坐等", "等待",
    ])


@dataclass
class ExportConfig:
    """导出配置"""
    default_format: str = "xlsx"           # xlsx / csv
    default_fields: list = field(default_factory=lambda: [
        "user_id", "nickname", "gender", "comment_text",
        "comment_time", "intent_level", "platform", "source_url"
    ])
    auto_open_after_export: bool = True


@dataclass
class NetworkConfig:
    """联网部署配置"""
    mode: str = "local"                    # local / server
    server_host: str = "127.0.0.1"
    server_port: int = 8765
    username: str = ""
    password: str = ""
    sync_enabled: bool = False


@dataclass
class SearchConfig:
    """搜索配置"""
    max_results_per_platform: int = 20
    search_timeout: int = 30
    enable_web_search: bool = True
    platforms: tuple = ("douyin", "bilibili", "xiaohongshu", "youtube", "instagram", "facebook")


@dataclass
class SecurityConfig:
    """安全配置"""
    password_protected: bool = False
    app_password_hash: str = ""
    encrypt_api_keys: bool = True


@dataclass
class AppConfig:
    """应用总配置"""
    scraper: ScraperConfig = field(default_factory=ScraperConfig)
    llm: LLMConfig = field(default_factory=LLMConfig)
    keywords: KeywordConfig = field(default_factory=KeywordConfig)
    export: ExportConfig = field(default_factory=ExportConfig)
    network: NetworkConfig = field(default_factory=NetworkConfig)
    search: SearchConfig = field(default_factory=SearchConfig)
    security: SecurityConfig = field(default_factory=SecurityConfig)
    first_run: bool = True
    language: str = "zh-CN"


class AppSettings:
    """配置管理器（单例模式）"""

    _instance: Optional["AppSettings"] = None
    _config: AppConfig = None

    def __new__(cls) -> "AppSettings":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._config = AppConfig()
            cls._instance._config_path = cls._instance._get_config_path()
        return cls._instance

    @staticmethod
    def _get_config_path() -> Path:
        """获取配置文件路径（存储在用户目录下）"""
        config_dir = Path.home() / ".client_lead_miner"
        config_dir.mkdir(parents=True, exist_ok=True)
        return config_dir / "config.json"

    @staticmethod
    def get_data_dir() -> Path:
        """获取数据存储目录"""
        data_dir = Path.home() / ".client_lead_miner" / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        return data_dir

    @staticmethod
    def get_log_dir() -> Path:
        """获取日志存储目录"""
        log_dir = Path.home() / ".client_lead_miner" / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        return log_dir

    @property
    def config(self) -> AppConfig:
        return self._config

    def load(self) -> AppConfig:
        """从文件加载配置，文件不存在时使用默认值"""
        if self._config_path.exists():
            try:
                with open(self._config_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self._merge_config(data)
            except (json.JSONDecodeError, KeyError):
                pass
        return self._config

    def save(self) -> None:
        """保存配置到文件"""
        config_dict = self._to_dict()
        with open(self._config_path, "w", encoding="utf-8") as f:
            json.dump(config_dict, f, ensure_ascii=False, indent=2)

    def _merge_config(self, data: dict) -> None:
        """将JSON数据合并到配置对象"""
        if "scraper" in data:
            for k, v in data["scraper"].items():
                if hasattr(self._config.scraper, k):
                    setattr(self._config.scraper, k, v)
        if "llm" in data:
            for k, v in data["llm"].items():
                if hasattr(self._config.llm, k):
                    setattr(self._config.llm, k, v)
        if "keywords" in data:
            for k, v in data["keywords"].items():
                if hasattr(self._config.keywords, k):
                    setattr(self._config.keywords, k, v)
        if "export" in data:
            for k, v in data["export"].items():
                if hasattr(self._config.export, k):
                    setattr(self._config.export, k, v)
        if "network" in data:
            for k, v in data["network"].items():
                if hasattr(self._config.network, k):
                    setattr(self._config.network, k, v)
        if "search" in data:
            for k, v in data["search"].items():
                if hasattr(self._config.search, k):
                    setattr(self._config.search, k, v)
        if "security" in data:
            for k, v in data["security"].items():
                if hasattr(self._config.security, k):
                    setattr(self._config.security, k, v)
        if "first_run" in data:
            self._config.first_run = data["first_run"]
        if "language" in data:
            self._config.language = data["language"]

    def _to_dict(self) -> dict:
        """将配置对象序列化为字典"""
        return {
            "scraper": asdict(self._config.scraper),
            "llm": asdict(self._config.llm),
            "keywords": asdict(self._config.keywords),
            "export": asdict(self._config.export),
            "network": asdict(self._config.network),
            "search": asdict(self._config.search),
            "security": asdict(self._config.security),
            "first_run": self._config.first_run,
            "language": self._config.language,
        }

    def reset(self) -> None:
        """重置为默认配置"""
        self._config = AppConfig()
        self.save()


# 全局快捷访问函数
def get_settings() -> AppSettings:
    return AppSettings()
