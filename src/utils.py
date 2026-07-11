import os
import re
from pathlib import Path

# Windows reserved filenames (case-insensitive, with or without extensions)
_WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
}

def sanitize_filename(filename: str) -> str:
    """Sanitize a filename by removing path traversal components, 
    illegal characters, and Windows reserved names.
    """
    if not filename:
        return "downloaded_file"

    # Remove control characters and strip whitespace
    filename = "".join(ch for ch in filename if ch.isprintable()).strip()

    # Replace dot-dot traversal sequences
    filename = filename.replace("..", "_")

    # Replace directory separators and common illegal chars with underscore
    filename = re.sub(r'[<>:"/\\|?*]', '_', filename)

    # Replace multiple underscores with a single one
    filename = re.sub(r'_{2,}', '_', filename)

    # Strip leading/trailing dots and spaces
    filename = filename.strip(". ")

    # Check for Windows reserved names
    base_name = os.path.splitext(filename)[0].upper()
    if base_name in _WINDOWS_RESERVED_NAMES:
        filename = f"safe_{filename}"

    # Truncate length to prevent OS filename length limit issues (max 200 chars)
    if len(filename) > 200:
        ext = os.path.splitext(filename)[1]
        filename = filename[:200 - len(ext)] + ext

    return filename or "downloaded_file"

def safe_resolve_path(base_dir: str, sub_path: str) -> str:
    """Resolve a directory or file path within a trusted base directory, 
    guaranteeing that it cannot traverse outside of the base directory.
    """
    base_path = Path(os.path.abspath(base_dir)).resolve()
    target_path = Path(os.path.abspath(os.path.join(base_dir, sub_path))).resolve()

    try:
        # Check if target_path is relative to base_path
        target_path.relative_to(base_path)
    except ValueError:
        # If not, prevent traversal and resolve to base_path directly
        return str(base_path)

    return str(target_path)
