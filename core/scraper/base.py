"""
爬虫基类模块
定义所有平台爬虫的通用行为：浏览器管理、反爬策略、重试机制
"""
import os
import random
import tempfile
import threading
import time
from abc import ABC, abstractmethod
from typing import Optional

from playwright.sync_api import sync_playwright, Browser, BrowserContext, Page

from storage.models import CommentInfo
from storage.cache import CacheManager
from utils.logger import Logger


# 浏览器初始化锁 — 防止多线程同时启动 Playwright + Edge 导致 Windows 资源冲突闪退
_browser_init_lock = threading.Lock()


def _browser_security_args() -> list[str]:
    """Return optional browser flags that intentionally weaken isolation."""
    args: list[str] = []
    if os.environ.get("CLIENT_LEAD_MINER_DISABLE_BROWSER_SANDBOX") == "1":
        Logger().warning("高风险兼容开关已启用: CLIENT_LEAD_MINER_DISABLE_BROWSER_SANDBOX=1")
        args.append("--no-sandbox")
    if os.environ.get("CLIENT_LEAD_MINER_DISABLE_WEB_SECURITY") == "1":
        Logger().warning("高风险兼容开关已启用: CLIENT_LEAD_MINER_DISABLE_WEB_SECURITY=1")
        args.append("--disable-web-security")
    return args


