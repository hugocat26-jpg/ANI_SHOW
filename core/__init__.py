def __getattr__(name):
    if name == "LinkParser":
        from .link_parser import LinkParser
        return LinkParser
    if name == "TaskManager":
        from .task_manager import TaskManager
        return TaskManager
    if name == "IntentRecognizer":
        from .intent_recognizer import IntentRecognizer
        return IntentRecognizer
    if name == "InfoExtractor":
        from .info_extractor import InfoExtractor
        return InfoExtractor
    if name == "DataExporter":
        from .data_exporter import DataExporter
        return DataExporter
    if name == "ScraperFactory":
        from .scraper import ScraperFactory
        return ScraperFactory
    raise AttributeError(name)
