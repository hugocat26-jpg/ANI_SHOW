"""
输入校验模块
链接格式校验、文件路径校验等
"""
import re
from typing import Optional
from urllib.parse import urlparse


class LinkValidator:
    """链接格式校验器"""

    # 各平台链接特征规则
    PLATFORM_PATTERNS = {
        "douyin": {
            "domains": ["douyin.com", "iesdouyin.com"],
            "pattern": r"https?://(?:www\.|v\.)?douyin\.com/\S+",
            "name": "抖音",
        },
        "xiaohongshu": {
            "domains": ["xiaohongshu.com", "xhslink.com"],
            "pattern": r"https?://(?:www\.)?xiaohongshu\.com/\S+",
            "name": "小红书",
        },
        "bilibili": {
            "domains": ["bilibili.com", "b23.tv"],
            "pattern": r"https?://(?:www\.)?bilibili\.com/\S+|https?://b23\.tv/\S+",
            "name": "B站",
        },
        "youtube": {
            "domains": ["youtube.com", "youtu.be"],
            "pattern": r"https?://(?:www\.)?(?:youtube\.com/\S+|youtu\.be/\S+)",
            "name": "YouTube",
        },
        "instagram": {
            "domains": ["instagram.com", "instagr.am"],
            "pattern": r"https?://(?:www\.)?instagram\.com/\S+",
            "name": "Instagram",
        },
        "facebook": {
            "domains": ["facebook.com", "fb.com", "fb.watch"],
            "pattern": r"https?://(?:www\.)?(?:facebook\.com/\S+|fb\.com/\S+|fb\.watch/\S+)",
            "name": "Facebook",
        },
    }

    @classmethod
    def validate(cls, url: str) -> tuple[bool, Optional[str]]:
        """
        校验链接格式
        返回: (是否有效, 错误原因)
        """
        url = url.strip()
        if not url:
            return False, "链接为空"

        # 基础URL格式校验
        try:
            parsed = urlparse(url)
            if not parsed.scheme or not parsed.netloc:
                return False, "链接格式不正确（需以http://或https://开头）"
        except Exception:
            return False, "链接格式无效"

        # 检查是否属于支持的平台
        platform = cls.identify_platform(url)
        if platform is None:
            return False, "不支持的平台（当前支持：抖音、小红书、B站、YouTube、Instagram、Facebook）"

        return True, None

    @classmethod
    def identify_platform(cls, url: str) -> Optional[str]:
        """
        识别链接所属平台
        返回: 平台标识（douyin/xiaohongshu/bilibili/youtube/instagram/facebook）或None
        """
        try:
            hostname = (urlparse(url.strip()).hostname or "").lower()
        except Exception:
            return None
        if not hostname:
            return None
        for platform_id, config in cls.PLATFORM_PATTERNS.items():
            for domain in config["domains"]:
                if hostname == domain or hostname.endswith(f".{domain}"):
                    return platform_id
        return None

    @classmethod
    def get_platform_name(cls, platform_id: str) -> str:
        """获取平台中文名称"""
        if platform_id in cls.PLATFORM_PATTERNS:
            return cls.PLATFORM_PATTERNS[platform_id]["name"]
        return "未知平台"

    @classmethod
    def extract_content_id(cls, url: str, platform_id: str) -> Optional[str]:
        """
        从链接中提取内容唯一标识（视频ID/图文ID）
        """
        url = url.strip()
        if platform_id == "douyin":
            match = re.search(r"/(?:video|note)/(\d+)", url)
            if match:
                return match.group(1)
            match = re.search(r"modal_id=(\d+)", url)
            if match:
                return match.group(1)
        elif platform_id == "xiaohongshu":
            match = re.search(r"/explore/([\w\-]+)", url)
            if match:
                return match.group(1)
            match = re.search(r"/note/([\w\-]+)", url)
            if match:
                return match.group(1)
            match = re.search(r"/discovery/item/([\w\-]+)", url)
            if match:
                return match.group(1)
        elif platform_id == "bilibili":
            match = re.search(r"/video/(BV\w+)", url)
            if match:
                return match.group(1)
            match = re.search(r"/video/(av\d+)", url)
            if match:
                return match.group(1)
        elif platform_id == "youtube":
            match = re.search(r"(?:v=|/)([\w\-]{11})", url)
            if match:
                return match.group(1)
        elif platform_id == "instagram":
            match = re.search(r"/(?:p|reel)/([\w\-]+)", url)
            if match:
                return match.group(1)
        elif platform_id == "facebook":
            match = re.search(r"/videos/(\d+)", url)
            if match:
                return match.group(1)
            match = re.search(r"/posts/(\w+)", url)
            if match:
                return match.group(1)
            match = re.search(r"/reel/(\d+)", url)
            if match:
                return match.group(1)
            match = re.search(r"[?&]v=(\d+)", url)
            if match:
                return match.group(1)
            match = re.search(r"/share/v/([\w\-]+)", url)
            if match:
                return match.group(1)
        return None

    @classmethod
    def guess_content_type(cls, url: str, platform_id: str) -> str:
        """
        推测内容类型：video（视频） / image_text（图文）
        """
        url_lower = url.lower()
        if platform_id == "xiaohongshu" and "/note/" not in url_lower and "/explore/" in url_lower:
            return "image_text"
        if platform_id in ("douyin", "youtube", "bilibili"):
            return "video"
        if platform_id in ("instagram", "facebook", "xiaohongshu"):
            # 这些平台链接可能是视频或图文，默认判断
            if any(kw in url_lower for kw in ("/video", "/reel", "/p/", "videos", "watch")):
                return "video"
            return "image_text"
        return "video"
