"""
设置对话框
包含：关键词配置 | 大模型参数 | 采集频率 | 安全密码
深色主题
"""
import requests
from PyQt6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QTabWidget,
    QWidget, QLabel, QLineEdit, QSpinBox, QDoubleSpinBox,
    QPushButton, QCheckBox, QComboBox, QTextEdit,
    QGroupBox, QFormLayout, QMessageBox, QStackedWidget,
    QApplication,
)
from PyQt6.QtCore import pyqtSignal, QThread

from config.settings import get_settings
from utils.crypto import CryptoUtil


# 规范色值
_PAGE_BG     = "#0A0D17"
_CARD_BG     = "#151A26"
_CARD_BORDER = "#232836"
_TITLE       = "#F5F0E6"
_BODY        = "#A6ADB8"
_MUTED       = "#86909C"
_GOLD        = "#B88646"
_GOLD_HOVER  = "#C89555"

# ==================== 各提供商的模型列表 API ====================

_PROVIDER_CONFIG = {
    "tongyi": {
        "name": "通义千问",
        "placeholder": "DashScope API Key",
        "models_api": "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
        "default_models": ["qwen-turbo", "qwen-plus", "qwen-max", "qwen-plus-latest", "qwen-max-latest"],
    },
    "wenxin": {
        "name": "文心一言",
        "placeholder": "百度 API Key",
        "has_secret": True,
        "models_api": None,
        "default_models": ["ernie-3.5", "ernie-4.0", "ernie-speed", "ernie-4.5", "ernie-longtext"],
    },
    "openai": {
        "name": "OpenAI GPT",
        "placeholder": "OpenAI API Key",
        "models_api": "https://api.openai.com/v1/models",
        "default_models": ["gpt-3.5-turbo", "gpt-4", "gpt-4-turbo", "gpt-4o", "gpt-4o-mini"],
    },
    "deepseek": {
        "name": "DeepSeek",
        "placeholder": "DeepSeek API Key",
        "models_api": "https://api.deepseek.com/v1/models",
        "models_api_fallback": "https://api.deepseek.com/v1/model/list",
        "default_models": ["deepseek-chat", "deepseek-reasoner"],
    },
    "kimi": {
        "name": "Kimi（月之暗面）",
        "placeholder": "Moonshot API Key",
        "models_api": "https://api.moonshot.cn/v1/models",
        "default_models": ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k", "kimi-k2"],
    },
}


class _ModelFetcher(QThread):
    """后台线程：通过 API 获取最新模型列表"""
    finished = pyqtSignal(str, list, str)

    _CHAT_KW = [
        "gpt", "chat", "qwen", "deepseek", "moonshot", "kimi",
        "ernie", "turbo", "o1", "o2", "o3", "o4",
        "claude", "llama", "mistral", "yi-", "glm", "r1",
    ]
    _EXCLUDE_KW = [
        "embedding", "davinci", "babbage", "audio",
        "whisper", "tts", "dall-e", "moderation",
    ]

    def __init__(self, provider: str, api_key: str):
        super().__init__()
        self.provider = provider
        self.api_key = api_key

    def run(self):
        cfg = _PROVIDER_CONFIG.get(self.provider, {})
        api_url = cfg.get("models_api")
        if not api_url:
            self.finished.emit(self.provider, [], "此提供商暂不支持 API 获取模型列表")
            return

        urls = [api_url]
        fallback = cfg.get("models_api_fallback")
        if fallback:
            urls.append(fallback)

        last_error = ""
        for url in urls:
            models, error = self._try_fetch(url)
            if models:
                self.finished.emit(self.provider, models, "")
                return
            last_error = error

        self.finished.emit(self.provider, [], last_error)

    def _try_fetch(self, api_url: str) -> tuple[list, str]:
        try:
            resp = requests.get(
                api_url,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                timeout=15,
            )
        except requests.Timeout:
            return [], f"请求超时: {api_url}"
        except requests.ConnectionError:
            return [], f"无法连接到 {api_url.split('/')[2]}，请检查网络"
        except requests.RequestException as e:
            return [], f"网络请求失败: {str(e)[:120]}"

        if resp.status_code == 401:
            return [], "API Key 无效或已过期（HTTP 401），请检查密钥是否正确"
        if resp.status_code == 403:
            return [], "API Key 无权限访问模型列表（HTTP 403）"
        if resp.status_code == 404:
            return [], f"端点不存在（HTTP 404）: {api_url}"
        if resp.status_code != 200:
            detail = resp.text[:150] if resp.text else "(无响应内容)"
            return [], f"HTTP {resp.status_code}: {detail}"

        try:
            data = resp.json()
        except Exception:
            return [], f"响应不是有效 JSON: {resp.text[:150]}"

        items = data.get("data") or data.get("models") or []

        models = []
        for item in items:
            model_id = item.get("id") or item.get("modelId") or item.get("model") or ""
            if model_id:
                models.append(model_id)

        if not models:
            snippet = str(data)[:200]
            return [], f"API 返回了数据但未找到模型 ID\n响应: {snippet}"

        chat_models = [m for m in models if any(kw in m.lower() for kw in self._CHAT_KW)]
        if not chat_models:
            chat_models = [m for m in models if not any(x in m.lower() for x in self._EXCLUDE_KW)]

        return chat_models or models, ""


