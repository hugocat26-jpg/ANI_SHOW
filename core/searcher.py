"""
搜索核心模块
在各平台按关键词搜索视频/图文内容，提取链接并分类
使用 Playwright 浏览器抓取搜索页 DOM，Bing 作为通用搜索兜底

关键设计：
- 单浏览器上下文 + 每平台独立 page：隔离页面崩溃，防止连锁失败
- 反检测脚本：与 BaseScraper 同等强度的 headless 检测对抗
- 三层降级：平台直搜 → Bing 站内搜 → Bing 宽泛搜
"""
import re
import time
import random
import threading
import tempfile
import shutil
import base64
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, quote, unquote, urlparse, urlunparse

from PyQt6.QtCore import QThread, pyqtSignal

from storage.models import SearchResult
from utils.logger import Logger

# 浏览器初始化锁
_search_browser_lock = threading.Lock()
_SEARCH_PROFILE_DIR = Path.home() / ".client_lead_miner" / "search_profile"
_PLATFORM_LOGIN_URLS = {
    "douyin": "https://www.douyin.com/",
    "xiaohongshu": "https://www.xiaohongshu.com/explore",
    "instagram": "https://www.instagram.com/",
    "facebook": "https://zh-cn.facebook.com/",
}
LOGIN_REQUIRED_PLATFORMS = {"douyin", "xiaohongshu", "instagram", "facebook"}

# ==================== 反检测脚本（与 BaseScraper 一致）====================

_ANTI_DETECT_SCRIPT = """
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

// 4. chrome 对象
window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };

// 5. permissions
var origQuery = window.navigator.permissions.query;
window.navigator.permissions.query = function(params) {
    if (params && params.name === 'notifications') {
        return Promise.resolve({state: 'prompt'});
    }
    return origQuery(params);
};

// 6. WebGL 渲染器伪装
try {
    var getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(p) {
        if (p === 37445) return 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)';
        if (p === 37446) return 'Google Inc. (Intel)';
        return getParam.call(this, p);
    };
} catch(e) {}

// 7. 硬件信息
Object.defineProperty(navigator, 'deviceMemory', {get: () => 8});
Object.defineProperty(navigator, 'hardwareConcurrency', {get: () => 8});
Object.defineProperty(navigator, 'platform', {get: () => 'Win32'});

// 8. 网络信息
Object.defineProperty(navigator, 'connection', {
    get: () => ({effectiveType: '4g', rtt: 50, downlink: 10, saveData: false})
});

// 9. 屏幕色深
Object.defineProperty(screen, 'colorDepth', {get: () => 24});
Object.defineProperty(screen, 'pixelDepth', {get: () => 24});

// 10. headless 标记
Object.defineProperty(navigator, 'headless', {get: () => false});
"""


class SearchWorker(QThread):
    """搜索工作线程"""
    progress = pyqtSignal(str, int, int)
    result_found = pyqtSignal(dict)
    search_finished = pyqtSignal(str, list)
    search_error = pyqtSignal(str)
    log = pyqtSignal(str, str)

    def __init__(self, keyword: str, platforms: list[str], llm=None, settings=None):
        super().__init__()
        self.keyword = keyword
        self.platforms = platforms
        self.llm = llm
        self.settings = settings
        self._stop_event = threading.Event()
        self.logger = Logger()

    def run(self) -> None:
        try:
            self.log.emit("INFO", f"搜索开始: '{self.keyword}' 在 {len(self.platforms)} 个平台")
            self.progress.emit("初始化浏览器", 0, len(self.platforms))

            manager = SearchManager(
                llm=self.llm,
                settings=self.settings,
                progress_callback=lambda phase, cur, total: self.progress.emit(phase, cur, total),
                log_callback=lambda level, msg: self.log.emit(level, msg),
                stop_event=self._stop_event,
            )

            results = manager.search_all(self.keyword, self.platforms)
            self.search_finished.emit(self.keyword, results)
            self.log.emit("SUCCESS", f"搜索完成: 共 {len(results)} 条结果")
        except Exception as e:
            self.log.emit("ERROR", f"搜索失败: {str(e)}")
            self.search_error.emit(str(e))

    def stop(self) -> None:
        self._stop_event.set()


class PlatformLoginWorker(QThread):
    """平台登录线程：打开可见浏览器，用户登录后关闭窗口保存状态。"""

    login_finished = pyqtSignal(str, bool, str)
    log = pyqtSignal(str, str)

    def __init__(self, platform: str):
        super().__init__()
        self.platform = platform

    def run(self) -> None:
        try:
            label = _platform_label(self.platform)
            self.log.emit("INFO", f"正在打开 {label} 登录窗口，请登录后关闭浏览器")
            login_search_platform(self.platform)
            self.login_finished.emit(self.platform, True, f"{label} 登录状态已保存")
        except Exception as e:
            self.login_finished.emit(self.platform, False, str(e))


