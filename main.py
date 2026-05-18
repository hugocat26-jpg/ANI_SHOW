"""
客户线索挖掘PC端软件 - 主入口
支持本地模式和联网部署模式
"""
import sys
import argparse
from PyQt6.QtWidgets import QApplication

from config.settings import get_settings
from utils.logger import Logger
from utils.crypto import CryptoUtil


def check_password() -> bool:
    """检查是否需要密码认证"""
    settings = get_settings()
    settings.load()
    if not settings.config.security.password_protected:
        return True
    if not settings.config.security.app_password_hash:
        return True

    from PyQt6.QtWidgets import QInputDialog, QLineEdit
    password, ok = QInputDialog.getText(
        None, "密码验证", "请输入应用密码:",
        QLineEdit.EchoMode.Password
    )
    if not ok:
        return False
    return CryptoUtil.verify_password(password, settings.config.security.app_password_hash)


def run_local_mode() -> None:
    """本地模式运行"""
    from ui.main_window import MainWindow

    logger = Logger()
    settings = get_settings()
    settings.load()
    logger.init_file_logger()

    app = QApplication.instance() or QApplication(sys.argv)
    app.setApplicationName("客户线索挖掘工具")
    app.setOrganizationName("ClientLeadMiner")

    # 任何 QWidget（包括密码输入框）都必须在 QApplication 创建之后出现。
    if not check_password():
        sys.exit(0)

    # 设置高DPI支持
    app.setStyleSheet("")

    window = MainWindow()
    window.show()

    sys.exit(app.exec())


def run_server_mode(host: str = "127.0.0.1", port: int = 8765) -> None:
    """联网服务器模式运行"""
    from network.server import NetworkServer
    settings = get_settings()
    settings.load()
    network_config = settings.config.network

    if not network_config.username or not network_config.password:
        print("服务器模式未启用：请先在配置中设置 network.username 和 network.password")
        sys.exit(1)

    print(f"启动联网服务器模式: {host}:{port}")
    print("按 Ctrl+C 停止服务器")

    server = NetworkServer(host=host, port=port)
    server.create_app()

    try:
        server.start()
    except KeyboardInterrupt:
        print("\n服务器已停止")
    except Exception as e:
        print(f"服务器启动失败: {e}")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="客户线索挖掘PC端软件")
    parser.add_argument(
        "--mode", choices=["local", "server"], default="local",
        help="运行模式: local (默认本地模式) / server (联网服务器模式)"
    )
    parser.add_argument(
        "--host", default="127.0.0.1",
        help="服务器监听地址 (仅 --mode=server 时有效, 默认 127.0.0.1)"
    )
    parser.add_argument(
        "--port", type=int, default=8765,
        help="服务器监听端口 (仅 --mode=server 时有效, 默认 8765)"
    )
    parser.add_argument(
        "--config", type=str, default="",
        help="指定配置文件路径 (默认使用用户目录下的配置)"
    )

    args = parser.parse_args()

    if args.mode == "server":
        run_server_mode(host=args.host, port=args.port)
    else:
        run_local_mode()


if __name__ == "__main__":
    main()
