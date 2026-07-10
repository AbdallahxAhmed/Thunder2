"""Application settings using pydantic BaseSettings.

Reads from environment variables with fallback to a .env file.
Sensitive values (aria2 RPC secret) should be set via env vars only.
"""

import os
from pydantic_settings import BaseSettings

# Dynamically prepend the project's bin directory to the system PATH
_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_bin_dir = os.path.join(_project_root, "bin")
if os.path.exists(_bin_dir) and _bin_dir not in os.environ.get("PATH", ""):
    os.environ["PATH"] = _bin_dir + os.pathsep + os.environ.get("PATH", "")


class Settings(BaseSettings):
    """Central configuration for the UHDD daemon."""

    aria2_rpc_url: str = "http://localhost:6800/jsonrpc"
    aria2_rpc_secret: str = ""
    download_dir: str = "downloads"
    log_dir: str = "logs"
    log_level: str = "INFO"
    host: str = "0.0.0.0"
    port: int = 8000
    wvd_path: str = ""  # Path to Widevine Device (.wvd) file for CDM negotiation
    db_path: str = "data/thunder.db"

    # Course downloader settings
    course_data_dir: str = "data"  # Auth/cookie files storage
    schedule_min_wait: int = 2     # Minutes between scheduled downloads
    schedule_max_wait: int = 8
    schedule_start_hour: int = 8
    schedule_end_hour: int = 23
    schedule_max_daily: int = 25

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


# Singleton — import this instance throughout the application
settings = Settings()

