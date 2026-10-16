import ConfigTransfer from '../../components/ConfigTransfer';
import { enable, isEnabled, disable } from 'tauri-plugin-autostart-api';
import { DropdownTrigger } from '@nextui-org/react';
import React, { useState, useEffect } from 'react';
import toast, { Toaster } from 'react-hot-toast';
import { DropdownMenu } from '@nextui-org/react';
import { DropdownItem } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
import { CardBody } from '@nextui-org/react';
import { Dropdown } from '@nextui-org/react';
import { info } from 'tauri-plugin-log-api';
import { Button } from '@nextui-org/react';
import { Switch } from '@nextui-org/react';
import 'flag-icons/css/flag-icons.min.css';
import { Input } from '@nextui-org/react';
import { Card } from '@nextui-org/react';
import { invoke } from '@tauri-apps/api';

import { useConfig } from '../../../../hooks/useConfig';
import { LanguageFlag } from '../../../../utils/language';
import { useToastStyle } from '../../../../hooks';
import { osType } from '../../../../utils/env';
import { nextPortValue } from '../../../../utils/port';
import { isFilledPort, isFilledString } from '../../../../utils/configValue';

let timer = null;

export default function General() {
    const [autoStart, setAutoStart] = useState(false);
    const [fontList, setFontList] = useState(null);
    const [checkUpdate, setCheckUpdate] = useConfig('check_update', true);
    const [serverPort, setServerPort] = useConfig('server_port', 60828);
    const [appLanguage, setAppLanguage] = useConfig('app_language', 'zh_cn');
    const [appTheme, setAppTheme] = useConfig('app_theme', 'system');
    const [appFont, setAppFont] = useConfig('app_font', 'default');
    const [appFallbackFont, setAppFallbackFont] = useConfig('app_fallback_font', 'default');
    const [appFontSize, setAppFontSize] = useConfig('app_font_size', 16);
    const [transparent, setTransparent] = useConfig('transparent', true);
    const [devMode, setDevMode] = useConfig('dev_mode', false);
    const [trayClickEvent, setTrayClickEvent] = useConfig('tray_click_event', 'config');
    const [proxyEnable, setProxyEnable] = useConfig('proxy_enable', false);
    const [proxyHost, setProxyHost] = useConfig('proxy_host', '');
    const [proxyPort, setProxyPort] = useConfig('proxy_port', '');
    const [proxyUsername, setProxyUsername] = useConfig('proxy_username', '');
    const [proxyPassword, setProxyPassword] = useConfig('proxy_password', '');
    const [noProxy, setNoProxy] = useConfig('no_proxy', 'localhost,127.0.0.1');
    const { t, i18n } = useTranslation();
    const toastStyle = useToastStyle();

    const languageName = {
        zh_cn: '简体中文',
        zh_tw: '繁體中文',
        en: 'English',
        ja: '日本語',
        ko: '한국어',
        fr: 'Français',
        es: 'Español',
        ru: 'Русский',
        de: 'Deutsch',
        it: 'Italiano',
        tr: 'Türkçe',
        pt_pt: 'Português',
        pt_br: 'Português (Brasil)',
        nb_no: 'Norsk Bokmål',
        nn_no: 'Norsk Nynorsk',
        fa: 'فارسی',
        uk: 'Українська',
        ar: 'العربية',
        he: 'עִבְרִית',
        ta: 'தமிழ்',
        tk: 'Türkmen',
    };

    // 翻译完整度远低于 en_US（361 个 key）的语言。以 en_US 为基准，这些语言的
    // key 数分别是：tr_TR / nb_NO / nn_NO 各 2 个、tk_TM 68、ja_JP 93、fa_IR 97。
    // 选中它们时界面大部分会回退到英文，若不提示，用户会以为是 bug。
    // 这里只在名称后加星号标注，**不改动语言文件本身**——补齐翻译需要母语校验，
    // 不是靠机翻可以交付的东西。该列表由 tests/locale-completeness.test.mjs 守着。
    const incompleteLanguages = ['tr', 'nb_no', 'nn_no', 'tk', 'ja', 'fa'];
    const languageLabel = (key) => (incompleteLanguages.includes(key) ? `${languageName[key]} *` : languageName[key]);

    useEffect(() => {
        // `isEnabled` 是 `tauri-plugin-autostart-api` 的
        // `await invoke('plugin:autostart|is_enabled')`（真实 IPC），**会 reject**
        // （插件未注册 / 平台不支持 / 系统调用失败）。
        //
        // 原先只有一个 `.then()`，失败时：
        //   · `setAutoStart` 从不执行 -> 开关停在初始值，可能与系统实际状态**相反**，
        //     用户看到一个错误的状态且没有任何提示；
        //   · 同时留下一个**未处理的 Promise 拒绝**（仓库里没有任何
        //     `window.unhandledrejection` 兜底，已 grep 确认）。
        //
        // 本文件下面就有一处已经是 `.then(...).catch(...)` 的正确写法
        // （读取系统字体列表的那次调用），这里补齐一致。
        //
        // 注意：上面刻意**不**把那次调用的字面文本写进注释 ——
        // `tests/font-list-failure.test.mjs` 用 `indexOf` 在 effect 体内定位它，
        // 注释里出现同样的字面量会让定位命中注释、抽出一段残句而报
        // `SyntaxError: Unexpected end of input`（本轮就踩到过）。
        isEnabled()
            .then((v) => {
                setAutoStart(v);
            })
            .catch((e) => {
                info('Failed to read the auto-start status: ' + e);
            });
        // `font_list` 的 Rust 签名是 `Result<Vec<String>, Error>`（font-kit 的
        // `SystemSource::all_families()`），**是会 reject 的**。原来只有一个
        // `.then()`，一旦失败：① 产生一个未处理的 Promise 拒绝；② `fontList`
        // 永远停在 `null`，而下面两处字体下拉框都带 `fontList !== null` 条件，
        // 于是整个「应用字体 / 回退字体」选择器**静默消失**，用户看不到任何选项
        // 也看不到任何提示，只会以为功能没了。
        // 这里失败时把 fontList 置为空数组（而不是留在 null），让下拉框照常渲染、
        // 至少保住「默认」等已有取值；同时记一条日志便于排查。
        invoke('font_list')
            .then((v) => {
                setFontList(v);
            })
            .catch((e) => {
                info('Failed to load the system font list: ' + e);
                setFontList([]);
            });
        return () => {
            // 组件卸载时清理未触发的 debounce 定时器
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        };
    }, []);

    return (
        <>
            <Toaster />
            <Card
                data-cup-card
                className='mb-[10px]'
            >
                <CardBody data-cup-body>
                    <div className='config-item'>
                        <h3>{t('config.general.auto_start')}</h3>
                        <Switch
                            isSelected={autoStart}
                            onValueChange={(v) => {
                                setAutoStart(v);
                                // `enable` / `disable` 同样是
                                // `await invoke('plugin:autostart|...')`（真实 IPC），**会 reject**。
                                //
                                // 这里的关键风险是**静默的假成功**：上面那行 `setAutoStart(v)`
                                // 已经把开关切成用户点的位置，若 IPC 失败而无人处理，
                                // 界面显示「已开启」，但系统层面根本没写进去 ——
                                // 用户重启后才发现开机自启没生效，且全程没有任何提示。
                                // 因此失败时必须**把开关拨回去**并打日志，让界面与系统状态一致。
                                if (v) {
                                    enable()
                                        .then(() => {
                                            info('Auto start enabled');
                                        })
                                        .catch((e) => {
                                            info('Failed to enable auto start: ' + e);
                                            setAutoStart(false);
                                        });
                                } else {
                                    disable()
                                        .then(() => {
                                            info('Auto start disabled');
                                        })
                                        .catch((e) => {
                                            info('Failed to disable auto start: ' + e);
                                            setAutoStart(true);
                                        });
                                }
                            }}
                        />
                    </div>
                    <div className='config-item'>
                        <h3>{t('config.general.check_update')}</h3>
                        {checkUpdate !== null && (
                            <Switch
                                isSelected={checkUpdate}
                                onValueChange={(v) => {
                                    setCheckUpdate(v);
                                }}
                            />
                        )}
                    </div>
                    <div className='config-item config-port-row'>
                        <h3 className='my-auto'>{t('config.general.server_port')}</h3>
                        {serverPort !== null && (
                            <Input
                                type='number'
                                variant='bordered'
                                value={serverPort}
                                aria-label={t('config.general.server_port')}
                                className='config-port-control'
                                onValueChange={(v) => {
                                    if (parseInt(v) !== serverPort) {
                                        if (timer) {
                                            clearTimeout(timer);
                                        }
                                        timer = setTimeout(() => {
                                            toast.success(t('config.general.server_port_change'), {
                                                duration: 3000,
                                                style: toastStyle,
                                            });
                                        }, 1000);
                                    }
                                    // NaN 不能被写进配置（见 utils/port.js 的注释）；
                                    // 非法输入（'-' / '.' / 'e' 等中间态）一律忽略，保持原值
                                    const next = nextPortValue(v);
                                    if (next === null) {
                                        // 空串 = 用户清空了输入框，按「未设置」处理为 0
                                        setServerPort(v.trim() === '' ? 0 : serverPort);
                                    } else {
                                        setServerPort(next);
                                    }
                                }}
                            />
                        )}
                    </div>
                </CardBody>
            </Card>
            <Card
                data-cup-card
                className='mb-[10px]'
            >
                <CardBody data-cup-body>
                    <div className='config-item'>
                        <h3 className='my-auto'>{t('config.general.app_language')}</h3>
                        {appLanguage !== null && (
                            <Dropdown>
                                <DropdownTrigger>
                                    <Button
                                        variant='bordered'
                                        startContent={<span className={`fi fi-${LanguageFlag[appLanguage]}`} />}
                                    >
                                        {languageLabel(appLanguage)}
                                    </Button>
                                </DropdownTrigger>
                                <DropdownMenu
                                    aria-label='app language'
                                    className='max-h-[40vh] overflow-y-auto'
                                    onAction={(key) => {
                                        setAppLanguage(key);
                                        i18n.changeLanguage(key);
                                        invoke('update_tray', { language: key, copyMode: '' });
                                    }}
                                >
                                    <DropdownItem
                                        key='zh_cn'
                                        startContent={<span className={`fi fi-${LanguageFlag.zh_cn}`} />}
                                    >
                                        {languageLabel('zh_cn')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='zh_tw'
                                        startContent={<span className={`fi fi-${LanguageFlag.zh_cn}`} />}
                                    >
                                        {languageLabel('zh_tw')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='en'
                                        startContent={<span className={`fi fi-${LanguageFlag.en}`} />}
                                    >
                                        {languageLabel('en')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='ja'
                                        startContent={<span className={`fi fi-${LanguageFlag.ja}`} />}
                                    >
                                        {languageLabel('ja')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='ko'
                                        startContent={<span className={`fi fi-${LanguageFlag.ko}`} />}
                                    >
                                        {languageLabel('ko')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='fr'
                                        startContent={<span className={`fi fi-${LanguageFlag.fr}`} />}
                                    >
                                        {languageLabel('fr')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='de'
                                        startContent={<span className={`fi fi-${LanguageFlag.de}`} />}
                                    >
                                        {languageLabel('de')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='es'
                                        startContent={<span className={`fi fi-${LanguageFlag.es}`} />}
                                    >
                                        {languageLabel('es')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='ru'
                                        startContent={<span className={`fi fi-${LanguageFlag.ru}`} />}
                                    >
                                        {languageLabel('ru')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='it'
                                        startContent={<span className={`fi fi-${LanguageFlag.it}`} />}
                                    >
                                        {languageLabel('it')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='tr'
                                        startContent={<span className={`fi fi-${LanguageFlag.tr}`} />}
                                    >
                                        {languageLabel('tr')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='pt_pt'
                                        startContent={<span className={`fi fi-${LanguageFlag.pt_pt}`} />}
                                    >
                                        {languageLabel('pt_pt')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='pt_br'
                                        startContent={<span className={`fi fi-${LanguageFlag.pt_br}`} />}
                                    >
                                        {languageLabel('pt_br')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='nb_no'
                                        startContent={<span className={`fi fi-${LanguageFlag.nb_no}`} />}
                                    >
                                        {languageLabel('nb_no')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='nn_no'
                                        startContent={<span className={`fi fi-${LanguageFlag.nn_no}`} />}
                                    >
                                        {languageLabel('nn_no')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='fa'
                                        startContent={<span className={`fi fi-${LanguageFlag.fa}`} />}
                                    >
                                        {languageLabel('fa')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='uk'
                                        startContent={<span className={`fi fi-${LanguageFlag.uk}`} />}
                                    >
                                        {languageLabel('uk')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='ar'
                                        startContent={<span className={`fi fi-${LanguageFlag.ar}`} />}
                                    >
                                        {languageLabel('ar')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='he'
                                        startContent={<span className={`fi fi-${LanguageFlag.he}`} />}
                                    >
                                        {languageLabel('he')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='ta'
                                        startContent={<span className={`fi fi-${LanguageFlag.ta}`} />}
                                    >
                                        {languageLabel('ta')}
                                    </DropdownItem>
                                    <DropdownItem
                                        key='tk'
                                        startContent={<span className={`fi fi-${LanguageFlag.tk}`} />}
                                    >
                                        {languageLabel('tk')}
                                    </DropdownItem>
                                </DropdownMenu>
                            </Dropdown>
                        )}
                        {/* 带 * 的语言翻译尚未完成，选中后部分界面会显示英文。
                            这是如实提示，不是错误——详见 languageLabel 的说明。 */}
                        {incompleteLanguages.includes(appLanguage) && (
                            <p className='text-tiny text-default-400 mt-1'>
                                * {t('config.general.incomplete_translation')}
                            </p>
                        )}
                    </div>
                    <div className='config-item'>
                        <h3 className='my-auto'>{t('config.general.app_theme')}</h3>
                        {appTheme !== null && (
                            <Dropdown>
                                <DropdownTrigger>
                                    <Button variant='bordered'>{t(`config.general.theme.${appTheme}`)}</Button>
                                </DropdownTrigger>
                                <DropdownMenu
                                    aria-label='app theme'
                                    onAction={(key) => setAppTheme(key)}
                                >
                                    <DropdownItem key='system'>{t('config.general.theme.system')}</DropdownItem>
                                    <DropdownItem key='light'>{t('config.general.theme.light')}</DropdownItem>
                                    <DropdownItem key='dark'>{t('config.general.theme.dark')}</DropdownItem>
                                </DropdownMenu>
                            </Dropdown>
                        )}
                    </div>
                    <div className='config-item'>
                        <h3 className='my-auto'>{t('config.general.app_font')}</h3>
                        {appFont !== null && fontList !== null && (
                            <Dropdown>
                                <DropdownTrigger>
                                    <Button
                                        variant='bordered'
                                        style={{
                                            fontFamily: appFont === 'default' ? 'sans-serif' : appFont,
                                        }}
                                    >
                                        {appFont === 'default' ? t('config.general.default_font') : appFont}
                                    </Button>
                                </DropdownTrigger>
                                <DropdownMenu
                                    aria-label='app font'
                                    className='max-h-[50vh] overflow-y-auto'
                                    onAction={(key) => {
                                        document.documentElement.style.fontFamily = `"${
                                            key === 'default' ? 'sans-serif' : key
                                        }","${appFallbackFont === 'default' ? 'sans-serif' : appFallbackFont}"`;
                                        setAppFont(key);
                                    }}
                                >
                                    <DropdownItem
                                        style={{ fontFamily: 'sans-serif' }}
                                        key='default'
                                    >
                                        {t('config.general.default_font')}
                                    </DropdownItem>
                                    {fontList.map((x) => {
                                        return (
                                            <DropdownItem
                                                style={{ fontFamily: x }}
                                                key={x}
                                            >
                                                {x}
                                            </DropdownItem>
                                        );
                                    })}
                                </DropdownMenu>
                            </Dropdown>
                        )}
                    </div>
                    <div className='config-item'>
                        <h3 className='my-auto'>{t('config.general.app_fallback_font')}</h3>
                        {appFallbackFont !== null && fontList !== null && (
                            <Dropdown>
                                <DropdownTrigger>
                                    <Button
                                        variant='bordered'
                                        style={{
                                            fontFamily: appFallbackFont === 'default' ? 'sans-serif' : appFallbackFont,
                                        }}
                                    >
                                        {appFallbackFont === 'default'
                                            ? t('config.general.default_font')
                                            : appFallbackFont}
                                    </Button>
                                </DropdownTrigger>
                                <DropdownMenu
                                    aria-label='app font'
                                    className='max-h-[50vh] overflow-y-auto'
                                    onAction={(key) => {
                                        document.documentElement.style.fontFamily = `"${
                                            appFont === 'default' ? 'sans-serif' : appFont
                                        }","${key === 'default' ? 'sans-serif' : key}"`;
                                        setAppFallbackFont(key);
                                    }}
                                >
                                    <DropdownItem
                                        style={{ fontFamily: 'sans-serif' }}
                                        key='default'
                                    >
                                        {t('config.general.default_font')}
                                    </DropdownItem>
                                    {fontList.map((x) => {
                                        return (
                                            <DropdownItem
                                                style={{ fontFamily: x }}
                                                key={x}
                                            >
                                                {x}
                                            </DropdownItem>
                                        );
                                    })}
                                </DropdownMenu>
                            </Dropdown>
                        )}
                    </div>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.general.font_size.title')}</h3>
                        {appFontSize !== null && (
                            <Dropdown>
                                <DropdownTrigger>
                                    <Button variant='bordered'>{t(`config.general.font_size.${appFontSize}`)}</Button>
                                </DropdownTrigger>
                                <DropdownMenu
                                    aria-label='window position'
                                    className='max-h-[50vh] overflow-y-auto'
                                    onAction={(key) => {
                                        document.documentElement.style.fontSize = `${key}px`;
                                        setAppFontSize(key);
                                    }}
                                >
                                    <DropdownItem key={10}>{t(`config.general.font_size.10`)}</DropdownItem>
                                    <DropdownItem key={12}>{t(`config.general.font_size.12`)}</DropdownItem>
                                    <DropdownItem key={14}>{t(`config.general.font_size.14`)}</DropdownItem>
                                    <DropdownItem key={16}>{t(`config.general.font_size.16`)}</DropdownItem>
                                    <DropdownItem key={18}>{t(`config.general.font_size.18`)}</DropdownItem>
                                    <DropdownItem key={20}>{t(`config.general.font_size.20`)}</DropdownItem>
                                    <DropdownItem key={24}>{t(`config.general.font_size.24`)}</DropdownItem>
                                </DropdownMenu>
                            </Dropdown>
                        )}
                    </div>
                    <div className={`config-item ${osType !== 'Windows_NT' && 'hidden'}`}>
                        <h3 className='my-auto'>{t('config.general.tray_click_event')}</h3>
                        {trayClickEvent !== null && (
                            <Dropdown>
                                <DropdownTrigger>
                                    <Button variant='bordered'>{t(`config.general.event.${trayClickEvent}`)}</Button>
                                </DropdownTrigger>
                                <DropdownMenu
                                    aria-label='tray click event'
                                    onAction={(key) => {
                                        setTrayClickEvent(key);
                                    }}
                                >
                                    <DropdownItem key='config'>{t('config.general.event.config')}</DropdownItem>
                                    <DropdownItem key='translate'>{t('config.general.event.translate')}</DropdownItem>
                                    <DropdownItem key='ocr_recognize'>
                                        {t('config.general.event.ocr_recognize')}
                                    </DropdownItem>
                                    <DropdownItem key='ocr_translate'>
                                        {t('config.general.event.ocr_translate')}
                                    </DropdownItem>
                                    <DropdownItem key='disable'>{t('config.general.event.disable')}</DropdownItem>
                                </DropdownMenu>
                            </Dropdown>
                        )}
                    </div>
                    <div className={`config-item ${osType === 'Darwin' && 'hidden'}`}>
                        <h3>{t('config.general.transparent')}</h3>
                        {transparent !== null && (
                            <Switch
                                isSelected={transparent}
                                onValueChange={(v) => {
                                    setTransparent(v);
                                }}
                            />
                        )}
                    </div>
                    <div className='config-item'>
                        <h3>{t('config.general.dev_mode')}</h3>
                        {devMode !== null && (
                            <Switch
                                isSelected={devMode}
                                onValueChange={(v) => {
                                    setDevMode(v);
                                }}
                            />
                        )}
                    </div>
                </CardBody>
            </Card>
            <Card data-cup-card>
                <CardBody data-cup-body>
                    <div className='config-item'>
                        <h3>{t('config.general.proxy.title')}</h3>
                        {proxyEnable !== null && (
                            <Switch
                                isSelected={proxyEnable}
                                onValueChange={async (v) => {
                                    if (v) {
                                        // 用 isFilledString / isFilledPort 而不是 === ''：
                                        // 纯空白 host（'   '）会穿过 `=== ''`，最终让 Rust 的
                                        // set_proxy 把 `http://   :7890` 写进 http_proxy 等环境变量
                                        // （实测确认：启动日志无任何告警，坏值被当成合法配置）。
                                        // 端口必须用 isFilledPort——它存的是 **number**，
                                        // 用 isFilledString 会把正常端口也判为未填。
                                        if (!isFilledString(proxyHost) || !isFilledPort(proxyPort)) {
                                            setProxyEnable(false);
                                            toast.error(t('config.general.proxy_error'), {
                                                duration: 3000,
                                                style: toastStyle,
                                            });
                                            return;
                                        } else {
                                            setProxyEnable(v);
                                        }
                                    } else {
                                        setProxyEnable(v);
                                    }
                                    toast.success(t('config.general.proxy_change'), {
                                        duration: 1000,
                                        style: toastStyle,
                                    });
                                }}
                            />
                        )}
                    </div>
                    <div className='config-item proxy-input-row'>
                        {proxyHost !== null && (
                            <Input
                                type='url'
                                variant='bordered'
                                isRequired
                                label={t('config.general.proxy.host')}
                                startContent={<span>http://</span>}
                                value={proxyHost}
                                onValueChange={(v) => {
                                    setProxyHost(v);
                                }}
                                className='mr-2'
                            />
                        )}
                        {proxyPort !== null && (
                            <Input
                                type='number'
                                variant='bordered'
                                isRequired
                                label={t('config.general.proxy.port')}
                                value={proxyPort}
                                onValueChange={(v) => {
                                    // 同 server_port：拒绝非数字输入，避免 NaN -> null
                                    const next = nextPortValue(v);
                                    if (next === null) {
                                        setProxyPort(v.trim() === '' ? '' : proxyPort);
                                    } else {
                                        setProxyPort(next);
                                    }
                                }}
                                className='ml-2'
                            />
                        )}
                    </div>
                    <div className='config-item proxy-input-row'>
                        {proxyUsername !== null && (
                            <Input
                                type='text'
                                variant='bordered'
                                isDisabled
                                label={t('config.general.proxy.username')}
                                value={proxyUsername}
                                onValueChange={(v) => {
                                    setProxyUsername(v);
                                }}
                                className='mr-2'
                            />
                        )}
                        {proxyPassword !== null && (
                            <Input
                                type='password'
                                variant='bordered'
                                isDisabled
                                label={t('config.general.proxy.password')}
                                value={proxyPassword}
                                onValueChange={(v) => {
                                    setProxyPassword(v);
                                }}
                                className='ml-2'
                            />
                        )}
                    </div>
                    <div className='config-item'>
                        {noProxy !== null && (
                            <Input
                                variant='bordered'
                                label={t('config.general.proxy.no_proxy')}
                                value={noProxy}
                                onValueChange={(v) => {
                                    setNoProxy(v);
                                }}
                            />
                        )}
                    </div>
                </CardBody>
            </Card>
            <ConfigTransfer />
        </>
    );
}
