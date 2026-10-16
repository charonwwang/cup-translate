# 图标资源说明

Cup 使用墨绿圆角方底、米白杯体和杯身内的双向翻译箭头。上箭头向右，下箭头向左；杯口上方留白，不再使用热气或文字线条。设计不含上游 pot 图形元素。

## 母版与派生资源

- `packaging/gen-icon.py`：100 单位坐标的可再生成几何源，4 倍采样抗锯齿。
- `app-icon.png`：1024×1024 RGBA 品牌母版，所有彩色平台图标由此派生。
- `tray-icon.png`：同一几何生成的透明单色杯形。箭头镂空，避免 macOS 模板渲染时变成实心方块。
- `public/icon.svg`：相同几何的矢量版本；更改几何时与生成器同步。
- `public/icon.png`：256×256 前端图标。
- `src-tauri/icons/`：Linux、Windows、通用打包图标。
- `src-tauri/icons_mac/`：macOS 应用图标及 `tray.ico` 模板托盘。

配色：底色 / 箭头 `#21634e`，杯体 `#f0f6e8`。客户端强调色 `#24735c`，深色强调色 `#90d4b5`。

## 重新生成

需要 Python + Pillow 和项目自带 Tauri CLI。以下命令从仓库根目录执行：

```bash
python3 packaging/gen-icon.py app-icon.png
pnpm tauri icon app-icon.png -o src-tauri/icons
python3 - <<'PY'
from pathlib import Path
from shutil import copy2
from PIL import Image
icons = Path('src-tauri/icons')
mac = Path('src-tauri/icons_mac')
for path in icons.iterdir():
    if path.name != 'icon_mac.ico':
        copy2(path, mac / path.name)
master = Image.open('app-icon.png').convert('RGBA')
master.resize((256, 256), Image.Resampling.LANCZOS).save('public/icon.png')
sizes = [(16,16), (32,32), (48,48), (64,64), (128,128), (256,256)]
master.save(icons / 'icon_mac.ico', sizes=sizes)
Image.open('tray-icon.png').save(mac / 'tray.ico', sizes=sizes)
PY
pnpm build
# 再从 src-tauri/ 执行：cargo build --release --features custom-protocol
```

图标路径已匹配现有 Tauri 配置，不需调整 bundle 列表。修改后检查 16 / 24 / 32px 识别度，macOS 托盘要用透明模板版，不能使用带实心背景的品牌母版。
