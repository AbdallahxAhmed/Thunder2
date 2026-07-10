# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['src\\tray.py'],
    pathex=[],
    binaries=[],
    datas=[('src/dashboard', 'src/dashboard'), ('icon.ico', '.'), ('bin', 'bin')],
    hiddenimports=['clr', 'clr_loader', 'pythonnet', 'webview'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='Thunder',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['D:\\downloaders\\thunder\\icon.ico'],
)
