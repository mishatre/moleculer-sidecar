import { describe, expect, it } from 'vite-plus/test';

import { buildUrl, parseRequestURL } from './utils.js';

describe('parseRequestURL', () => {
    it('returns the path and query parameters', () => {
        expect(parseRequestURL({ url: '/lab/api/projects?limit=10&tag=sidecar' })).toEqual({
            url: '/lab/api/projects',
            query: { limit: '10', tag: 'sidecar' },
        });
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
