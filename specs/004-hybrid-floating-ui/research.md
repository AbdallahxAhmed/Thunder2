# Research & Design Decisions: Hybrid Floating UI

## 1. Event Delegation in Shadow DOM
- **Decision**: Attach a single click event listener to the `uiContainer` inside the Shadow Root, rather than attaching individual event listeners to each dynamically generated download button.
- **Rationale**: Mitigates CSP inline-handler restrictions and ensures dynamically added format buttons are instantly interactive without needing re-binding. The event handler will use `e.target.closest('.format-btn')` to delegate the click action.
- **Alternatives considered**: Iterating through all buttons and running `addEventListener` on each inside `renderFormats`. Rejected because it creates memory overhead and requires careful cleanup when the menu is refreshed.

## 2. Trigger Download Payload URL Fix
- **Decision**: Explicitly pass `window.location.href` (or the `data-url` attribute attached to the button) when dispatching the `TRIGGER_DOWNLOAD` message.
- **Rationale**: Prevents `undefined` URLs from being sent to the background script, which currently causes silent failures when the popup or daemon attempts to parse the payload.
- **Alternatives considered**: Allowing `background.js` to infer the URL from the sender tab. Rejected because the sender tab's URL might occasionally be desynced in SPA navigations, whereas the content script always knows its current exact location.

## 3. Hybrid Payload Generation in Background Script
- **Decision**: Add a new `GET_HYBRID_STREAMS` message listener in `background.js`. This handler will fetch `formatCache.get(tabId)` and merge it with `tabBuffers.get(tabId)`. The raw M3U8 (if present) will be prepended as a "Master Stream (Adaptive)" option to the existing array of yt-dlp options.
- **Rationale**: Centralizes logic in the background, minimizing data processing in `content.js`, which aligns with the "Dumb UI" philosophy and respects Constitution Principle VIII.
