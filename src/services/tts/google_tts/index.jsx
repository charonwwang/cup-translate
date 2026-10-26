import { useState } from 'react';
import { Button } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
import { fetchWithTimeout as fetch } from '../../../utils/fetchWithTimeout';
import { chunkText } from './chunkText';

// Google TTS（免费、无需 API key、开箱即用）：
// 使用 Google 翻译的 TTS 端点，返回 MP3 音频，无需本地安装任何 TTS 引擎。
// 短文本（<200 字符）直接合成；长文本分段合成后拼接。
export async function tts(text, lang, options = {}) {
    if (!text || text.trim() === '') {
        return new Uint8Array(0);
    }
    // Unsupported languages must fail explicitly rather than silently speak English.
    const langMap = {
        zh_cn: 'zh-CN',
        zh_tw: 'zh-TW',
        en: 'en',
        ja: 'ja',
        ko: 'ko',
        fr: 'fr',
        de: 'de',
        es: 'es',
        ru: 'ru',
        it: 'it',
        tr: 'tr',
        pt_pt: 'pt-PT',
        pt_br: 'pt-BR',
        ar: 'ar',
        hi: 'hi',
        th: 'th',
        vi: 'vi',
        id: 'id',
        ms: 'ms',
        uk: 'uk',
        fa: 'fa',
        he: 'he',
        sv: 'sv',
        pl: 'pl',
        nl: 'nl',
        nb_no: 'no',
        nn_no: 'no', // 书面语 nb 与新挪威语 nn 共用 Google 的 'no'，与 lingva 的映射一致
        km: 'km',
    };
    const googleLang = langMap[lang];
    if (!googleLang) throw new Error(`Google speech does not support ${lang}`);

    const chunks = chunkText(text);

    // 逐段合成并拼接 MP3（MP3 帧可直接拼接）
    const parts = [];
    for (const chunk of chunks) {
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${googleLang}&q=${encodeURIComponent(chunk)}`;
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                Referer: 'https://translate.google.com/',
            },
            responseType: 3, // Binary
        });
        if (!res.ok) {
            // 与其余服务层错误保持一致，用英文（服务层拿不到 t，回退语言即英文）
            throw `Google TTS request failed: HTTP ${res.status}`;
        }
        parts.push(new Uint8Array(res.data));
    }

    // 拼接所有 MP3 分段
    const totalLen = parts.reduce((s, p) => s + p.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

export const info = {
    display: 'Google TTS',
    name: 'google_tts',
    icon: '/logo/google.svg',
    server: 'translate.google.com',
};

export const Language = Object.freeze(
    Object.fromEntries(
        [
            'zh_cn',
            'zh_tw',
            'en',
            'ja',
            'ko',
            'fr',
            'de',
            'es',
            'ru',
            'it',
            'tr',
            'pt_pt',
            'pt_br',
            'ar',
            'hi',
            'th',
            'vi',
            'id',
            'ms',
            'uk',
            'fa',
            'he',
            'sv',
            'pl',
            'nl',
            'nb_no',
            'nn_no',
            'km',
        ].map((key) => [key, key])
    )
);

export function Config({ onClose, updateServiceList, instanceKey }) {
    const { t } = useTranslation();
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    return (
        <>
            <p>{t('translate.google_speech_hint')}</p>
            {error && (
                <p
                    role='alert'
                    className='break-all'
                >
                    {t('models.speech_action_failed')} {error}
                </p>
            )}
            <Button
                color='primary'
                isLoading={saving}
                onPress={async () => {
                    setSaving(true);
                    setError('');
                    try {
                        await updateServiceList(instanceKey);
                        onClose();
                    } catch (failure) {
                        setError(String(failure));
                    } finally {
                        setSaving(false);
                    }
                }}
            >
                {t('common.ok')}
            </Button>
        </>
    );
}
