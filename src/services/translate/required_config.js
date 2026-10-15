// 翻译前的「已配置」检查（TargetArea 调用 isServiceConfigured：未配置的引擎直接跳过、不发请求）。
// 注意：不要把非服务导出放进 services/translate/index.jsx——设置页用 Object.keys 遍历它当服务列表。
//
// 免 key 引擎（yandex/google/transmart/bing_dict/cambridge_dict/local_mt 等）无需登记，默认视为可用；
// 需要密钥/地址的引擎登记必需配置项，任何一项为空或**纯空白**即视为「未配置」
// （判据见 isFilledString：'   ' 与 '' 同等对待，因为两者都没有引擎能用）。
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
    // apiKey 为 "id.secret" 两段式。
    //
    // ⚠️ 这里**必须**用 isFilledString 判两段，不能只写 `includes('.')`：
    // `'   .   '` / `'\n.\t'` 都含 `.`，会被判为「已配置」，然后
    // `chatglm/index.jsx` 的 `apiKey.split('.')` 切出全空白的 id/secret
    // 真的发出请求 —— 与 round 48 修掉的漏洞同形，只是走的是特殊表而不是登记表。
    chatglm: (config) => {
        const key = config['apiKey'];
        if (typeof key !== 'string') {
            return false;
        }
        const [id, secret] = key.split('.');
        return isFilledString(id) && isFilledString(secret);
    },
    // api 类型需要 authKey；deeplx 类型需要自定义地址；free 需显式选择类型
    // （空配置的 deepl 不再默认走免 key 端点——实测已 429 封禁，见 docs/research/）
    //
    // ⚠️ 两个字符串分支同样必须走 isFilledString：原先写的是 `!== ''`，
    // 于是 `'   '` 被判为「已配置」，而 `translate_by_deeplx` 会把该值直接
    // 当 url 传给 fetch，归一化成 `'https://   '` 后 `new URL()` 抛
    // `Invalid URL`，用户只看到「翻译失败」，不知道原因只是多了个空格。
    deepl: (config) => {
        const type = config['type'];
        if (type === 'api') {
            return isFilledString(config['authKey']);
        }
        if (type === 'deeplx') {
            return isFilledString(config['customUrl']);
        }
        return type === 'free';
    },
};

/**
 * 判断一个配置值是否「真的填了内容」。
 *
 * 除了非空字符串，还必须排除**纯空白**——round 48 实测：闸门原先用
 * `config[key] !== ''` 精确比较空串，于是 `'   '`（空格）会被判为「已配置」，
 * **全部 11 个登记引擎都会被骗过**，进而发出注定失败的请求。
 *
 * 具体后果（以 openai 为例，实测）：
 *   requestPath=''    -> configured=false -> 不发请求（正确）
 *   requestPath='   ' -> configured=true  -> 归一化成 'https://   '
 *                        -> `new URL()` 抛 `Invalid URL`
 *   用户只看到「翻译失败」，完全不知道原因只是输入框里多了个空格。
 *
 * 为什么用 trim() 而不是只查 `!== ''`：从网页/文档里复制密钥时，
 * 尾部常常带上空格或换行，那是**用户的真实操作**，不该被当成有效配置。
 * 反过来，trim 后为空的字符串没有任何引擎能用，判为未配置不会误伤。
 *
 * 刻意**不**对值本身做 trim 后存回配置：闸门只读不写，
 * 保留用户原始输入，避免「我明明填了」的困惑。
 * 这里在**结构上**就做不到——本函数只收到字符串（按值传递），
 * 拿不到 config 对象，所以「trim 后写回」不可能发生
 * （变异测试确认：把本函数内部改成 `value = value.trim()` 属**等价变异**，
 *   行为完全不变；真正的风险是将来有人把判定内联进 isServiceConfigured
 *   并直接写 `config[key] = config[key].trim()`——测试里专门有一条拦它）。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isFilledString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

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
    return requiredKeys.every((key) => isFilledString(config[key]));
}
