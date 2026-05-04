"""Tests for src/db.py — SQLite schema, WAL mode, indexes, and seed data."""

from __future__ import annotations

import os
import tempfile

import pytest
import pytest_asyncio
import sqlite3

from src.db import get_db, init_db


@pytest.fixture
def tmp_db_path(tmp_path):
    """Provide a temporary SQLite database path."""
    return str(tmp_path / "test_thunder.db")


class TestInitDb:
    """Test database initialization (schema, indexes, seed data)."""

    @pytest.mark.asyncio
    async def test_creates_database_file(self, tmp_db_path):
        """init_db creates the database file and parent directories."""
        assert not os.path.exists(tmp_db_path)
        await init_db(tmp_db_path)
        assert os.path.exists(tmp_db_path)

    @pytest.mark.asyncio
    async def test_creates_parent_directory(self, tmp_path):
        """init_db creates parent directories if they don't exist."""
        nested_path = str(tmp_path / "nested" / "dir" / "thunder.db")
        await init_db(nested_path)
        assert os.path.exists(nested_path)

    @pytest.mark.asyncio
    async def test_idempotent(self, tmp_db_path):
        """init_db can be called multiple times without error."""
        await init_db(tmp_db_path)
        await init_db(tmp_db_path)  # Should not raise

    @pytest.mark.asyncio
    async def test_wal_mode_enabled(self, tmp_db_path):
        """Database uses WAL journal mode."""
        await init_db(tmp_db_path)
        async with get_db(tmp_db_path) as db:
            cursor = await db.execute("PRAGMA journal_mode;")
            row = await cursor.fetchone()
            assert row[0] == "wal"

    @pytest.mark.asyncio
    async def test_foreign_keys_enabled(self, tmp_db_path):
        """Foreign keys are enforced."""
        await init_db(tmp_db_path)
        async with get_db(tmp_db_path) as db:
            cursor = await db.execute("PRAGMA foreign_keys;")
            row = await cursor.fetchone()
            assert row[0] == 1


class TestJobsTable:
    """Test the jobs table schema."""

    @pytest.mark.asyncio
    async def test_jobs_table_exists(self, tmp_db_path):
        """jobs table is created by init_db."""
        await init_db(tmp_db_path)
        async with get_db(tmp_db_path) as db:
            cursor = await db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='jobs';"
            )
            row = await cursor.fetchone()
            assert row is not None
            assert row[0] == "jobs"

    @pytest.mark.asyncio
    async def test_jobs_table_columns(self, tmp_db_path):
        """jobs table has all expected columns."""
        expected_columns = {
            "id", "url", "engine", "status", "progress", "speed", "eta",
            "output_path", "file_size", "error", "group_id", "format_id",
            "title", "cookies", "user_agent", "referer", "page_url",
            "drm_keys", "pssh", "license_url", "priority", "retry_count",
            "created_at", "updated_at",
        }
        await init_db(tmp_db_path)
        async with get_db(tmp_db_path) as db:
            cursor = await db.execute("PRAGMA table_info(jobs);")
            rows = await cursor.fetchall()
            actual_columns = {row[1] for row in rows}
            assert actual_columns == expected_columns

    @pytest.mark.asyncio
    async def test_jobs_engine_check_constraint(self, tmp_db_path):
        """jobs table rejects invalid engine values."""
        await init_db(tmp_db_path)
        async with get_db(tmp_db_path) as db:
            with pytest.raises(sqlite3.IntegrityError):
                await db.execute(
                    "INSERT INTO jobs (id, url, engine) VALUES (?, ?, ?)",
                    ("test-id", "https://example.com", "invalid_engine"),
                )
                await db.commit()

    @pytest.mark.asyncio
    async def test_jobs_status_check_constraint(self, tmp_db_path):
        """jobs table rejects invalid status values."""
        await init_db(tmp_db_path)
        async with get_db(tmp_db_path) as db:
            with pytest.raises(sqlite3.IntegrityError):
                await db.execute(
                    "INSERT INTO jobs (id, url, engine, status) VALUES (?, ?, ?, ?)",
                    ("test-id", "https://example.com", "aria2", "invalid_status"),
                )
                await db.commit()

    @pytest.mark.asyncio
    async def test_jobs_default_values(self, tmp_db_path):
        """jobs table applies correct defaults for status, priority, retry_count."""
        await init_db(tmp_db_path)
        async with get_db(tmp_db_path) as db:
            await db.execute(
                "INSERT INTO jobs (id, url, engine) VALUES (?, ?, ?)",
                ("test-id", "https://example.com", "aria2"),
            )
            await db.commit()
            cursor = await db.execute("SELECT status, priority, retry_count FROM jobs WHERE id = ?", ("test-id",))
            row = await cursor.fetchone()
            assert row[0] == "queued"
            assert row[1] == 0
            assert row[2] == 0

    @pytest.mark.asyncio
    async def test_jobs_timestamps_auto_populated(self, tmp_db_path):
        """created_at and updated_at are auto-populated on insert."""
        await init_db(tmp_db_path)
        async with get_db(tmp_db_path) as db:
            await db.execute(
                "INSERT INTO jobs (id, url, engine) VALUES (?, ?, ?)",
                ("test-id", "https://example.com", "ytdlp"),
            )
            await db.commit()
            cursor = await db.execute("SELECT created_at, updated_at FROM jobs WHERE id = ?", ("test-id",))
            row = await cursor.fetchone()
            assert row[0] is not None
            assert row[1] is not None
            assert "T" in row[0]  # ISO 8601 format


