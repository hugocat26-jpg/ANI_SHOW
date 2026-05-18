"""
全局样式表 — 深色哑光金主题
设计原则：深邃藏蓝黑底、半透明悬浮卡片、哑光金强调、克制高级
"""

# ═══════════════════════════════════════
# 全局色彩色值（严格固定，不可自定义）
# ═══════════════════════════════════════

# 背景体系
PAGE_BG       = "#0A0D17"   # 深邃藏蓝黑
CARD_BG       = "#151A26"   # rgba(255,255,255,0.05) 近似
CARD_BORDER   = "#232836"   # rgba(255,255,255,0.1) 近似

# 文字体系
TEXT_TITLE    = "#F5F0E6"   # 暖白/米白
TEXT_BODY     = "#A6ADB8"   # 低饱和浅灰
TEXT_DISABLED = "#86909C"   # 禁用灰

# 哑光金强调色
GOLD          = "#B88646"
GOLD_HOVER    = "#C89555"
GOLD_PRESSED  = "#A6783D"

# 功能状态色
SUCCESS       = "#5CB85C"
WARNING_COLOR = "#F0AD4E"
ERROR_COLOR   = "#D9534F"

# 表格专用
TABLE_HEADER_BG  = "#1E2330"   # rgba(255,255,255,0.08)
TABLE_ALT_ROW    = "#0F1420"   # rgba(255,255,255,0.03)
TABLE_SELECTED   = "#2A2218"   # rgba(184,134,70,0.2) 近似

# 日志面板专用
LOG_BG        = "#0A0D17"
LOG_TEXT      = "#A6ADB8"
LOG_INFO      = "#F5F0E6"
LOG_SUCCESS   = "#5CB85C"
LOG_WARNING   = "#F0AD4E"
LOG_ERROR     = "#D9534F"

# 输入框/控件背景
INPUT_BG      = "#151A26"
INPUT_BORDER  = "#232836"
INPUT_FOCUS   = "#B88646"

# ═══════════════════════════════════════
# 全局样式表
# ═══════════════════════════════════════

