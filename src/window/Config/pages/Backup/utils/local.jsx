import { save, open } from '@tauri-apps/api/dialog';
import { invoke } from '@tauri-apps/api';
import { finishRestore } from './restore';

export async function backup() {
    const selected = await save({
        filters: [
            {
                name: 'Backup',
                extensions: ['zip'],
            },
        ],
    });
    if (selected !== null) {
        return await invoke('local', {
            operate: 'put',
            path: selected,
        });
    } else {
        throw 'Invalid File';
    }
}

export async function get() {
    const selected = await open({
        multiple: false,
        directory: false,
        filters: [
            {
                name: '*.zip',
                extensions: ['zip'],
            },
        ],
    });

    if (selected !== null && selected.endsWith('zip')) {
        await invoke('local', {
            operate: 'get',
            path: selected,
        });
        return finishRestore();
    } else {
        throw 'Invalid File';
    }
}
