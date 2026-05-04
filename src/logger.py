"""Structured JSON logging with correlation ID injection and secret redaction."""

import logging
import json
import re
from datetime import datetime, timezone
from contextvars import ContextVar

# Context variable for per-request/per-job correlation ID
correlation_id: ContextVar[str] = ContextVar("correlation_id", default="-")

# Patterns to redact in log output
_REDACT_PATTERNS = [
    re.compile(r"(token:)\S+", re.IGNORECASE),
    re.compile(r"(rpc.secret[\"':\s=]+)\S+", re.IGNORECASE),
    re.compile(r"(--key\s+)\S+", re.IGNORECASE),
    re.compile(r"(['\"]?drm_keys['\"]?\s*[:=]\s*['\"]?)[a-fA-F0-9:]+", re.IGNORECASE),
]


def _redact(message: str) -> str:
    """Replace sensitive values in a log message with [REDACTED]."""
    for pattern in _REDACT_PATTERNS:
        message = pattern.sub(r"\1[REDACTED]", message)
    return message


class JSONFormatter(logging.Formatter):
    """Formats log records as single-line JSON objects."""

    def format(self, record: logging.LogRecord) -> str:
        log_entry = {
            "timestamp": datetime.fromtimestamp(
                record.created, tz=timezone.utc
            ).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": _redact(record.getMessage()),
            "correlation_id": correlation_id.get(),
        }
        if record.exc_info and record.exc_info[0] is not None:
            log_entry["exception"] = self.formatException(record.exc_info)
        # Merge any extra fields set via `extra={...}`
        for key in ("download_id", "engine", "event"):
            value = getattr(record, key, None)
            if value is not None:
                log_entry[key] = value
        return json.dumps(log_entry, default=str)


class RedactionFilter(logging.Filter):
    """Applies redaction to all log records."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = _redact(record.msg)
        return True


def setup_logging(log_dir: str = "logs", log_level: str = "INFO") -> None:
    """Configure the root logger with JSON output to file and stderr."""
    import os

    os.makedirs(log_dir, exist_ok=True)

    root = logging.getLogger()
    root.setLevel(getattr(logging, log_level.upper(), logging.INFO))

    # Clear existing handlers to avoid duplicates on re-init
    root.handlers.clear()

    formatter = JSONFormatter()
    redaction_filter = RedactionFilter()

    # File handler — structured JSON logs
    file_handler = logging.FileHandler(
        os.path.join(log_dir, "thunder.log"), encoding="utf-8"
    )
    file_handler.setFormatter(formatter)
    file_handler.addFilter(redaction_filter)
    root.addHandler(file_handler)

    # Stderr handler — same JSON format for container/systemd environments
    stderr_handler = logging.StreamHandler()
    stderr_handler.setFormatter(formatter)
    stderr_handler.addFilter(redaction_filter)
    root.addHandler(stderr_handler)
