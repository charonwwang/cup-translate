import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { isFilledPort, isFilledString } from '../src/utils/configValue.js';

/**
 * 「配置值真的填了吗」的判定。
 *
 * 背景（round 48/49 实测，同类缺陷反复出现）：项目里多处用
 * `value === ''` / `value !== ''` 判断是否填了，而那是**精确比较空串**，
 * 纯空白（`'   '` / `'\t'` / `'\n'`）会穿过去。
 *
 * 已经实测到两处真实后果：
 *   1) `required_config.js`（round 48）：配置闸门放行纯空白的
 *      apiKey / requestPath，**全部 11 个登记引擎**都会发出注定失败的请求。
 *   2) `General/index.jsx`（round 49）：代理开关的
 *      `proxyHost === '' || proxyPort === ''` 放行纯空白 host，
 *      最终 Rust 的 `set_proxy()` 把 `http://   :7890` 写进
 *      http_proxy / https_proxy / all_proxy 环境变量。
 *      **用真实二进制验证过**：proxy_host='   ' 时 set_proxy() 成功返回、
 *      启动日志没有任何告警——也就是说这个坏值被当成了合法配置。
 */

test('isFilledString rejects empty and whitespace-only values', () => {
    for (const blank of ['', ' ', '   ', '\t', '\n', '\r\n', ' \t\n ']) {
        assert.equal(isFilledString(blank), false, `${JSON.stringify(blank)} must not count as filled`);
    }
});

test('isFilledString accepts values with incidental surrounding whitespace', () => {
    // 从网页/文档复制时尾部常带空格或换行，那是真实且正确的操作，不能误伤
    for (const good of ['a', ' 127.0.0.1 ', '\thttp://x\n', 'sk-abc']) {
        assert.equal(isFilledString(good), true, `${JSON.stringify(good)} must count as filled`);
    }
});

test('isFilledString rejects non-strings', () => {
    for (const bad of [0, 1, true, false, {}, [], null, undefined, NaN, () => {}]) {
        assert.equal(isFilledString(bad), false, `${String(bad)} must not count as filled`);
    }
});

test('isFilledPort handles both number and string ports', () => {
    // 这是本轮最关键的一条：端口经 nextPortValue 存进配置的是 **number**，
    // 若拿 isFilledString 去判，`isFilledString(7890) === false`——
    // 所有正常填写的端口都会被判为「没填」，比原缺陷更糟（直接锁死功能）。
    assert.equal(isFilledString(7890), false, 'this is exactly why isFilledPort must exist');
    assert.equal(isFilledPort(7890), true);
    assert.equal(isFilledPort('7890'), true);
    assert.equal(isFilledPort(' 7890 '), true);
    assert.equal(isFilledPort(1), true);
    assert.equal(isFilledPort(65535), true);

    for (const bad of [
        '',
        '   ',
        0,
        '0',
        -1,
        'abc',
        '12abc',
        1.5,
        '1.5',
        65536,
        '99999',
        NaN,
        Infinity,
        null,
        undefined,
        {},
        [],
    ]) {
        assert.equal(isFilledPort(bad), false, `${String(bad)} is not a valid port`);
    }
});

test('the helpers never mutate the values they inspect', () => {
    const config = { host: ' 127.0.0.1 ', port: ' 7890 ' };
    const snapshot = JSON.stringify(config);
    isFilledString(config.host);
    isFilledPort(config.port);
    assert.equal(JSON.stringify(config), snapshot, 'the helpers must be read-only');
});

test('the proxy switch no longer validates with === empty-string comparison', async () => {
    // 接线护栏：删掉 isFilledString / isFilledPort 调用、退回 `=== ''`，
    // 上面所有测试依然会通过（它们只测纯函数）。这里直接扫源码。
    const source = await readFile('src/window/Config/pages/General/index.jsx', 'utf8');
    const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(code, /isFilledString\s*\(\s*proxyHost\s*\)/, 'the proxy host must go through isFilledString');
    assert.match(code, /isFilledPort\s*\(\s*proxyPort\s*\)/, 'the proxy port must go through isFilledPort');
    assert.ok(
        !/proxyHost === '' \|\| proxyPort === ''/.test(code),
        "the proxy switch must not fall back to `=== ''`: a whitespace-only host passes it"
    );
    assert.match(
        source,
        /import \{[^}]*isFilledString[^}]*\} from '[^']*utils\/configValue'/,
        'the helper must be imported'
    );
});

