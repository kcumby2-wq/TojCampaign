"""Draws the iPhone app icon (1024, no transparency) and the launch screen
image from the same mark as the web app's icons: TOJ in gold Anton on navy,
with a gold rule under it.

    python3 mobile/scripts/make-icons.py path/to/Anton-Regular.ttf
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

NAVY = (10, 20, 32)
GOLD = (212, 162, 76)
ROOT = Path(__file__).resolve().parent.parent / "ios" / "App" / "App" / "Assets.xcassets"


def mark(size, text_width_ratio, font_path):
    img = Image.new("RGB", (size, size), NAVY)
    d = ImageDraw.Draw(img)
    # Find the font size that makes "TOJ" the requested share of the width.
    target = size * text_width_ratio
    lo, hi = 10, size
    while lo < hi:
        mid = (lo + hi + 1) // 2
        f = ImageFont.truetype(font_path, mid)
        l, t, r, b = d.textbbox((0, 0), "TOJ", font=f)
        if r - l <= target:
            lo = mid
        else:
            hi = mid - 1
    f = ImageFont.truetype(font_path, lo)
    l, t, r, b = d.textbbox((0, 0), "TOJ", font=f)
    w, h = r - l, b - t
    bar_h = round(h * 0.066)
    gap = round(h * 0.17)
    block = h + gap + bar_h
    x = (size - w) / 2 - l
    y = (size - block) / 2 - t - size * 0.012
    d.text((x, y), "TOJ", font=f, fill=GOLD)
    bar_w = w * 0.635
    by = y + t + h + gap
    d.rectangle([(size - bar_w) / 2, by, (size + bar_w) / 2, by + bar_h], fill=GOLD)
    return img


def main(font_path):
    icon = mark(1024, 0.50, font_path)
    icon.save(ROOT / "AppIcon.appiconset" / "AppIcon-512@2x.png", optimize=True)
    splash = mark(2732, 0.20, font_path)
    for name in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"):
        splash.save(ROOT / "Splash.imageset" / name, optimize=True)
    print("icon and splash written to", ROOT)


if __name__ == "__main__":
    main(sys.argv[1])