class BaseScraper(ABC):
    """爬虫基类 — 所有平台爬虫的通用实现"""

    platform: str = ""
    platform_name: str = ""

    def __init__(self, request_interval: float = 2.0, max_retries: int = 3,
                 scroll_delay: float = 1.5, headless: bool = True,
                 simulate_human: bool = True, random_delay_range: tuple = (1.0, 3.0),
                 persistent_data_dir: Optional[str] = None):
        self.request_interval = request_interval
        self.max_retries = max_retries
        self.scroll_delay = scroll_delay
        self.headless = headless
        self.simulate_human = simulate_human
        self.random_delay_range = random_delay_range
        self.logger = Logger()
        self._playwright = None
        self._browser: Optional[Browser] = None
        self._context: Optional[BrowserContext] = None
        self._page: Optional[Page] = None
        self._user_data_dir: Optional[str] = None
        self._persistent_data_dir = persistent_data_dir  # 持久化目录（不自动清理）

    def _init_browser(self) -> None:
        """初始化Playwright浏览器（使用系统Edge浏览器）

        使用全局锁串行化浏览器初始化，防止两个 Playwright 实例
        同时启动 Edge 时争抢用户数据目录导致 Windows 上闪退。

        使用 launch_persistent_context 而非 launch + --user-data-dir，
        后者在新版 Playwright 中已不被支持。
        """
        with _browser_init_lock:
            self._playwright = sync_playwright().start()

            # 持久化数据目录（如抖音登录态）— 复制到临时目录避免并发冲突
            # Edge/Chromium 不允许两个实例同时使用同一个 user-data-dir
            if self._persistent_data_dir and os.path.isdir(self._persistent_data_dir):
                import shutil as _shutil
                self._user_data_dir = tempfile.mkdtemp(prefix="edge_clm_")
                _shutil.copytree(self._persistent_data_dir, self._user_data_dir, dirs_exist_ok=True)
            elif self._persistent_data_dir:
                # 持久化目录尚不存在（未登录），使用临时目录
                self._user_data_dir = tempfile.mkdtemp(prefix="edge_clm_")
            else:
                self._user_data_dir = tempfile.mkdtemp(prefix="edge_clm_")

            launch_args = [
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
            ]
            launch_args.extend(_browser_security_args())
            # Windows 无头模式添加 --disable-gpu 提高稳定性
            if self.headless:
                launch_args.append("--disable-gpu")

            self._context = self._playwright.chromium.launch_persistent_context(
                user_data_dir=self._user_data_dir,
                headless=self.headless,
                channel="msedge",
                args=launch_args,
                viewport={"width": 1920, "height": 1080},
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
                locale="zh-CN",
            )
            self._browser = self._context.browser

            # 注入反检测脚本 — 对抗抖音/小红书等平台的 headless 检测
            self._context.add_init_script("""
                // 1. 基础 webdriver 标记
                Object.defineProperty(navigator, 'webdriver', {get: () => false});

                // 2. plugins — 模拟真实 Chrome 插件数组
                Object.defineProperty(navigator, 'plugins', {
                    get: () => {
                        const arr = [1, 2, 3, 4, 5];
                        arr.item = (i) => arr[i];
                        arr.namedItem = () => null;
                        arr.refresh = () => {};
                        return arr;
                    }
                });
                Object.defineProperty(navigator, 'mimeTypes', {
                    get: () => {
                        const arr = [1, 2, 3];
                        arr.item = (i) => arr[i];
                        arr.namedItem = () => null;
                        return arr;
                    }
                });

                // 3. languages
                Object.defineProperty(navigator, 'languages', {get: () => ['zh-CN', 'zh', 'en', 'en-US']});

                // 4. chrome 对象（真实 Chrome 有此属性）
                window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };

                // 5. permissions — 防止 headless 特征
                const origQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (params) =>
                    params && params.name === 'notifications'
                        ? Promise.resolve({state: Notification.permission})
                        : origQuery(params);

                // 6. 隐藏 headless 特有的 WebGL 渲染器信息
                try {
                    const getParameter = WebGLRenderingContext.prototype.getParameter;
                    WebGLRenderingContext.prototype.getParameter = function(param) {
                        if (param === 37445) return 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)';
                        if (param === 37446) return 'Google Inc. (Intel)';
                        return getParameter.call(this, param);
                    };
                } catch(e) {}

                // 7. deviceMemory / hardwareConcurrency
                Object.defineProperty(navigator, 'deviceMemory', {get: () => 8});
                Object.defineProperty(navigator, 'hardwareConcurrency', {get: () => 8});

                // 8. platform
                Object.defineProperty(navigator, 'platform', {get: () => 'Win32'});

                // 9. connection
                Object.defineProperty(navigator, 'connection', {
                    get: () => ({
                        effectiveType: '4g',
                        rtt: 50,
                        downlink: 10,
                        saveData: false,
                    })
                });
            """)
            self._page = self._context.new_page()

    def _close_browser(self) -> None:
        """关闭浏览器（确保进程彻底退出，防止临时目录残留导致下次采集闪退）"""
        # 关闭顺序：page → context（persistent context 关闭时会自动关闭 browser）
        # 这个顺序确保子进程逐级退出，Windows 上尤其重要
        for obj_name, obj in [("page", self._page), ("context", self._context)]:
            try:
                if obj:
                    obj.close()
            except Exception:
                pass

        # 等待浏览器进程退出并释放文件句柄（Windows 上 Edge 退出较慢）
        time.sleep(0.5)

        # 停止 Playwright 服务器
        try:
            if self._playwright:
                self._playwright.stop()
        except Exception:
            pass

        # 再次等待 OS 释放临时目录锁
        time.sleep(0.3)

        # 清理临时用户数据目录（持久化目录不清理）
        if self._user_data_dir and not self._persistent_data_dir:
            try:
                import shutil
                shutil.rmtree(self._user_data_dir, ignore_errors=True)
            except Exception:
                pass
            self._user_data_dir = None

        # 清空引用，帮助 GC 回收
        self._page = None
        self._context = None
        self._browser = None
        self._playwright = None

    def _random_delay(self) -> None:
        """随机延迟（模拟真人操作间隔）"""
        if self.simulate_human:
            delay = random.uniform(*self.random_delay_range)
            time.sleep(delay)
        else:
            time.sleep(self.request_interval)

    def _random_scroll(self) -> None:
        """随机滚动（模拟真人浏览行为）"""
        if not self._page:
            return
        scroll_distance = random.randint(300, 800)
        self._page.evaluate(f"window.scrollBy(0, {scroll_distance})")
        time.sleep(self.scroll_delay * random.uniform(0.8, 1.2))

    def _retry_operation(self, func, *args, **kwargs):
        """带重试的操作包装器"""
        last_error = None
        for attempt in range(self.max_retries):
            try:
                return func(*args, **kwargs)
            except Exception as e:
                last_error = e
                if attempt < self.max_retries - 1:
                    wait_time = (attempt + 1) * 2
                    self.logger.warning(f"操作失败，{wait_time}秒后重试 ({attempt+1}/{self.max_retries}): {str(e)[:100]}")
                    time.sleep(wait_time)
        raise last_error

    @abstractmethod
    def get_comments(self, url: str, content_id: str) -> list[CommentInfo]:
        """
        获取指定内容的评论列表（子类实现）
        返回: CommentInfo 列表
        """
        ...

    def scrape(self, url: str, platform: str, content_id: str,
               progress_callback=None) -> list[CommentInfo]:
        """
        完整的采集流程（模板方法）
        1. 初始化浏览器
        2. 获取评论
        3. 关闭浏览器
        4. 返回结果

        progress_callback: 可选，用于报告采集进度 (phase: str, current: int, total: int)
        """
        try:
            if progress_callback:
                progress_callback("正在启动浏览器...", 0, 100)
            self._init_browser()
            if progress_callback:
                progress_callback("正在加载页面...", 10, 100)
            self.logger.info(f"[{self.platform_name}] 开始采集: {url}")
            self._progress_callback = progress_callback
            comments = self._retry_operation(self.get_comments, url, content_id)
            if progress_callback:
                progress_callback(f"采集完成，开始分析...", 100, 100)
            self.logger.success(f"[{self.platform_name}] 采集完成: {len(comments)}条评论")
            return comments
        except Exception as e:
            self.logger.error(f"[{self.platform_name}] 采集失败: {str(e)}")
            if progress_callback:
                progress_callback(f"采集失败: {str(e)[:50]}", 0, 100)
            return []
        finally:
            self._close_browser()

    def _create_comment(self, **kwargs) -> CommentInfo:
        """创建标准化的CommentInfo对象"""
        defaults = {
            "platform": self.platform,
            "platform_name": self.platform_name,
            "content_url": kwargs.get("content_url", ""),
            "content_id": kwargs.get("content_id", ""),
            "content_type": kwargs.get("content_type", "video"),
            "comment_id": kwargs.get("comment_id", ""),
            "user_id": kwargs.get("user_id", ""),
            "nickname": kwargs.get("nickname", "未知"),
            "gender": kwargs.get("gender", "未知"),
            "comment_text": kwargs.get("comment_text", ""),
            "comment_time": kwargs.get("comment_time", ""),
            "likes": kwargs.get("likes", 0),
            "is_reply": kwargs.get("is_reply", False),
            "reply_to": kwargs.get("reply_to", ""),
        }
        return CommentInfo(**defaults)


