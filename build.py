#!/usr/bin/env python
"""
打包脚本
使用方法: python build.py [--onedir|--onefile]
"""
import os
import sys
import subprocess
from pathlib import Path

PROJECT_DIR = Path(__file__).parent

CMD_ONEDIR = [
    sys.executable, "-m", "PyInstaller",
    str(PROJECT_DIR / "build.spec"),
    "--distpath", str(PROJECT_DIR / "dist"),
    "--workpath", str(PROJECT_DIR / "build"),
    "--noconfirm",
]

CMD_ONEFILE = [
    sys.executable, "-m", "PyInstaller",
    "--name", "客户线索挖掘工具",
    "--onefile",
    "--windowed",
    "--icon", "NONE",
    "--add-data", f"config{os.pathsep}config",
    "--hidden-import", "playwright.sync_api",
    "--hidden-import", "pandas",
    "--hidden-import", "openpyxl",
    "--hidden-import", "Crypto",
    "--distpath", str(PROJECT_DIR / "dist"),
    "--workpath", str(PROJECT_DIR / "build"),
    "--noconfirm",
    str(PROJECT_DIR / "main.py"),
]


def main():
    import argparse
    parser = argparse.ArgumentParser(description="打包客户线索挖掘工具")
    parser.add_argument("--onefile", action="store_true", help="打包为单个exe文件")
    parser.add_argument("--onedir", action="store_true", help="打包为目录（默认）")
    args = parser.parse_args()

    print("=" * 60)
    print("客户线索挖掘工具 - 打包脚本")
    print("=" * 60)

    if args.onefile:
        cmd = CMD_ONEFILE
        mode = "单文件"
    else:
        cmd = CMD_ONEDIR
        mode = "目录"

    print(f"打包模式: {mode}")
    print(f"输出目录: {PROJECT_DIR / 'dist'}")
    print()

    try:
        result = subprocess.run(cmd, check=True, cwd=str(PROJECT_DIR))
        print(f"\n打包成功! 输出目录: {PROJECT_DIR / 'dist'}")
    except subprocess.CalledProcessError as e:
        print(f"\n打包失败: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
