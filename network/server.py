"""
联网部署服务器模块（预留功能）
使用Flask提供简易API服务，支持多用户远程访问
"""
import hmac
class NetworkServer:
    """
    联网部署HTTP服务器
    基于Flask框架，提供RESTful API
    使用前需安装: pip install flask
    """

    def __init__(self, host: str = "0.0.0.0", port: int = 8765):
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
            limit = int(request.args.get("limit", 100))
            offset = int(request.args.get("offset", 0))
            leads = db.get_leads(intent_level=intent, platform=platform, limit=limit, offset=offset)
            return jsonify({
                "total": len(leads),
                "data": [lead.to_dict() for lead in leads],
            })

        @app.route("/api/leads", methods=["POST"])
        def create_lead():
            """创建或同步一条线索"""
            from storage.database import Database
            from storage.models import LeadInfo, IntentLevel
            db = Database()
            data = request.get_json() or {}
            user_id = data.get("user_id", "")
            content_id = data.get("content_id", "")
            if not user_id or not content_id:
                return jsonify({"status": "error", "message": "user_id 和 content_id 必填"}), 400
            try:
                lead = LeadInfo(
                    user_id=user_id,
                    nickname=data.get("nickname", ""),
                    gender=data.get("gender", "未知"),
                    comment_text=data.get("comment_text", ""),
                    comment_time=data.get("comment_time", ""),
                    intent_level=IntentLevel(data.get("intent_level", "无")),
                    intent_keywords=data.get("intent_keywords", ""),
                    llm_verified=bool(data.get("llm_verified", False)),
                    llm_analysis=data.get("llm_analysis", ""),
                    platform=data.get("platform", ""),
                    platform_name=data.get("platform_name", ""),
                    source_url=data.get("source_url", ""),
                    content_id=content_id,
                    content_type=data.get("content_type", "video"),
                    likes=int(data.get("likes", 0) or 0),
                    notes=data.get("notes", ""),
                    manually_marked=bool(data.get("manually_marked", False)),
                    is_duplicate=bool(data.get("is_duplicate", False)),
                )
            except ValueError:
                return jsonify({"status": "error", "message": "意向等级无效"}), 400
            lead_id = db.insert_lead(lead)
            return jsonify({"status": "ok", "id": lead_id}), 201

        @app.route("/api/leads/<int:lead_id>", methods=["PUT"])
        def update_lead(lead_id):
            """更新线索（如手动标记）"""
            from storage.database import Database
            db = Database()
            data = request.get_json()
            if data:
                db.update_lead(lead_id, **data)
                return jsonify({"status": "ok"})
            return jsonify({"status": "error", "message": "无效数据"}), 400

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
            limit = int(request.args.get("limit", 100))
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