class ScraperFactory:
    """爬虫工厂 — 根据平台标识创建对应的爬虫实例"""

    _scrapers: dict = {}

    @classmethod
    def register(cls, platform: str, scraper_class):
        """注册平台爬虫"""
        cls._scrapers[platform] = scraper_class

    @classmethod
    def create(cls, platform: str, **kwargs) -> BaseScraper:
        """创建爬虫实例"""
        from config.settings import get_settings
        from pathlib import Path
        config = get_settings().config.scraper

        scraper_kwargs = {
            "request_interval": config.request_interval,
            "max_retries": config.max_retries,
            "scroll_delay": config.scroll_delay,
            "headless": config.headless,
            "simulate_human": config.simulate_human,
            "random_delay_range": config.random_delay_range,
            **kwargs,
        }

        # 平台持久化 Profile（如抖音登录态）
        _PLATFORM_PROFILES = {
            "douyin": Path.home() / ".client_lead_miner" / "douyin_profile",
        }
        if platform in _PLATFORM_PROFILES:
            profile_dir = _PLATFORM_PROFILES[platform]
            # 如果持久化目录存在（已登录），使用它
            if (profile_dir / "Default" / "Preferences").exists() or \
               (profile_dir / "Default" / "Cookies").exists():
                scraper_kwargs["persistent_data_dir"] = str(profile_dir)

        if platform in cls._scrapers:
            return cls._scrapers[platform](**scraper_kwargs)
        raise ValueError(f"不支持的平台: {platform}")
