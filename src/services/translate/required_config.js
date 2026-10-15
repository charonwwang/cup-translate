// 翻译前的「已配置」检查（TargetArea 调用 isServiceConfigured：未配置的引擎直接跳过、不发请求）。
// 注意：不要把非服务导出放进 services/translate/index.jsx——设置页用 Object.keys 遍历它当服务列表。
//
// 免 key 引擎（yandex/google/transmart/bing_dict/cambridge_dict/local_mt 等）无需登记，默认视为可用；
// 需要密钥/地址的引擎登记必需配置项，任何一项为空即视为「未配置」。
const REQUIRED_CONFIG_KEYS = {
    alibaba: ['accesskey_id', 'accesskey_secret'],
    baidu: ['appid', 'secret'],
    baidu_field: ['appid', 'secret'],
    caiyun: ['token'],
    geminipro: ['apiKey', 'requestPath'],
    niutrans: ['apikey'],
    // apiKey 是必需的：service 只有 openai / azure 两档，都是托管服务，没有「本地免 key」这一项。
    // 只要求 requestPath 时，默认新建实例（apiKey 为 ''）会被判为「已配置」并真的发请求，
    // 实测得到 HTTP 401——正是本闸门要拦下的「无效请求」。
    openai: ['requestPath', 'apiKey'],
    ollama: ['requestPath'],
    tencent: ['secret_id', 'secret_key'],
    volcengine: ['appid', 'secret'],
    youdao: ['appkey', 'key'],
};

// 配置语义特殊的引擎：返回 true 表示「配置齐全、可以调用」
const SPECIAL_CONFIG_CHECK = {
    // apiKey 为 "id.secret" 两段式
    chatglm: (config) => typeof config['apiKey'] === 'string' && config['apiKey'].includes('.'),
    // api 类型需要 authKey；deeplx 类型需要自定义地址；free 需显式选择类型
    // （空配置的 deepl 不再默认走免 key 端点——实测已 429 封禁，见 docs/research/）
    deepl: (config) => {
        const type = config['type'];
        if (type === 'api') {
            return typeof config['authKey'] === 'string' && config['authKey'] !== '';
        }
        if (type === 'deeplx') {
            return typeof config['customUrl'] === 'string' && config['customUrl'] !== '';
        }
        return type === 'free';
    },
};

export function isServiceConfigured(serviceName, instanceConfig) {
    const config = instanceConfig ?? {};
    const specialCheck = SPECIAL_CONFIG_CHECK[serviceName];
    if (specialCheck) {
        return specialCheck(config);
    }
    const requiredKeys = REQUIRED_CONFIG_KEYS[serviceName];
    if (!requiredKeys) {
        return true;
    }
    return requiredKeys.every((key) => typeof config[key] === 'string' && config[key] !== '');
}
