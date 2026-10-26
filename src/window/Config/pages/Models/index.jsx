import { useLocation } from 'react-router-dom';
import QwenSpeech from './QwenSpeech';
import SpeechModels from './SpeechModels';
import KokoroVoices from './KokoroVoices';
import PiperVoices from './PiperVoices';
import ServicesHome from './ServicesHome';
import ModelCatalog from './ModelCatalog';
import { LuVolume2, LuLock } from 'react-icons/lu';
import './models.css';
import { LuCpu, LuCheck, LuArrowRight, LuSettings2 } from 'react-icons/lu';
import React, { useEffect, useRef, useState } from 'react';
import {
    Button,
    Card,
    CardBody,
    Switch,
    Input,
    Textarea,
    Select,
    SelectItem,
    Tabs,
    Tab,
    Progress,
    Modal,
    ModalContent,
    ModalHeader,
    ModalBody,
    ModalFooter,
} from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/tauri';
import { listen, emit } from '@tauri-apps/api/event';
import { useConfig } from '../../../../hooks';
import { store } from '../../../../utils/store';
import { createServiceInstanceKey } from '../../../../utils/service_instance';
import { parseGlossary, previewGlossary, commitGlossary, persistGlossary } from '../../../../utils/glossary';
import * as providers from '../../../../services/translate';
import { resolveSecrets } from '../../../../utils/credentials';
import { checkPolicy, registerRequestController } from '../../../../utils/requestRuntime';
import { connectionUrl } from '../../../../utils/connection';

