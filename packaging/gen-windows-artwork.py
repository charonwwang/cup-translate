#!/usr/bin/env python3
"""Generate 24-bit BMP artwork for the stock NSIS Modern UI and WiX dialogs.
Run after gen-icon.py. Requires Pillow. Keeps all native controls and page text clear.
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path('packaging/windows')
OUT.mkdir(exist_ok=True)
MASTER = Image.open('app-icon.png').convert('RGBA')


def artwork(name, size, panel, icon_size, icon_y):
    image = Image.new('RGB', size, '#ffffff')
    draw = ImageDraw.Draw(image)
    for y in range(size[1]):
        t = y / max(1, size[1]-1)
        a, b = (42, 109, 86), (18, 62, 52)
        color = tuple(round(x*(1-t)+z*t) for x,z in zip(a,b))
        draw.line((0,y,panel-1,y),fill=color)
    icon = MASTER.resize((icon_size, icon_size), Image.Resampling.LANCZOS)
    image.paste(icon, ((panel-icon_size)//2, icon_y), icon)
    image.save(OUT / name)


artwork('nsis-sidebar.bmp', (164,314), 164, 120, 65)
# Header artwork sits beside native title text; use a white field for legibility.
header = Image.new('RGB',(150,57),'white')
icon = MASTER.resize((54,54),Image.Resampling.LANCZOS)
header.paste(icon,(94,1),icon)
header.save(OUT/'nsis-header.bmp')
artwork('wix-dialog.bmp',(493,312),164,120,65)
# WiX banner reserves its left side for native headings; do not stretch the icon.
banner=Image.new('RGB',(493,58),'white')
banner.paste(icon,(433,2),icon)
banner.save(OUT/'wix-banner.bmp')
print('Generated stock NSIS/WiX BMP artwork in', OUT)
