"""
YouTube平台爬虫
采集YouTube视频评论
"""
import re
import time
from typing import Optional

from .base import BaseScraper, ScraperFactory
from storage.models import CommentInfo


class YoutubeScraper(BaseScraper):
    """YouTube爬虫"""

    platform = "youtube"
    platform_name = "YouTube"

    def get_comments(self, url: str, content_id: str) -> list[CommentInfo]:
        comments: list[CommentInfo] = []
        try:
            self._page.goto(url, wait_until="domcontentloaded", timeout=30000)
            self._random_delay()
        except Exception as e:
            self.logger.error(f"YouTube页面加载失败: {str(e)}")
            return comments

        # 滚动使评论区可见
        for _ in range(3):
            self._page.evaluate("window.scrollBy(0, 500)")
            time.sleep(0.5)

        # 等待评论区加载
        try:
            self._page.wait_for_selector("ytd-comment-thread-renderer", timeout=15000)
        except Exception:
            self.logger.warning("YouTube评论区加载超时")

        progress = getattr(self, '_progress_callback', None)

        collected_ids = set()
        no_new_rounds = 0
        max_scrolls = 50
        for scroll_count in range(max_scrolls):
            comment_elements = self._page.query_selector_all("ytd-comment-thread-renderer")

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

            # 滚动评论区
            comments_section = self._page.query_selector("#sections")
            if comments_section:
                comments_section.evaluate("el => el.scrollTop += 1000")
            self._random_delay()

            # 展开回复
            try:
                expand_buttons = self._page.query_selector_all("#replies button")
                for btn in expand_buttons[:3]:
                    try:
                        btn.click()
                        time.sleep(0.5)
                    except Exception:
                        pass
            except Exception:
                pass

        return comments

    def _parse_comment_element(self, elem, url: str, content_id: str) -> Optional[CommentInfo]:
        try:
            # 评论内容
            text_elem = elem.query_selector("#content-text") or elem.query_selector("#content")
            comment_text = text_elem.inner_text() if text_elem else ""
            if not comment_text or len(comment_text) < 2:
                return None

            # 用户昵称
            user_elem = elem.query_selector("#author-text") or elem.query_selector("#channel-name")
            nickname = user_elem.inner_text() if user_elem else "未知"
            nickname = nickname.replace("@", "").strip()

            # YouTube不显示性别
            gender = "未知"

            # 用户ID
            try:
                user_link = elem.query_selector("a#author-text")
                user_id = user_link.get_attribute("href") if user_link else f"yt_{hash(nickname) & 0xFFFFFFFF:08x}"
            except Exception:
                user_id = f"yt_{hash(nickname) & 0xFFFFFFFF:08x}"

            comment_id = f"yt_cmt_{hash(comment_text + nickname) & 0xFFFFFFFF:08x}"

            # 点赞数
            likes = 0
            try:
                like_elem = elem.query_selector("#vote-count-middle")
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


ScraperFactory.register("youtube", YoutubeScraper)
