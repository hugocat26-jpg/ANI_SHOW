"""
抖音平台爬虫
采集视频评论
通过拦截抖音评论 API 网络响应直接获取结构化数据，
配合页面滚动触发更多 API 请求。
使用持久化浏览器 Profile 保存登录态，绕过验证码。
"""
import os
import re
import time
from pathlib import Path
from typing import Optional

from .base import BaseScraper, ScraperFactory
from storage.models import CommentInfo

# 抖音浏览器 Profile 持久化目录（保存登录态）
_DOUYIN_PROFILE_DIR = Path.home() / ".client_lead_miner" / "douyin_profile"


def _browser_security_args() -> list[str]:
    if os.environ.get("CLIENT_LEAD_MINER_DISABLE_BROWSER_SANDBOX") != "1":
        return []
    try:
        from utils.logger import Logger
        Logger().warning("高风险兼容开关已启用: CLIENT_LEAD_MINER_DISABLE_BROWSER_SANDBOX=1")
    except Exception:
        pass
    return ["--no-sandbox"]


class DouyinScraper(BaseScraper):
    """抖音爬虫 — 网络拦截 + DOM 兜底 + 持久化登录态"""

    platform = "douyin"
    platform_name = "抖音"

    # ==================== 登录流程 ====================

    @classmethod
    def login(cls, headless: bool = False) -> bool:
        """打开可见浏览器让用户手动扫码登录，登录态保存到持久化目录"""
        import shutil
        from playwright.sync_api import sync_playwright

        _DOUYIN_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        logger = None
        try:
            from utils.logger import Logger
            logger = Logger()
        except Exception:
            pass

        p = sync_playwright().start()
        try:
            context = p.chromium.launch_persistent_context(
                user_data_dir=str(_DOUYIN_PROFILE_DIR),
                headless=headless,
                channel="msedge",
                args=["--disable-blink-features=AutomationControlled", *_browser_security_args()],
                viewport={"width": 1920, "height": 1080},
                locale="zh-CN",
            )
            page = context.new_page()
            page.goto("https://www.douyin.com", wait_until="domcontentloaded", timeout=30000)
            print("[抖音登录] 请在浏览器中扫码登录抖音账号...")
            print("[抖音登录] 登录成功后，关闭浏览器窗口即可。")

            if logger:
                logger.info("抖音登录: 请在浏览器中扫码登录，完成后手动关闭窗口")

            # 等待用户关闭浏览器（通过检测页面是否仍然打开）
            try:
                page.wait_for_event("close", timeout=300000)  # 5分钟超时
            except Exception:
                pass

            print("[抖音登录] 登录态已保存。")
            if logger:
                logger.success("抖音登录态已保存到本地")
            return True
        except Exception as e:
            print(f"[抖音登录] 失败: {e}")
            if logger:
                logger.error(f"抖音登录失败: {e}")
            return False
        finally:
            try:
                p.stop()
            except Exception:
                pass

    @classmethod
    def is_logged_in(cls) -> bool:
        """检查是否有已保存的登录态"""
        pref_file = _DOUYIN_PROFILE_DIR / "Default" / "Preferences"
        cookies_file = _DOUYIN_PROFILE_DIR / "Default" / "Cookies"
        return pref_file.exists() or cookies_file.exists()

    # ==================== 评论采集 ====================

    def get_comments(self, url: str, content_id: str) -> list[CommentInfo]:
        from config.settings import get_settings
        max_comments = get_settings().config.scraper.max_comments_per_item
        progress = getattr(self, '_progress_callback', None)

        # ===== 用 Python 端 response 事件拦截评论 API（比 JS 注入更可靠）=====
        self._raw_comments: list[dict] = []
        self._seen_cids: set[str] = set()
        self._comment_cursor = 0
        self._comment_has_more = True

        def _on_response(response):
            """捕获 /aweme/v1/web/comment/list/ 响应"""
            try:
                if "/aweme/v" not in response.url:
                    return
                if "/comment/list/" not in response.url and "/comment/list/" not in response.url:
                    return
                body = response.body()
                if not body or len(body) < 100:
                    return
                import json
                data = json.loads(body)
                comment_list = data.get("comments") or data.get("comment_list") or []
                for c in comment_list:
                    cid = str(c.get("cid", ""))
                    if cid and cid not in self._seen_cids:
                        self._seen_cids.add(cid)
                        self._raw_comments.append(c)
                self._comment_cursor = data.get("cursor", 0)
                self._comment_has_more = data.get("has_more", False)
            except Exception:
                pass

        self._page.on("response", _on_response)

        # 加载页面
        try:
            self._page.goto(url, wait_until="domcontentloaded", timeout=30000)
            self._random_delay()
        except Exception as e:
            self.logger.error(f"抖音页面加载失败: {str(e)}")
            return self._parse_api_comments(self._raw_comments, content_id, max_comments)

        # 等待初始数据加载
        time.sleep(5)

        init_count = len(self._raw_comments)
        self.logger.info(f"初始拦截到 {init_count} 条评论数据")

        # 检测是否被验证码拦截
        try:
            body_text = self._page.evaluate("() => document.body.innerText.substring(0, 200)")
            if any(kw in body_text for kw in ["滑块验证", "请完成", "captcha", "验证码"]):
                self.logger.warning("抖音弹出验证码！请先登录抖音账号：运行 DouyinScraper.login()")
        except Exception:
            pass

        # 关闭弹窗
        self._page.evaluate("""() => {
            const btns = document.querySelectorAll('[class*="close"], [class*="Close"]');
            for (const btn of btns) { if (btn.offsetHeight > 0) { btn.click(); break; } }
        }""")

        # ===== 持续滚动触发更多评论 API =====
        last_count = init_count
        no_new = 0

        for round_idx in range(300):
            # 滚动所有可滚动容器
            self._page.evaluate("""() => {
                const divs = document.querySelectorAll('div');
                for (const d of divs) {
                    if (d.scrollHeight > d.clientHeight + 10 && d.clientHeight > 80) {
                        d.scrollTop += 400;
                    }
                }
                window.scrollBy(0, 400);
            }""")
            time.sleep(1.5)

            # 点击展开按钮
            self._page.evaluate("""() => {
                const all = document.querySelectorAll('span, div');
                for (const el of all) {
                    const t = (el.textContent || '').trim();
                    if ((t === '展开更多回复' || t === '展开' || t === '加载更多' ||
                         t === '查看更多' || t === '查看全部') && el.offsetHeight > 0) {
                        el.click();
                    }
                }
            }""")
            time.sleep(1.0)

            cur_count = len(self._raw_comments)

            if progress and round_idx % 5 == 0:
                progress(f"采集评论... ({cur_count}条)",
                          min(cur_count, max_comments), max_comments)

            if cur_count >= max_comments:
                self.logger.info(f"已达到采集上限 {max_comments} 条")
                break

            if cur_count == last_count:
                no_new += 1
                if no_new >= 20:
                    self.logger.info(f"连续 {no_new} 轮无新数据，停止采集")
                    break
            else:
                no_new = 0
                last_count = cur_count

        return self._parse_api_comments(self._raw_comments, content_id, max_comments)

    # ==================== API 数据解析 ====================

    def _parse_api_comments(self, raw_list: list[dict], content_id: str, max_count: int) -> list[CommentInfo]:
        comments: list[CommentInfo] = []
        seen_ids: set[str] = set()

        for c in raw_list:
            try:
                user = c.get("user", {})
                nickname = user.get("nickname", "") or "未知"
                uid = user.get("short_id", "") or user.get("uid", "") or str(user.get("sec_uid", ""))
                if not uid or uid == "0":
                    uid = f"dy_{hash(nickname) & 0xFFFFFFFF:08x}"

                text = c.get("text", "")
                if not text or len(text) < 2:
                    continue

                cid = str(c.get("cid", ""))

                create_time = c.get("create_time", 0) or c.get("createTime", 0)
                time_str = ""
                if create_time:
                    try:
                        from datetime import datetime
                        time_str = datetime.fromtimestamp(int(create_time)).strftime("%Y-%m-%d %H:%M:%S")
                    except Exception:
                        pass

                likes = c.get("digg_count", 0) or c.get("like_count", 0)

                comment_id = f"dy_{cid}" if cid else f"dy_{hash(text + uid) & 0xFFFFFFFF:08x}"
                if comment_id in seen_ids:
                    continue
                seen_ids.add(comment_id)

                # 子评论（回复）
                replies = c.get("reply_comment") or c.get("reply_comments") or []
                if replies:
                    for r in replies:
                        if isinstance(r, dict):
                            raw_list.append(r)

                comment = self._create_comment(
                    comment_id=comment_id,
                    user_id=uid,
                    nickname=nickname,
                    gender="未知",
                    comment_text=text,
                    comment_time=time_str,
                    content_url=f"https://www.douyin.com/video/{content_id}",
                    content_id=content_id,
                    content_type="video",
                    likes=likes,
                )
                comments.append(comment)
                if len(comments) >= max_count:
                    break
            except Exception:
                continue

        return comments

    # ==================== DOM 补充采集 ====================

    def _fetch_dom_supplement(self, url: str, content_id: str) -> list[CommentInfo]:
        comments: list[CommentInfo] = []

        for selector in [
            '[data-e2e="comment-item"]',
            '[class*="comment-item"]',
        ]:
            elements = []
            try:
                elements = self._page.query_selector_all(selector)
                if elements:
                    break
            except Exception:
                continue

        for elem in elements:
            try:
                c = self._parse_dom_comment(elem, url, content_id)
                if c:
                    comments.append(c)
            except Exception:
                continue

        if comments:
            self.logger.info(f"DOM 补充了 {len(comments)} 条评论")
        return comments

    def _parse_dom_comment(self, elem, url: str, content_id: str) -> Optional[CommentInfo]:
        try:
            user_link = elem.query_selector('a[href*="/user/"]')
            nickname = "未知"
            if user_link:
                nickname = user_link.inner_text().strip() or "未知"
            if nickname == "未知":
                name_el = elem.query_selector('[class*="name"], [class*="nickname"], [class*="author"]')
                if name_el:
                    nickname = name_el.inner_text().strip() or "未知"

            full_text = elem.inner_text()
            lines = [l.strip() for l in full_text.split("\n") if l.strip()]
            skip_words = {"...", "举报", "回复", "分享", "赞", "踩", "收藏"}
            lines = [l for l in lines if l not in skip_words and not l.isdigit()]

            time_pattern = re.compile(r"(\d+\s*(天|小时|分钟|秒)前|\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2})")
            time_idx = -1
            time_str = ""
            for i, line in enumerate(lines):
                m = time_pattern.search(line)
                if m:
                    time_idx = i
                    time_str = m.group(1)
                    break

            comment_text = ""
            if time_idx > 1:
                comment_text = " ".join(lines[1:time_idx])
            elif len(lines) > 1:
                for line in lines[1:]:
                    if line != nickname and len(line) > 2:
                        comment_text = line
                        break

            if not comment_text or len(comment_text) < 2:
                return None

            user_id = f"dy_{hash(nickname) & 0xFFFFFFFF:08x}"
            try:
                href = user_link.get_attribute("href") if user_link else ""
                if "/user/" in href:
                    uid = href.split("/user/")[-1].split("?")[0]
                    if uid:
                        user_id = uid
            except Exception:
                pass

            comment_id = f"dy_cmt_{hash(comment_text + nickname + content_id) & 0xFFFFFFFF:08x}"
            likes = 0

            return self._create_comment(
                comment_id=comment_id,
                user_id=user_id,
                nickname=nickname,
                gender="未知",
                comment_text=comment_text,
                comment_time=time_str,
                content_url=url,
                content_id=content_id,
                content_type="video",
                likes=likes,
            )
        except Exception:
            return None


ScraperFactory.register("douyin", DouyinScraper)
