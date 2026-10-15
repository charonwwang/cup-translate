import { Language } from './info';
import * as jose from 'jose';
import { info } from 'tauri-plugin-log-api';
// 必须用带超时的封装：@tauri-apps/api/http 的 fetch **不会**自动超时，
// 服务端挂起时请求会无限等待，界面永久卡在 loading。
// （本文件是 19 个翻译引擎里唯一漏掉这层的；其余 18 个都 import 了它。）
import { fetchWithTimeout as fetch } from '../../../utils/fetchWithTimeout';

export async function translate(text, from, to, options = {}) {
    const { config, setResult, detect } = options;

    let { model, apiKey, promptList } = config;

    let [id, secret] = apiKey.split('.');
    if (id === undefined || secret === undefined) {
        return Promise.reject('invalid apikey');
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

    //
    let timestamp = new Date().getTime();
    let payload = {
        api_key: id,
        exp: timestamp + 1000 * 60,
        timestamp: timestamp,
    };
    secret = new TextEncoder().encode(secret);
    let jwt = new jose.SignJWT(payload).setProtectedHeader({ alg: 'HS256', sign_type: 'SIGN' });
    let token = await jwt.sign(secret);

    const headers = {
        'Content-Type': 'application/json',
        Authorization: token,
    };

    const body = {
        model: model,
        messages: promptList,
        stream: true,
        thinking: {
            type: 'disabled',
        },
    };

    let result = '';
    try {
        const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            throw new Error(`Http Request Error\nHttp Status: ${response.status}\n${await response.text()}`);
        }

        let buffer = '';
        // Function to process the stream data
        const processChatStream = async (reader, decoder) => {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                // Convert binary data to string
                buffer += decoder.decode(value, { stream: true });

                // Process complete events
                const boundary = buffer.lastIndexOf('\n\n');
                if (boundary !== -1) {
                    const event = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    const chunks = event.split('\n\n');

                    for (const chunk of chunks) {
                        const text = chunk.replace(/^data:/, '').trim();
                        if (text === '[DONE]') {
                            continue;
                        }
                        const data = JSON.parse(text);
                        result += data.choices[0].delta.content;
                        if (setResult) {
                            setResult(result + '_');
                        }
                    }
                }
            }
        };

        const reader = response.body.getReader();
        try {
            await processChatStream(reader, new TextDecoder());
        } finally {
            reader.releaseLock();
        }
    } catch (error) {
        return Promise.reject(error);
    }

    return result;
}

export * from './Config';
export * from './info';
