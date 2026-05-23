"""
公司信息提取模块
搜索官网、提取联系方式、公司信息结构化
使用 DuckDuckGo 搜索 + LLM 解析页面内容
"""
import re
import os
import time
import threading
from typing import Optional
from urllib.parse import quote

from PyQt6.QtCore import QThread, pyqtSignal

from storage.models import CompanyInfo
from utils.logger import Logger

_search_lock = threading.Lock()


def _browser_security_args() -> list[str]:
    if os.environ.get("CLIENT_LEAD_MINER_DISABLE_BROWSER_SANDBOX") != "1":
        return []
    Logger().warning("高风险兼容开关已启用: CLIENT_LEAD_MINER_DISABLE_BROWSER_SANDBOX=1")
    return ["--no-sandbox"]


class CompanySearchWorker(QThread):
    """公司搜索工作线程"""
    progress = pyqtSignal(str, int, int)
    company_found = pyqtSignal(dict)
    search_finished = pyqtSignal(str, list)       # keyword, list[CompanyInfo]
    search_error = pyqtSignal(str)
    log = pyqtSignal(str, str)

    def __init__(self, company_name: str, llm=None):
        super().__init__()
        self.company_name = company_name
        self.llm = llm
        self._stop_event = threading.Event()
        self.logger = Logger()

    def run(self) -> None:
        try:
            self.log.emit("INFO", f"搜索公司: '{self.company_name}'")
            self.progress.emit("搜索官网...", 0, 100)

            extractor = CompanyExtractor(llm=self.llm)
            info = extractor.search_company(self.company_name)

            if info:
                self.company_found.emit(info.to_dict())
                self.search_finished.emit(self.company_name, [info])
                self.log.emit("SUCCESS", f"公司信息提取完成: {info.name}")
            else:
                self.log.emit("WARNING", f"未找到 '{self.company_name}' 的公司信息")
                self.search_finished.emit(self.company_name, [])
        except Exception as e:
            self.log.emit("ERROR", f"公司搜索失败: {str(e)}")
            self.search_error.emit(str(e))

    def stop(self) -> None:
        self._stop_event.set()