def login_search_platform(platform: str, timeout_ms: int = 600000) -> None:
    """打开持久化搜索 Profile 让用户登录平台。"""
    from playwright.sync_api import sync_playwright

    if platform not in _PLATFORM_LOGIN_URLS:
        raise ValueError(f"不支持的平台登录: {platform}")

    _SEARCH_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    pw = sync_playwright().start()
    context = None
    try:
        context = pw.chromium.launch_persistent_context(
            user_data_dir=str(_SEARCH_PROFILE_DIR),
            headless=False,
            channel="msedge",
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
            viewport={"width": 1280, "height": 900},
            locale="zh-CN",
        )
        context.add_init_script(_ANTI_DETECT_SCRIPT)
        page = context.new_page()
        page.goto(_PLATFORM_LOGIN_URLS[platform], wait_until="domcontentloaded", timeout=30000)
        try:
            page.wait_for_event("close", timeout=timeout_ms)
        except Exception:
            pass
    finally:
        try:
            if context:
                context.close()
        except Exception:
            pass
        try:
            pw.stop()
        except Exception:
            pass


def has_search_login_state() -> bool:
    return (_SEARCH_PROFILE_DIR / "Default" / "Preferences").exists() or (
        _SEARCH_PROFILE_DIR / "Default" / "Cookies"
    ).exists()


