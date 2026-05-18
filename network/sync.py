"""
数据同步模块
支持本地模式与联网模式的数据双向同步
"""
import json
import time
from pathlib import Path
from typing import Optional

import requests

from storage.database import Database
from utils.logger import Logger


class DataSync:
    """数据同步管理器"""

    def __init__(self, server_url: str = ""):
        self.server_url = server_url.rstrip("/")
        self.logger = Logger()

    def _auth(self) -> Optional[tuple[str, str]]:
        from config.settings import get_settings
        settings = get_settings()
        settings.load()
        username = settings.config.network.username
        password = settings.config.network.password
        if username and password:
            return username, password
        return None

    def set_server(self, host: str, port: int) -> None:
        """设置服务器地址"""
        self.server_url = f"http://{host}:{port}"

    def test_connection(self) -> bool:
        """测试与服务器的连接"""
        if not self.server_url:
            return False
        try:
            resp = requests.get(f"{self.server_url}/api/health", auth=self._auth(), timeout=5)
            return resp.status_code == 200
        except Exception:
            return False

    def upload_leads(self, database: Database, intent_level: Optional[str] = None) -> int:
        """
        将本地线索上传至服务器
        返回: 成功上传的数量
        """
        if not self.server_url:
            self.logger.warning("未配置服务器地址，无法上传")
            return 0

        leads = database.get_leads(intent_level=intent_level, limit=10000)
        if not leads:
            self.logger.info("没有需要上传的线索数据")
            return 0

        count = 0
        for lead in leads:
            try:
                resp = requests.post(
                    f"{self.server_url}/api/leads",
                    json=lead.to_dict(),
                    auth=self._auth(),
                    timeout=10,
                )
                if resp.status_code in (200, 201):
                    count += 1
            except Exception as e:
                self.logger.debug(f"上传线索失败: {str(e)[:80]}")
                continue

        self.logger.success(f"上传完成: {count}/{len(leads)}条线索")
        return count

    def download_leads(self, database: Database) -> int:
        """
        从服务器下载线索数据到本地
        返回: 成功下载的数量
        """
        if not self.server_url:
            self.logger.warning("未配置服务器地址，无法下载")
            return 0

        from storage.models import LeadInfo, IntentLevel
        count = 0
        try:
            resp = requests.get(
                f"{self.server_url}/api/leads",
                params={"limit": 10000},
                auth=self._auth(),
                timeout=30,
            )
            if resp.status_code == 200:
                data = resp.json()
                for item in data.get("data", []):
                    try:
                        lead = LeadInfo(
                            user_id=item.get("user_id", ""),
                            nickname=item.get("nickname", ""),
                            gender=item.get("gender", "未知"),
                            comment_text=item.get("comment_text", ""),
                            comment_time=item.get("comment_time", ""),
                            intent_level=IntentLevel(item.get("intent_level", "无")),
                            intent_keywords=item.get("intent_keywords", ""),
                            llm_verified=item.get("llm_verified", False),
                            llm_analysis=item.get("llm_analysis", ""),
                            platform=item.get("platform", ""),
                            platform_name=item.get("platform_name", ""),
                            source_url=item.get("source_url", ""),
                            content_id=item.get("content_id", ""),
                            likes=item.get("likes", 0),
                            notes=item.get("notes", ""),
                        )
                        database.insert_lead(lead)
                        count += 1
                    except Exception:
                        continue
                self.logger.success(f"下载完成: {count}条线索")
            else:
                self.logger.error(f"服务器返回错误: HTTP {resp.status_code}")
        except Exception as e:
            self.logger.error(f"下载失败: {str(e)}")
        return count
