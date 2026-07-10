"""Generate premium high-quality icons for the browser extension.

Creates 16x16, 48x48, and 128x128 PNG files with a yellow thunderbolt logo
on a rounded dark-slate background, matching the application theme.
"""

from __future__ import annotations

import os
from pathlib import Path

# Add project root to path
root_dir = Path(__file__).resolve().parent
icons_dir = root_dir / "extension" / "icons"
icons_dir.mkdir(parents=True, exist_ok=True)

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("PIL (Pillow) is not installed. Please install it first.")
    import sys
    sys.exit(1)

def draw_icon(size: int) -> Image.Image:
    """Draw a stylized premium logo for the extension toolbar at a given size."""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    
    # Scale coordinates proportionally to the canvas size
    margin = max(1, int(size * 0.06))
    radius = size - (margin * 2)
    
    # Draw background circle (slate dark theme `#1e1e2e`)
    draw.ellipse(
        (margin, margin, margin + radius, margin + radius),
        fill=(30, 30, 46, 255),
        outline=(137, 180, 250, 255),  # light blue border `#89b4fa`
        width=max(1, int(size * 0.05))
    )
    
    # Stylized thunderbolt coordinates scaled relative to size
    # Base bolt points relative to 100x100 box
    base_points = [
        (56, 18),  # Top point
        (32, 53),  # Left bend
        (50, 53),  # Inner bend left
        (44, 82),  # Bottom point
        (68, 47),  # Right bend
        (50, 47),  # Inner bend right
    ]
    
    # Scale points
    scaled_points = []
    for x, y in base_points:
        scaled_x = int(margin + (x / 100.0) * radius)
        scaled_y = int(margin + (y / 100.0) * radius)
        scaled_points.append((scaled_x, scaled_y))
        
    # Draw the bolt (yellow `#f9e2af`)
    draw.polygon(scaled_points, fill=(249, 226, 175, 255))
    
    return image

def main():
    sizes = [16, 48, 128]
    for s in sizes:
        img = draw_icon(s)
        icon_path = icons_dir / f"icon{s}.png"
        img.save(icon_path, format="PNG")
        print(f"✔ Generated extension icon: {icon_path}")

if __name__ == "__main__":
    main()
