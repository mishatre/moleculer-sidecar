import { join } from 'node:path/posix';
import { ConnectionInfo } from '../types.js';

export function parseRequestURL(req: { url?: string }) {
    const url = new URL(req.url!, 'https://example.com');
    return {
        url: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
    };
}

export function buildUrl(connection: ConnectionInfo) {
    const url = new URL('https://example.org');
    url.protocol = connection.useSSL ? 'https' : 'http';
    url.port = connection.port;
    url.hostname = connection.endpoint;
    url.pathname = join(connection.path ?? '', 'hs/moleculer/sidecar');

    return url;
}
