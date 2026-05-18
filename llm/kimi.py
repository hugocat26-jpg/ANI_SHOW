"""
Kimi大模型接口（月之暗面Moonshot）
使用OpenAI兼容API，通过api.moonshot.cn调用
"""
from .openai_llm import OpenAILLM


class KimiLLM(OpenAILLM):
    """Kimi（月之暗面Moonshot）- OpenAI兼容接口"""

    API_URL = "https://api.moonshot.cn/v1/chat/completions"

    def __init__(self, api_key: str, model: str = "moonshot-v1-8k", **kwargs):
        super().__init__(api_key=api_key, model=model, api_base=self.API_URL, **kwargs)
