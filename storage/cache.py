"""
采集缓存管理器
在采集过程中临时保存评论数据，防止中断后数据丢失
支持断点续采功能
"""
import json
from datetime import datetime
from pathlib import Path
from typing import Optional

from .models import CommentInfo


class CacheManager:
    """缓存管理器"""

    _cache_dir: Optional[Path] = None

    @classmethod
    def _get_cache_dir(cls) -> Path:
        """获取缓存目录"""
        if cls._cache_dir is None:
            from config.settings import AppSettings
            cls._cache_dir = AppSettings.get_data_dir() / "cache"
            cls._cache_dir.mkdir(parents=True, exist_ok=True)
        return cls._cache_dir

    @classmethod
    def save_comments(cls, task_id: str, comments: list[CommentInfo]) -> None:
        """缓存评论数据到临时文件"""
        cache_file = cls._get_cache_dir() / f"{task_id}.json"
        data = {
            "task_id": task_id,
            "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "comments": [c.to_dict() for c in comments],
        }
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    @classmethod
    def load_comments(cls, task_id: str) -> list[CommentInfo]:
        """从缓存加载评论数据"""
        cache_file = cls._get_cache_dir() / f"{task_id}.json"
        if not cache_file.exists():
            return []
        with open(cache_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        comments = []
        for c in data.get("comments", []):
            comments.append(CommentInfo(**c))
        return comments

    @classmethod
    def save_progress(cls, task_id: str, progress: dict) -> None:
        """保存采集进度（用于断点续采）"""
        progress_file = cls._get_cache_dir() / f"{task_id}_progress.json"
        progress["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(progress_file, "w", encoding="utf-8") as f:
            json.dump(progress, f, ensure_ascii=False, indent=2)

    @classmethod
    def load_progress(cls, task_id: str) -> Optional[dict]:
        """加载采集进度"""
        progress_file = cls._get_cache_dir() / f"{task_id}_progress.json"
        if not progress_file.exists():
            return None
        with open(progress_file, "r", encoding="utf-8") as f:
            return json.load(f)

    @classmethod
    def clear_cache(cls, task_id: str) -> None:
        """清除指定任务的缓存"""
        cache_dir = cls._get_cache_dir()
        for pattern in [f"{task_id}.json", f"{task_id}_progress.json"]:
            file_path = cache_dir / pattern
            if file_path.exists():
                file_path.unlink()

    @classmethod
    def clear_all_cache(cls) -> None:
        """清除所有缓存"""
        cache_dir = cls._get_cache_dir()
        for f in cache_dir.glob("*.json"):
            f.unlink()
