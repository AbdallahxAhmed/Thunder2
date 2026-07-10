"""Build and package Thunder into a standalone, portable desktop application.

Ensures all requirements (pystray, pillow, pyinstaller) are installed in the venv,
runs PyInstaller to compile src/tray.py into a windowed executable, copies binary
dependencies (bin/*) and CDM device.wvd, and packages the result as a zip archive.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

# Setup paths
root_dir = Path(__file__).resolve().parent
venv_python = root_dir / ".venv" / "Scripts" / "python.exe"

def log(msg: str):
    print(f"\n⚡ [Thunder Build] {msg}")

def ensure_dependencies():
    log("Checking/installing build dependencies in virtual environment...")
    if not venv_python.exists():
        print("Virtual environment python.exe not found.")
        sys.exit(1)
        
    # Install dependencies safely via python module
    subprocess.run([str(venv_python), "-m", "pip", "install", "pystray", "pillow", "pyinstaller"], check=True)

def clean_previous_builds():
    log("Cleaning previous build directories...")
    build_dir = root_dir / "build"
    if build_dir.exists():
        try:
            shutil.rmtree(build_dir)
        except Exception as e:
            print(f"Warning: Could not clean build folder: {e}")
            
    dist_dir = root_dir / "dist"
    if dist_dir.exists():
        for item in dist_dir.iterdir():
            if item.name == "Thunder":
                # Keep data directory inside dist/Thunder to preserve DB
                for subitem in item.iterdir():
                    if subitem.name != "data":
                        try:
                            if subitem.is_dir():
                                shutil.rmtree(subitem)
                            else:
                                subitem.unlink()
                        except Exception as e:
                            print(f"Warning: Could not clean subitem {subitem}: {e}")
            else:
                try:
                    if item.is_dir():
                        shutil.rmtree(item)
                    else:
                        item.unlink()
                except Exception as e:
                    print(f"Warning: Could not clean item {item}: {e}")

    spec_file = root_dir / "Thunder.spec"
    if spec_file.exists():
        spec_file.unlink()

def run_pyinstaller():
    log("Running PyInstaller to compile Thunder...")
    
    # We add src/dashboard to PyInstaller using the platform-specific separator
    # Under Windows, it is a semicolon (;)
    add_data_arg = "src/dashboard;src/dashboard"
    add_icon_arg = "icon.ico;."
    add_bin_arg = "bin;bin"
    icon_path = root_dir / "icon.ico"
    
    cmd = [
        str(venv_python), "-m", "PyInstaller",
        "--onefile",                 # Package everything into a single EXE file
        "--noconsole",               # Windowed app (no command prompt)
        "--name=Thunder",            # Executable name
        f"--icon={str(icon_path)}",  # Set custom application icon
        f"--add-data={add_data_arg}",# Include dashboard static files
        f"--add-data={add_icon_arg}",# Include icon file in runtime resources
        f"--add-data={add_bin_arg}", # Embed binary dependencies (aria2c, N_m3u8DL-RE)
        "--hidden-import=clr",
        "--hidden-import=clr_loader",
        "--hidden-import=pythonnet",
        "--hidden-import=webview",
        "src/tray.py"                # Main entry point script
    ]
    
    subprocess.run(cmd, check=True)

def copy_assets():
    log("Copying third-party binaries and database configs...")
    dist_app_dir = root_dir / "dist" / "Thunder"
    dist_app_dir.mkdir(parents=True, exist_ok=True)
    
    # Move compiled Thunder.exe inside the distribution folder
    exe_src = root_dir / "dist" / "Thunder.exe"
    exe_dst = dist_app_dir / "Thunder.exe"
    if exe_src.exists():
        if exe_dst.exists():
            exe_dst.unlink()
        shutil.move(str(exe_src), str(exe_dst))
        print(f"✔ Moved Thunder.exe inside {dist_app_dir}")
        
    # Copy device.wvd (if present)
    wvd_src = root_dir / "device.wvd"
    wvd_dst = dist_app_dir / "device.wvd"
    if wvd_src.exists():
        shutil.copy2(wvd_src, wvd_dst)
        print(f"✔ Copied Widevine device key to {wvd_dst}")

    # Copy icon.ico (if present)
    icon_src = root_dir / "icon.ico"
    icon_dst = dist_app_dir / "icon.ico"
    if icon_src.exists():
        shutil.copy2(icon_src, icon_dst)
        print(f"✔ Copied icon.ico to {icon_dst}")

    # Copy extension folder
    ext_src = root_dir / "extension"
    ext_dst = dist_app_dir / "extension"
    if ext_src.exists():
        shutil.copytree(ext_src, ext_dst, dirs_exist_ok=True)
        print(f"✔ Copied browser extension to {ext_dst}")

    # Copy register_extension.py
    reg_src = root_dir / "register_extension.py"
    reg_dst = dist_app_dir / "register_extension.py"
    if reg_src.exists():
        shutil.copy2(reg_src, reg_dst)
        print(f"✔ Copied register_extension.py to {reg_dst}")
        
    # Copy a simple helper README
    readme_dst = dist_app_dir / "README.txt"
    readme_content = """⚡ Thunder - Portable Universal Downloader
==========================================

Thunder is running as a background utility. 

How to use:
1. Double-click "Thunder.exe" to start.
2. Look for the Thunder logo (yellow bolt icon) in the Windows system tray (near the clock).
3. Right-click the system tray icon to:
   - Open the web Dashboard.
   - Open the Downloads folder.
   - Change Settings.
   - Exit cleanly.
4. Install the Chrome extension from the "extension" folder in developer mode to capture video lessons automatically.

Enjoy downloading!
"""
    readme_dst.write_text(readme_content, encoding="utf-8")
    print("✔ Created README.txt in portable package")

def create_zip_archive():
    log("Creating zip archive for distribution...")
    dist_app_dir = root_dir / "dist" / "Thunder"
    zip_dst = root_dir / "dist" / "Thunder-v1.0-Portable"
    
    shutil.make_archive(str(zip_dst), 'zip', root_dir / "dist", "Thunder")
    print(f"✔ Created portable zip package at: {zip_dst}.zip")

def main():
    try:
        ensure_dependencies()
        clean_previous_builds()
        run_pyinstaller()
        copy_assets()
        create_zip_archive()
        log("🎉 Thunder desktop package built successfully!")
    except Exception as e:
        log(f"❌ Build failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
