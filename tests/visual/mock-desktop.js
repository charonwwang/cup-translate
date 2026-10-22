import piperManifest from '../../src-tauri/resources/piper-catalog.json';
import kokoroManifest from '../../src-tauri/resources/kokoro-model.json';
import kokoroVoices from '../../src-tauri/resources/kokoro-voices.json';
// Development-only fixture entry. Not referenced by either production build entry.
// All desktop, disk and network operations terminate in memory here.
const params = new URLSearchParams(location.search);
const view = params.get('view') || 'translate';
// Constrain the document to a desktop popup width for layout QA.
const fixtureWidth = Number(params.get('width'));
if (fixtureWidth >= 300 && fixtureWidth <= 1600) {
    document.documentElement.style.width = `${fixtureWidth}px`;
    document.body.style.width = `${fixtureWidth}px`;
    const popupStyle = document.createElement('style');
    popupStyle.textContent =
        '.translate-shell { width: 100% !important; }' +
        (Number(params.get('height')) >= 400
            ? `.config-shell { height: ${Math.min(1000, Number(params.get('height')))}px !important; }`
            : '');
    document.head.append(popupStyle);
}
const scenario = params.get('scenario') || 'dictionary';
const settings = new Map(
    Object.entries({
        app_language: 'zh_cn',
        app_theme: params.get('theme') || 'light',
        app_font_size: Number(params.get('font')) || 16,
        translate_detect_engine: 'local',
        translate_source_language: params.get('source') || 'auto',
        translate_target_language: 'zh_cn',
        translate_service_list: scenario === 'multi' ? ['google', 'google@2'] : ['google'],
        google: {},
        'google@2': { name: 'Google · 对照引擎' },
        tts_service_list: params.has('speech') ? ['local_tts'] : [],
        speech_policy: params.has('speech') ? 'local' : 'engine',
        history_disable: true,
        translate_close_on_blur: false,
    })
);
const fixtureText = {
    phrase: 'take something into account',
    paragraph:
        'Good design makes the important things easy to see. It removes friction, so people can focus on what matters. Clarity is not decoration; it is part of the product.',
};
const source =
    params.get('text') ||
    (scenario === 'dictionary'
        ? 'term'
        : fixtureText[scenario] || 'Good design makes the important things easy to see.');
const fixtureHistory = params.has('history')
    ? Array.from({ length: 24 }, (_, index) => ({
          id: index + 1,
          service: 'google',
          text: index === 1 ? '模型' : '多模态模型',
          result:
              index === 1
                  ? JSON.stringify({ explanations: [{ trait: 'noun', explains: ['model', 'pattern'] }] })
                  : 'multimodal model',
          source: 'zh_cn',
          target: 'en',
          timestamp: 1792110600000 - index * 60000,
      }))
    : [];
