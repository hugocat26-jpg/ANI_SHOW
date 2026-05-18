"""
数据模型定义
定义了线索、日志、任务等核心数据结构
"""
from dataclasses import dataclass, field, asdict
from datetime import datetime
from enum import Enum
from typing import Optional


class TaskStatus(Enum):
    """采集任务状态"""
    PENDING = "pending"         # 等待中
    PARSING = "parsing"         # 解析中
    RUNNING = "running"         # 采集中
    PAUSED = "paused"           # 已暂停
    COMPLETED = "completed"     # 已完成
    FAILED = "failed"           # 失败
    STOPPED = "stopped"         # 已停止


class IntentLevel(Enum):
    """意向等级"""
    HIGH = "高"       # 高意向：明确表达购买意图
    MEDIUM = "中"     # 中意向：犹豫或对比中
    LOW = "低"        # 低意向：仅表达兴趣
    NONE = "无"       # 无意向


@dataclass
class CommentInfo:
    """评论信息"""
    comment_id: str                          # 评论唯一ID
    platform: str                            # 平台标识
    platform_name: str                       # 平台中文名
    content_url: str                         # 来源内容链接
    content_id: str                          # 内容ID（视频ID/图文ID）
    content_type: str = "video"              # 内容类型：video / image_text
    user_id: str = ""                        # 用户ID
    nickname: str = ""                       # 用户昵称
    gender: str = "未知"                     # 性别（平台公开显示）
    comment_text: str = ""                   # 评论内容
    comment_time: str = ""                   # 评论时间
    likes: int = 0                           # 点赞数
    is_reply: bool = False                   # 是否为回复评论
    reply_to: str = ""                       # 被回复者昵称

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class LeadInfo:
    """客户线索信息"""
    id: Optional[int] = None                 # 数据库自增ID
    user_id: str = ""                        # 用户ID（平台唯一标识）
    nickname: str = ""                       # 用户昵称
    gender: str = "未知"                     # 性别
    comment_text: str = ""                   # 意向评论内容
    comment_time: str = ""                   # 评论时间
    intent_level: IntentLevel = IntentLevel.NONE  # 意向等级
    intent_keywords: str = ""                # 匹配到的关键词（逗号分隔）
    llm_verified: bool = False               # 是否经过大模型校验
    llm_analysis: str = ""                   # 大模型分析结果
    platform: str = ""                       # 平台标识
    platform_name: str = ""                  # 平台中文名
    source_url: str = ""                     # 来源内容链接
    content_id: str = ""                     # 内容ID
    content_type: str = "video"              # 内容类型
    likes: int = 0                           # 评论点赞数
    collected_at: str = ""                   # 采集时间
    notes: str = ""                          # 手动备注
    manually_marked: bool = False            # 是否手动标记
    is_duplicate: bool = False               # 是否重复

    def to_dict(self) -> dict:
        d = asdict(self)
        d["intent_level"] = self.intent_level.value if isinstance(self.intent_level, IntentLevel) else self.intent_level
        return d

    def to_export_dict(self, fields: Optional[list] = None) -> dict:
        """转换为导出格式，支持字段筛选"""
        full_dict = {
            "用户ID": self.user_id,
            "昵称": self.nickname,
            "性别": self.gender,
            "意向评论": self.comment_text,
            "评论时间": self.comment_time,
            "意向等级": self.intent_level.value if isinstance(self.intent_level, IntentLevel) else self.intent_level,
            "匹配关键词": self.intent_keywords,
            "大模型校验": "是" if self.llm_verified else "否",
            "大模型分析": self.llm_analysis,
            "平台": self.platform_name,
            "来源链接": self.source_url,
            "点赞数": self.likes,
            "采集时间": self.collected_at,
            "备注": self.notes,
        }
        if fields:
            return {k: v for k, v in full_dict.items() if k in fields}
        return full_dict


@dataclass
class LogEntry:
    """日志条目"""
    time: str
    level: str
    message: str


@dataclass
class CollectTask:
    """采集任务定义"""
    task_id: str
    url: str
    platform: str
    platform_name: str
    content_type: str
    content_id: str
    status: TaskStatus = TaskStatus.PENDING
    total_comments: int = 0
    collected_comments: int = 0
    intent_count: int = 0
    error_message: str = ""
    created_at: str = field(default_factory=lambda: datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    updated_at: str = ""


@dataclass
class SearchResult:
    """搜索结果"""
    url: str
    title: str = ""
    platform: str = ""
    platform_name: str = ""
    content_type: str = "video"
    snippet: str = ""
    relevance: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class CompanyInfo:
    """公司信息"""
    name: str = ""
    website: str = ""
    email: str = ""
    phone: str = ""
    address: str = ""
    description: str = ""
    social_links: str = ""
    source: str = ""
    created_at: str = field(default_factory=lambda: datetime.now().strftime("%Y-%m-%d %H:%M:%S"))

    def to_dict(self) -> dict:
        return asdict(self)
