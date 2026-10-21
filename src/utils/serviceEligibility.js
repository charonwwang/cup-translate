import { isDeviceAllowed } from './requestPolicy.js';
import { isServiceConfigured } from '../services/translate/required_config.js';
import { resolveLocalModel } from '../services/translate/local_mt/options.js';
export function serviceEligibility(key, config, from, to, mode, provider, modelStatus = {}) {
    const name = key.split('@')[0];
    if (config?.enable === false || config?.enable === 'false') return 'disabled';
    if (mode === 'device_only' && !isDeviceAllowed('translate', name)) return 'privacy';
    if (!provider) return 'missing_provider';
    if (!isServiceConfigured(name, config)) return 'unconfigured';
    if (!provider.Language?.[to] || !(provider.Language?.[from] || provider.Language?.auto)) return 'language';
    if (name === 'local_mt') {
        const pair = resolveLocalModel(config, from, to);
        if (!pair) return 'direction';
        if (!modelStatus[pair]?.installed) return 'not_ready';
    }
    return null;
}
