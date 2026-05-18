# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller 打包配置文件
将 Python 代码打包为独立 exe 文件（64位 Windows）
"""

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=[
        # 如需打包其他资源文件，在此添加
        # ('res/icon.ico', 'res'),
    ],
    hiddenimports=[
        'playwright',
        'playwright.sync_api',
        'pandas',
        'openpyxl',
        'requests',
        'Crypto',
        'PyQt6.QtCore',
        'PyQt6.QtGui',
        'PyQt6.QtWidgets',
        'sqlite3',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter',
        'matplotlib',
        'scipy',
        'numpy.random._examples',
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='客户线索挖掘工具',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch="x86_64",
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
    uac_admin=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='客户线索挖掘工具',
)
