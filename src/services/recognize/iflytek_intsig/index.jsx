import { fetchWithTimeout as fetch } from '../../../utils/fetchWithTimeout';
import CryptoJS from 'crypto-js';
import { iflytek_auth } from '../iflytek';

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

    const host = 'api.xf-yun.com';
    const today = new Date();
    const date = today.toUTCString();
    const request_line = 'POST /v1/private/hh_ocr_recognize_doc HTTP/1.1';

    let auth = iflytek_auth(apikey, apisecret, host, date, request_line);

    let request_url =
        'https://api.xf-yun.com/v1/private/hh_ocr_recognize_doc?' +
        'authorization=' +
        auth +
        '&host=' +
        host +
        '&date=' +
        encodeURIComponent(date);

    let request_body = {
        header: {
            app_id: appid, // 在讯飞开放平台申请的appid信息
            status: 3, // 请求状态，取值为：3（一次传完）
        },
        parameter: {
            hh_ocr_recognize_doc: {
                recognizeDocumentRes: {
                    encoding: 'utf8',
                    compress: 'raw',
                    format: 'json',
                },
            },
        },
        payload: {
            image: {
                image: base64,
            },
        },
    };

    // 发送请求
    let res = await fetch(request_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { type: 'Text', payload: JSON.stringify(request_body) },
    });

    // 处理结果
    if (!res.ok) {
        throw `Http Request Error\nHttp Status: ${res.status}\n${JSON.stringify(res.data)}`;
    }
    let data = res['data'];
    if (!data) {
        throw `Result data not found\nResult:\n${JSON.stringify(res)}`;
    }
    let res_payload = data['payload'];
    if (!res_payload) {
        throw `Result payload not found\nResult:\n${JSON.stringify(res)}`;
    }

    let text = CryptoJS.enc.Base64.parse(res_payload['recognizeDocumentRes']['text']); // Base64解码
    let text_string = CryptoJS.enc.Utf8.stringify(text);
    let text_json = JSON.parse(text_string);
    let return_content = text_json['whole_text']; // 最终结果
    if (!return_content) {
        return_content = '';
    }
    return return_content.trim();
}

export * from './Config';
export * from './info';
