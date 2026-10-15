// 服务实例键的工具函数。
//
// 实现已抽到 `service_instance_core.js`（纯 .js，可被 `node --test` 直接 import）——
// 本文件此前含 `enum`，而 Node 24 只做 type-stripping，无法加载它，导致这些
// 被约 50 处 UI 依赖的纯逻辑**没有任何测试**。抽出的做法与
// src/utils/{port,configValue}.js、src/services/collection/anki/port.js 一致。
//
// 这里保留 .ts 入口、枚举与全部导出名，**所有既有 import 路径不用改**。

import {
    INSTANCE_NAME_CONFIG_KEY,
    createServiceInstanceKey,
    getDisplayInstanceName,
    getServiceName,
    getServiceSouceType,
    whetherAvailableService,
    whetherPluginService,
} from './service_instance_core.js';

export enum ServiceType {
    TRANSLATE = 'translate',
    RECOGNIZE = 'recognize',
    TTS = 'tts',
    COLLECTION = 'collection',
}

export enum ServiceSourceType {
    BUILDIN = 'buildin',
    PLUGIN = 'plugin',
}

export {
    INSTANCE_NAME_CONFIG_KEY,
    createServiceInstanceKey,
    getDisplayInstanceName,
    getServiceName,
    getServiceSouceType,
    whetherAvailableService,
    whetherPluginService,
};