test('the Rust set_proxy check trims before deciding', async () => {
    // Rust 侧同样有 `!value.is_empty()`，纯空白会穿过去。
    // 直接扫描源码确认用的是 trim。
    const source = await readFile('src-tauri/src/cmd.rs', 'utf8');
    const start = source.indexOf('pub fn set_proxy()');
    assert.notEqual(start, -1, 'set_proxy should exist');
    const body = source.slice(start, source.indexOf('\n}', start));
    assert.match(body, /trim\(\)\.is_empty\(\)/, 'set_proxy must reject whitespace-only hosts');
    assert.ok(
        !/filter\(\|value\| !value\.is_empty\(\)\)/.test(body),
        'set_proxy must not use the untrimmed is_empty check'
    );
});

test('the proxy host and port are required together, matching the Rust guard', async () => {
    // 前端与 Rust 的判据必须一致，否则会出现「前端放行、Rust 拒绝」的静默不一致：
    // Rust 为 host 与 port 都做了校验（host 非空白、port 为 1..=65535 的 u16）。
    const source = await readFile('src-tauri/src/cmd.rs', 'utf8');
    const start = source.indexOf('pub fn set_proxy()');
    const body = source.slice(start, source.indexOf('\n}', start));
    assert.match(body, /proxy_port/, 'set_proxy must read proxy_port');
    assert.match(body, /u16::try_from/, 'set_proxy must bound the port to u16');
    assert.match(body, /\*value != 0/, 'set_proxy must reject port 0');
});