class SettingsDialog(QDialog):
    """设置对话框"""

    settings_changed = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.settings = get_settings()
        self._fetcher: _ModelFetcher | None = None
        self.setWindowTitle("设置")
        self.resize(580, 480)
        self.setMinimumSize(480, 380)
        self.setStyleSheet(f"QDialog {{ background-color: {_PAGE_BG}; }}")
        self._init_ui()
        self._load_settings()

    # ==================== 主布局 ====================

    def _init_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(12)

        self.tabs = QTabWidget()
        self.tabs.addTab(self._create_keywords_tab(), "意向关键词")
        self.tabs.addTab(self._create_llm_tab(), "大模型配置")
        self.tabs.addTab(self._create_scraper_tab(), "采集设置")
        self.tabs.addTab(self._create_security_tab(), "安全设置")
        layout.addWidget(self.tabs)

        # 底部按钮
        btn_layout = QHBoxLayout()
        btn_layout.addStretch()

        save_btn = QPushButton("保存")
        save_btn.setStyleSheet(f"""
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
        save_btn.clicked.connect(self._save)
        btn_layout.addWidget(save_btn)

        cancel_btn = QPushButton("取消")
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(cancel_btn)

        layout.addLayout(btn_layout)

    # ==================== 关键词标签页 ====================

    def _create_keywords_tab(self) -> QWidget:
        w = QWidget()
        layout = QVBoxLayout(w)
        layout.setSpacing(8)

        for level, label in [("high", "高意向关键词"), ("medium", "中意向关键词"), ("low", "低意向关键词")]:
            row = QHBoxLayout()
            lbl = QLabel(f"{label}:")
            lbl.setFixedWidth(120)
            lbl.setStyleSheet(f"font-weight: 500; color: {_TITLE};")
            row.addWidget(lbl)
            edit = QTextEdit()
            edit.setMaximumHeight(80)
            edit.setPlaceholderText("每行一个关键词")
            row.addWidget(edit)
            layout.addLayout(row)
            setattr(self, f"{level}_keywords_edit", edit)

        layout.addStretch()
        return w

    # ==================== 大模型标签页 ====================

    def _create_llm_tab(self) -> QWidget:
        w = QWidget()
        layout = QVBoxLayout(w)
        layout.setSpacing(10)

        provider_row = QHBoxLayout()
        provider_lbl = QLabel("提供商:")
        provider_lbl.setStyleSheet(f"font-weight: 500; font-size: 14px; color: {_TITLE};")
        provider_row.addWidget(provider_lbl)
        self.llm_provider = QComboBox()
        for key, cfg in _PROVIDER_CONFIG.items():
            self.llm_provider.addItem(f"{cfg['name']}", key)
        self.llm_provider.setMinimumWidth(200)
        self.llm_provider.currentIndexChanged.connect(self._on_provider_changed)
        provider_row.addWidget(self.llm_provider)
        provider_row.addStretch()
        layout.addLayout(provider_row)

        self.provider_stack = QStackedWidget()
        for key in _PROVIDER_CONFIG:
            self.provider_stack.addWidget(self._build_provider_page(key))
        layout.addWidget(self.provider_stack)

        common_group = QGroupBox("通用参数")
        common_form = QFormLayout(common_group)
        common_form.setSpacing(8)

        self.temperature = QDoubleSpinBox()
        self.temperature.setRange(0.0, 1.0)
        self.temperature.setSingleStep(0.1)
        self.temperature.setValue(0.3)
        self.temperature.setFixedWidth(100)
        common_form.addRow("Temperature:", self.temperature)

        self.max_tokens = QSpinBox()
        self.max_tokens.setRange(100, 4000)
        self.max_tokens.setValue(500)
        self.max_tokens.setFixedWidth(100)
        common_form.addRow("Max Tokens:", self.max_tokens)

        self.enable_llm = QCheckBox("启用大模型语义校验")
        self.enable_llm.setChecked(True)
        common_form.addRow("", self.enable_llm)
        layout.addWidget(common_group)

        layout.addStretch()
        return w

    def _build_provider_page(self, provider: str) -> QWidget:
        cfg = _PROVIDER_CONFIG[provider]
        page = QWidget()
        form = QFormLayout(page)
        form.setSpacing(8)
        form.setContentsMargins(0, 4, 0, 4)

        key_input = QLineEdit()
        key_input.setEchoMode(QLineEdit.EchoMode.Password)
        key_input.setPlaceholderText(f"输入{cfg['placeholder']}")
        form.addRow("API Key:", key_input)
        setattr(self, f"{provider}_key", key_input)

        if cfg.get("has_secret"):
            secret_input = QLineEdit()
            secret_input.setEchoMode(QLineEdit.EchoMode.Password)
            secret_input.setPlaceholderText("输入百度 Secret Key")
            form.addRow("Secret Key:", secret_input)
            setattr(self, f"{provider}_secret", secret_input)

        model_row = QHBoxLayout()
        model_row.setSpacing(6)

        model_combo = QComboBox()
        model_combo.setMinimumWidth(160)
        model_combo.setEditable(True)
        model_combo.addItems(cfg["default_models"])
        model_row.addWidget(model_combo, 1)
        setattr(self, f"{provider}_model", model_combo)

        refresh_btn = QPushButton("获取最新模型")
        refresh_btn.setFixedWidth(110)
        refresh_btn.setToolTip(f"通过 API 获取 {cfg['name']} 最新可用模型列表")
        refresh_btn.clicked.connect(lambda checked, p=provider: self._fetch_models(p))
        model_row.addWidget(refresh_btn)
        setattr(self, f"{provider}_refresh_btn", refresh_btn)

        form.addRow("模型:", model_row)
        return page

    def _on_provider_changed(self, index: int) -> None:
        self.provider_stack.setCurrentIndex(index)

    # ==================== 动态获取模型列表 ====================

    def _fetch_models(self, provider: str) -> None:
        key_widget = getattr(self, f"{provider}_key", None)
        api_key = key_widget.text().strip() if key_widget else ""

        if not api_key:
            QMessageBox.warning(self, "提示", "请先输入 API Key")
            return

        cfg = _PROVIDER_CONFIG[provider]
        if not cfg.get("models_api"):
            QMessageBox.information(self, "提示", f"{cfg['name']} 暂不支持 API 动态获取模型列表")
            return

        refresh_btn = getattr(self, f"{provider}_refresh_btn", None)
        if refresh_btn:
            refresh_btn.setEnabled(False)
            refresh_btn.setText("获取中...")

        self._fetcher = _ModelFetcher(provider, api_key)
        self._fetcher.finished.connect(self._on_models_fetched)
        self._fetcher.start()

    def _on_models_fetched(self, provider: str, models: list[str], error: str) -> None:
        refresh_btn = getattr(self, f"{provider}_refresh_btn", None)
        if refresh_btn:
            refresh_btn.setEnabled(True)
            refresh_btn.setText("获取最新模型")

        model_combo = getattr(self, f"{provider}_model", None)
        if not model_combo:
            return

        if error:
            QMessageBox.warning(self, "获取失败", f"获取 {provider} 模型列表失败:\n{error}")
            return

        current = model_combo.currentText()
        model_combo.clear()
        model_combo.addItems(models)
        idx = model_combo.findText(current)
        if idx >= 0:
            model_combo.setCurrentIndex(idx)
        else:
            model_combo.setCurrentIndex(0)

    # ==================== 采集标签页 ====================

    def _create_scraper_tab(self) -> QWidget:
        w = QWidget()
        layout = QVBoxLayout(w)
        layout.setSpacing(8)

        form = QFormLayout()
        form.setSpacing(8)

        self.request_interval = QDoubleSpinBox()
        self.request_interval.setRange(0.5, 10.0)
        self.request_interval.setSingleStep(0.5)
        self.request_interval.setValue(2.0)
        form.addRow("请求间隔(秒):", self.request_interval)

        self.max_retries = QSpinBox()
        self.max_retries.setRange(1, 10)
        self.max_retries.setValue(3)
        form.addRow("最大重试次数:", self.max_retries)

        self.scroll_delay = QDoubleSpinBox()
        self.scroll_delay.setRange(0.5, 5.0)
        self.scroll_delay.setSingleStep(0.5)
        self.scroll_delay.setValue(1.5)
        form.addRow("滚动延迟(秒):", self.scroll_delay)

        self.max_comments = QSpinBox()
        self.max_comments.setRange(50, 2000)
        self.max_comments.setValue(500)
        form.addRow("单条最大评论数:", self.max_comments)

        self.concurrent_tasks = QSpinBox()
        self.concurrent_tasks.setRange(1, 10)
        self.concurrent_tasks.setValue(3)
        form.addRow("并发采集数:", self.concurrent_tasks)

        layout.addLayout(form)

        self.headless = QCheckBox("无头模式（不显示浏览器窗口）")
        self.headless.setChecked(True)
        layout.addWidget(self.headless)

        self.simulate_human = QCheckBox("模拟真人操作（随机延迟、滚动）")
        self.simulate_human.setChecked(True)
        layout.addWidget(self.simulate_human)

        layout.addStretch()
        return w

    # ==================== 安全标签页 ====================

    def _create_security_tab(self) -> QWidget:
        w = QWidget()
        layout = QVBoxLayout(w)
        layout.setSpacing(8)

        self.password_enabled = QCheckBox("启用密码保护")
        self.password_enabled.toggled.connect(self._on_password_toggle)
        layout.addWidget(self.password_enabled)

        pwd_group = QGroupBox("密码设置")
        pwd_form = QFormLayout(pwd_group)
        pwd_form.setSpacing(8)

        self.app_password = QLineEdit()
        self.app_password.setEchoMode(QLineEdit.EchoMode.Password)
        self.app_password.setPlaceholderText("设置应用密码（至少6位）")
        pwd_form.addRow("应用密码:", self.app_password)

        self.app_password_confirm = QLineEdit()
        self.app_password_confirm.setEchoMode(QLineEdit.EchoMode.Password)
        self.app_password_confirm.setPlaceholderText("确认密码")
        pwd_form.addRow("确认密码:", self.app_password_confirm)

        pwd_group.setEnabled(False)
        self._pwd_group = pwd_group
        layout.addWidget(pwd_group)

        network_group = QGroupBox("联网模式认证")
        network_form = QFormLayout(network_group)
        network_form.setSpacing(8)

        self.network_username = QLineEdit()
        self.network_username.setPlaceholderText("服务器 API 用户名")
        network_form.addRow("用户名:", self.network_username)

        self.network_password = QLineEdit()
        self.network_password.setEchoMode(QLineEdit.EchoMode.Password)
        self.network_password.setPlaceholderText("服务器 API 密码")
        network_form.addRow("密码:", self.network_password)

        layout.addWidget(network_group)
        layout.addStretch()
        return w

    def _on_password_toggle(self, enabled: bool) -> None:
        self._pwd_group.setEnabled(enabled)

    # ==================== 加载 / 保存 ====================

    def _load_settings(self) -> None:
        config = self.settings.config

        self.high_keywords_edit.setPlainText("\n".join(config.keywords.high_intent))
        self.medium_keywords_edit.setPlainText("\n".join(config.keywords.medium_intent))
        self.low_keywords_edit.setPlainText("\n".join(config.keywords.low_intent))

        idx = self.llm_provider.findData(config.llm.provider)
        if idx >= 0:
            self.llm_provider.setCurrentIndex(idx)
            self.provider_stack.setCurrentIndex(idx)

        # 回填已保存的 API Key（解密后显示）
        for p in _PROVIDER_CONFIG:
            key_attr = f"{p}_api_key"
            encrypted = getattr(config.llm, key_attr, "")
            if encrypted:
                try:
                    decrypted = CryptoUtil.decrypt(encrypted)
                    key_widget = getattr(self, f"{p}_key", None)
                    if key_widget:
                        key_widget.setText(decrypted)
                except Exception:
                    pass
            # 回填模型选择
            model_attr = f"{p}_model"
            model_val = getattr(config.llm, model_attr, "")
            if model_val:
                model_widget = getattr(self, f"{p}_model", None)
                if model_widget:
                    idx_m = model_widget.findText(model_val)
                    if idx_m >= 0:
                        model_widget.setCurrentIndex(idx_m)
                    else:
                        model_widget.setCurrentText(model_val)
            # 回填文心 Secret Key
            if p == "wenxin":
                encrypted_secret = getattr(config.llm, "wenxin_secret_key", "")
                if encrypted_secret:
                    try:
                        decrypted = CryptoUtil.decrypt(encrypted_secret)
                        secret_widget = getattr(self, "wenxin_secret", None)
                        if secret_widget:
                            secret_widget.setText(decrypted)
                    except Exception:
                        pass

        self.temperature.setValue(config.llm.temperature)
        self.max_tokens.setValue(config.llm.max_tokens)
        self.enable_llm.setChecked(config.llm.enable_llm_check)

        self.request_interval.setValue(config.scraper.request_interval)
        self.max_retries.setValue(config.scraper.max_retries)
        self.scroll_delay.setValue(config.scraper.scroll_delay)
        self.max_comments.setValue(config.scraper.max_comments_per_item)
        self.concurrent_tasks.setValue(config.scraper.concurrent_tasks)
        self.headless.setChecked(config.scraper.headless)
        self.simulate_human.setChecked(config.scraper.simulate_human)

        self.password_enabled.setChecked(config.security.password_protected)
        self.network_username.setText(config.network.username)
        self.network_password.setText(config.network.password)

    def _save(self) -> None:
        config = self.settings.config

        config.keywords.high_intent = [k.strip() for k in self.high_keywords_edit.toPlainText().split("\n") if k.strip()]
        config.keywords.medium_intent = [k.strip() for k in self.medium_keywords_edit.toPlainText().split("\n") if k.strip()]
        config.keywords.low_intent = [k.strip() for k in self.low_keywords_edit.toPlainText().split("\n") if k.strip()]

        config.llm.provider = self.llm_provider.currentData() or "tongyi"

        for p in _PROVIDER_CONFIG:
            key_widget = getattr(self, f"{p}_key", None)
            if key_widget:
                key_text = key_widget.text().strip()
                if key_text:
                    setattr(config.llm, f"{p}_api_key", CryptoUtil.encrypt(key_text))
            if p == "wenxin":
                secret_widget = getattr(self, "wenxin_secret", None)
                if secret_widget:
                    secret_text = secret_widget.text().strip()
                    if secret_text:
                        config.llm.wenxin_secret_key = CryptoUtil.encrypt(secret_text)
            model_widget = getattr(self, f"{p}_model", None)
            if model_widget:
                setattr(config.llm, f"{p}_model", model_widget.currentText())

        config.llm.temperature = self.temperature.value()
        config.llm.max_tokens = self.max_tokens.value()
        config.llm.enable_llm_check = self.enable_llm.isChecked()

        config.scraper.request_interval = self.request_interval.value()
        config.scraper.max_retries = self.max_retries.value()
        config.scraper.scroll_delay = self.scroll_delay.value()
        config.scraper.max_comments_per_item = self.max_comments.value()
        config.scraper.concurrent_tasks = self.concurrent_tasks.value()
        config.scraper.headless = self.headless.isChecked()
        config.scraper.simulate_human = self.simulate_human.isChecked()

        if self.password_enabled.isChecked():
            pwd = self.app_password.text()
            pwd_confirm = self.app_password_confirm.text()
            if not pwd:
                QMessageBox.warning(self, "提示", "请输入密码")
                return
            if len(pwd) < 6:
                QMessageBox.warning(self, "提示", "密码长度至少6位")
                return
            if pwd != pwd_confirm:
                QMessageBox.warning(self, "提示", "两次密码输入不一致")
                return
            config.security.password_protected = True
            config.security.app_password_hash = CryptoUtil.hash_password(pwd)
        else:
            config.security.password_protected = False
            config.security.app_password_hash = ""

        config.network.username = self.network_username.text().strip()
        config.network.password = self.network_password.text().strip()

        self.settings.save()
        self.settings_changed.emit()
        self.accept()
        QMessageBox.information(self, "保存成功", "设置已保存")
