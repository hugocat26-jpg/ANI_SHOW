"""
SQLite 数据库管理模块
负责线索数据、操作日志、配置信息的持久化存储
"""
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional

import pandas as pd

from .models import LeadInfo, IntentLevel, TaskStatus, CollectTask, CompanyInfo


class Database:
    """数据库管理器（线程安全）"""

    _instances: dict = {}
    _lock = threading.Lock()

    def __new__(cls, db_path: Optional[Path] = None) -> "Database":
        if db_path is None:
            from config.settings import AppSettings
            db_path = AppSettings.get_data_dir() / "lead_miner.db"
        key = str(db_path)
        if key not in cls._instances:
            with cls._lock:
                if key not in cls._instances:
                    instance = super().__new__(cls)
                    instance._initialized = False
                    instance._db_path = db_path
                    cls._instances[key] = instance
        return cls._instances[key]

    def __init__(self, db_path: Optional[Path] = None) -> None:
        if self._initialized:
            return
        self._initialized = True
        self._local = threading.local()
        self._init_tables()

    def _get_conn(self) -> sqlite3.Connection:
        """获取当前线程的数据库连接"""
        if not hasattr(self._local, "conn") or self._local.conn is None:
            self._local.conn = sqlite3.connect(str(self._db_path))
            self._local.conn.row_factory = sqlite3.Row
            self._local.conn.execute("PRAGMA journal_mode=WAL")
            self._local.conn.execute("PRAGMA foreign_keys=ON")
        return self._local.conn

    def _init_tables(self) -> None:
        """初始化数据库表结构"""
        conn = self._get_conn()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS leads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                nickname TEXT DEFAULT '',
                gender TEXT DEFAULT '未知',
                comment_text TEXT DEFAULT '',
                comment_time TEXT DEFAULT '',
                intent_level TEXT DEFAULT '无',
                intent_keywords TEXT DEFAULT '',
                llm_verified INTEGER DEFAULT 0,
                llm_analysis TEXT DEFAULT '',
                platform TEXT DEFAULT '',
                platform_name TEXT DEFAULT '',
                source_url TEXT DEFAULT '',
                content_id TEXT DEFAULT '',
                content_type TEXT DEFAULT 'video',
                likes INTEGER DEFAULT 0,
                collected_at TEXT DEFAULT '',
                notes TEXT DEFAULT '',
                manually_marked INTEGER DEFAULT 0,
                is_duplicate INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                UNIQUE(user_id, content_id)
            );

            CREATE TABLE IF NOT EXISTS tasks (
                task_id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                platform TEXT DEFAULT '',
                platform_name TEXT DEFAULT '',
                content_type TEXT DEFAULT 'video',
                content_id TEXT DEFAULT '',
                status TEXT DEFAULT 'pending',
                total_comments INTEGER DEFAULT 0,
                collected_comments INTEGER DEFAULT 0,
                intent_count INTEGER DEFAULT 0,
                error_message TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                time TEXT NOT NULL,
                level TEXT NOT NULL,
                message TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS company_leads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                company_name TEXT NOT NULL,
                website TEXT DEFAULT '',
                email TEXT DEFAULT '',
                phone TEXT DEFAULT '',
                address TEXT DEFAULT '',
                description TEXT DEFAULT '',
                social_links TEXT DEFAULT '',
                source TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now', 'localtime'))
            );

            CREATE INDEX IF NOT EXISTS idx_leads_user_id ON leads(user_id);
            CREATE INDEX IF NOT EXISTS idx_leads_platform ON leads(platform);
            CREATE INDEX IF NOT EXISTS idx_leads_intent ON leads(intent_level);
            CREATE INDEX IF NOT EXISTS idx_leads_time ON leads(collected_at);
        """)
        conn.execute("""
            DELETE FROM company_leads
            WHERE id NOT IN (
                SELECT MAX(id) FROM company_leads GROUP BY company_name
            )
        """)
        conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_company_leads_name
            ON company_leads(company_name)
        """)
        conn.commit()

    # ========== 线索操作 ==========

    def insert_lead(self, lead: LeadInfo) -> Optional[int]:
        """插入线索，如已存在（同user_id+content_id）则更新"""
        conn = self._get_conn()
        lead.collected_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        try:
            cursor = conn.execute("""
                INSERT INTO leads (user_id, nickname, gender, comment_text, comment_time,
                    intent_level, intent_keywords, llm_verified, llm_analysis,
                    platform, platform_name, source_url, content_id, content_type,
                    likes, collected_at, notes, manually_marked, is_duplicate)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, content_id) DO UPDATE SET
                    comment_text=excluded.comment_text,
                    comment_time=excluded.comment_time,
                    intent_level=excluded.intent_level,
                    intent_keywords=excluded.intent_keywords,
                    llm_verified=excluded.llm_verified,
                    llm_analysis=excluded.llm_analysis,
                    likes=excluded.likes,
                    collected_at=excluded.collected_at
            """, (
                lead.user_id, lead.nickname, lead.gender, lead.comment_text,
                lead.comment_time, lead.intent_level.value if isinstance(lead.intent_level, IntentLevel) else lead.intent_level,
                lead.intent_keywords, 1 if lead.llm_verified else 0, lead.llm_analysis,
                lead.platform, lead.platform_name, lead.source_url, lead.content_id,
                lead.content_type, lead.likes, lead.collected_at, lead.notes,
                1 if lead.manually_marked else 0, 1 if lead.is_duplicate else 0
            ))
            conn.commit()
            return cursor.lastrowid
        except Exception as e:
            conn.rollback()
            raise e

    def get_leads(
        self,
        intent_level: Optional[str] = None,
        platform: Optional[str] = None,
        keyword: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        limit: int = 1000,
        offset: int = 0,
        order_by: str = "collected_at DESC"
    ) -> list[LeadInfo]:
        """查询线索列表，支持多种筛选条件"""
        conn = self._get_conn()
        conditions = ["1=1"]
        params = []

        if intent_level:
            conditions.append("intent_level = ?")
            params.append(intent_level)
        if platform:
            conditions.append("platform = ?")
            params.append(platform)
        if keyword:
            conditions.append("(comment_text LIKE ? OR nickname LIKE ?)")
            params.extend([f"%{keyword}%", f"%{keyword}%"])
        if date_from:
            conditions.append("collected_at >= ?")
            params.append(date_from)
        if date_to:
            conditions.append("collected_at <= ?")
            params.append(date_to)

        where_clause = " AND ".join(conditions)
        safe_order_by = self._safe_leads_order_by(order_by)
        sql = f"SELECT * FROM leads WHERE {where_clause} ORDER BY {safe_order_by} LIMIT ? OFFSET ?"
        params.extend([limit, offset])

        cursor = conn.execute(sql, params)
        rows = cursor.fetchall()
        return [self._row_to_lead(row) for row in rows]

    def count_leads(
        self,
        intent_level: Optional[str] = None,
        platform: Optional[str] = None,
    ) -> int:
        """统计线索数量"""
        conn = self._get_conn()
        conditions = ["1=1"]
        params = []
        if intent_level:
            conditions.append("intent_level = ?")
            params.append(intent_level)
        if platform:
            conditions.append("platform = ?")
            params.append(platform)
        where = " AND ".join(conditions)
        cursor = conn.execute(f"SELECT COUNT(*) FROM leads WHERE {where}", params)
        return cursor.fetchone()[0]

    def update_lead(self, lead_id: int, **kwargs) -> None:
        """更新线索信息（如手动标记、添加备注）"""
        conn = self._get_conn()
        allowed_fields = {"intent_level", "notes", "manually_marked", "gender"}
        updates = {}
        for k, v in kwargs.items():
            if k in allowed_fields:
                updates[k] = v
        if not updates:
            return
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [lead_id]
        conn.execute(f"UPDATE leads SET {set_clause} WHERE id = ?", values)
        conn.commit()

    def delete_lead(self, lead_id: int) -> None:
        """删除线索"""
        conn = self._get_conn()
        conn.execute("DELETE FROM leads WHERE id = ?", (lead_id,))
        conn.commit()

    def delete_all_leads(self) -> None:
        """清空所有线索"""
        conn = self._get_conn()
        conn.execute("DELETE FROM leads")
        conn.commit()

    def get_leads_as_dataframe(self, **kwargs) -> pd.DataFrame:
        """以DataFrame格式获取线索（用于导出）"""
        leads = self.get_leads(**kwargs)
        return pd.DataFrame([lead.to_dict() for lead in leads])

    # ========== 任务操作 ==========

    def save_task(self, task: CollectTask) -> None:
        """保存或更新任务状态"""
        conn = self._get_conn()
        task.updated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        conn.execute("""
            INSERT OR REPLACE INTO tasks
            (task_id, url, platform, platform_name, content_type, content_id,
             status, total_comments, collected_comments, intent_count,
             error_message, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            task.task_id, task.url, task.platform, task.platform_name,
            task.content_type, task.content_id, task.status.value if isinstance(task.status, TaskStatus) else task.status,
            task.total_comments, task.collected_comments, task.intent_count,
            task.error_message, task.created_at, task.updated_at
        ))
        conn.commit()

    def get_task(self, task_id: str) -> Optional[CollectTask]:
        """获取任务信息"""
        conn = self._get_conn()
        cursor = conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,))
        row = cursor.fetchone()
        if row:
            return CollectTask(
                task_id=row["task_id"],
                url=row["url"],
                platform=row["platform"],
                platform_name=row["platform_name"],
                content_type=row["content_type"],
                content_id=row["content_id"],
                status=TaskStatus(row["status"]),
                total_comments=row["total_comments"],
                collected_comments=row["collected_comments"],
                intent_count=row["intent_count"],
                error_message=row["error_message"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )
        return None

    def get_all_tasks(self) -> list[CollectTask]:
        """获取所有任务"""
        conn = self._get_conn()
        cursor = conn.execute("SELECT * FROM tasks ORDER BY created_at DESC")
        rows = cursor.fetchall()
        tasks = []
        for row in rows:
            tasks.append(CollectTask(
                task_id=row["task_id"],
                url=row["url"],
                platform=row["platform"],
                platform_name=row["platform_name"],
                content_type=row["content_type"],
                content_id=row["content_id"],
                status=TaskStatus(row["status"]),
                total_comments=row["total_comments"],
                collected_comments=row["collected_comments"],
                intent_count=row["intent_count"],
                error_message=row["error_message"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            ))
        return tasks

    # ========== 日志操作 ==========

    def insert_log(self, time: str, level: str, message: str) -> None:
        """插入操作日志"""
        conn = self._get_conn()
        conn.execute(
            "INSERT INTO logs (time, level, message) VALUES (?, ?, ?)",
            (time, level, message)
        )
        conn.commit()

    def get_logs(self, level: Optional[str] = None, limit: int = 500) -> list[dict]:
        """查询日志"""
        conn = self._get_conn()
        if level:
            cursor = conn.execute(
                "SELECT * FROM logs WHERE level = ? ORDER BY id DESC LIMIT ?",
                (level, limit)
            )
        else:
            cursor = conn.execute(
                "SELECT * FROM logs ORDER BY id DESC LIMIT ?", (limit,)
            )
        return [dict(row) for row in cursor.fetchall()]

    def clear_logs(self) -> None:
        """清空日志"""
        conn = self._get_conn()
        conn.execute("DELETE FROM logs")
        conn.commit()

    # ========== 配置操作 ==========

    def set_config(self, key: str, value: str) -> None:
        """保存配置项"""
        conn = self._get_conn()
        conn.execute(
            "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
            (key, value)
        )
        conn.commit()

    def get_config(self, key: str, default: str = "") -> str:
        """读取配置项"""
        conn = self._get_conn()
        cursor = conn.execute("SELECT value FROM config WHERE key = ?", (key,))
        row = cursor.fetchone()
        return row["value"] if row else default

    # ========== 公司信息操作 ==========

    def insert_company(self, company: CompanyInfo) -> int:
        """插入公司信息，同名则更新"""
        conn = self._get_conn()
        try:
            conn.execute("""
                INSERT INTO company_leads (company_name, website, email, phone, address,
                    description, social_links, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(company_name) DO UPDATE SET
                    website=excluded.website,
                    email=excluded.email,
                    phone=excluded.phone,
                    address=excluded.address,
                    description=excluded.description,
                    social_links=excluded.social_links,
                    source=excluded.source,
                    created_at=datetime('now', 'localtime')
            """, (
                company.name, company.website, company.email, company.phone,
                company.address, company.description, company.social_links, company.source
            ))
            conn.commit()
            cursor = conn.execute(
                "SELECT id FROM company_leads WHERE company_name = ?",
                (company.name,)
            )
            row = cursor.fetchone()
            return int(row["id"]) if row else 0
        except Exception as e:
            conn.rollback()
            raise e

    def get_companies(self, keyword: str = "", limit: int = 100) -> list[CompanyInfo]:
        """查询公司信息"""
        conn = self._get_conn()
        if keyword:
            cursor = conn.execute(
                """SELECT * FROM company_leads
                   WHERE company_name LIKE ? OR description LIKE ?
                   ORDER BY created_at DESC LIMIT ?""",
                (f"%{keyword}%", f"%{keyword}%", limit)
            )
        else:
            cursor = conn.execute(
                "SELECT * FROM company_leads ORDER BY created_at DESC LIMIT ?",
                (limit,)
            )
        rows = cursor.fetchall()
        return [CompanyInfo(
            name=row["company_name"], website=row["website"],
            email=row["email"], phone=row["phone"], address=row["address"],
            description=row["description"], social_links=row["social_links"],
            source=row["source"], created_at=row["created_at"],
        ) for row in rows]

    def close(self) -> None:
        """关闭数据库连接"""
        if hasattr(self._local, "conn") and self._local.conn:
            self._local.conn.close()
            self._local.conn = None

    @staticmethod
    def _safe_leads_order_by(order_by: str) -> str:
        allowed_fields = {
            "collected_at", "created_at", "comment_time", "likes",
            "intent_level", "platform", "nickname", "id"
        }
        parts = str(order_by or "collected_at DESC").strip().split()
        field = parts[0] if parts else "collected_at"
        direction = parts[1].upper() if len(parts) > 1 else "DESC"
        if field not in allowed_fields:
            field = "collected_at"
        if direction not in {"ASC", "DESC"}:
            direction = "DESC"
        return f"{field} {direction}"

    @staticmethod
    def _row_to_lead(row: sqlite3.Row) -> LeadInfo:
        return LeadInfo(
            id=row["id"],
            user_id=row["user_id"],
            nickname=row["nickname"],
            gender=row["gender"],
            comment_text=row["comment_text"],
            comment_time=row["comment_time"],
            intent_level=IntentLevel(row["intent_level"]) if row["intent_level"] else IntentLevel.NONE,
            intent_keywords=row["intent_keywords"],
            llm_verified=bool(row["llm_verified"]),
            llm_analysis=row["llm_analysis"],
            platform=row["platform"],
            platform_name=row["platform_name"],
            source_url=row["source_url"],
            content_id=row["content_id"],
            content_type=row["content_type"],
            likes=row["likes"],
            collected_at=row["collected_at"],
            notes=row["notes"],
            manually_marked=bool(row["manually_marked"]),
            is_duplicate=bool(row["is_duplicate"]),
        )