test('the editable proxy fields are exactly the ones the backend reads', async () => {
    // 契约：**用户能编辑的代理字段** 必须 **⊆ Rust `set_proxy()` 真正读取的键**。
    //
    // 背景（本轮实测）：代理区块有 5 个字段：
    //   proxy_host / proxy_port / no_proxy   -> 可编辑，且 `set_proxy()` 都读取
    //   proxy_username / proxy_password      -> `isDisabled`，且 `set_proxy()` **不读**
    //     （`grep proxy_username src-tauri/` 无任何命中：拼出的代理 URL 是
    //      `format!("http://{}:{}", host, port)`，没有凭据的位置）
    //
    // 当前状态**自洽**——不可编辑的字段不被读取，不构成缺陷。但这个自洽
    // **没有任何护栏**：若有人去掉 `isDisabled`，用户就能填入一组永远不生效的
    // 代理凭据，界面不会有任何提示。这就是「能填但静默无效」那类问题。
    //
    // **刻意不列举已知字段**：本测试从左到右扫描整个代理区块，把所有
    // `useConfig('proxy_*')` / `useConfig('no_proxy')` 都收进来。
    // 列举已知清单的写法无法发现**新增**的字段（清单自证不了完整性，
    // 与 round 58 的 `UI_LANGUAGES` 是同一个坑）——实测确认那版会让
    // 「新增一个可编辑但后端不读的字段」静默逃逸。
    const jsx = await readFile('src/window/Config/pages/General/index.jsx', 'utf8');
    const rust = await readFile('src-tauri/src/cmd.rs', 'utf8');

    const setProxyStart = rust.indexOf('pub fn set_proxy()');
    assert.notEqual(setProxyStart, -1, 'set_proxy should exist');
    const setProxyBody = rust.slice(setProxyStart, rust.indexOf('\n}', setProxyStart));
    const readKeys = new Set([...setProxyBody.matchAll(/get\("([a-z_]+)"\)/g)].map((m) => m[1]));

    // 配置绑定在组件顶部声明（`const [x, setX] = useConfig('proxy_x', ...)`），
    // 渲染在代理 Card 里，两处不在一起——所以要分开取。
    //
    // 声明侧：扫**整个文件**里所有 `proxy_*` / `no_proxy` 绑定。这是**发现式**的，
    // 新增字段会自动进入检查范围（列举已知键做不到这点，实测会静默逃逸）。
    const declared = [...jsx.matchAll(/\[\s*(\w+)\s*,\s*\w+\s*\]\s*=\s*useConfig\('((?:proxy_\w+|no_proxy))'/g)].map(
        (m) => ({ variable: m[1], key: m[2] })
    );
    assert.ok(
        declared.length >= 5,
        `expected at least 5 proxy config bindings, found ${declared.length}: ${declared.map((d) => d.key).join(', ')}`
    );

    // 渲染侧：代理 Card 的范围，从 proxy.title 那行到该 Card 的 `</Card>`。
    const allLines = jsx.split('\n');
    const regionStart = allLines.findIndex((l) => l.includes("t('config.general.proxy.title')"));
    assert.notEqual(regionStart, -1, 'the proxy section must exist');
    const regionEnd = allLines.findIndex((l, i) => i > regionStart && l.includes('</Card>'));
    assert.notEqual(regionEnd, -1, 'the proxy section must be closed by </Card>');
    const region = allLines.slice(regionStart, regionEnd).join('\n');

    // 每个绑定的键都要能在代理区块内找到它的控件，并判定是否禁用。
    // 控件有两种形态：`proxy_enable` 是 `<Switch isSelected>`，其余是 `<Input value>`。
    // 只认 `<Input>` 会把开关误判成「未渲染」——实测踩过。
    // `proxy_enable` 是**开关**而非代理参数：它不参与 `set_proxy()` 拼 URL，
    // 而是在启动时由 main.rs 读取（`get("proxy_enable") == Some(true)` 才调用
    // set_proxy）。因此它属于「可编辑但不被 set_proxy 读取」，是**契约内的例外**，
    // 显式登记以免被上面的断言误伤。
    const editable = [];
    const disabled = [];
    const unbound = [];
    for (const { key, variable: name } of declared) {
        const inputAt = region.indexOf(`value={${name}}`);
        const isInput = inputAt !== -1;
        const switchAt = region.indexOf(`isSelected={${name}}`);
        const isSwitch = switchAt !== -1;

        if (!isInput && !isSwitch) {
            unbound.push(key);
            continue;
        }

        // 从控件起点往回找最近的 <Input / <Switch，往下找最近的 />
        const at = isInput ? inputAt : switchAt;
        const before = region.slice(0, at);
        const openAt = Math.max(before.lastIndexOf('<Input'), before.lastIndexOf('<Switch'));
        assert.notEqual(openAt, -1, `${key} must be rendered by an <Input> or <Switch>`);
        const closeAt = region.indexOf('/>', at);
        assert.notEqual(closeAt, -1, `${key}'s control must be self-closed`);
        const block = region.slice(openAt, closeAt + 2);
        (block.includes('isDisabled') ? disabled : editable).push(key);
    }

    assert.deepEqual(
        unbound,
        [],
        `these proxy config keys are bound in the section but never rendered by an input: ${unbound.join(', ')}`
    );
    assert.ok(editable.length >= 2, `expected several editable proxy fields, found ${editable.length}`);

    // 例外：开关本身不参与 set_proxy 的参数解析（见上）
    const switchesNotParameters = new Set(['proxy_enable']);
    const notRead = editable.filter((key) => !readKeys.has(key) && !switchesNotParameters.has(key));
    assert.deepEqual(
        notRead,
        [],
        `these proxy fields are editable but never read by set_proxy, so typing in them does nothing: ${notRead.join(', ')}`
    );

    const readButDisabled = disabled.filter((key) => readKeys.has(key));
    assert.deepEqual(
        readButDisabled,
        [],
        `these proxy fields are disabled in the UI but the backend reads them — enable them instead: ${readButDisabled.join(', ')}`
    );
});

test('the WebDav backup button refuses to run without a URL and account', async () => {
    // 修复前 webdav 分支**没有任何前置校验**：空 url 被原样传给 Rust，
    // 最终用户看到的是 reqwest 的原始报错（用真实 url crate 实测过）：
    //   url=''    -> `relative URL without a base`
    //   url='   ' -> `invalid international domain name`
    // 对「忘了填地址」这件事毫无提示作用；而 aliyun 分支早就有对照的
    // aliyun_login_first 提示。
    const source = await readFile('src/window/Config/pages/Backup/index.jsx', 'utf8');
    const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

    assert.match(code, /isFilledString\s*\(\s*davUrl\s*\)/, 'the WebDav URL must be validated');
    assert.match(code, /isFilledString\s*\(\s*davUserName\s*\)/, 'the WebDav account must be validated');
    assert.match(
        code,
        /t\('config\.backup\.webdav_not_configured'\)/,
        'the user must get a localized explanation, not a raw reqwest error'
    );
    assert.match(
        source,
        /import \{[^}]*isFilledString[^}]*\} from '[^']*utils\/configValue'/,
        'the helper must be imported'
    );

    // 校验必须发生在真正发起请求之前
    const checkAt = code.indexOf('isFilledString(davUrl)');
    const callAt = code.indexOf('webdav.backup(');
    assert.notEqual(checkAt, -1, 'the check must exist');
    assert.notEqual(callAt, -1, 'the backup call must exist');
    assert.ok(checkAt < callAt, 'the guard must run before the request is sent');
});