const installedModels = new Set();
const installedVoices = new Set();
let kokoroInstalled = false;
let eventId = 0;
const events = new Map();
window.__TAURI_METADATA__ = { __currentWindow: { label: view }, __windows: [{ label: view }] };
window.__TAURI_IPC__ = async (args) => {
    const { cmd, callback, error, message = {}, __tauriModule: module } = args;
    await new Promise((resolve) => setTimeout(resolve, 10));
    let value = null;
    try {
        if (cmd === 'plugin:store|get') value = settings.get(args.key) ?? null;
        else if (cmd === 'plugin:store|set') settings.set(args.key, args.value);
        else if (cmd === 'plugin:store|has') value = settings.has(args.key);
        else if (cmd === 'plugin:store|entries') value = [...settings.entries()];
        else if (cmd === 'plugin:store|delete') value = settings.delete(args.key);
        else if (cmd === 'plugin:store|keys') value = [...settings.keys()];
        else if (cmd === 'plugin:autostart|is_enabled') value = false;
        else if (cmd === 'font_list') value = ['Arial', 'PingFang SC'];
        else if (cmd === 'plugin:sql|select') {
            value = args.query.includes('COUNT(*)')
                ? [{ 'COUNT(*)': fixtureHistory.length }]
                : args.query.includes('WHERE id=')
                  ? fixtureHistory.filter((item) => item.id === Number(args.values[0]))
                  : fixtureHistory.slice(Number(args.values?.[0] || 0), Number(args.values?.[0] || 0) + 20);
        } else if (cmd === 'plugin:sql|load') value = 'sqlite:fixture.db';
        else if (cmd === 'tts_speak') {
            // Silent PCM for observing playback/stop without external services or sound.
            const samples = 8000 * 30;
            const bytes = new Uint8Array(44 + samples * 2);
            const header = new DataView(bytes.buffer);
            for (const [offset, text] of [
                [0, 'RIFF'],
                [8, 'WAVE'],
                [12, 'fmt '],
                [36, 'data'],
            ])
                [...text].forEach((char, index) => (bytes[offset + index] = char.charCodeAt(0)));
            for (const [offset, value] of [
                [4, bytes.length - 8],
                [16, 16],
                [24, 8000],
                [28, 16000],
                [40, samples * 2],
            ])
                header.setUint32(offset, value, true);
            for (const [offset, value] of [
                [20, 1],
                [22, 1],
                [32, 2],
                [34, 16],
            ])
                header.setUint16(offset, value, true);
            value = Array.from(bytes);
        } else if (cmd === 'get_text') value = source;
        else if (cmd === 'lang_detect') value = params.get('detect') || 'en';
        else if (cmd === 'piper_catalog')
            value = {
                supported: true,
                voices: piperManifest.map((voice) => ({
                    voice,
                    installed: installedVoices.has(voice.id),
                    task: { state: 'not_installed' },
                })),
            };
        else if (cmd === 'kokoro_model_status')
            value = {
                supported: true,
                installed: kokoroInstalled,
                model: kokoroManifest,
                voices: kokoroVoices,
                task: { state: 'idle' },
            };
        else if (cmd === 'piper_download') installedVoices.add(args.id);
        else if (cmd === 'kokoro_download') kokoroInstalled = true;
        else if (cmd === 'native_speech_device_check')
            value = {
                supported: true,
                platform: 'macos',
                architecture: 'aarch64',
                modelBytes: args.family === 'kokoro' ? kokoroManifest.archiveBytes : 63e6,
                diskAvailable: 30e9,
                diskRequired: 600e6,
                bundledRuntime: true,
            };
        else if (cmd === 'local_mt_model_status')
            value = { installed: installedModels.has(args.pair), supported: true };
        else if (cmd === 'local_mt_device_check')
            value = { platform: 'macos', architecture: 'aarch64', supported: true, diskAvailable: 30e9, threads: 4 };
        else if (cmd === 'local_mt_download_model') {
            installedModels.add(args.pair);
            value = null;
        } else if (cmd === 'local_mt_delete_model') installedModels.delete(args.pair);
        else if (module === 'Path') value = message.cmd === 'join' ? message.paths.join('/') : '/fixture';
        else if (module === 'Os')
            value = { osType: 'Linux', arch: 'aarch64', version: 'fixture', locale: 'zh-CN' }[message.cmd];
        else if (module === 'App') value = '3.0.7';
        else if (module === 'Dialog') value = params.has('transfer') ? '/fixture/settings.json' : null;
        else if (module === 'Fs')
            value =
                message.cmd === 'readDir'
                    ? []
                    : message.cmd === 'exists'
                      ? false
                      : message.cmd === 'readTextFile' && params.has('transfer')
                        ? JSON.stringify({
                              format: 'cup-translate-settings',
                              version: 1,
                              settings: { app_theme: 'dark' },
                          })
                        : '';
        else if (module === 'Event') {
            if (message.cmd === 'listen') {
                value = ++eventId;
                events.set(value, message);
            }
            if (message.cmd === 'unlisten') events.delete(message.eventId);
            if (message.cmd === 'emit') {
                for (const listener of events.values()) {
                    if (listener.event === message.event)
                        window[`_${listener.handler}`]?.({ payload: message.payload, event: message.event });
                }
            }
        } else if (module === 'Http') {
            if (message.cmd === 'createClient') value = 1;
            if (message.cmd === 'httpRequest') {
                await new Promise((resolve) => setTimeout(resolve, scenario === 'loading' ? 600000 : 300));
                if (scenario === 'error') {
                    window[`_${callback}`]({
                        url: 'fixture',
                        status: 400,
                        headers: {},
                        rawHeaders: {},
                        data: 'Fixture: service unavailable',
                    });
                    return;
                }
                const dictionaryRequest = scenario === 'dictionary' && message.options?.query?.q === source;
                const data = dictionaryRequest
                    ? [
                          [
                              ['术语', 'term'],
                              [null, null, null, 'tɜːrm'],
                          ],
                          [
                              ['名词', null, [['术语'], ['学期'], ['期限'], ['用语'], ['词语'], ['条款'], ['条件']]],
                              ['动词', null, [['称为'], ['把…叫作']]],
                          ],
                      ]
                    : [
                          [
                              [
                                  scenario === 'phrase'
                                      ? '考虑到；顾及'
                                      : scenario === 'paragraph'
                                        ? '好的设计让重要的内容一目了然。它消除阻力，让人们专注于真正重要的事。清晰不是装饰，而是产品的一部分。'
                                        : message.options?.query?.tl === 'en'
                                          ? 'Good design makes important content clear.'
                                          : '好的设计，让重要的内容一目了然。',
                              ],
                          ],
                      ];
                if (dictionaryRequest)
                    data[13] = [
                        [
                            ['The <b>term</b> starts tomorrow.'],
                            ['the musical <b>term</b> “leitmotiv”'],
                            ['a term of abuse'],
                            ['the summer term'],
                            ['The pregnancy went to full term.'],
                            ['low birthweight at term'],
                        ],
                    ];
                value = { url: 'fixture', status: 200, headers: {}, rawHeaders: {}, data: JSON.stringify(data) };
            }
        } else if (module === 'Clipboard' && message.cmd === 'writeText') {
            window.__fixtureClipboard = message.data;
        } else if (module === 'Window')
            value =
                message.cmd === 'manage' && message.data?.cmd?.type === 'currentMonitor'
                    ? { size: { width: 1440, height: 900 }, scaleFactor: 1 }
                    : null;
        window[`_${callback}`]?.(value);
    } catch (reason) {
        window[`_${error}`]?.(String(reason));
    }
};
if (view === 'config') history.replaceState({}, '', '/general');
await import('/src/main.jsx');
