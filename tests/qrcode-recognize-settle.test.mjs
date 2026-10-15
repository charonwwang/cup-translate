import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const QRCODE = 'src/services/recognize/qrcode/index.jsx';

/**
 * 背景（本轮实测）：`qrcode/index.jsx` 的 `recognize()` 里那个等待图片加载的
 * Promise **可能永不 settle**，而调用方没有任何超时兜底。
 *
 * 修复前的实现只有两个出口：
 *
 *     let ctx = canvas.getContext('2d');            // 可能返回 null
 *     let imgdata = await new Promise((resolve, reject) => {
 *         img.onload = () => {
 *             ctx.drawImage(img, 0, 0);             // ctx 为 null -> TypeError
 *             ...
 *         };
 *         img.onerror = () => { reject(...); };
 *     });
 *
 * 有两条路径会「既不 resolve 也不 reject」：
 *   a) `getContext('2d')` 返回 null（资源耗尽）-> onload 里抛 TypeError。
 *      该异常发生在**事件回调**内，不被 Promise 捕获，也不会 reject。
 *   b) 浏览器对畸形 data URL 既不派发 load 也不派发 error
 *      （WebKit 有此类静默丢弃行为）-> 两个回调都不触发。
 *
 * 后果不是报错，而是 `Recognize/TextArea/index.jsx` 里
 * `.then(成功, 失败)` 的**两个分支都不执行** -> `setLoading(false)` 永不调用
 * -> **识别窗口永远停在加载中**，用户看不到提示，也没有可恢复路径。
 *
 * **可达性诚实说明**：本机没有真实 GUI 会话，我**没有观察到**窗口真的卡住。
 * 能确证的只有两件事：
 *   1. 空 base64 这条路径**不可达** —— 调用点有 `base64 !== ''` 闸门
 *      （`Recognize/TextArea/index.jsx:67`），且 Rust `get_base64` 失败时
 *      返回空串（`cmd.rs:163/168/175`）会被该闸门拦下；
 *   2. `get_base64` **不做任何图片格式校验**（`cmd.rs:185` 只是把文件字节
 *      base64 编码），所以缓存文件损坏时确实会把非空垃圾字节送到这里。
 * 于是「Promise 有没有兜底出口」是本测试唯一能客观断言的东西 ——
 * 不断言浏览器一定会静默，只断言代码不再依赖「浏览器一定会派发事件」。
 */

function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * 按括号配平抽出函数体（不依赖缩进宽度）。
 *
 * ⚠️ 不能直接取签名后的第一个 `{` —— 形参里的默认值 `options = {}` 会先出现，
 * 配平会立刻在它的 `}` 处归零，抽出一个**空函数体**。本轮实测踩到过：
 * 表现为「正常路径返回 undefined」，看着像被测代码坏了，其实是抽取器坏了。
 * 因此先跳过形参括号，再从函数体那个 `{` 开始配平。
 */
function extractFunctionBody(source, signature) {
    const start = source.indexOf(signature);
    assert.notEqual(start, -1, `anchor missing: ${signature}`);
    // 跳过形参列表
    const parenOpen = source.indexOf('(', start);
    let pdepth = 0;
    let parenClose = -1;
    for (let i = parenOpen; i < source.length; i += 1) {
        if (source[i] === '(') pdepth += 1;
        else if (source[i] === ')') {
            pdepth -= 1;
            if (pdepth === 0) {
                parenClose = i;
                break;
            }
        }
    }
    assert.notEqual(parenClose, -1, 'unbalanced parentheses in the signature');
    const open = source.indexOf('{', parenClose);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) {
                const body = source.slice(open + 1, i);
                assert.ok(body.trim().length > 0, 'extracted an empty function body');
                return body;
            }
        }
    }
    throw new Error('unbalanced braces');
}

