"""
主窗口 — 应用核心UI
深色哑光金主题 | 卡片式分区布局
"""
import os
from typing import Optional

from PyQt6.QtWidgets import (
    QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QSplitter, QMessageBox, QSystemTrayIcon, QMenu,
    QApplication, QFrame, QGraphicsDropShadowEffect,
    QTabWidget, QScrollArea, QTextEdit, QTableWidget,
    QTableWidgetItem, QHeaderView, QCheckBox, QLabel, QPushButton,
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal, QTimer
from PyQt6.QtGui import QIcon, QAction, QCloseEvent, QColor

from .styles import GLOBAL_STYLE
from .widgets.link_input import LinkInputWidget
from .widgets.search_input import SearchInputWidget
from .widgets.operation_bar import OperationBar
from .widgets.log_panel import LogPanel
from .widgets.lead_table import LeadTableWidget
from .widgets.status_bar import StatusBarWidget
from .widgets.progress_widget import ProgressPanel
from .dialogs.settings_dialog import SettingsDialog
from .dialogs.guide_dialog import GuideDialog
from .dialogs.compliance_dialog import ComplianceDialog
from .dialogs.export_dialog import ExportDialog
from .dialogs.search_results_dialog import SearchResultsDialog

from config.settings import get_settings, AppSettings
from core.link_parser import LinkParser
from core.task_manager import TaskManager, TaskWorker
from core.scraper.base import ScraperFactory
from core.intent_recognizer import IntentRecognizer
from core.info_extractor import InfoExtractor
from core.data_exporter import DataExporter
from llm.base import BaseLLM
from llm.tongyi import TongyiLLM
from llm.wenxin import WenxinLLM
from llm.openai_llm import OpenAILLM
from llm.deepseek import DeepseekLLM
from llm.kimi import KimiLLM
from storage.database import Database
from storage.models import CollectTask
from utils.logger import Logger


# 卡片阴影
def _make_shadow(blur: int = 24, offset: int = 4, alpha: int = 80) -> QGraphicsDropShadowEffect:
    shadow = QGraphicsDropShadowEffect()
    shadow.setBlurRadius(blur)
    shadow.setOffset(0, offset)
    shadow.setColor(QColor(0, 0, 0, alpha))
    return shadow


class MainWindow(QMainWindow):
    """主窗口"""

    def __init__(self):
        super().__init__()
        self.settings = get_settings()
        self.settings.load()
        self.logger = Logger()
        self.database = Database()
        self.link_parser = LinkParser()

        # LLM 初始化
        self.llm: Optional[BaseLLM] = None
        self._init_llm()

        self.extractor = InfoExtractor(self.database)
        self.recognizer = IntentRecognizer(self.llm)
        self.exporter = DataExporter(self.database)

        # 任务管理器（单浏览器串行 + 启动间隔，防止多 Edge 实例资源耗尽闪退）
        self.task_manager = TaskManager(
            ScraperFactory, self.recognizer, self.extractor, self.database,
            max_concurrent=1,
        )
        # 排队任务启动回调
        self.task_manager.set_pending_callback(self._on_pending_task_started)

        # 初始化UI
        self._search_results: list = []
        self._init_ui()
        self._init_tray()
        self._connect_signals()
        self._check_first_run()

    def _init_ui(self) -> None:
        """初始化界面 — Tab 切换 + 可拖拽调整卡片大小"""
        self.setWindowTitle("客户线索挖掘工具")
        self.setMinimumSize(1100, 750)
        self.resize(1280, 860)
        self.setStyleSheet(GLOBAL_STYLE)

        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        main_layout = QVBoxLayout(central_widget)
        main_layout.setContentsMargins(16, 12, 16, 12)
        main_layout.setSpacing(8)

        # === Tab 栏 ===
        self._tabs = QTabWidget()
        self._tabs.setStyleSheet(f"""
            QTabWidget::pane {{
                border: 1px solid #232836;
                border-radius: 10px;
                background-color: #0A0D17;
            }}
            QTabBar::tab {{
                background: #151A26;
                color: #A6ADB8;
                border: 1px solid #232836;
                border-bottom: none;
                border-top-left-radius: 8px;
                border-top-right-radius: 8px;
                padding: 8px 28px;
                margin-right: 2px;
                font-size: 13px;
                font-weight: 500;
            }}
            QTabBar::tab:selected {{
                background: #0A0D17;
                color: #B88646;
                border-bottom: 2px solid #B88646;
            }}
            QTabBar::tab:hover:!selected {{
                color: #F5F0E6;
                background: #1E2330;
            }}
        """)

        # ---- Tab 0: 搜索发现 ----
        search_tab = QWidget()
        search_splitter = QSplitter(Qt.Orientation.Vertical)
        search_splitter.setHandleWidth(3)
        search_splitter.setStyleSheet(f"""
            QSplitter::handle {{ background: #232836; }}
            QSplitter::handle:hover {{ background: #B88646; }}
        """)

        self.search_input = SearchInputWidget()
        self.search_input.setGraphicsEffect(_make_shadow())
        search_splitter.addWidget(self.search_input)

        # 搜索日志 + 结果区
        search_bottom = QSplitter(Qt.Orientation.Vertical)
        search_bottom.setHandleWidth(3)
        search_bottom.setStyleSheet(f"""
            QSplitter::handle {{ background: #232836; }}
            QSplitter::handle:hover {{ background: #B88646; }}
        """)

        # 搜索日志（迷你）
        self.search_log = QTextEdit()
        self.search_log.setReadOnly(True)
        self.search_log.setMaximumHeight(120)
        self.search_log.setStyleSheet(f"""
            QTextEdit {{
                border: 1px solid #232836;
                border-radius: 6px;
                padding: 6px 10px;
                background-color: #0A0D17;
                color: #86909C;
                font-size: 10px;
            }}
        """)
        search_bottom.addWidget(self.search_log)

        # 搜索结果区（内嵌表格 + 按钮）
        results_widget = QWidget()
        results_layout = QVBoxLayout(results_widget)
        results_layout.setContentsMargins(0, 0, 0, 0)
        results_layout.setSpacing(6)

        # 统计 + 全选行
        results_header = QHBoxLayout()
        self._search_stats_label = QLabel("")
        self._search_stats_label.setStyleSheet(f"color: #86909C; font-size: 10px;")
        results_header.addWidget(self._search_stats_label)
        results_header.addStretch()

        self._search_select_all = QCheckBox("全选")
        self._search_select_all.setChecked(True)
        self._search_select_all.setStyleSheet(f"color: #A6ADB8; font-size: 11px;")
        self._search_select_all.toggled.connect(self._toggle_search_results)
        results_header.addWidget(self._search_select_all)

        self._search_selected_label = QLabel("已选中 0/0")
        self._search_selected_label.setStyleSheet(f"color: #86909C; font-size: 10px;")
        results_header.addWidget(self._search_selected_label)
        results_layout.addLayout(results_header)

        # 结果表格
        self._search_results_table = QTableWidget()
        self._search_results_table.setColumnCount(4)
        self._search_results_table.setHorizontalHeaderLabels(["", "平台", "标题", "摘要"])
        self._search_results_table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self._search_results_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self._search_results_table.setAlternatingRowColors(True)
        self._search_results_table.setStyleSheet(f"""
            QTableWidget {{
                border: 1px solid #232836;
                border-radius: 6px;
                background-color: #0A0D17;
                gridline-color: #232836;
                font-size: 11px;
                color: #A6ADB8;
                alternate-background-color: #0F1420;
            }}
            QTableWidget::item {{ padding: 0 8px; height: 30px; }}
            QHeaderView::section {{
                background-color: #1E2330;
                border: none;
                border-bottom: 1px solid #232836;
                padding: 0 8px;
                height: 30px;
                font-weight: 500;
                font-size: 10px;
                color: #F5F0E6;
            }}
        """)
        header_view = self._search_results_table.horizontalHeader()
        header_view.setSectionResizeMode(0, QHeaderView.ResizeMode.Fixed)
        header_view.resizeSection(0, 28)
        header_view.setSectionResizeMode(1, QHeaderView.ResizeMode.Fixed)
        header_view.resizeSection(1, 72)
        header_view.setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        header_view.setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)
        results_layout.addWidget(self._search_results_table, 1)

        # 加入采集按钮
        add_btn_layout = QHBoxLayout()
        add_btn_layout.addStretch()
        self._add_search_results_btn = QPushButton("加入采集队列")
        self._add_search_results_btn.setStyleSheet(f"""
            QPushButton {{
                background-color: #B88646;
                color: #FFFFFF;
                border: none;
                border-radius: 6px;
                padding: 0 14px;
                min-height: 30px;
                font-size: 11px;
                font-weight: 500;
            }}
            QPushButton:hover {{ background-color: #C89555; }}
            QPushButton:disabled {{ background-color: #5A4A38; color: #86909C; }}
        """)
        self._add_search_results_btn.clicked.connect(self._add_search_results_to_collection)
        self._add_search_results_btn.setEnabled(False)
        add_btn_layout.addWidget(self._add_search_results_btn)
        results_layout.addLayout(add_btn_layout)

        search_bottom.addWidget(results_widget)
        search_bottom.setSizes([80, 300])

        search_splitter.addWidget(search_bottom)
        search_splitter.setSizes([180, 350])

        search_tab_layout = QVBoxLayout(search_tab)
        search_tab_layout.setContentsMargins(8, 8, 8, 8)
        search_tab_layout.addWidget(search_splitter)

        self._tabs.addTab(search_tab, "🔍  搜索发现")

        # ---- Tab 1: 链接采集 ----
        collect_tab = QWidget()
        collect_splitter = QSplitter(Qt.Orientation.Vertical)
        collect_splitter.setHandleWidth(3)
        collect_splitter.setStyleSheet(f"""
            QSplitter::handle {{ background: #232836; }}
            QSplitter::handle:hover {{ background: #B88646; }}
        """)

        # 链接输入卡片
        self.link_input = LinkInputWidget()
        self.link_input.setGraphicsEffect(_make_shadow())
        collect_splitter.addWidget(self.link_input)

        # 操作栏 + 进度面板
        action_card = QFrame()
        action_card.setObjectName("card")
        action_card.setGraphicsEffect(_make_shadow())
        action_card_layout = QHBoxLayout(action_card)
        action_card_layout.setContentsMargins(16, 10, 16, 10)
        action_card_layout.setSpacing(12)

        self.operation_bar = OperationBar()
        action_card_layout.addWidget(self.operation_bar)
        action_card_layout.addStretch()
        self.progress_panel = ProgressPanel()
        action_card_layout.addWidget(self.progress_panel)
        collect_splitter.addWidget(action_card)

        # 内容区：日志 + 线索预览
        content_splitter = QSplitter(Qt.Orientation.Horizontal)
        content_splitter.setHandleWidth(3)
        content_splitter.setStyleSheet(f"""
            QSplitter::handle {{ background: #232836; }}
            QSplitter::handle:hover {{ background: #B88646; }}
        """)

        left_panel = QWidget()
        left_layout = QVBoxLayout(left_panel)
        left_layout.setContentsMargins(0, 0, 0, 0)
        self.log_panel = LogPanel()
        left_layout.addWidget(self.log_panel)
        content_splitter.addWidget(left_panel)

        right_panel = QWidget()
        right_layout = QVBoxLayout(right_panel)
        right_layout.setContentsMargins(0, 0, 0, 0)
        self.lead_table = LeadTableWidget(self.database)
        right_layout.addWidget(self.lead_table)
        content_splitter.addWidget(right_panel)
        content_splitter.setSizes([300, 700])

        collect_splitter.addWidget(content_splitter)
        collect_splitter.setSizes([180, 80, 400])

        collect_tab_layout = QVBoxLayout(collect_tab)
        collect_tab_layout.setContentsMargins(8, 8, 8, 8)
        collect_tab_layout.addWidget(collect_splitter)

        self._tabs.addTab(collect_tab, "📋  链接采集")

        main_layout.addWidget(self._tabs, 1)

        # === 底部状态栏 ===
        self.status_bar = StatusBarWidget()
        main_layout.addWidget(self.status_bar)

    def _init_tray(self) -> None:
        """初始化系统托盘（最小化到托盘）"""
        self.tray_icon = QSystemTrayIcon(self)
        self.tray_icon.setToolTip("客户线索挖掘工具")

        tray_menu = QMenu()
        show_action = QAction("显示主窗口", self)
        show_action.triggered.connect(self._show_from_tray)
        tray_menu.addAction(show_action)

        quit_action = QAction("退出", self)
        quit_action.triggered.connect(self._quit_app)
        tray_menu.addAction(quit_action)

        self.tray_icon.setContextMenu(tray_menu)
        self.tray_icon.activated.connect(self._on_tray_activated)

    def _init_llm(self) -> None:
        """初始化LLM实例"""
        llm_config = self.settings.config.llm
        try:
            from utils.crypto import CryptoUtil
            provider = llm_config.provider
            if provider == "tongyi":
                api_key = CryptoUtil.decrypt(llm_config.tongyi_api_key) if llm_config.tongyi_api_key else ""
                if api_key:
                    self.llm = TongyiLLM(api_key=api_key, model=llm_config.tongyi_model,
                                         temperature=llm_config.temperature, max_tokens=llm_config.max_tokens)
            elif provider == "wenxin":
                api_key = CryptoUtil.decrypt(llm_config.wenxin_api_key) if llm_config.wenxin_api_key else ""
                secret_key = CryptoUtil.decrypt(llm_config.wenxin_secret_key) if llm_config.wenxin_secret_key else ""
                if api_key:
                    self.llm = WenxinLLM(api_key=api_key, secret_key=secret_key, model=llm_config.wenxin_model,
                                         temperature=llm_config.temperature, max_tokens=llm_config.max_tokens)
            elif provider == "openai":
                api_key = CryptoUtil.decrypt(llm_config.openai_api_key) if llm_config.openai_api_key else ""
                if api_key:
                    self.llm = OpenAILLM(api_key=api_key, model=llm_config.openai_model,
                                         temperature=llm_config.temperature, max_tokens=llm_config.max_tokens)
            elif provider == "deepseek":
                api_key = CryptoUtil.decrypt(llm_config.deepseek_api_key) if llm_config.deepseek_api_key else ""
                if api_key:
                    self.llm = DeepseekLLM(api_key=api_key, model=llm_config.deepseek_model,
                                           temperature=llm_config.temperature, max_tokens=llm_config.max_tokens)
            elif provider == "kimi":
                api_key = CryptoUtil.decrypt(llm_config.kimi_api_key) if llm_config.kimi_api_key else ""
                if api_key:
                    self.llm = KimiLLM(api_key=api_key, model=llm_config.kimi_model,
                                       temperature=llm_config.temperature, max_tokens=llm_config.max_tokens)
        except Exception as e:
            self.logger.warning(f"LLM初始化失败: {str(e)}，将仅使用关键词识别")

    def _connect_signals(self) -> None:
        """连接信号槽"""
        self.operation_bar.start_clicked.connect(self._on_start)
        self.operation_bar.pause_clicked.connect(self._on_pause)
        self.operation_bar.stop_clicked.connect(self._on_stop)
        self.operation_bar.export_clicked.connect(self._on_export)
        self.operation_bar.settings_clicked.connect(self._on_settings)

        # 搜索信号
        self.search_input.search_requested.connect(self._on_search_content)
        self.search_input.search_company.connect(self._on_search_company)
        self.search_input.add_urls.connect(self.link_input.append_urls)
        # 搜索结果加入后自动切到采集 Tab
        self.search_input.add_urls.connect(lambda urls: self._tabs.setCurrentIndex(1))

        self.logger.set_ui_callback(self.log_panel.add_log)
        self.lead_table.refresh_data()

    def _check_first_run(self) -> None:
        """首次运行检测"""
        if self.settings.config.first_run:
            QTimer.singleShot(500, self._show_compliance)
        else:
            QTimer.singleShot(500, self._show_guide)

    def _show_compliance(self) -> None:
        dialog = ComplianceDialog(self)
        if dialog.exec() == ComplianceDialog.DialogCode.Accepted:
            self.settings.config.first_run = False
            self.settings.save()
            QTimer.singleShot(300, self._show_guide)

    def _show_guide(self) -> None:
        GuideDialog(self).exec()

    # ===== 搜索处理 =====

    def _on_search_content(self, keyword: str, platforms: list, content_type: str = "all") -> None:
        """处理内容搜索请求 — 平台选择以用户手动勾选为准，content_type 仅作参考"""
        from core.searcher import SearchWorker

        if not platforms:
            QMessageBox.warning(self, "提示", "请至少选择一个平台")
            self.search_input.set_searching(False)
            return

        # 清空上次搜索结果
        self._search_results = []
        self._search_results_table.setRowCount(0)
        self._search_stats_label.setText("")
        self._search_selected_label.setText("已选中 0/0")
        self._add_search_results_btn.setEnabled(False)
        self.search_log.clear()

        self._search_worker = SearchWorker(
            keyword=keyword, platforms=platforms,
            llm=self.llm, settings=self.settings,
        )
        self._search_worker.log.connect(self._on_search_log)
        self._search_worker.progress.connect(self._on_search_progress)
        self._search_worker.search_finished.connect(self._on_search_content_finished)
        self._search_worker.search_error.connect(self._on_search_error)
        self._search_worker.finished.connect(lambda: self.search_input.set_searching(False))
        self._search_worker.start()

    def _on_search_company(self, company_name: str) -> None:
        """处理公司搜索请求"""
        from core.company_extractor import CompanySearchWorker

        self._search_worker = CompanySearchWorker(
            company_name=company_name, llm=self.llm,
        )
        self._search_worker.log.connect(self._on_search_log)
        self._search_worker.search_finished.connect(self._on_search_company_finished)
        self._search_worker.search_error.connect(self._on_search_error)
        self._search_worker.finished.connect(lambda: self.search_input.set_searching(False))
        self._search_worker.start()

    def _on_search_log(self, level: str, message: str) -> None:
        # 写入搜索日志区
        prefix = {"SUCCESS": "✓", "ERROR": "✗", "WARNING": "!", "INFO": "·"}.get(level, "·")
        self.search_log.append(f"{prefix} {message}")

        if level == "SUCCESS":
            self.logger.success(message)
        elif level == "ERROR":
            self.logger.error(message)
        elif level == "WARNING":
            self.logger.warning(message)
        else:
            self.logger.info(message)

    def _on_search_progress(self, phase: str, current: int, total: int) -> None:
        self.search_input.set_status(f"{phase} ({current}/{total})")

    def _on_search_content_finished(self, keyword: str, results: list) -> None:
        """内容搜索完成 — 内嵌展示结果"""
        self.search_input.set_searching(False)
        self._search_results = results

        if not results:
            self._search_stats_label.setText(f"关键词「{keyword}」无搜索结果")
            return

        # 统计
        platform_counts: dict[str, int] = {}
        for r in results:
            pn = r.platform_name or "网页"
            platform_counts[pn] = platform_counts.get(pn, 0) + 1
        stats = " | ".join(f"{name}: {cnt}" for name, cnt in platform_counts.items())
        self._search_stats_label.setText(f"「{keyword}」共 {len(results)} 条 → {stats}")

        # 填充表格
        self._search_results_table.setRowCount(len(results))
        for row, result in enumerate(results):
            cb = QCheckBox("")
            cb.setChecked(True)
            cb.stateChanged.connect(self._update_search_selection_count)
            cb_widget = QWidget()
            cb_layout = QHBoxLayout(cb_widget)
            cb_layout.setContentsMargins(0, 0, 0, 0)
            cb_layout.setAlignment(Qt.AlignmentFlag.AlignCenter)
            cb_layout.addWidget(cb)
            self._search_results_table.setCellWidget(row, 0, cb_widget)

            platform_item = QTableWidgetItem(result.platform_name or "网页")
            platform_item.setData(Qt.ItemDataRole.UserRole, result.url)
            self._search_results_table.setItem(row, 1, platform_item)

            self._search_results_table.setItem(row, 2, QTableWidgetItem((result.title or "")[:80]))
            self._search_results_table.setItem(row, 3, QTableWidgetItem((result.snippet or "")[:100]))

        self._search_selected_label.setText(f"已选中 {len(results)}/{len(results)}")
        self._add_search_results_btn.setEnabled(True)

    def _on_search_company_finished(self, keyword: str, infos: list) -> None:
        """公司搜索完成"""
        self.search_input.set_searching(False)
        if infos:
            from storage.models import CompanyInfo
            info = infos[0]
            self.database.insert_company(info)
            msg = (f"公司: {info.name}\n"
                   f"官网: {info.website}\n"
                   f"邮箱: {info.email or '未找到'}\n"
                   f"电话: {info.phone or '未找到'}\n"
                   f"地址: {info.address or '未找到'}\n\n"
                   f"描述: {info.description or '无'}")
            QMessageBox.information(self, "公司信息", msg)
            self.logger.success(f"公司信息已保存: {info.name}")
        else:
            QMessageBox.information(self, "搜索结果", f"未找到 '{keyword}' 的公司信息。")

    def _on_search_error(self, error: str) -> None:
        self.search_input.set_searching(False)
        self.search_log.append(f"✗ 搜索失败: {error}")
        QMessageBox.warning(self, "搜索错误", f"搜索失败:\n{error}")

    def _toggle_search_results(self, checked: bool) -> None:
        """全选/取消全选搜索结果"""
        for row in range(self._search_results_table.rowCount()):
            widget = self._search_results_table.cellWidget(row, 0)
            if widget:
                cb = widget.findChild(QCheckBox)
                if cb:
                    cb.setChecked(checked)
        self._update_search_selection_count()

    def _update_search_selection_count(self) -> None:
        """更新搜索结果选中计数"""
        count = 0
        total = self._search_results_table.rowCount()
        for row in range(total):
            widget = self._search_results_table.cellWidget(row, 0)
            if widget:
                cb = widget.findChild(QCheckBox)
                if cb and cb.isChecked():
                    count += 1
        self._search_selected_label.setText(f"已选中 {count}/{total}")

    def _add_search_results_to_collection(self) -> None:
        """将勾选的搜索结果加入采集队列"""
        urls = []
        for row in range(self._search_results_table.rowCount()):
            widget = self._search_results_table.cellWidget(row, 0)
            if widget:
                cb = widget.findChild(QCheckBox)
                if cb and cb.isChecked():
                    item = self._search_results_table.item(row, 1)
                    if item:
                        urls.append(item.data(Qt.ItemDataRole.UserRole))
        if not urls:
            QMessageBox.information(self, "提示", "请至少选择一条结果")
            return

        self.search_input.add_urls.emit(urls)
        # add_urls 已连接 link_input.append_urls + 自动切到采集 Tab
        self.search_log.append(f"✓ 已添加 {len(urls)} 条链接到采集队列")

    # ===== 事件处理 =====

    def _on_start(self) -> None:
        """开始采集"""
        urls = self.link_input.get_urls()
        if not urls:
            QMessageBox.warning(self, "提示", "请输入至少一条链接")
            return

        results = self.link_parser.parse_batch(urls)
        valid_results = [r for r in results if r["is_valid"]]
        failed_results = [r for r in results if not r["is_valid"]]

        if failed_results:
            fail_info = "\n".join(f"{r['url'][:60]}: {r['error']}" for r in failed_results)
            self.logger.warning(f"以下链接解析失败:\n{fail_info}")

        if not valid_results:
            QMessageBox.warning(self, "提示", "所有链接解析失败，请检查链接格式")
            return

        self.operation_bar.set_collecting_state(True)
        queued_count = 0
        for result in valid_results:
            task = self.task_manager.create_task(result)
            worker = self.task_manager.start_task(task)
            if worker:
                self._connect_worker_signals(worker)
                self.progress_panel.add_task(task.task_id, task.platform_name)
            else:
                # 超出并发限制，已加入等待队列
                queued_count += 1

        total_started = len(valid_results) - queued_count
        if queued_count > 0:
            self.logger.info(f"已启动 {total_started} 个任务，{queued_count} 个排队等待中...")
            self.progress_panel.set_pending_count(queued_count)
        self.logger.success(f"已启动{total_started}个采集任务" + (f"，{queued_count}个排队中" if queued_count else ""))

    def _connect_worker_signals(self, worker) -> None:
        """连接任务工作线程的信号"""
        try:
            worker.signals.progress.disconnect(self._on_task_progress)
            worker.signals.status_changed.disconnect(self._on_task_status)
            worker.signals.lead_found.disconnect(self._on_lead_found)
            worker.signals.task_finished.disconnect(self._on_task_finished)
        except Exception:
            pass
        worker.signals.progress.connect(self._on_task_progress)
        worker.signals.status_changed.connect(self._on_task_status)
        worker.signals.lead_found.connect(self._on_lead_found)
        worker.signals.task_finished.connect(self._on_task_finished)

    def _on_pending_task_started(self, task, worker) -> None:
        """排队任务被调度启动时的回调"""
        self._connect_worker_signals(worker)
        self.progress_panel.add_task(task.task_id, task.platform_name)
        pending = self.task_manager.get_pending_count()
        self.progress_panel.set_pending_count(pending)
        self.logger.info(f"排队任务开始: {task.task_id} - {task.platform_name} (剩余排队 {pending})")

    def _on_pause(self) -> None:
        """暂停/恢复采集"""
        active_tasks = self.task_manager.get_active_tasks()
        if not active_tasks:
            return
        for task_id in active_tasks:
            worker = self.task_manager.get_worker(task_id)
            if worker:
                if worker.task.status.value == "paused":
                    self.task_manager.resume_task(task_id)
                    self.operation_bar.set_pause_button(False)
                else:
                    self.task_manager.pause_task(task_id)
                    self.operation_bar.set_pause_button(True)

    def _on_stop(self) -> None:
        """停止采集"""
        active_tasks = self.task_manager.get_active_tasks()
        pending = self.task_manager.get_pending_count()
        if not active_tasks and not pending:
            return

        msg = f"确定要停止{len(active_tasks)}个正在运行的任务吗？"
        if pending:
            msg += f"\n（还有{pending}个排队任务将被清空）"
        msg += "\n已采集的数据将被保留。"

        reply = QMessageBox.question(self, "确认停止", msg)
        if reply == QMessageBox.StandardButton.Yes:
            for task_id in active_tasks:
                self.task_manager.stop_task(task_id)
            # 清空排队
            self.task_manager._pending_queue.clear()
            self.operation_bar.set_collecting_state(False)
            self.progress_panel.clear()
            self.task_manager.cleanup_finished()
            self.logger.info("所有采集任务已停止")

    def _on_export(self) -> None:
        """打开导出对话框"""
        dialog = ExportDialog(self.database, self)
        dialog.exec()
        self.lead_table.refresh_data()

    def _on_settings(self) -> None:
        """打开设置对话框"""
        dialog = SettingsDialog(self)
        dialog.settings_changed.connect(self._on_settings_changed)
        dialog.exec()

    def _on_settings_changed(self) -> None:
        """设置变更后重新初始化相关模块"""
        self._init_llm()
        self.recognizer = IntentRecognizer(self.llm)
        self.task_manager.recognizer = self.recognizer
        self.settings.load()

    def _on_task_progress(self, task_id: str, current: int, total: int, phase: str = "") -> None:
        self.progress_panel.update_task(task_id, current, total, phase)

    def _on_task_status(self, task_id: str, status: str) -> None:
        self.progress_panel.set_task_status(task_id, status)
        active = bool(self.task_manager.get_active_tasks())
        self.operation_bar.set_collecting_state(active)
        self.status_bar.update_status(f"任务 {task_id}: {status}")

    def _on_lead_found(self, lead_dict: dict) -> None:
        self.lead_table.add_lead(lead_dict)

    def _on_task_finished(self, task_id: str, success: bool, error: str) -> None:
        self.progress_panel.remove_task(task_id)
        self.lead_table.refresh_data()

        # 触发排队任务调度
        self.task_manager._on_worker_finished(task_id)
        pending = self.task_manager.get_pending_count()
        self.progress_panel.set_pending_count(pending)

        active = bool(self.task_manager.get_active_tasks()) or pending > 0
        self.operation_bar.set_collecting_state(active)
        if not active:
            self.status_bar.update_status("就绪")
            self.progress_panel.set_pending_count(0)
            total_leads = self.database.count_leads()
            self.logger.success(f"所有任务完成，共发现{total_leads}条意向线索")
        elif pending > 0:
            self.status_bar.update_status(f"采集中 ({self.task_manager.count_active()} 活跃, {pending} 排队)")

    # ===== 系统托盘 =====

    def _on_tray_activated(self, reason) -> None:
        if reason == QSystemTrayIcon.ActivationReason.DoubleClick:
            self._show_from_tray()

    def _show_from_tray(self) -> None:
        self.show()
        self.setWindowState(self.windowState() & ~Qt.WindowState.WindowMinimized)
        self.activateWindow()

    def closeEvent(self, event: QCloseEvent) -> None:
        active_tasks = self.task_manager.get_active_tasks()
        pending = self.task_manager.get_pending_count()
        if active_tasks or pending:
            msg = "还有任务在运行中，\n确定要关闭吗？"
            if pending:
                msg += f"\n（{pending}个排队任务也将被清空）"
            msg += "\n\n点击'最小化到托盘'可在后台继续运行。"
            reply = QMessageBox.question(
                self, "确认", msg,
                QMessageBox.StandardButton.Close |
                QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Cancel
            )
            if reply != QMessageBox.StandardButton.Close:
                event.ignore()
                return

        self._quit_app()
        event.accept()

    def _quit_app(self) -> None:
        for task_id in self.task_manager.get_active_tasks():
            self.task_manager.stop_task(task_id)
        self.task_manager.cleanup_finished()
        self.database.close()
        self.settings.save()
        self.tray_icon.hide()
        QApplication.quit()
