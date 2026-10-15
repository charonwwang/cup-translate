// 检测系统语言并映射到应用支持的语言代码
// 目标语言应默认用户本地机器的语言（如中文系统→中文），
// 但如果源语言也是中文，则默认翻译为英语

const LOCALE_MAP = {
    'zh': 'zh_cn',
    'zh-cn': 'zh_cn',
    'zh-hans': 'zh_cn',
    'zh-tw': 'zh_tw',
    'zh-hk': 'zh_tw',
    'zh-hant': 'zh_tw',
    'en': 'en',
    'ja': 'ja',
    'ko': 'ko',
    'fr': 'fr',
    'de': 'de',
    'es': 'es',
    'ru': 'ru',
    'it': 'it',
    'tr': 'tr',
    'pt': 'pt_pt',
    'pt-br': 'pt_br',
    'pt-pt': 'pt_pt',
    'ar': 'ar',
    'hi': 'hi',
    'th': 'th',
    'vi': 'vi',
    'id': 'id',
    'ms': 'ms',
    'uk': 'uk',
    'fa': 'fa',
    'he': 'he',
    'ta': 'ta',
    'tk': 'tk',
};

// 获取系统语言对应的翻译目标语言代码
export function getSystemTargetLanguage() {
    try {
        const locale = (navigator.language || 'en').toLowerCase();
        // 精确匹配
        if (LOCALE_MAP[locale]) return LOCALE_MAP[locale];
        // 前缀匹配（如 zh-cn -> zh）
        const prefix = locale.split('-')[0];
        return LOCALE_MAP[prefix] || 'en';
    } catch {
        return 'en';
    }
}

// 智能选择目标语言：如果源语言与目标语言相同，切换为英语
export function getSmartTargetLanguage(sourceLang, currentTarget) {
    const systemLang = getSystemTargetLanguage();
    // 如果当前目标就是系统语言，保持不变
    if (currentTarget === systemLang) return currentTarget;
    // 如果源语言和目标语言相同，切换到英语（或系统语言如果不是英语）
    if (sourceLang === currentTarget && sourceLang !== 'auto') {
        return currentTarget === 'en' ? systemLang : 'en';
    }
    return currentTarget;
}
