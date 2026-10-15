import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readHistory = () => readFile('src/window/Config/pages/History/index.jsx', 'utf8');

/** 取出某个 async 函数的函数体源码（按大括号配对，避免截断嵌套块）。 */
function functionBody(source, signature) {
    const start = source.indexOf(signature);
    assert.notEqual(start, -1, `function not found: ${signature}`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(open, i + 1);
        }
    }
    throw new Error(`unbalanced braces for ${signature}`);
}

/** 去掉行注释与块注释，避免把说明文字里的关键词误当成代码。 */
function stripComments(code) {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('clearing history empties the table instead of dropping it', async () => {
    // 缺陷背景：clearData 原本用 `DROP TABLE history`。
    // 全项目只有 TargetArea.addToHistory 的失败重试会重建该表，
    // 所以「清空历史」之后历史页会一直报 "no such table"，
    // 直到用户再翻译一次为止。清空数据不应破坏表结构。
    //
    // 注意：必须先去注释再断言。修复后 clearData 的注释里就解释了
    // 「为什么不用 DROP TABLE」，直接匹配源码会把说明文字误判成代码
    //（这个测试第一版正是被自己的注释绊倒的）。
    const body = stripComments(functionBody(await readHistory(), 'const clearData = async () =>'));

    assert.doesNotMatch(body, /DROP\s+TABLE/i, 'clearData must not drop the table structure');
    assert.match(body, /DELETE\s+FROM\s+history/i, 'clearData should delete the rows');
});

test('history data helpers guard against database failures', async () => {
    // 缺陷背景：init / getData / getSelectedData / clearData / updateData
    // 都没有 try/catch。表不存在（上一条缺陷的后果）或 sqlite 插件未就绪时，
    // 异常会逃逸成未处理的 promise rejection，界面空白且无任何提示。
    const source = await readHistory();

    for (const signature of [
        'const init = async () =>',
        'const getData = async () =>',
        'const getSelectedData = async (id) =>',
        'const clearData = async () =>',
        'const updateData = async () =>',
    ]) {
        const body = functionBody(source, signature);
        assert.match(body, /try\s*\{/, `${signature} must guard its database access so failures surface`);
    }
});

test('a missing history table does not surface as an unhandled rejection', async () => {
    // 回归护栏：getData 等被 useEffect 以裸调用方式触发（未 await、未 catch），
    // 因此函数自身必须吞掉并上报错误，不能把 rejection 抛给调用方。
    const source = await readHistory();
    const body = functionBody(source, 'const getData = async () =>');
    assert.match(body, /catch\s*\(/, 'getData must catch its own errors');
});

test('a missing table is tolerated when counting rows', async () => {
    // init() 统计总数：表不存在时应视为 0 条，而不是抛错中断页面加载
    const source = await readHistory();
    const body = functionBody(source, 'const init = async () =>');
    assert.match(body, /catch\s*\(/, 'init must tolerate a missing/erroring table');
});
