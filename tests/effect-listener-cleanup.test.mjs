/**
 * useEffect 全局监听器必须注销（架构级护栏）
 *
 * 为什么要有这条：round 62 在 App.jsx 修了一个真实缺陷——
 * `[devMode]` 的 effect 用**匿名**函数给 document 注册 keydown 且没有 cleanup。
 * 由于 useConfig 的 state 初值是 null、磁盘值异步写入，effect 每次挂载都会
 * 重跑一次（`Object.is(null, false) === false`），于是监听器累积、按一次
 * Escape 会调用两次 appWindow.close()，卸载后监听器仍附着。
 *
 * 那次是靠人肉审查发现的。这条护栏把它变成**自动化**规则：
 * 扫描 src/ 下所有 useEffect，凡是给 document/window 注册监听器的，
 * 必须①用具名函数②在同一次 effect 的 cleanup 里 removeEventListener。
 *
 * 规则已在两个方向验证：
 *   · round 62 修复前的 App.jsx -> 报 3 条违规（能失败）
 *   · 当前仓库 -> 0 条（不误报）
 *   · 另有 5 个人工构造样本自检（匿名/无 cleanup/块体/表达式体/注释）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';

/** 去掉注释：避免「注释里提到 addEventListener」造成假阳性。 */
function stripComments(source) {
    return source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 括号配平地取出每个 useEffect(...) 的完整调用块。 */
function effects(source) {
    const out = [];
    const re = /useEffect\s*\(/g;
    let m;
    while ((m = re.exec(source)) !== null) {
        const start = m.index;
        const i = m.index + m[0].length - 1;
        let depth = 0;
        let j = i;
        for (; j < source.length; j++) {
            if (source[j] === '(') depth += 1;
            else if (source[j] === ')') {
                depth -= 1;
                if (depth === 0) break;
            }
        }
        out.push({ start, body: source.slice(i, j + 1) });
    }
    return out;
}

const GLOBAL_ADD = /(document|window)\.addEventListener\(\s*'([^']+)'\s*,\s*([A-Za-z_$][\w$]*)/g;
const ANON_ADD = /(document|window)\.addEventListener\(\s*'[^']+'\s*,\s*(async\s*)?\(/;

function violations(source) {
    const code = stripComments(source);
    const bad = [];
    for (const { start, body } of effects(code)) {
        const line = code.slice(0, start).split('\n').length;

        if (ANON_ADD.test(body)) {
            bad.push({ line, why: '用匿名函数注册全局监听器（无法注销）' });
        }

        const adds = [];
        GLOBAL_ADD.lastIndex = 0;
        let g;
        while ((g = GLOBAL_ADD.exec(body)) !== null) {
            adds.push({ target: g[1], event: g[2], handler: g[3], offset: g.index });
        }
        // 带括号参数列表的匿名箭头函数（`(e) => {}` / `async (e) => {}`）
        // 不被 GLOBAL_ADD 匹配（它要求标识符形式的 handler），
        // 但它同样是匿名、无法注销——补记一条「未注销」违规。
        // 注意只补 GLOBAL_ADD **没覆盖到**的那些位置，避免同一次注册被计两次。
        const covered = new Set(adds.map((a) => a.offset));
        const parenAnon = /(document|window)\.addEventListener\(\s*'([^']+)'\s*,\s*(?:async\s*)?\(/g;
        let p2;
        while ((p2 = parenAnon.exec(body)) !== null) {
            if (covered.has(p2.index)) continue;
            adds.push({ target: p2[1], event: p2[2], handler: null, offset: p2.index });
        }

        // cleanup 有块体与表达式体两种写法，都要认
        const retBlock = body.match(/return\s*\(\s*\)\s*=>\s*\{[\s\S]*?\}/);
        const retExpr = body.match(/return\s*\(\s*\)\s*=>[^;]*;/);
        const cleanup = [retBlock ? retBlock[0] : '', retExpr ? retExpr[0] : ''].join('\n');

        for (const a of adds) {
            if (a.handler === null) {
                // 匿名注册：既然连引用都没有，cleanup 里不可能按引用注销
                const anyRemove = new RegExp(`${a.target}\\.removeEventListener\\(\\s*'${a.event}'`);
                if (!anyRemove.test(cleanup)) {
                    bad.push({ line, why: `注册 ${a.target} '${a.event}' 后未在 cleanup 中注销` });
                }
                continue;
            }
            const pat = new RegExp(`${a.target}\\.removeEventListener\\(\\s*'${a.event}'\\s*,\\s*${a.handler}`);
            if (!pat.test(cleanup)) {
                bad.push({ line, why: `注册 ${a.target} '${a.event}' 后未在 cleanup 中注销` });
            }
        }
    }
    return bad;
}

test('self-check: 规则必须能抓到已知坏形态、且不误报好形态', () => {
    const cases = [
        [
            '具名 + 表达式体 cleanup',
            `useEffect(() => { const h=()=>{}; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [x]);`,
            0,
        ],
        [
            '具名 + 块体 cleanup',
            `useEffect(() => { const h=()=>{}; document.addEventListener('keydown', h); return () => { document.removeEventListener('keydown', h); }; }, [x]);`,
            0,
        ],
        // 匿名注册会同时命中两条规则：「匿名（无法注销）」+「未在 cleanup 中注销」。
        // 这不是重复计数，而是两个独立事实——期望值就是 2，规则行为正确。
        ['匿名注册', `useEffect(() => { document.addEventListener('keydown', async () => {}); }, [x]);`, 2],
        ['具名但无 cleanup', `useEffect(() => { const h=()=>{}; document.addEventListener('keydown', h); }, [x]);`, 1],
        ['注释里出现 addEventListener', `useEffect(() => { /* document.addEventListener('keydown', h) */ }, [x]);`, 0],
        ['window 而非 document', `useEffect(() => { window.addEventListener('resize', (e) => {}); }, [x]);`, 2],
    ];
    for (const [name, src, expected] of cases) {
        const v = violations(src);
        assert.equal(
            v.length,
            expected,
            `样本「${name}」期望 ${expected} 条违规，实际 ${v.length}：${JSON.stringify(v)}`
        );
    }
});

test('src/ 下每个 useEffect 注册的全局监听器都必须注销', async () => {
    const files = [];
    for (const pattern of ['src/**/*.jsx', 'src/**/*.js']) {
        for await (const f of glob(pattern)) files.push(f);
    }
    assert.ok(files.length > 50, `应当扫到整个源码树，实际只扫到 ${files.length} 个文件`);

    const all = [];
    for (const f of files) {
        const src = await readFile(f, 'utf8');
        for (const v of violations(src)) all.push(`${f}:${v.line} ${v.why}`);
    }
    assert.deepEqual(all, [], `存在未注销的全局监听器：\n${all.join('\n')}`);
});
