"""
B站平台爬虫
采集B站视频评论
"""
import re
import time
from typing import Optional

from .base import BaseScraper, ScraperFactory
from storage.models import CommentInfo


class BilibiliScraper(BaseScraper):
    """B站爬虫"""

    platform = "bilibili"
    platform_name = "B站"

    def get_comments(self, url: str, content_id: str) -> list[CommentInfo]:
        comments: list[CommentInfo] = []
        progress = getattr(self, '_progress_callback', None)

        try:
            self._page.goto(url, wait_until="domcontentloaded", timeout=30000)
            self._random_delay()
        except Exception as e:
            self.logger.error(f"B站页面加载失败: {str(e)}")
            return comments

        # 滚动到评论区位置（B站评论区在页面下方，需要滚动触发生成）
        try:
            # 先尝试滚动到评论区锚点
            reply_section = self._page.query_selector('#reply, [class*="reply-list"], [class*="comment-container"]')
            if reply_section:
                reply_section.scroll_into_view_if_needed()
                time.sleep(2)
        except Exception:
            pass

        # 多次向下滚动以确保评论加载
        for _ in range(3):
            self._page.evaluate("window.scrollBy(0, 600)")
            time.sleep(1.5)

        # 等待评论区加载
        try:
            self._page.wait_for_selector(
                '[class*="reply-item"], [class*="reply-wrap"], [class*="comment-list"], '
                '.reply-list li, .comment-container div, #comment div',
                timeout=15000
            )
        except Exception:
            self.logger.warning("B站评论区加载超时，尝试继续...")

        comment_selectors = [
            '.reply-list [class*="reply-item"]',
            '[class*="reply-item"]',
            '[class*="reply-wrap"] > div',
            '[class*="comment-list"] > div',
            '.reply-list li',
            '#comment [class*="item"]',
            '[class*="bb-comment"]',
        ]

        collected_ids = set()
        no_new_rounds = 0
        max_scrolls = 50
        for scroll_count in range(max_scrolls):
            comment_elements = []
            for sel in comment_selectors:
                try:
                    elements = self._page.query_selector_all(sel)
                    if elements and len(elements) > 0:
                        comment_elements = elements
                        break
                except Exception:
                    continue

            round_new = 0
            for elem in comment_elements:
                try:
                    comment = self._parse_comment_element(elem, url, content_id)
                    if comment and comment.comment_id not in collected_ids:
                        collected_ids.add(comment.comment_id)
                        comments.append(comment)
                        round_new += 1
                except Exception:
                    continue

            if len(comments) >= 500:
                break

            if progress:
                progress(f"正在采集评论... ({len(comments)}条)",
                         min(scroll_count + 1, max_scrolls), max_scrolls)

            if round_new == 0:
                no_new_rounds += 1
                if no_new_rounds >= 5:
                    break
            else:
                no_new_rounds = 0

            self._random_scroll()
            self._random_delay()

        return comments

    def _parse_comment_element(self, elem, url: str, content_id: str) -> Optional[CommentInfo]:
        try:
            # B站评论内容在 .reply-content 中
            text_elem = elem.query_selector('[class*="reply-content"]') or elem.query_selector('[class*="text"]')
            comment_text = text_elem.inner_text() if text_elem else ""
            if not comment_text or len(comment_text) < 2:
                return None

            # 用户昵称
            user_elem = elem.query_selector('[class*="user-name"]') or elem.query_selector('[class*="name"]')
            nickname = user_elem.inner_text() if user_elem else "未知"

            # B站评论可能显示性别
            gender = "未知"
            try:
                gender_elem = elem.query_selector('[class*="gender"]')
                if gender_elem:
                    gender_class = gender_elem.get_attribute("class") or ""
                    if "male" in gender_class:
                        gender = "男"
                    elif "female" in gender_class:
                        gender = "女"
            except Exception:
                pass

            # 用户ID (B站UID)
            user_id = f"bili_{hash(nickname) & 0xFFFFFFFF:08x}"
            try:
                uid_elem = elem.query_selector('[data-user-id]')
                if uid_elem:
                    uid = uid_elem.get_attribute("data-user-id")
                    if uid:
                        user_id = uid
            except Exception:
                pass

            comment_id = f"bili_cmt_{hash(comment_text + nickname) & 0xFFFFFFFF:08x}"

            # 点赞
            likes = 0
            try:
                like_elem = elem.query_selector('[class*="like"]')
                if like_elem:
                    like_text = like_elem.inner_text()
                    likes = int(re.sub(r'\D', '', like_text) or 0)
            except Exception:
                pass

            return self._create_comment(
                comment_id=comment_id,
                user_id=user_id,
                nickname=nickname,
                gender=gender,
                comment_text=comment_text,
                comment_time="",
                content_url=url,
                content_id=content_id,
                content_type="video",
                likes=likes,
            )
        except Exception:
            return None


ScraperFactory.register("bilibili", BilibiliScraper)
