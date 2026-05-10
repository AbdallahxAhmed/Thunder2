"""Binary resolution helpers for Thunder runtime tools."""

from __future__ import annotations

from dataclasses import dataclass
import os
import shutil
import sys
from typing import Iterable

from src.config import settings


@dataclass(frozen=True)
class BinaryStatus:
    """Status for a runtime binary."""

    name: str
    found: bool
    path: str | None
    searched: list[str]


def _candidate_names(name: str) -> list[str]:
    names = [name]
    if sys.platform.startswith("win") and not name.lower().endswith(".exe"):
        names.append(f"{name}.exe")
    return names


def _bin_dir_path(bin_dir: str | None = None) -> str:
    raw = bin_dir or settings.bin_dir
    return os.path.abspath(raw)


def resolve_binary(name: str, *, bin_dir: str | None = None) -> str | None:
    """Resolve a binary path from BIN_DIR first, then PATH."""
    resolved_bin_dir = _bin_dir_path(bin_dir)
    for candidate in _candidate_names(name):
        local_path = os.path.join(resolved_bin_dir, candidate)
        if os.path.isfile(local_path):
            return local_path
        path_hit = shutil.which(candidate)
        if path_hit:
            return path_hit
    return None


def binary_status(name: str, *, bin_dir: str | None = None) -> BinaryStatus:
    """Return a structured status for a binary lookup."""
    resolved_bin_dir = _bin_dir_path(bin_dir)
    searched: list[str] = []
    for candidate in _candidate_names(name):
        local_path = os.path.join(resolved_bin_dir, candidate)
        searched.append(local_path)
        if os.path.isfile(local_path):
            return BinaryStatus(name=name, found=True, path=local_path, searched=searched)
        path_hit = shutil.which(candidate)
        if path_hit:
            searched.append(path_hit)
            return BinaryStatus(name=name, found=True, path=path_hit, searched=searched)
    return BinaryStatus(name=name, found=False, path=None, searched=searched)


def required_binaries() -> Iterable[str]:
    """Return the list of required binaries for a full install."""
    return ("aria2c", "yt-dlp", "N_m3u8DL-RE", "ffmpeg", "ffprobe")


def binary_statuses(*, bin_dir: str | None = None) -> list[BinaryStatus]:
    """Return statuses for all required binaries."""
    return [binary_status(name, bin_dir=bin_dir) for name in required_binaries()]
