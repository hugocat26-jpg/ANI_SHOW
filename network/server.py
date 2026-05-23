"""
联网部署服务器模块（预留功能）
使用Flask提供简易API服务，支持多用户远程访问
"""
import hmac
from urllib.parse import urlparse


_LEAD_TEXT_LIMITS = {
    "user_id": 128,
    "content_id": 256,
    "nickname": 120,
    "gender": 16,
    "comment_text": 5000,
    "comment_time": 64,
    "intent_keywords": 1000,
    "llm_analysis": 5000,
    "platform": 64,
    "platform_name": 64,
    "source_url": 2048,
    "content_type": 32,
    "notes": 5000,
}
_LEAD_UPDATE_FIELDS = {"intent_level", "notes", "manually_marked", "gender"}


def _bounded_int(value, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value) if value is not None else default
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def _bounded_text(data: dict, field: str, default: str = "") -> str:
    value = data.get(field, default)
    if value is None:
        value = default
    text = str(value)
    limit = _LEAD_TEXT_LIMITS[field]
    if len(text) > limit:
        raise ValueError(f"{field} 长度不能超过 {limit}")
    return text


def _validated_likes(value) -> int:
    try:
        likes = int(value or 0)
    except (TypeError, ValueError):
        raise ValueError("likes 必须是数字")
    if likes < 0 or likes > 100_000_000:
        raise ValueError("likes 超出允许范围")
    return likes


def _validate_source_url(value: str) -> str:
    if not value:
        return value
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("source_url 必须是有效的 HTTP/HTTPS 链接")
    return value


def _validated_intent_level(value):
    from storage.models import IntentLevel
    try:
        return IntentLevel(value or "无")
    except ValueError:
        raise ValueError("意向等级无效")


def _validated_update_payload(data: dict) -> dict:
    if not isinstance(data, dict):
        raise ValueError("请求体必须是 JSON 对象")
    patch = {key: data[key] for key in _LEAD_UPDATE_FIELDS if key in data}
    if not patch:
        raise ValueError("没有可更新字段")
    if "intent_level" in patch:
        patch["intent_level"] = _validated_intent_level(patch["intent_level"]).value
    if "notes" in patch:
        patch["notes"] = _bounded_text(patch, "notes")
    if "gender" in patch:
        patch["gender"] = _bounded_text(patch, "gender")
    if "manually_marked" in patch:
        patch["manually_marked"] = bool(patch["manually_marked"])
    return patch


