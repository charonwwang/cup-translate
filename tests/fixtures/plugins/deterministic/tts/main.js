async function tts(text, lang, {config}) { return Array.from(new TextEncoder().encode(`${config.prefix}:${lang}:${text}`)); }
