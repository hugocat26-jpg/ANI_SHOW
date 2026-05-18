"""
线索预览表格
以表格形式展示提取的客户线索，支持排序、筛选、搜索
深色主题 — 哑光金高亮
"""
from typing import Optional

from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTableWidget,
    QTableWidgetItem, QHeaderView, QPushButton,
    QComboBox, QLineEdit, QLabel, QGroupBox,
    QMessageBox, QMenu,
)
from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtGui import QAction, QColor

from storage.database import Database
from storage.models import IntentLevel


# 规范色值
_GOLD        = "#B88646"
_SUCCESS     = "#5CB85C"
_WARNING     = "#F0AD4E"
_ERROR       = "#D9534F"
_CARD_BG     = "#151A26"
_CARD_BORDER = "#232836"
_TITLE       = "#F5F0E6"
_BODY        = "#A6ADB8"
_MUTED       = "#86909C"
_TABLE_HEAD  = "#1E2330"
_TABLE_ALT   = "#0F1420"
_TABLE_SEL   = "#2A2218"

# 意向等级色（低饱和 + 白字）
_INTENT_HIGH_BG   = "#5A2A28"
_INTENT_HIGH_FG   = "#F5F0E6"
_INTENT_MEDIUM_BG  = "#5A4020"
_INTENT_MEDIUM_FG  = "#F5F0E6"
_INTENT_LOW_BG     = "#2A2F36"
_INTENT_LOW_FG     = "#F5F0E6"


