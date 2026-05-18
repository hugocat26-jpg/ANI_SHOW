"""
日志展示面板
实时显示操作日志，支持筛选、清空、导出
深色黑底面板，彩色分级日志文字，等宽字体
"""
from typing import Optional

from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTextEdit,
    QPushButton, QComboBox, QLabel, QGroupBox,
    QFileDialog,
)
from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtGui import QTextCursor


# 规范色值
LOG_BG      = "#0A0D17"
LOG_TEXT    = "#A6ADB8"
LOG_INFO    = "#F5F0E6"
LOG_SUCCESS = "#5CB85C"
LOG_WARNING = "#F0AD4E"
LOG_ERROR   = "#D9534F"
_CARD_BORDER = "#232836"
_GOLD        = "#B88646"
_BODY        = "#A6ADB8"


class LogPanel(QGroupBox):
    """日志展示面板"""

    MAX_LOG_LINES = 500

    def __init__(self, parent=None):
        super().__init__("● 操作日志", parent)
        self._log_count = 0
        self._init_ui()

    def _init_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setSpacing(8)

        # 筛选栏
        filter_layout = QHBoxLayout()
        filter_layout.setSpacing(8)

        filter_label = QLabel("筛选:")
        filter_label.setStyleSheet(f"color: {_BODY}; font-size: 12px;")
        filter_layout.addWidget(filter_label)

        self.level_combo = QComboBox()
        self.level_combo.addItems(["全部", "SUCCESS", "INFO", "WARNING", "ERROR"])
        self.level_combo.setStyleSheet(f"""
            QComboBox {{
                border: 1px solid {_CARD_BORDER};
                border-radius: 8px;
                padding: 0 12px;
                background-color: #151A26;
                color: {_BODY};
                font-size: 12px;
                min-height: 32px;
                min-width: 100px;
            }}
            QComboBox:focus {{ border-color: {_GOLD}; }}
            QComboBox::drop-down {{ border: none; width: 20px; }}
            QComboBox QAbstractItemView {{
                background-color: #151A26;
                border: 1px solid {_CARD_BORDER};
                border-radius: 8px;
                selection-background-color: #2A2218;
                color: {_BODY};
                outline: none;
            }}
        """)
        self.level_combo.currentTextChanged.connect(self._apply_filter)
        filter_layout.addWidget(self.level_combo)

        filter_layout.addStretch()

        # 次按钮样式
        btn_style = f"""
            QPushButton {{
                border: 1px solid {_CARD_BORDER};
                border-radius: 8px;
                padding: 0 12px;
                background-color: transparent;
                color: {_BODY};
                min-height: 32px;
                min-width: 64px;
                font-size: 11px;
            }}
            QPushButton:hover {{
                border-color: {_GOLD};
                background-color: #151A26;
            }}
        """

        self.clear_btn = QPushButton("清空")
        self.clear_btn.setStyleSheet(btn_style)
        self.clear_btn.clicked.connect(self.clear)
        filter_layout.addWidget(self.clear_btn)

        self.export_btn = QPushButton("导出日志")
        self.export_btn.setStyleSheet(btn_style)
        self.export_btn.clicked.connect(self._export_log)
        filter_layout.addWidget(self.export_btn)

        layout.addLayout(filter_layout)

        # 日志文本区 — 深色底 + 等宽 11px
        self.log_text = QTextEdit()
        self.log_text.setReadOnly(True)
        self.log_text.setStyleSheet(f"""
            QTextEdit {{
                font-family: "Cascadia Code", "Consolas", "Courier New", monospace;
                font-size: 11px;
                background-color: {LOG_BG};
                color: {LOG_TEXT};
                border: 1px solid {_CARD_BORDER};
                border-radius: 8px;
                selection-background-color: #2A2218;
                selection-color: {LOG_INFO};
                padding: 4px 8px;
            }}
        """)
        layout.addWidget(self.log_text)

        # 存储原始日志（用于筛选）
        self._all_logs: list[str] = []
        self._filtered_logs: list[str] = []

    def add_log(self, log_entry: dict) -> None:
        """
        添加一条日志
        log_entry: {"time": ..., "level": ..., "message": ..., "level_color": ...}
        """
        level = log_entry.get("level", "INFO")
        color = log_entry.get("level_color", LOG_INFO)
        time_str = log_entry.get("time", "")
        message = log_entry.get("message", "")

        html_line = (
            f'<span style="color:#86909C;">[{time_str}]</span> '
            f'<span style="color:{color};">[{level}]</span> '
            f'<span style="color:{LOG_TEXT};">{message}</span>'
        )
        self._all_logs.append(html_line)

        # 筛选逻辑
        current_filter = self.level_combo.currentText()
        if current_filter == "全部" or current_filter == level:
            self._add_line(html_line)

        # 超过最大行数时删除旧行
        self._log_count += 1
        if self._log_count > self.MAX_LOG_LINES:
            self._all_logs = self._all_logs[-self.MAX_LOG_LINES:]
            self._refresh_display()

    def _add_line(self, html_line: str) -> None:
        """向文本区添加一行"""
        self.log_text.moveCursor(QTextCursor.MoveOperation.End)
        self.log_text.insertHtml(html_line + "<br>")
        scrollbar = self.log_text.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())

    def _apply_filter(self) -> None:
        """按日志级别筛选"""
        self._refresh_display()

    def _refresh_display(self) -> None:
        """刷新日志显示"""
        self.log_text.clear()
        current_filter = self.level_combo.currentText()
        for line in self._all_logs:
            if current_filter == "全部":
                self.log_text.insertHtml(line + "<br>")
            else:
                if f"[{current_filter}]" in line:
                    self.log_text.insertHtml(line + "<br>")
        scrollbar = self.log_text.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())

    def clear(self) -> None:
        """清空日志"""
        self._all_logs.clear()
        self.log_text.clear()
        self._log_count = 0

    def _export_log(self) -> None:
        """导出日志到文件"""
        file_path, _ = QFileDialog.getSaveFileName(
            self, "导出日志", "操作日志.txt",
            "文本文件 (*.txt);;所有文件 (*)"
        )
        if file_path:
            with open(file_path, "w", encoding="utf-8") as f:
                for line in self._all_logs:
                    import re
                    text = re.sub(r'<[^>]+>', '', line)
                    f.write(text + "\n")
