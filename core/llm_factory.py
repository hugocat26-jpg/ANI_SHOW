"""LLM provider factory."""
from __future__ import annotations

from typing import Optional

from config.settings import AppSettings
from llm.base import BaseLLM
from llm.deepseek import DeepseekLLM
from llm.kimi import KimiLLM
from llm.openai_llm import OpenAILLM
from llm.tongyi import TongyiLLM
from llm.wenxin import WenxinLLM
from utils.crypto import CryptoUtil
from utils.logger import Logger


def _decrypt(value: str) -> str:
    return CryptoUtil.decrypt(value) if value else ""


def create_llm(settings: AppSettings, logger: Optional[Logger] = None) -> Optional[BaseLLM]:
    """Create the configured LLM instance, or return None when not configured."""
    llm_config = settings.config.llm
    provider = (llm_config.provider or "").lower()
    logger = logger or Logger()

    try:
        common = {
            "temperature": llm_config.temperature,
            "max_tokens": llm_config.max_tokens,
        }
        if provider == "tongyi":
            api_key = _decrypt(llm_config.tongyi_api_key)
            return TongyiLLM(api_key=api_key, model=llm_config.tongyi_model, **common) if api_key else None
        if provider == "wenxin":
            api_key = _decrypt(llm_config.wenxin_api_key)
            secret_key = _decrypt(llm_config.wenxin_secret_key)
            return WenxinLLM(
                api_key=api_key,
                secret_key=secret_key,
                model=llm_config.wenxin_model,
                **common,
            ) if api_key else None
        if provider == "openai":
            api_key = _decrypt(llm_config.openai_api_key)
            return OpenAILLM(api_key=api_key, model=llm_config.openai_model, **common) if api_key else None
        if provider == "deepseek":
            api_key = _decrypt(llm_config.deepseek_api_key)
            return DeepseekLLM(api_key=api_key, model=llm_config.deepseek_model, **common) if api_key else None
        if provider == "kimi":
            api_key = _decrypt(llm_config.kimi_api_key)
            return KimiLLM(api_key=api_key, model=llm_config.kimi_model, **common) if api_key else None
    except Exception as exc:
        logger.warning(f"LLM初始化失败: {str(exc)}，将仅使用关键词识别")

    return None
