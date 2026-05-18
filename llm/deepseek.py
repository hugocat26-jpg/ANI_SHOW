"""
DeepSeek大模型接口
使用OpenAI兼容API，通过api.deepseek.com调用
"""
from .openai_llm import OpenAILLM


class DeepseekLLM(OpenAILLM):
    """DeepSeek（深度求索）- OpenAI兼容接口"""

    API_URL = "https://api.deepseek.com/v1/chat/completions"

    def __init__(self, api_key: str, model: str = "deepseek-chat", **kwargs):
        super().__init__(api_key=api_key, model=model, api_base=self.API_URL, **kwargs)
