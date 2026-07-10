"""Windows System Tray & Native Webview2 GUI for Thunder.

Spawns a native MS Edge WebView2 desktop window (Tauri-style) to render the dashboard
and runs the FastAPI server and a system tray manager in background daemon threads.
"""

from __future__ import annotations

import os
import sys
import time
import threading
import sqlite3
from pathlib import Path

# Add project root to path if running directly
project_root = Path(__file__).resolve().parent.parent
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

# Third-party packages
import uvicorn
import webview
from PIL import Image, ImageDraw

try:
    import pystray
except ImportError:
    print("pystray is not installed. Please install pystray and pillow first.")
    sys.exit(1)

from src.main import app
from src.config import settings

# Global state
window = None
should_really_exit = False

class UvicornServer(threading.Thread):
    """Background thread to run the Uvicorn server."""
    def __init__(self):
        super().__init__(name="ThunderUvicornThread", daemon=True)
        self.config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=settings.port,
            log_level="error" # Keep logs clean
        )
        self.server = uvicorn.Server(self.config)

    def run(self):
        self.server.run()

    def stop(self):
        self.server.should_exit = True

# Helper to read/write settings directly in SQLite
def get_db_setting(key: str, default: str) -> str:
    try:
        conn = sqlite3.connect(settings.db_path)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("SELECT value FROM settings WHERE key = ?", (key,))
        row = cur.fetchone()
        conn.close()
        if row:
            val = row["value"]
            if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                val = val[1:-1]
            return val
        return default
    except Exception:
        return default

def set_db_setting(key: str, value: str):
    try:
        conn = sqlite3.connect(settings.db_path)
        cur = conn.cursor()
        cur.execute("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))", (key, value))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Error saving setting: {e}")

# Helper to create a premium system tray icon dynamically
def create_tray_image():
    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse((4, 4, 60, 60), fill=(30, 30, 46, 255), outline=(137, 180, 250, 255), width=3)
    points = [
        (36, 12),  # Top point
        (20, 34),  # Left bend
        (32, 34),  # Inner bend left
        (28, 52),  # Bottom point
        (44, 30),  # Right bend
        (32, 30),  # Inner bend right
    ]
    draw.polygon(points, fill=(249, 226, 175, 255))
    return image

class ThunderTrayApp:
    def __init__(self):
        self.server_thread = UvicornServer()
        self.icon = None
        
    def show_gui(self, icon=None, item=None):
        global window
        if window:
            window.show()
            # Bring window to focus
            # webview doesn't have focus() but show() restores it

    def open_downloads(self, icon=None, item=None):
        dl_dir = os.path.abspath(settings.download_dir)
        os.makedirs(dl_dir, exist_ok=True)
        os.startfile(dl_dir)

    def toggle_auto_start(self, icon, item):
        current = get_db_setting("auto_start_downloads", "true")
        new_val = "false" if current == "true" else "true"
        set_db_setting("auto_start_downloads", new_val)
        show_status = "enabled" if new_val == "true" else "disabled"
        self.icon.notify(f"Auto-Start Captures is now {show_status}.", title="Thunder Settings")

    def is_auto_start_checked(self, item):
        return get_db_setting("auto_start_downloads", "true") == "true"

    def shutdown(self, icon, item):
        global should_really_exit, window
        print("Stopping Thunder server...")
        should_really_exit = True
        self.server_thread.stop()
        self.icon.stop()
        if window:
            window.destroy()

    def run_tray(self):
        menu = pystray.Menu(
            pystray.MenuItem("Thunder Manager ⚡", lambda: None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Open GUI Window 📱", self.show_gui, default=True),
            pystray.MenuItem("Open Downloads Folder 📂", self.open_downloads),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Auto-Start Captures", self.toggle_auto_start, checked=self.is_auto_start_checked),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Exit Thunder ❌", self.shutdown)
        )
        
        self.icon = pystray.Icon(
            "Thunder",
            create_tray_image(),
            title="Thunder ⚡ Universal Downloader",
            menu=menu
        )
        self.icon.run()

def on_closing():
    """Intercept close event: hide window instead of terminating (IDM style)."""
    global should_really_exit, window
    if should_really_exit:
        return True # Allow destruction
    else:
        window.hide()
        return False # Intercept/cancel destruction

import asyncio
from fastapi import APIRouter
from fastapi.responses import JSONResponse

# Define API class for pywebview JS API
class WebViewAPI:
    def select_folder(self) -> str | None:
        global window
        if window:
            dirs = window.create_file_dialog(webview.FOLDER_DIALOG)
            if dirs:
                return dirs[0]
        return None

