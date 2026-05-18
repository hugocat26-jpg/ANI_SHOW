"""
操作按钮栏
提供开始、暂停、停止、导出、设置按钮
主按钮（哑光金）、次按钮（低饱和边框）
"""
from PyQt6.QtWidgets import QWidget, QHBoxLayout, QPushButton
from PyQt6.QtCore import pyqtSignal


# 规范色值
_GOLD        = "#B88646"
_GOLD_HOVER  = "#C89555"
_CARD_BORDER = "#232836"
_BODY        = "#A6ADB8"
_TITLE       = "#F5F0E6"


class OperationBar(QWidget):
    """操作按钮栏"""

    start_clicked = pyqtSignal()
    pause_clicked = pyqtSignal()
    stop_clicked = pyqtSignal()
    export_clicked = pyqtSignal()
    settings_clicked = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._is_collecting = False
        self._is_paused = False
        self._init_ui()

    def _init_ui(self) -> None:
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(12)

        # 主按钮样式（哑光金）
        primary_btn_style = f"""
            QPushButton {{
                background-color: {_GOLD};
                color: #FFFFFF;
                border: none;
                border-radius: 8px;
                padding: 0 16px;
                min-height: 36px;
                min-width: 88px;
                font-size: 12px;
                font-weight: 500;
            }}
            QPushButton:hover {{
                background-color: {_GOLD_HOVER};
            }}
            QPushButton:pressed {{
                background-color: #A6783D;
            }}
            QPushButton:disabled {{
                background-color: #5A4A38;
                color: #86909C;
            }}
        """

        # 次按钮样式（低饱和边框）
        secondary_btn_style = f"""
            QPushButton {{
                border: 1px solid {_CARD_BORDER};
                border-radius: 8px;
                padding: 0 16px;
                background-color: transparent;
                color: {_BODY};
                min-height: 36px;
                min-width: 88px;
                font-size: 12px;
            }}
            QPushButton:hover {{
                border-color: {_GOLD};
                background-color: #151A26;
            }}
            QPushButton:pressed {{
                background-color: #1E1820;
                border-color: #A6783D;
            }}
            QPushButton:disabled {{
                color: #86909C;
                border-color: {_CARD_BORDER};
            }}
        """

        # 开始采集（主按钮 — 哑光金）
        self.start_btn = QPushButton("开始采集")
        self.start_btn.setStyleSheet(primary_btn_style)
        self.start_btn.clicked.connect(self.start_clicked)
        layout.addWidget(self.start_btn)

        # 暂停（次按钮）
        self.pause_btn = QPushButton("暂停")
        self.pause_btn.setEnabled(False)
        self.pause_btn.setStyleSheet(secondary_btn_style)
        self.pause_btn.clicked.connect(self._on_pause)
        layout.addWidget(self.pause_btn)

        # 停止（次按钮）
        self.stop_btn = QPushButton("停止")
        self.stop_btn.setEnabled(False)
        self.stop_btn.setStyleSheet(secondary_btn_style)
        self.stop_btn.clicked.connect(self.stop_clicked)
        layout.addWidget(self.stop_btn)

        layout.addSpacing(16)

        # 刷新数据（次按钮）
        self.refresh_btn = QPushButton("刷新数据")
        self.refresh_btn.setStyleSheet(secondary_btn_style)
        self.refresh_btn.clicked.connect(self.export_clicked)
        layout.addWidget(self.refresh_btn)

        # 导出表格（主按钮 — 哑光金）
        self.export_btn = QPushButton("导出表格")
        self.export_btn.setStyleSheet(primary_btn_style)
        self.export_btn.clicked.connect(self.export_clicked)
        layout.addWidget(self.export_btn)

        layout.addSpacing(16)

        # 设置（次按钮）
        self.settings_btn = QPushButton("设置")
        self.settings_btn.setStyleSheet(secondary_btn_style)
        self.settings_btn.clicked.connect(self.settings_clicked)
        layout.addWidget(self.settings_btn)

    def set_collecting_state(self, is_collecting: bool) -> None:
        """设置采集状态（禁用/启用按钮）"""
        self._is_collecting = is_collecting
        self.start_btn.setEnabled(not is_collecting)
        self.pause_btn.setEnabled(is_collecting)
        self.stop_btn.setEnabled(is_collecting)

    def set_pause_button(self, is_paused: bool) -> None:
        """设置暂停按钮状态"""
        self._is_paused = is_paused
        self.pause_btn.setText("恢复" if is_paused else "暂停")

    def _on_pause(self) -> None:
        self.set_pause_button(not self._is_paused)
        self.pause_clicked.emit()