class PlatformSearcher:
    """各平台搜索器 — 每平台接收一个独立 page（共享 context），隔离页面崩溃"""

    def __init__(self, context, headless: bool = True):
        self._context = context   # 共享的浏览器上下文
        self._headless = headless
        self._page = None         # 每个平台独立创建 page
        self.logger = Logger()

    def _new_page(self):
        """为当前平台创建独立页面"""
        if self._page:
            try:
                self._page.close()
            except Exception:
                pass
        self._page = self._context.new_page()
        return self._page

    def _close_page(self):
        """关闭当前平台的页面"""
        if self._page:
            try:
                self._page.close()
            except Exception:
                pass
            self._page = None

    def _navigate(self, url: str, wait_until: str = "domcontentloaded", timeout: int = 25000) -> bool:
        """导航到 URL，返回是否成功加载"""
        try:
            self._page.goto(url, wait_until=wait_until, timeout=timeout)
            return True
        except Exception as e:
            # 超时或页面错误 — 页面可能已部分加载，继续尝试
            self.logger.warning(f"导航超时/异常 ({wait_until}): {str(e)[:80]}")
            return False

    def _page_has_content(self) -> bool:
        """检查页面是否有可见内容"""
        try:
            text = self._page.inner_text("body") or ""
            return len(text.strip()) > 50
        except Exception:
            return False

    def _element_tag_name(self, element) -> str:
        """兼容 Playwright ElementHandle：获取节点 tagName。"""
        try:
            return (element.evaluate("el => el.tagName") or "").lower()
        except Exception:
            return ""

    def _make_result(self, url: str, title: str, platform_name: str = "") -> Optional[SearchResult]:
        normalized = _normalize_result_url(url)
        if not normalized:
            return None

        platform, guessed_name = _guess_platform_from_url(normalized)
        if platform == "web":
            return None

        return SearchResult(
            url=normalized,
            title=(title or normalized)[:100],
            platform=platform,
            platform_name=platform_name or guessed_name,
            content_type=_content_type_for_platform(platform),
            snippet=(title or "")[:120],
        )

    # ==================== 抖音搜索 ====================

    def search_douyin(self, keyword: str, max_results: int = 20) -> list[SearchResult]:
        """抖音搜索 — 三路径保障"""
        self._new_page()
        try:
            # 路径1：直接搜索抖音
            results = self._search_douyin_direct(keyword, max_results)
            if results:
                return results
            # 路径2：Bing site:douyin.com
            results = self._search_bing_site(keyword, "douyin.com", "抖音", max_results)
            if results:
                return results
            # 路径3：Bing 宽泛搜索
            return self._search_bing_general(keyword, "douyin", "抖音", max_results)
        finally:
            self._close_page()

    def _search_douyin_direct(self, keyword: str, max_results: int = 20) -> list[SearchResult]:
        """直接访问抖音搜索页"""
        results: list[SearchResult] = []
        search_url = f"https://www.douyin.com/search/{quote(keyword)}?type=video"

        self._navigate(search_url, wait_until="domcontentloaded", timeout=25000)
        time.sleep(4)

        # 检查拦截
        try:
            text = self._page.inner_text("body")[:300] or ""
            if any(kw in text for kw in ["验证", "滑块", "captcha", "安全验证"]):
                self.logger.info(f"抖音触发验证码，跳过直搜")
                return results
        except Exception:
            pass

        # 滚动加载
        for _ in range(5):
            try:
                self._page.evaluate("window.scrollBy(0, 600)")
            except Exception:
                break
            time.sleep(1.5)

        # 提取链接
        seen_urls: set[str] = set()
        # 优先用 a[href] 宽泛匹配
        try:
            all_links = self._page.query_selector_all('a[href*="/video/"], a[href*="/note/"]')
            for link in all_links:
                if len(results) >= max_results:
                    break
                try:
                    href = link.get_attribute("href") or ""
                    if not href:
                        continue
                    if "/user/" in href or "/music/" in href:
                        continue
                    if not href.startswith("http"):
                        href = "https://www.douyin.com" + href
                    if href in seen_urls:
                        continue
                    seen_urls.add(href)
                    title = (link.inner_text() or keyword).strip()[:100]

                    results.append(SearchResult(
                        url=href, title=title,
                        platform="douyin", platform_name="抖音",
                        content_type="video", snippet=title[:60],
                    ))
                except Exception:
                    continue
        except Exception as e:
            self.logger.warning(f"抖音链接提取异常: {str(e)[:80]}")

        self.logger.info(f"抖音直搜 '{keyword}': {len(results)} 条")
        return results

    # ==================== B站搜索 ====================

    def search_bilibili(self, keyword: str, max_results: int = 20) -> list[SearchResult]:
        results: list[SearchResult] = []
        self._new_page()
        try:
            search_url = f"https://search.bilibili.com/all?keyword={quote(keyword)}"
            self._navigate(search_url, wait_until="domcontentloaded", timeout=25000)
            time.sleep(2)

            for _ in range(4):
                try:
                    self._page.evaluate("window.scrollBy(0, 600)")
                except Exception:
                    break
                time.sleep(1.0)

            seen_urls: set[str] = set()
            items = self._page.query_selector_all('a[href*="/video/"]')

            for item in items:
                if len(results) >= max_results:
                    break
                try:
                    href = item.get_attribute("href") or ""
                    if not href or "BV" not in href:
                        continue
                    if not href.startswith("http"):
                        href = "https:" + href if href.startswith("//") else "https://www.bilibili.com" + href
                    if href in seen_urls:
                        continue
                    seen_urls.add(href)
                    title = (item.inner_text() or keyword).strip()[:100]

                    results.append(SearchResult(
                        url=href, title=title,
                        platform="bilibili", platform_name="B站",
                        content_type="video", snippet=title[:60],
                    ))
                except Exception:
                    continue

            self.logger.info(f"B站搜索 '{keyword}': {len(results)} 条")
        finally:
            self._close_page()
        return results

    # ==================== 小红书搜索 ====================

    def search_xiaohongshu(self, keyword: str, max_results: int = 20) -> list[SearchResult]:
        results: list[SearchResult] = []
        self._new_page()
        try:
            # 直搜
            search_url = f"https://www.xiaohongshu.com/search_result?keyword={quote(keyword)}"
            self._navigate(search_url, wait_until="domcontentloaded", timeout=25000)
            time.sleep(4)

            for _ in range(6):
                try:
                    self._page.evaluate("window.scrollBy(0, 500)")
                except Exception:
                    break
                time.sleep(1.5)

            seen_urls: set[str] = set()
            items = self._page.query_selector_all('a[href*="/explore/"], a[href*="/note/"]')

            for item in items:
                if len(results) >= max_results:
                    break
                try:
                    href = item.get_attribute("href") or ""
                    if not href:
                        continue
                    if not href.startswith("http"):
                        href = "https://www.xiaohongshu.com" + href
                    if href in seen_urls:
                        continue
                    seen_urls.add(href)
                    title = (item.inner_text() or keyword).strip()[:100]

                    results.append(SearchResult(
                        url=href, title=title,
                        platform="xiaohongshu", platform_name="小红书",
                        content_type="image_text", snippet=title[:60],
                    ))
                except Exception:
                    continue

            if not results:
                self.logger.info(f"小红书直搜无结果 → Bing 降级")
                results = self._search_bing_site(keyword, "xiaohongshu.com", "小红书", max_results)

            self.logger.info(f"小红书搜索 '{keyword}': {len(results)} 条")
        finally:
            self._close_page()
        return results

    # ==================== YouTube 搜索 ====================

    def search_youtube(self, keyword: str, max_results: int = 20) -> list[SearchResult]:
        results: list[SearchResult] = []
        self._new_page()
        try:
            search_url = f"https://www.youtube.com/results?search_query={quote(keyword)}"
            self._navigate(search_url, wait_until="domcontentloaded", timeout=25000)
            time.sleep(3)

            for _ in range(3):
                try:
                    self._page.evaluate("window.scrollBy(0, 600)")
                except Exception:
                    break
                time.sleep(1.2)

            seen_urls: set[str] = set()
            items = self._page.query_selector_all('a#video-title')

            for item in items:
                if len(results) >= max_results:
                    break
                try:
                    href = item.get_attribute("href") or ""
                    if not href or "/watch" not in href:
                        continue
                    if not href.startswith("http"):
                        href = "https://www.youtube.com" + href
                    if href in seen_urls:
                        continue
                    seen_urls.add(href)
                    title = (item.inner_text() or keyword).strip()[:100]

                    results.append(SearchResult(
                        url=href, title=title,
                        platform="youtube", platform_name="YouTube",
                        content_type="video", snippet=title[:60],
                    ))
                except Exception:
                    continue

            self.logger.info(f"YouTube搜索 '{keyword}': {len(results)} 条")
        finally:
            self._close_page()
        return results

    # ==================== Instagram ====================

    def search_instagram(self, keyword: str, max_results: int = 20) -> list[SearchResult]:
        self._new_page()
        try:
            results = self._search_instagram_tags(keyword, max_results)
            if results:
                return results
            return self._search_bing_site(keyword, "instagram.com", "Instagram", max_results)
        finally:
            self._close_page()

    def _search_instagram_tags(self, keyword: str, max_results: int = 20) -> list[SearchResult]:
        """Instagram 公开 hashtag/popular 页面，比站内搜索页更少触发登录拦截。"""
        results: list[SearchResult] = []
        seen_urls: set[str] = set()
        for tag in _instagram_tag_candidates(keyword):
            if len(results) >= max_results:
                break
            try:
                url = f"https://www.instagram.com/explore/tags/{quote(tag)}/"
                self._navigate(url, wait_until="domcontentloaded", timeout=25000)
                time.sleep(4)
                links = self._page.eval_on_selector_all(
                    "a[href]",
                    """els => els.map(a => ({
                        href: a.href || a.getAttribute('href') || '',
                        text: a.innerText || a.getAttribute('aria-label') || ''
                    }))""",
                )
                for item in links:
                    if len(results) >= max_results:
                        break
                    href = _normalize_result_url(item.get("href") or "")
                    if not href or href in seen_urls:
                        continue
                    if not _is_platform_content_url(href, "instagram"):
                        continue
                    seen_urls.add(href)
                    title = (item.get("text") or keyword).strip()[:100]
                    results.append(SearchResult(
                        url=href,
                        title=title or keyword,
                        platform="instagram",
                        platform_name="Instagram",
                        content_type="video" if "/reel/" in href.lower() else "image_text",
                        snippet=(title or keyword)[:120],
                    ))
            except Exception as e:
                self.logger.warning(f"Instagram标签搜索失败: {str(e)[:80]}")

        self.logger.info(f"Instagram标签搜索 '{keyword}': {len(results)} 条")
        return results

    # ==================== Facebook ====================

    def search_facebook(self, keyword: str, max_results: int = 20) -> list[SearchResult]:
        self._new_page()
        try:
            results = self._search_facebook_direct(keyword, max_results)
            if results:
                return results
            return self._search_bing_site(keyword, "facebook.com", "Facebook", max_results)
        finally:
            self._close_page()

    def _search_facebook_direct(self, keyword: str, max_results: int = 20) -> list[SearchResult]:
        """Facebook 公开视频搜索页，无需登录时也能暴露部分 reel/video 链接。"""
        results: list[SearchResult] = []
        try:
            for search_keyword in [keyword] + _keyword_english_fallbacks(keyword):
                if len(results) >= max_results:
                    break
                search_url = f"https://zh-cn.facebook.com/search/videos/?q={quote(search_keyword)}"
                self._navigate(search_url, wait_until="domcontentloaded", timeout=25000)
                time.sleep(4)

                for _ in range(3):
                    try:
                        self._page.evaluate("window.scrollBy(0, 700)")
                    except Exception:
                        break
                    time.sleep(1.2)

                seen_urls: set[str] = {r.url for r in results}
                links = self._page.eval_on_selector_all(
                    "a[href]",
                    """els => els.map(a => ({
                        href: a.href || a.getAttribute('href') || '',
                        text: a.innerText || a.getAttribute('aria-label') || ''
                    }))""",
                )
                for item in links:
                    if len(results) >= max_results:
                        break
                    try:
                        href = _normalize_result_url(item.get("href") or "")
                        if not href or href in seen_urls:
                            continue
                        if not _is_platform_content_url(href, "facebook"):
                            continue
                        seen_urls.add(href)
                        title = (item.get("text") or search_keyword).strip()[:100]
                        results.append(SearchResult(
                            url=href,
                            title=title or search_keyword,
                            platform="facebook",
                            platform_name="Facebook",
                            content_type="video",
                            snippet=(title or search_keyword)[:120],
                        ))
                    except Exception:
                        continue
        except Exception as e:
            self.logger.warning(f"Facebook直搜失败: {str(e)[:80]}")

        self.logger.info(f"Facebook直搜 '{keyword}': {len(results)} 条")
        return results

    # ==================== 通用网页搜索 ====================

    def search_web(self, keyword: str, max_results: int = 20) -> list[SearchResult]:
        self._new_page()
        try:
            results = self._search_bing(keyword, max_results)
            if not results:
                results = self._search_duckduckgo(keyword, max_results)
            return results
        finally:
            self._close_page()

    # ==================== 内部搜索方法 ====================

    def _search_duckduckgo(self, keyword: str, max_results: int = 20) -> list[SearchResult]:
        results: list[SearchResult] = []
        try:
            search_url = f"https://duckduckgo.com/?q={quote(keyword)}"
            self._navigate(search_url, wait_until="domcontentloaded", timeout=20000)
            time.sleep(2)

            items = self._page.query_selector_all('article[data-testid="result"], a[data-testid="result-title-a"]')
            seen_urls: set[str] = set()

            for item in items:
                if len(results) >= max_results:
                    break
                try:
                    if self._element_tag_name(item) == 'a':
                        link_el = item
                    else:
                        link_el = item.query_selector('a[data-testid="result-title-a"], h2 a, a[href]')
                    if not link_el:
                        continue
                    href = link_el.get_attribute("href") or ""
                    href = _normalize_result_url(href)
                    if not href:
                        continue
                    if _is_search_engine_or_local_url(href):
                        continue
                    if href in seen_urls:
                        continue
                    seen_urls.add(href)

                    title = link_el.inner_text().strip()
                    platform, platform_name = _guess_platform_from_url(href)

                    results.append(SearchResult(
                        url=href, title=title[:100],
                        platform=platform, platform_name=platform_name,
                        content_type=_content_type_for_platform(platform),
                        snippet=title[:120],
                    ))
                except Exception:
                    continue

            self.logger.info(f"DuckDuckGo '{keyword}': {len(results)} 条")
        except Exception as e:
            self.logger.warning(f"DuckDuckGo失败: {str(e)[:80]}")
        return results

    def _search_bing(self, keyword: str, max_results: int = 20) -> list[SearchResult]:
        results: list[SearchResult] = []
        try:
            search_url = f"https://www.bing.com/search?q={quote(keyword)}&setlang=zh-cn"
            self._navigate(search_url, wait_until="domcontentloaded", timeout=20000)
            time.sleep(2)

            items = self._page.query_selector_all('li.b_algo, ol#b_results > li')
            if not items:
                items = self._page.query_selector_all('h2 a[href]')

            seen_urls: set[str] = set()
            for item in items:
                if len(results) >= max_results:
                    break
                try:
                    link_el = item if self._element_tag_name(item) == 'a' else item.query_selector('h2 a, a[href]')
                    if not link_el:
                        continue
                    href = link_el.get_attribute("href") or ""
                    href = _normalize_result_url(href)
                    if not href or _is_search_engine_or_local_url(href):
                        continue
                    if href in seen_urls:
                        continue
                    seen_urls.add(href)

                    title = link_el.inner_text().strip()
                    platform, platform_name = _guess_platform_from_url(href)

                    results.append(SearchResult(
                        url=href, title=title[:100],
                        platform=platform, platform_name=platform_name,
                        content_type=_content_type_for_platform(platform),
                        snippet=title[:120],
                    ))
                except Exception:
                    continue

            self.logger.info(f"Bing '{keyword}': {len(results)} 条")
        except Exception as e:
            self.logger.warning(f"Bing失败: {str(e)[:80]}")
        return results

    def _search_bing_site(self, keyword: str, site: str, platform_name: str,
                          max_results: int = 20) -> list[SearchResult]:
        results: list[SearchResult] = []
        platform = _platform_from_site(site)
        queries = _platform_site_queries(keyword, platform, site, platform_name)
        try:
            seen_urls: set[str] = set()

            rss_results = self._search_bing_rss_site(queries, platform, platform_name, max_results)
            for result in rss_results:
                if result.url not in seen_urls:
                    seen_urls.add(result.url)
                    results.append(result)
                if len(results) >= max_results:
                    break

            for query in queries:
                if len(results) >= max_results:
                    break

                search_url = f"https://www.bing.com/search?q={quote(query)}&setlang=zh-cn"
                self._navigate(search_url, wait_until="domcontentloaded", timeout=20000)
                time.sleep(2)

                items = self._page.query_selector_all('li.b_algo, ol#b_results > li')
                if not items:
                    items = self._page.query_selector_all('h2 a[href]')

                for item in items:
                    if len(results) >= max_results:
                        break
                    try:
                        link_el = item if self._element_tag_name(item) == 'a' else item.query_selector('h2 a, a[href]')
                        if not link_el:
                            continue
                        href = _normalize_result_url(link_el.get_attribute("href") or "")
                        if not href or href in seen_urls:
                            continue
                        if not _is_platform_content_url(href, platform):
                            continue
                        seen_urls.add(href)

                        title = link_el.inner_text().strip()
                        result = self._make_result(href, title, platform_name)
                        if result:
                            results.append(result)
                    except Exception:
                        continue

            if not results:
                results = self._search_duckduckgo_site(keyword, platform, site, platform_name, max_results)

            self.logger.info(f"搜索引擎 site:{site} '{keyword}': {len(results)} 条")
        except Exception as e:
            self.logger.warning(f"搜索引擎 site失败: {str(e)[:80]}")
        return results

    def _search_bing_rss_site(self, queries: list[str], platform: str, platform_name: str,
                              max_results: int = 20) -> list[SearchResult]:
        results: list[SearchResult] = []
        seen_urls: set[str] = set()
        try:
            import requests
        except Exception:
            return results

        for query in queries:
            if len(results) >= max_results:
                break
            try:
                response = requests.get(
                    "https://www.bing.com/search",
                    params={"q": query, "format": "rss", "setlang": "zh-cn"},
                    headers={"User-Agent": "Mozilla/5.0"},
                    timeout=12,
                )
                if response.status_code != 200:
                    continue

                root = ET.fromstring(response.content)
                for item in root.findall("./channel/item"):
                    if len(results) >= max_results:
                        break
                    href = _normalize_result_url(item.findtext("link") or "")
                    if not href or href in seen_urls:
                        continue
                    if not _is_platform_content_url(href, platform):
                        continue
                    seen_urls.add(href)

                    title = item.findtext("title") or href
                    snippet = item.findtext("description") or title
                    results.append(SearchResult(
                        url=href,
                        title=title[:100],
                        platform=platform,
                        platform_name=platform_name,
                        content_type=_content_type_for_platform(platform),
                        snippet=snippet[:120],
                    ))
            except Exception as e:
                self.logger.warning(f"Bing RSS失败: {str(e)[:80]}")

        if results:
            self.logger.info(f"Bing RSS {platform_name}: {len(results)} 条")
        return results

    def _search_duckduckgo_site(self, keyword: str, platform: str, site: str, platform_name: str,
                                max_results: int = 20) -> list[SearchResult]:
        results: list[SearchResult] = []
        seen_urls: set[str] = set()
        try:
            for query in _platform_site_queries(keyword, platform, site, platform_name):
                if len(results) >= max_results:
                    break
                search_url = f"https://duckduckgo.com/html/?q={quote(query)}"
                self._navigate(search_url, wait_until="domcontentloaded", timeout=20000)
                time.sleep(2)

                items = self._page.query_selector_all('a.result__a, .result__title a, h2 a, a[href]')
                for item in items:
                    if len(results) >= max_results:
                        break
                    try:
                        href = _normalize_result_url(item.get_attribute("href") or "")
                        if not href or href in seen_urls:
                            continue
                        if not _is_platform_content_url(href, platform):
                            continue
                        seen_urls.add(href)

                        title = item.inner_text().strip()
                        result = self._make_result(href, title, platform_name)
                        if result:
                            results.append(result)
                    except Exception:
                        continue
        except Exception as e:
            self.logger.warning(f"DuckDuckGo site失败: {str(e)[:80]}")
        return results

    def _search_bing_general(self, keyword: str, platform: str, platform_name: str,
                             max_results: int = 20) -> list[SearchResult]:
        results: list[SearchResult] = []
        try:
            query = f"{platform_name} {keyword}"
            search_url = f"https://www.bing.com/search?q={quote(query)}&setlang=zh-cn"
            self._navigate(search_url, wait_until="domcontentloaded", timeout=20000)
            time.sleep(2)

            items = self._page.query_selector_all('li.b_algo, ol#b_results > li')
            if not items:
                items = self._page.query_selector_all('h2 a[href]')

            seen_urls: set[str] = set()
            for item in items:
                if len(results) >= max_results:
                    break
                try:
                    link_el = item if self._element_tag_name(item) == 'a' else item.query_selector('h2 a, a[href]')
                    if not link_el:
                        continue
                    href = link_el.get_attribute("href") or ""
                    href = _normalize_result_url(href)
                    if not href or _is_search_engine_or_local_url(href):
                        continue
                    if platform != "web" and not _is_platform_content_url(href, platform):
                        continue
                    if href in seen_urls:
                        continue
                    seen_urls.add(href)

                    title = link_el.inner_text().strip()
                    plat, pname = _guess_platform_from_url(href)

                    results.append(SearchResult(
                        url=href, title=title[:100],
                        platform=plat, platform_name=pname,
                        content_type=_content_type_for_platform(plat),
                        snippet=title[:120],
                    ))
                except Exception:
                    continue

            self.logger.info(f"Bing宽泛 '{query}': {len(results)} 条")
        except Exception as e:
            self.logger.warning(f"Bing宽泛失败: {str(e)[:80]}")
        return results


