"""
搜索输入区组件
支持关键词搜索 + 平台多选 + 内容类型过滤 + 公司搜索切换
深色主题卡片样式
"""
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLineEdit,
    QPushButton, QLabel, QGroupBox, QCheckBox, QComboBox,
)
from PyQt6.QtCore import pyqtSignal, Qt

from config.settings import get_settings


# 规范色值
_CARD_BG     = "#151A26"
_CARD_BORDER = "#232836"
_TITLE       = "#F5F0E6"
_BODY        = "#A6ADB8"
_MUTED       = "#86909C"
_GOLD        = "#B88646"
_GOLD_HOVER  = "#C89555"
_INPUT_BG    = "#151A26"
_INPUT_BORDER = "#232836"

PLATFORM_OPTIONS = [
    ("douyin", "抖音"), ("bilibili", "B站"),
    ("xiaohongshu", "小红书"), ("youtube", "YouTube"),
    ("instagram", "Instagram"), ("facebook", "Facebook"),
    ("web", "网页搜索"),
]

# 内容类型 → 默认平台映射
CONTENT_TYPE_PLATFORMS = {
    "all": ("douyin", "bilibili", "xiaohongshu", "youtube", "instagram", "facebook"),
    "video": ("douyin", "bilibili", "youtube", "instagram", "facebook"),
    "image_text": ("xiaohongshu", "instagram", "facebook"),
}