class NetworkServer:
    """
    联网部署HTTP服务器
    基于Flask框架，提供RESTful API
    使用前需安装: pip install flask
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 8765):
        self.host = host
        self.port = port
        self._app = None
        self._running = False

    def create_app(self):
        """创建Flask应用"""
        try:
            from flask import Flask, request, jsonify
        except ImportError:
            raise ImportError("联网模式需要安装Flask: pip install flask")

        app = Flask(__name__)

        @app.before_request
        def require_auth():
            if not request.path.startswith("/api/"):
                return None

            from config.settings import get_settings
            settings = get_settings()
            settings.load()
            expected_user = settings.config.network.username
            expected_password = settings.config.network.password
            if not expected_user or not expected_password:
                return jsonify({
                    "status": "error",
                    "message": "服务器认证未配置",
                }), 503

            auth = request.authorization
            username = auth.username if auth else request.headers.get("X-CLM-Username", "")
            password = auth.password if auth else request.headers.get("X-CLM-Password", "")
            if hmac.compare_digest(username or "", expected_user) and \
                    hmac.compare_digest(password or "", expected_password):
                return None

            return jsonify({"status": "error", "message": "认证失败"}), 401

        @app.route("/api/health", methods=["GET"])
        def health():
            return jsonify({"status": "ok", "mode": "server"})

        @app.route("/api/leads", methods=["GET"])
        def get_leads():
            """获取线索列表"""
            from storage.database import Database
            db = Database()
            intent = request.args.get("intent")
            platform = request.args.get("platform")
            limit = _bounded_int(request.args.get("limit"), default=100, minimum=1, maximum=1000)
            offset = _bounded_int(request.args.get("offset"), default=0, minimum=0, maximum=100000)
            leads = db.get_leads(intent_level=intent, platform=platform, limit=limit, offset=offset)
            return jsonify({
                "total": len(leads),
                "data": [lead.to_dict() for lead in leads],
            })

        @app.route("/api/leads", methods=["POST"])
        def create_lead():
            """创建或同步一条线索"""
            from storage.database import Database
            from storage.models import LeadInfo
            db = Database()
            data = request.get_json(silent=True) or {}
            if not isinstance(data, dict):
                return jsonify({"status": "error", "message": "请求体必须是 JSON 对象"}), 400
            try:
                user_id = _bounded_text(data, "user_id")
                content_id = _bounded_text(data, "content_id")
            except ValueError as exc:
                return jsonify({"status": "error", "message": str(exc)}), 400
            if not user_id or not content_id:
                return jsonify({"status": "error", "message": "user_id 和 content_id 必填"}), 400
            try:
                source_url = _validate_source_url(_bounded_text(data, "source_url"))
                lead = LeadInfo(
                    user_id=user_id,
                    nickname=_bounded_text(data, "nickname"),
                    gender=_bounded_text(data, "gender", "未知"),
                    comment_text=_bounded_text(data, "comment_text"),
                    comment_time=_bounded_text(data, "comment_time"),
                    intent_level=_validated_intent_level(data.get("intent_level", "无")),
                    intent_keywords=_bounded_text(data, "intent_keywords"),
                    llm_verified=bool(data.get("llm_verified", False)),
                    llm_analysis=_bounded_text(data, "llm_analysis"),
                    platform=_bounded_text(data, "platform"),
                    platform_name=_bounded_text(data, "platform_name"),
                    source_url=source_url,
                    content_id=content_id,
                    content_type=_bounded_text(data, "content_type", "video"),
                    likes=_validated_likes(data.get("likes", 0)),
                    notes=_bounded_text(data, "notes"),
                    manually_marked=bool(data.get("manually_marked", False)),
                    is_duplicate=bool(data.get("is_duplicate", False)),
                )
            except ValueError as exc:
                return jsonify({"status": "error", "message": str(exc)}), 400
            lead_id = db.insert_lead(lead)
            return jsonify({"status": "ok", "id": lead_id}), 201

        @app.route("/api/leads/<int:lead_id>", methods=["PUT"])
        def update_lead(lead_id):
            """更新线索（如手动标记）"""
            from storage.database import Database
            db = Database()
            data = request.get_json(silent=True)
            try:
                patch = _validated_update_payload(data)
            except ValueError as exc:
                return jsonify({"status": "error", "message": str(exc)}), 400
            if patch:
                db.update_lead(lead_id, **patch)
                return jsonify({"status": "ok"})
            return jsonify({"status": "error", "message": "没有可更新字段"}), 400

        @app.route("/api/leads/<int:lead_id>", methods=["DELETE"])
        def delete_lead(lead_id):
            """删除线索"""
            from storage.database import Database
            db = Database()
            db.delete_lead(lead_id)
            return jsonify({"status": "ok"})

        @app.route("/api/tasks", methods=["GET"])
        def get_tasks():
            """获取任务列表"""
            from storage.database import Database
            db = Database()
            tasks = db.get_all_tasks()
            return jsonify({
                "total": len(tasks),
                "data": [
                    {
                        "task_id": t.task_id,
                        "url": t.url,
                        "platform_name": t.platform_name,
                        "status": t.status.value if hasattr(t.status, 'value') else t.status,
                        "total_comments": t.total_comments,
                        "intent_count": t.intent_count,
                    }
                    for t in tasks
                ],
            })

        @app.route("/api/logs", methods=["GET"])
        def get_logs():
            """获取操作日志"""
            from storage.database import Database
            db = Database()
            level = request.args.get("level")
            limit = _bounded_int(request.args.get("limit"), default=100, minimum=1, maximum=1000)
            logs = db.get_logs(level=level, limit=limit)
            return jsonify({"data": logs})

        self._app = app
        return app

    def start(self) -> None:
        """启动服务器"""
        if self._running:
            return
        from config.settings import get_settings
        settings = get_settings()
        settings.load()
        if not settings.config.network.username or not settings.config.network.password:
            raise RuntimeError("服务器认证未配置，请先设置 network.username 和 network.password")
        if not self._app:
            self.create_app()
        self._running = True
        self._app.run(host=self.host, port=self.port, debug=False, threaded=True)

    def stop(self) -> None:
        """停止服务器"""
        self._running = False
