// 服务实例键（serviceInstanceKey）的纯逻辑实现。
//
// 为什么单独放在 .js（而不是继续留在 service_instance.ts 里）：
// 这些函数是纯字符串解析，被约 50 处 UI 代码依赖，但 Node 无法 import 含
// `enum` 的 .ts（Node 24 只做 type-stripping，报
// `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript enum is not supported in
// strip-only mode`），于是它们此前**没有任何测试**。
// 项目的既有做法就是把可测的纯逻辑抽到 .js：见 src/utils/port.js、
// src/utils/configValue.js、src/services/collection/anki/port.js、
// src/services/tts/google_tts/chunkText.js。
// service_instance.ts 保留原有的 .ts 入口与枚举，转发到这里，导入路径不变。

import { validPluginName } from './plugin_validation.js';

export function getServiceSouceType(serviceInstanceKey) {
    // 判据与 invoke_plugin 加载插件时的 validPluginName **保持一致**。
    //
    // 修复前只判 `startsWith('plugin')`，比 validPluginName 宽松，于是
    // `plugin..` / `plugin$a` / `plugin ` 这类**永远加载不了**的名字会被判为
    // PLUGIN，随后各调用点无守卫地索引 `pluginList[name].icon` / `.language`，
    // 直接抛 TypeError 打挂窗口渲染（实测复现：
    // `Cannot read properties of undefined (reading 'language')`）。
    // 这类 key 可来自用户手改 config.json，或历史记录里残留的旧服务键。
    //
    // 现在「判为插件」等价于「名字能通过 validPluginName」，非法名落到 BUILDIN
    // 分支，由内置服务白名单兜底（不存在时返回 undefined，
    // 与 whetherAvailableService 的语义一致）。
    return validPluginName(serviceInstanceKey.split('@')[0]) ? 'plugin' : 'buildin';
}

export function whetherPluginService(serviceInstanceKey) {
    return getServiceSouceType(serviceInstanceKey) === 'plugin';
}

// The serviceInstanceKey consists of the service name and it's id, separated by @
// In earlier versions, the @ separator and id were optional, so they all have only one instance.
export function createServiceInstanceKey(serviceName) {
    const randomId = Math.random().toString(36).substring(2);
    return `${serviceName}@${randomId}`;
}

// if the serviceInstanceKey is from a plugin, serviceName is it's pluginId
export function getServiceName(serviceInstanceKey) {
    return serviceInstanceKey.split('@')[0];
}

export function getDisplayInstanceName(instanceName, serviceNameSupplier) {
    return instanceName || serviceNameSupplier();
}

export const INSTANCE_NAME_CONFIG_KEY = 'instanceName';

export function whetherAvailableService(serviceInstanceKey, availableServices) {
    const serviceSourceType = getServiceSouceType(serviceInstanceKey);
    const serviceName = getServiceName(serviceInstanceKey);
    return availableServices[serviceSourceType]?.[serviceName] !== undefined;
}