GLOBAL_STYLE = f"""
/* ============================================
   全局基础
   ============================================ */
QMainWindow, QDialog {{
    background-color: {PAGE_BG};
}}

QWidget {{
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 12px;
    font-weight: 400;
    color: {TEXT_BODY};
    background-color: transparent;
}}

/* ============================================
   卡片容器
   ============================================ */
QFrame#card {{
    background-color: {CARD_BG};
    border: 1px solid {CARD_BORDER};
    border-radius: 12px;
}}

/* ============================================
   输入框 — 36px 高度 / 8px 圆角
   ============================================ */
QLineEdit, QTextEdit, QPlainTextEdit {{
    border: 1px solid {INPUT_BORDER};
    border-radius: 8px;
    padding: 0 12px;
    background-color: {INPUT_BG};
    color: {TEXT_TITLE};
    font-size: 12px;
    min-height: 36px;
    selection-background-color: {GOLD};
    selection-color: #FFFFFF;
}}
QLineEdit:focus, QTextEdit:focus, QPlainTextEdit:focus {{
    border-color: {GOLD};
}}
QLineEdit:disabled, QTextEdit:disabled, QPlainTextEdit:disabled {{
    background-color: {PAGE_BG};
    color: {TEXT_DISABLED};
}}

/* ============================================
   按钮 — 36px 高度 / min 88px 宽 / 8px 圆角
   ============================================ */
QPushButton {{
    border: 1px solid {CARD_BORDER};
    border-radius: 8px;
    padding: 0 16px;
    background-color: transparent;
    color: {TEXT_BODY};
    min-height: 36px;
    min-width: 88px;
    font-size: 12px;
    font-weight: 400;
}}
QPushButton:hover {{
    border-color: {GOLD};
    background-color: {CARD_BG};
}}
QPushButton:pressed {{
    background-color: #1E1820;
    border-color: {GOLD_PRESSED};
}}
QPushButton:disabled {{
    background-color: transparent;
    color: {TEXT_DISABLED};
    border-color: {CARD_BORDER};
}}

/* 主按钮 — 哑光金实心 */
QPushButton#primaryBtn {{
    background-color: {GOLD};
    color: #FFFFFF;
    border: none;
    font-weight: 500;
}}
QPushButton#primaryBtn:hover {{
    background-color: {GOLD_HOVER};
}}
QPushButton#primaryBtn:pressed {{
    background-color: {GOLD_PRESSED};
}}
QPushButton#primaryBtn:disabled {{
    background-color: #5A4A38;
    color: {TEXT_DISABLED};
}}

/* 成功按钮 — 同哑光金（导出等核心操作） */
QPushButton#successBtn {{
    background-color: {GOLD};
    color: #FFFFFF;
    border: none;
    font-weight: 500;
}}
QPushButton#successBtn:hover {{
    background-color: {GOLD_HOVER};
}}
QPushButton#successBtn:pressed {{
    background-color: {GOLD_PRESSED};
}}

/* 危险按钮 */
QPushButton#dangerBtn {{
    background-color: {ERROR_COLOR};
    color: #FFFFFF;
    border: none;
    font-weight: 500;
}}
QPushButton#dangerBtn:hover {{
    background-color: #E06060;
}}
QPushButton#dangerBtn:pressed {{
    background-color: #C04040;
}}

/* ============================================
   表格 — 表头 40px / 行 34px
   ============================================ */
QTableWidget {{
    border: 1px solid {CARD_BORDER};
    border-radius: 8px;
    background-color: {PAGE_BG};
    gridline-color: {CARD_BORDER};
    font-size: 11px;
    color: {TEXT_BODY};
    selection-background-color: {TABLE_SELECTED};
    selection-color: {TEXT_TITLE};
    alternate-background-color: {TABLE_ALT_ROW};
}}
QTableWidget::item {{
    padding: 0 8px;
    height: 34px;
    border-bottom: 1px solid transparent;
}}
QHeaderView::section {{
    background-color: {TABLE_HEADER_BG};
    border: none;
    border-bottom: 1px solid {CARD_BORDER};
    padding: 0 8px;
    height: 40px;
    font-weight: 500;
    font-size: 11px;
    color: {TEXT_TITLE};
}}

/* ============================================
   标签页 — 14px 分区标题
   ============================================ */
QTabWidget::pane {{
    border: 1px solid {CARD_BORDER};
    border-radius: 8px;
    background-color: {CARD_BG};
    top: -1px;
}}
QTabBar::tab {{
    padding: 8px 20px;
    margin-right: 2px;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    color: {TEXT_BODY};
    font-size: 14px;
    font-weight: 500;
    background-color: transparent;
}}
QTabBar::tab:selected {{
    color: {GOLD};
    background-color: {CARD_BG};
    border-bottom: 2px solid {GOLD};
}}
QTabBar::tab:hover:!selected {{
    color: {GOLD};
    background-color: {TABLE_HEADER_BG};
}}

/* ============================================
   滚动条 — 细条
   ============================================ */
QScrollBar:vertical {{
    border: none;
    background: transparent;
    width: 6px;
    margin: 2px;
}}
QScrollBar::handle:vertical {{
    background: #2A2F38;
    border-radius: 3px;
    min-height: 30px;
}}
QScrollBar::handle:vertical:hover {{
    background: {GOLD};
}}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{
    height: 0px;
}}
QScrollBar:horizontal {{
    border: none;
    background: transparent;
    height: 6px;
    margin: 2px;
}}
QScrollBar::handle:horizontal {{
    background: #2A2F38;
    border-radius: 3px;
    min-width: 30px;
}}
QScrollBar::handle:horizontal:hover {{
    background: {GOLD};
}}
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {{
    width: 0px;
}}

/* ============================================
   进度条
   ============================================ */
QProgressBar {{
    border: none;
    border-radius: 8px;
    text-align: center;
    background-color: #1E2330;
    height: 8px;
    font-size: 10px;
    color: {TEXT_BODY};
}}
QProgressBar::chunk {{
    background-color: {GOLD};
    border-radius: 8px;
}}

/* ============================================
   分组框 — 卡片容器 / 12px 圆角
   ============================================ */
QGroupBox {{
    border: 1px solid {CARD_BORDER};
    border-radius: 12px;
    margin-top: 12px;
    padding: 16px 12px 12px 12px;
    background-color: {CARD_BG};
    font-weight: 500;
    font-size: 14px;
    color: {TEXT_TITLE};
}}
QGroupBox::title {{
    subcontrol-origin: margin;
    left: 16px;
    padding: 0 8px;
    color: {TEXT_TITLE};
    background-color: {CARD_BG};
}}

/* ============================================
   复选框 / 单选框
   ============================================ */
QCheckBox, QRadioButton {{
    spacing: 8px;
    color: {TEXT_BODY};
    font-size: 12px;
}}
QCheckBox::indicator {{
    width: 16px;
    height: 16px;
    border: 1px solid {CARD_BORDER};
    border-radius: 3px;
    background-color: {INPUT_BG};
}}
QCheckBox::indicator:checked {{
    background-color: {GOLD};
    border-color: {GOLD};
}}
QCheckBox::indicator:hover {{
    border-color: {GOLD};
}}

/* ============================================
   下拉框 — 36px 高度 / 8px 圆角
   ============================================ */
QComboBox {{
    border: 1px solid {INPUT_BORDER};
    border-radius: 8px;
    padding: 0 12px;
    background-color: {INPUT_BG};
    color: {TEXT_TITLE};
    font-size: 12px;
    min-height: 36px;
}}
QComboBox:focus {{
    border-color: {GOLD};
}}
QComboBox::drop-down {{
    border: none;
    width: 24px;
}}
QComboBox QAbstractItemView {{
    background-color: {CARD_BG};
    border: 1px solid {CARD_BORDER};
    border-radius: 8px;
    selection-background-color: {TABLE_SELECTED};
    selection-color: {TEXT_TITLE};
    outline: none;
    font-size: 12px;
    color: {TEXT_BODY};
}}

/* ============================================
   滑块
   ============================================ */
QSlider::groove:horizontal {{
    border: none;
    height: 4px;
    background-color: #1E2330;
    border-radius: 2px;
}}
QSlider::handle:horizontal {{
    background-color: {GOLD};
    border: 2px solid {CARD_BG};
    width: 14px;
    height: 14px;
    margin: -5px 0;
    border-radius: 7px;
}}
QSlider::handle:horizontal:hover {{
    background-color: {GOLD_HOVER};
}}

/* ============================================
   微调框 — 36px 高度 / 8px 圆角
   ============================================ */
QSpinBox, QDoubleSpinBox {{
    border: 1px solid {INPUT_BORDER};
    border-radius: 8px;
    padding: 0 12px;
    background-color: {INPUT_BG};
    color: {TEXT_TITLE};
    font-size: 12px;
    min-height: 36px;
}}
QSpinBox:focus, QDoubleSpinBox:focus {{
    border-color: {GOLD};
}}

/* ============================================
   提示框（Tooltip）
   ============================================ */
QToolTip {{
    background-color: {CARD_BG};
    color: {TEXT_TITLE};
    border: 1px solid {CARD_BORDER};
    border-radius: 8px;
    padding: 4px 8px;
    font-size: 12px;
}}

/* ============================================
   日志颜色类
   ============================================ */
.log-success {{ color: {LOG_SUCCESS}; }}
.log-warning {{ color: {LOG_WARNING}; }}
.log-error   {{ color: {LOG_ERROR}; }}
.log-info    {{ color: {LOG_INFO}; }}
"""
