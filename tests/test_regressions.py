import base64
import inspect
import sqlite3
import sys
import tempfile
import types
import unittest
from pathlib import Path

from config.settings import get_settings
from core.data_exporter import DataExporter
from storage.database import Database
from storage.models import CollectTask, LeadInfo, IntentLevel, TaskStatus, CompanyInfo
from utils.validators import LinkValidator


def install_pyqt_core_stub():
    if "PyQt6.QtCore" in sys.modules:
        return

    class _Signal:
        def __init__(self, *args, **kwargs):
            self._callbacks = []

        def connect(self, callback):
            self._callbacks.append(callback)

        def disconnect(self, callback=None):
            if callback is None:
                self._callbacks.clear()
            elif callback in self._callbacks:
                self._callbacks.remove(callback)

        def emit(self, *args, **kwargs):
            for callback in list(self._callbacks):
                callback(*args, **kwargs)

    class _QObject:
        pass

    class _QThread:
        def __init__(self, *args, **kwargs):
            self._running = False

        def start(self):
            self._running = True

        def isRunning(self):
            return self._running

        def isFinished(self):
            return not self._running

        def wait(self, timeout=None):
            self._running = False
            return True

    pyqt_pkg = types.ModuleType("PyQt6")
    qtcore = types.ModuleType("PyQt6.QtCore")
    qtcore.QThread = _QThread
    qtcore.QObject = _QObject
    qtcore.pyqtSignal = _Signal
    sys.modules.setdefault("PyQt6", pyqt_pkg)
    sys.modules["PyQt6.QtCore"] = qtcore


class RegressionTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        Database._instances.clear()
        self.db = Database(Path(self.tmp.name) / "test.db")

    def tearDown(self):
        self.db.close()
        Database._instances.clear()

    def test_link_platform_detection_uses_hostname_only(self):
        self.assertEqual(
            LinkValidator.identify_platform("https://www.douyin.com/video/123456"),
            "douyin",
        )
        self.assertEqual(
            LinkValidator.identify_platform("https://sub.youtube.com/watch?v=abcdefghijk"),
            "youtube",
        )
        self.assertIsNone(
            LinkValidator.identify_platform("https://evil.example/watch?next=douyin.com/video/123")
        )

    def test_searcher_decodes_wrapped_urls_and_requires_real_content_hosts(self):
        install_pyqt_core_stub()
        from core.searcher import (
            _best_search_result_title,
            _clean_result_text,
            _guess_platform_from_url,
            _is_platform_content_url,
            _normalize_result_url,
        )

        wrapped = (
            "https://www.bing.com/ck/a?!&&u="
            "a1aHR0cHM6Ly93d3cuZG91eWluLmNvbS92aWRlby8xMjM0NTY"
            "&ntb=1"
        )
        self.assertEqual(
            _normalize_result_url(wrapped),
            "https://www.douyin.com/video/123456",
        )
        self.assertEqual(_guess_platform_from_url(wrapped), ("douyin", "抖音"))
        self.assertTrue(_is_platform_content_url(wrapped, "douyin"))
        self.assertFalse(
            _is_platform_content_url("https://evil.example/path?u=instagram.com/p/123", "instagram")
        )
        self.assertFalse(
            _is_platform_content_url("https://www.instagram.com/accounts/login/", "instagram")
        )
        self.assertFalse(
            _is_platform_content_url("https://www.instagram.com/p/signin/", "instagram")
        )
        self.assertEqual(
            _best_search_result_title(
                "小红书",
                "家用咖啡机选购攻略，预算不同怎么选。更多内容...",
                "https://www.xiaohongshu.com/explore/abc",
                "小红书",
            ),
            "家用咖啡机选购攻略，预算不同怎么选",
        )
        self.assertEqual(_clean_result_text("在家喝咖啡 - 抖音"), "在家喝咖啡")
        self.assertEqual(
            _best_search_result_title(
                "抖音 https://www.douyin.com › video",
                "抖音 https://www.douyin.com › video 咖啡机保姆级教程来了 很多姐妹像我一样第一次在家里使用咖啡机",
                "https://www.douyin.com/video/7573485523579374939",
                "抖音",
            ),
            "咖啡机保姆级教程来了 很多姐妹像我一样第一次在家里使用咖啡机",
        )

    def test_link_parser_supports_search_result_url_shapes(self):
        self.assertEqual(
            LinkValidator.extract_content_id(
                "https://www.xiaohongshu.com/discovery/item/6233548400000000010259a5",
                "xiaohongshu",
            ),
            "6233548400000000010259a5",
        )
        self.assertEqual(
            LinkValidator.extract_content_id("https://www.facebook.com/watch/?v=123456789", "facebook"),
            "123456789",
        )

    def test_batch_parser_keeps_going_after_single_url_exception(self):
        from core.link_parser import LinkParser

        parser = LinkParser()
        original = parser.parse

        def flaky(url):
            if "boom" in url:
                raise RuntimeError("boom")
            return original(url)

        parser.parse = flaky
        results = parser.parse_batch([
            "https://www.bilibili.com/video/BV1zoi9B6Ex7/",
            "https://boom.example/video/1",
        ])

        self.assertEqual(len(results), 2)
        self.assertTrue(results[0]["is_valid"])
        self.assertFalse(results[1]["is_valid"])
        self.assertIn("解析异常", results[1]["error"])

    def test_platform_status_uses_domain_specific_login_state(self):
        install_pyqt_core_stub()
        import core.searcher as searcher

        with tempfile.TemporaryDirectory() as tmp:
            profile = Path(tmp)
            default = profile / "Default"
            default.mkdir(parents=True)
            conn = sqlite3.connect(default / "Cookies")
            try:
                conn.execute("CREATE TABLE cookies (host_key TEXT)")
                conn.execute("INSERT INTO cookies VALUES ('.xiaohongshu.com')")
                conn.commit()
            finally:
                conn.close()

            self.assertTrue(searcher._profile_has_domain_state(profile, "xiaohongshu"))
            self.assertFalse(searcher._profile_has_domain_state(profile, "instagram"))

    def test_all_content_type_defaults_include_all_social_platforms(self):
        from ui.widgets.search_input import CONTENT_TYPE_PLATFORMS

        self.assertEqual(
            CONTENT_TYPE_PLATFORMS["all"],
            ("douyin", "bilibili", "xiaohongshu", "youtube", "instagram", "facebook"),
        )

    def test_export_respects_selected_and_default_fields(self):
        self.db.insert_lead(LeadInfo(
            user_id="u1",
            nickname="Alice",
            comment_text="多少钱，有链接吗",
            intent_level=IntentLevel.HIGH,
            platform="douyin",
            platform_name="抖音",
            content_id="c1",
        ))

        csv_path = Path(self.tmp.name) / "leads.csv"
        success, message = DataExporter(self.db).export(
            str(csv_path),
            format_type="csv",
            fields=["user_id", "nickname", "intent_level"],
        )

        self.assertTrue(success, message)
        text = csv_path.read_text(encoding="utf-8-sig")
        header = text.splitlines()[0]
        self.assertEqual(header, "用户ID,昵称,意向等级")
        self.assertNotIn("意向评论", header)

    def test_company_insert_updates_same_name_instead_of_duplicating(self):
        first_id = self.db.insert_company(CompanyInfo(name="Acme", website="https://old.example"))
        second_id = self.db.insert_company(CompanyInfo(name="Acme", website="https://new.example"))

        companies = self.db.get_companies(keyword="Acme")
        self.assertEqual(first_id, second_id)
        self.assertEqual(len(companies), 1)
        self.assertEqual(companies[0].website, "https://new.example")

    def test_task_status_updates_are_persisted(self):
        install_pyqt_core_stub()
        try:
            from core.task_manager import TaskWorker
        except ModuleNotFoundError:
            raise

        task = CollectTask(
            task_id="task-1",
            url="https://www.douyin.com/video/123",
            platform="douyin",
            platform_name="抖音",
            content_type="video",
            content_id="123",
        )
        worker = TaskWorker(task, scraper=None, recognizer=None, extractor=None, database=self.db)
        task.total_comments = 12
        task.collected_comments = 12
        task.intent_count = 3
        worker._update_status(TaskStatus.COMPLETED)

        saved = self.db.get_task("task-1")
        self.assertIsNotNone(saved)
        self.assertEqual(saved.status, TaskStatus.COMPLETED)
        self.assertEqual(saved.total_comments, 12)
        self.assertEqual(saved.intent_count, 3)

    def test_local_mode_creates_qapplication_before_password_prompt(self):
        try:
            import main
        except ModuleNotFoundError as exc:
            if exc.name in {"PyQt6", "Crypto"}:
                source = Path("main.py").read_text(encoding="utf-8")
                run_local_source = source[source.index("def run_local_mode"):]
                self.assertLess(
                    run_local_source.index("QApplication.instance()"),
                    run_local_source.index("check_password()"),
                )
                return
            raise

        source = inspect.getsource(main.run_local_mode)
        self.assertLess(source.index("QApplication.instance()"), source.index("check_password()"))

    def test_platform_catalog_tracks_supported_and_future_targets(self):
        install_pyqt_core_stub()
        from core.platforms import PlatformCapability
        from core.platforms.catalog import PlatformCatalog

        catalog = PlatformCatalog()
        keys = {spec.key for spec in catalog.supported()}
        self.assertIn("douyin", keys)
        self.assertIn("google", keys)
        searchable = {spec.key for spec in catalog.by_capability(PlatformCapability.SEARCH)}
        self.assertIn("bilibili", searchable)
        future = {target.key for target in catalog.expansion_targets()}
        self.assertIn("tiktok", future)

    def test_ai_service_has_rule_fallback_for_scoring_and_keywords(self):
        from core.ai_service import AIService

        service = AIService()
        keywords = service.expand_keywords("咖啡机")
        self.assertIn("咖啡机 怎么选", keywords)
        score = service.score_lead(LeadInfo(
            nickname="Alice",
            comment_text="多少钱，有链接吗",
            intent_level=IntentLevel.HIGH,
            intent_keywords="多少钱",
        ))
        self.assertGreaterEqual(score.score, 90)
        self.assertEqual(score.suggested_action, "优先跟进")

    def test_application_services_builds_shared_framework(self):
        install_pyqt_core_stub()
        from core.app_services import ApplicationServices

        services = ApplicationServices.build(
            settings=get_settings(),
            database=self.db,
            max_concurrent=1,
        )
        self.assertIs(services.database, self.db)
        self.assertIs(services.task_manager.database, self.db)
        self.assertIs(services.task_manager.recognizer, services.recognizer)
        self.assertTrue(services.platforms.supported())


class ServerAuthTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        Database._instances.clear()
        self.db_path = Path(self.tmp.name) / "server.db"
        self.config_path = Path(self.tmp.name) / "config.json"

        settings = get_settings()
        settings._config_path = self.config_path
        settings.reset()
        settings.config.network.username = "admin"
        settings.config.network.password = "secret"
        settings.save()

    def tearDown(self):
        Database._instances.clear()

    def test_server_requires_auth_and_accepts_basic_auth(self):
        try:
            from network.server import NetworkServer
        except ImportError as exc:
            self.skipTest(str(exc))

        try:
            app = NetworkServer(host="127.0.0.1", port=8765).create_app()
        except ImportError as exc:
            self.skipTest(str(exc))
        client = app.test_client()

        self.assertEqual(client.get("/api/health").status_code, 401)

        token = base64.b64encode(b"admin:secret").decode("ascii")
        resp = client.get("/api/health", headers={"Authorization": f"Basic {token}"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["status"], "ok")

    def test_server_rejects_requests_when_auth_config_missing(self):
        settings = get_settings()
        settings.config.network.username = ""
        settings.config.network.password = ""
        settings.save()

        try:
            from network.server import NetworkServer
            app = NetworkServer().create_app()
        except ImportError as exc:
            self.skipTest(str(exc))

        resp = app.test_client().get("/api/health")
        self.assertEqual(resp.status_code, 503)


if __name__ == "__main__":
    unittest.main()
