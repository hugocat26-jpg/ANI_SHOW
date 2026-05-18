"""
信息提取模块
从评论数据中提取标准化用户信息，进行去重处理
"""
from typing import Optional

from storage.models import CommentInfo, LeadInfo
from storage.database import Database
from utils.logger import Logger


class InfoExtractor:
    """信息提取器"""

    def __init__(self, database: Optional[Database] = None):
        self.database = database
        self.logger = Logger()

    def extract(self, comment: CommentInfo, lead: LeadInfo) -> LeadInfo:
        """
        从评论中提取并补充用户公开信息
        对已有的LeadInfo进行信息补充和标准化
        """
        # 标准化用户ID
        if not lead.user_id:
            lead.user_id = self._generate_user_id(comment)

        # 标准化昵称
        if not lead.nickname or lead.nickname == "未知":
            lead.nickname = comment.nickname or "未知"

        # 标准化性别
        if lead.gender and lead.gender != "未知":
            lead.gender = self._normalize_gender(lead.gender)

        # 标准化时间格式
        if lead.comment_time:
            lead.comment_time = self._normalize_time(lead.comment_time)

        # 去重检查（同用户同内容多条意向评论，只保留最新）
        if self.database:
            lead = self._deduplicate(lead)

        return lead

    def _generate_user_id(self, comment: CommentInfo) -> str:
        """为没有ID的用户生成唯一标识"""
        raw = f"{comment.platform}_{comment.nickname}"
        import hashlib
        return hashlib.md5(raw.encode()).hexdigest()[:16]

    def _normalize_gender(self, gender: str) -> str:
        """标准化性别信息"""
        gender = gender.strip()
        if gender in ("男", "male", "Male", "M", "m"):
            return "男"
        elif gender in ("女", "female", "Female", "F", "f"):
            return "女"
        return "未知"

    def _normalize_time(self, time_str: str) -> str:
        """标准化时间格式"""
        if not time_str:
            return ""
        # 常见格式适配
        from datetime import datetime
        formats = [
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%dT%H:%M:%S",
            "%Y/%m/%d %H:%M:%S",
            "%m-%d %H:%M",
        ]
        for fmt in formats:
            try:
                dt = datetime.strptime(time_str, fmt)
                return dt.strftime("%Y-%m-%d %H:%M:%S")
            except ValueError:
                continue
        return time_str

    def _deduplicate(self, lead: LeadInfo) -> LeadInfo:
        """
        去重处理：
        同一用户在同一内容下的多条意向评论，仅保留最新一条
        将旧记录标记为重复
        """
        try:
            existing = self.database.get_leads(
                platform=lead.platform,
                limit=10,
            )
            for old_lead in existing:
                if (old_lead.user_id == lead.user_id and
                        old_lead.content_id == lead.content_id and
                        old_lead.id != lead.id):
                    # 保留时间更晚的评论
                    if lead.comment_time and old_lead.comment_time:
                        if lead.comment_time > old_lead.comment_time:
                            self.database.update_lead(old_lead.id, is_duplicate=True)
                        else:
                            lead.is_duplicate = True
                            return lead
        except Exception as e:
            self.logger.debug(f"去重检查异常: {str(e)[:80]}")

        return lead