const pairs = ['en-zh', 'zh-en'];
export default function Models() {
    const { t } = useTranslation();
    const [privacy, setPrivacy] = useConfig('privacy_mode', 'standard', { immediate: true });
    const [library, setLibrary] = useConfig(
        'glossary_v2',
        { enabled: false, entries: [], revision: 0 },
        { sync: false }
    );
    const [status, setStatus] = useState({});
    const [services, setServices] = useState([]);
    const [catalogOpen, setCatalogOpen] = useState(false);
    const [manageModelId, setManageModelId] = useState(null);
    const location = useLocation();
    useEffect(() => {
        const id = new URLSearchParams(location.search).get('install');
        if (['en-zh', 'zh-en', 'm2m100', 'hymt-q4', 'hymt-q8'].includes(id)) {
            setCatalogOpen(true);
            setManageModelId(id);
        }
    }, [location.search]);
    const [panel, setPanel] = useState(null);
    const [qwen] = useConfig('qwen_tts', {});
    const [speechPolicy] = useConfig('speech_policy', 'engine');
    const [piper, setPiper] = useState(null);
    const [speechFamily, setSpeechFamily] = useState(null);
    const [kokoro, setKokoro] = useState(null);
    useEffect(() => {
        invoke('kokoro_model_status')
            .then(setKokoro)
            .catch(() => {});
        invoke('piper_catalog')
            .then(setPiper)
            .catch(() => {});
    }, []);
    const [voice, setVoice] = useState(null);
    const [notice, setNotice] = useState('');
    const [source, setSource] = useState('en');
    const [target, setTarget] = useState('zh-CN');
    const [format, setFormat] = useState('json');
    const [draft, setDraft] = useState('');
    const [preview, setPreview] = useState(null);
    const [libraryBusy, setLibraryBusy] = useState(false);
    const [strategy, setStrategy] = useState('merge');
    const [connections, setConnections] = useState([]);
    const [chosen, setChosen] = useState('');
    const [connectionName, setConnectionName] = useState('');
    const [protocol, setProtocol] = useState('openai');
    const [url, setUrl] = useState('http://localhost:1234/v1');
    const [model, setModel] = useState('');
    const [secret, setSecret] = useState('');
    const [anonymous, setAnonymous] = useState(false);
    const [trial, setTrial] = useState('');
    const controller = useRef(null);
    const refresh = async () => {
        const list = (await store.get('translate_service_list')) ?? ['google'];
        const all = await Promise.all(list.map(async (key) => ({ key, config: await store.get(key) })));
        setServices(all);
        const configs = all.filter(({ key }) => ['openai', 'ollama'].includes(key.split('@')[0]));
        setConnections(configs);
        const next = {};
        for (const pair of [...pairs, 'm2m100', 'hymt-q4', 'hymt-q8']) {
            next[pair] = await invoke('local_mt_model_status', { pair });
            setStatus((previous) => ({ ...previous, [pair]: next[pair] }));
        }
        setStatus(next);

        if (configs.some((item) => item.config?.apiKey || Object.keys(item.config?.headers ?? {}).length))
            setNotice(t('models.migration_pending'));
    };
    useEffect(() => {
        let live = true;
        refresh().catch(() => setNotice(t('models.status_failed')));
        invoke('tts_inventory')
            .then((v) => live && setVoice(v))
            .catch(() => live && setVoice({ supported: false }));
        const taskListener = listen('local_mt_task', ({ payload }) => {
            if (!live) return;
            setStatus((prev) => ({ ...prev, [payload.pair]: { ...prev[payload.pair], task: payload } }));
            if (['ready', 'failed', 'paused', 'cancelled'].includes(payload.state)) refresh().catch(() => {});
        });
        return () => {
            live = false;
            controller.current?.abort();
            taskListener.then((stop) => stop());
        };
    }, []);
    const act = async (action) => {
        setNotice('');
        try {
            await action();
        } catch (error) {
            setNotice(error.message ?? String(error));
        }
    };
    const saveLibrary = async (value) => {
        if (libraryBusy) return;
        setLibraryBusy(true);
        try {
            await persistGlossary(store, value);
            setLibrary(value);
            await emit('glossary_v2_changed', value);
            setPreview(null);
        } finally {
            setLibraryBusy(false);
        }
    };
    const testConnection = async (kind) => {
        controller.current?.abort();
        const request = new AbortController();
        controller.current = request;
        const release = registerRequestController(request);
        const timer = setTimeout(() => request.abort(), 30000);
        setTrial('');
        try {
            await checkPolicy('translate', protocol);
            let config = chosen ? connections.find((c) => c.key === chosen)?.config : null;
            config = {
                ...config,
                requestPath: url,
                model,
                apiKey: secret || config?.apiKey,
                service: config?.service ?? 'openai',
                stream: false,
            };
            if (kind === 'test') {
                const resolved = await resolveSecrets(config);
                const base = new URL(connectionUrl(url, protocol));
                base.pathname =
                    protocol === 'ollama'
                        ? base.pathname.replace(/\/chat$/, '/tags')
                        : base.pathname.replace(/\/chat\/completions$/, '/models');
                const response = await window.fetch(base.href, {
                    signal: request.signal,
                    redirect: 'error',
                    headers: {
                        ...resolved.headers,
                        ...(resolved.apiKey ? { Authorization: `Bearer ${resolved.apiKey}` } : {}),
                    },
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                await response.json();
                if (!request.signal.aborted) setTrial(t('models.connected'));
            } else {
                const output = await providers[protocol].translate(
                    'Please close the window.',
                    'English',
                    'Simplified Chinese',
                    { config, signal: request.signal, detect: 'en' }
                );
                if (!request.signal.aborted) setTrial(output);
            }
        } catch (error) {
            if (error?.name === 'AbortError') throw new Error(t('models.connection_cancelled'));
            if (/^HTTP \d{3}$/.test(error?.message ?? '') || error?.message === 'Blocked by device-only policy')
                throw error;
            throw new Error(t('models.connection_failed'));
        } finally {
            clearTimeout(timer);
            release();
        }
    };
    const saveConnection = async () => {
        connectionUrl(url, protocol);
        const key = chosen || createServiceInstanceKey(protocol);
        const previous = connections.find((c) => c.key === key)?.config ?? {};
        const config = {
            ...previous,
            instanceName: connectionName || protocol,
            requestPath: url,
            model,
            service: previous.service ?? 'openai',
            allowAnonymous: anonymous,
            stream: previous.stream ?? false,
        };
        if (secret) config.apiKey = secret;
        await store.set(key, config);
        const list = (await store.get('translate_service_list')) ?? ['google'];
        if (!list.includes(key)) await store.set('translate_service_list', [...list, key]);
        await store.save();
        await emit('translate_service_list_changed', await store.get('translate_service_list'));
        setSecret('');
        await refresh();
        setChosen(key);
        setNotice(t('models.saved'));
    };
    const openConnection = (key) => {
        const config = connections.find((connection) => connection.key === key)?.config;
        setChosen(key ?? '');
        setSecret('');
        setTrial('');
        setConnectionName(config?.instanceName ?? '');
        setProtocol(key ? key.split('@')[0] : 'openai');
        setUrl(config?.requestPath ?? 'http://localhost:1234/v1');
        setModel(config?.model ?? '');
        setAnonymous(config?.allowAnonymous ?? false);
        setPanel('connections');
    };
    const toggleService = (key, enable) =>
        act(async () => {
            const previous = await store.get(key);
            setServices((rows) =>
                rows.map((row) => (row.key === key ? { ...row, config: { ...row.config, enable } } : row))
            );
            await store.set(key, { ...previous, enable });
            try {
                await store.save();
            } catch (error) {
                await store.set(key, previous);
                setServices((rows) => rows.map((row) => (row.key === key ? { ...row, config: previous } : row)));
                throw error;
            }
            await emit('translate_service_list_changed', await store.get('translate_service_list'));
            await refresh();
        });
    const chooseSpeechPolicy = (value) =>
        act(async () => {
            await store.set('speech_policy', value);
            await store.save();
            await emit('speech_policy_changed', value);
        });
    return (
        <div className='models-page models-prototype-page'>
            <ServicesHome
                services={services}
                status={status}
                privacy={privacy}
                voice={voice}
                piper={piper}
                onPiperSettings={() => setSpeechFamily('piper')}
                kokoro={kokoro}
                qwen={qwen}
                onQwenSettings={() => setSpeechFamily('qwen')}
                onKokoroSettings={() => setSpeechFamily('kokoro')}
                onAddVoice={() => setSpeechFamily('choose')}
                speechPolicy={speechPolicy}
                onToggle={toggleService}
                onSpeechPolicy={chooseSpeechPolicy}
                onAdd={() => setCatalogOpen(true)}
                onManage={(id) => {
                    if (!status[id]?.installed) setCatalogOpen(true);
                    setManageModelId(id);
                }}
                onConnect={openConnection}
                onVoiceSettings={() => setPanel('voice')}
                onGlossary={() => setPanel('glossary')}
            />
            <SpeechModels
                open={speechFamily === 'choose'}
                onClose={() => setSpeechFamily(null)}
                onSelect={setSpeechFamily}
            />
            <QwenSpeech
                open={speechFamily === 'qwen'}
                onClose={() => setSpeechFamily(null)}
            />
            <KokoroVoices
                open={speechFamily === 'kokoro'}
                onClose={() => setSpeechFamily(null)}
                onBack={() => setSpeechFamily('choose')}
                onChange={setKokoro}
                onSpeechPolicy={chooseSpeechPolicy}
            />
            <PiperVoices
                open={speechFamily === 'piper'}
                onClose={() => setSpeechFamily(null)}
                onChange={setPiper}
            />
            {notice && (
                <p
                    role='alert'
                    className='model-catalog-error'
                >
                    {notice}
                </p>
            )}
            <details className='service-policy-details'>
                <summary>
                    {t('models.home_privacy_settings')}
                    <span>{t(privacy === 'device_only' ? 'models.device_only' : 'models.home_standard')}</span>
                </summary>
                <div>
                    <Switch
                        size='sm'
                        isSelected={privacy === 'device_only'}
                        onValueChange={(value) => setPrivacy(value ? 'device_only' : 'standard')}
                    >
                        {t('models.device_only')}
                    </Switch>
                    <p>{t('models.privacy_hint')}</p>
                </div>
            </details>
            <ModelCatalog
                status={status}
                refresh={refresh}
                act={act}
                browseOpen={catalogOpen}
                onBrowseClose={() => setCatalogOpen(false)}
                manageModelId={manageModelId}
                onManageHandled={() => setManageModelId(null)}
            />
            <Modal
                disableAnimation
                isOpen={!!panel}
                onClose={() => {
                    setPanel(null);
                    controller.current?.abort();
                }}
                size='2xl'
                scrollBehavior='inside'
                classNames={{
                    base: 'model-install-dialog service-form-dialog',
                    header: 'model-install-header',
                    body: 'model-install-body',
                }}
            >
                <ModalContent>
                    <ModalHeader>
                        {t(
                            panel === 'connections'
                                ? 'models.home_custom_api'
                                : panel === 'voice'
                                  ? 'models.system_voice'
                                  : 'models.home_glossary'
                        )}
                    </ModalHeader>
                    <ModalBody>
                        {notice && (
                            <p
                                role='alert'
                                className='model-catalog-error'
                            >
                                {notice}
                            </p>
                        )}
                        {panel === 'connections' && (
                            <>
                                <Card
                                    data-cup-card
                                    className='models-card'
                                >
                                    <CardBody className='models-card-body'>
                                        <Select
                                            size='sm'
                                            label={t('models.existing')}
                                            selectedKeys={chosen ? [chosen] : []}
                                            onSelectionChange={(keys) => {
                                                const key = [...keys][0] ?? '';
                                                setChosen(key);
                                                const config = connections.find((c) => c.key === key)?.config;
                                                if (config) {
                                                    setProtocol(key.split('@')[0]);
                                                    setUrl(config.requestPath);
                                                    setModel(config.model);
                                                    setConnectionName(config.instanceName ?? '');
                                                    setAnonymous(config.allowAnonymous ?? false);
                                                }
                                                setSecret('');
                                            }}
                                        >
                                            {connections.map((c) => (
                                                <SelectItem key={c.key}>{c.config?.instanceName || c.key}</SelectItem>
                                            ))}
                                        </Select>
                                        <Button
                                            size='sm'
                                            onPress={() => {
                                                setChosen('');
                                                setConnectionName('');
                                                setSecret('');
                                            }}
                                        >
                                            {t('models.new_connection')}
                                        </Button>
                                        <Select
                                            size='sm'
                                            label={t('models.protocol')}
                                            isDisabled={!!chosen}
                                            selectedKeys={[protocol]}
                                            onSelectionChange={(keys) => {
                                                const v = [...keys][0] ?? 'openai';
                                                setProtocol(v);
                                                setUrl(
                                                    v === 'ollama'
                                                        ? 'http://localhost:11434'
                                                        : 'http://localhost:1234/v1'
                                                );
                                            }}
                                        >
                                            {['openai', 'ollama'].map((v) => (
                                                <SelectItem key={v}>
                                                    {v === 'openai' ? 'OpenAI-compatible / LM Studio / vLLM' : 'Ollama'}
                                                </SelectItem>
                                            ))}
                                        </Select>
                                        <Input
                                            size='sm'
                                            label={t('services.instance_name')}
                                            value={connectionName}
                                            onValueChange={setConnectionName}
                                        />
                                        <Input
                                            size='sm'
                                            label='Base URL / endpoint'
                                            value={url}
                                            onValueChange={setUrl}
                                        />
                                        <Input
                                            size='sm'
                                            label={t('models.model')}
                                            value={model}
                                            onValueChange={setModel}
                                        />
                                        <Input
                                            size='sm'
                                            label={t('models.credential')}
                                            type='password'
                                            value={secret}
                                            onValueChange={setSecret}
                                            placeholder={chosen ? t('models.rebind') : ''}
                                        />
                                        <Switch
                                            size='sm'
                                            isSelected={anonymous}
                                            onValueChange={setAnonymous}
                                        >
                                            {t('models.anonymous')}
                                        </Switch>
                                        <p className='text-xs'>{t('models.proxy_hint')}</p>
                                        <div className='connection-actions flex gap-2'>
                                            <Button onPress={() => act(() => testConnection('test'))}>
                                                {t('models.test')}
                                            </Button>
                                            <Button onPress={() => act(() => testConnection('trial'))}>
                                                {t('models.trial')}
                                            </Button>
                                            <Button onPress={() => controller.current?.abort()}>
                                                {t('common.cancel')}
                                            </Button>
                                            <Button
                                                size='sm'
                                                color='primary'
                                                onPress={() => act(saveConnection)}
                                            >
                                                {t('common.save')}
                                            </Button>
                                        </div>
                                        {trial && (
                                            <p
                                                className='select-text whitespace-pre-wrap'
                                                role='status'
                                            >
                                                {trial}
                                            </p>
                                        )}
                                    </CardBody>
                                </Card>
                            </>
                        )}
                        {panel === 'voice' && (
                            <>
                                <Card
                                    data-cup-card
                                    className='models-card'
                                >
                                    <CardBody className='models-card-body'>
                                        <div className='models-product-head'>
                                            <span className='models-product-icon'>
                                                <LuVolume2 size={20} />
                                            </span>
                                            <div>
                                                <h2>{t('models.system_voice')}</h2>
                                                <p>{t('models.system_voice_summary')}</p>
                                            </div>
                                            <span className='models-status ready'>
                                                {voice?.supported ? t('models.available') : t('models.not_ready')}
                                            </span>
                                        </div>

                                        <p>
                                            {voice?.supported
                                                ? `${voice.engine} · ${voice.offline ? t('models.offline') : t('models.unverified')}`
                                                : t('models.voice_unavailable')}
                                        </p>
                                        <p className='text-xs'>{voice?.reason}</p>
                                        <details className='models-details'>
                                            <summary>
                                                {t('models.installed_voices')} · {voice?.voices?.length ?? 0}
                                            </summary>
                                            <div className='models-voices'>
                                                {voice?.voices?.map((voice, index) => (
                                                    <div key={index}>
                                                        <span>{voice.name}</span>
                                                        <small>{voice.locale}</small>
                                                    </div>
                                                ))}
                                            </div>
                                        </details>
                                        <p>{t('models.voice_help')}</p>
                                        <section className='models-deferred-voice'>
                                            <span className='models-deferred-icon'>
                                                <LuLock size={16} />
                                            </span>
                                            <div>
                                                <strong>
                                                    Piper{' '}
                                                    <span className='models-badge'>{t('models.not_offered')}</span>
                                                </strong>
                                                <p>{t('models.piper_scope_note')}</p>
                                            </div>
                                        </section>
                                    </CardBody>
                                </Card>
                            </>
                        )}
                        {panel === 'glossary' && (
                            <>
                                <Card
                                    data-cup-card
                                    className='models-card'
                                >
                                    <CardBody className='models-card-body'>
                                        <Switch
                                            size='sm'
                                            isSelected={!!library?.enabled}
                                            isDisabled={libraryBusy}
                                            onValueChange={(value) =>
                                                act(() =>
                                                    saveLibrary({
                                                        ...library,
                                                        enabled: value,
                                                        revision: (library?.revision ?? 0) + 1,
                                                    })
                                                )
                                            }
                                        >
                                            {t('models.enable_glossary')}
                                        </Switch>
                                        <p className='text-xs'>{t('models.glossary_hint')}</p>
                                        <Select
                                            size='sm'
                                            label={t('models.style')}
                                            selectedKeys={[library?.style || 'none']}
                                            isDisabled={libraryBusy}
                                            onSelectionChange={(keys) =>
                                                act(() =>
                                                    saveLibrary({
                                                        ...library,
                                                        style: [...keys][0],
                                                        revision: (library?.revision ?? 0) + 1,
                                                    })
                                                )
                                            }
                                        >
                                            {['none', 'formal', 'concise'].map((v) => (
                                                <SelectItem key={v}>{t(`models.style_${v}`)}</SelectItem>
                                            ))}
                                        </Select>
                                        <Button
                                            size='sm'
                                            onPress={() => {
                                                setDraft(
                                                    JSON.stringify(
                                                        {
                                                            ...library,
                                                            schemaVersion: 2,
                                                            sourceLanguage: library?.sourceLanguage || 'en',
                                                            targetLanguage: library?.targetLanguage || 'zh-CN',
                                                        },
                                                        null,
                                                        2
                                                    )
                                                );
                                                setFormat('json');
                                                setPreview(null);
                                            }}
                                        >
                                            {t('models.edit_entries')}
                                        </Button>
                                        <Select
                                            size='sm'
                                            label={t('models.format')}
                                            selectedKeys={[format]}
                                            onSelectionChange={(keys) => {
                                                setFormat([...keys][0] ?? 'json');
                                                setPreview(null);
                                            }}
                                        >
                                            <SelectItem key='json'>JSON</SelectItem>
                                            <SelectItem key='csv'>CSV</SelectItem>
                                        </Select>
                                        <Input
                                            size='sm'
                                            label={t('models.source_language')}
                                            value={source}
                                            onValueChange={(v) => {
                                                setSource(v);
                                                setPreview(null);
                                            }}
                                        />
                                        <Input
                                            size='sm'
                                            label={t('models.target_language')}
                                            value={target}
                                            onValueChange={(v) => {
                                                setTarget(v);
                                                setPreview(null);
                                            }}
                                        />
                                        <input
                                            type='file'
                                            accept='.json,.csv'
                                            aria-label={t('models.import_file')}
                                            onChange={(event) =>
                                                act(async () => {
                                                    const file = event.target.files?.[0];
                                                    if (!file) return;
                                                    if (file.size > 10 * 1024 * 1024)
                                                        throw new Error('Glossary exceeds 10 MB');
                                                    setFormat(
                                                        file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'json'
                                                    );
                                                    setDraft(await file.text());
                                                    setPreview(null);
                                                })
                                            }
                                        />
                                        <Textarea
                                            label={t('models.import_editor')}
                                            minRows={8}
                                            value={draft}
                                            onValueChange={(value) => {
                                                setDraft(value);
                                                setPreview(null);
                                            }}
                                        />
                                        <Button
                                            size='sm'
                                            onPress={() =>
                                                act(async () =>
                                                    setPreview(
                                                        previewGlossary(
                                                            library,
                                                            parseGlossary(draft, format, {
                                                                sourceLanguage: source,
                                                                targetLanguage: target,
                                                            })
                                                        )
                                                    )
                                                )
                                            }
                                        >
                                            {t('models.preview')}
                                        </Button>
                                        {preview && (
                                            <>
                                                <p>
                                                    {['added', 'updated', 'duplicate', 'conflict']
                                                        .map(
                                                            (state) =>
                                                                `${t(`models.import_${state}`)}: ${preview.rows.filter((row) => row.status === state).length}`
                                                        )
                                                        .join(' · ')}
                                                </p>
                                                <div className='max-h-64 overflow-auto'>
                                                    {preview.rows.slice(0, 200).map((row, i) => (
                                                        <p key={i}>
                                                            {i + 1}. {row.entry.source} → {row.entry.target} ·{' '}
                                                            {t(`models.import_${row.status}`)}
                                                        </p>
                                                    ))}
                                                </div>
                                                <p className='text-xs'>{t('models.conflict_help')}</p>
                                                <Select
                                                    size='sm'
                                                    label={t('models.strategy')}
                                                    selectedKeys={[strategy]}
                                                    onSelectionChange={(keys) => setStrategy([...keys][0] ?? 'merge')}
                                                >
                                                    {['merge', 'skip', 'replace'].map((v) => (
                                                        <SelectItem key={v}>{t(`models.strategy_${v}`)}</SelectItem>
                                                    ))}
                                                </Select>
                                                <Button
                                                    size='sm'
                                                    color='primary'
                                                    isDisabled={
                                                        libraryBusy ||
                                                        preview.rows.some((row) => row.status === 'conflict')
                                                    }
                                                    onPress={() =>
                                                        act(async () => {
                                                            const next = commitGlossary(library, preview, strategy);
                                                            await saveLibrary({
                                                                ...next,
                                                                enabled: library?.enabled ?? true,
                                                                style: library?.style,
                                                            });
                                                            setNotice(t('models.saved'));
                                                        })
                                                    }
                                                >
                                                    {t('models.confirm_import')}
                                                </Button>
                                            </>
                                        )}
                                    </CardBody>
                                </Card>
                            </>
                        )}
                    </ModalBody>
                    <ModalFooter>
                        <Button
                            size='sm'
                            variant='light'
                            onPress={() => {
                                setPanel(null);
                                controller.current?.abort();
                            }}
                        >
                            {t('common.close')}
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>
        </div>
    );
}
