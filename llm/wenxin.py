"""
文心一言大模型接口
通过百度千帆平台API调用
"""
import json
import re
from typing import Optional

import requests

from .base import BaseLLM, LLMResponse


class WenxinLLM(BaseLLM):
    """文心一言（百度千帆）"""

    TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token"
    API_URL = "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/"

    def __init__(self, api_key: str, secret_key: str = "", model: str = "ernie-3.5", **kwargs):
        super().__init__(api_key, model, **kwargs)
        self.secret_key = secret_key
        self._access_token: Optional[str] = None

    def _get_access_token(self) -> Optional[str]:
        """获取百度API access_token"""
        if self._access_token:
            return self._access_token
        try:
            resp = requests.post(
                self.TOKEN_URL,
                params={
                    "grant_type": "client_credentials",
                    "client_id": self.api_key,
                    "client_secret": self.secret_key,
                },
                timeout=15,
            )
            if resp.status_code == 200:
                data = resp.json()
                self._access_token = data.get("access_token")
                return self._access_token
        except Exception:
            pass
        return None

    def analyze_intent(self, comment_text: str, context: Optional[str] = None) -> LLMResponse:
        token = self._get_access_token()
        if not token:
            return LLMResponse(success=False, error_message="获取百度API access_token失败，请检查API Key和Secret Key")

        prompt = self.get_default_prompt(comment_text, context or "")
        url = f"{self.API_URL}{self.model}?access_token={token}"
        try:
            resp = requests.post(
                url,
                json={
                    "messages": [
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": self.temperature,
                    "max_output_tokens": self.max_tokens,
                },
                timeout=30,
            )
            if resp.status_code != 200:
                return LLMResponse(
                    success=False,
                    error_message=f"API请求失败: HTTP {resp.status_code} - {resp.text[:200]}"
                )
            data = resp.json()
            content = data.get("result", "")
            return self._parse_response(content)
        except requests.RequestException as e:
            return LLMResponse(success=False, error_message=f"网络请求失败: {str(e)}")
        except Exception as e:
            return LLMResponse(success=False, error_message=f"解析失败: {str(e)}")

    def filter_search_results(self, keyword: str, results: list) -> list:
        if not results:
            return results
        from storage.models import SearchResult
        items_text = ""
        for i, r in enumerate(results):
            title = r.title if isinstance(r, SearchResult) else r.get("title", "")
            snippet = r.snippet if isinstance(r, SearchResult) else r.get("snippet", "")
            items_text += f"[{i}] {title} | {snippet}\n"

        prompt = f"""关键词：「{keyword}」
搜索结果列表，判断每条与关键词的相关性：
{items_text}
请返回JSON: {{"relevant_indices": [相关项的索引列表]}}"""
        token = self._get_access_token()
        if not token:
            return results
        try:
            resp = requests.post(
                f"{self.API_URL}{self.model}?access_token={token}",
                json={"messages": [{"role": "user", "content": prompt}], "temperature": 0.1, "max_output_tokens": 200},
                timeout=20,
            )
            if resp.status_code == 200:
                data = resp.json()
                content = data.get("result", "")
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
        prompt = f"""从网页文本提取公司信息，JSON格式：
{{"email": "", "phone": "", "address": "", "description": "", "social_links": ""}}

网页文本：
{html_text[:4000]}"""
        token = self._get_access_token()
        if not token:
            return {}
        try:
            resp = requests.post(
                f"{self.API_URL}{self.model}?access_token={token}",
                json={"messages": [{"role": "user", "content": prompt}], "temperature": 0.1, "max_output_tokens": 500},
                timeout=25,
            )
            if resp.status_code == 200:
                data = resp.json()
                content = data.get("result", "")
                return self._parse_json_response(content)
        except Exception:
            pass
        return {}

    def _parse_indices(self, content: str) -> list:
        import json as _json
        match = re.search(r'\{[^{}]*\}', content, re.DOTALL)
        if match:
            data = _json.loads(match.group())
            return data.get("relevant_indices", [])
        return []

    def _parse_json_response(self, content: str) -> dict:
        import json as _json
        match = re.search(r'\{[^{}]*\}', content, re.DOTALL)
        if match:
            return _json.loads(match.group())
        try:
            return _json.loads(content)
        except Exception:
            return {}

    def generate_follow_up(self, comment_text: str, intent_level: str, product_info: str = "") -> str:
        token = self._get_access_token()
        if not token:
            return ""
        prompt = f"""用户评论："{comment_text}"
意向等级：{intent_level}
{('产品信息：' + product_info) if product_info else ''}

请根据以上信息，生成一段自然、亲切的客户跟进话术，用于私信或回复该用户。"""
        url = f"{self.API_URL}{self.model}?access_token={token}"
        try:
            resp = requests.post(
                url,
                json={
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.7,
                    "max_output_tokens": self.max_tokens,
                },
                timeout=30,
            )
            if resp.status_code == 200:
                data = resp.json()
                return data.get("result", "")
        except Exception:
            pass
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
