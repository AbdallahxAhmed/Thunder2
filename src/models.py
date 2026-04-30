"""Pydantic models for API request/response payloads and internal state."""

from __future__ import annotations

import enum
import re
from datetime import datetime, timezone
from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator

# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class DownloadStatus(str, enum.Enum):
    """State machine: queued → downloading → completed | failed."""

    QUEUED = "queued"
    DOWNLOADING = "downloading"
    COMPLETED = "completed"
    FAILED = "failed"


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

_KID_KEY_RE = re.compile(r"^[a-fA-F0-9]+:[a-fA-F0-9]+$")


class DownloadRequest(BaseModel):
    """Incoming download submission from the browser extension."""

    url: str = Field(..., min_length=1, description="Download URL")
    cookies: Optional[str] = Field(default=None, description="Raw cookie header")
    user_agent: Optional[str] = Field(default=None, description="Custom User-Agent")
    drm_keys: Optional[str] = Field(
        default=None, description="KID:KEY hex pair(s) for DRM decryption (comma-separated for multiple)"
    )
    pssh: Optional[str] = Field(
        default=None, description="Base64-encoded PSSH for Widevine CDM negotiation"
    )
    license_url: Optional[str] = Field(
        default=None, description="License server URL for Widevine CDM negotiation"
    )
    license_headers: Optional[dict[str, Any]] = Field(
        default=None, description="HTTP headers for the license server request"
    )
    drm_hint: Optional[bool] = Field(
        default=None,
        description="Hint that a DRM manifest/license was detected (routes to m3u8)",
    )
    title: Optional[str] = Field(
        default=None, description="Page title for human-readable filenames"
    )
    referer: Optional[str] = Field(
        default=None, description="HTTP Referer header for the download"
    )
    engine: Optional[str] = Field(
        default=None, description="Explicit engine override (aria2, ytdlp, m3u8)"
    )
    format_id: Optional[str] = Field(
        default=None, description="yt-dlp format ID for quality selection (e.g., '137+140')"
    )

    @field_validator("url")
    @classmethod
    def validate_url(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("URL must not be empty")
        # Accept http, https, ftp, and magnet schemes
        if not re.match(r"^(https?|ftp|magnet):", v, re.IGNORECASE):
            raise ValueError(
                "URL must start with http://, https://, ftp://, or magnet:"
            )
        return v

    @field_validator("drm_keys")
    @classmethod
    def validate_drm_keys(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            # Support comma-separated multi-key format: KID1:KEY1,KID2:KEY2
            for pair in v.split(","):
                pair = pair.strip()
                if pair and not _KID_KEY_RE.match(pair):
                    raise ValueError(
                        "drm_keys must be formatted as KID:KEY "
                        "(hexadecimal strings separated by a colon). "
                        "Multiple pairs separated by commas."
                    )
        return v

    @field_validator("engine")
    @classmethod
    def validate_engine(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            valid = {"aria2", "ytdlp", "m3u8"}
            if v not in valid:
                raise ValueError(f"engine must be one of: {', '.join(sorted(valid))}")
        return v


# ---------------------------------------------------------------------------
# Internal job model
# ---------------------------------------------------------------------------

class DownloadJob(BaseModel):
    """Tracks an active or completed download."""

    id: str
    url: str
    engine: str
    status: DownloadStatus = DownloadStatus.QUEUED
    progress: Optional[float] = None
    speed: Optional[str] = None
    output_path: Optional[str] = None
    file_size: Optional[int] = None
    error: Optional[str] = None
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
    aria2_gid: Optional[str] = None


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class DownloadResponse(BaseModel):
    """Response returned when a download is accepted."""

    id: str
    status: str
    engine: str
    message: str = "Download request accepted"


class StatusResponse(BaseModel):
    """Response for GET /api/download/{id}."""

    id: str
    url: str
    engine: str
    status: str
    progress: Optional[float] = None
    speed: Optional[str] = None
    output_path: Optional[str] = None
    file_size: Optional[int] = None
    error: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class ErrorDetail(BaseModel):
    """Single field-level validation error."""

    field: str
    message: str


class ErrorResponse(BaseModel):
    """Standardised error response body."""

    error_code: str
    message: str
    details: list[ErrorDetail] = Field(default_factory=list)


class EngineHealth(BaseModel):
    """Health status for a single engine."""

    name: str
    available: bool
    version: Optional[str] = None
    error: Optional[str] = None


class HealthResponse(BaseModel):
    """Response for GET /api/health."""

    status: str  # "healthy" or "degraded"
    uptime_seconds: float
    engines: list[EngineHealth]


class QualityOption(BaseModel):
    """A simplified, opinionated quality tier for the popup picker."""

    label: str = Field(..., description="Human-readable label (e.g. '1080p')")
    format_id: str = Field(..., description="yt-dlp format selection string")
    type: str = Field(..., description="'video' or 'audio'")
    badge: Optional[str] = Field(
        default=None, description="Optional badge text (e.g. 'HD', '4K', 'HQ')"
    )


class InfoResponse(BaseModel):
    """Response for GET /api/info."""

    url: str
    status: Optional[str] = Field(
        default=None, description="Optional status (e.g. 'ok', 'unsupported')"
    )
    suggested_engine: Optional[str] = Field(
        default=None, description="Engine hint when yt-dlp is unsupported"
    )
    reason: Optional[str] = Field(default=None, description="Optional status details")
    title: Optional[str] = None
    thumbnail: Optional[str] = None
    duration: Optional[float] = None
    max_height: Optional[int] = None
    options: list[QualityOption] = Field(default_factory=list)