class SearchInputWidget(QGroupBox):
    """搜索输入区"""

    search_requested = pyqtSignal(str, list, str)   # keyword, platforms, content_type
    search_company = pyqtSignal(str)                 # company name
    add_urls = pyqtSignal(list)                      # 批量添加链接到链接输入区
    platform_login_requested = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__("● 搜索发现", parent)
        self._is_searching = False
        self._init_ui()

    def _init_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setSpacing(8)

        # 搜索模式切换
        mode_layout = QHBoxLayout()
        mode_layout.setSpacing(12)

        self._mode_label = QLabel("搜索模式: 内容发现")
        self._mode_label.setStyleSheet(f"color: {_MUTED}; font-size: 10px; font-weight: 300;")
        mode_layout.addWidget(self._mode_label)

        self._mode_toggle = QPushButton("切换为公司搜索")
        self._mode_toggle.setFixedWidth(120)
        self._mode_toggle.setStyleSheet(f"""
            QPushButton {{
                border: 1px solid {_CARD_BORDER};
                border-radius: 8px;
                padding: 0 12px;
                background-color: transparent;
                color: {_BODY};
                min-height: 28px;
                font-size: 11px;
            }}
            QPushButton:hover {{ border-color: {_GOLD}; color: {_GOLD}; }}
        """)
        self._mode_toggle.clicked.connect(self._toggle_mode)
        mode_layout.addWidget(self._mode_toggle)

        self._login_btn = QPushButton("平台登录")
        self._login_btn.setFixedWidth(88)
        self._login_btn.setStyleSheet(f"""
            QPushButton {{
                border: 1px solid {_CARD_BORDER};
                border-radius: 8px;
                padding: 0 10px;
                background-color: transparent;
                color: {_BODY};
                min-height: 28px;
                font-size: 11px;
            }}
            QPushButton:hover {{ border-color: {_GOLD}; color: {_GOLD}; }}
        """)
        self._login_btn.clicked.connect(lambda: self.platform_login_requested.emit(""))
        mode_layout.addWidget(self._login_btn)
        mode_layout.addStretch()
        layout.addLayout(mode_layout)

        # 搜索输入行
        input_layout = QHBoxLayout()
        input_layout.setSpacing(8)

        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("输入关键词搜索视频/图文内容...")
        self.search_input.setStyleSheet(f"""
            QLineEdit {{
                border: 1px solid {_INPUT_BORDER};
                border-radius: 8px;
                padding: 0 12px;
                background-color: {_INPUT_BG};
                color: {_TITLE};
                font-size: 12px;
                min-height: 36px;
            }}
            QLineEdit:focus {{ border-color: {_GOLD}; }}
        """)
        self.search_input.returnPressed.connect(self._on_search)
        input_layout.addWidget(self.search_input, 1)

        self.search_btn = QPushButton("搜索")
        self.search_btn.setStyleSheet(f"""
            QPushButton {{
                background-color: {_GOLD};
                color: #FFFFFF;
                border: none;
                border-radius: 8px;
                padding: 0 16px;
                min-height: 36px;
                min-width: 72px;
                font-size: 12px;
                font-weight: 500;
            }}
            QPushButton:hover {{ background-color: {_GOLD_HOVER}; }}
            QPushButton:disabled {{ background-color: #5A4A38; color: {_MUTED}; }}
        """)
        self.search_btn.clicked.connect(self._on_search)
        input_layout.addWidget(self.search_btn)

        layout.addLayout(input_layout)

        # 内容类型 + 平台选择行
        filter_row = QHBoxLayout()
        filter_row.setSpacing(12)

        # 内容类型下拉
        type_label = QLabel("内容类型:")
        type_label.setStyleSheet(f"color: {_BODY}; font-size: 11px;")
        filter_row.addWidget(type_label)

        self._content_type = QComboBox()
        self._content_type.addItems(["全部", "视频", "图文"])
        self._content_type.setCurrentIndex(0)
        self._content_type.setStyleSheet(f"""
            QComboBox {{
                border: 1px solid {_CARD_BORDER};
                border-radius: 6px;
                padding: 2px 8px;
                background-color: {_INPUT_BG};
                color: {_TITLE};
                font-size: 11px;
                min-width: 72px;
            }}
            QComboBox:hover {{ border-color: {_GOLD}; }}
            QComboBox::drop-down {{ border: none; width: 20px; }}
            QComboBox QAbstractItemView {{
                background-color: {_CARD_BG};
                color: {_BODY};
                border: 1px solid {_CARD_BORDER};
                selection-background-color: {_GOLD};
            }}
        """)
        self._content_type.currentIndexChanged.connect(self._on_content_type_changed)
        filter_row.addWidget(self._content_type)

        filter_row.addSpacing(8)

        self._platform_chk = QLabel("平台:")
        self._platform_chk.setStyleSheet(f"color: {_BODY}; font-size: 11px;")
        filter_row.addWidget(self._platform_chk)

        self._platform_checkboxes: dict[str, QCheckBox] = {}
        self._platform_status_labels: dict[str, QLabel] = {}
        self._platform_login_buttons: dict[str, QPushButton] = {}
        for key, name in PLATFORM_OPTIONS:
            cb = QCheckBox(name)
            cb.setChecked(key in CONTENT_TYPE_PLATFORMS["all"])
            cb.setStyleSheet(f"""
                QCheckBox {{ color: {_BODY}; font-size: 11px; spacing: 4px; }}
                QCheckBox::indicator {{
                    width: 14px; height: 14px; border: 1px solid {_CARD_BORDER};
                    border-radius: 3px; background-color: {_INPUT_BG};
                }}
                QCheckBox::indicator:checked {{ background-color: {_GOLD}; border-color: {_GOLD}; }}
            """)
            self._platform_checkboxes[key] = cb
            filter_row.addWidget(cb)

        filter_row.addStretch()
        layout.addLayout(filter_row)

        status_grid = QHBoxLayout()
        status_grid.setSpacing(8)
        for key, name in PLATFORM_OPTIONS:
            if key == "web":
                continue
            item = QWidget()
            item_layout = QHBoxLayout(item)
            item_layout.setContentsMargins(0, 0, 0, 0)
            item_layout.setSpacing(4)

            label = QLabel(f"{name}: 检查中")
            label.setStyleSheet(f"color: {_MUTED}; font-size: 10px;")
            self._platform_status_labels[key] = label
            item_layout.addWidget(label)

            login_btn = QPushButton("登录")
            login_btn.setFixedWidth(42)
            login_btn.setStyleSheet(f"""
                QPushButton {{
                    border: 1px solid {_CARD_BORDER};
                    border-radius: 5px;
                    padding: 0 6px;
                    min-height: 20px;
                    background-color: transparent;
                    color: {_GOLD};
                    font-size: 10px;
                }}
                QPushButton:hover {{ border-color: {_GOLD}; background-color: {_CARD_BG}; }}
            """)
            login_btn.clicked.connect(lambda checked=False, p=key: self.platform_login_requested.emit(p))
            login_btn.setVisible(False)
            self._platform_login_buttons[key] = login_btn
            item_layout.addWidget(login_btn)
            status_grid.addWidget(item)

        status_grid.addStretch()
        layout.addLayout(status_grid)

        # 状态提示
        self._status_label = QLabel("")
        self._status_label.setStyleSheet(f"color: {_MUTED}; font-size: 10px; font-weight: 300;")
        layout.addWidget(self._status_label)

    def _on_content_type_changed(self, index: int) -> None:
        """内容类型切换时自动勾选对应平台"""
        type_map = {0: "all", 1: "video", 2: "image_text"}
        ct = type_map.get(index, "all")
        defaults = CONTENT_TYPE_PLATFORMS.get(ct, ())
        for key, cb in self._platform_checkboxes.items():
            cb.setChecked(key in defaults)
        # 切换到图文时更新 placeholder
        if ct == "image_text":
            self.search_input.setPlaceholderText("输入关键词搜索图文内容...")
        elif ct == "video":
            self.search_input.setPlaceholderText("输入关键词搜索视频内容...")
        else:
            self.search_input.setPlaceholderText("输入关键词搜索视频/图文内容...")

    def _get_content_type(self) -> str:
        type_map = {0: "all", 1: "video", 2: "image_text"}
        return type_map.get(self._content_type.currentIndex(), "all")

    def _toggle_mode(self) -> None:
        """切换搜索模式"""
        current = self._mode_label.text()
        if "公司" in current:
            self._mode_label.setText("搜索模式: 内容发现")
            self._mode_toggle.setText("切换为公司搜索")
            self.search_input.setPlaceholderText("输入关键词搜索视频/图文内容...")
            self._content_type.setVisible(True)
            self._platform_chk.setVisible(True)
            for cb in self._platform_checkboxes.values():
                cb.setVisible(True)
            for label in self._platform_status_labels.values():
                label.setVisible(True)
            for key, btn in self._platform_login_buttons.items():
                btn.setVisible("未登录" in self._platform_status_labels[key].text())
        else:
            self._mode_label.setText("搜索模式: 公司信息")
            self._mode_toggle.setText("切换为内容搜索")
            self.search_input.setPlaceholderText("输入公司名称查找官网和联系方式...")
            self._content_type.setVisible(False)
            self._platform_chk.setVisible(False)
            for cb in self._platform_checkboxes.values():
                cb.setVisible(False)
            for label in self._platform_status_labels.values():
                label.setVisible(False)
            for btn in self._platform_login_buttons.values():
                btn.setVisible(False)

    def _on_search(self) -> None:
        """触发搜索"""
        keyword = self.search_input.text().strip()
        if not keyword:
            return

        self._set_searching(True)
        is_company = "公司" in self._mode_label.text()

        if is_company:
            self._status_label.setText(f"搜索公司: '{keyword}'...")
            self.search_company.emit(keyword)
        else:
            platforms = [k for k, cb in self._platform_checkboxes.items() if cb.isChecked()]
            if not platforms:
                platforms = ["douyin", "bilibili", "xiaohongshu", "youtube"]
            ct = self._get_content_type()
            self._status_label.setText(f"搜索: '{keyword}' → {', '.join(platforms)}...")
            self.search_requested.emit(keyword, platforms, ct)

    def set_searching(self, searching: bool) -> None:
        self._set_searching(searching)

    def _set_searching(self, searching: bool) -> None:
        self._is_searching = searching
        self.search_btn.setEnabled(not searching)
        self.search_btn.setText("搜索中..." if searching else "搜索")
        if not searching:
            self._status_label.setText("")

    def set_status(self, text: str) -> None:
        self._status_label.setText(text)

    def set_platform_status(self, platform: str, status: dict) -> None:
        label = self._platform_status_labels.get(platform)
        if not label:
            return
        name = dict(PLATFORM_OPTIONS).get(platform, platform)
        latency = status.get("latency_ms")
        latency_text = f" {latency}ms" if latency is not None else ""
        logged_in = bool(status.get("logged_in"))
        available = bool(status.get("available"))
        message = status.get("message") or ""

        if available:
            label.setText(f"{name}: ● 已登录{latency_text}" if platform in ("douyin", "xiaohongshu", "instagram", "facebook") else f"{name}: ● 可用{latency_text}")
            label.setStyleSheet("color: #3FB950; font-size: 10px;")
        elif platform in ("douyin", "xiaohongshu", "instagram", "facebook") and not logged_in:
            label.setText(f"{name}: ● 未登录{latency_text}")
            label.setStyleSheet("color: #D29922; font-size: 10px;")
        else:
            label.setText(f"{name}: ● 异常{latency_text}" + (f" {message}" if message else ""))
            label.setStyleSheet("color: #F85149; font-size: 10px;")

        btn = self._platform_login_buttons.get(platform)
        if btn:
            btn.setVisible(platform in ("douyin", "xiaohongshu", "instagram", "facebook") and not logged_in)