def _host_matches(hostname: str, domains: tuple[str, ...]) -> bool:
    host = (hostname or "").lower().strip(".")
    return any(host == domain or host.endswith(f".{domain}") for domain in domains)


def _decode_wrapped_search_url(url: str) -> str:
    """解开 Bing/DuckDuckGo 的跳转包装，返回真实目标 URL。"""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    query = parse_qs(parsed.query)

    if _host_matches(host, ("bing.com",)) and parsed.path.startswith("/ck/a"):
        raw = query.get("u", [""])[0]
        if raw.startswith("a1"):
            encoded = raw[2:]
            padding = "=" * (-len(encoded) % 4)
            try:
                return base64.urlsafe_b64decode(encoded + padding).decode("utf-8", errors="ignore")
            except Exception:
                return url

    if _host_matches(host, ("duckduckgo.com",)):
        raw = query.get("uddg", [""])[0]
        if raw:
            return unquote(raw)

    return url


def _normalize_result_url(url: str) -> str:
    if not url:
        return ""
    decoded = _decode_wrapped_search_url(url.strip())
    parsed = urlparse(decoded)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return ""
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", parsed.query, ""))


def _is_search_engine_or_local_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return _host_matches(host, ("bing.com", "microsoft.com", "duckduckgo.com", "localhost"))


