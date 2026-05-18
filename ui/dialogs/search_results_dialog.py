"""
搜索结果展示对话框
表格展示各平台搜索结果，支持勾选并加入采集队列
深色主题
"""
from PyQt6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QTableWidget,
    QTableWidgetItem, QHeaderView, QPushButton,
    QLabel, QCheckBox, QMessageBox, QWidget,
)
from PyQt6.QtCore import Qt

from storage.models import SearchResult


# 规范色值
_PAGE_BG     = "#0A0D17"
_CARD_BG     = "#151A26"
_CARD_BORDER = "#232836"
_TITLE       = "#F5F0E6"
_BODY        = "#A6ADB8"
_MUTED       = "#86909C"
_GOLD        = "#B88646"
_GOLD_HOVER  = "#C89555"
_TABLE_HEAD  = "#1E2330"
_TABLE_ALT   = "#0F1420"
_SUCCESS     = "#5CB85C"


class SearchResultsDialog(QDialog):
    """搜索结果对话框"""

    def __init__(self, keyword: str, results: list[SearchResult], parent=None):
        super().__init__(parent)
        self.keyword = keyword
        self.results = results
        self.setWindowTitle(f"搜索结果 - '{keyword}'")
        self.setMinimumSize(750, 500)
        self.resize(800, 560)
        self.setStyleSheet(f"QDialog {{ background-color: {_PAGE_BG}; }}")
        self._init_ui()

    def _init_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        # 标题行
        title_row = QHBoxLayout()
        title = QLabel(f"关键词「{self.keyword}」的搜索结果")
        title.setStyleSheet(f"font-size: 16px; font-weight: 500; color: {_TITLE};")
        title_row.addWidget(title)
        title_row.addStretch()

        # 统计
        platform_counts: dict[str, int] = {}
        for r in self.results:
            pn = r.platform_name or "网页"
            platform_counts[pn] = platform_counts.get(pn, 0) + 1
        stats = " | ".join(f"{name}: {cnt}" for name, cnt in platform_counts.items())
        stats_label = QLabel(stats or "无结果")
        stats_label.setStyleSheet(f"color: {_MUTED}; font-size: 10px;")
        title_row.addWidget(stats_label)
        layout.addLayout(title_row)

        # 全选
        select_row = QHBoxLayout()
        self._select_all = QCheckBox("全选")
        self._select_all.setChecked(True)
        self._select_all.setStyleSheet(f"color: {_BODY}; font-size: 12px;")
        self._select_all.toggled.connect(self._toggle_all)
        select_row.addWidget(self._select_all)
        select_row.addStretch()
        self._selected_label = QLabel(f"已选中 {len(self.results)}/{len(self.results)}")
        self._selected_label.setStyleSheet(f"color: {_MUTED}; font-size: 10px;")
        select_row.addWidget(self._selected_label)
        layout.addLayout(select_row)

        # 结果表格
        self.table = QTableWidget()
        self.table.setColumnCount(4)
        self.table.setHorizontalHeaderLabels(["", "平台", "标题", "摘要"])
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.table.setAlternatingRowColors(True)
        self.table.setStyleSheet(f"""
            QTableWidget {{
                border: 1px solid {_CARD_BORDER};
                border-radius: 8px;
                background-color: {_PAGE_BG};
                gridline-color: {_CARD_BORDER};
                font-size: 11px;
                color: {_BODY};
                alternate-background-color: {_TABLE_ALT};
            }}
            QTableWidget::item {{ padding: 0 8px; height: 34px; }}
            QHeaderView::section {{
                background-color: {_TABLE_HEAD};
                border: none;
                border-bottom: 1px solid {_CARD_BORDER};
                padding: 0 8px;
                height: 36px;
                font-weight: 500;
                font-size: 11px;
                color: {_TITLE};
            }}
        """)

        self.table.setRowCount(len(self.results))
        for row, result in enumerate(self.results):
            # 勾选框
            cb = QCheckBox("")
            cb.setChecked(True)
            cb.stateChanged.connect(self._update_count)
            cb.setStyleSheet("QCheckBox { margin-left: 4px; }")
            cb_widget = _CheckboxWidget(cb)
            self.table.setCellWidget(row, 0, cb_widget)

            # 平台
            platform_item = QTableWidgetItem(result.platform_name or "网页")
            platform_item.setData(Qt.ItemDataRole.UserRole, result.url)
            self.table.setItem(row, 1, platform_item)

            # 标题
            self.table.setItem(row, 2, QTableWidgetItem(result.title[:80]))

            # 摘要
            self.table.setItem(row, 3, QTableWidgetItem(result.snippet[:100]))

        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Fixed)
        header.resizeSection(0, 30)
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.Fixed)
        header.resizeSection(1, 80)
        header.setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)

        layout.addWidget(self.table, 1)

        # 底部按钮
        btn_layout = QHBoxLayout()
        btn_layout.addStretch()

        add_btn = QPushButton("加入采集队列")
        add_btn.setStyleSheet(f"""
            QPushButton {{
                background-color: {_GOLD};
                color: #FFFFFF;
                border: none;
                border-radius: 8px;
                padding: 0 16px;
                min-height: 36px;
                min-width: 120px;
                font-size: 12px;
                font-weight: 500;
            }}
            QPushButton:hover {{ background-color: {_GOLD_HOVER}; }}
        """)
        add_btn.clicked.connect(self._add_to_collection)
        btn_layout.addWidget(add_btn)

        cancel_btn = QPushButton("取消")
        cancel_btn.setStyleSheet(f"""
            QPushButton {{
                border: 1px solid {_CARD_BORDER};
                border-radius: 8px;
                padding: 0 16px;
                background-color: transparent;
                color: {_BODY};
                min-height: 36px;
                min-width: 80px;
                font-size: 12px;
            }}
            QPushButton:hover {{ border-color: {_GOLD}; }}
        """)
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(cancel_btn)

        layout.addLayout(btn_layout)

    def _get_selected_urls(self) -> list[str]:
        """获取勾选的URL列表"""
        urls = []
        for row in range(self.table.rowCount()):
            widget = self.table.cellWidget(row, 0)
            cb = widget.findChild(QCheckBox) if widget else None
            if cb and cb.isChecked():
                item = self.table.item(row, 1)
                if item:
                    urls.append(item.data(Qt.ItemDataRole.UserRole))
        return urls

    def _toggle_all(self, checked: bool) -> None:
        for row in range(self.table.rowCount()):
            widget = self.table.cellWidget(row, 0)
            cb = widget.findChild(QCheckBox) if widget else None
            if cb:
                cb.setChecked(checked)
        self._update_count()

    def _update_count(self) -> None:
        selected = len(self._get_selected_urls())
        self._selected_label.setText(f"已选中 {selected}/{len(self.results)}")

    def _add_to_collection(self) -> None:
        urls = self._get_selected_urls()
        if not urls:
            QMessageBox.information(self, "提示", "请至少选择一条结果")
            return

        # 通过父窗口的 add_urls 信号传递（由 main_window 连接）
        parent = self.parent()
        # 使用 attribute 查找搜索组件
        if parent:
            search_widget = getattr(parent, "search_input", None)
            if search_widget:
                search_widget.add_urls.emit(urls)

        QMessageBox.information(
            self, "添加成功",
            f"已添加 {len(urls)} 条链接到输入区，可点击「开始采集」进行评论采集。"
        )
        self.accept()


class _CheckboxWidget(QWidget):
    """包装复选框的 widget"""
    def __init__(self, checkbox: QCheckBox, parent=None):
        super().__init__(parent)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(checkbox)
