// 插件路径校验（与 src-tauri/src/cmd.rs 的 valid_plugin_type / valid_plugin_name 对齐）：
// 防止 config.json 被手改成含 ../ 或分隔符的 pluginName 后，经 invoke_plugin
// 拼进文件系统路径造成目录穿越（readTextFile / run_binary 的 working dir）。

// 插件类型白名单。必须与 src-tauri/src/cmd.rs 的 PLUGIN_TYPES 完全一致——
// 两侧不一致会导致「前端认为能加载、后端拒绝」或反之。
// tests/plugin-type-sync.test.mjs 有一条跨语言护栏守着这件事。
// 不需要 export：本文件之外没有使用者（唯一消费者是下面的 validPluginType）。
const PLUGIN_TYPES = ['recognize', 'translate', 'tts', 'collection'];

export function validPluginType(value) {
    return PLUGIN_TYPES.includes(value);
}

export function validPluginName(value) {
    return (
        typeof value === 'string' &&
        value.startsWith('plugin') &&
        value.length > 0 &&
        [...value].every((c) => /[A-Za-z0-9_-]/.test(c))
    );
}