def _platform_from_site(site: str) -> str:
    platform, _ = _guess_platform_from_url(f"https://{site}/")
    return platform


def _content_type_for_platform(platform: str) -> str:
    return "video" if platform in ("douyin", "bilibili", "youtube") else "image_text"


def _is_platform_content_url(url: str, platform: str) -> bool:
    parsed = urlparse(_normalize_result_url(url) or url)
    host = parsed.hostname or ""
    path = parsed.path.lower()

    if platform == "douyin":
        return _host_matches(host, ("douyin.com", "iesdouyin.com")) and (
            "/video/" in path or "/note/" in path or "/share/video/" in path
        )
    if platform == "bilibili":
        return _host_matches(host, ("bilibili.com", "b23.tv")) and (
            "/video/" in path or path.startswith("/")
        )
    if platform == "xiaohongshu":
        return _host_matches(host, ("xiaohongshu.com", "xhslink.com")) and (
            "/explore/" in path or "/note/" in path or "/discovery/item/" in path
        )
    if platform == "youtube":
        return _host_matches(host, ("youtube.com", "youtu.be")) and (
            "/watch" in path or "/shorts/" in path or _host_matches(host, ("youtu.be",))
        )
    if platform == "instagram":
        match = re.match(r"^/(?:p|reel|tv)/([a-z0-9_.-]+)/?$", path)
        if not _host_matches(host, ("instagram.com",)) or not match:
            return False
        shortcode = match.group(1)
        return shortcode not in {"signin", "login", "accounts"} and len(shortcode) >= 8
    if platform == "facebook":
        query = parse_qs(parsed.query)
        return _host_matches(host, ("facebook.com", "fb.com", "fb.watch")) and (
            "/videos/" in path or "/posts/" in path
            or "/reel/" in path or "/share/v/" in path
            or _host_matches(host, ("fb.watch",)) or bool(query.get("v"))
        )
    return True


