"""Unit tests for URL classification router."""

from __future__ import annotations

import pytest

from src.router import classify


class TestClassifyRouting:
    """Verify deterministic 5-rule routing logic."""

    # Rule 1: drm_keys present → m3u8
    def test_drm_keys_routes_to_m3u8(self):
        assert classify("https://example.com/video.mp4", drm_keys="abc:def") == "m3u8"

    def test_drm_keys_override_media_domain(self):
        """drm_keys must override even YouTube URLs."""
        assert classify("https://www.youtube.com/watch?v=x", drm_keys="abc:def") == "m3u8"

    # Rule 2: .mpd URL → m3u8
    def test_mpd_url_routes_to_m3u8(self):
        assert classify("https://cdn.example.com/stream.mpd") == "m3u8"

    def test_mpd_url_case_insensitive(self):
        assert classify("https://cdn.example.com/stream.MPD") == "m3u8"

    # Rule 3: known media sites → ytdlp
    def test_youtube_routes_to_ytdlp(self):
        assert classify("https://www.youtube.com/watch?v=dQw4w9WgXcQ") == "ytdlp"

    def test_youtu_be_routes_to_ytdlp(self):
        assert classify("https://youtu.be/dQw4w9WgXcQ") == "ytdlp"

    def test_twitter_routes_to_ytdlp(self):
        assert classify("https://twitter.com/user/status/12345") == "ytdlp"

    def test_x_com_routes_to_ytdlp(self):
        assert classify("https://x.com/user/status/12345") == "ytdlp"

    def test_vimeo_routes_to_ytdlp(self):
        assert classify("https://vimeo.com/123456789") == "ytdlp"

    def test_tiktok_routes_to_ytdlp(self):
        assert classify("https://www.tiktok.com/@user/video/12345") == "ytdlp"

    def test_instagram_routes_to_ytdlp(self):
        assert classify("https://www.instagram.com/reel/abc123/") == "ytdlp"

    def test_twitch_routes_to_ytdlp(self):
        assert classify("https://www.twitch.tv/clips/something") == "ytdlp"

    # Rule 4: .m3u8 URL (no drm_keys) → ytdlp
    def test_m3u8_url_routes_to_ytdlp(self):
        assert classify("https://cdn.example.com/live/stream.m3u8") == "ytdlp"

    # Rule 5: everything else → aria2
    def test_zip_routes_to_aria2(self):
        assert classify("https://example.com/archive.zip") == "aria2"

    def test_exe_routes_to_aria2(self):
        assert classify("https://example.com/setup.exe") == "aria2"

    def test_generic_url_routes_to_aria2(self):
        assert classify("https://example.com/page") == "aria2"

    def test_ftp_routes_to_aria2(self):
        assert classify("ftp://mirror.example.com/file.iso") == "aria2"
