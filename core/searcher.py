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
from typing import Optional
from urllib.parse import quote

from PyQt6.QtCore import QThread, pyqtSignal

from storage.models import SearchResult
from utils.logger import Logger

# 浏览器初始化锁
_search_browser_lock = threading.Lock()

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
            return self._search_bing_site(keyword, "instagram.com", "Instagram", max_results)
        finally:
            self._close_page()

    # ==================== Facebook ====================

    def search_facebook(self, keyword: str, max_results: int = 20) -> list[SearchResult]:
        self._new_page()
        try:
            return self._search_bing_site(keyword, "facebook.com", "Facebook", max_results)
        finally:
            self._close_page()

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
                    if item.tag_name == 'a':
                        link_el = item
                    else:
                        link_el = item.query_selector('a[data-testid="result-title-a"], h2 a, a[href]')
                    if not link_el:
                        continue
                    href = link_el.get_attribute("href") or ""
                    if not href.startswith("http"):
                        continue
                    if any(d in href for d in ["duckduckgo.com", "localhost"]):
                        continue
                    if href in seen_urls:
                        continue
                    seen_urls.add(href)

                    title = link_el.inner_text().strip()
                    platform, platform_name = _guess_platform_from_url(href)

                    results.append(SearchResult(
                        url=href, title=title[:100],
                        platform=platform, platform_name=platform_name,
                        content_type="video" if platform in ("douyin", "bilibili", "youtube") else "image_text",
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
                    link_el = item if item.tag_name == 'a' else item.query_selector('h2 a, a[href]')
                    if not link_el:
                        continue
                    href = link_el.get_attribute("href") or ""
                    if not href.startswith("http"):
                        continue
                    if any(d in href for d in ["bing.com", "microsoft.com", "localhost"]):
                        continue
                    if href in seen_urls:
                        continue
                    seen_urls.add(href)

                    title = link_el.inner_text().strip()
                    platform, platform_name = _guess_platform_from_url(href)

                    results.append(SearchResult(
                        url=href, title=title[:100],
                        platform=platform, platform_name=platform_name,
                        content_type="video" if platform in ("douyin", "bilibili", "youtube") else "image_text",
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
        try:
            query = f"site:{site} {keyword}"
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
                    link_el = item if item.tag_name == 'a' else item.query_selector('h2 a, a[href]')
                    if not link_el:
                        continue
                    href = link_el.get_attribute("href") or ""
                    if not href.startswith("http"):
                        continue
                    if "bing.com" in href and "bing.com/ck/a" not in href:
                        continue
                    # 宽松域名匹配
                    site_key = site.split(".")[0]
                    if site_key not in href.lower():
                        continue
                    if href in seen_urls:
                        continue
                    seen_urls.add(href)

                    title = link_el.inner_text().strip()
                    platform = _guess_platform_from_url(href)[0]

                    results.append(SearchResult(
                        url=href, title=title[:100],
                        platform=platform, platform_name=platform_name,
                        content_type="video" if platform in ("douyin", "bilibili", "youtube") else "image_text",
                        snippet=title[:120],
                    ))
                except Exception:
                    continue

            self.logger.info(f"Bing site:{site} '{keyword}': {len(results)} 条")
        except Exception as e:
            self.logger.warning(f"Bing site失败: {str(e)[:80]}")
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
                    link_el = item if item.tag_name == 'a' else item.query_selector('h2 a, a[href]')
                    if not link_el:
                        continue
                    href = link_el.get_attribute("href") or ""
                    if not href.startswith("http"):
                        continue
                    if any(d in href for d in ["bing.com", "microsoft.com", "localhost"]):
                        continue
                    if href in seen_urls:
                        continue
                    seen_urls.add(href)

                    title = link_el.inner_text().strip()
                    plat, pname = _guess_platform_from_url(href)

                    results.append(SearchResult(
                        url=href, title=title[:100],
                        platform=plat, platform_name=pname,
                        content_type="video" if plat in ("douyin", "bilibili", "youtube") else "image_text",
                        snippet=title[:120],
                    ))
                except Exception:
                    continue

            self.logger.info(f"Bing宽泛 '{query}': {len(results)} 条")
        except Exception as e:
            self.logger.warning(f"Bing宽泛失败: {str(e)[:80]}")
        return results


def _guess_platform_from_url(url: str) -> tuple[str, str]:
    url_lower = url.lower()
    if "douyin.com" in url_lower or "iesdouyin" in url_lower:
        return "douyin", "抖音"
    if "bilibili.com" in url_lower or "b23.tv" in url_lower:
        return "bilibili", "B站"
    if "xiaohongshu.com" in url_lower or "xhslink.com" in url_lower:
        return "xiaohongshu", "小红书"
    if "youtube.com" in url_lower or "youtu.be" in url_lower:
        return "youtube", "YouTube"
    if "instagram.com" in url_lower:
        return "instagram", "Instagram"
    if "facebook.com" in url_lower or "fb.com" in url_lower:
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
                launch_args = [
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                ]
                context = pw.chromium.launch_persistent_context(
                    user_data_dir=user_data_dir,
                    headless=True,
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
            searcher = PlatformSearcher(context, headless=True)

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
