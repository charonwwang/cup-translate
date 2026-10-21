export function connectionUrl(value, protocol) {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (url.username || url.password || url.search || url.hash)
        throw new Error('Connection URL must not contain credentials, query parameters or fragments');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
        throw new Error('HTTPS is required for non-loopback connections');
    if (protocol === 'openai' && !url.pathname.endsWith('/chat/completions')) {
        url.pathname = url.pathname.replace(/\/$/, '');
        url.pathname += url.pathname.endsWith('/v1') ? '/chat/completions' : '/v1/chat/completions';
    }
    if (protocol === 'ollama') url.pathname = url.pathname.replace(/\/(?:api\/(?:chat|tags))?\/?$/, '') + '/api/chat';
    return url.href;
}