class LeadTableWidget(QGroupBox):
    """线索预览表格"""

    COLUMNS = ["ID", "昵称", "性别", "意向等级", "意向评论", "评论时间",
               "平台", "匹配关键词", "大模型校验", "点赞", "备注"]

    def __init__(self, database: Database, parent=None):
        super().__init__("● 线索预览", parent)
        self.database = database
        self._all_leads: list[dict] = []
        self._init_ui()
        self.refresh_data()

    def _init_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setSpacing(8)

        # 搜索筛选栏
        filter_layout = QHBoxLayout()
        filter_layout.setSpacing(8)

        filter_layout.addWidget(QLabel("意向等级:"))
        self.intent_combo = QComboBox()
        self.intent_combo.addItems(["全部", "高", "中", "低"])
        self.intent_combo.setStyleSheet(f"""
            QComboBox {{
                border: 1px solid {_CARD_BORDER};
                border-radius: 8px;
                padding: 0 12px;
                background-color: {_CARD_BG};
                color: {_BODY};
                font-size: 12px;
                min-height: 32px;
            }}
            QComboBox:focus {{ border-color: {_GOLD}; }}
            QComboBox::drop-down {{ border: none; width: 20px; }}
            QComboBox QAbstractItemView {{
                background-color: {_CARD_BG};
                border: 1px solid {_CARD_BORDER};
                selection-background-color: {_TABLE_SEL};
                color: {_BODY};
                outline: none;
            }}
        """)
        self.intent_combo.currentTextChanged.connect(self._apply_filter)
        filter_layout.addWidget(self.intent_combo)

        filter_layout.addWidget(QLabel("平台:"))
        self.platform_combo = QComboBox()
        self.platform_combo.addItems(["全部", "抖音", "小红书", "B站", "YouTube", "Instagram", "Facebook"])
        self.platform_combo.setStyleSheet(self.intent_combo.styleSheet())
        self.platform_combo.currentTextChanged.connect(self._apply_filter)
        filter_layout.addWidget(self.platform_combo)

        filter_layout.addWidget(QLabel("搜索:"))
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("搜索昵称/评论关键词")
        self.search_input.setMaximumWidth(180)
        self.search_input.setStyleSheet(f"""
            QLineEdit {{
                border: 1px solid {_CARD_BORDER};
                border-radius: 8px;
                padding: 0 12px;
                background-color: {_CARD_BG};
                color: {_TITLE};
                font-size: 12px;
                min-height: 32px;
            }}
            QLineEdit:focus {{ border-color: {_GOLD}; }}
        """)
        self.search_input.textChanged.connect(self._apply_filter)
        filter_layout.addWidget(self.search_input)

        filter_layout.addStretch()

        # 统计文字
        self.stats_label = QLabel("")
        self.stats_label.setStyleSheet(f"color: {_MUTED}; font-size: 10px; font-weight: 300;")
        filter_layout.addWidget(self.stats_label)

        # 删除选中按钮（次按钮样式）
        self.delete_btn = QPushButton("删除选中")
        self.delete_btn.setStyleSheet(f"""
            QPushButton {{
                border: 1px solid {_CARD_BORDER};
                border-radius: 8px;
                padding: 0 12px;
                background-color: transparent;
                color: {_BODY};
                min-height: 32px;
                min-width: 72px;
                font-size: 11px;
            }}
            QPushButton:hover {{ border-color: {_GOLD}; background-color: {_CARD_BG}; }}
        """)
        self.delete_btn.clicked.connect(self._delete_selected)
        filter_layout.addWidget(self.delete_btn)

        layout.addLayout(filter_layout)

        # 表格
        self.table = QTableWidget()
        self.table.setColumnCount(len(self.COLUMNS))
        self.table.setHorizontalHeaderLabels(self.COLUMNS)
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.table.setAlternatingRowColors(True)
        self.table.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.table.customContextMenuRequested.connect(self._show_context_menu)

        # 列宽
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(2, QHeaderView.ResizeMode.Fixed)
        header.resizeSection(2, 50)
        header.setSectionResizeMode(3, QHeaderView.ResizeMode.Fixed)
        header.resizeSection(3, 70)
        header.setSectionResizeMode(4, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(5, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(6, QHeaderView.ResizeMode.Fixed)
        header.resizeSection(6, 70)
        header.setSectionResizeMode(7, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(8, QHeaderView.ResizeMode.Fixed)
        header.resizeSection(8, 70)

        self.table.itemDoubleClicked.connect(self._on_item_double_clicked)
        layout.addWidget(self.table)

    def refresh_data(self) -> None:
        """刷新表格数据"""
        leads = self.database.get_leads(limit=10000)
        self._all_leads = [lead.to_dict() for lead in leads]
        self._apply_filter()

    def add_lead(self, lead_dict: dict) -> None:
        """添加单条线索到表格"""
        self._all_leads.insert(0, lead_dict)
        self._apply_filter()

    def _apply_filter(self) -> None:
        """应用筛选条件"""
        intent_filter = self.intent_combo.currentText()
        platform_filter = self.platform_combo.currentText()
        search_text = self.search_input.text().strip().lower()

        platform_map = {
            "抖音": "douyin", "小红书": "xiaohongshu", "B站": "bilibili",
            "YouTube": "youtube", "Instagram": "instagram", "Facebook": "facebook",
        }

        filtered = []
        for lead in self._all_leads:
            if intent_filter != "全部":
                intent_val = lead.get("intent_level", "")
                if isinstance(intent_val, IntentLevel):
                    intent_val = intent_val.value
                if intent_val != intent_filter:
                    continue
            if platform_filter != "全部":
                if lead.get("platform") != platform_map.get(platform_filter, ""):
                    continue
            if search_text:
                nickname = str(lead.get("nickname", "")).lower()
                comment = str(lead.get("comment_text", "")).lower()
                keywords = str(lead.get("intent_keywords", "")).lower()
                if not (search_text in nickname or search_text in comment or search_text in keywords):
                    continue
            filtered.append(lead)

        self._populate_table(filtered)

        high_count = sum(1 for l in filtered if _get_intent(l) == "高")
        medium_count = sum(1 for l in filtered if _get_intent(l) == "中")
        low_count = sum(1 for l in filtered if _get_intent(l) == "低")
        self.stats_label.setText(
            f"共 {len(filtered)} 条线索 | 高意向: {high_count} | 中意向: {medium_count} | 低意向: {low_count}"
        )

    def _populate_table(self, leads: list) -> None:
        """填充表格数据"""
        self.table.setRowCount(len(leads))

        for row, lead in enumerate(leads):
            intent_level = _get_intent(lead)
            items = [
                str(lead.get("id", "")),
                str(lead.get("nickname", "")),
                str(lead.get("gender", "未知")),
                intent_level,
                str(lead.get("comment_text", "")),
                str(lead.get("comment_time", "")),
                str(lead.get("platform_name", "")),
                str(lead.get("intent_keywords", "")),
                "是" if lead.get("llm_verified") else "否",
                str(lead.get("likes", "0")),
                str(lead.get("notes", "")),
            ]

            for col, text in enumerate(items):
                item = QTableWidgetItem(text)
                item.setData(Qt.ItemDataRole.UserRole, lead.get("id"))
                # 意向等级颜色（低饱和背景 + 白字）
                if col == 3:
                    if intent_level == "高":
                        item.setBackground(QColor(_INTENT_HIGH_BG))
                        item.setForeground(QColor(_INTENT_HIGH_FG))
                    elif intent_level == "中":
                        item.setBackground(QColor(_INTENT_MEDIUM_BG))
                        item.setForeground(QColor(_INTENT_MEDIUM_FG))
                    elif intent_level == "低":
                        item.setBackground(QColor(_INTENT_LOW_BG))
                        item.setForeground(QColor(_INTENT_LOW_FG))
                self.table.setItem(row, col, item)

    def _show_context_menu(self, pos) -> None:
        """右键菜单"""
        row = self.table.currentRow()
        if row < 0:
            return

        menu = QMenu(self)
        mark_high = QAction("标记为高意向", self)
        mark_medium = QAction("标记为中意向", self)
        mark_low = QAction("标记为低意向", self)
        add_note = QAction("添加备注", self)

        mark_high.triggered.connect(lambda: self._mark_intent("高"))
        mark_medium.triggered.connect(lambda: self._mark_intent("中"))
        mark_low.triggered.connect(lambda: self._mark_intent("低"))
        add_note.triggered.connect(self._add_note)

        menu.addAction(mark_high)
        menu.addAction(mark_medium)
        menu.addAction(mark_low)
        menu.addSeparator()
        menu.addAction(add_note)

        menu.exec(self.table.viewport().mapToGlobal(pos))

    def _mark_intent(self, level: str) -> None:
        """手动标记意向等级"""
        row = self.table.currentRow()
        if row >= 0:
            item = self.table.item(row, 0)
            lead_id = int(item.data(Qt.ItemDataRole.UserRole))
            self.database.update_lead(lead_id, intent_level=level, manually_marked=True)
            self.refresh_data()

    def _add_note(self) -> None:
        """添加备注"""
        row = self.table.currentRow()
        if row >= 0:
            item = self.table.item(row, 0)
            lead_id = int(item.data(Qt.ItemDataRole.UserRole))
            current_note = self.table.item(row, 10).text() if self.table.item(row, 10) else ""
            from PyQt6.QtWidgets import QInputDialog
            note, ok = QInputDialog.getText(
                self, "添加备注", "请输入备注内容:",
                text=current_note
            )
            if ok:
                self.database.update_lead(lead_id, notes=note)
                self.refresh_data()

    def _delete_selected(self) -> None:
        """删除选中的线索"""
        selected_rows = set()
        for item in self.table.selectedItems():
            selected_rows.add(item.row())

        if not selected_rows:
            QMessageBox.information(self, "提示", "请先选择要删除的线索")
            return

        reply = QMessageBox.question(
            self, "确认删除",
            f"确定要删除选中的 {len(selected_rows)} 条线索吗？\n此操作不可恢复。"
        )
        if reply == QMessageBox.StandardButton.Yes:
            for row in sorted(selected_rows, reverse=True):
                item = self.table.item(row, 0)
                if item:
                    lead_id = int(item.data(Qt.ItemDataRole.UserRole))
                    self.database.delete_lead(lead_id)
            self.refresh_data()

    def _on_item_double_clicked(self, item) -> None:
        """双击查看详情"""
        row = item.row()
        comment = self.table.item(row, 4).text() if self.table.item(row, 4) else ""
        QMessageBox.information(self, "评论详情", comment)


def _get_intent(lead: dict) -> str:
    val = lead.get("intent_level", "")
    if isinstance(val, IntentLevel):
        return val.value
    return str(val)
