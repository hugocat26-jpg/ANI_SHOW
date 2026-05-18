"""
新手引导弹窗
首次使用时的操作指引
深色主题
"""
from PyQt6.QtWidgets import (
    QDialog, QVBoxLayout, QLabel, QPushButton,
    QHBoxLayout,
)
from PyQt6.QtCore import Qt


# 规范色值
_PAGE_BG     = "#0A0D17"
_CARD_BG     = "#151A26"
_CARD_BORDER = "#232836"
_TITLE       = "#F5F0E6"
_BODY        = "#A6ADB8"
_MUTED       = "#86909C"
_GOLD        = "#B88646"
_GOLD_HOVER  = "#C89555"


class GuideDialog(QDialog):
    """新手引导"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("新手引导 - 快速上手")
        self.setFixedSize(500, 420)
        self.setStyleSheet(f"QDialog {{ background-color: {_PAGE_BG}; }}")
        self._init_ui()

    def _init_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setSpacing(12)

        title = QLabel("客户线索挖掘工具 - 快速上手")
        title.setStyleSheet(f"font-size: 18px; font-weight: 500; color: {_GOLD};")
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(title)

        steps = [
            ("1. 输入链接",
             "在顶部链接输入区粘贴视频/图文链接，每行一条，支持抖音、小红书、B站、YouTube、Instagram、Facebook"),
            ("2. 配置大模型（可选）",
             "点击「设置」→「大模型配置」，填入API密钥，启用AI语义分析可提升意向识别准确率至90%+"),
            ("3. 开始采集",
             "点击「开始采集」按钮，软件将自动解析链接、采集评论、识别购买意向，进度在右侧面板实时显示"),
            ("4. 预览与管理",
             "采集完成后，在线索预览区查看意向客户，支持按意向度排序、搜索筛选、手动标记纠正"),
            ("5. 导出表格",
             "点击「导出表格」按钮，选择Excel或CSV格式，选择导出字段和保存路径，一键导出客户线索"),
        ]

        for title_text, desc in steps:
            step_title = QLabel(title_text)
            step_title.setStyleSheet(f"font-weight: 500; color: {_TITLE}; font-size: 14px;")
            layout.addWidget(step_title)

            step_desc = QLabel(desc)
            step_desc.setStyleSheet(f"color: {_BODY}; padding-left: 16px; font-size: 12px; font-weight: 300;")
            step_desc.setWordWrap(True)
            layout.addWidget(step_desc)

        layout.addStretch()

        tips = QLabel(
            "提示：\n"
            "- 使用「设置」中的「意向关键词」可自定义识别规则\n"
            "- 采集过程中可随时「暂停」或「停止」\n"
            "- 关闭窗口时程序将最小化到系统托盘，后台继续采集"
        )
        tips.setStyleSheet(f"color: {_BODY}; font-size: 12px; padding: 8px; font-weight: 300; "
                           f"background-color: {_CARD_BG}; border: 1px solid {_CARD_BORDER}; border-radius: 8px;")
        tips.setWordWrap(True)
        layout.addWidget(tips)

        btn_layout = QHBoxLayout()
        btn_layout.addStretch()
        close_btn = QPushButton("开始使用")
        close_btn.setStyleSheet(f"""
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
        close_btn.clicked.connect(self.accept)
        btn_layout.addWidget(close_btn)
        layout.addLayout(btn_layout)