class TestGroupsTable:
    """Test the groups table schema."""

    @pytest.mark.asyncio
    async def test_groups_table_exists(self, tmp_db_path):
        """groups table is created by init_db."""
        await init_db(tmp_db_path)
        async with get_db(tmp_db_path) as db:
            cursor = await db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='groups';"
            )
            row = await cursor.fetchone()
            assert row is not None

    @pytest.mark.asyncio
    async def test_groups_table_columns(self, tmp_db_path):
        """groups table has all expected columns."""
        expected_columns = {"id", "name", "source_url", "status", "created_at", "updated_at"}
        await init_db(tmp_db_path)
        async with get_db(tmp_db_path) as db:
            cursor = await db.execute("PRAGMA table_info(groups);")
            rows = await cursor.fetchall()
            actual_columns = {row[1] for row in rows}
            assert actual_columns == expected_columns

    @pytest.mark.asyncio
    async def test_groups_status_check_constraint(self, tmp_db_path):
        """groups table rejects invalid status values."""
        await init_db(tmp_db_path)
        async with get_db(tmp_db_path) as db:
            with pytest.raises(sqlite3.IntegrityError):
                await db.execute(
                    "INSERT INTO groups (id, name, status) VALUES (?, ?, ?)",
                    ("test-group", "Test", "invalid"),
                )
                await db.commit()

    @pytest.mark.asyncio
    async def test_jobs_group_fk_on_delete_set_null(self, tmp_db_path):
        """Deleting a group sets group_id to NULL on child jobs."""
        await init_db(tmp_db_path)
        async with get_db(tmp_db_path) as db:
            # Create group
            await db.execute(
                "INSERT INTO groups (id, name) VALUES (?, ?)",
                ("g1", "Test Group"),
            )
            # Create job referencing group
            await db.execute(
                "INSERT INTO jobs (id, url, engine, group_id) VALUES (?, ?, ?, ?)",
                ("j1", "https://example.com", "aria2", "g1"),
            )
            await db.commit()

            # Delete group
            await db.execute("DELETE FROM groups WHERE id = ?", ("g1",))
            await db.commit()

            # Job should still exist with group_id = NULL
            cursor = await db.execute("SELECT group_id FROM jobs WHERE id = ?", ("j1",))
            row = await cursor.fetchone()
            assert row[0] is None


class TestSettingsTable:
    """Test the settings table and seed data."""

    @pytest.mark.asyncio
    async def test_settings_table_exists(self, tmp_db_path):
        """settings table is created by init_db."""
        await init_db(tmp_db_path)
        async with get_db(tmp_db_path) as db:
            cursor = await db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='settings';"
            )
            row = await cursor.fetchone()
            assert row is not None

    @pytest.mark.asyncio
    async def test_seed_data_inserted(self, tmp_db_path):
        """Default settings are seeded on init."""
        await init_db(tmp_db_path)
        async with get_db(tmp_db_path) as db:
            cursor = await db.execute("SELECT key, value FROM settings ORDER BY key;")
            rows = await cursor.fetchall()
            seed = {row[0]: row[1] for row in rows}

            assert seed["global_max_concurrent"] == "8"
            assert seed["engine_limit_aria2"] == "4"
            assert seed["engine_limit_ytdlp"] == "3"
            assert seed["engine_limit_m3u8"] == "2"
            assert seed["download_dir"] == '"downloads"'

    @pytest.mark.asyncio
    async def test_seed_data_not_overwritten(self, tmp_db_path):
        """Re-running init_db does NOT overwrite existing settings."""
        await init_db(tmp_db_path)

        # Manually update a setting
        async with get_db(tmp_db_path) as db:
            await db.execute(
                "UPDATE settings SET value = ? WHERE key = ?",
                ("12", "global_max_concurrent"),
            )
            await db.commit()

        # Re-init should NOT overwrite
        await init_db(tmp_db_path)

        async with get_db(tmp_db_path) as db:
            cursor = await db.execute(
                "SELECT value FROM settings WHERE key = ?",
                ("global_max_concurrent",),
            )
            row = await cursor.fetchone()
            assert row[0] == "12"  # Should keep user's value, not reset to 8


class TestIndexes:
    """Test that all indexes are created."""

    @pytest.mark.asyncio
    async def test_all_indexes_created(self, tmp_db_path):
        """All 4 indexes from data-model.md are created."""
        expected_indexes = {
            "idx_jobs_status_priority",
            "idx_jobs_engine_status",
            "idx_jobs_group_id",
            "idx_jobs_created_at",
        }
        await init_db(tmp_db_path)
        async with get_db(tmp_db_path) as db:
            cursor = await db.execute(
                "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%';"
            )
            rows = await cursor.fetchall()
            actual_indexes = {row[0] for row in rows}
            assert expected_indexes.issubset(actual_indexes)


class TestGetDb:
    """Test the get_db context manager."""

    @pytest.mark.asyncio
    async def test_connection_is_usable(self, tmp_db_path):
        """get_db returns a usable connection."""
        await init_db(tmp_db_path)
        async with get_db(tmp_db_path) as db:
            cursor = await db.execute("SELECT 1;")
            row = await cursor.fetchone()
            assert row[0] == 1

    @pytest.mark.asyncio
    async def test_connection_closed_after_context(self, tmp_db_path):
        """Connection is closed when context manager exits."""
        await init_db(tmp_db_path)
        async with get_db(tmp_db_path) as db:
            pass
        # Attempting to use after close should fail
        with pytest.raises(Exception):
            await db.execute("SELECT 1;")

    @pytest.mark.asyncio
    async def test_row_factory_set(self, tmp_db_path):
        """Row factory is set to aiosqlite.Row for dict-like access."""
        await init_db(tmp_db_path)
        async with get_db(tmp_db_path) as db:
            assert db.row_factory == sqlite3.Row
