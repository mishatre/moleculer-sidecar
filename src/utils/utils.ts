import { randomBytes } from 'node:crypto';
import { join } from 'node:path/posix';
import type { ConnectionInfo } from '../types.js';

export function parseRequestURL(req: { url?: string }) {
    const url = new URL(req.url!, 'https://example.com');
    return {
        url: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
    };
}

export function isLoopback(address?: string): boolean {
    if (!address) return false;
    if (address === '::1') return true;

    const ipv4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
    return ipv4.startsWith('127.');
}

export function buildUrl(connection: ConnectionInfo) {
    const url = new URL('https://example.org');
    url.protocol = connection.useSSL ? 'https' : 'http';
    url.port = connection.port;
    url.hostname = connection.endpoint;
    url.pathname = join(connection.path ?? '', 'hs/moleculer/sidecar');

    return url;
}

export function randomString(length: number, charset: string): string {
    const charsetLength = charset.length;
    const bytes = randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) {
        // Use modulo to pick a character index from the charset
        result += charset[bytes[i] % charsetLength];
    }
    return result;
}