class CompanyExtractor:
    """公司信息提取器"""

    def __init__(self, llm=None):
        self.llm = llm
        self.logger = Logger()

    def search_company(self, company_name: str) -> Optional[CompanyInfo]:
        """搜索公司信息"""
        from playwright.sync_api import sync_playwright

        with _search_lock:
            p = sync_playwright().start()
            try:
                context = p.chromium.launch_persistent_context(
                    user_data_dir="",
                    headless=True,
                    channel="msedge",
                    args=["--disable-gpu", *_browser_security_args()],
                    viewport={"width": 1920, "height": 1080},
                    locale="zh-CN",
                )
                page = context.new_page()

                # 1. DuckDuckGo 搜索公司官网
                search_url = f"https://html.duckduckgo.com/html/?q={quote(company_name + ' 官网')}"
                page.goto(search_url, wait_until="domcontentloaded", timeout=20000)
                time.sleep(1.5)

                # 提取搜索结果中的官网 URL
                official_url = self._find_official_url(page, company_name)

                if not official_url:
                    # 再试百度
                    search_url = f"https://www.baidu.com/s?wd={quote(company_name + ' 官网')}"
                    page.goto(search_url, wait_until="domcontentloaded", timeout=20000)
                    time.sleep(2)
                    official_url = self._find_official_url_baidu(page)

                if not official_url:
                    self.logger.warning(f"未找到 {company_name} 的官网")
                    context.close()
                    p.stop()
                    return None

                self.logger.info(f"找到官网: {official_url}")

                # 2. 访问官网提取信息
                page_text = self._fetch_page_text(page, official_url)

                # 3. LLM 解析结构化信息
                info = self._parse_company_info(company_name, official_url, page_text)
                context.close()
                p.stop()
                return info

            except Exception as e:
                self.logger.error(f"公司搜索异常: {str(e)[:100]}")
                try:
                    context.close()
                except Exception:
                    pass
                try:
                    p.stop()
                except Exception:
                    pass
                return None

    def _find_official_url(self, page, company_name: str) -> Optional[str]:
        """从 DuckDuckGo 搜索结果提取官网"""
        links = page.query_selector_all('a.result__a, a[class*="result__url"]')
        for link in links:
            try:
                href = link.get_attribute("href")
                if not href or not href.startswith("http"):
                    continue
                if any(d in href for d in ["duckduckgo.com", "baidu.com", "google.com"]):
                    continue
                # 优先选择看起来像官网的（不含搜索/social/media等）
                if not any(kw in href.lower() for kw in
                           ["search", "zhihu", "weibo", "douyin", "xiaohongshu",
                            "baike", "wikipedia", "linkedin", "facebook"]):
                    return href
            except Exception:
                continue
        return None

    def _find_official_url_baidu(self, page) -> Optional[str]:
        """从百度搜索结果提取官网"""
        items = page.query_selector_all('[class*="result"], [class*="c-container"]')
        for item in items:
            try:
                # 百度官网标识
                official_tag = item.query_selector('[class*="c-color-gray"], [class*="official"]')
                link = item.query_selector('a[href*="http"]')
                if link:
                    href = link.get_attribute("href")
                    if href and href.startswith("http") and "baidu.com" not in href:
                        return href
            except Exception:
                continue
        return None

    def _fetch_page_text(self, page, url: str, max_chars: int = 8000) -> str:
        """抓取页面文本"""
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=20000)
            time.sleep(2)
            # 获取可见文本
            text = page.evaluate("""() => {
                const body = document.body;
                if (!body) return '';
                const clone = body.cloneNode(true);
                // 移除脚本和样式
                for (const el of clone.querySelectorAll('script, style, nav, footer, header')) {
                    el.remove();
                }
                return (clone.innerText || clone.textContent || '').substring(0, 8000);
            }""")
            return text[:max_chars]
        except Exception as e:
            self.logger.warning(f"抓取页面文本失败: {str(e)[:60]}")
            return ""

    def _parse_company_info(self, company_name: str, url: str, page_text: str) -> CompanyInfo:
        """解析公司信息 — 正则 + LLM"""

        info = CompanyInfo(name=company_name, website=url, source=url)

        # 正则快速提取邮箱
        emails = re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', page_text)
        if emails:
            info.email = emails[0]

        # 正则提取电话（中国手机号/座机号）
        phones = re.findall(
            r'(?:电话|Tel|Phone|手机|热线|联系电话|联系方式)[：:\s]*[+\d][\d\-\s()（）]{7,20}',
            page_text, re.IGNORECASE
        )
        if not phones:
            phones = re.findall(r'(?:1[3-9]\d{9})', page_text)
        if phones:
            info.phone = phones[0] if isinstance(phones[0], str) else phones[0]

        # 正则提取地址
        addr_patterns = re.findall(
            r'(?:地址|Address|ADD)[：:\s]*([^\n]{5,80})',
            page_text, re.IGNORECASE
        )
        if addr_patterns:
            info.address = addr_patterns[0].strip()

        # LLM 深度提取
        if self.llm and page_text:
            try:
                extracted = self.llm.extract_company_info(page_text[:5000])
                if extracted:
                    if not info.email and extracted.get("email"):
                        info.email = extracted["email"]
                    if not info.phone and extracted.get("phone"):
                        info.phone = extracted["phone"]
                    if not info.address and extracted.get("address"):
                        info.address = extracted["address"]
                    if extracted.get("description"):
                        info.description = extracted["description"]
                    if extracted.get("social_links"):
                        info.social_links = extracted["social_links"]
            except Exception as e:
                self.logger.warning(f"LLM 公司信息提取失败: {str(e)[:60]}")

        return info

    def batch_search(self, company_names: list[str]) -> list[CompanyInfo]:
        """批量搜索公司"""
        results: list[CompanyInfo] = []
        for name in company_names:
            info = self.search_company(name)
            if info:
                results.append(info)
            time.sleep(2)
        return results
