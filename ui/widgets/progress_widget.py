"""
进度条面板
显示各采集任务的实时进度 — 卡片式布局 + 阶段指示 + 百分比
深色主题 — 哑光金进度条 | 超出高度自动滚动
"""
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QProgressBar,
    QLabel, QFrame, QSizePolicy, QScrollArea,
)
from PyQt6.QtCore import Qt

# 平台图标（unicode 标识）
_PLATFORM_ICONS = {
    "抖音": "🎵", "小红书": "📕", "B站": "📺",
    "YouTube": "▶️", "Instagram": "📷", "Facebook": "📘",
}

# 规范色值
_GOLD        = "#B88646"
_SUCCESS     = "#5CB85C"
_ERROR       = "#D9534F"
_WARNING     = "#F0AD4E"
_MUTED       = "#86909C"
_CARD_BG     = "#151A26"
_CARD_BORDER = "#232836"
_PAGE_BG     = "#0A0D17"
_TITLE       = "#F5F0E6"


class ProgressPanel(QFrame):
    """采集进度面板 — 内容溢出时自动滚动"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("progressPanel")
        self.setMinimumWidth(280)
        self.setMaximumWidth(420)
        self.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Expanding)
        self._task_widgets: dict[str, dict] = {}
        self._init_ui()

    def _init_ui(self) -> None:
        self.setStyleSheet(f"""
            QFrame#progressPanel {{
                background: {_CARD_BG};
                border: 1px solid {_CARD_BORDER};
                border-radius: 12px;
            }}
        """)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(12, 8, 12, 8)
        outer.setSpacing(6)

        # 标题行
        header = QHBoxLayout()
        title = QLabel("● 采集进度")
        title.setStyleSheet(f"font-weight: 500; font-size: 14px; color: {_TITLE};")
        header.addWidget(title)
        header.addStretch()
        self._count_label = QLabel("")
        self._count_label.setStyleSheet(f"font-size: 10px; color: {_MUTED}; font-weight: 300;")
        header.addWidget(self._count_label)
        outer.addLayout(header)

        # 滚动区域 — 内容多时可滚动，不挤压其他卡片
        self._scroll = QScrollArea()
        self._scroll.setWidgetResizable(True)
        self._scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self._scroll.setStyleSheet(f"""
            QScrollArea {{
                border: none; background: transparent;
            }}
            QScrollBar:vertical {{
                background: {_CARD_BG}; width: 6px; border-radius: 3px;
            }}
            QScrollBar::handle:vertical {{
                background: {_CARD_BORDER}; border-radius: 3px; min-height: 30px;
            }}
            QScrollBar::handle:vertical:hover {{ background: {_GOLD}; }}
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
        """)

        self._content = QWidget()
        self._content.setStyleSheet("background: transparent;")
        self._content_layout = QVBoxLayout(self._content)
        self._content_layout.setContentsMargins(0, 0, 0, 0)
        self._content_layout.setSpacing(6)
        self._content_layout.addStretch()

        self._scroll.setWidget(self._content)
        outer.addWidget(self._scroll, 1)

    # ==================== 公共接口 ====================

    def add_task(self, task_id: str, platform_name: str) -> None:
        """添加一个采集任务卡片"""
        if task_id in self._task_widgets:
            return

        card = QFrame()
        card.setStyleSheet(f"""
            QFrame {{ background: {_PAGE_BG}; border: 1px solid {_CARD_BORDER}; border-radius: 8px; }}
        """)
        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(10, 6, 10, 6)
        card_layout.setSpacing(4)

        # 第一行：平台名 + 阶段 + 百分比
        top_row = QHBoxLayout()
        icon = _PLATFORM_ICONS.get(platform_name, "📌")
        name_lbl = QLabel(f"{icon} {platform_name}")
        name_lbl.setStyleSheet(f"font-size: 11px; font-weight: 500; color: {_TITLE};")
        top_row.addWidget(name_lbl)
        top_row.addStretch()

        phase_lbl = QLabel("排队中")
        phase_lbl.setStyleSheet(f"font-size: 10px; color: {_GOLD}; font-weight: 300;")
        top_row.addWidget(phase_lbl)

        pct_lbl = QLabel("0%")
        pct_lbl.setStyleSheet(f"font-size: 11px; font-weight: 500; color: {_GOLD};")
        pct_lbl.setMinimumWidth(36)
        pct_lbl.setAlignment(Qt.AlignmentFlag.AlignRight)
        top_row.addWidget(pct_lbl)
        card_layout.addLayout(top_row)

        # 第二行：进度条
        bar = QProgressBar()
        bar.setMaximum(100)
        bar.setValue(0)
        bar.setTextVisible(False)
        bar.setFixedHeight(5)
        bar.setStyleSheet(f"""
            QProgressBar {{
                border: none; border-radius: 6px; background-color: #1E2330;
            }}
            QProgressBar::chunk {{
                border-radius: 6px; background-color: {_GOLD};
            }}
        """)
        card_layout.addWidget(bar)

        # 插入到 stretch 之前
        self._content_layout.insertWidget(
            self._content_layout.count() - 1, card
        )
        self._task_widgets[task_id] = {
            "card": card, "bar": bar, "phase": phase_lbl,
            "pct": pct_lbl, "name": name_lbl,
        }
        self._update_count()

    def update_task(self, task_id: str, current: int, total: int, phase: str = "") -> None:
        """更新进度条"""
        w = self._task_widgets.get(task_id)
        if not w:
            return

        pct = int(current / total * 100) if total > 0 else 0
        w["bar"].setMaximum(total if total > 0 else 1)
        w["bar"].setValue(min(current, total) if total > 0 else 0)
        w["pct"].setText(f"{pct}%")

        if phase:
            w["phase"].setText(phase)

        color = _SUCCESS if pct >= 80 else _GOLD

        w["bar"].setStyleSheet(f"""
            QProgressBar {{ border: none; border-radius: 6px; background-color: #1E2330; }}
            QProgressBar::chunk {{ border-radius: 6px; background-color: {color}; }}
        """)
        w["pct"].setStyleSheet(f"font-size: 11px; font-weight: 500; color: {color};")
        w["phase"].setStyleSheet(f"font-size: 10px; color: {color}; font-weight: 300;")

    def set_task_status(self, task_id: str, status: str) -> None:
        """更新任务状态"""
        w = self._task_widgets.get(task_id)
        if not w:
            return

        status_config = {
            "completed": ("已完成", _SUCCESS),
            "failed": ("失败", _ERROR),
            "stopped": ("已停止", _MUTED),
            "paused": ("已暂停", _WARNING),
            "running": ("采集中", _GOLD),
        }
        text, color = status_config.get(status, (status, _MUTED))

        w["phase"].setText(text)
        w["phase"].setStyleSheet(f"font-size: 10px; color: {color}; font-weight: 300;")
        w["bar"].setStyleSheet(f"""
            QProgressBar {{ border: none; border-radius: 6px; background-color: #1E2330; }}
            QProgressBar::chunk {{ border-radius: 6px; background-color: {color}; }}
        """)

        if status in ("completed", "failed", "stopped"):
            w["pct"].setText(text)

    def remove_task(self, task_id: str) -> None:
        """移除已完成的任务卡片"""
        w = self._task_widgets.pop(task_id, None)
        if w:
            w["card"].deleteLater()
        self._update_count()

    def clear(self) -> None:
        """清除所有任务"""
        for task_id in list(self._task_widgets.keys()):
            self.remove_task(task_id)

    def set_pending_count(self, count: int) -> None:
        """设置排队中的任务数"""
        self._pending_count = count
        self._update_count()

    def _update_count(self) -> None:
        n = len(self._task_widgets)
        pending = getattr(self, '_pending_count', 0)
        parts = []
        if n > 0:
            parts.append(f"活跃 {n}")
        if pending > 0:
            parts.append(f"排队 {pending}")
        self._count_label.setText(" | ".join(parts) if parts else "")
