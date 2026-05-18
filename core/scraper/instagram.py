"""
Instagram平台爬虫
采集帖子和Reel评论
"""
import re
import time
from typing import Optional

from .base import BaseScraper, ScraperFactory
from storage.models import CommentInfo


class InstagramScraper(BaseScraper):
    """Instagram爬虫"""

    platform = "instagram"
    platform_name = "Instagram"

    def get_comments(self, url: str, content_id: str) -> list[CommentInfo]:
        comments: list[CommentInfo] = []
        try:
            self._page.goto(url, wait_until="domcontentloaded", timeout=30000)
            self._random_delay()
        except Exception as e:
            self.logger.error(f"Instagram页面加载失败: {str(e)}")
            return comments

        # Instagram评论在 article 下的 ul 中
        try:
            self._page.wait_for_selector("article", timeout=15000)
        except Exception:
            self.logger.warning("Instagram内容加载超时")

        progress = getattr(self, '_progress_callback', None)

        collected_ids = set()
        no_new_rounds = 0
        max_scrolls = 50
        for scroll_count in range(max_scrolls):
            comment_elements = self._page.query_selector_all("ul li[role='menuitem']")

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

            # 滚动加载更多评论
            self._page.evaluate("window.scrollBy(0, 600)")
            self._random_delay()

            # 点击加载更多
            try:
                load_more = self._page.query_selector("text=View replies") or \
                            self._page.query_selector("text=Load more")
                if load_more:
                    load_more.click()
                    time.sleep(0.5)
            except Exception:
                pass

        return comments

    def _parse_comment_element(self, elem, url: str, content_id: str) -> Optional[CommentInfo]:
        try:
            # 评论内容
            text_elem = elem.query_selector("span") or elem.query_selector('[class*="comment"]')
            if not text_elem:
                return None
            comment_text = text_elem.inner_text()
            if not comment_text or len(comment_text) < 2:
                return None

            # 用户昵称
            user_elem = elem.query_selector("a[href*='/']") or elem.query_selector("h3")
            nickname = user_elem.inner_text() if user_elem else "未知"

            user_id = f"ig_{hash(nickname) & 0xFFFFFFFF:08x}"

            comment_id = f"ig_cmt_{hash(comment_text + nickname) & 0xFFFFFFFF:08x}"

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
                gender="未知",
                comment_text=comment_text,
                comment_time="",
                content_url=url,
                content_id=content_id,
                content_type="image_text",
                likes=likes,
            )
        except Exception:
            return None


ScraperFactory.register("instagram", InstagramScraper)
