import { checkPolicy } from './requestRuntime';
import { appCacheDir, appConfigDir, join } from '@tauri-apps/api/path';
import { readBinaryFile, readTextFile } from '@tauri-apps/api/fs';
import { invoke } from '@tauri-apps/api/tauri';
import Database from 'tauri-plugin-sql-api';
import { http } from '@tauri-apps/api';
import CryptoJS from 'crypto-js';
import { osType } from './env';
import { validPluginName, validPluginType } from './plugin_validation';

export async function invoke_plugin(pluginType, pluginName) {
    // 与 Rust 端 cmd.rs 的 valid_plugin_type / valid_plugin_name 对齐校验，
    // 防止 config.json 被手改成含 ../ 的 pluginName 后拼进文件系统路径造成目录穿越
    if (!validPluginType(pluginType) || !validPluginName(pluginName)) {
        throw new Error(`Invalid plugin path: ${pluginType}/${pluginName}`);
    }
    await checkPolicy(pluginType, pluginName);
    let configDir = await appConfigDir();
    let cacheDir = await appCacheDir();
    let pluginDir = await join(configDir, 'plugins', pluginType, pluginName);
    let script = await invoke('load_plugin', { pluginType, pluginName });
    async function run(cmdName, args) {
        return await invoke('run_binary', {
            pluginType,
            pluginName,
            cmdName,
            args,
        });
    }
    const utils = {
        tauriFetch: http.fetch,
        http,
        readBinaryFile,
        readTextFile,
        Database,
        CryptoJS,
        run,
        cacheDir, // String
        pluginDir, // String
        osType, // "Windows_NT", "Darwin", "Linux"
    };
    const entry = eval(`${script}\n;${pluginType}`);
    if (typeof entry !== 'function') throw new Error(`Missing plugin entry: ${pluginType}`);
    // Recheck on every call, including entries cached before a privacy-mode change.
    return [
        async (...args) => {
            await checkPolicy(pluginType, pluginName);
            return await entry(...args);
        },
        utils,
    ];
}
