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
    PAUSED = "paused"
    CANCELLED = "cancelled"


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

_KID_KEY_RE = re.compile(r"^[a-fA-F0-9]+:[a-fA-F0-9]+$")


class DownloadRequest(BaseModel):
    """Incoming download submission from the browser extension."""

    url: str = Field(..., min_length=1, description="Download URL")
    cookies: Optional[Any] = Field(
        default=None,
        description="Browser cookies — either a raw header string or array of Chrome cookie objects",
    )
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
    license_headers: dict[str, Any] = Field(
        default_factory=dict, description="HTTP headers for the license server request"
    )
    drm_hint: Optional[bool] = Field(
        default=None,
        description="Hint that a DRM manifest/license was detected (routes to m3u8)",
    )
    title: Optional[str] = Field(
        default=None, description="Page title for human-readable filenames"
    )
    page_url: Optional[str] = Field(
        default=None, description="Original browser page URL for Origin/Referer spoofing"
    )
    referer: Optional[str] = Field(
        default=None, description="HTTP Referer header for the download"
    )
    engine: Optional[str] = Field(
        default=None, description="Explicit engine override"
    )
    download_dir: Optional[str] = Field(
        default=None, description="Custom download directory override for this specific job"
    )
    format_id: Optional[str] = Field(
        default=None, description="yt-dlp format ID for quality selection (e.g., '137+140')"
    )
    auto_download: bool = Field(
        default=True, description="Start downloading immediately"
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
        
        # SSRF checks
        from src.config import settings
        from urllib.parse import urlparse
        import ipaddress
        
        try:
            parsed = urlparse(v)
            hostname = parsed.hostname
            if hostname and not settings.allow_local_downloads:
                clean_host = hostname.strip("[]")
                is_ip = False
                try:
                    ip = ipaddress.ip_address(clean_host)
                    is_ip = True
                    if ip.is_private or ip.is_loopback or ip.is_multicast or ip.is_reserved or ip.is_link_local:
                        raise ValueError("Downloads from private or local network addresses are disabled for security.")
                except ValueError as ip_err:
                    if "disabled for security" in str(ip_err):
                        raise
                
                if not is_ip:
                    hostname_lower = hostname.lower()
                    if hostname_lower in ("localhost", "localhost.localdomain") or hostname_lower.endswith(".local") or hostname_lower.endswith(".internal"):
                        raise ValueError("Downloads from local hostnames are disabled for security.")
        except Exception as e:
            if isinstance(e, ValueError):
                raise
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
            valid = {"aria2", "ytdlp", "m3u8", "yanfaa", "course_har", "course_m3u8"}
            if v not in valid:
                raise ValueError(f"engine must be one of: {', '.join(sorted(valid))}")
        return v


# ---------------------------------------------------------------------------
# Internal job/group models
# ---------------------------------------------------------------------------

class DownloadJob(BaseModel):
    """Tracks an active or completed download."""

    id: str
    url: str
    engine: str
    status: DownloadStatus = DownloadStatus.QUEUED
    progress: Optional[float] = None
    speed: Optional[str] = None
    eta: Optional[int] = None
    output_path: Optional[str] = None
    file_size: Optional[int] = None
    error: Optional[str] = None
    group_id: Optional[str] = None
    format_id: Optional[str] = None
    title: Optional[str] = None
    cookies: Optional[str] = None
    user_agent: Optional[str] = None
    referer: Optional[str] = None
    page_url: Optional[str] = None
    drm_keys: Optional[str] = None
    pssh: Optional[str] = None
    license_url: Optional[str] = None
    priority: int = 0
    retry_count: int = 0
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
    aria2_gid: Optional[str] = None
    request_payload: Optional[DownloadRequest] = None


class DownloadGroup(BaseModel):
    """Tracks a group of download jobs (e.g., a playlist)."""
    id: str
    name: str
    source_url: Optional[str] = None
    status: str = "active"
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )


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
    vcodec: Optional[str] = Field(default=None, description="Video codec prefix")
    acodec: Optional[str] = Field(default=None, description="Audio codec prefix")
    ext: Optional[str] = Field(default=None, description="File extension (e.g. 'MP4')")
    filesize: Optional[int] = Field(default=None, description="Approx file size in bytes")
    resolution: Optional[str] = Field(default=None, description="Resolution string (e.g. '1920x1080')")
    fps: Optional[int] = Field(default=None, description="Video frames per second")
    size_mb: Optional[float] = Field(default=None, description="Calculated file size in Megabytes")
    engine: Optional[str] = Field(default=None, description="Explicit engine override (e.g. 'm3u8')")


class InfoRequest(BaseModel):
    """Incoming request for media format extraction."""
    url: str = Field(..., min_length=1)
    drm_hint: bool = Field(default=False)
    cookies: Optional[Any] = Field(default=None)
    user_agent: Optional[str] = Field(default=None)


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


# ---------------------------------------------------------------------------
# Queue Management API models
# ---------------------------------------------------------------------------

class JobActionResponse(BaseModel):
    """Response for job action endpoints (pause, resume, cancel, retry, delete)."""

    id: str
    action: str
    status: str
    message: str = ""


