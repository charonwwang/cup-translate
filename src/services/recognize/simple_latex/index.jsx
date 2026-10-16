import { readBinaryFile, BaseDirectory } from '@tauri-apps/api/fs';
import { fetchWithTimeout as fetch, Body } from '../../../utils/fetchWithTimeout';

export async function recognize(base64, language, options = {}) {
    const { config } = options;

    const { token } = config;

    const url = 'https://server.simpletex.cn/api/latex_ocr/v2';

    // 与其他需要凭据的服务保持一致：凭据没填就**不要发请求**。
    // 对照 `recognize/baidu_img` 的 `if (appid === '' || secret === '') throw ...`，
    // 本服务原先**没有任何前置校验**，空 token 照样发出去。
    // 实测（2026-10）：空 token 请求 `latex_ocr/v2` 返回
    //     HTTP 401 {"err_info":{"err_msg":"invalid credentials",...}}
    // 即真的向第三方服务器发了一次注定失败的请求，用户只看到一串
    // `Http Request Error / Http Status: 401 / {...}`。
    //
    // 判据用 `isFilledString` 的同一语义（纯空白视同未填）：项目里
    // `required_config.js` 已确立「'   ' 与 '' 同等对待，因为两者都没有引擎能用」。
    // 这里为避免跨目录依赖，就地写等价判断。
    if (typeof token !== 'string' || token.trim() === '') {
        throw 'Please configure token';
    }

    let file = await readBinaryFile('pot_screenshot_cut.png', { dir: BaseDirectory.AppCache });

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            token,
            'content-type': 'multipart/form-data',
        },
        body: Body.form({
            file: {
                file: file,
                fileName: 'pot_screenshot_cut.png',
            },
        }),
    });
    if (res.ok) {
        let result = res.data;
        if (result['res'] && result['res']['latex']) {
            return result['res']['latex'].trim();
        } else {
            throw JSON.stringify(result);
        }
    } else {
        throw `Http Request Error\nHttp Status: ${res.status}\n${JSON.stringify(res.data)}`;
    }
}

export * from './Config';
export * from './info';
