"""Application service composition root."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from config.settings import AppSettings, get_settings
from core.ai_service import AIService
from core.data_exporter import DataExporter
from core.info_extractor import InfoExtractor
from core.intent_recognizer import IntentRecognizer
from core.link_parser import LinkParser
from core.llm_factory import create_llm
from core.platforms.catalog import PlatformCatalog
from core.policies import CompliancePolicy
from core.scraper.base import ScraperFactory
from core.task_manager import TaskManager
from llm.base import BaseLLM
from storage.database import Database
from utils.logger import Logger


@dataclass
class ApplicationServices:
    settings: AppSettings
    logger: Logger
    database: Database
    llm: Optional[BaseLLM]
    ai: AIService
    compliance: CompliancePolicy
    platforms: PlatformCatalog
    link_parser: LinkParser
    extractor: InfoExtractor
    recognizer: IntentRecognizer
    exporter: DataExporter
    task_manager: TaskManager

    @classmethod
    def build(
        cls,
        *,
        settings: Optional[AppSettings] = None,
        database: Optional[Database] = None,
        max_concurrent: Optional[int] = None,
        pending_callback: Optional[Callable] = None,
    ) -> "ApplicationServices":
        settings = settings or get_settings()
        settings.load()
        logger = Logger()
        database = database or Database()
        llm = create_llm(settings, logger)
        recognizer = IntentRecognizer(llm)
        extractor = InfoExtractor(database)
        task_manager = TaskManager(
            ScraperFactory,
            recognizer,
            extractor,
            database,
            max_concurrent=max_concurrent or settings.config.scraper.concurrent_tasks,
        )
        if pending_callback:
            task_manager.set_pending_callback(pending_callback)

        return cls(
            settings=settings,
            logger=logger,
            database=database,
            llm=llm,
            ai=AIService(llm),
            compliance=CompliancePolicy(),
            platforms=PlatformCatalog(),
            link_parser=LinkParser(),
            extractor=extractor,
            recognizer=recognizer,
            exporter=DataExporter(database),
            task_manager=task_manager,
        )

    def reload_ai(self) -> None:
        """Reload LLM-backed services after settings change."""
        self.settings.load()
        self.llm = create_llm(self.settings, self.logger)
        self.ai = AIService(self.llm)
        self.recognizer = IntentRecognizer(self.llm)
        self.task_manager.recognizer = self.recognizer
