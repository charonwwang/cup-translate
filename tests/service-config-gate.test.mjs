import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import { isServiceConfigured } from '../src/services/translate/required_config.js';

/**
 * isServiceConfigured() 是**每次翻译前的前置闸门**（TargetArea:197）：
 * 返回 false 的引擎会被直接跳过、不发请求。
 *
 * 因此它判错的两个方向都有真实后果：
 *   · 该 true 判成 false -> 用户明明配好了却被告知「未配置」，翻译被跳过
 *   · 该 false 判成 true -> 拿空配置去发请求，得到看不懂的接口报错
 *
 * 它是纯 .js，可以直接 import 真实执行——所以这些测试跑的是**线上同一份实现**，
 * 不是复刻出来的逻辑。
 */

test('engines that need no credentials are usable out of the box', async () => {
    // 这些是免 API key 的引擎，空配置也必须可用，否则新用户开箱即错
    for (const engine of ['google', 'yandex', 'transmart', 'bing_dict', 'cambridge_dict', 'local_mt']) {
        assert.equal(
            isServiceConfigured(engine, {}),
            true,
            `'${engine}' is a key-free engine and must be usable with an empty config`
        );
    }
});

test('engines that require credentials are rejected until fully configured', async () => {
    // [引擎, 必需项] —— 与 required_config.js 的登记保持一致
    const cases = [
        ['alibaba', ['accesskey_id', 'accesskey_secret']],
        ['baidu', ['appid', 'secret']],
        ['baidu_field', ['appid', 'secret']],
        ['caiyun', ['token']],
        ['geminipro', ['apiKey', 'requestPath']],
        ['niutrans', ['apikey']],
        // openai 必须同时要地址和密钥：它只有 openai / azure 两档托管服务，
        // 没有「本地免 key」选项，缺 apiKey 时请求必然 401（已实测）。
        ['openai', ['requestPath', 'apiKey']],
        // ollama 则相反——它本来就是本地服务，requestPath 就是全部所需。
        ['ollama', ['requestPath']],
        ['tencent', ['secret_id', 'secret_key']],
        ['volcengine', ['appid', 'secret']],
        ['youdao', ['appkey', 'key']],
    ];

    for (const [engine, keys] of cases) {
        assert.equal(isServiceConfigured(engine, {}), false, `'${engine}' must be unconfigured when empty`);

        // 少任意一项都必须仍判为未配置（逐项缺省，防止「只检查第一项」这类回归）
        for (const missing of keys) {
            const partial = {};
            for (const key of keys) {
                if (key !== missing) partial[key] = 'filled';
            }
            assert.equal(
                isServiceConfigured(engine, partial),
                false,
                `'${engine}' must stay unconfigured when '${missing}' is absent`
            );
        }

        // 全部填上才算配置齐全
        const full = {};
        for (const key of keys) full[key] = 'filled';
        assert.equal(isServiceConfigured(engine, full), true, `'${engine}' must be configured once every key is set`);
    }
});

test('a non-string or empty value never counts as configured', async () => {
    // 只判「存在」是不够的：数字 / 对象 / 空串都应当算未配置。
    // 若有人把 `typeof x === 'string' && x !== ''` 简化成 `x != null`，
    // 空配置就会通过闸门并发出无效请求。
    for (const value of ['', 0, 123, true, false, {}, [], null, undefined]) {
        assert.equal(
            isServiceConfigured('ollama', { requestPath: value }),
            false,
            `ollama.requestPath = ${JSON.stringify(value)} must not count as configured`
        );
    }
    // 非空字符串才算配置
    assert.equal(isServiceConfigured('ollama', { requestPath: 'http://127.0.0.1:11434' }), true);
});

test('a missing or null instance config is handled without throwing', async () => {
    // 全新实例的配置可能还没落盘（null）；此处不能抛错
    assert.equal(isServiceConfigured('openai', null), false);
    assert.equal(isServiceConfigured('openai', undefined), false);
    assert.equal(isServiceConfigured('ollama', null), false);
    assert.equal(isServiceConfigured('ollama', undefined), false);
    assert.equal(isServiceConfigured('google', null), true);
    assert.equal(isServiceConfigured('google', undefined), true);
});

test('deepl requires an explicit type and the matching credential', async () => {
    // 历史事故：空配置的 deepl 曾默认走免 key 端点，该端点实测已被 429 封禁。
    // 因此「没选类型」必须视为未配置，而不是默默走 free。
    assert.equal(isServiceConfigured('deepl', {}), false, 'deepl with no type must NOT silently use free');

    assert.equal(isServiceConfigured('deepl', { type: 'free' }), true);

    assert.equal(isServiceConfigured('deepl', { type: 'api' }), false);
    assert.equal(isServiceConfigured('deepl', { type: 'api', authKey: '' }), false);
    assert.equal(isServiceConfigured('deepl', { type: 'api', authKey: 'k' }), true);

    assert.equal(isServiceConfigured('deepl', { type: 'deeplx' }), false);
    assert.equal(isServiceConfigured('deepl', { type: 'deeplx', customUrl: '' }), false);
    assert.equal(isServiceConfigured('deepl', { type: 'deeplx', customUrl: 'http://x' }), true);

    // 未知类型按未配置处理（不要因为写错大小写就悄悄放行）
    assert.equal(isServiceConfigured('deepl', { type: 'Free' }), false);
    assert.equal(isServiceConfigured('deepl', { type: 'nonsense' }), false);
});

