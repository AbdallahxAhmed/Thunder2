# Data Model: Hybrid Floating UI

## 1. Hybrid Stream Payload (Background → Content Script)

This is the unified payload sent by `background.js` when responding to `GET_HYBRID_STREAMS`.

```typescript
interface HybridStreamPayload {
  title: string | null;
  url: string;
  options: StreamOption[];
}

interface StreamOption {
  type: "video" | "audio";
  format_id: string; // Identifier used for downloading
  label: string; // Human readable label (e.g., "1080p", "Master Stream (Adaptive)", "Audio Only")
  badge?: "4K" | "QHD" | "HD" | "HQ" | "RAW"; // Optional quality badge
  resolution?: string; // e.g., "1920x1080"
  vcodec: string;
  acodec: string;
  filesize?: number; // In bytes, if available
  ext: string; // e.g., "mp4", "m3u8"
}
```

### State Transitions

- **M3U8 Intercepted**: Added to `tabBuffers[tabId].manifestUrl`.
- **yt-dlp Formats Cached**: Added to `formatCache[tabId].data`.
- **Hybrid Merge**: Upon receiving `GET_HYBRID_STREAMS`, `background.js` extracts the M3U8 from the buffer and injects it as index `0` into the `options` array derived from `formatCache`, formatting it appropriately with the "RAW" badge.