# Add FastAPI endpoint for browser extension to trigger folder chooser
@app.post("/api/settings/browse-folder")
async def api_browse_folder():
    global window
    if window is None:
        return JSONResponse(status_code=400, content={"error": "GUI window is not active"})
    
    try:
        loop = asyncio.get_event_loop()
        # Run the blocking GUI file dialog in uvicorn's thread pool executor
        dirs = await loop.run_in_executor(None, window.create_file_dialog, webview.FOLDER_DIALOG)
        if dirs:
            return JSONResponse(content={"path": dirs[0]})
        return JSONResponse(content={"path": None})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

def auto_register_extension():
    """Automatically registers the browser extension in Windows Registry on startup."""
    import sys
    import json
    import base64
    import hashlib
    import winreg
    
    # Determine extension and key path
    if hasattr(sys, "frozen"):
        root_dir = os.path.dirname(sys.executable)
    else:
        root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        
    manifest_path = os.path.join(root_dir, "extension", "manifest.json")
    key_pem_path = os.path.join(root_dir, "key.pem")
    
    if not os.path.exists(manifest_path):
        print(f"⚡ [Extension Installer] manifest.json not found at {manifest_path}, skipping auto-registration.")
        return
        
    try:
        from Crypto.PublicKey import RSA
        
        # 1. Generate or load private key
        if not os.path.exists(key_pem_path):
            print("⚡ [Extension Installer] Generating RSA key for stable extension ID...")
            key = RSA.generate(2048)
            key_pem = key.export_key(format='PEM')
            with open(key_pem_path, "wb") as f:
                f.write(key_pem)
        else:
            with open(key_pem_path, "rb") as f:
                key_pem = f.read()
            key = RSA.import_key(key_pem)
            
        # 2. Get public key in DER format
        pub_der = key.publickey().export_key(format='DER')
        pub_b64 = base64.b64encode(pub_der).decode('utf-8')
        
        # 3. Calculate Extension ID
        sha = hashlib.sha256(pub_der).hexdigest()
        ext_id = "".join(chr(int(c, 16) + 97) for c in sha[:32])
        
        # 4. Update manifest.json with key
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        manifest["key"] = pub_b64
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
            
        # 5. Write to Windows Registry for Chrome, Edge, Brave
        ext_folder = os.path.join(root_dir, "extension")
        targets = [
            ("Google Chrome", "Software\\Google\\Chrome\\Extensions"),
            ("Microsoft Edge", "Software\\Microsoft\\Edge\\Extensions"),
            ("Brave Browser", "Software\\BraveSoftware\\Brave-Browser\\Extensions")
        ]
        
        for browser, reg_path in targets:
            try:
                reg_key = winreg.CreateKeyEx(
                    winreg.HKEY_CURRENT_USER,
                    f"{reg_path}\\{ext_id}",
                    0,
                    winreg.KEY_SET_VALUE
                )
                winreg.SetValueEx(reg_key, "path", 0, winreg.REG_SZ, ext_folder)
                winreg.SetValueEx(reg_key, "version", 0, winreg.REG_SZ, "1.0")
                winreg.CloseKey(reg_key)
                print(f"⚡ [Extension Installer] Registered in {browser} registry.")
            except Exception as e:
                print(f"⚡ [Extension Installer] Failed register in {browser}: {e}")
                
        print(f"⚡ [Extension Installer] Extension ID is: {ext_id}")
    except Exception as e:
        print(f"⚡ [Extension Installer] Error during auto-registration: {e}")

def start_gui():
    global window
    # 0. Automatically register browser extension on startup
    auto_register_extension()
    
    # Create the app instance
    app_instance = ThunderTrayApp()
    
    # 1. Start server thread
    app_instance.server_thread.start()
    
    # 2. Start tray icon in a background thread
    tray_thread = threading.Thread(target=app_instance.run_tray, daemon=True)
    tray_thread.start()
    
    # Wait a brief moment for the uvicorn server to bind
    time.sleep(0.5)
    
    # 3. Start PyWebView on main thread with js_api registered
    icon_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icon.ico")
    if not os.path.exists(icon_path):
        icon_path = os.path.join(sys._MEIPASS, "icon.ico") if hasattr(sys, "_MEIPASS") else "icon.ico"

    window = webview.create_window(
        title="Thunder ⚡ Universal Downloader",
        url=f"http://127.0.0.1:{settings.port}/dashboard/index.html",
        width=1024,
        height=768,
        resizable=True,
        min_size=(800, 600),
        js_api=WebViewAPI()
    )
    
    # Register close handler
    window.events.closing += on_closing
    
    print("Launching Thunder native desktop window...")
    webview.start()

if __name__ == "__main__":
    start_gui()
