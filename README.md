# UHDD (Unified Headless Download Daemon)

UHDD is a high-performance, hybrid download orchestration system designed to natively handle complex DRM-encrypted video streams and standard media downloads. It pairs a sophisticated Chrome Extension frontend with a robust Python FastAPI backend to bypass strict WAFs, anti-hotlinking protections, and DRM constraints.

## Overview & Architecture

The architecture consists of three core layers that work in tandem to intercept, authenticate, and download media seamlessly:

1. **Chrome Extension (Frontend)**: Injects scripts into the page context (MAIN world) to intercept network requests, sniff `.m3u8` manifests, and rip DRM encryption keys directly from the browser's EME (Encrypted Media Extensions) sessions.
2. **FastAPI Daemon (Backend)**: Runs a local Python daemon (`http://localhost:8000`) that coordinates download jobs, tracks progress, and interacts with external download engines.
3. **Engines (`N_m3u8DL-RE` / `aria2`)**: Utilizes highly concurrent, specialized CLI binaries for the actual data transfer and decryption.

## Core Features

- **Auto-Widevine Decryption**: Seamlessly negotiates with DRM license servers using `pywidevine` to acquire decryption keys dynamically.
- **EME Key Ripping (VMP Bypass)**: For license servers enforcing strict Verified Media Path (VMP) or blacklisting local CDMs, the extension intercepts `MediaKeySession.update` to rip ClearKey/Widevine keys directly from the browser's native CDM session.
- **CDN Anti-Hotlinking Bypass**: Spoofs `User-Agent`, `Referer`, and `Origin` headers dynamically based on the original parent tab URL, easily bypassing BunnyCDN, Cloudflare, and custom WAF restrictions.
- **IDM-Grade Concurrency**: Operates with massive concurrency (`--thread-count 16`) to saturate bandwidth and dramatically accelerate download speeds for chunked HLS/DASH media.
- **Smart Title Extraction**: Intelligently sanitizes metadata to avoid generic filenames (e.g., UUIDs from CDNs). Falls back to parsing URL slugs from the parent tab when embedded iframe titles fail.

## Current State (v3.14.4)

The core pipeline is **100% stable and production-ready**. 
The system successfully intercepts manifests, decrypts DRM streams via EME Key Ripping or Pywidevine, bypasses 403 CDN errors via HTTP spoofing, and generates clean, human-readable filenames.

## Development Roadmap (TODO)

With the core extraction and decryption pipeline fully operational, development focus shifts to user experience and job management:

- [ ] **Job & Queue Manager**: Implement robust concurrency limits, job queuing, and memory management for the backend to handle multiple massive files simultaneously.
- [ ] **Real-Time Frontend UI**: Build a modern, glassmorphic UI tracking progress bars, speeds, and ETAs. Integrate WebSocket or Server-Sent Events (SSE) for zero-latency UI updates.
- [ ] **Pause/Resume Mechanics**: Implement granular pause, resume, and failure recovery functionality for large, multi-gigabyte downloads.
