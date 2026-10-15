import jsQR from 'jsqr';

// 等待图片加载的超时上限。正常情况下这个 Promise 在几十毫秒内就 settle，
// 设成 10s 是为了「绝不挂死」而不是「够快」。
const IMAGE_LOAD_TIMEOUT_MS = 10000;

export async function recognize(base64, language, options = {}) {
    let canvas = document.createElement('CANVAS');
    let ctx = canvas.getContext('2d');
    // getContext 可能返回 null（资源耗尽等）。若继续走下去，会在 onload
    // 回调里抛 TypeError —— 那个异常发生在**事件回调**中，既不会被下面的
    // Promise 捕获也不会 reject，调用方就永远等下去。
    if (!ctx) {
        throw 'Failed to create a 2D canvas context';
    }
    base64 = 'data:image/png;base64,' + base64;
    let img = new Image();
    img.src = base64;
    let imgdata = await new Promise((resolve, reject) => {
        // 兜底：这个 Promise 原来只有 onload / onerror 两个出口。若浏览器
        // 两者都不触发（WebKit 对畸形 data URL 会静默丢弃请求而不派发事件），
        // 或者 onload 回调内部抛异常，Promise 就**永不 settle**。
        // 后果不是报错，而是调用方 `.then` 的两个分支都不执行 ——
        // `setLoading(false)` 永不调用，**识别窗口永远停在加载中**，
        // 用户看不到提示，也没有可恢复路径（见
        // Recognize/TextArea/index.jsx:137-142）。
        // 因此加一条超时出口，保证无论发生什么都一定会 settle。
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(`Timed out after ${IMAGE_LOAD_TIMEOUT_MS}ms while decoding the image`);
        }, IMAGE_LOAD_TIMEOUT_MS);
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
        };

        img.onload = () => {
            try {
                img.crossOrigin = 'anonymous';
                canvas.height = img.height;
                canvas.width = img.width;
                ctx.drawImage(img, 0, 0);
                const height = img.height;
                const width = img.width;
                const data = ctx.getImageData(0, 0, width, height);
                if (height !== 0 && width !== 0) {
                    finish(resolve, { data, height, width });
                } else {
                    finish(reject, 'Image has zero width or height');
                }
            } catch (e) {
                // 把 onload 内部的异常转成 reject，而不是让它逃逸成无人接管的
                // 错误（那会同时导致 Promise 永不 settle）。
                finish(reject, `Failed to decode image: ${e && e.message ? e.message : e}`);
            }
        };
        img.onerror = () => {
            finish(reject, 'Failed to load image (corrupt or unsupported format)');
        };
    });

    const code = jsQR(imgdata.data.data, imgdata.width, imgdata.height);
    if (code) {
        return code.data;
    } else {
        throw 'QR code not recognized or multiple QR codes exist';
    }
}

export * from './Config';
export * from './info';
