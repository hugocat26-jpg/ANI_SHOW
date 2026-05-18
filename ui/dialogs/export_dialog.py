"""
导出配置对话框
选择导出格式、字段、筛选条件、保存路径
深色主题
"""
import os

from PyQt6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel,
    QComboBox, QCheckBox, QPushButton, QLineEdit,
    QGroupBox, QFormLayout, QFileDialog, QMessageBox,
)
from PyQt6.QtCore import Qt

from storage.database import Database
from core.data_exporter import DataExporter
from config.settings import get_settings


# 规范色值
_PAGE_BG     = "#0A0D17"
_CARD_BG     = "#151A26"
_CARD_BORDER = "#232836"
_TITLE       = "#F5F0E6"
_BODY        = "#A6ADB8"
_MUTED       = "#86909C"
_GOLD        = "#B88646"
_GOLD_HOVER  = "#C89555"


class ExportDialog(QDialog):
    """导出配置对话框"""

    ALL_FIELDS = [
        ("用户ID", "用户ID"), ("昵称", "昵称"), ("性别", "性别"),
        ("意向评论", "意向评论"), ("评论时间", "评论时间"),
        ("意向等级", "意向等级"), ("匹配关键词", "匹配关键词"),
        ("大模型校验", "大模型校验"), ("大模型分析", "大模型分析"),
        ("平台", "平台"), ("来源链接", "来源链接"),
        ("点赞数", "点赞数"), ("采集时间", "采集时间"), ("备注", "备注"),
    ]

    def __init__(self, database: Database, parent=None):
        super().__init__(parent)
        self.database = database
        self.exporter = DataExporter(database)
        self.settings = get_settings()
        self.setWindowTitle("导出线索表格")
        self.setFixedSize(520, 540)
        self.setStyleSheet(f"QDialog {{ background-color: {_PAGE_BG}; }}")
        self._init_ui()

    def _init_ui(self) -> None:
        layout = QVBoxLayout(self)

        # 数据概览
        total = self.database.count_leads()
        high = self.database.count_leads(intent_level="高")
        medium = self.database.count_leads(intent_level="中")
        low = self.database.count_leads(intent_level="低")
        info_label = QLabel(
            f"当前线索: 总计 {total} 条 | 高意向 {high} | 中意向 {medium} | 低意向 {low}"
        )
        info_label.setStyleSheet(f"font-size: 13px; padding: 10px; background: {_CARD_BG}; "
                                  f"border: 1px solid {_CARD_BORDER}; border-radius: 8px; color: {_BODY}; font-weight: 300;")
        layout.addWidget(info_label)

        # 导出格式
        fmt_group = QGroupBox("导出格式")
        fmt_layout = QHBoxLayout(fmt_group)
        self.format_combo = QComboBox()
        self.format_combo.addItem("Excel (.xlsx)", "xlsx")
        self.format_combo.addItem("CSV (.csv)", "csv")
        fmt_layout.addWidget(QLabel("格式:"))
        fmt_layout.addWidget(self.format_combo)
        fmt_layout.addStretch()
        layout.addWidget(fmt_group)

        # 筛选条件
        filter_group = QGroupBox("筛选条件")
        filter_layout = QFormLayout(filter_group)
        self.intent_combo = QComboBox()
        self.intent_combo.addItems(["全部", "高", "中", "低"])
        filter_layout.addRow("意向等级:", self.intent_combo)

        self.platform_combo = QComboBox()
        self.platform_combo.addItems(["全部", "抖音", "小红书", "B站", "YouTube", "Instagram", "Facebook"])
        filter_layout.addRow("平台:", self.platform_combo)

        self.keyword_input = QLineEdit()
        self.keyword_input.setPlaceholderText("搜索评论关键词")
        filter_layout.addRow("关键词:", self.keyword_input)
        layout.addWidget(filter_group)

        # 导出字段
        field_group = QGroupBox("导出字段")
        field_layout = QVBoxLayout(field_group)
        self.field_checkboxes: list[QCheckBox] = []
        for key, name in self.ALL_FIELDS:
            cb = QCheckBox(name)
            cb.setChecked(True)
            self.field_checkboxes.append(cb)

        half = (len(self.field_checkboxes) + 1) // 2
        for i in range(half):
            row_layout = QHBoxLayout()
            row_layout.addWidget(self.field_checkboxes[i])
            if i + half < len(self.field_checkboxes):
                row_layout.addWidget(self.field_checkboxes[i + half])
            row_layout.addStretch()
            field_layout.addLayout(row_layout)

        btn_row = QHBoxLayout()
        btn_row.setSpacing(8)
        select_all = QPushButton("全选")
        select_all.clicked.connect(lambda: self._toggle_all(True))
        btn_row.addWidget(select_all)
        deselect_all = QPushButton("取消全选")
        deselect_all.clicked.connect(lambda: self._toggle_all(False))
        btn_row.addWidget(deselect_all)
        btn_row.addStretch()
        field_layout.addLayout(btn_row)
        layout.addWidget(field_group)

        # 文件路径
        path_group = QGroupBox("保存位置")
        path_layout = QHBoxLayout(path_group)
        default_name = DataExporter.generate_default_filename("xlsx")
        self.file_path_edit = QLineEdit(os.path.join(os.path.expanduser("~"), "Desktop", default_name))
        path_layout.addWidget(self.file_path_edit)

        browse_btn = QPushButton("浏览...")
        browse_btn.clicked.connect(self._browse_path)
        path_layout.addWidget(browse_btn)
        layout.addWidget(path_group)

        self.format_combo.currentIndexChanged.connect(self._update_default_name)

        # 底部按钮
        btn_layout = QHBoxLayout()
        btn_layout.addStretch()

        self.export_btn = QPushButton("导出")
        self.export_btn.setStyleSheet(f"""
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
        self.export_btn.clicked.connect(self._export)
        btn_layout.addWidget(self.export_btn)

        cancel_btn = QPushButton("取消")
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(cancel_btn)

        layout.addLayout(btn_layout)

    def _toggle_all(self, checked: bool) -> None:
        for cb in self.field_checkboxes:
            cb.setChecked(checked)

    def _update_default_name(self) -> None:
        fmt = self.format_combo.currentData()
        name = DataExporter.generate_default_filename(fmt)
        current = self.file_path_edit.text()
        self.file_path_edit.setText(os.path.join(os.path.dirname(current), name))

    def _browse_path(self) -> None:
        fmt = self.format_combo.currentData()
        filter_str = "Excel 文件 (*.xlsx)" if fmt == "xlsx" else "CSV 文件 (*.csv)"
        file_path, _ = QFileDialog.getSaveFileName(
            self, "选择保存位置",
            self.file_path_edit.text(),
            f"{filter_str};;所有文件 (*)"
        )
        if file_path:
            self.file_path_edit.setText(file_path)

    def _export(self) -> None:
        file_path = self.file_path_edit.text().strip()
        if not file_path:
            QMessageBox.warning(self, "提示", "请选择保存路径")
            return

        selected_fields = []
        for cb in self.field_checkboxes:
            if cb.isChecked():
                selected_fields.append(cb.text())

        intent = self.intent_combo.currentText()
        platform_map = {
            "抖音": "douyin", "小红书": "xiaohongshu", "B站": "bilibili",
            "YouTube": "youtube", "Instagram": "instagram", "Facebook": "facebook",
        }
        platform = platform_map.get(self.platform_combo.currentText(), "")
        keyword = self.keyword_input.text().strip()

        success, message = self.exporter.export(
            file_path=file_path,
            format_type=self.format_combo.currentData(),
            fields=selected_fields,
            intent_level=intent if intent != "全部" else None,
            platform=platform if platform else None,
            keyword=keyword if keyword else None,
        )

        if success:
            QMessageBox.information(self, "导出成功", message)
            self.accept()
        else:
            QMessageBox.warning(self, "导出失败", message)
