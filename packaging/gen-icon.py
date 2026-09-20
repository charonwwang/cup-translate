#!/usr/bin/env python3
"""
生成 cup-translate 的品牌图标源图（1024x1024 PNG，带透明通道）。

设计说明
--------
主题：一只咖啡杯 + 两条"翻译"语义的符号，呼应品牌 ☕ 与"划词翻译"。

构图：
  - 圆角方形底（暖橙→琥珀渐变），与系统托盘/启动器的小尺寸识别度兼顾
  - 中央白色杯体（梯形 + 圆角），右侧带杯柄
  - 杯口上方三条"热气"曲线，取自"翻译"的语感（对话/传递）
  - 杯身内嵌「文/A」双字符意向：左为笔画块，右为拉丁字母 A
    —— 表示"两种语言之间的转换"，即翻译

仅为本地生成脚本，不参与运行时；产出 app-icon.png 供 `pnpm tauri icon` 使用。

用法：
    python3 packaging/gen-icon.py [输出路径]
"""

import math
import sys
from PIL import Image, ImageDraw, ImageFilter

S = 1024                      # 画布尺寸
OUT = sys.argv[1] if len(sys.argv) > 1 else "app-icon.png"

# ---- 配色（暖咖啡/焦糖系，与 ☕ 品牌一致）----
C_TOP = (255, 176, 92)        # 渐变顶部：暖橙
C_BOT = (214, 106, 42)        # 渐变底部：焦糖棕
C_CUP = (255, 255, 255)       # 杯体：纯白
C_MARK = (198, 88, 30)        # 杯身图案：深焦糖
C_STEAM = (255, 240, 224)     # 热气：近白米色


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def rounded_rect_mask(size, radius, supersample=4):
    """生成抗锯齿的圆角方形遮罩。"""
    w = size * supersample
    m = Image.new("L", (w, w), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, w - 1, w - 1], radius=radius * supersample, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def vertical_gradient(size, top, bottom):
    g = Image.new("RGB", (1, size))
    for y in range(size):
        g.putpixel((0, y), lerp(top, bottom, y / max(1, size - 1)))
    return g.resize((size, size))


def draw_steam(d, cx, top_y, width, n=3):
    """三条上浮的热气曲线，用二次贝塞尔近似成折线。"""
    for i in range(n):
        x = cx + (i - (n - 1) / 2) * width
        pts = []
        for k in range(25):
            t = k / 24
            y = top_y - t * 150
            # 正弦摆动，越往上越明显
            xo = math.sin(t * math.pi * 1.6 + i * 0.9) * 26 * t
            pts.append((x + xo, y))
        d.line(pts, fill=C_STEAM, width=22, joint="curve")
        # 端点圆头
        r = 11
        d.ellipse([pts[0][0] - r, pts[0][1] - r, pts[0][0] + r, pts[0][1] + r], fill=C_STEAM)
        d.ellipse([pts[-1][0] - r, pts[-1][1] - r, pts[-1][0] + r, pts[-1][1] + r], fill=C_STEAM)


def main():
    base = vertical_gradient(S, C_TOP, C_BOT).convert("RGBA")
    mask = rounded_rect_mask(S, radius=210)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(base, (0, 0), mask)

    d = ImageDraw.Draw(img)

    cx = S / 2

    # ---------- 热气（先画，位于杯体之后） ----------
    draw_steam(d, cx - 6, 330, width=126, n=3)

    # ---------- 杯柄（右侧，用圆环模拟） ----------
    hx, hy, hr = cx + 250, 648, 96
    d.ellipse([hx - hr, hy - hr, hx + hr, hy + hr], outline=C_CUP, width=40)

    # ---------- 杯体：上宽下窄的梯形，底部圆角 ----------
    top_w, bot_w = 470, 372
    top_y, bot_y = 470, 812
    body = [
        (cx - top_w / 2, top_y),
        (cx + top_w / 2, top_y),
        (cx + bot_w / 2, bot_y - 58),
        (cx + bot_w / 2 - 40, bot_y),
        (cx - bot_w / 2 + 40, bot_y),
        (cx - bot_w / 2, bot_y - 58),
    ]
    d.polygon(body, fill=C_CUP)
    # 补齐底部圆角
    d.rounded_rectangle(
        [cx - bot_w / 2, bot_y - 60, cx + bot_w / 2, bot_y],
        radius=34, fill=C_CUP,
    )

    # ---------- 杯身图案：左「文」意向笔画 + 右「A」 ----------
    mk = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    md = ImageDraw.Draw(mk)

    # 左侧：三条横笔 + 一竖，抽象表示汉字「文」/ 笔画文字
    lx = cx - 112
    for i, (wy, ww) in enumerate([(600, 108), (656, 92), (712, 76)]):
        md.rounded_rectangle([lx - ww / 2, wy, lx + ww / 2, wy + 20], radius=10, fill=C_MARK)
    md.rounded_rectangle([lx - 11, 578, lx + 11, 742], radius=11, fill=C_MARK)

    # 右侧：字母 A（两条斜笔 + 一横）
    ax = cx + 110
    md.line([(ax - 62, 742), (ax, 578)], fill=C_MARK, width=26)
    md.line([(ax, 578), (ax + 62, 742)], fill=C_MARK, width=26)
    md.rounded_rectangle([ax - 40, 682, ax + 40, 706], radius=12, fill=C_MARK)
    # 圆头收尾
    for p in [(ax - 62, 742), (ax, 578), (ax + 62, 742)]:
        md.ellipse([p[0] - 13, p[1] - 13, p[0] + 13, p[1] + 13], fill=C_MARK)

    img.alpha_composite(mk)

    # ---------- 轻微内阴影，增加厚度感 ----------
    # 做法：把阴影限制在"杯体边缘"的窄带内（体 mask 减去腐蚀后的体 mask），
    # 避免整块杯体被整体压暗（那样白色会变成灰）。
    body_mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(body_mask).polygon(body, fill=255)
    ImageDraw.Draw(body_mask).rounded_rectangle(
        [cx - bot_w / 2, bot_y - 60, cx + bot_w / 2, bot_y], radius=34, fill=255,
    )

    eroded = body_mask.filter(ImageFilter.MinFilter(31))      # 向内收 ~15px
    edge = Image.new("L", (S, S), 0)
    ep = edge.load()
    bp, rp = body_mask.load(), eroded.load()
    for y in range(S):
        for x in range(S):
            v = bp[x, y]
            if v and not rp[x, y]:
                ep[x, y] = v

    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).polygon(
        [(p[0], p[1] + 8) for p in body], fill=(0, 0, 0, 40),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(10))
    # 仅保留边缘窄带
    edge_rgba = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    edge_rgba.putalpha(edge)
    img.alpha_composite(Image.composite(shadow, Image.new("RGBA", (S, S), (0, 0, 0, 0)), edge))

    img.save(OUT)
    print(f"已生成 {OUT}  ({img.size[0]}x{img.size[1]}, {img.mode})")


if __name__ == "__main__":
    main()