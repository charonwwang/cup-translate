import { fetchWithTimeout as fetch } from '../../../utils/fetchWithTimeout';
import hmacSHA256 from 'crypto-js/hmac-sha256';
import hashSHA256 from 'crypto-js/sha256';
import Base64 from 'crypto-js/enc-base64';

export async function recognize(base64, language, options = {}) {
    const { config } = options;

    const { appid, apisecret, apikey } = config;

    // 与其他需要凭据的 recognize 服务保持一致：凭据没填就**不要发请求**。
    // 原先本服务没有前置校验，空凭据照样发出去（对照 `baidu_img` 有 guard）。
    // 实测（2026-10）：空凭据请求真实端点返回 4xx（baidu token 端点实测 HTTP 400
    // `invalid_request`），用户只会看到 `Http Request Error / Http Status: 4xx`，
    // 既没说清缺哪个字段，也白费一次网络往返。
    // 判据与 required_config.js 的 isFilledString 同义（纯空白视同未填）。
    if (
        typeof appid !== 'string' ||
        appid.trim() === '' ||
        typeof apikey !== 'string' ||
        apikey.trim() === '' ||
        typeof apisecret !== 'string' ||
        apisecret.trim() === ''
    ) {
        throw 'Please configure appid, apikey and apisecret';
    }

    const url = 'https://rest-api.xfyun.cn/v2/itr';

    const body = {
        common: {
            app_id: appid,
        },
        business: {
            ent: 'teach-photo-print',
            aue: 'raw',
        },
        data: {
            image: base64,
        },
    };
    const host = 'rest-api.xfyun.cn';
    const date = new Date().toUTCString();
    const request_line = 'POST /v2/itr HTTP/1.1';
    const digest = 'SHA-256=' + Base64.stringify(hashSHA256(JSON.stringify(body)));
    const signature_origin = `host: ${host}\ndate: ${date}\n${request_line}\ndigest: ${digest}`;
    const signature_sha = hmacSHA256(signature_origin, apisecret);
    const signature = Base64.stringify(signature_sha);
    const authorization = `api_key="${apikey}", algorithm="hmac-sha256", headers="host date request-line digest", signature="${signature}"`;
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json,version=1.0',
        Host: host,
        Date: date,
        Digest: digest,
        Authorization: authorization,
    };
    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: {
            type: 'Text',
            payload: JSON.stringify(body),
        },
    });
    if (res.ok) {
        let result = res.data;
        // ⚠️ 必须先判断 `result.data` 是否存在，不能直接 `result.data['region']`。
        //
        // 讯飞在鉴权失败时返回的是**不带 `data` 字段**的响应。实测（伪造签名的
        // 真实请求 `https://rest-api.xfyun.cn/v2/itr`）拿到的响应：
        //     {"message":"HMAC signature cannot be verified: apikey not found"}
        // 于是原来的 `result.data['region']` 会抛
        //     TypeError: Cannot read properties of undefined (reading 'region')
        // 而前端 `TextArea` 是 `setError(e.toString())` 原样展示，用户看到的
        // 就是这句 TypeError —— 服务端明明已经说明「apikey 找不到」，这条真正
        // 可操作的信息却被完全丢弃（与上一轮修掉的 tencent_img 是同一类缺陷）。
        //
        // 同目录的 `iflytek` 与 `iflytek_intsig` 本来就做了逐层判断
        // （`if (!data) throw ...` / `if (!res_payload) throw ...`），
        // 只有 latex 这一版漏了；这里补齐，文案与那两个保持一致。
        let data = result && result['data'];
        if (!data) {
            throw `Result data not found\nResult:\n${JSON.stringify(result)}`;
        }
        if (data['region']) {
            let target = '';
            for (let i of data['region']) {
                // `recog` 同样可能缺失（某块没有识别结果），缺了按空内容处理，
                // 不要因为一块而让整次识别崩掉。
                target += (i['recog'] ? i['recog']['content'] : '') + '\n';
            }
            target = target.replaceAll(' ifly-latex-begin ', '');
            target = target.replaceAll(' ifly-latex-end ', '');
            return target.trim();
        } else {
            throw JSON.stringify(result);
        }
    } else {
        throw `Http Request Error\nHttp Status: ${res.status}\n${JSON.stringify(res.data)}`;
    }
}

export * from './Config';
export * from './info';
