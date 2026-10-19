#!/usr/bin/env python3
"""Regenerate browser assets; originals are retained. Requires Pillow for this step only."""
from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]


def optimize(source, destination, bounds):
    with Image.open(source) as original:
        image = ImageOps.exif_transpose(original)
        image.thumbnail(bounds, Image.Resampling.LANCZOS)
        destination.parent.mkdir(parents=True, exist_ok=True)
        image.save(destination, "WEBP", quality=82, method=6)
    return source.stat().st_size, destination.stat().st_size


def main():
    before = after = count = 0
    for folder, bounds in [("portraits", (192, 192)), ("posters", (680, 1020))]:
        for source in sorted((ROOT / "images" / folder).glob("*.jpg")):
            destination = ROOT / "images/optimized" / folder / (source.stem + ".webp")
            old, new = optimize(source, destination, bounds)
            before += old
            after += new
            count += 1
    old, new = optimize(ROOT / "images/game-logo.png", ROOT / "images/optimized/game-logo.webp", (192, 192))
    before += old
    after += new
    print(f"{count + 1} images: {before:,} → {after:,} bytes ({100 * (1 - after / before):.1f}% smaller)")


if __name__ == "__main__":
    main()
