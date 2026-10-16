import { emit, listen } from '@tauri-apps/api/event';

// Register both listeners before emitting; always release them, including on timeout.
export async function checkForUpdate({ listenEvent = listen, emitEvent = emit, timeout = 30000 } = {}) {
    const removers = [];
    let timer;
    let settled = false;
    return new Promise((resolve, reject) => {
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            removers.splice(0).forEach((remove) => remove());
            if (error) reject(error);
            else resolve(result);
        };
        timer = setTimeout(() => finish(new Error('Update check timed out')), timeout);
        const register = async (name, handler) => {
            const remove = await listenEvent(name, handler);
            if (settled) remove();
            else removers.push(remove);
        };
        Promise.all([
            register('tauri://update-available', ({ payload }) =>
                finish(null, { shouldUpdate: true, manifest: payload })
            ),
            register('tauri://update-status', ({ payload }) => {
                if (payload.error) finish(new Error(payload.error));
                else if (payload.status === 'UPTODATE') finish(null, { shouldUpdate: false });
            }),
        ])
            .then(() => {
                if (!settled) return emitEvent('tauri://update');
            })
            .catch((error) => finish(error));
    });
}
