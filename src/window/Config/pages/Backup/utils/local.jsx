import { save, open } from '@tauri-apps/api/dialog';
import { invoke } from '@tauri-apps/api';
import { finishRestore } from './restore';

export async function backup() {
    const selected = await save({
        filters: [
            {
                name: 'Backup',
                extensions: ['zip'],
            },
        ],
    });
    if (selected !== null) {
        return await invoke('local', {
            operate: 'put',
            path: selected,
        });
    } else {
        throw 'Invalid File';
    }
}

// 判断所选文件是否是备份压缩包。
//
// 用不区分大小写的比较，并且要求 `.zip` **作为扩展名**出现在末尾：
//   · 原来写的是 `selected.endsWith('zip')`，于是
//       "/tmp/backup.ZIP" -> **被拒**（大小写敏感），
//       而 "/tmp/myzip"   -> **通过**（后缀不是扩展名，也没有点）
//     即同时存在「该收的没收」和「不该收的收了」两个方向的问题。
//   · 文件名大小写由用户决定：`backup()` 用的 save 对话框**没有 defaultPath**，
//     用户可自行输入 `backup.ZIP`；在 Windows/macOS 这类大小写不敏感的
//     文件系统上，`.ZIP` 是再正常不过的形态。而 filters 只是**建议性**的
//     显示过滤，不是强制约束（GTK/NSOpenPanel 都允许手输路径）。
//   · Rust 侧（backup.rs::local 的 "get" 分支）是直接
//     `ZipArchive::new(File::open(path)?)`，由 zip 解析器判定内容合法性——
//     也就是说前端这一层**不是**安全边界，加严只会误伤，加宽不会带来风险。
export function isBackupFileName(name) {
    return typeof name === 'string' && /\.zip$/i.test(name.trim());
}

export async function get() {
    const selected = await open({
        multiple: false,
        directory: false,
        filters: [
            {
                name: '*.zip',
                extensions: ['zip'],
            },
        ],
    });

    if (isBackupFileName(selected)) {
        await invoke('local', {
            operate: 'get',
            path: selected,
        });
        return finishRestore();
    } else {
        throw 'Invalid File';
    }
}
