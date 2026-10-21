import { wordDetailsPrompt, parseWordDetails } from '../../../utils/wordDetails';
import { Language } from './info';
import { checkPolicy } from '../../../utils/requestRuntime';
import { connectionUrl } from '../../../utils/connection';
import { resolveSecrets } from '../../../utils/credentials';
import { glossaryHint } from '../../../utils/glossary';

export async function translate(text, from, to, options = {}) {
    await checkPolicy('translate', 'ollama');
    const config = await resolveSecrets(options.config);
    const messages = (config.promptList ?? [{ role: 'user', content: 'Translate into $to: $text' }]).map((item) => ({
        ...item,
        content: item.content
            .replaceAll('$text', text)
            .replaceAll('$from', from)
            .replaceAll('$to', to)
            .replaceAll('$detect', Language[options.detect] ?? ''),
    }));
    const dictionaryPrompt = wordDetailsPrompt(text, from, options.detect);
    if (dictionaryPrompt) messages.push(dictionaryPrompt);
    const streaming = !!config.stream && !dictionaryPrompt;
    const hint = glossaryHint(options.matches ?? [], options.style);
    if (hint.message) messages.push(hint.message);
    const response = await window.fetch(connectionUrl(config.requestPath, 'ollama'), {
        method: 'POST',
        redirect: 'error',
        signal: options.signal ?? AbortSignal.timeout(30000),
        headers: { ...config.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, messages, stream: streaming }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!streaming) return parseWordDetails((await response.json()).message.content, dictionaryPrompt);
    const reader = response.body.getReader();
    let pending = '',
        target = '';
    const decoder = new TextDecoder();
    try {
        while (true) {
            const { done, value } = await reader.read();
            pending += decoder.decode(value, { stream: !done });
            const lines = pending.split('\n');
            pending = done ? '' : lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                const part = JSON.parse(line);
                if (part.error) throw new Error('Ollama inference failed');
                target += part.message?.content ?? '';
                options.setResult?.(target);
            }
            if (done) break;
        }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
    return target.trim();
}
export * from './Config';
export * from './info';
