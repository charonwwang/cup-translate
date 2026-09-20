# 图标资源说明

> 本目录记录 cup-translate 品牌图标的**来源与再生成方式**，避免「图标从哪来」失传。

## 现状

图标已从上游 pot 的素材**全部替换**为 cup-translate 自有设计。

| 文件 | 用途 | 是否自动生成 |
|---|---|---|
| `app-icon.png`（仓库根） | **图标母版**，1024×1024 RGBA | 由 `gen-icon.py` 生成 |
| `src-tauri/icons/icon.png` | Linux 托盘 / `systemTray.iconPath` | `pnpm tauri icon` |
| `src-tauri/icons/32x32.png` 等 | Linux 打包 | `pnpm tauri icon` |
| `src-tauri/icons/icon.ico` | Windows | `pnpm tauri icon` |
| `src-tauri/icons/icon.icns` | macOS | `pnpm tauri icon` |
| `src-tauri/icons/Square*Logo.png` / `StoreLogo.png` | Windows Appx | `pnpm tauri icon` |
| `src-tauri/icons/icon_mac.ico` | （当前无引用，历史遗留） | ❌ 需手动生成 |
| `public/icon.png` | 前端窗口 favicon（`index.html` 引用 `/icon.png`） | ❌ 需手动生成 |

## 设计说明

主题：**咖啡杯 + 两种文字符号**，呼应品牌 ☕ 与「划词翻译」。

- 圆角方形底：暖橙 → 焦糖棕 垂直渐变
- 中央白色杯体（上宽下窄），右侧杯柄
- 杯口上方三条热气曲线
- 杯身内嵌图案：**左侧笔画块（汉字意向）+ 右侧字母 A**，表示语言之间的转换

配色（`gen-icon.py` 中定义）：

| 名称 | RGB | 用途 |
|---|---|---|
| 暖橙 | `#FFB05C` | 渐变顶部 |
| 焦糖棕 | `#D66A2A` | 渐变底部 |
| 纯白 | `#FFFFFF` | 杯体 |
| 深焦糖 | `#C6581E` | 杯身图案 |

> ⚠️ 该设计为**本项目原创**，不含上游 pot 的图形元素，避免商标混淆。

## 重新生成（完整流程）

修改图标后按顺序执行：

```bash
# 1) 生成母版（1024x1024 RGBA）——需要 Pillow
python3 packaging/gen-icon.py app-icon.png

# 2) 生成各平台图标（覆盖 src-tauri/icons/）
pnpm tauri icon app-icon.png -o src-tauri/icons

# 3) 补齐 tauri icon 不会生成的两个文件
python3 - <<'PY'
from PIL import Image
im = Image.open('app-icon.png').convert('RGBA')
# 前端 favicon
im.resize((256, 256), Image.LANCZOS).save('public/icon.png')
# 历史遗留的 icon_mac.ico（当前无引用，保持一致以免混淆）
im.save('src-tauri/icons/icon_mac.ico', format='ICO',
        sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
PY

# 4) 重新构建验证
pnpm build
bash packaging/build-linux.sh deb
```

## 依赖

- **Python + Pillow**（生成母版）：`pip install Pillow --break-system-packages`
- **`pnpm tauri icon`**（Tauri CLI 自带，无需额外安装）

## 验证清单

替换后建议确认：

```bash
# 1) 母版尺寸/模式正确
python3 -c "from PIL import Image; im=Image.open('app-icon.png'); print(im.size, im.mode)"
# 期望: (1024, 1024) RGBA

# 2) 小尺寸仍有对比度（32x32 下杯体与底色可区分）
#    见 packaging/gen-icon.py 生成后可用像素统计检查

# 3) 安装后图标确实被替换（对比哈希）
md5sum src-tauri/icons/128x128.png
md5sum /usr/share/icons/hicolor/128x128/apps/cup-translate.png   # 两者应一致
```

## 注意事项

- `src-tauri/tauri.conf.json` 的 `bundle.icon` 列表**不要随意增删**，
  增删图标文件后需同步该列表。
- 托盘使用 `systemTray.iconPath = icons/icon.png` 且 `iconAsTemplate: true`：
  macOS 上会按**单色剪影**渲染，因此图标需要有清晰的实心轮廓
  （当前杯体为纯白实心，满足该条件）。
- 图标母版 `app-icon.png` 位于仓库根目录并纳入版本控制，
  它是所有派生图标的唯一来源，**不要只改派生文件**。