"""SQLite database layer for the Queue Manager.

Handles connection management (WAL mode), schema creation, seed data,
and provides an async context manager for database access.

Tables: jobs, groups, settings (see data-model.md for full schema).
"""

import os
import sqlite3
import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator, Any

from src.config import settings

# ─── Schema ──────────────────────────────────────────────────────────────────

SCHEMA_SQL = """
-- Jobs table: central persistence for all download jobs
CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    url         TEXT    NOT NULL,
    engine      TEXT    NOT NULL CHECK (engine IN ('aria2', 'ytdlp', 'm3u8')),
    status      TEXT    NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'downloading', 'completed', 'failed', 'paused', 'cancelled')),
    progress    REAL,
    speed       TEXT,
    eta         INTEGER,
    output_path TEXT,
    file_size   INTEGER,
    error       TEXT,
    group_id    TEXT    REFERENCES groups(id) ON DELETE SET NULL,
    format_id   TEXT,
    title       TEXT,
    cookies     TEXT,
    user_agent  TEXT,
    referer     TEXT,
    page_url    TEXT,
    drm_keys    TEXT,
    pssh        TEXT,
    license_url TEXT,
    priority    INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Groups table: container for related downloads (playlists, courses)
CREATE TABLE IF NOT EXISTS groups (
    id          TEXT PRIMARY KEY,
    name        TEXT    NOT NULL,
    source_url  TEXT,
    status      TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Settings table: runtime-configurable key-value store
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
"""

INDEX_SQL = """
-- Scheduler query: find QUEUED jobs ordered by priority then creation time
CREATE INDEX IF NOT EXISTS idx_jobs_status_priority
    ON jobs (status, priority DESC, created_at ASC);

-- Engine slot counting: count DOWNLOADING jobs per engine
CREATE INDEX IF NOT EXISTS idx_jobs_engine_status
    ON jobs (engine, status);

-- Group membership lookup
CREATE INDEX IF NOT EXISTS idx_jobs_group_id
    ON jobs (group_id);

-- History queries: filter by status, paginate by created_at
CREATE INDEX IF NOT EXISTS idx_jobs_created_at
    ON jobs (created_at DESC);
"""

SEED_SQL = """
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('global_max_concurrent', '8'),
    ('engine_limit_aria2',    '4'),
    ('engine_limit_ytdlp',   '3'),
    ('engine_limit_m3u8',    '2'),
    ('download_dir',         '"downloads"');
"""


# ─── Connection Management ───────────────────────────────────────────────────

class AsyncCursor:
    """Async wrapper for sqlite3.Cursor."""
    def __init__(self, cursor: sqlite3.Cursor):
        self._cursor = cursor

    async def fetchone(self) -> Any:
        return await asyncio.to_thread(self._cursor.fetchone)

    async def fetchall(self) -> list[Any]:
        return await asyncio.to_thread(self._cursor.fetchall)

class AsyncConnection:
    """Async wrapper for sqlite3.Connection."""
    def __init__(self, conn: sqlite3.Connection):
        self._conn = conn

    @property
    def row_factory(self) -> Any:
        return self._conn.row_factory

    @row_factory.setter
    def row_factory(self, factory: Any) -> None:
        self._conn.row_factory = factory

    async def execute(self, sql: str, parameters: tuple = ()) -> AsyncCursor:
        cursor = await asyncio.to_thread(self._conn.execute, sql, parameters)
        return AsyncCursor(cursor)

    async def executescript(self, sql_script: str) -> None:
        await asyncio.to_thread(self._conn.executescript, sql_script)

    async def commit(self) -> None:
        await asyncio.to_thread(self._conn.commit)

    async def close(self) -> None:
        await asyncio.to_thread(self._conn.close)

@asynccontextmanager
async def get_db(db_path: str | None = None) -> AsyncIterator[AsyncConnection]:
    """Async context manager for SQLite connections.

    Enables WAL mode and foreign keys on every connection.
    Uses the configured db_path by default.
    """
    path = db_path or settings.db_path
    
    def _connect():
        # check_same_thread=False is needed since we run queries in different threads via asyncio.to_thread
        return sqlite3.connect(path, check_same_thread=False)

    conn = await asyncio.to_thread(_connect)
    db = AsyncConnection(conn)
    try:
        await db.execute("PRAGMA journal_mode=WAL;")
        await db.execute("PRAGMA foreign_keys=ON;")
        db.row_factory = sqlite3.Row
        yield db
    finally:
        await db.close()


async def init_db(db_path: str | None = None) -> None:
    """Create all tables, indexes, and seed data.

    Safe to call multiple times (uses IF NOT EXISTS / INSERT OR IGNORE).
    Creates the parent directory for the database file if it doesn't exist.
    """
    path = db_path or settings.db_path
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)

    async with get_db(path) as db:
        # Create tables (groups first, since jobs references it)
        await db.executescript(SCHEMA_SQL)
        # Create indexes
        await db.executescript(INDEX_SQL)
        # Seed default settings
        await db.executescript(SEED_SQL)
        await db.commit()
