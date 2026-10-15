/**
 * 备份页阿里云盘扫码轮询的定时器泄漏（回归护栏）
 *
 * 背景（根因）：
 *   `useEffect` 里同步调用 `refreshQrCode()`，而它是 `async`：
 *       const p = refreshQrCode();   // 卡在 await aliyun.qrcode()
 *       return () => clearInterval(refreshTimer);
 *   若用户在「二维码请求在途」时切换备份类型 / 离开页面，cleanup 立刻执行，
 *   但此刻 `refreshTimer` 仍是 `null`——`clearInterval(null)` 什么都清不掉。
 *   等 `qrcode()` 返回，`pollingStatus()` 才开始 `setInterval`，于是留下一个
 *   **没有任何人负责回收**的 2 秒轮询：组件已卸载，它却会一直向阿里云发状态
 *   查询，并在已卸载组件上 setState。
 *
 * 这里**不测助手函数**，而是把 `src/window/Config/pages/Backup/index.jsx`
 * 里这两段的真实结构抽出来执行，用受控的 setInterval/clearInterval 观察
 * 最终哪些 timer 仍存活。修复前该文件缺失代次检查，测试会失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SOURCE = 'src/window/Config/pages/Backup/index.jsx';

/** 读真实源码，取出 refreshQrCode / cleanup 片段，断言关键结构确实存在。 */
async function loadSource() {
    const source = await readFile(SOURCE, 'utf8');
    return source;
}

test('cleanup 必须在创建轮询之前作废在途的 refreshQrCode', async () => {
    const source = await loadSource();
    // cleanup 里必须递增 refreshToken（作废在途初始化）+ 清 timer + 置 null
    const cleanup = source.slice(source.indexOf('return () => {'), source.indexOf('}, [backupType]);'));
    assert.match(cleanup, /refreshToken\s*\+=\s*1/, 'cleanup 必须递增 refreshToken 作废在途初始化');
    assert.match(cleanup, /clearInterval\(refreshTimer\)/, 'cleanup 必须清除当前 timer');
    assert.match(cleanup, /refreshTimer\s*=\s*null/, 'cleanup 必须把 refreshTimer 置回 null');

    // refreshQrCode 必须在 await 之后、pollingStatus 之前检查代次
    const qr = source.slice(source.indexOf('const refreshQrCode = async'), source.indexOf('const refreshUserInfo'));
    const awaitAt = qr.indexOf('await aliyun.qrcode()');
    const guardAt = qr.indexOf('token !== refreshToken');
    const pollAt = qr.indexOf('pollingStatus(sid)');
    assert.notEqual(awaitAt, -1, 'refreshQrCode 必须 await aliyun.qrcode()');
    assert.notEqual(guardAt, -1, 'refreshQrCode 必须检查代次是否过期');
    assert.notEqual(pollAt, -1, 'refreshQrCode 必须调用 pollingStatus');
    assert.ok(guardAt > awaitAt, '代次检查必须发生在 await（拿到二维码）之后');
    assert.ok(guardAt < pollAt, '代次检查必须发生在启动轮询之前——否则迟到的响应仍会创建 timer');
});

test('真实执行：直接从源码抽出 refreshQrCode 执行，迟到的响应不得创建轮询', async () => {
    // 关键：**不**在测试里复刻 refreshQrCode 的逻辑（round 53 的教训——
    // 测试自己重写生产流程会让变异全部逃逸）。这里把真实源码里的
    // refreshQrCode 函数体原样取出来，只把外部依赖注入进去。
    const source = await loadSource();
    const start = source.indexOf('const refreshQrCode = async');
    assert.notEqual(start, -1, 'refreshQrCode 必须存在');
    // 取到下一个顶层 `const xxx = async` 之前
    const rest = source.slice(start);
    const nextFn = rest.indexOf('\n    const refreshUserInfo');
    assert.notEqual(nextFn, -1, 'refreshQrCode 的结尾必须可界定');
    let fnSrc = rest.slice(0, nextFn);

    // 受控计时器 + 受控 await：记录 set/clear 顺序，最后算存活 id
    const events = [];
    let nextId = 0;
    let releaseQrcode;
    const qrcodeGate = new Promise((r) => (releaseQrcode = r));

    const deps = {
        setInterval: (fn, ms) => {
            const id = ++nextId;
            events.push({ op: 'set', id, ms });
            return id;
        },
        clearInterval: (id) => events.push({ op: 'clear', id }),
        aliyun: { qrcode: () => qrcodeGate.then(() => ({ url: 'u', sid: 's' })) },
        setAliyunQrCodeUrl: () => {},
        toast: { error: () => {} },
        t: (k) => k,
        toastStyle: {},
    };

    // refreshToken / refreshTimer 用真实源码里的模块级变量语义：
    // 修复版源码引用 `refreshToken` 与 `refreshTimer`，这里用受控对象承载。
    const state = { refreshTimer: null, refreshToken: 0 };
    deps.refreshTimer = state.refreshTimer;

    // 把源码里的 refreshTimer 读写重定向到 state
    fnSrc = fnSrc.replace(/\brefreshTimer\b/g, 'state.refreshTimer').replace(/\brefreshToken\b/g, 'state.refreshToken');

    const factory = new Function(
        'setInterval',
        'clearInterval',
        'aliyun',
        'setAliyunQrCodeUrl',
        'toast',
        't',
        'toastStyle',
        'state',
        'pollingStatus',
        `${fnSrc}
         return refreshQrCode;`
    );

    const pollingStatus = () => {
        state.refreshTimer = deps.setInterval(() => {}, 2000);
    };

    const refreshQrCode = factory(
        deps.setInterval,
        deps.clearInterval,
        deps.aliyun,
        deps.setAliyunQrCodeUrl,
        deps.toast,
        deps.t,
        deps.toastStyle,
        state,
        pollingStatus
    );

    // useEffect：同步发起，cleanup 同步跑
    const inflight = refreshQrCode();
    // cleanup 的真实结构：递增代次 + 清 timer + 置 null
    const cleanupSrc = source.slice(source.indexOf('return () => {'), source.indexOf('}, [backupType]);'));
    if (/refreshToken\s*\+=\s*1/.test(cleanupSrc)) {
        state.refreshToken += 1;
    }
    deps.clearInterval(state.refreshTimer);
    state.refreshTimer = null;

    releaseQrcode();
    await inflight;

    const alive = new Set();
    for (const e of events) {
        if (e.op === 'set') alive.add(e.id);
        else alive.delete(e.id);
    }
    assert.deepEqual(
        [...alive],
        [],
        `cleanup 之后不得再创建轮询，实际存活=${JSON.stringify([...alive])} 事件=${JSON.stringify(events)}`
    );
});
