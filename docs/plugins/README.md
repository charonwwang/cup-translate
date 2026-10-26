# Cup 插件安装与开发

Cup 是 pot-desktop 的社区续版，复用 Pot `.potext` 协议。[Cup 验证清单](COMPATIBILITY.md) 仅说明具体样本及测试层次；[Pot 社区目录](https://github.com/pot-app/pot-app-plugin-list) 是第三方来源，不能视为 Cup 的兼容承诺。

## 安装与配置

从可信来源下载 `.potext`，在设置的服务页选择“添加外部服务 / 安装外部插件”，可多选；每个包分别显示成功或错误。安装完成后选择插件、填写配置、保存；配置与服务列表在一次持久化中提交。重新启动后按保存的实例键恢复。安装成功并不代表外部服务可用，也不会验证你的 API key。

支持 `plugin.com.pot-app.lingva_tts`、`plugin.com.pot-app.ecdict`、`plugin.com.pot-app.anki` 等点分 ID，也保留 `plugin`、`pluginA`、`plugin-demo_2` 等合法旧 ID。ID 以小写 `plugin` 开头，最长 128 个 ASCII 字符；点分段非空，只允许字母、数字、`_`、`-`。不允许路径分隔符、空白、盘符、控制字符和尾随点。

包名须为 `<info.id>.potext`，ZIP 根目录包含 `info.json`、非空 UTF-8 `main.js` 和图标。不要给下载包任意改名。历史上已经以合法旧目录名安装、但 `info.id` 不同的包可在**原目录名与原 manifest ID 均不改变**时升级，原实例键和配置不重写。新建重命名安装会明确拒绝；宿主不会自动推断或合并别名。插件自身硬编码的数据库路径可能仍要求上游原名。

安装会先编译检查 JavaScript 语法（不执行顶层代码），用入口摘要绑定所选内容，再校验归档、元信息与全部资源，完整解压到私有暂存目录后替换。首次加载还会验证类别对应的绑定确实为函数。语法通过不能证明插件业务正确或外部服务在线；条件式入口或顶层异常仍可能在加载时报错。

失败安装保留旧版本。成功升级保留一份 `.<id>.previous`；替换中断通过 `.<id>.pending` 在发现阶段恢复旧目录。普通重启不会启用备份目录。卸载会移除该包全部实例引用、配置和旧版本；最后一个非收藏服务不能被卸载。配置保存失败不会删除包，磁盘删除失败会报告错误并恢复实例引用；异常目录不会在启动时被自动删除。不要手动删除事务文件或在插件运行时更改安装目录。

## 安全与设备内模式

插件是可信代码扩展，当前没有权限沙箱。它在 WebView 中执行，可使用宿主 HTTP、文件、SQL、CryptoJS 和受控二进制入口，也可能直接使用 WebView 全局能力。**所有插件在设备内模式均禁止加载和调用，包括宣称离线的插件。** 缓存入口调用时也重新检查策略，Rust 的脚本加载及二进制命令另行检查。

切换模式不会可靠地终止已执行的任意第三方顶层代码、后台任务或既有网络连接；不能把它当成对不可信插件的进程隔离。需要严格断网保证时，先退出应用，再在设备内模式重新启动，并仅使用内置获准的本地服务。

归档限额：4096 条目，单文件 256 MiB，总解压 512 MiB；`info.json` 最大 64 KiB，`main.js` 最大 4 MiB。不接受符号链接、特殊文件、setuid/setgid/sticky 位、重复路径或仅大小写不同的路径。资源使用相对路径 `/` 分段；各段遵守可移植 ASCII 文件名规则，不允许 `.`、`..`、Windows 设备名（如 `CON`、`LPT1.exe`）、反斜杠、盘符和尾随点。已有安装路径的每层父目录也不能是符号链接。

`utils.run` 仅执行插件目录内的常规文件，支持相对路径（可带 `./`）或位于该目录内的绝对路径；不再从系统 PATH 查找命令，不能执行目录外程序。参数以参数数组传递，不经 shell。依赖系统 PATH、Node 或 Python 命令的旧插件需要将适用平台的程序放入包内并适配；这类插件不能推定兼容。

## 自定义开发

当前**没有直接 npm 安装能力**，宿主也不是 Node.js。npm 可用作作者的构建工具：把浏览器兼容依赖打包进单个 `main.js`，再制作 ZIP 格式 `.potext`。不支持运行时 `require`、Node 原生模块或自动解析 `node_modules`。

`info.json` 示例：

```json
{
  "id": "plugin.example.translate",
  "plugin_type": "translate",
  "display": "Example",
  "homepage": "https://example.com/plugin",
  "icon": "icon.svg",
  "needs": [{ "key": "prefix", "display": "Prefix", "type": "input" }],
  "language": { "en": "en", "zh_cn": "zh" }
}
```

类别为 `translate`、`tts`、`recognize`、`collection` 之一；非收藏类别须提供非空语言映射。`needs` 是数组，支持旧式未写 `type` 的输入项，以及 `input` / `select`（须有非空字符串值 `options` 对象）。入口应声明同名函数，例如：

```js
async function translate(text, from, to, { config, utils }) {
    return `${config.prefix || ''}${text}`;
}
```

四类签名：`translate(text, from, to, options)`、`tts(text, language, options)`、`recognize(image, language, options)`、`collection(source, target, options)`。`options` 包含 `config`、`utils`。翻译返回文本或现有词典结构；TTS 返回音频字节数组；OCR 返回文本；收藏 Promise 必须在目标确认写入后 resolve，并对业务错误 reject。宿主不会把 HTTP 200 自动解释为收藏成功。

工具包括 `tauriFetch`、`http`、`readTextFile`、`readBinaryFile`、`Database`、`CryptoJS`、`run`、`pluginDir`、`cacheDir`、`osType`。请通过 `utils.http.Body` 构造请求体，不能假设存在全局 `Body`。不同平台二进制和数据库资源须分别验证、记录许可证和摘要；安装结构校验不能代替这些验证。

可参考 [确定性测试插件](../../tests/fixtures/plugins/deterministic)；它们只验证宿主协议，TTS 样本返回的是可预测测试字节，不能当成可播放音频演示。运行 `python3 tests/fixtures/plugins/build-fixtures.py` 可离线重建固定时间戳的源码包；该脚本不下载任何资源。

## 损坏安装的恢复

规范 ID 目录中的入口、图标或 manifest 损坏时，可重新导入同 ID 的完整包修复；新包仍完整验证，旧目录保留为上一版本，已有服务配置不改名。能读取到不同身份的目录不会被静默覆盖。历史重命名目录需要可读且一致的 info.json 才能升级；若身份无法确认，请先恢复原 manifest，或备份配置后移除旧包，再使用规范文件名重装。
