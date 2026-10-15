import Tesseract from 'tesseract.js';
import { Language } from './info';

export async function recognize(base64, language) {
    // workerPath/corePath 不要覆盖为 /xxx.js 路径：这些文件不在 public/ 目录，
    // 覆盖后 tesseract.js 会 404 加载失败。让 tesseract.js 用默认的 npm 包内
    // 资源（Vite 构建时自动打包）。langPath 保留 R2 镜像（比 jsdelivr CDN 快）。
    const {
        data: { text },
    } = await Tesseract.recognize('data:image/png;base64,' + base64, language, {
        langPath: 'https://pub-f6afb74f13c64cd89561b4714dca1c27.r2.dev',
    });
    if (language === Language.zh_cn || language === Language.zh_tw) {
        return text.replaceAll(' ', '').trim();
    } else {
        return text.trim();
    }
}

export * from './Config';
export * from './info';
