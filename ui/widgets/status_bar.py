"""
状态栏组件
显示当前状态（就绪/采集中/完成）+ 模式信息 + 软件版本
深色主题 — 10px Light 300 弱化文字
"""
from PyQt6.QtWidgets import QWidget, QHBoxLayout, QLabel
from PyQt6.QtCore import Qt


# 规范色值
_PAGE_BG     = "#0A0D17"
_CARD_BORDER = "#232836"
_BODY        = "#A6ADB8"
_MUTED       = "#86909C"
_SUCCESS     = "#5CB85C"
_WARNING     = "#F0AD4E"
_ERROR       = "#D9534F"
_GOLD        = "#B88646"


class StatusBarWidget(QWidget):
    """底部状态栏"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setStyleSheet(f"""
            QWidget {{
                border-top: 1px solid {_CARD_BORDER};
                background-color: transparent;
            }}
        """)
        self._init_ui()

    def _init_ui(self) -> None:
        layout = QHBoxLayout(self)
        layout.setContentsMargins(20, 4, 20, 4)
        layout.setSpacing(8)

        # 状态指示器
        self.status_dot = QLabel("●")
        self.status_dot.setStyleSheet(f"color: {_SUCCESS}; font-size: 10px;")
        layout.addWidget(self.status_dot)

        self.status_label = QLabel("就绪")
        self.status_label.setStyleSheet(f"color: {_BODY}; font-size: 10px; font-weight: 300;")
        layout.addWidget(self.status_label)

        layout.addStretch()

        # 线索统计
        self.lead_count_label = QLabel("")
        self.lead_count_label.setStyleSheet(f"color: {_MUTED}; font-size: 10px; font-weight: 300;")
        layout.addWidget(self.lead_count_label)

        layout.addSpacing(16)

        # 模式标签
        from config.settings import get_settings
        mode = get_settings().config.network.mode
        mode_text = "本地模式" if mode == "local" else "联网模式"

        self.network_label = QLabel(f"运行模式: {mode_text}")
        self.network_label.setStyleSheet(f"color: {_MUTED}; font-size: 10px; font-weight: 300;")
        layout.addWidget(self.network_label)

        layout.addSpacing(16)

        # 版本号
        self.version_label = QLabel("v1.0.0")
        self.version_label.setStyleSheet(f"color: {_MUTED}; font-size: 10px; font-weight: 300;")
        layout.addWidget(self.version_label)

    def update_status(self, text: str) -> None:
        """更新状态文本"""
        self.status_label.setText(text)
        if "失败" in text or "错误" in text or "error" in text.lower():
            self.status_dot.setStyleSheet(f"color: {_ERROR}; font-size: 10px;")
        elif "运行" in text or "running" in text.lower():
            self.status_dot.setStyleSheet(f"color: {_GOLD}; font-size: 10px;")
        elif "暂停" in text or "paused" in text.lower():
            self.status_dot.setStyleSheet(f"color: {_WARNING}; font-size: 10px;")
        else:
            self.status_dot.setStyleSheet(f"color: {_SUCCESS}; font-size: 10px;")
