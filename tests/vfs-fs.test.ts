import { describe, expect, it } from 'vite-plus/test';

import {
    installUrlAwareFs,
    normalizePathArgument,
    urlAwareWrapper,
} from '../src/runtime/vfs-fs.js';

describe('normalizePathArgument', () => {
    it('turns file URLs into paths and leaves everything else alone', () => {
        expect(normalizePathArgument(new URL('file:///tmp/a.txt'))).toBe('/tmp/a.txt');
        expect(normalizePathArgument('/tmp/a.txt')).toBe('/tmp/a.txt');
        expect(normalizePathArgument(Buffer.from('x'))).toBeInstanceOf(Buffer);
    });

    it('decodes URL escaping that a path would have to carry verbatim', () => {
        expect(normalizePathArgument(new URL('file:///tmp/a%20b/c.txt'))).toBe('/tmp/a b/c.txt');
    });
});

describe('urlAwareWrapper', () => {
    it('passes the normalized first argument and keeps the rest', () => {
        const calls: unknown[][] = [];
        const original = (...args: unknown[]) => {
            calls.push(args);
            return 'called';
        };

        const wrapped = urlAwareWrapper(original) as (...args: unknown[]) => unknown;
        expect(wrapped(new URL('file:///tmp/a.txt'), 'utf8')).toBe('called');
        expect(calls).toEqual([['/tmp/a.txt', 'utf8']]);
    });

    it('is idempotent and ignores non-functions', () => {
        const original = () => 'x';
        const once = urlAwareWrapper(original);
        expect(urlAwareWrapper(once)).toBe(once);
        expect(urlAwareWrapper(undefined)).toBeUndefined();
    });
});

describe('installUrlAwareFs', () => {
    it('patches the listed entry points of every module, including fs.promises', () => {
        const promises: Record<string, unknown> = {};
        const module: Record<string, unknown> = {
            readFile: (file: unknown) => file,
            statSync: (file: unknown) => file,
            untouched: (file: unknown) => file,
            promises,
        };

        installUrlAwareFs([module]);

        expect((module.readFile as (f: unknown) => unknown)(new URL('file:///tmp/a.txt'))).toBe(
            '/tmp/a.txt',
        );
        expect((module.statSync as (f: unknown) => unknown)(new URL('file:///tmp/b.txt'))).toBe(
            '/tmp/b.txt',
        );
        // `untouched` is not in the list, so a URL must arrive unchanged.
        expect(
            (module.untouched as (f: unknown) => unknown)(new URL('file:///tmp/c.txt')),
        ).toHaveProperty('href', 'file:///tmp/c.txt');
    });

    it('survives a frozen module object', () => {
        const frozen = Object.freeze({ readFile: (file: unknown) => file });
        expect(() => installUrlAwareFs([frozen])).not.toThrow();
    });

    it('installs on the real fs modules and keeps them working', async () => {
        const { createRequire } = await import('node:module');
        const fsCjs = createRequire(import.meta.url)('node:fs') as Record<string, unknown>;
        const before = fsCjs.readFileSync;

        installUrlAwareFs();
        installUrlAwareFs(); // idempotent
        expect(fsCjs.readFileSync).not.toBe(before);

        const self = new URL(import.meta.url);
        expect((fsCjs.existsSync as (f: unknown) => boolean)(self)).toBe(true);
        expect((fsCjs.readFileSync as (f: unknown) => string)(self).length).toBeGreaterThan(0);
    });
});
