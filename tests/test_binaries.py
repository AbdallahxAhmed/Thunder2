"""Tests for binary resolution helpers."""

from __future__ import annotations

import os
import sys

from src.binaries import binary_status, resolve_binary


def _binary_filename(name: str) -> str:
    if sys.platform.startswith("win"):
        return f"{name}.exe"
    return name


def test_resolve_binary_prefers_bin_dir(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    binary = bin_dir / _binary_filename("ffmpeg")
    binary.write_text("stub")
    binary.chmod(0o755)

    resolved = resolve_binary("ffmpeg", bin_dir=str(bin_dir))
    assert resolved == os.path.abspath(str(binary))


def test_binary_status_includes_search_paths(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()

    status = binary_status("ffprobe", bin_dir=str(bin_dir))
    assert status.found is False
    assert os.path.abspath(str(bin_dir / _binary_filename("ffprobe"))) in status.searched
