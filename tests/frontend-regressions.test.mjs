import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('language swap uses a declared variable', async () => {
    // 曾经的 bug：setTargetLanguage(secondLanguage) 里 secondLanguage 从未声明
    // （只有 Config 页面的另一个组件有同名变量），按下交换按钮抛 ReferenceError，
    // 目标语言静默不变。构建期发现不了（在 onPress 回调里，运行时才触发）。
    const source = await readFile('src/window/Translate/components/LanguageArea/index.jsx', 'utf8');

    assert.doesNotMatch(source, /\bsecondLanguage\b/, 'LanguageArea must not reference an undeclared secondLanguage');

    // 声明的变量名是 translateSecondLanguage，交换逻辑必须用它
    const declared = [...source.matchAll(/const\s*\[(\w+)\]/g)].map((m) => m[1]);
    assert.ok(declared.includes('translateSecondLanguage'), 'translateSecondLanguage must be declared');
    assert.match(source, /setTargetLanguage\(translateSecondLanguage\)/);
});

test('input-translate clears the source atom, not just local state', async () => {
    // 曾经的 bug：setSourceText('', true) —— setSourceText 来自 useSyncAtom，
    // 是普通 useState setter（只接受一个参数，第二个参数被忽略），
    // 且不会写回 sourceTextAtom。结果输入框视觉上清空了，
    // 但 TargetArea 读到的 atom 还是旧文本，继续显示上一次的译文。
    const source = await readFile('src/window/Translate/components/SourceArea/index.jsx', 'utf8');

    assert.doesNotMatch(source, /setSourceText\('', true\)/, 'the bogus forceSync argument must be gone');

    const branch = source.slice(source.indexOf("text === '[INPUT_TRANSLATE]'"));
    const body = branch.slice(0, branch.indexOf('} else if'));
    assert.match(body, /setSourceText\(''\)/, 'local state must be cleared');
    assert.match(body, /syncSourceText\(\)/, 'the atom must be synced too');
});

test('plugin list reload is actually subscribed in the translate window', async () => {
    // 曾经的 bug：模块级 `unlisten` 在模块加载时就赋值为 listenBlur() 的 Promise，
    // 而 Promise 恒为真值，因此 useEffect 里的 `if (!unlisten)` 永远不成立，
    // `listen('reload_plugin_list', ...)` 从未执行。
    // 后果：翻译窗口（长期复用）在安装/卸载插件后 pluginList 一直是旧数据。
    const source = await readFile('src/window/Translate/index.jsx', 'utf8');
    // 注释里会提到这个旧写法，断言前先去掉注释行，避免匹配到说明文字
    const code = source
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');

    assert.doesNotMatch(code, /if \(!unlisten\)/, 'a Promise is always truthy; this guard can never be false');
    assert.match(code, /unlistenReloadPluginList = listen\('reload_plugin_list', loadPluginList\)/);

    // 必须独立于 blur 监听器的变量，且卸载时清理
    const effect = code.slice(code.indexOf("listen('reload_plugin_list'"));
    const effectBody = effect.slice(0, effect.indexOf('}, []);'));
    assert.match(
        effectBody,
        /return \(\) => \{\s*unlistenReloadPluginListEvent\(\);\s*\};/,
        'the reload listener must be unlistened on unmount',
    );
    assert.match(code, /const unlistenReloadPluginListEvent = \(\) => \{/);

    // 不能把插件订阅塞回 blur 用的 unlisten 变量（两者生命周期不同）
    assert.doesNotMatch(source, /unlisten = listen\('reload_plugin_list'/);
});