"""
OpenAI大模型接口
支持OpenAI API及兼容接口
"""
import json
import re
from typing import Optional

import requests

from .base import BaseLLM, LLMResponse


class OpenAILLM(BaseLLM):
    """OpenAI GPT 接口"""

    API_URL = "https://api.openai.com/v1/chat/completions"

    def __init__(self, api_key: str, model: str = "gpt-3.5-turbo", api_base: str = "", **kwargs):
        super().__init__(api_key, model, **kwargs)
        self.api_base = api_base or self.API_URL

    def analyze_intent(self, comment_text: str, context: Optional[str] = None) -> LLMResponse:
        prompt = self.get_default_prompt(comment_text, context or "")
        try:
            resp = requests.post(
                self.api_base,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": "你是一个专业的购买意向分析助手。请仅返回JSON格式分析结果。"},
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": self.temperature,
                    "max_tokens": self.max_tokens,
                },
                timeout=30,
            )
            if resp.status_code != 200:
                return LLMResponse(
                    success=False,
                    error_message=f"API请求失败: HTTP {resp.status_code} - {resp.text[:200]}"
                )
            data = resp.json()
            content = data["choices"][0]["message"]["content"]
            return self._parse_response(content)
        except requests.RequestException as e:
            return LLMResponse(success=False, error_message=f"网络请求失败: {str(e)}")
        except Exception as e:
            return LLMResponse(success=False, error_message=f"解析失败: {str(e)}")

    def filter_search_results(self, keyword: str, results: list) -> list:
        """LLM 过滤搜索结果的低相关项"""
        if not results:
            return results
        from storage.models import SearchResult
        # 构建结果清单
        items_text = ""
        for i, r in enumerate(results):
            title = r.title if isinstance(r, SearchResult) else r.get("title", "")
            snippet = r.snippet if isinstance(r, SearchResult) else r.get("snippet", "")
            items_text += f"[{i}] {title} | {snippet}\n"

        prompt = f"""关键词：「{keyword}」
以下是从各平台搜索到的结果列表，请判断每一条与关键词的相关性。

结果列表：
{items_text}

请以JSON格式返回相关结果索引列表：
{{"relevant_indices": [0, 2, 5], "reason": "简要说明筛选逻辑"}}

要求：只保留与关键词直接相关的结果，排除完全不相关的、广告性质过强的。JSON仅包含数组。"""
        try:
            resp = requests.post(
                self.api_base,
                headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                json={
                    "model": self.model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.1, "max_tokens": 200,
                },
                timeout=20,
            )
            if resp.status_code == 200:
                data = resp.json()
                content = data["choices"][0]["message"]["content"]
                indices = self._parse_indices(content)
                if indices:
                    filtered = [results[i] for i in indices if i < len(results)]
                    for r in filtered:
                        if isinstance(r, SearchResult):
                            r.relevance = 1.0
                    return filtered
        except Exception:
            pass
        return results

    def extract_company_info(self, html_text: str) -> dict:
        """LLM 从网页文本中提取公司信息"""
        prompt = f"""请从以下网页文本中提取公司的基本信息。
只提取明确提到的信息，不要编造。

网页文本：
{html_text[:4000]}

请以JSON格式返回：
{{"email": "邮箱地址（如有）", "phone": "电话/手机（如有）", "address": "公司地址（如有）",
  "description": "公司简介（如有，50字以内）", "social_links": "社交媒体链接（如有，多个用分号分隔）"}}"""
        try:
            resp = requests.post(
                self.api_base,
                headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                json={
                    "model": self.model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.1, "max_tokens": 500,
                },
                timeout=25,
            )
            if resp.status_code == 200:
                data = resp.json()
                content = data["choices"][0]["message"]["content"]
                return self._parse_json_response(content)
        except Exception:
            pass
        return {}

    def _parse_indices(self, content: str) -> list:
        """解析索引列表"""
        import json as _json
        match = re.search(r'\{[^{}]*\}', content, re.DOTALL)
        if match:
            data = _json.loads(match.group())
            return data.get("relevant_indices", [])
        return []

    def _parse_json_response(self, content: str) -> dict:
        """解析JSON响应"""
        import json as _json
        match = re.search(r'\{[^{}]*\}', content, re.DOTALL)
        if match:
            return _json.loads(match.group())
        try:
            return _json.loads(content)
        except Exception:
            return {}

    def generate_follow_up(self, comment_text: str, intent_level: str, product_info: str = "") -> str:
        prompt = f"""用户评论："{comment_text}"
意向等级：{intent_level}
{('产品信息：' + product_info) if product_info else ''}

请根据以上信息，生成一段自然、亲切的客户跟进话术，用于私信或回复该用户。
话术要求：语气友好、不强制推销、针对性地回应评论内容。"""
        try:
            resp = requests.post(
                self.api_base,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.7,
                    "max_tokens": self.max_tokens,
                },
                timeout=30,
            )
            if resp.status_code == 200:
                data = resp.json()
                return data["choices"][0]["message"]["content"]
            return ""
        except Exception:
            return ""

    def _parse_response(self, content: str) -> LLMResponse:
        """解析LLM返回的JSON"""
        json_match = re.search(r'\{[^{}]*\}', content, re.DOTALL)
        if json_match:
            json_str = json_match.group()
            data = json.loads(json_str)
            return LLMResponse(
                success=True,
                intent_level=data.get("intent_level", "无"),
                confidence=float(data.get("confidence", 0)),
                analysis=data.get("analysis", ""),
                keywords_matched=data.get("keywords", []),
            )
        data = json.loads(content)
        return LLMResponse(
            success=True,
            intent_level=data.get("intent_level", "无"),
            confidence=float(data.get("confidence", 0)),
            analysis=data.get("analysis", ""),
            keywords_matched=data.get("keywords", []),
        )