test('the WebDav prompt is a real localized string, not a key or an English copy', async () => {
    // 新增 key 必须真的存在于两个基准语言里，且两边文案不同
    // （zh_CN 复用英文属于「假本地化」，locale 相关测试会拦，这里就近断言一次）。
    const en = JSON.parse(await readFile('src/i18n/locales/en_US.json', 'utf8'));
    const zh = JSON.parse(await readFile('src/i18n/locales/zh_CN.json', 'utf8'));
    const key = 'webdav_not_configured';
    const enText = en.translation.config.backup[key];
    const zhText = zh.translation.config.backup[key];
    assert.equal(typeof enText, 'string', `en_US must define config.backup.${key}`);
    assert.equal(typeof zhText, 'string', `zh_CN must define config.backup.${key}`);
    assert.ok(enText.trim() !== '', 'the English prompt must not be empty');
    assert.ok(zhText.trim() !== '', 'the Chinese prompt must not be empty');
    assert.notEqual(enText, zhText, 'zh_CN must not simply reuse the English text');
    assert.ok(/[\u4e00-\u9fff]/.test(zhText), 'the Chinese prompt should actually contain Chinese characters');
});
/**
 * 按 `case 'xxx':` 把 switch 的每个分支体切出来。
 *
 * 教训（round 51）：我第一版护栏只用 `indexOf` 找「第一个 isFilledString」
 * 与「onWebDavListOpen」，于是「把恢复入口的校验挪到打开弹窗**之后**」
 * 这种变异能逃逸——因为第一个匹配到的其实是**备份入口**的校验。
 * 全局计数无法表达「哪个分支必须校验」，必须按分支体分别断言。
 */
