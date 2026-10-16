import { readBinaryFile, BaseDirectory } from '@tauri-apps/api/fs';
import { fetchWithTimeout as fetch, Body } from '../../../utils/fetchWithTimeout';
import { nanoid } from 'nanoid';
import md5 from 'md5';

export async function recognize(base64, language, options = {}) {
    const { config } = options;

    const { appid, secret } = config;

    const url = 'https://fanyi-api.baidu.com/api/trans/sdk/picture';

    const salt = nanoid();
    // 判据与 required_config.js 的 isFilledString 同义：**纯空白视同未填**。
    // 原先只比较 `=== ''`，于是 `'   '` 会被当成有效凭据发出去；
    // 项目已确立「'   ' 与 '' 同等对待，因为两者都没有引擎能用」。
    if (typeof appid !== 'string' || appid.trim() === '' || typeof secret !== 'string' || secret.trim() === '') {
        throw 'Please configure appid and secret';
    }

    let file = await readBinaryFile('pot_screenshot_cut.png', { dir: BaseDirectory.AppCache });
    const str = appid + md5(file) + salt + 'APICUIDmac' + secret;
    const sign = md5(str);

    let res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'multipart/form-data',
        },
        body: Body.form({
            image: {
                file: file,
                mime: 'image/png',
                fileName: 'pot_screenshot_cut.png',
            },
            from: 'auto',
            to: language === 'auto' ? 'zh' : language,
            appid: appid,
            salt: salt,
            cuid: 'APICUID',
            mac: 'mac',
            version: '3',
            sign: sign,
        }),
    });

    if (res.ok) {
        let result = res.data;
        if (result['data'] && result['data']['sumSrc'] && result['data']['sumDst']) {
            if (language === 'auto') {
                return result['data']['sumSrc'].trim();
            } else {
                return result['data']['sumDst'].trim();
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
