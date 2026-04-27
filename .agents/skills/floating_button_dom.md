# Skill: MV3 Video Interception & Floating UI (IDM Style)

This skill dictates how to inject a premium floating download button over video players across the web (e.g., YouTube).

## Architecture Rules:
1. **DOM Interception:** Use `MutationObserver` to watch for `<video>` elements. Do NOT use `setInterval`.
2. **Injection Target:** Inject the floating UI into the video's direct parent container (e.g., `.html5-video-player` on YouTube) so it inherits positioning and goes fullscreen correctly.
3. **Idempotency:** Always mark the video or container with a custom attribute (e.g., `data-uhdd-injected="true"`) to prevent duplicate buttons when the DOM mutates.
4. **SPA Handling:** In Single Page Applications, the `<video>` element might be reused. The observer must handle URL changes gracefully.
5. **UI/UX:** The button must be positioned `absolute`, `top: 10px`, `right: 10px`. Use the established Dark Theme (`#0F172A`, `#6366F1`). It should start small (an icon), and expand on hover or click to show a mini-dropdown.
6. **Data Flow:** When clicked, the content script calls `chrome.runtime.sendMessage({type: "getFormats"})` to fetch the pre-fetched qualities from the background script, then dynamically renders the quality options in a mini-dropdown inside the page.