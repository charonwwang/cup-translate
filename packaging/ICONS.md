# Cup 图标与 macOS 安装视觉

品牌方向：Evergreen & Porcelain（墨绿与瓷白）。保留杯子与双向翻译箭头，增加瓷白杯口、暖金内沿、柔和投影和墨绿纵向层次。图形不含上游 pot 元素。

## 资源与尺寸

- `packaging/gen-icon.py`：可重复生成的几何源，Pillow 超采样渲染；不调用网络。
- `app-icon.png`：1024×1024 RGBA 母版，外轮廓占画布 80%，为 macOS Dock 留出光学边距。
- `public/icon.svg`：同一杯子轮廓的网页矢量版本；有与 PNG 对应的渐变和投影。
- `public/icon.png`：256×256 前端图标。
- `tray-icon.png` / `src-tauri/icons_mac/tray.ico`：透明单色模板图标，翻译箭头镂空，不把彩色底板用于菜单栏。
- `src-tauri/icons/` / `src-tauri/icons_mac/`：Tauri 生成的各平台资源。

墨绿底从 `#34836a` 到 `#123e34`；箭头 `#174e40`；瓷白 `#f7f2e6`；安装页暖纸底 `#f4f0e6`。客户端现有强调色无需更改。

## 重新生成图标

在仓库根目录执行，需要 Pillow 与项目自带的 Tauri CLI：

```bash
python3 packaging/gen-icon.py app-icon.png
node_modules/.bin/tauri icon app-icon.png -o src-tauri/icons
python3 - <<'PY'
from pathlib import Path
from shutil import copy2
from PIL import Image
icons = Path('src-tauri/icons')
mac = Path('src-tauri/icons_mac')
for path in icons.iterdir():
    if path.is_file() and path.name != 'icon_mac.ico':
        copy2(path, mac / path.name)
master = Image.open('app-icon.png').convert('RGBA')
master.resize((256, 256), Image.Resampling.LANCZOS).save('public/icon.png')
sizes = [(16,16), (32,32), (48,48), (64,64), (128,128), (256,256)]
master.save(icons / 'icon_mac.ico', sizes=sizes)
Image.open('tray-icon.png').save(mac / 'tray.ico', sizes=sizes)
PY
```

更改轮廓时同步 `public/icon.svg`。检查 16 / 24 / 32px 和浅深两种底色。PNG 母版决定平台图标，SVG 使用缩放适配的矢量投影。

## 安装页

```bash
swift packaging/dmg-background.swift --preview
```

生成 1600×960、144 DPI 的 `packaging/dmg-background.png`（Finder 显示为 800×480 点），以及 `docs/design/macos-brand/installer-preview.png`。预览用系统 Applications 图标合成；实际安装页的两个图标及标签由 Finder 提供，背景不烘焙伪交互元素。

窗口为 800×512 点（含 32 点标题栏），背景内容为 800×480 点，避免底部被 Finder 裁切。左侧 232 点宽的双语字体海报；右侧图标中心为 `(382,254)` 与 `(650,254)`，图标区域 112 点。生成器、`package-macos.mjs` 与 Tauri DMG 配置应一起更新。许可证仍随磁盘镜像保留为 `.LICENSE.txt`，默认视图只显示应用与 Applications。

正式发布使用已有的 `package:macos:dmg` 流程或 release workflow，并安装 dmgbuild 以获得完整的 Finder 布局。Tauri 原生 DMG 配置也已同步背景与坐标。缺少 dmgbuild 时原有 hdiutil 回退仍只生成普通文件布局。