def _platform_site_queries(keyword: str, platform: str, site: str, platform_name: str) -> list[str]:
    base = [
        f"site:{site} {keyword}",
        f"{platform_name} {keyword} site:{site}",
    ]
    extra = {
        "douyin": [
            f"site:douyin.com/video {keyword}",
            f"site:douyin.com/share/video {keyword}",
            f"抖音 {keyword} 视频",
        ],
        "xiaohongshu": [
            f"site:xiaohongshu.com/explore {keyword}",
            f"site:xiaohongshu.com/discovery/item {keyword}",
            f"小红书 {keyword} 笔记",
        ],
        "instagram": [
            f"site:instagram.com/p {keyword}",
            f"site:instagram.com/reel {keyword}",
            f"Instagram {keyword} reel",
        ],
        "facebook": [
            f"site:facebook.com/videos {keyword}",
            f"site:facebook.com/posts {keyword}",
            f"site:facebook.com/reel {keyword}",
            f"site:facebook.com/watch {keyword}",
            f"site:fb.watch {keyword}",
            f"Facebook {keyword} video",
        ],
    }.get(platform, [])
    return base + extra


def _search_profile_seed(platforms: list[str]) -> Optional[Path]:
    """搜索也复用已保存登录态的副本，避免直搜平台反复要求验证。"""
    if has_search_login_state():
        return _SEARCH_PROFILE_DIR
    if "douyin" not in platforms:
        return None
    profile_dir = Path.home() / ".client_lead_miner" / "douyin_profile"
    if (profile_dir / "Default" / "Preferences").exists() or (profile_dir / "Default" / "Cookies").exists():
        return profile_dir
    return None


