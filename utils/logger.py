"""
日志系统模块
支持文件日志 + UI回调双输出，日志分级、筛选、导出
"""
import logging
import os
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Optional, Callable


class LogLevel(Enum):
    DEBUG = logging.DEBUG
    INFO = logging.INFO
    SUCCESS = 25       # 自定义成功级别
    WARNING = logging.WARNING
    ERROR = logging.ERROR


# 注册自定义日志级别
logging.addLevelName(LogLevel.SUCCESS.value, "SUCCESS")


class UILogHandler(logging.Handler):
    """UI日志处理器 — 将日志消息通过回调发送到界面"""

    def __init__(self, callback: Optional[Callable] = None):
        super().__init__()
        self.callback = callback
        self.setLevel(logging.DEBUG)

    def set_callback(self, callback: Callable) -> None:
        self.callback = callback

    def emit(self, record: logging.LogRecord) -> None:
        if self.callback:
            log_entry = {
                "time": datetime.fromtimestamp(record.created).strftime("%Y-%m-%d %H:%M:%S"),
                "level": record.levelname,
                "level_color": self._level_color(record.levelno),
                "message": self.format(record),
                "levelno": record.levelno,
            }
            self.callback(log_entry)

    @staticmethod
    def _level_color(levelno: int) -> str:
        if levelno >= logging.ERROR:
            return "#D9534F"    # 错误红
        elif levelno >= logging.WARNING:
            return "#F0AD4E"    # 警告橙
        elif levelno == LogLevel.SUCCESS.value:
            return "#5CB85C"    # 成功绿
        else:
            return "#F5F0E6"    # 信息暖白


class Logger:
    """日志管理器（单例）"""

    _instance: Optional["Logger"] = None

    def __new__(cls) -> "Logger":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self) -> None:
        if self._initialized:
            return
        self._initialized = True
        self._logger = logging.getLogger("ClientLeadMiner")
        self._logger.setLevel(logging.DEBUG)
        self._ui_handler = UILogHandler()
        self._logger.addHandler(self._ui_handler)
        self._file_handler: Optional[logging.FileHandler] = None
        self._log_records: list = []  # 内存中保留最近的日志用于导出

    def init_file_logger(self, log_dir: Optional[Path] = None) -> None:
        """初始化文件日志处理器"""
        if log_dir is None:
            from config.settings import AppSettings
            log_dir = AppSettings.get_log_dir()
        log_file = log_dir / f"app_{datetime.now().strftime('%Y%m%d')}.log"
        self._file_handler = logging.FileHandler(
            log_file, encoding="utf-8", mode="a"
        )
        self._file_handler.setLevel(logging.DEBUG)
        formatter = logging.Formatter(
            "%(asctime)s [%(levelname)s] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S"
        )
        self._file_handler.setFormatter(formatter)
        self._logger.addHandler(self._file_handler)

    def set_ui_callback(self, callback: Callable) -> None:
        """设置UI日志回调函数"""
        self._ui_handler.set_callback(callback)

    def _log(self, level: LogLevel, message: str) -> None:
        record = logging.LogRecord(
            name="ClientLeadMiner",
            level=level.value,
            pathname="",
            lineno=0,
            msg=message,
            args=(),
            exc_info=None,
        )
        self._logger.handle(record)
        self._log_records.append({
            "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "level": logging.getLevelName(level.value),
            "message": message,
        })

    def debug(self, message: str) -> None:
        self._log(LogLevel.DEBUG, message)

    def info(self, message: str) -> None:
        self._log(LogLevel.INFO, message)

    def success(self, message: str) -> None:
        self._log(LogLevel.SUCCESS, message)

    def warning(self, message: str) -> None:
        self._log(LogLevel.WARNING, message)

    def error(self, message: str) -> None:
        self._log(LogLevel.ERROR, message)

    def get_records(self, level_filter: Optional[str] = None) -> list:
        """获取日志记录，支持按级别筛选"""
        if level_filter:
            return [r for r in self._log_records if r["level"] == level_filter]
        return self._log_records.copy()

    def clear(self) -> None:
        self._log_records.clear()

    def export(self, file_path: str) -> None:
        """导出日志到文本文件"""
        with open(file_path, "w", encoding="utf-8") as f:
            for record in self._log_records:
                f.write(f"[{record['time']}] [{record['level']}] {record['message']}\n")