class JobListItem(BaseModel):
    """Single item in the paginated job list."""

    id: str
    url: str
    engine: str
    status: str
    progress: Optional[float] = None
    speed: Optional[str] = None
    eta: Optional[int] = None
    output_path: Optional[str] = None
    file_size: Optional[int] = None
    error: Optional[str] = None
    group_id: Optional[str] = None
    title: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class JobListResponse(BaseModel):
    """Paginated response for GET /api/jobs."""

    jobs: list[JobListItem]
    total: int
    limit: int
    offset: int


class GroupCreateRequest(BaseModel):
    """Request body for POST /api/groups."""

    name: str = Field(..., min_length=1)
    source_url: Optional[str] = None
    urls: list[str] = Field(default_factory=list, description="URLs to add as jobs")
    engine: Optional[str] = Field(default=None, description="Engine override for all jobs")


class GroupListItem(BaseModel):
    """Summary of a group for listing."""

    id: str
    name: str
    source_url: Optional[str] = None
    status: str
    total_jobs: int = 0
    completed_jobs: int = 0
    failed_jobs: int = 0
    created_at: datetime
    updated_at: datetime


class GroupListResponse(BaseModel):
    """Paginated response for GET /api/groups."""

    groups: list[GroupListItem]
    total: int


class GroupDetailResponse(BaseModel):
    """Detailed group response with job list."""

    id: str
    name: str
    source_url: Optional[str] = None
    status: str
    jobs: list[JobListItem] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class SettingsResponse(BaseModel):
    """Response for GET /api/settings."""

    settings: dict[str, str]


class SettingsUpdateRequest(BaseModel):
    """Request body for PUT /api/settings."""

    settings: dict[str, str] = Field(
        ..., description="Key-value pairs to update"
    )


# ---------------------------------------------------------------------------
# Course downloader models
# ---------------------------------------------------------------------------


class ScheduleConfig(BaseModel):
    """Human-like download scheduling parameters."""

    min_wait_minutes: int = Field(default=2, ge=1, le=60)
    max_wait_minutes: int = Field(default=8, ge=1, le=120)
    start_hour: int = Field(default=8, ge=0, le=23)
    end_hour: int = Field(default=23, ge=0, le=23)
    max_videos_per_day: int = Field(default=25, ge=1, le=200)
    long_break_probability: float = Field(default=0.1, ge=0.0, le=1.0)
    long_break_min: int = Field(default=15, ge=1)
    long_break_max: int = Field(default=30, ge=1)


class CourseHARRequest(BaseModel):
    """Request to extract/download from a HAR file."""

    har_path: str = Field(..., min_length=1, description="Path to HAR file")
    course_name: Optional[str] = Field(default=None, description="Course folder name")
    download_path: Optional[str] = Field(default=None, description="Override download directory")
    auto_download: bool = Field(default=False, description="Start downloading immediately")
    use_scheduler: bool = Field(default=False, description="Use human-like delays")
    schedule: Optional[ScheduleConfig] = None
    video_indices: Optional[list[int]] = Field(default=None, description="Indices of videos to download")
    download_dirs: Optional[dict[str, str]] = Field(default=None, description="Mapping of video index to custom download directory")


class CourseHARResponse(BaseModel):
    """Response from HAR extraction."""

    urls: list[str]
    names: list[str]
    missing_lessons: list[int]
    total_found: int
    job_ids: list[str] = Field(default_factory=list)


class YanfaaCourseRequest(BaseModel):
    """Request to fetch/download a Yanfaa course."""

    course_slug: str = Field(..., min_length=1, description="Yanfaa course slug")
    video_indices: Optional[list[int]] = Field(
        default=None, description="Indices of videos to download (None = all)"
    )
    download_path: Optional[str] = None
    download_dirs: Optional[dict[str, str]] = Field(default=None, description="Mapping of video index to custom download directory")
    auto_download: bool = Field(default=True, description="Start downloading immediately")


class YanfaaVideoInfo(BaseModel):
    """Single video entry in a Yanfaa course."""

    index: int
    brightcove_id: str
    title: str
    duration: Optional[float] = None
    duration_human: Optional[str] = None
    chapter: Optional[str] = None


class YanfaaCourseResponse(BaseModel):
    """Response from Yanfaa course info fetch."""

    title: str
    slug: str
    videos: list[YanfaaVideoInfo]
    total_videos: int


class BatchM3U8Request(BaseModel):
    """Request to batch-download M3U8 URLs."""

    urls: list[str] = Field(..., min_length=1)
    names: Optional[list[str]] = None
    download_path: Optional[str] = None
    referer: Optional[str] = None
    origin: Optional[str] = None
    use_scheduler: bool = False
    schedule: Optional[ScheduleConfig] = None
    auto_download: bool = Field(default=True, description="Start downloading immediately")


class BatchM3U8Response(BaseModel):
    """Response from batch M3U8 download submission."""

    job_ids: list[str]
    total: int


class AuthExtractRequest(BaseModel):
    """Request to launch browser-based auth extraction."""

    url: str = Field(..., min_length=1, description="Login page URL")
    platform: str = Field(default="cloudnative", description="Platform identifier")


class AuthSession(BaseModel):
    """Info about a saved auth session."""

    platform: str
    file: str
    cookies_count: int
    has_token: bool