test('chatglm requires the two-part id.secret key format', async () => {
    assert.equal(isServiceConfigured('chatglm', {}), false);
    assert.equal(isServiceConfigured('chatglm', { apiKey: '' }), false);
    assert.equal(isServiceConfigured('chatglm', { apiKey: 'no-dot' }), false);
    assert.equal(isServiceConfigured('chatglm', { apiKey: '12' }), false, 'a number is not a key');
    assert.equal(isServiceConfigured('chatglm', { apiKey: 'id.secret' }), true);
});

test('plugin engines are never blocked by the builtin config check', async () => {
    // 插件的配置由插件自己管，这里必须放行，否则插件永远无法调用。
    // 注意实例键形如 `plugin-xxx@id`，服务名以 plugin 开头。
    for (const key of ['plugin-translate-demo', 'plugin-translate-demo@abc123']) {
        assert.equal(
            isServiceConfigured(key, {}),
            true,
            `'${key}' is a plugin instance and must not be gated by builtin rules`
        );
    }
});

test('the required-key table stays in sync with the registered engines', async () => {
    // 结构性护栏：登记表里出现的引擎必须真的存在；
    // 反过来，导出但**不做配置检查**的引擎必须是「确实不需要配置」的白名单之一。
    const source = await readFile('src/services/translate/required_config.js', 'utf8');
    const listBody = source.slice(
        source.indexOf('const REQUIRED_CONFIG_KEYS'),
        source.indexOf('};', source.indexOf('const REQUIRED_CONFIG_KEYS'))
    );
    const registered = new Set([...listBody.matchAll(/^\s*(\w+):\s*\[/gm)].map((m) => m[1]));
    // SPECIAL_CONFIG_CHECK 是函数式的，单独抽
    const specialBody = source.slice(
        source.indexOf('const SPECIAL_CONFIG_CHECK'),
        source.indexOf('};', source.indexOf('const SPECIAL_CONFIG_CHECK'))
    );
    for (const m of specialBody.matchAll(/^\s*(\w+):\s*\(/gm)) registered.add(m[1]);

    const indexSource = await readFile('src/services/translate/index.jsx', 'utf8');
    const engines = new Set([...indexSource.matchAll(/^export const (\w+) =/gm)].map((m) => m[1]));
    assert.ok(engines.size >= 18, `expected ~19 engines, found ${engines.size}`);

    // 登记表里不能有拼错的引擎名（拼错等于静默不生效）
    const unknown = [...registered].filter((e) => !engines.has(e));
    assert.deepEqual(unknown, [], `these entries in required_config.js are not real engines: ${unknown.join(', ')}`);

    // 未登记的引擎必须是明确「无需配置」的那批。
    // 新增引擎时如果忘了登记，这里会提醒——而不是等到用户端报「未配置」或发无效请求。
    const NO_CONFIG_NEEDED = new Set([
        'google', // custom_url 可选，缺省走内置端点
        'yandex', // 免 key
        'transmart', // 匿名可用（transmart/index.jsx 里 username/token 为空时不加认证头）
        'bing_dict', // 免 key
        'cambridge_dict', // 免 key
        'local_mt', // threads 可选，缺省 4
    ]);
    const unregistered = [...engines].filter((e) => !registered.has(e));
    const unexpected = unregistered.filter((e) => !NO_CONFIG_NEEDED.has(e));
    assert.deepEqual(
        unexpected,
        [],
        `these engines have no entry in required_config.js and are not on the "needs no config" list: ${unexpected.join(', ')}`
    );
});

test('every registered engine documents which config keys it needs', async () => {
    // 登记表里的 key 必须真的出现在该引擎的 Config.jsx 中（拼错就等于没登记）
    const source = await readFile('src/services/translate/required_config.js', 'utf8');
    const listBody = source.slice(
        source.indexOf('const REQUIRED_CONFIG_KEYS'),
        source.indexOf('};', source.indexOf('const REQUIRED_CONFIG_KEYS'))
    );
    const entries = [...listBody.matchAll(/(\w+):\s*\[([^\]]*)\]/g)].map((m) => [
        m[1],
        [...m[2].matchAll(/'([^']+)'/g)].map((k) => k[1]),
    ]);

    for (const [engine, keys] of entries) {
        const configSource = await readFile(`src/services/translate/${engine}/Config.jsx`, 'utf8');
        for (const key of keys) {
            assert.ok(
                configSource.includes(key),
                `'${engine}' declares '${key}' as required but its Config.jsx never mentions it`
            );
        }
    }
});

test('the engine list contains no leftover files from deleted engines', async () => {
    // CLAUDE.md §3.2：bing / ecdict / lingva 已删除，不应再出现在注册表里
    const indexSource = await readFile('src/services/translate/index.jsx', 'utf8');
    for (const dead of ['bing', 'ecdict', 'lingva']) {
        assert.equal(
            new RegExp(`^export const ${dead} =`, 'm').test(indexSource),
            false,
            `'${dead}' was removed from the codebase and must not be re-registered`
        );
    }

    const dirs = await readdir('src/services/translate', { withFileTypes: true });
    const names = dirs.filter((d) => d.isDirectory()).map((d) => d.name);
    for (const dead of ['bing', 'ecdict', 'lingva']) {
        assert.ok(!names.includes(dead), `the deleted engine directory '${dead}' is back`);
    }
});

test('no engine reads a credential that the gate does not require', async () => {
    // 这条护栏针对本轮发现的缺口：openai 的 index.jsx 用 apiKey 组装
    // `Authorization: Bearer ${apiKey}`，但登记表只要求 requestPath，
    // 于是空密钥的实例被判为「已配置」并真的发请求（实测 401）——
    // 正是 TargetArea 注释里写的「不发无效请求」要避免的情况。
    //
    // 做法：从每个已登记引擎的 index.jsx 里抽出它**解构出来的配置键**，
    // 凡是名字看起来是凭据的（key/token/secret/password…），
    // 就必须出现在该引擎的必需项里（或者显式列在下面的豁免表中）。
    const CREDENTIAL_LIKE = /^(?:.*(?:apiKey|authKey|token|secret|password|apikey|accesskey|appid|appkey|key))$/i;
    const source = await readFile('src/services/translate/required_config.js', 'utf8');
    const listBody = source.slice(
        source.indexOf('const REQUIRED_CONFIG_KEYS'),
        source.indexOf('};', source.indexOf('const REQUIRED_CONFIG_KEYS'))
    );
    const registered = new Map(
        [...listBody.matchAll(/(\w+):\s*\[([^\]]*)\]/g)].map((m) => [
            m[1],
            new Set([...m[2].matchAll(/'([^']+)'/g)].map((k) => k[1])),
        ])
    );

    // 某些引擎的凭据是可选的（空值时走免认证路径），这些需要显式豁免并说明理由。
    const OPTIONAL_CREDENTIALS = new Set([
        'transmart.username', // 空时匿名可用
        'transmart.token',
    ]);

    const offenders = [];
    for (const [engine, required] of registered) {
        const impl = await readFile(`src/services/translate/${engine}/index.jsx`, 'utf8');
        // 取 `let { a, b, c } = config;` / `const { ... } = config` 里的键
        const names = new Set();
        for (const m of impl.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*config/g)) {
            for (const raw of m[1].split(',')) {
                const name = raw.trim().split(/[:=]/)[0].trim();
                if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
            }
        }
        for (const name of names) {
            if (!CREDENTIAL_LIKE.test(name)) continue;
            if (required.has(name)) continue;
            if (OPTIONAL_CREDENTIALS.has(`${engine}.${name}`)) continue;
            offenders.push(`${engine} reads config.${name} but the gate does not require it`);
        }
    }

    assert.deepEqual(
        offenders,
        [],
        `these engines can send unauthenticated requests because the gate lets them through:\n${offenders.join('\n')}`
    );
});