function branchBody(code, caseName) {
    const start = code.indexOf(`case '${caseName}':`);
    assert.notEqual(start, -1, `branch '${caseName}' should exist`);
    const rest = code.slice(start + 1);
    const next = rest.search(/case '/);
    const end = next === -1 ? code.length : start + 1 + next;
    return code.slice(start, end);
}

test('every WebDav entry point validates before it does anything', async () => {
    // 「备份」与「恢复」两个入口都必须校验。恢复入口尤其重要：
    // WebDavModal 的 useEffect 在 isOpen 时**立即**发 webdav.list，
    // 而 backup_type 的默认值就是 'webdav'（Backup/index.jsx:29），
    // 新用户什么都没配就点「恢复」必然走到这里。
    const source = await readFile('src/window/Config/pages/Backup/index.jsx', 'utf8');
    const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

    // 找出所有 webdav 分支（备份 switch 与恢复 switch 各一个）
    const bodies = [];
    let from = 0;
    while (true) {
        const at = code.indexOf("case 'webdav':", from);
        if (at === -1) break;
        const rest = code.slice(at + 1);
        const next = rest.search(/case '/);
        bodies.push(code.slice(at, next === -1 ? code.length : at + 1 + next));
        from = at + 1;
    }
    assert.equal(bodies.length, 2, `expected 2 webdav branches (backup + restore), found ${bodies.length}`);

    for (const [i, body] of bodies.entries()) {
        assert.match(body, /isFilledString\(davUrl\)/, `webdav branch #${i + 1} must validate the URL`);
        assert.match(body, /isFilledString\(davUserName\)/, `webdav branch #${i + 1} must validate the account`);
        assert.match(
            body,
            /t\('config\.backup\.webdav_not_configured'\)/,
            `webdav branch #${i + 1} must show a localized prompt`
        );
        assert.match(body, /return;/, `webdav branch #${i + 1} must abort, not fall through`);
    }

    // 校验必须在该分支**实际动作之前**——逐个分支比较位置，
    // 而不是比较全文里的第一个匹配（那正是上一版逃逸的原因）。
    for (const [i, body] of bodies.entries()) {
        const checkAt = body.indexOf('isFilledString(davUrl)');
        const actionAt = Math.min(
            ...[body.indexOf('webdav.backup('), body.indexOf('onWebDavListOpen()')].filter((v) => v !== -1)
        );
        assert.notEqual(actionAt, Infinity, `webdav branch #${i + 1} should have an action`);
        assert.ok(checkAt < actionAt, `webdav branch #${i + 1}: the guard must precede the action`);
    }
});

test('the aliyun branches keep their own login check', async () => {
    // 修 webdav 时不能把 aliyun 的对照校验删掉——**两个 switch 各有一处**
    const source = await readFile('src/window/Config/pages/Backup/index.jsx', 'utf8');
    const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

    const bodies = [];
    let from = 0;
    while (true) {
        const at = code.indexOf("case 'aliyun':", from);
        if (at === -1) break;
        const rest = code.slice(at + 1);
        const next = rest.search(/case '/);
        bodies.push(code.slice(at, next === -1 ? code.length : at + 1 + next));
        from = at + 1;
    }
    assert.equal(bodies.length, 2, `expected 2 aliyun branches, found ${bodies.length}`);
    for (const [i, body] of bodies.entries()) {
        assert.match(body, /aliyun_login_first/, `aliyun branch #${i + 1} must keep its login-first prompt`);
    }
});

test('the local branches are not given the WebDav credential check', async () => {
    // local 是纯本地文件操作，不该继承 webdav 的校验（过度修正）
    const source = await readFile('src/window/Config/pages/Backup/index.jsx', 'utf8');
    const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // 两个 local 分支（备份 + 恢复）都要检查。
    // 教训（round 51）：我第一版只看了 `branchBody(code, 'local')` 返回的**第一个**
    // 分支，注释却写着「两个都检查」——于是「给恢复入口的 local 分支加上 webdav
    // 校验」这个变异直接逃逸（pass 204 / fail 0）。注释与实现不符是护栏最常见的失效方式。
    let from = 0;
    const bodies = [];
    while (true) {
        const at = code.indexOf("case 'local':", from);
        if (at === -1) break;
        const rest = code.slice(at + 1);
        const next = rest.search(/case '/);
        bodies.push(code.slice(at, next === -1 ? code.length : at + 1 + next));
        from = at + 1;
    }
    assert.equal(bodies.length, 2, `expected 2 local branches (backup + restore), found ${bodies.length}`);
    for (const [i, body] of bodies.entries()) {
        assert.ok(
            !/davUrl|davUserName|webdav_not_configured/.test(body),
            `local branch #${i + 1} must not inherit the WebDav credential check`
        );
    }
});
