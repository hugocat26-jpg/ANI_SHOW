"""
任务管理器模块
负责采集任务的调度、暂停、恢复、停止控制
使用QThread工作线程执行采集任务，通过信号槽与UI交互
"""
import queue
import random
import threading
import time
import uuid
from datetime import datetime
from enum import Enum
from typing import Optional, Callable

from PyQt6.QtCore import QThread, pyqtSignal, QObject

from storage.models import TaskStatus, CollectTask
from utils.logger import Logger


class TaskSignals(QObject):
    """任务线程信号"""
    progress = pyqtSignal(str, int, int, str)    # task_id, current, total, phase
    status_changed = pyqtSignal(str, str)        # task_id, new_status
    log = pyqtSignal(str, str)                   # level, message
    lead_found = pyqtSignal(dict)                 # lead_info dict
    task_finished = pyqtSignal(str, bool, str)   # task_id, success, error_msg


class TaskWorker(QThread):
    """采集任务工作线程基类"""

    def __init__(self, task: CollectTask, scraper, recognizer, extractor, database):
        super().__init__()
        self.task = task
        self.scraper = scraper
        self.recognizer = recognizer
        self.extractor = extractor
        self.database = database
        self.signals = TaskSignals()
        self._pause_event = threading.Event()
        self._pause_event.set()  # 初始为非暂停状态
        self._stop_event = threading.Event()
        self.logger = Logger()

    def run(self) -> None:
        """线程主函数 — 执行采集流程"""
        task_id = self.task.task_id
        try:
            # 状态 → 采集中
            self._update_status(TaskStatus.RUNNING)
            self.signals.log.emit("INFO", f"开始采集: {self.task.platform_name} - {self.task.url}")
            self.signals.progress.emit(task_id, 0, 100, "启动中")

            # 1. 采集评论（通过回调报告抓取进度）
            comments = self._collect_comments()

            if self._stop_event.is_set():
                self._update_status(TaskStatus.STOPPED)
                self.signals.log.emit("WARNING", f"采集已停止: {task_id}")
                self.signals.task_finished.emit(task_id, False, "用户停止")
                return

            total = len(comments)
            self.signals.log.emit("SUCCESS", f"采集完成: 共{total}条评论")
            if total == 0:
                self.signals.log.emit("WARNING", f"未获取到评论，请确认链接有效且可在浏览器中正常查看评论区")
                self.signals.progress.emit(task_id, 0, 1, "无评论")

            # 2. 意向识别
            intent_count = 0
            for i, comment in enumerate(comments):
                if self._stop_event.is_set():
                    self._update_status(TaskStatus.STOPPED)
                    self.signals.log.emit("WARNING", f"分析已停止: {task_id}")
                    self.signals.task_finished.emit(task_id, False, "用户停止")
                    return
                self._check_pause()

                # 意向识别
                lead = self.recognizer.recognize(comment)
                if lead and lead.intent_level.value != "无":
                    # 3. 信息提取
                    lead = self.extractor.extract(comment, lead)
                    self.database.insert_lead(lead)
                    self.signals.lead_found.emit(lead.to_dict())
                    intent_count += 1
                    self.signals.log.emit("INFO", f"发现意向评论: [{lead.intent_level.value}] {comment.nickname} - {comment.comment_text[:50]}")

                if total > 0:
                    # 分析阶段进度映射到 70-100%
                    progress_pct = 70 + int((i + 1) / total * 30)
                    self.signals.progress.emit(task_id, progress_pct, 100, "分析意向")

            self.task.total_comments = total
            self.task.collected_comments = total
            self.task.intent_count = intent_count
            self._update_status(TaskStatus.COMPLETED)
            self.signals.progress.emit(task_id, 100, 100, "完成")
            self.signals.log.emit("SUCCESS", f"任务完成: {task_id}, 共{total}条评论, {intent_count}条意向")
            self.signals.task_finished.emit(task_id, True, "")

        except Exception as e:
            self.task.error_message = str(e)
            self._update_status(TaskStatus.FAILED)
            self.signals.log.emit("ERROR", f"任务失败: {task_id} - {str(e)}")
            self.signals.task_finished.emit(task_id, False, str(e))
        finally:
            # 关闭当前线程的数据库连接（每个线程通过 threading.local() 持有独立连接）
            try:
                self.database.close()
            except Exception:
                pass

    def _collect_comments(self) -> list:
        """采集评论"""

        def scrape_progress(phase: str, current: int, total: int):
            """抓取进度回调，转发到UI"""
            self.signals.log.emit("INFO", f"[采集] {phase}")
            # 将抓取阶段的进度映射到 0-70% 区间（抓取完成后用 70-100% 分析）
            mapped = int(current / total * 70) if total > 0 else 0
            self.signals.progress.emit(self.task.task_id, mapped, 100, phase)

        comments = []
        try:
            self.signals.log.emit("INFO", "启动浏览器采集评论...")
            comments = self.scraper.scrape(
                self.task.url, self.task.platform, self.task.content_id,
                progress_callback=scrape_progress
            )
        except Exception as e:
            self.signals.log.emit("ERROR", f"评论采集异常: {str(e)}")
        return comments

    def _check_pause(self) -> None:
        """检查暂停状态，如暂停则阻塞等待"""
        self._pause_event.wait()

    def pause(self) -> None:
        self._pause_event.clear()
        self._update_status(TaskStatus.PAUSED)
        self.signals.log.emit("WARNING", f"任务已暂停: {self.task.task_id}")

    def resume(self) -> None:
        self._pause_event.set()
        self._update_status(TaskStatus.RUNNING)
        self.signals.log.emit("INFO", f"任务已恢复: {self.task.task_id}")

    def stop(self) -> None:
        self._stop_event.set()
        self._pause_event.set()  # 解除暂停以便退出
        self.signals.log.emit("WARNING", f"正在停止任务: {self.task.task_id}")

    def _update_status(self, status: TaskStatus) -> None:
        self.task.status = status
        try:
            self.database.save_task(self.task)
        except Exception as e:
            self.logger.warning(f"保存任务状态失败: {self.task.task_id} - {str(e)[:100]}")
        self.signals.status_changed.emit(self.task.task_id, status.value)


