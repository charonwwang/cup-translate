# 安装与卸载

## Windows

普通用户选择对应 CPU 架构的 `*_setup.exe`（NSIS）；MSI 供 Windows Installer 管理或组织部署使用，不需要再安装一遍 EXE。

1. 启动安装包，选择简体中文、繁体中文或英语。
2. 按系统提示授权安装：当前采用全用户安装，默认位置为 Program Files。
3. 阅读许可证，选择安装目录和开始菜单文件夹。
4. 安装器检查 WebView2，缺失时运行微软引导程序；首次补装需要联网。
5. 等待安装完成，自行决定是否创建桌面快捷方式、立即启动。

已有版本使用原安装器的升级/重装提示。应用可从开始菜单启动；通过 Windows「设置 → 应用 → 已安装的应用」卸载。NSIS 卸载确认页提供是否删除应用数据的选项，删除前应先导出需要的配置。

安装器保持 Tauri 自带的 NSIS Modern UI / WiX 原生向导，仅替换符合尺寸要求的品牌 BMP 和图标。保留既有 perMachine 范围，避免升级时把 HKLM 安装迁到 HKCU。MSI 使用英语原生界面与许可证页面；多语言 EXE 面向普通用户。

## Debian / Ubuntu

下载架构对应的 `.deb`，通过软件安装器打开，或在下载目录执行：

```bash
sudo apt install ./cup-translate_<版本>_linux_x64.deb
```

APT 会解析并安装所需依赖；ARM64 下载名称包含 `linux_arm64` 的包。不要同时安装 RPM 或把解压目录当成已安装的软件。

安装后从应用菜单搜索 Cup / 翻译，或运行 `cup-translate`。后续版本使用同一命令安装。卸载：

```bash
sudo apt remove cup-translate
```

## Fedora / RPM 系发行版

下载架构对应的 `.rpm`，用软件中心打开，或执行：

```bash
sudo dnf install ./cup-translate_<版本>_linux_x64.rpm
sudo dnf remove cup-translate
```

依赖能否满足取决于发行版版本与启用的软件源；安装失败时按包管理器给出的缺失依赖处理，不强制忽略依赖。

DEB / RPM 负责程序、应用菜单项、hicolor 图标、AppStream 元数据及许可证的安装和卸载。用户目录中的配置与模型不会因移除系统软件包而自动删除。应用无需以 root 身份运行。

## AppImage

AppImage 是可携带运行格式，直接运行不等于注册到系统包管理器：赋予可执行权限后启动；不要求执行额外的 root 安装脚本。移除 AppImage 文件即可移除程序本体，用户数据另外保留。桌面集成由用户选择的 AppImage 管理器处理。

Linux 旧 `.tar.gz` 组合包继续保留，但普通用户优先下载 DEB / RPM。首次安装本地翻译模型在应用内单独进行，不与系统安装器捆绑。

## 发布验证边界

品牌资源与配置已接入仓库；Windows 安装/升级/卸载和 Linux 包管理器实机验证需分别在目标系统执行。macOS 不能替代这些测试，不将本地静态检查视作安装成功。

参考：[Tauri Windows Installer](https://v1.tauri.app/v1/guides/building/windows/)、[Desktop Entry 规范](https://specifications.freedesktop.org/desktop-entry/latest-single/)、[AppStream 元数据规范](https://www.freedesktop.org/software/appstream/docs/chap-Metadata.html)。
