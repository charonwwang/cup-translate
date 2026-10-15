import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readModal = () => readFile('src/window/Config/pages/Service/SelectPluginModal/index.jsx', 'utf8');

/** 取出「卸载插件」按钮的 onPress 回调源码（按大括号配对）。 */
function uninstallHandler(source) {
    const anchor = source.indexOf('removeDir(`plugins/${pluginType}/${x}`');
    assert.notEqual(anchor, -1, 'uninstall handler not found');
    // 往前找回该回调的开头
    const start = source.lastIndexOf('onPress={() => {', anchor);
    assert.notEqual(start, -1, 'onPress handler start not found');
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(open, i + 1);
        }
    }
    throw new Error('unbalanced braces in uninstall handler');
}

test('uninstalling a plugin does not delete files before the config allows it', async () => {
    // 缺陷背景：原实现先 removeDir 删掉插件文件，成功回调里才 deleteService(x)。
    // 但 deleteService 在「仅剩最后一个服务实例」时会**拒绝并直接 return**
    // （toast「至少保留一个服务」），此时文件已经删了、配置却没删：
    //   - 用户同时看到「卸载成功」和「至少保留一个服务」两条自相矛盾的提示；
    //   - 磁盘上插件已消失，config.json 仍引用它，状态不一致。
    // 正确顺序：先让 deleteService 判断能否删，再动文件。
    const handler = uninstallHandler(await readModal());
    const dirIndex = handler.indexOf('removeDir(');
    const serviceIndex = handler.indexOf('deleteService(');

    assert.notEqual(dirIndex, -1, 'handler should call removeDir');
    assert.notEqual(serviceIndex, -1, 'handler should call deleteService');
    assert.ok(serviceIndex < dirIndex, 'deleteService must be consulted before removeDir deletes the plugin files');
});

test('a refused uninstall leaves the plugin files on disk', async () => {
    // deleteService 拒绝时（最后一个实例）不应删除任何文件。
    // 因此 removeDir 必须只在「配置层已同意」之后才被调用——
    // 用源码结构断言：removeDir 不得出现在 deleteService 之前。
    const handler = uninstallHandler(await readModal());

    // 若实现改为「先询问再删除」，removeDir 应出现在 deleteService 调用的
    // 结果判断之后；这里断言二者顺序，避免回退到「先删文件」。
    assert.ok(
        handler.indexOf('deleteService(') < handler.indexOf('removeDir('),
        'plugin files must not be removed before deleteService decides'
    );
    // 成功提示也不应早于配置删除（否则又会出现「已卸载但配置还在」的假成功）
    const successIndex = handler.indexOf('uninstall_success');
    assert.ok(
        successIndex === -1 || successIndex > handler.indexOf('deleteService('),
        'the success toast must not fire before the config deletion is accepted'
    );
});
