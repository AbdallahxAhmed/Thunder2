# Skill: Modern Extension UI/UX (Premium Dark Theme)

When building UI for this extension (e.g., `popup.html` and `popup.js`), you MUST adhere to the following design system:

## 1. Color Palette (CSS Variables)
Use a sleek, modern Dark Mode palette:
- `--bg-main`: `#0F172A` (Deep Slate Black)
- `--bg-card`: `#1E293B` (Darker Slate)
- `--text-primary`: `#F8FAFC` (Off-white)
- `--text-secondary`: `#94A3B8` (Cool Gray)
- `--accent`: `#6366F1` (Indigo/Purple neon feel)
- `--accent-hover`: `#4F46E5`
- `--success`: `#10B981` (Emerald Green)
- `--error`: `#EF4444` (Red)

## 2. Layout & Styling Rules
- Use strict separation of concerns (No inline styles).
- Base font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif.
- Smooth transitions: `transition: all 0.2s ease-in-out;` on all interactive elements (buttons, cards).
- Use `border-radius: 8px` or `12px` for a modern, soft look.
- Hide default scrollbars but keep functionality, or style them to be minimalist and dark.

## 3. UI States
The popup must elegantly handle 4 states using smooth DOM updates:
1. **Loading State**: A pulsing CSS spinner or skeleton loader with text "Sniffing formats...".
2. **Empty/Invalid State**: A friendly message "No downloadable media detected on this page."
3. **Loaded State**: A clean list/grid of format buttons. Video formats grouped together, Audio-only separated.
4. **Success State**: A green checkmark or toast notification after clicking a download button.