// 默认引擎：Google 翻译（免费、无需 API key、开箱即用）。
// local_mt（本地离线翻译）为**可选**引擎，需用户主动在
// 设置 → 翻译服务 → 本地离线翻译 中下载模型后手动启用。
// local_mt 使用 OPUS-MT CT2 int8（82MB 磁盘 / 158MB 内存 / ~100ms），
// 经评估为 <200MB 资源占用下的最优解（见 docs/research/on-device-mt-models-2026.md）。
export const DEFAULT_TRANSLATE_SERVICE_INSTANCE_LIST = ['google'];
