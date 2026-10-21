// Entries are installable, pinned native manifests, not prototype placeholders.
export const LOCAL_MODEL_CATALOG = [
    {
        id: 'hymt-q4',
        family: 'hymt',
        name: 'HY-MT1.5',
        tag: '1.8B · Q4_K_M',
        scope: 'hy_scope',
        scenario: 'hy_scenario',
        bytes: 1133096782,
        memory: 'hy_memory_q4',
        disk: 4500000000,
        license: 'Tencent Hunyuan Community License',
        author: 'Tencent Hunyuan',
        languages: 'hy_languages',
    },
    {
        id: 'hymt-q8',
        family: 'hymt',
        name: 'HY-MT1.5',
        tag: '1.8B · Q8_0',
        scope: 'hy_scope',
        scenario: 'hy_scenario',
        bytes: 1908544558,
        memory: 'hy_memory_q8',
        disk: 4500000000,
        license: 'Tencent Hunyuan Community License',
        author: 'Tencent Hunyuan',
        languages: 'hy_languages',
    },
    {
        id: 'm2m100',
        family: 'm2m100',
        name: 'M2M-100',
        tag: '418M · int8',
        scope: 'multi_scope_short',
        scenario: 'catalog_scenario_multi',
        bytes: 495887804,
        memory: 'catalog_memory_multi',
        disk: 1200000000,
        license: 'MIT',
        author: 'Meta / M2M-100',
        languages: 'multi_scope_hint',
    },
    {
        id: 'en-zh',
        family: 'opus',
        name: 'OPUS-MT',
        tag: 'en → zh · int8',
        scope: 'catalog_scope_en_zh',
        scenario: 'catalog_scenario_opus',
        bytes: 82482557,
        memory: 'catalog_memory_opus',
        disk: 400000000,
        license: 'Apache-2.0',
        author: 'Helsinki-NLP / OPUS-MT',
        languages: 'catalog_scope_en_zh',
    },
    {
        id: 'zh-en',
        family: 'opus',
        name: 'OPUS-MT',
        tag: 'zh → en · int8',
        scope: 'catalog_scope_zh_en',
        scenario: 'catalog_scenario_opus',
        bytes: 82482840,
        memory: 'catalog_memory_opus',
        disk: 400000000,
        license: 'CC-BY-4.0',
        author: 'Helsinki-NLP / OPUS-MT',
        languages: 'catalog_scope_zh_en',
    },
];
export const localTaskRunning = (item) => ['queued', 'downloading', 'verifying', 'warming'].includes(item?.task?.state);
export function filterLocalCatalog(catalog, status, installedOnly) {
    return installedOnly ? catalog.filter((item) => status[item.id]?.installed) : catalog;
}

// Resume the same custom directory, rather than silently restarting from another source.
export function resumableModelBase(item) {
    const task = item?.task;
    if (
        !task ||
        task.state === 'ready' ||
        !task.origin ||
        ['https://huggingface.co', 'https://hf-mirror.com'].includes(task.origin)
    )
        return '';
    return task.origin;
}
