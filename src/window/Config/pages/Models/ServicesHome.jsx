import React, { useState } from 'react';
import { Button, Switch } from '@nextui-org/react';
import { LuPlus, LuServer, LuVolume2, LuLock, LuSettings2, LuCpu } from 'react-icons/lu';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { localServiceSummary } from '../../../../utils/modelServices';

export default function ServicesHome({
    services,
    status,
    privacy,
    voice,
    piper,
    kokoro,
    onKokoroSettings,
    onAddVoice,
    onPiperSettings,
    speechPolicy,
    onToggle,
    onSpeechPolicy,
    onAdd,
    onManage,
    onConnect,
    onVoiceSettings,
    onGlossary,
}) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [tab, setTab] = useState('translation');
    const [orderInfo, setOrderInfo] = useState(false);
    const localSpeech = voice?.supported && voice.offline;
    const count =
        tab === 'translation'
            ? services.filter(({ config }) => config?.enable !== false && config?.enable !== 'false').length
            : Number(
                  (speechPolicy === 'kokoro' && kokoro?.installed) ||
                      (speechPolicy === 'piper' && piper?.voices?.some((entry) => entry.installed)) ||
                      (speechPolicy === 'local' && localSpeech) ||
                      (speechPolicy === 'google' && privacy !== 'device_only')
              );
    return (
        <div className='models-service-home'>
            <header className='service-page-head'>
                <div>
                    <h1>{t('models.home_title')}</h1>
                    <p>{t('models.home_subtitle')}</p>
                </div>
                <div className='service-head-metric'>
                    <b>{count}</b>
                    <span>{t('models.home_enabled_count')}</span>
                </div>
            </header>
            <div
                className='service-segmented'
                role='tablist'
                aria-label={t('models.home_title')}
            >
                <button
                    role='tab'
                    aria-selected={tab === 'translation'}
                    className={tab === 'translation' ? 'active' : ''}
                    onClick={() => setTab('translation')}
                >
                    {t('models.home_translation_tab')}
                </button>
                <button
                    role='tab'
                    aria-selected={tab === 'speech'}
                    className={tab === 'speech' ? 'active' : ''}
                    onClick={() => setTab('speech')}
                >
                    {t('models.home_speech_tab')}
                </button>
            </div>
            {tab === 'translation' ? (
                <div role='tabpanel'>
                    <section className='service-panel'>
                        <div className='service-panel-head'>
                            <h3>{t('models.home_added')}</h3>
                            <span>{t('models.home_parallel')}</span>
                            <button
                                className='service-text-button'
                                onClick={() => setOrderInfo(!orderInfo)}
                            >
                                {t('models.home_order')}
                            </button>
                        </div>
                        {orderInfo && (
                            <div className='service-order-note'>
                                <p>{t('models.home_order_hint')}</p>
                                <button
                                    className='service-text-button'
                                    onClick={() => navigate('/service')}
                                >
                                    {t('models.home_reorder')}
                                </button>
                            </div>
                        )}
                        {services.map(({ key, config }) => {
                            const name = key.split('@')[0];
                            const local = name === 'local_mt';
                            const connected = ['openai', 'ollama'].includes(name);
                            const summary = localServiceSummary(key, config, status);
                            const title =
                                config?.instanceName ||
                                (local
                                    ? summary.family === 'hymt'
                                        ? 'HY-MT1.5'
                                        : summary.family === 'm2m100'
                                          ? 'M2M-100'
                                          : 'OPUS-MT'
                                    : t(`services.translate.${name}.title`, { defaultValue: name }));
                            return (
                                <div
                                    className='service-home-row'
                                    key={key}
                                >
                                    <span
                                        className={`service-home-logo ${name === 'google' ? 'google' : local ? 'local' : ''}`}
                                    >
                                        {name === 'google' ? 'G' : local ? <LuCpu size={16} /> : <LuServer size={16} />}
                                    </span>
                                    <div className='service-home-copy'>
                                        <div className='service-title-line'>
                                            <strong>{title}</strong>
                                            {name === 'google' && (
                                                <span className='service-mini-badge default'>
                                                    {t('models.home_default')}
                                                </span>
                                            )}
                                            <span className='service-mini-badge'>
                                                {t(local ? 'models.offline' : 'models.home_online')}
                                            </span>
                                            {local && (
                                                <span className={`service-mini-badge ${summary.ready ? 'ready' : ''}`}>
                                                    {t(
                                                        summary.checking
                                                            ? 'models.home_checking'
                                                            : summary.ready
                                                              ? 'models.ready'
                                                              : 'models.not_ready'
                                                    )}
                                                </span>
                                            )}
                                        </div>
                                        <p>
                                            {summary.family === 'hymt' &&
                                                `${config?.variant === 'hymt-q8' ? 'Q8_0' : 'Q4_K_M'} · `}
                                            {local
                                                ? t(
                                                      summary.family === 'hymt'
                                                          ? 'models.hy_scope'
                                                          : summary.family === 'm2m100'
                                                            ? 'models.home_multi_hint'
                                                            : 'models.home_opus_hint'
                                                  )
                                                : name === 'google'
                                                  ? t('models.home_google_hint')
                                                  : connected
                                                    ? `${config?.model || t('models.model')} · ${name === 'ollama' ? 'Ollama' : 'OpenAI-compatible'}`
                                                    : t('models.home_existing_hint')}
                                        </p>
                                        {privacy === 'device_only' && !local && (
                                            <small>{t('models.home_privacy_blocked')}</small>
                                        )}
                                    </div>
                                    <div className='service-home-actions'>
                                        {name !== 'google' && (
                                            <button
                                                className='service-text-button'
                                                onClick={() =>
                                                    local
                                                        ? onManage(summary.manageId)
                                                        : connected
                                                          ? onConnect(key)
                                                          : navigate('/service')
                                                }
                                            >
                                                {t('models.home_settings')}
                                            </button>
                                        )}
                                        <Switch
                                            size='sm'
                                            aria-label={`${t('models.service_enabled')} ${title}`}
                                            isSelected={config?.enable !== false && config?.enable !== 'false'}
                                            onValueChange={(value) => onToggle(key, value)}
                                        />
                                    </div>
                                </div>
                            );
                        })}
                        {Object.entries(status)
                            .filter(([, item]) => item?.task && !['ready', 'cancelled'].includes(item.task.state))
                            .map(([id, item]) => (
                                <div
                                    className='service-background-task'
                                    key={id}
                                >
                                    <div>
                                        <strong>{id === 'm2m100' ? 'M2M-100' : `OPUS-MT · ${id}`}</strong>
                                        <span>
                                            {t(`models.state_${item.task.state}`)}
                                            {item.task.total
                                                ? ` · ${(item.task.bytes / 1e6).toFixed(1)} / ${(item.task.total / 1e6).toFixed(1)} MB`
                                                : ''}
                                        </span>
                                    </div>
                                    <button
                                        className='service-text-button'
                                        onClick={() => onManage(id)}
                                    >
                                        {t('models.manage_install')}
                                    </button>
                                </div>
                            ))}
                        <div className='service-add-row'>
                            <span className='service-plus-circle'>
                                <LuPlus size={18} />
                            </span>
                            <div>
                                <strong>{t('models.home_add_local')}</strong>
                                <p>{t('models.home_add_hint')}</p>
                            </div>
                            <Button
                                size='sm'
                                className='service-primary-button'
                                onPress={onAdd}
                            >
                                {t('models.home_add')}
                            </Button>
                        </div>
                    </section>
                    <section className='service-panel'>
                        <div className='service-panel-head'>
                            <h3>{t('models.home_connections')}</h3>
                            <span>{t('models.home_connections_hint')}</span>
                        </div>
                        <div className='service-home-row'>
                            <span className='service-home-logo'>
                                <LuServer size={16} />
                            </span>
                            <div className='service-home-copy'>
                                <div className='service-title-line'>
                                    <strong>{t('models.home_custom_api')}</strong>
                                    <span className='service-mini-badge'>Base URL · Key · Model</span>
                                </div>
                                <p>{t('models.home_custom_hint')}</p>
                            </div>
                            <Button
                                size='sm'
                                variant='bordered'
                                className='service-secondary-button'
                                onPress={() => onConnect()}
                            >
                                {t('models.home_connect')}
                            </Button>
                        </div>
                    </section>
                </div>
            ) : (
                <div role='tabpanel'>
                    <section className='service-panel'>
                        <div className='service-panel-head'>
                            <h3>{t('models.home_speech_services')}</h3>
                            <span>{t('models.home_speech_follow')}</span>
                        </div>
                        <div className='service-home-row'>
                            <span className='service-home-logo system'>
                                <LuVolume2 size={17} />
                            </span>
                            <div className='service-home-copy'>
                                <div className='service-title-line'>
                                    <strong>{t('models.system_voice')}</strong>
                                    <span className='service-mini-badge default'>{t('models.home_no_download')}</span>
                                    <span className='service-mini-badge'>
                                        {t(localSpeech ? 'models.available' : 'models.not_ready')}
                                    </span>
                                </div>
                                <p>{t('models.home_system_hint')}</p>
                            </div>
                            <div className='service-home-actions'>
                                <button
                                    className='service-text-button'
                                    onClick={onVoiceSettings}
                                >
                                    {t('models.home_settings')}
                                </button>
                                <Switch
                                    size='sm'
                                    aria-label={t('models.system_voice')}
                                    isDisabled={!localSpeech}
                                    isSelected={speechPolicy === 'local'}
                                    onValueChange={(value) => onSpeechPolicy(value ? 'local' : 'off')}
                                />
                            </div>
                        </div>
                        <div className='service-home-row'>
                            <span className='service-home-logo google'>G</span>
                            <div className='service-home-copy'>
                                <div className='service-title-line'>
                                    <strong>{t('models.google_speech')}</strong>
                                    <span className='service-mini-badge'>{t('models.home_online')}</span>
                                </div>
                                <p>
                                    {t(
                                        privacy === 'device_only'
                                            ? 'models.home_privacy_blocked'
                                            : 'models.home_google_speech_hint'
                                    )}
                                </p>
                            </div>
                            <Switch
                                size='sm'
                                aria-label={t('models.google_speech')}
                                isDisabled={privacy === 'device_only'}
                                isSelected={speechPolicy === 'google'}
                                onValueChange={(value) => onSpeechPolicy(value ? 'google' : 'off')}
                            />
                        </div>
                        {piper?.voices?.some((entry) => entry.installed) && (
                            <div className='service-home-row'>
                                <span className='service-home-logo local'>
                                    <LuVolume2 size={16} />
                                </span>
                                <div className='service-home-copy'>
                                    <div className='service-title-line'>
                                        <strong>Piper</strong>
                                        <span className='service-mini-badge'>{t('models.offline_short')}</span>
                                    </div>
                                    <p>
                                        {t('models.piper_service_hint', {
                                            count: piper.voices.filter((entry) => entry.installed).length,
                                        })}
                                    </p>
                                </div>
                                <div className='service-home-actions'>
                                    <button
                                        className='service-text-button'
                                        onClick={onPiperSettings}
                                    >
                                        {t('models.home_settings')}
                                    </button>
                                    <Switch
                                        size='sm'
                                        aria-label='Piper'
                                        isSelected={speechPolicy === 'piper'}
                                        onValueChange={(value) => onSpeechPolicy(value ? 'piper' : 'off')}
                                    />
                                </div>
                            </div>
                        )}
                        {kokoro?.installed && (
                            <div className='service-home-row'>
                                <span className='service-home-logo local'>
                                    <LuVolume2 size={16} />
                                </span>
                                <div className='service-home-copy'>
                                    <div className='service-title-line'>
                                        <strong>Kokoro</strong>
                                        <span className='service-mini-badge'>{t('models.offline_short')}</span>
                                    </div>
                                    <p>{t('models.kokoro_service_hint')}</p>
                                </div>
                                <div className='service-home-actions'>
                                    <button
                                        className='service-text-button'
                                        onClick={onKokoroSettings}
                                    >
                                        {t('models.home_settings')}
                                    </button>
                                    <Switch
                                        size='sm'
                                        aria-label='Kokoro'
                                        isSelected={speechPolicy === 'kokoro'}
                                        onValueChange={(value) => onSpeechPolicy(value ? 'kokoro' : 'off')}
                                    />
                                </div>
                            </div>
                        )}
                        <div className='service-add-row'>
                            <span className='service-plus-circle'>
                                <LuPlus size={17} />
                            </span>
                            <div>
                                <strong>{t('models.home_add_voice')}</strong>
                                <p>{piper?.supported === false ? piper.reason : t('models.piper_add_hint')}</p>
                            </div>
                            <Button
                                size='sm'
                                className='service-primary-button'
                                onPress={onAddVoice}
                            >
                                {t('models.home_add')}
                            </Button>
                        </div>
                    </section>
                </div>
            )}
            <div className='service-home-footer'>
                <button
                    className='service-text-button'
                    onClick={onGlossary}
                >
                    <LuSettings2 size={12} />
                    {t('models.home_glossary')}
                </button>
            </div>
        </div>
    );
}