test('the image-load promise is guaranteed to settle', async () => {
    const code = stripComments(await readFile(QRCODE, 'utf8'));

    // 必须有超时出口
    assert.match(code, /setTimeout\(\(\) => \{/, 'a timeout fallback is required so the promise always settles');
    assert.match(code, /clearTimeout\(timer\)/, 'the timer must be cleared once settled');
    // 必须有「只 settle 一次」的守卫
    assert.match(code, /let settled = false;/, 'a settled flag prevents double-settling');
    assert.match(code, /if \(settled\) return;/, 'late callbacks must be ignored');
    // 守卫必须在**正确的两个位置**上，而不是「存在即可」。
    // 本轮变异测试暴露过这个缺口：只删掉 finish() 里的守卫时，上面两条
    // 「存在性」断言依然通过（超时回调里还留着一个同款守卫），于是变异逃逸。
    // 分别断言两处：
    assert.match(
        code,
        /const finish = \(fn, value\) => \{\s*if \(settled\) return;/,
        'the guard must be the first thing inside finish()'
    );
    assert.match(
        code,
        /setTimeout\(\(\) => \{\s*if \(settled\) return;/,
        'the guard must be the first thing inside the timeout callback'
    );
    // onload 内部必须被 try/catch 包住，否则异常会逃逸且 promise 永不 settle
    assert.match(code, /img\.onload = \(\) => \{\s*try \{/, 'onload must catch its own exceptions');
    // ctx 必须显式校验
    assert.match(code, /if \(!ctx\) \{/, 'a null 2D context must be rejected up front');
    // drawImage 必须在 try 块内（上面已断言 onload 有 try）；
    // 这里断言「try {」确实包住了 drawImage，而不是包住别的东西
    assert.match(
        code,
        /img\.onload = \(\) => \{\s*try \{[\s\S]*?ctx\.drawImage\(/,
        'drawImage must sit inside the try block'
    );
    // 模块级常量必须定义（否则抽出来执行时会 ReferenceError）
    assert.match(code, /const IMAGE_LOAD_TIMEOUT_MS = \d+;/, 'the timeout constant must be defined');
});

/** 用真实源码体构造可调用函数，注入可控的 DOM 替身。 */
function buildRecognize(source, { timeoutMs } = {}) {
    const body = extractFunctionBody(source, 'export async function recognize(');
    // 模块级常量也要带进来，否则抽出函数体执行时会 ReferenceError。
    // 生产值是 10s；测试里可覆盖成一个很短的值，否则「等超时」的用例
    // 会超出测试自己的等待窗口（本轮实测踩到过，会被误报成「挂起」）。
    //
    // 这里**不**断言常量必须存在：修复前的源码没有这个常量，若在此断言，
    // 行为用例就会因为「常量缺失」而提前失败，**根本跑不到真正的症状**（挂起），
    // 证据就变成「结构断言失败」而不是「真的会卡住」。缺常量时回退成
    // 「永不超时」（一个极大值），让用例如实暴露修复前的挂起行为。
    const m = source.match(/const IMAGE_LOAD_TIMEOUT_MS = (\d+);/);
    const effective = timeoutMs === undefined ? (m ? m[1] : Number.MAX_SAFE_INTEGER) : timeoutMs;
    const shim = `
        return async function recognize(base64, language, options = {}) {
            const IMAGE_LOAD_TIMEOUT_MS = ${effective};
            const jsQR = (data, w, h) => globalThis.__qr(data, w, h);
            ${body}
        };
    `;
    return new Function(shim)();
}

/** 造一个可控的 canvas / Image 替身。 */
function installDom({ contextNull = false, fire = 'load', drawThrows = false } = {}) {
    const handlers = {};
    const ctx = {
        drawImage() {
            if (drawThrows) throw new Error('drawImage blew up');
        },
        getImageData() {
            return { data: new Uint8ClampedArray(16) };
        },
    };
    globalThis.document = {
        createElement() {
            return { getContext: () => (contextNull ? null : ctx), width: 0, height: 0 };
        },
    };
    globalThis.Image = class {
        constructor() {
            // 让 setter 触发事件，模拟「加载完成 / 加载失败 / 什么都不发生」
            Object.defineProperty(this, 'src', {
                set() {
                    if (fire === 'load') {
                        this.width = 4;
                        this.height = 4;
                        queueMicrotask(() => handlers.load && handlers.load());
                    } else if (fire === 'error') {
                        queueMicrotask(() => handlers.error && handlers.error());
                    }
                    // fire === 'silent' -> 两个事件都不派发
                },
            });
        }
        set onload(fn) {
            handlers.load = fn;
        }
        set onerror(fn) {
            handlers.error = fn;
        }
    };
    globalThis.__qr = () => ({ data: 'hello-qr' });
    return handlers;
}

/**
 * 用 `Promise.race` 把「永不 settle」变成可断言的失败。
 *
 * 注意：`Promise.race` 只能反映「谁先完成」。当被测代码真的永不 settle 时，
 * 只有这个 watch（setTimeout）会完成，于是我们拿到 `{hung:true}` 并断言失败 ——
 * 这正是我们要的。但若被测代码内部**也**用了计时器兜底，就取决于两者谁更短，
 * 所以调用方必须保证 watch 比被测代码的超时长（见下）。
 */
function raceWithWatchdog(promise, watchMs) {
    return Promise.race([
        promise.then(
            (v) => ({ ok: true, v }),
            (e) => ({ ok: false, e: String(e) })
        ),
        new Promise((r) => setTimeout(() => r({ hung: true }), watchMs)),
    ]);
}

test('real recognize(): a corrupt image that never fires any event still rejects', async () => {
    const source = await readFile(QRCODE, 'utf8');
    installDom({ fire: 'silent' });
    // 生产常量是 10s（「绝不挂死」而非「够快」）。**只有当源码里确实存在
    // 这个常量时**才注入一个更短的值让用例跑得快 —— 若修复前的源码没有它，
    // 就不注入，让它按「没有超时」运行，用例于是如实报告「挂起」。
    const hasTimeoutConst = /const IMAGE_LOAD_TIMEOUT_MS = \d+;/.test(source);
    const recognize = buildRecognize(source, hasTimeoutConst ? { timeoutMs: 50 } : {});

    const settled = await raceWithWatchdog(recognize('AAAA', 'auto'), 2000);
    assert.equal(settled.hung, undefined, 'recognize() hung: the load promise never settled');
    assert.equal(settled.ok, false, 'a never-firing image must reject, not resolve');
    assert.match(settled.e, /Timed out/);
});

test('real recognize(): an exception inside onload becomes a rejection, not a hang', async () => {
    const source = await readFile(QRCODE, 'utf8');
    installDom({ fire: 'load', drawThrows: true });
    const recognize = buildRecognize(source);

    const settled = await raceWithWatchdog(recognize('AAAA', 'auto'), 2000);
    assert.equal(settled.hung, undefined, 'recognize() hung instead of rejecting');
    assert.equal(settled.ok, false);
    assert.match(settled.e, /Failed to decode image/);
});

test('real recognize(): a null 2D context rejects immediately', async () => {
    const source = await readFile(QRCODE, 'utf8');
    installDom({ contextNull: true });
    const recognize = buildRecognize(source);

    const settled = await raceWithWatchdog(recognize('AAAA', 'auto'), 2000);
    assert.equal(settled.hung, undefined, 'a null context must not hang');
    assert.equal(settled.ok, false);
    assert.match(settled.e, /2D canvas context/);
});

test('real recognize(): the happy path and the error path still work', async () => {
    const source = await readFile(QRCODE, 'utf8');

    // 正常解码
    installDom({ fire: 'load' });
    const recognize = buildRecognize(source);
    assert.equal(await recognize('AAAA', 'auto'), 'hello-qr');

    // 图片加载失败
    installDom({ fire: 'error' });
    const recognize2 = buildRecognize(source);
    await assert.rejects(
        () => recognize2('AAAA', 'auto'),
        (e) => {
            assert.match(String(e), /Failed to load image/);
            return true;
        }
    );

    // 解码失败（jsQR 返回 null）
    installDom({ fire: 'load' });
    globalThis.__qr = () => null;
    const recognize3 = buildRecognize(source);
    await assert.rejects(
        () => recognize3('AAAA', 'auto'),
        (e) => {
            assert.match(String(e), /not recognized/);
            return true;
        }
    );
});
