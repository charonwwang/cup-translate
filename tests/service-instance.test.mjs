import assert from 'node:assert/strict';
import test from 'node:test';

// 直接 import **生产代码**（src/utils/service_instance_core.js）。
// 该模块此前是 service_instance.ts 的一部分，含 `enum` 而 Node 24 只做
// type-stripping，无法加载，于是这些被约 50 处 UI 依赖的纯逻辑没有任何测试。
// 抽到 .js 后这里无需任何语法改写——round 53 的教训是：
// 在测试里重抄一份实现等于没测，必须调用真实代码。
import {
    INSTANCE_NAME_CONFIG_KEY,
    createServiceInstanceKey,
    getDisplayInstanceName,
    getServiceName,
    getServiceSouceType,
    whetherAvailableService,
    whetherPluginService,
} from '../src/utils/service_instance_core.js';
import { validPluginName } from '../src/utils/plugin_validation.js';

const BUILDIN = 'buildin';
const PLUGIN = 'plugin';

const AVAILABLE = {
    buildin: { google: { info: {} }, yandex: { info: {} } },
    plugin: { 'plugin-demo': { icon: 'a' }, plugin_openai_2: { icon: 'b' } },
};

test('getServiceName takes the part before @ (and tolerates missing/extra @)', () => {
    assert.equal(getServiceName('google'), 'google');
    assert.equal(getServiceName('google@abc123'), 'google');
    assert.equal(getServiceName('plugin-demo@xyz'), 'plugin-demo');
    // 多个 @ 只切第一个（早期版本没有 @id，故单段 key 也要能取到）
    assert.equal(getServiceName('plugin-demo@a@b'), 'plugin-demo');
    // 空串不会 panic（split 至少产出一个元素）
    assert.equal(getServiceName(''), '');
});

test('a key is only reported as a plugin when its name could really be loaded', () => {
    for (const key of ['plugin-demo', 'plugin-demo@x', 'plugin_openai_2@y']) {
        assert.equal(getServiceSouceType(key), PLUGIN, key);
    }
    for (const key of ['google', 'google@x', 'yandex']) {
        assert.equal(getServiceSouceType(key), BUILDIN, key);
    }
});

// 本轮修复的核心契约：修复前只判 `startsWith('plugin')`，比加载插件时用的
// `validPluginName` 宽松，于是这些「永远加载不了」的名字被判为 PLUGIN，
// 随后各调用点无守卫地索引 `pluginList[name].icon` / `.language`，
// 抛 TypeError 打挂窗口渲染（已实测复现该 TypeError）。
test('names that can never be loaded are not classified as plugins', () => {
    for (const key of ['plugin..@x', 'plugin$a@x', 'plugin/x@x', 'plugin @x', 'plugin\\evil@x']) {
        assert.equal(getServiceSouceType(key), BUILDIN, `${key} cannot be loaded, so it must not be a plugin`);
    }
    // 反例：`plugin@x` 的名字是 'plugin'，通过 validPluginName，应判为 PLUGIN
    assert.equal(getServiceSouceType('plugin@x'), PLUGIN);
});

test('the plugin classification is exactly as strict as validPluginName', () => {
    const keys = [
        'plugin-demo',
        'plugin@x',
        'plugin..@x',
        'plugin$a@x',
        'plugin/x@x',
        'plugin @x',
        'Plugin-demo@x',
        'pluginfoo@x',
        'google@x',
        '',
        '@onlyid',
    ];
    for (const key of keys) {
        const expected = validPluginName(getServiceName(key)) ? PLUGIN : BUILDIN;
        assert.equal(getServiceSouceType(key), expected, `classification of ${JSON.stringify(key)}`);
    }
});

test('whetherPluginService agrees with getServiceSouceType', () => {
    for (const key of ['plugin-demo@x', 'plugin..@x', 'google@x', 'plugin']) {
        assert.equal(whetherPluginService(key), getServiceSouceType(key) === PLUGIN, key);
    }
});

test('whetherAvailableService rejects keys that are not really available', () => {
    assert.equal(whetherAvailableService('google@x', AVAILABLE), true);
    assert.equal(whetherAvailableService('plugin-demo@x', AVAILABLE), true);
    for (const key of ['plugin..@x', 'plugin-missing@x', 'nosuch@x', '', '@onlyid']) {
        assert.equal(whetherAvailableService(key, AVAILABLE), false, key);
    }
});

test('whetherAvailableService tolerates a missing source-type bucket', () => {
    // 缺 plugin / buildin 桶时不能抛（`?.` 保护）
    assert.equal(whetherAvailableService('plugin-demo@x', { buildin: {} }), false);
    assert.equal(whetherAvailableService('google@x', { plugin: {} }), false);
});

test('createServiceInstanceKey always produces a name@id pair', () => {
    const key = createServiceInstanceKey('plugin-demo');
    assert.match(key, /^plugin-demo@[a-z0-9]+$/);
    assert.equal(getServiceName(key), 'plugin-demo');
    assert.notEqual(key, createServiceInstanceKey('plugin-demo'));
});

test('getDisplayInstanceName falls back to the supplier only when empty', () => {
    assert.equal(
        getDisplayInstanceName('My Instance', () => 'fallback'),
        'My Instance'
    );
    assert.equal(
        getDisplayInstanceName('', () => 'fallback'),
        'fallback'
    );
});

test('INSTANCE_NAME_CONFIG_KEY matches the key used by the UI', () => {
    assert.equal(INSTANCE_NAME_CONFIG_KEY, 'instanceName');
});

// 结构性护栏：判据必须来自共享的 validPluginName，而不是在本模块里另写一套。
// 否则两边会再次漂移——这正是本轮缺陷的成因（round 47/50 的同类护栏思路）。
test('the plugin test is delegated to the shared validPluginName', async () => {
    const raw = await import('node:fs').then((fs) =>
        fs.readFileSync(new URL('../src/utils/service_instance_core.js', import.meta.url), 'utf8')
    );
    // 必须**先剥掉注释**再扫描：本文件的说明性注释里就写着
    // `startsWith('plugin')`（用来解释修复了什么），不剥注释会被自己注释绊倒
    // ——round 44/47 记过的同一个坑。
    const source = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const flattened = source.replace(/\s+/g, ' ');
    assert.ok(
        flattened.includes("validPluginName(serviceInstanceKey.split('@')[0])"),
        'getServiceSouceType must delegate to the shared validPluginName'
    );
    assert.ok(!/startsWith\(['"]plugin['"]\)/.test(source), 'the loose startsWith check must not come back');
});
