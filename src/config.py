"""Application settings using pydantic BaseSettings.

Reads from environment variables with fallback to a .env file.
Sensitive values (aria2 RPC secret) should be set via env vars only.
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Central configuration for the Thunder daemon."""

    aria2_rpc_url: str = "http://localhost:6800/jsonrpc"
    aria2_rpc_secret: str = ""
    download_dir: str = "downloads"
    bin_dir: str = "bin"
    log_dir: str = "logs"
    log_level: str = "INFO"
    host: str = "0.0.0.0"
    port: int = 8000
    wvd_path: str = ""  # Path to Widevine Device (.wvd) file for CDM negotiation
    db_path: str = "data/thunder.db"  # SQLite database for Queue Manager persistence

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


# Singleton — import this instance throughout the application
settings = Settings()