def _search_headless(platforms: list[str], settings=None) -> bool:
    """部分平台在 headless 搜索页不吐出内容链接，需要短暂使用可见浏览器。"""
    configured = True
    try:
        configured = bool(settings.config.scraper.headless)
    except Exception:
        configured = True
    if "facebook" in platforms:
        return False
    return configured


def _keyword_english_fallbacks(keyword: str) -> list[str]:
    """少量高频中文关键词兜底，服务海外平台公开搜索。"""
    mapping = {
        "咖啡机": ["coffee machine", "coffeemachine"],
        "咖啡": ["coffee"],
        "露营": ["camping"],
        "美妆": ["beauty"],
        "护肤": ["skincare"],
        "家居": ["home decor"],
        "健身": ["fitness"],
        "美食": ["food"],
        "旅行": ["travel"],
    }
    variants: list[str] = []
    for zh, words in mapping.items():
        if zh in keyword:
            variants.extend(words)
    return list(dict.fromkeys(v for v in variants if v and v != keyword))


def _instagram_tag_candidates(keyword: str) -> list[str]:
    candidates: list[str] = []
    ascii_tag = re.sub(r"[^a-zA-Z0-9]+", "", keyword).lower()
    if ascii_tag:
        candidates.append(ascii_tag)
    for variant in _keyword_english_fallbacks(keyword):
        tag = re.sub(r"[^a-zA-Z0-9]+", "", variant).lower()
        if tag:
            candidates.append(tag)
    return list(dict.fromkeys(candidates))


def _guess_platform_from_url(url: str) -> tuple[str, str]:
    parsed = urlparse(_normalize_result_url(url) or url)
    host = parsed.hostname or ""
    if _host_matches(host, ("douyin.com", "iesdouyin.com")):
        return "douyin", "抖音"
    if _host_matches(host, ("bilibili.com", "b23.tv")):
        return "bilibili", "B站"
    if _host_matches(host, ("xiaohongshu.com", "xhslink.com")):
        return "xiaohongshu", "小红书"
    if _host_matches(host, ("youtube.com", "youtu.be")):
        return "youtube", "YouTube"
    if _host_matches(host, ("instagram.com",)):
        return "instagram", "Instagram"
    if _host_matches(host, ("facebook.com", "fb.com", "fb.watch")):
        return "facebook", "Facebook"
    return "web", "网页"


