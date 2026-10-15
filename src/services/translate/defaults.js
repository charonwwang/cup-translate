// 翻译引擎优先级：本地小模型（离线、零延迟、隐私保护）+ Google（在线兜底）。
// local_mt 使用 OPUS-MT CT2 int8（79MB 磁盘 / 158MB 内存 / ~100ms），
// 经评估为 <200MB 资源占用下的最优解（见 docs/research/on-device-mt-models-2026.md）。
// Hy-MT2-1.8B 最小 462MB（1.25-bit GGUF）且需 llama.cpp，资源占用 5.8 倍，不采用。
// 注意：local_mt 需先在 设置 → 翻译服务 → 本地离线翻译 中下载模型后才能翻译。
export const DEFAULT_TRANSLATE_SERVICE_INSTANCE_LIST = ['google', 'local_mt'];
