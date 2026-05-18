"""
合规提示弹窗
首次启动时必须同意合规声明才能使用软件
深色主题
"""
from PyQt6.QtWidgets import (
    QDialog, QVBoxLayout, QLabel, QPushButton,
    QHBoxLayout, QTextEdit,
)
from PyQt6.QtCore import Qt

from utils.compliance import ComplianceChecker


# 规范色值
_PAGE_BG     = "#0A0D17"
_CARD_BG     = "#151A26"
_CARD_BORDER = "#232836"
_TITLE       = "#F5F0E6"
_BODY        = "#A6ADB8"
_MUTED       = "#86909C"
_GOLD        = "#B88646"
_GOLD_HOVER  = "#C89555"
_ERROR       = "#D9534F"


class ComplianceDialog(QDialog):
    """合规声明"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("合规声明")
        self.setFixedSize(500, 450)
        self.setStyleSheet(f"QDialog {{ background-color: {_PAGE_BG}; }}")
        self._agreed = False
        self._init_ui()

    def _init_ui(self) -> None:
        layout = QVBoxLayout(self)

        title = QLabel("重要：使用合规声明")
        title.setStyleSheet(f"font-size: 16px; font-weight: 500; color: {_ERROR};")
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(title)

        notice_text = QTextEdit()
        notice_text.setReadOnly(True)
        notice_text.setPlainText(ComplianceChecker.get_compliance_notice())
        notice_text.setStyleSheet(f"""
            QTextEdit {{
                font-size: 13px;
                color: {_BODY};
                font-weight: 300;
                background-color: {_CARD_BG};
                border: 1px solid {_CARD_BORDER};
                border-radius: 8px;
                padding: 8px;
            }}
        """)
        layout.addWidget(notice_text)

        warning = QLabel("如果您不同意上述规定，请关闭本软件。")
        warning.setStyleSheet(f"color: {_ERROR}; font-weight: 500;")
        warning.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(warning)

        btn_layout = QHBoxLayout()
        btn_layout.setSpacing(12)

        disagree_btn = QPushButton("不同意")
        disagree_btn.setStyleSheet(f"""
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
            QPushButton:hover {{ border-color: {_ERROR}; background-color: {_CARD_BG}; }}
        """)
        disagree_btn.clicked.connect(self.reject)
        btn_layout.addWidget(disagree_btn)

        btn_layout.addStretch()

        agree_btn = QPushButton("同意并遵守")
        agree_btn.setStyleSheet(f"""
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
            QPushButton:hover {{ background-color: {_GOLD_HOVER}; }}
            QPushButton:pressed {{ background-color: #A6783D; }}
        """)
        agree_btn.clicked.connect(self._on_agree)
        btn_layout.addWidget(agree_btn)

        layout.addLayout(btn_layout)

    def _on_agree(self) -> None:
        self._agreed = True
        self.accept()