class SearchManager:
    """搜索编排 — 单浏览器上下文 + 每平台独立 page"""

    def __init__(self, llm=None, settings=None, progress_callback=None,
                 log_callback=None, stop_event=None):
        self.llm = llm
        self.settings = settings
        self.progress_callback = progress_callback or (lambda phase, cur, total: None)
        self.log_callback = log_callback or (lambda level, msg: None)
        self._stop_event = stop_event or threading.Event()
        self.logger = Logger()

    def search_all(self, keyword: str, platforms: Optional[list[str]] = None) -> list[SearchResult]:
        """多平台顺序搜索 — 共享 context，每平台独立 page"""
        from playwright.sync_api import sync_playwright

        if platforms is None:
            if self.settings:
                platforms = list(self.settings.config.search.platforms)
            else:
                platforms = ["douyin", "bilibili", "xiaohongshu", "youtube"]

        all_results: list[SearchResult] = []
        total_platforms = len(platforms)

        pw = None
        context = None
        user_data_dir = None

        try:
            # ===== 单 Playwright + 单 Context =====
            pw = sync_playwright().start()

            with _search_browser_lock:
                user_data_dir = tempfile.mkdtemp(prefix="search_edge_")
                profile_seed = _search_profile_seed(platforms)
                if profile_seed:
                    shutil.copytree(profile_seed, user_data_dir, dirs_exist_ok=True)
                    self.log_callback("INFO", "已载入平台搜索登录态")
                headless = _search_headless(platforms, self.settings)
                if not headless:
                    self.log_callback("INFO", "当前平台需要可见浏览器，搜索窗口会自动打开并在结束后关闭")
                launch_args = [
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                ]
                if headless:
                    launch_args.append("--disable-gpu")
                context = pw.chromium.launch_persistent_context(
                    user_data_dir=user_data_dir,
                    headless=headless,
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
                context.add_init_script(_ANTI_DETECT_SCRIPT)

            self.progress_callback("浏览器就绪", 0, total_platforms)
            self.log_callback("INFO", "浏览器已启动（单上下文 + 独立页面）")

            # ===== 每平台创建独立 searcher（各自管理自己的 page）=====
            searcher = PlatformSearcher(context, headless=headless)

            for i, platform in enumerate(platforms):
                if self._stop_event.is_set():
                    break

                self.progress_callback(f"搜索 {_platform_label(platform)}...", i, total_platforms)
                self.log_callback("INFO", f"搜索 '{keyword}' → {_platform_label(platform)}")

                try:
                    search_method = {
                        "douyin": searcher.search_douyin,
                        "bilibili": searcher.search_bilibili,
                        "xiaohongshu": searcher.search_xiaohongshu,
                        "youtube": searcher.search_youtube,
                        "instagram": searcher.search_instagram,
                        "facebook": searcher.search_facebook,
                        "web": lambda kw, mx: searcher.search_web(kw, mx),
                    }.get(platform, searcher.search_web)

                    max_results = self.settings.config.search.max_results_per_platform if self.settings else 20
                    results = search_method(keyword, max_results)
                    all_results.extend(results)

                    self.log_callback("INFO", f"{_platform_label(platform)}: {len(results)} 条结果")
                except Exception as e:
                    self.log_callback("WARNING", f"搜索 {_platform_label(platform)} 异常: {str(e)[:80]}")

                if i < total_platforms - 1 and not self._stop_event.is_set():
                    time.sleep(random.uniform(0.5, 1.0))

        except Exception as e:
            self.log_callback("ERROR", f"搜索管理器异常: {str(e)[:120]}")
        finally:
            # ===== 统一清理 =====
            self.log_callback("INFO", "正在清理浏览器...")
            try:
                if context:
                    context.close()
            except Exception:
                pass
            time.sleep(0.5)
            try:
                if pw:
                    pw.stop()
            except Exception:
                pass
            time.sleep(0.5)
            if user_data_dir:
                try:
                    shutil.rmtree(user_data_dir, ignore_errors=True)
                except Exception:
                    pass
            self.log_callback("INFO", "浏览器已关闭")

        # LLM 过滤
        if self.llm and all_results:
            try:
                self.progress_callback("LLM 筛选...", 0, len(all_results))
                all_results = self.llm.filter_search_results(keyword, all_results)
                self.log_callback("INFO", f"LLM 筛选后保留 {len(all_results)} 条")
            except Exception as e:
                self.log_callback("WARNING", f"LLM 筛选失败: {str(e)[:60]}")

        all_results.sort(key=lambda r: r.relevance, reverse=True)
        return all_results


def _platform_label(platform: str) -> str:
    return {
        "douyin": "抖音", "bilibili": "B站", "xiaohongshu": "小红书",
        "youtube": "YouTube", "instagram": "Instagram", "facebook": "Facebook",
        "web": "网页搜索",
    }.get(platform, platform)
