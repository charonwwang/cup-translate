async function runProbe() {
    let result;
    try {
        const response = await window.__TAURI__.core.invoke('probe', { value: 'webview' });
        result = response === 'rust:webview' ? 'allowed' : 'unexpected';
    } catch (error) {
        result = String(error).includes('not allowed') ? 'denied' : 'unexpected';
    }
    document.getElementById('status').textContent = `Tauri 2 IPC: ${result}`;
    document.title = `Tauri 2 IPC: ${result}`;
}

void runProbe();
