"""
爬虫模块 - 基类和所有平台实现
导入时会自动注册各平台爬虫到 ScraperFactory
"""
from .base import BaseScraper, ScraperFactory

# 导入所有平台爬虫，触发自动注册
from .douyin import DouyinScraper
from .xiaohongshu import XiaohongshuScraper
from .bilibili import BilibiliScraper
from .youtube import YoutubeScraper
from .instagram import InstagramScraper
from .facebook import FacebookScraper
