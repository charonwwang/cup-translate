import { fetchWithTimeout as fetch, Body } from '../../../utils/fetchWithTimeout';

export async function recognize(base64, language, options = {}) {
    const { config } = options;

    const { client_id, client_secret } = config;

    // 与其他需要凭据的 recognize 服务保持一致：凭据没填就**不要发请求**。
    // 原先本服务没有前置校验，空凭据照样发出去（对照 `baidu_img` 有 guard）。
    // 实测（2026-10）：空凭据请求真实端点返回 4xx（baidu token 端点实测 HTTP 400
    // `invalid_request`），用户只会看到 `Http Request Error / Http Status: 4xx`，
    // 既没说清缺哪个字段，也白费一次网络往返。
    // 判据与 required_config.js 的 isFilledString 同义（纯空白视同未填）。
    if (
        typeof client_id !== 'string' ||
        client_id.trim() === '' ||
        typeof client_secret !== 'string' ||
        client_secret.trim() === ''
    ) {
        throw 'Please configure client_id and client_secret';
    }

    const url = 'https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic';
    const token_url = 'https://aip.baidubce.com/oauth/2.0/token';

    const token_res = await fetch(token_url, {
        method: 'POST',
        query: {
            grant_type: 'client_credentials',
            client_id,
            client_secret,
        },
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
    });
    if (token_res.ok) {
        if (token_res.data.access_token) {
            let token = token_res.data.access_token;

            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                query: {
                    access_token: token,
                },
                body: Body.form({
                    language_type: language,
                    detect_direction: 'false',
                    image: base64,
                }),
            });
            if (res.ok) {
                let result = res.data;
                if (result['words_result']) {
                    let target = '';
                    for (let i of result['words_result']) {
                        target += i['words'] + '\n';
                    }
                    return target.trim();
                } else {
                    throw JSON.stringify(result);
                }
            } else {
                throw `Http Request Error\nHttp Status: ${res.status}\n${JSON.stringify(res.data)}`;
            }
        } else {
            throw 'Get Access Token Failed!';
        }
    } else {
        throw `Http Request Error\nHttp Status: ${token_res.status}\n${JSON.stringify(token_res.data)}`;
    }
}

export * from './Config';
export * from './info';
