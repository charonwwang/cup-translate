#!/usr/bin/env python3
"""Generate the Cup brand master and monochrome tray from the same vector geometry.

Usage: python3 packaging/gen-icon.py [app-icon.png]
Requires Pillow. No runtime or network dependency. Coordinates use a 100-unit grid.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

SIZE = 1024
SCALE = 4
GREEN = '#21634e'
CREAM = '#f0f6e8'


def render(size=SIZE, tray=False):
    """Supersample code-native geometry, with arrows cut out for template trays."""
    n = size * SCALE
    image = Image.new('RGBA', (n, n))
    draw = ImageDraw.Draw(image)
    unit = n / 100

    def box(bounds):
        return tuple(round(x * unit) for x in bounds)

    if not tray:
        draw.rounded_rectangle(box((2, 2, 98, 98)), radius=round(25 * unit), fill=GREEN)
    cup = '#000000' if tray else CREAM
    # Cup handle and body: identical to public/icon.svg.
    draw.rounded_rectangle(box((57, 34, 82, 65)), radius=round(12 * unit), outline=cup, width=round(7 * unit))
    draw.rounded_rectangle(box((23, 29, 65, 78)), radius=round(20 * unit), fill=cup)
    draw.rectangle(box((23, 29, 65, 54)), fill=cup)
    ink = (0, 0, 0, 0) if tray else GREEN

    def stroke(points):
        coords = [(round(x * unit), round(y * unit)) for x, y in points]
        width = round(3.6 * unit)
        draw.line(coords, fill=ink, width=width, joint='curve')
        r = width / 2
        for x, y in coords:
            draw.ellipse((x-r, y-r, x+r, y+r), fill=ink)

    # Translation arrows live on the cup: right on top, left underneath.
    stroke([(34, 46), (55, 46)])
    stroke([(49, 40), (55, 46), (49, 52)])
    stroke([(55, 62), (34, 62)])
    stroke([(40, 56), (34, 62), (40, 68)])
    return image.resize((size, size), Image.Resampling.LANCZOS)


def main():
    output = Path(sys.argv[1] if len(sys.argv) > 1 else 'app-icon.png')
    render().save(output)
    tray = output.with_name('tray-icon.png')
    render(256, tray=True).save(tray)
    print(f'Generated {output} and {tray}')


if __name__ == '__main__':
    main()