class TaskManager:
    """任务管理器 — 管理所有采集任务的生命周期，限制并发浏览器数防止闪退"""

    def __init__(self, scraper_factory, recognizer, extractor, database,
                 max_concurrent: int = 3):
        self.scraper_factory = scraper_factory
        self.recognizer = recognizer
        self.extractor = extractor
        self.database = database
        self.max_concurrent = max_concurrent
        self._workers: dict[str, TaskWorker] = {}
        self._pending_queue: list[CollectTask] = []
        self._lock = threading.RLock()  # 可重入锁，允许同一线程多次获取
        self.logger = Logger()

    def create_task(self, parse_result: dict) -> CollectTask:
        """根据解析结果创建任务"""
        task = CollectTask(
            task_id=parse_result["task_id"],
            url=parse_result["url"],
            platform=parse_result["platform"],
            platform_name=parse_result["platform_name"],
            content_type=parse_result["content_type"],
            content_id=parse_result["content_id"],
            status=TaskStatus.PENDING,
        )
        self.database.save_task(task)
        return task

    def count_active(self) -> int:
        """统计当前正在运行的任务数"""
        return sum(
            1 for w in self._workers.values()
            if w.isRunning() and w.task.status in (TaskStatus.RUNNING, TaskStatus.PAUSED)
        )

    def start_task(self, task: CollectTask) -> Optional[TaskWorker]:
        """启动采集任务，超出并发限制则加入等待队列"""
        with self._lock:
            self.cleanup_finished()

            # 如果同 task_id 已有运行中的 worker，先停止再创建新的
            if task.task_id in self._workers:
                old_worker = self._workers[task.task_id]
                if old_worker.isRunning():
                    self.logger.warning(f"任务已在运行中，先停止旧任务: {task.task_id}")
                    old_worker.stop()
                    old_worker.wait(8000)
                self._disconnect_worker(old_worker)
                del self._workers[task.task_id]

            active_count = self.count_active()
            if active_count >= self.max_concurrent:
                # 超出并发限制，加入等待队列
                self._pending_queue.append(task)
                self.logger.info(f"任务排队等待: {task.task_id} - {task.platform_name} (当前活跃 {active_count})")
                return None  # 返回 None 表示已排队，调用方不立即连接信号

            return self._launch_task(task)

    def _launch_task(self, task: CollectTask) -> TaskWorker:
        """实际启动任务线程 — 增加启动间隔防止浏览器资源竞争"""
        # 任务间增加随机延迟，减少 Edge 进程并发压力
        if self._workers:
            time.sleep(random.uniform(1.5, 3.0))
        scraper = self.scraper_factory.create(task.platform)
        worker = TaskWorker(task, scraper, self.recognizer, self.extractor, self.database)
        self._workers[task.task_id] = worker
        worker.start()
        self.logger.info(f"任务已启动: {task.task_id} - {task.platform_name}")
        return worker

    def _on_worker_finished(self, task_id: str) -> None:
        """任务完成回调 — 启动下一个排队任务"""
        with self._lock:
            # 清理已完成的任务
            finished = [tid for tid, w in self._workers.items() if w.isFinished()]
            for tid in finished:
                worker = self._workers.pop(tid, None)
                if worker:
                    self._disconnect_worker(worker)

            # 如果还有排队任务，启动下一个
            if self._pending_queue:
                next_task = self._pending_queue.pop(0)
                worker = self._launch_task(next_task)
                # 通知外部有新任务启动（通过 pending_started 回调）
                if hasattr(self, '_on_pending_started') and self._on_pending_started:
                    self._on_pending_started(next_task, worker)

    def get_pending_count(self) -> int:
        """获取排队中的任务数"""
        with self._lock:
            return len(self._pending_queue)

    def set_pending_callback(self, callback) -> None:
        """设置排队任务启动回调: callback(task, worker)"""
        self._on_pending_started = callback

    def pause_task(self, task_id: str) -> None:
        """暂停任务"""
        worker = self._workers.get(task_id)
        if worker and worker.isRunning():
            worker.pause()
            self.database.save_task(worker.task)

    def resume_task(self, task_id: str) -> None:
        """恢复任务"""
        worker = self._workers.get(task_id)
        if worker and worker.isRunning():
            worker.resume()
            self.database.save_task(worker.task)

    def stop_task(self, task_id: str) -> None:
        """停止任务（线程安全，可安全重复调用）"""
        worker = self._workers.get(task_id)
        if not worker:
            return
        worker.stop()
        self.database.save_task(worker.task)
        # 等待线程结束（最多10秒，给 Playwright 清理留足时间）
        if worker.isRunning():
            worker.wait(10000)
        self._disconnect_worker(worker)

    @staticmethod
    def _disconnect_worker(worker: TaskWorker) -> None:
        """断开 worker 的所有信号连接，防止野指针崩溃"""
        try:
            worker.signals.progress.disconnect()
            worker.signals.status_changed.disconnect()
            worker.signals.log.disconnect()
            worker.signals.lead_found.disconnect()
            worker.signals.task_finished.disconnect()
        except Exception:
            pass  # 可能已断开

    def get_worker(self, task_id: str) -> Optional[TaskWorker]:
        return self._workers.get(task_id)

    def get_active_tasks(self) -> list[str]:
        """获取活跃任务ID列表"""
        return [
            tid for tid, w in self._workers.items()
            if w.isRunning() and w.task.status in (TaskStatus.RUNNING, TaskStatus.PAUSED)
        ]

    def cleanup_finished(self) -> None:
        """清理已完成的任务线程（线程安全）"""
        with self._lock:
            finished_ids = [
                tid for tid, w in self._workers.items()
                if w.isFinished()
            ]
            for tid in finished_ids:
                worker = self._workers.get(tid)
                if worker:
                    self._disconnect_worker(worker)
                    del self._workers[tid]