test('every registered engine really rejects the default instance config', async () => {
    // 端到端一点：对每个登记了必需项的引擎，用它的 Config.jsx 默认值构造配置，
    // 断言闸门判为「未配置」。默认值 = 用户新建实例后、什么都还没填的状态。
    const source = await readFile('src/services/translate/required_config.js', 'utf8');
    const listBody = source.slice(
        source.indexOf('const REQUIRED_CONFIG_KEYS'),
        source.indexOf('};', source.indexOf('const REQUIRED_CONFIG_KEYS'))
    );
    const engines = [...listBody.matchAll(/(\w+):\s*\[/g)].map((m) => m[1]);

    for (const engine of engines) {
        const configSource = await readFile(`src/services/translate/${engine}/Config.jsx`, 'utf8');
        // 抽出 useConfig 的默认值对象里的 `key: ''` 形式（空串即未填写）
        const emptyKeys = new Set([...configSource.matchAll(/(\w+):\s*''/g)].map((m) => m[1]));
        const required = new Set(
            (listBody.match(new RegExp(`${engine}:\\s*\\[([^\\]]*)\\]`))?.[1] ?? '').matchAll(/'([^']+)'/g)
        );
        const requiredKeys = [...required].map((m) => m[1]);
        if (requiredKeys.length === 0) continue;

        // 只要其中任一必需项在默认值里是空串，默认实例就必须被判为未配置
        const hasEmptyRequired = requiredKeys.some((k) => emptyKeys.has(k));
        if (!hasEmptyRequired) continue;
        assert.equal(
            isServiceConfigured(engine, Object.fromEntries(requiredKeys.map((k) => [k, '']))),
            false,
            `'${engine}' has empty defaults for its required keys but the gate accepts them`
        );
    }
});
