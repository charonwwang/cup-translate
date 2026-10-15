// 插件路径校验（与 src-tauri/src/cmd.rs 的 valid_plugin_type / valid_plugin_name 对齐）：
// 防止 config.json 被手改成含 ../ 或分隔符的 pluginName 后，经 invoke_plugin
// 拼进文件系统路径造成目录穿越（readTextFile / run_binary 的 working dir）。

export const PLUGIN_TYPES = ['recognize', 'translate', 'tts', 'collection'];

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
