"""
小红书平台爬虫
采集图文内容和评论
"""
import re
import time
from typing import Optional

from .base import BaseScraper, ScraperFactory
from storage.models import CommentInfo


class XiaohongshuScraper(BaseScraper):
    """小红书爬虫"""

    platform = "xiaohongshu"
    platform_name = "小红书"

    def get_comments(self, url: str, content_id: str) -> list[CommentInfo]:
        comments: list[CommentInfo] = []
        progress = getattr(self, '_progress_callback', None)

        try:
            self._page.goto(url, wait_until="domcontentloaded", timeout=30000)
            self._random_delay()
        except Exception as e:
            self.logger.error(f"小红书页面加载失败: {str(e)}")
            return comments

        # 等待内容区域加载
        try:
            self._page.wait_for_selector('[class*="note"]', timeout=15000)
        except Exception:
            self.logger.warning("小红书页面加载超时，尝试继续")

        # 评论区选择器（多种后备）
        comment_selectors = [
            '[class*="comment-item"]',
            '[class*="commentItem"]',
            '[class*="comment"] > div',
            '[class*="note"] [class*="item"]',
        ]

        collected_ids = set()
        no_new_rounds = 0
        max_scrolls = 50
        for scroll_count in range(max_scrolls):
            comment_elements = []
            for sel in comment_selectors:
                elements = self._page.query_selector_all(sel)
                if elements and len(elements) > 0:
                    comment_elements = elements
                    break

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

            # 展开回复
            try:
                reply_buttons = self._page.query_selector_all('text=回复')
                for btn in reply_buttons[:5]:
                    try:
                        btn.click()
                        time.sleep(0.3)
                    except Exception:
                        pass
            except Exception:
                pass

        return comments

    def _parse_comment_element(self, elem, url: str, content_id: str) -> Optional[CommentInfo]:
        try:
            # 提取评论内容
            text_elem = elem.query_selector('[class*="content"]') or elem.query_selector('[class*="desc"]')
            comment_text = text_elem.inner_text() if text_elem else ""
            if not comment_text or len(comment_text) < 2:
                return None

            # 提取用户昵称
            user_elem = elem.query_selector('[class*="name"]') or elem.query_selector('[class*="username"]')
            nickname = user_elem.inner_text() if user_elem else "未知"

            # 性别（小红书可能显示）
            gender = "未知"

            # 用户ID
            user_id = f"xhs_{hash(nickname) & 0xFFFFFFFF:08x}"

            # 评论ID
            comment_id = f"xhs_cmt_{hash(comment_text + nickname) & 0xFFFFFFFF:08x}"

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
                content_type="image_text",
                likes=likes,
            )
        except Exception:
            return None


ScraperFactory.register("xiaohongshu", XiaohongshuScraper)
