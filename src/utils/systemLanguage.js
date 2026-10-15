// 检测系统语言并映射到应用支持的语言代码
// 目标语言应默认用户本地机器的语言（如中文系统→中文），
// 但如果源语言也是中文，则默认翻译为英语

const LOCALE_MAP = {
    zh: 'zh_cn',
    'zh-cn': 'zh_cn',
    'zh-hans': 'zh_cn',
    'zh-tw': 'zh_tw',
    'zh-hk': 'zh_tw',
    'zh-hant': 'zh_tw',
    en: 'en',
    ja: 'ja',
    ko: 'ko',
    fr: 'fr',
    de: 'de',
    es: 'es',
    ru: 'ru',
    it: 'it',
    tr: 'tr',
    pt: 'pt_pt',
    'pt-br': 'pt_br',
    'pt-pt': 'pt_pt',
    ar: 'ar',
    hi: 'hi',
    th: 'th',
    vi: 'vi',
    id: 'id',
    ms: 'ms',
    uk: 'uk',
    fa: 'fa',
    he: 'he',
};

// 注意：映射的**值**必须都存在于 src/utils/language.ts 的 `languageList`（翻译语言表），
// 因为 getSystemTargetLanguage() 的返回值会被直接用作 `translate_target_language`
// 的默认值，而目标语言下拉的选项正是来自 languageList。
// 曾经这里有 `ta: 'ta'` / `tk: 'tk'`：这两个系统语言会让目标语言被设成一个
// **不在下拉选项里**的值——界面上显示得出来（语言包里有 languages.ta），
// 但用户一旦改走就再也选不回来。故移除，让它们与其他未知语言一样回退 'en'。
//
// 不要与「界面语言」混淆：app_language 是另一套列表（21 项，含 ta_IN / tk_TM），
// 由 General 页的 incompleteLanguages 管理，与本文件无关。

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

// 说明：这里原本还有一个 `getSmartTargetLanguage(sourceLang, currentTarget)`，
// 它**从未被任何地方调用过**——只被 LanguageArea 导入却未使用。
// 真正生效的「源语言与目标语言相同时自动切换」逻辑，是在
// src/window/Translate/components/LanguageArea/index.jsx 的 useEffect 里
// 就地实现的（条件为 `sourceLanguage === 'auto' && detectLanguage === targetLanguage`）。
//
// 两者语义**并不等价**：那个死函数以 `sourceLang !== 'auto'` 为条件（正好相反），
// 而且开头有 `if (currentTarget === systemLang) return currentTarget` 提前返回，
// 会吞掉后续的切换分支。留着它只会让人误以为目标语言切换走的是它，
// 因此直接删除，避免后来者照着它去改一份根本不生效的实现。
