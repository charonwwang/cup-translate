import { invoke } from '@tauri-apps/api';
import { finishRestore } from './restore';

export async function backup(url, username, password, name) {
    return await invoke('webdav', {
        operate: 'put',
        url,
        username,
        password,
        name,
    });
}

/**
 * 从 WebDAV 的 PROPFIND 响应里取出可用的备份文件名。
 *
 * 输入是 Rust 侧 `serde_json::to_string(&Vec<ListEntity>)` 的结果，
 * `ListEntity` 是 `File(ListFile) | Folder(ListFolder)`，所以正常形态是
 * `[{"File":{"href":...}},{"Folder":{"href":...}}]`。
 *
 * 这里做两件必要的清理：
 *
 * 1. 用 `Object.hasOwn` 而不是 `item.hasOwnProperty`。
 *    `hasOwnProperty` 是原型链上的方法，会被**自有属性遮蔽**：
 *        JSON.parse('{"hasOwnProperty":1}').hasOwnProperty('File')
 *        -> TypeError: ... is not a function
 *    当前 serde 的键只可能是 File / Folder 所以不可达，但用 `Object.hasOwn`
 *    是零成本的正确写法，且不依赖「上游永远不产出别的键」这个假设。
 *
 * 2. **丢弃取不到文件名的条目**。`href` 由服务器决定，取 basename 的方式是
 *    `href.split('/').slice(-1)[0]`，当 href 以 `/` 结尾时会得到**空串**。
 *    Rust 侧 `backup_name()` 明确拒绝空名字（`Invalid backup name`），
 *    所以这种条目一旦进入列表：
 *      · 界面上是一个**没有文字的按钮**，用户不知道它是什么；
 *      · 点它只会换来一句对用户毫无意义的错误提示；
 *      · 多个空条目还会造成 React key 重复。
 *    按 RFC4918，集合（目录）的 href 才带尾斜杠，而 reqwest_dav 会把带
 *    `collection` 的条目判为 `Folder`（已被本函数过滤掉）；但仍有些实现
 *    对目录不回 `collection`，于是它会以 `File` 的身份带着尾斜杠 href 出现。
 *    既然这种条目**必然用不了**，就该在列表里直接不显示。
 *
 * 顺带说明为什么**不**在这里做百分号解码：`href` 可能是
 * `.../a%20b.zip` 这样的编码形态，但解码与否取决于服务器与 Rust 侧的
 * 实际行为，本机没有可用的 WebDAV 服务端可验证 —— 在无法验证的情况下
 * 擅自解码，可能把本来能用的名字改坏。这里只处理**已证实**为空的情况。
 */
export function extractBackupNames(rawJson) {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) {
        return [];
    }
    return parsed
        .filter((item) => item !== null && typeof item === 'object' && Object.hasOwn(item, 'File'))
        .map((item) => item.File?.href)
        .filter((href) => typeof href === 'string')
        .map((href) => href.split('/').slice(-1)[0])
        .filter((name) => name !== '');
}

export async function list(url, username, password) {
    const backup_list_text = await invoke('webdav', {
        operate: 'list',
        url,
        username,
        password,
    });
    return extractBackupNames(backup_list_text);
}

export async function get(url, username, password, name) {
    await invoke('webdav', {
        operate: 'get',
        url,
        username,
        password,
        name,
    });
    return finishRestore();
}

export async function remove(url, username, password, name) {
    return await invoke('webdav', {
        operate: 'delete',
        url,
        username,
        password,
        name,
    });
}
