"""
链接输入区组件
支持单条/多条链接批量粘贴（换行分隔）
深色主题卡片样式
"""
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTextEdit,
    QLabel, QPushButton, QGroupBox,
)
from PyQt6.QtCore import Qt


# 规范色值
_CARD_BG     = "#151A26"
_CARD_BORDER = "#232836"
_TITLE       = "#F5F0E6"
_BODY        = "#A6ADB8"
_MUTED       = "#86909C"
_INPUT_BG    = "#151A26"
_INPUT_BORDER = "#232836"
_GOLD        = "#B88646"


class LinkInputWidget(QGroupBox):
    """链接输入区"""

    def __init__(self, parent=None):
        super().__init__("● 链接输入区", parent)
        self._init_ui()

    def _init_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setSpacing(8)

        # 辅助说明文字
        hint_label = QLabel("请输入视频/图文链接，每行一条，支持批量粘贴（抖音、小红书、B站、YouTube、Instagram、Facebook）")
        hint_label.setStyleSheet(f"color: {_MUTED}; font-size: 10px; font-weight: 300;")
        hint_label.setWordWrap(True)
        layout.addWidget(hint_label)

        # 输入框
        self.text_edit = QTextEdit()
        self.text_edit.setPlaceholderText(
            "示例：\n"
            "https://www.douyin.com/video/123456789\n"
            "https://www.xiaohongshu.com/note/abc123\n"
            "https://www.bilibili.com/video/BV1xx411c7mD\n"
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        )
        self.text_edit.setMaximumHeight(200)
        self.text_edit.setMinimumHeight(100)
        self.text_edit.setStyleSheet(f"""
            QTextEdit {{
                border: 1px solid {_INPUT_BORDER};
                border-radius: 8px;
                padding: 10px 12px;
                background-color: {_INPUT_BG};
                color: {_TITLE};
                font-size: 12px;
                selection-background-color: {_GOLD};
                selection-color: #FFFFFF;
            }}
            QTextEdit:focus {{
                border-color: {_GOLD};
            }}
        """)
        layout.addWidget(self.text_edit)

        # 底部按钮行
        btn_layout = QHBoxLayout()
        btn_layout.setSpacing(12)

        self.clear_btn = QPushButton("清空")
        self.clear_btn.setFixedWidth(72)
        self.clear_btn.setStyleSheet(f"""
            QPushButton {{
                border: 1px solid {_CARD_BORDER};
                border-radius: 8px;
                padding: 0 12px;
                background-color: transparent;
                color: {_BODY};
                min-height: 32px;
                min-width: 72px;
                font-size: 12px;
            }}
            QPushButton:hover {{
                border-color: {_GOLD};
                background-color: {_CARD_BG};
            }}
        """)
        self.clear_btn.clicked.connect(self.clear)
        btn_layout.addWidget(self.clear_btn)

        btn_layout.addStretch()

        self.count_label = QLabel("已输入 0 条链接")
        self.count_label.setStyleSheet(f"color: {_MUTED}; font-size: 10px; font-weight: 300;")
        btn_layout.addWidget(self.count_label)

        layout.addLayout(btn_layout)

        # 连接信号
        self.text_edit.textChanged.connect(self._update_count)

    def get_urls(self) -> list[str]:
        """获取输入的链接列表"""
        text = self.text_edit.toPlainText().strip()
        if not text:
            return []
        urls = [line.strip() for line in text.split("\n") if line.strip()]
        return urls

    def append_urls(self, urls: list[str]) -> None:
        """追加链接到输入框（不覆盖已有内容）"""
        existing = self.get_urls()
        new_urls = [u for u in urls if u not in existing]
        if new_urls:
            current_text = self.text_edit.toPlainText().rstrip()
            if current_text:
                current_text += "\n"
            self.text_edit.setPlainText(current_text + "\n".join(new_urls))
            self._update_count()

    def set_urls(self, urls: list[str]) -> None:
        """设置链接（覆盖已有内容）"""
        self.text_edit.setPlainText("\n".join(urls))
        self._update_count()

    def clear(self) -> None:
        self.text_edit.clear()

    def _update_count(self) -> None:
        urls = self.get_urls()
        self.count_label.setText(f"已输入 {len(urls)} 条链接")
