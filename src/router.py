"""Deterministic URL classification and engine routing.

Routing rules (evaluated in priority order):
  1. ``drm_keys`` present           → ``m3u8``  (N_m3u8DL-RE)
  2. URL ends with ``.mpd``         → ``m3u8``
  3. URL domain is a known media site → ``ytdlp``
  4. URL ends with ``.m3u8``        → ``ytdlp``
  5. Everything else                → ``aria2``
"""

from __future__ import annotations

import logging
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# Domains where yt-dlp should be used for extraction.
# Kept as a flat set for O(1) lookup — extend as needed.
KNOWN_MEDIA_DOMAINS: set[str] = {
    "youtube.com",
    "www.youtube.com",
    "youtu.be",
    "m.youtube.com",
    "music.youtube.com",
    "twitter.com",
    "www.twitter.com",
    "x.com",
    "www.x.com",
    "vimeo.com",
    "www.vimeo.com",
    "dailymotion.com",
    "www.dailymotion.com",
    "twitch.tv",
    "www.twitch.tv",
    "clips.twitch.tv",
    "tiktok.com",
    "www.tiktok.com",
    "instagram.com",
    "www.instagram.com",
    "soundcloud.com",
    "www.soundcloud.com",
    "reddit.com",
    "www.reddit.com",
    "v.redd.it",
    "facebook.com",
    "www.facebook.com",
    "fb.watch",
}


def classify(
    url: str,
    drm_keys: Optional[str] = None,
    pssh: Optional[str] = None,
    license_url: Optional[str] = None,
) -> str:
    """Return the engine name for the given URL and optional DRM metadata.

    Returns one of: ``"m3u8"``, ``"ytdlp"``, ``"aria2"``.
    """
    # Rule 1: explicit DRM keys → always N_m3u8DL-RE
    if drm_keys:
        logger.debug("Route → m3u8 (drm_keys present)", extra={"event": "route.drm"})
        return "m3u8"

    # Rule 1b: PSSH + license URL → CDM negotiation then N_m3u8DL-RE
    if pssh and license_url:
        logger.debug(
            "Route → m3u8 (pssh + license_url → CDM negotiation)",
            extra={"event": "route.drm_proxy"},
        )
        return "m3u8"

    parsed = urlparse(url)
    path_lower = parsed.path.lower()

    # Rule 2: .mpd manifest → N_m3u8DL-RE
    if path_lower.endswith(".mpd"):
        logger.debug("Route → m3u8 (.mpd URL)", extra={"event": "route.mpd"})
        return "m3u8"

    # Rule 3: known media site domain → yt-dlp
    domain = parsed.hostname or ""
    if domain in KNOWN_MEDIA_DOMAINS:
        logger.debug(
            "Route → ytdlp (known domain: %s)", domain, extra={"event": "route.media"}
        )
        return "ytdlp"

    # Rule 4: .m3u8 playlist (no DRM) → yt-dlp
    if path_lower.endswith(".m3u8"):
        logger.debug("Route → ytdlp (.m3u8 URL)", extra={"event": "route.m3u8"})
        return "ytdlp"

    # Rule 5: everything else → aria2
    logger.debug("Route → aria2 (default)", extra={"event": "route.default"})
    return "aria2"

