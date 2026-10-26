#!/usr/bin/env python3
"""Reproducible Cup porcelain/evergreen icon. Requires Pillow; no network at render time.
Usage: python3 packaging/gen-icon.py [app-icon.png]
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

GREEN = '#174e40'
CREAM = '#f7f2e6'


def render(size=1024, tray=False):
    n = max(size * 3, 768)
    u = n / 100
    def box(values):
        return tuple(round(v * u) for v in values)
    def layer():
        return Image.new('RGBA', (n, n))
    def gradient(top, bottom):
        im = Image.new('RGBA', (n, n))
        a, b = bytes.fromhex(top), bytes.fromhex(bottom)
        d = ImageDraw.Draw(im)
        for y in range(n):
            t = y / (n - 1)
            d.line((0, y, n, y), fill=tuple(round(x*(1-t)+z*t) for x,z in zip(a,b))+(255,))
        return im
    def rounded(bounds, radius, fill):
        im = layer()
        ImageDraw.Draw(im).rounded_rectangle(box(bounds), radius=round(radius*u), fill=fill)
        return im
    def body_mask():
        im = layer()
        d = ImageDraw.Draw(im)
        d.rounded_rectangle(box((26, 34, 64, 76)), radius=round(16*u), fill='white')
        d.rectangle(box((26, 34, 64, 55)), fill='white')
        return im.getchannel('A')
    def arrows(im, color):
        d = ImageDraw.Draw(im)
        for points in [[(35,49),(55,49)],[(50,44),(55,49),(50,54)],[(55,63),(35,63)],[(40,58),(35,63),(40,68)]]:
            p = [(round(x*u),round(y*u)) for x,y in points]
            w = round(3*u)
            d.line(p, fill=color, width=w, joint='curve')
            for x,y in p:
                r=w/2
                d.ellipse((x-r,y-r,x+r,y+r),fill=color)
    im = layer()
    if not tray:
        tile = rounded((10,10,90,90),18,'white')
        shadow = layer()
        shadow.paste((7,31,24,55), (0,round(1.2*u),n,n+round(1.2*u)), tile.getchannel('A'))
        im.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(1.5*u)))
        tile_grad=gradient('34836a','123e34')
        tile_grad.putalpha(tile.getchannel('A'))
        im.alpha_composite(tile_grad)
        edge=layer()
        ImageDraw.Draw(edge).rounded_rectangle(box((10.4,10.4,89.6,89.6)),radius=round(17.7*u),outline=(204,239,215,85),width=max(1,round(.35*u)))
        im.alpha_composite(edge)
    handle=layer()
    d=ImageDraw.Draw(handle)
    d.rounded_rectangle(box((56,38,78,65)),radius=round(11*u),outline='black' if tray else '#e5decc',width=round(6.5*u))
    cup=layer()
    cup.paste((0,0,0,255) if tray else (247,242,230,255),(0,0,n,n),body_mask())
    if not tray:
        shade=gradient('fffdf5','e2dac7'); shade.putalpha(body_mask()); cup=shade
        silhouette=layer(); silhouette.alpha_composite(handle); silhouette.alpha_composite(cup)
        shadow=layer(); shadow.paste((0,19,12,90),(0,round(2*u),n,n+round(2*u)),silhouette.getchannel('A'))
        im.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(1.6*u)))
    im.alpha_composite(handle); im.alpha_composite(cup)
    if not tray:
        d=ImageDraw.Draw(im)
        d.ellipse(box((26,30.5,64,40.5)),fill='#fffbef')
        d.ellipse(box((29,32.8,61,38.4)),fill='#b8a681')
        d.ellipse(box((29.6,34.1,60.4,38.4)),fill='#544f3a')
        # A quiet warm highlight on the inner rim, like glazed porcelain.
        d.arc(box((29.2,32.8,60.8,38.2)),0,180,fill='#d2b77f',width=round(.7*u))
    arrows(im,(0,0,0,0) if tray else GREEN)
    return im.resize((size,size),Image.Resampling.LANCZOS)


def main():
    output=Path(sys.argv[1] if len(sys.argv)>1 else 'app-icon.png')
    render().save(output)
    render(256,tray=True).save(output.with_name('tray-icon.png'))
    print(f'Generated {output} and template tray-icon.png')

if __name__=='__main__':
    main()
