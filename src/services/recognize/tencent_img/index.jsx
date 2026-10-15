import hmacSHA256 from 'crypto-js/hmac-sha256';
import { fetchWithTimeout as fetch } from '../../../utils/fetchWithTimeout';
import hashSHA256 from 'crypto-js/sha256';
import hex from 'crypto-js/enc-hex';
import { nanoid } from 'nanoid';

export async function recognize(base64, language, options = {}) {
    const { config } = options;

    const { secret_key, secret_id } = config;

    function sha256(message, secret = '') {
        return hmacSHA256(message, secret);
    }

    function getHash(message) {
        return hashSHA256(message).toString();
    }

    function getDate(timestamp) {
        const date = new Date(timestamp * 1000);
        const year = date.getUTCFullYear();
        const month = ('0' + (date.getUTCMonth() + 1)).slice(-2);
        const day = ('0' + date.getUTCDate()).slice(-2);
        return `${year}-${month}-${day}`;
    }

    const endpoint = 'tmt.tencentcloudapi.com';
    const service = 'tmt';
    const region = 'ap-beijing';
    const action = 'ImageTranslate';
    const version = '2018-03-21';
    const timestamp = Math.ceil(Date.now() / 1000);
    // const timestamp = 1551113065
    //时间处理, 获取世界时间日期
    const date = getDate(timestamp);

    // ************* 步骤 1：拼接规范请求串 *************
    const body = {
        SessionUuid: nanoid(),
        Scene: 'doc',
        Data: base64,
        Source: 'auto',
        Target: language === 'auto' ? 'zh' : language,
        ProjectId: 0,
    };
    const payload = JSON.stringify(body);
    // const payload = "{\"Limit\": 1, \"Filters\": [{\"Values\": [\"\\u672a\\u547d\\u540d\"], \"Name\": \"instance-name\"}]}"

    const hashedRequestPayload = getHash(payload);
    const httpRequestMethod = 'POST';
    const canonicalUri = '/';
    const canonicalQueryString = '';
    const canonicalHeaders = 'content-type:application/json\n' + 'host:' + endpoint + '\n';
    // + "x-tc-action:" + action.toLowerCase() + "\n"
    const signedHeaders = 'content-type;host';

    const canonicalRequest =
        httpRequestMethod +
        '\n' +
        canonicalUri +
        '\n' +
        canonicalQueryString +
        '\n' +
        canonicalHeaders +
        '\n' +
        signedHeaders +
        '\n' +
        hashedRequestPayload;

    // ************* 步骤 2：拼接待签名字符串 *************
    const algorithm = 'TC3-HMAC-SHA256';
    const hashedCanonicalRequest = getHash(canonicalRequest);
    const credentialScope = date + '/' + service + '/' + 'tc3_request';
    const stringToSign = algorithm + '\n' + timestamp + '\n' + credentialScope + '\n' + hashedCanonicalRequest;

    // ************* 步骤 3：计算签名 *************
    const kDate = sha256(date, 'TC3' + secret_key);
    const kService = sha256(service, kDate);
    const kSigning = sha256('tc3_request', kService);
    const signature = hex.stringify(sha256(stringToSign, kSigning));

    // ************* 步骤 4：拼接 Authorization *************
    const authorization =
        algorithm +
        ' ' +
        'Credential=' +
        secret_id +
        '/' +
        credentialScope +
        ', ' +
        'SignedHeaders=' +
        signedHeaders +
        ', ' +
        'Signature=' +
        signature;

    let res = await fetch('https://' + endpoint, {
        method: 'POST',
        headers: {
            Authorization: authorization,
            'content-type': 'application/json',
            Host: endpoint,
            'X-TC-Action': action,
            'X-TC-Timestamp': timestamp.toString(),
            'X-TC-Version': version,
            'X-TC-Region': region,
        },
        body: {
            type: 'Text',
            payload: payload,
        },
    });
    if (res.ok) {
        const result = res.data;
        // ⚠️ 必须逐层判断，不能直接 `result['Response']['ImageRecord']['Value']`。
        //
        // 腾讯云的接口在**失败时也返回 HTTP 200**，错误信息放在
        // `Response.Error` 里、**不带** `ImageRecord` 字段。实测（无效凭据，仅看结构）：
        //   {"Response":{"Error":{"Code":"AuthFailure.SignatureExpire",
        //     "Message":"Signature expired. ..."},"RequestId":"..."}}
        // 于是原来的三层链式访问会抛
        //   TypeError: Cannot read properties of undefined (reading 'Value')
        // 而前端 `TextArea` 是 `setError(e.toString())` 原样展示，
        // 用户看到的就是这句 TypeError —— 与真正的原因（密钥错/签名过期）毫无关系，
        // 也不知道该去改配置。
        //
        // 现在先取 Response，再取 ImageRecord，任何一层缺失都退回到
        // `throw JSON.stringify(result)`，把服务端返回的原始错误如实带给用户。
        const response = result && result['Response'];
        const record = response && response['ImageRecord'];
        const value = record && record['Value'];
        if (value) {
            let source = '';
            let target = '';
            for (let i of value) {
                source += i['SourceText'] + '\n';
                target += i['TargetText'] + '\n';
            }
            if (language === 'auto') {
                return source.trim();
            } else {
                return target.trim();
            }
        } else {
            throw JSON.stringify(result);
        }
    } else {
        throw `Http Request Error\nHttp Status: ${res.status}\n${JSON.stringify(res.data)}`;
    }
}

export * from './Config';
export * from './info';
