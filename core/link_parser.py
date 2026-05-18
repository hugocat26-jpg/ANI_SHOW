"""
链接解析模块
负责链接格式校验、平台识别、内容类型判断、内容ID提取
"""
import hashlib
from typing import Optional

from utils.validators import LinkValidator
from utils.logger import Logger


class LinkParser:
    """链接解析器"""

    def __init__(self):
        self.logger = Logger()

    def parse(self, url: str) -> Optional[dict]:
        """
        解析一条链接
        返回: {
            "url": 原始链接,
            "platform": 平台标识,
            "platform_name": 平台中文名,
            "content_type": video/image_text,
            "content_id": 内容唯一ID,
            "task_id": 任务唯一ID,
            "is_valid": 是否有效,
            "error": 错误信息（如有）
        }
        """
        url = url.strip()
        result = {
            "url": url,
            "platform": "",
            "platform_name": "",
            "content_type": "",
            "content_id": "",
            "task_id": "",
            "is_valid": False,
            "error": "",
        }

        # 1. 校验链接格式
        is_valid, error = LinkValidator.validate(url)
        if not is_valid:
            result["error"] = error
            self.logger.error(f"链接解析失败: {url} - {error}")
            return result

        # 2. 识别平台
        platform = LinkValidator.identify_platform(url)
        if not platform:
            result["error"] = "无法识别平台类型"
            return result
        result["platform"] = platform
        result["platform_name"] = LinkValidator.get_platform_name(platform)

        # 3. 判断内容类型
        result["content_type"] = LinkValidator.guess_content_type(url, platform)

        # 4. 提取内容ID
        content_id = LinkValidator.extract_content_id(url, platform)
        if not content_id:
            result["error"] = "无法提取内容ID，请检查链接是否正确"
            return result
        result["content_id"] = content_id

        # 5. 生成任务唯一ID
        task_id = hashlib.md5(f"{platform}_{content_id}".encode()).hexdigest()[:16]
        result["task_id"] = task_id

        result["is_valid"] = True
        self.logger.info(f"链接解析成功: {result['platform_name']} - {result['content_type']} - {result['content_id']}")
        return result

    def parse_batch(self, urls: list) -> list[dict]:
        """
        批量解析链接
        返回: 解析结果列表（包含成功和失败的结果）
        """
        results = []
        total = len(urls)
        for i, url in enumerate(urls, 1):
            url = url.strip()
            if not url:
                continue
            self.logger.info(f"正在解析第{i}条链接，共{total}条")
            result = self.parse(url)
            results.append(result)
        success_count = sum(1 for r in results if r["is_valid"])
        self.logger.success(f"链接解析完成: 总计{len(results)}条, 成功{success_count}条")
        return results
