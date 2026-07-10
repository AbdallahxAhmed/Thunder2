"""Generate a high-quality multi-resolution Windows .ico file for Thunder.

Uses PIL (Pillow) to draw a premium yellow thunderbolt logo on a rounded dark
slate background, saving it in standard resolutions (16x16 up to 256x256).
"""

from __future__ import annotations

import sys
from pathlib import Path

# Add project root to path
root_dir = Path(__file__).resolve().parent

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("PIL (Pillow) is not installed. Please install it first.")
    sys.exit(1)

def draw_thunder_icon(size: int) -> Image.Image:
    """Draw a stylized premium logo for the given size."""
    # Create RGBA image
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    
    # Scale coordinates proportionally to the canvas size
    margin = max(2, int(size * 0.06))
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
    icon_path = root_dir / "icon.ico"
    print(f"Generating premium multi-resolution icon at {icon_path}...")
    
    # Generate list of standard icon sizes
    sizes = [16, 32, 48, 64, 128, 256]
    images = [draw_thunder_icon(s) for s in sizes]
    
    # Save as multi-resolution ICO file
    # The first image (typically largest) serves as the primary base
    images[-1].save(
        icon_path,
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=images[:-1]
    )
    print("✔ Successfully generated icon.ico!")

if __name__ == "__main__":
    main()
