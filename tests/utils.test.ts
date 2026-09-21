import { describe, expect, it } from 'vite-plus/test';

import { buildUrl, isLoopback, parseRequestURL } from '../src/utils/utils.js';

describe('parseRequestURL', () => {
    it('returns the path and query parameters', () => {
        expect(parseRequestURL({ url: '/lab/api/projects?limit=10&tag=sidecar' })).toEqual({
            url: '/lab/api/projects',
            query: { limit: '10', tag: 'sidecar' },
        });
    });
});

describe('isLoopback', () => {
    it('accepts the loopback ranges', () => {
        expect(['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1'].map(isLoopback)).toEqual([
            true,
            true,
            true,
            true,
        ]);
    });

    it('rejects everything else', () => {
        const addresses = ['192.168.1.10', '::ffff:192.168.1.10', '10.0.0.1', '1270.1.2.3'];

        expect([...addresses.map(isLoopback), isLoopback(undefined), isLoopback()]).toEqual([
            false,
            false,
            false,
            false,
            false,
            false,
        ]);
    });
});

describe('buildUrl', () => {
    it('builds an https url including the sidecar path', () => {
        const url = buildUrl({
            id: 'conn-1',
            endpoint: 'sidecar.example.com',
            port: '8443',
            useSSL: true,
            path: '/lab',
        });

        expect(url.toString()).toBe('https://sidecar.example.com:8443/lab/hs/moleculer/sidecar');
    });

    it('defaults to http and the root path', () => {
        const url = buildUrl({
            id: 'conn-2',
            endpoint: 'sidecar.example.com',
            port: '8080',
            useSSL: false,
            path: '',
        });

        expect(url.toString()).toBe('http://sidecar.example.com:8080/hs/moleculer/sidecar');
    });
});
