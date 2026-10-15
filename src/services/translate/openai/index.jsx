import { fetchWithTimeout as fetch, Body } from '../../../utils/fetchWithTimeout';
import { Language } from './info';
import { defaultRequestArguments } from './Config';

export async function translate(text, from, to, options) {
    const { config, setResult, detect } = options;

    let { service, requestPath, model, apiKey, stream, promptList, requestArguments } = config;

    if (!/https?:\/\/.+/.test(requestPath)) {
        requestPath = `https://${requestPath}`;
    }
    const apiUrl = new URL(requestPath);

    // in openai like api, /v1 is not required
    if (service === 'openai' && !apiUrl.pathname.endsWith('/chat/completions')) {
        // not openai like, populate completion endpoint
        apiUrl.pathname += apiUrl.pathname.endsWith('/') ? '' : '/';
        apiUrl.pathname += 'v1/chat/completions';
    }

    // 兼容旧版
    if (promptList === undefined) {
        promptList = [
            {
                role: 'system',
                content:
                    'You are a professional translation engine, please translate the text into a colloquial, professional, elegant and fluent content, without the style of machine translation. You must only translate the text content, never interpret it.',
            },
            { role: 'user', content: `Translate into $to:\n"""\n$text\n"""` },
        ];
    }

    promptList = promptList.map((item) => {
        return {
            ...item,
            content: item.content
                .replaceAll('$text', text)
                .replaceAll('$from', from)
                .replaceAll('$to', to)
                .replaceAll('$detect', Language[detect]),
        };
    });

    const headers =
        service === 'openai'
            ? {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${apiKey}`,
              }
            : {
                  'Content-Type': 'application/json',
                  'api-key': apiKey,
              };
    const body = {
        ...JSON.parse(requestArguments ?? defaultRequestArguments),
        stream: stream,
        messages: promptList,
    };
    if (service === 'openai') {
        body['model'] = model;
    }
    if (stream) {
        const res = await window.fetch(apiUrl.href, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body),
        });
        if (res.ok) {
            let target = '';
            const reader = res.body.getReader();
            try {
                let temp = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        setResult(target.trim());
                        return target.trim();
                    }
                    const str = new TextDecoder().decode(value);
                    let datas = str.split('data:');
                    for (let data of datas) {
                        if (data.trim() !== '' && data.trim() !== '[DONE]') {
                            // temp 只用来缓存「上一次没解析成功的片段」。
                            // 注意：**只有 JSON.parse 失败**才算片段被截断，
                            // 解析成功但结构不同（例如流末尾的 usage 块
                            // `{"choices":[],"usage":{...}}`）不是截断。
                            // 原来把整个处理都包在 try 里，于是 `choices[0]` 抛的
                            // TypeError 也被当成截断，把**完整**的 usage 块塞进 temp；
                            // 下一个内容块再与它拼接必然解析失败，又被塞回 temp——
                            // 此后所有内容块全被丢弃，译文静默截断。
                            let raw = temp !== '' ? temp + data.trim() : data.trim();
                            let result;
                            try {
                                result = JSON.parse(raw);
                            } catch {
                                // 真的被截断了：留给下一个数据块再拼
                                temp = raw;
                                continue;
                            }
                            temp = '';
                            // choices 可能为空数组（usage 块），delta.content 也可能缺失
                            const piece = result?.choices?.[0]?.delta?.content;
                            if (typeof piece === 'string') {
                                target += piece;
                                if (setResult) {
                                    setResult(target + '_');
                                } else {
                                    return '[STREAM]';
                                }
                            }
                        }
                    }
                }
            } finally {
                reader.releaseLock();
            }
        } else {
            throw `Http Request Error\nHttp Status: ${res.status}\n${JSON.stringify(res.data)}`;
        }
    } else {
        let res = await fetch(apiUrl.href, {
            method: 'POST',
            headers: headers,
            body: Body.json(body),
        });
        if (res.ok) {
            let result = res.data;
            const { choices } = result;
            if (choices) {
                let target = choices[0].message.content.trim();
                if (target) {
                    if (target.startsWith('"')) {
                        target = target.slice(1);
                    }
                    if (target.endsWith('"')) {
                        target = target.slice(0, -1);
                    }
                    return target.trim();
                } else {
                    throw JSON.stringify(choices);
                }
            } else {
                throw JSON.stringify(result);
            }
        } else {
            throw `Http Request Error\nHttp Status: ${res.status}\n${JSON.stringify(res.data)}`;
        }
    }
}

export * from './Config';
export * from './info';
