import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrokerOptions } from 'moleculer';
import { afterAll, describe, expect, it } from 'vite-plus/test';

import {
    applyEnvOverrides,
    buildBrokerOptions,
    loadBrokerConfig,
    loadEnvFile,
    parseCliArgs,
    resolveConfigFile,
    resolveEnvFile,
    resolveOptionalServices,
} from '../src/index.js';

const tempDir = mkdtempSync(path.join(tmpdir(), 'sidecar-cli-'));

afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

const configFixture = (): BrokerOptions =>
    ({
        logLevel: { '**': 'info' },
        requestTimeout: 1000,
        retryPolicy: { retries: 5 },
    }) as unknown as BrokerOptions;

describe('parseCliArgs', () => {
    it('applies defaults', () => {
        expect(parseCliArgs([])).toMatchObject({
            config: undefined,
            envfile: undefined,
            lab: false,
            test: false,
            repl: false,
            help: false,
            version: false,
        });
    });

    it('parses flags, short aliases and tolerates a leading --', () => {
        const options = parseCliArgs([
            '--',
            '-c',
            'custom.config.ts',
            '-E',
            'custom.env',
            '--lab',
            '--node-id',
            'sidecar-1',
        ]);

        expect(options).toMatchObject({
            config: 'custom.config.ts',
            envfile: 'custom.env',
            lab: true,
            nodeId: 'sidecar-1',
        });
    });

    it('rejects unknown flags and positionals', () => {
        expect(() => parseCliArgs(['--nope'])).toThrow();
        expect(() => parseCliArgs(['auth'])).toThrow();
    });
});

describe('resolveEnvFile', () => {
    it('uses an explicit env file and rejects a missing one', () => {
        const file = path.join(tempDir, 'explicit.env');
        writeFileSync(file, 'FROM_EXPLICIT=1\n');

        expect(resolveEnvFile(parseCliArgs(['--envfile', file]), tempDir)).toBe(file);
        expect(() =>
            resolveEnvFile(parseCliArgs(['--envfile', path.join(tempDir, 'missing.env')]), tempDir),
        ).toThrow(/not found/);
    });

    it('falls back to .env only when it exists', () => {
        const cwd = mkdtempSync(path.join(tempDir, 'cwd-'));
        expect(resolveEnvFile(parseCliArgs([]), cwd)).toBeUndefined();

        const fallback = path.join(cwd, '.env');
        writeFileSync(fallback, 'FROM_FALLBACK=1\n');
        expect(resolveEnvFile(parseCliArgs([]), cwd)).toBe(fallback);
    });

    it('never overwrites variables already present in the environment', () => {
        const file = path.join(tempDir, 'preset.env');
        writeFileSync(file, 'PRESET=from-file\nADDED=1\n');

        const env: NodeJS.ProcessEnv = { PRESET: 'from-process' };
        loadEnvFile(file, env);

        expect(env.PRESET).toBe('from-process');
        expect(env.ADDED).toBe('1');
    });
});

describe('resolveOptionalServices', () => {
    it('defaults to none and is driven by flags or environment', () => {
        expect(resolveOptionalServices(parseCliArgs([]), {})).toEqual([]);
        expect(resolveOptionalServices(parseCliArgs(['--lab']), {})).toEqual(['lab']);
        expect(resolveOptionalServices(parseCliArgs([]), { LAB: 'true', TEST: '1' })).toEqual([
            'lab',
            'test',
        ]);
        expect(resolveOptionalServices(parseCliArgs([]), { LAB: 'false', TEST: '0' })).toEqual([]);
    });
});

describe('applyEnvOverrides', () => {
    it('overrides top-level options with coerced values', () => {
        const config = configFixture();
        applyEnvOverrides(config, { LOGLEVEL: 'debug', REQUESTTIMEOUT: '5000' });

        expect(config.logLevel).toBe('debug');
        expect(config.requestTimeout).toBe(5000);
    });

    it('leaves nested and MOL_ style variables alone', () => {
        const config = configFixture();
        applyEnvOverrides(config, {
            RETRYPOLICY_RETRIES: '9',
            MOL_RETRYPOLICY__RETRIES: '9',
        });

        expect(config.retryPolicy).toEqual({ retries: 5 });
    });
});

describe('buildBrokerOptions', () => {
    it('lets CLI flags win over environment and keeps config values', () => {
        const options = parseCliArgs(['--node-id', 'cli-node', '--log-level', 'warn']);
        const merged = buildBrokerOptions({ namespace: 'from-config' } as BrokerOptions, options, {
            NODEID: 'env-node',
            NAMESPACE: 'from-env',
        });

        expect(merged.nodeID).toBe('cli-node');
        expect(merged.logLevel).toBe('warn');
        expect(merged.namespace).toBe('from-env');
    });

    it('reaches broker defaults that the config file omits', () => {
        const merged = buildBrokerOptions(
            { requestTimeout: 1000 } as BrokerOptions,
            parseCliArgs([]),
            {
                REQUESTTIMEOUT: '250',
                TRANSPORTER: 'TCP',
            },
        );

        expect(merged.requestTimeout).toBe(250);
        expect(merged.transporter).toBe('TCP');
    });
});

describe('config file', () => {
    it('resolves the default, the flag and the environment variable', () => {
        const cwd = mkdtempSync(path.join(tempDir, 'config-'));
        const defaultFile = path.join(cwd, 'moleculer.config.ts');
        writeFileSync(defaultFile, '');

        expect(resolveConfigFile(parseCliArgs([]), {}, cwd)).toBe(defaultFile);
        expect(resolveConfigFile(parseCliArgs([]), { MOLECULER_CONFIG: defaultFile }, cwd)).toBe(
            defaultFile,
        );
        expect(resolveConfigFile(parseCliArgs(['--config', defaultFile]), {}, cwd)).toBe(
            defaultFile,
        );
        expect(() =>
            resolveConfigFile(parseCliArgs(['--config', path.join(cwd, 'nope.ts')]), {}, cwd),
        ).toThrow(/not found/);
    });

    it('imports object and factory exports and rejects modules without a default', async () => {
        const objectFile = path.join(tempDir, 'config-object.mjs');
        writeFileSync(objectFile, 'export default { namespace: "from-object" };\n');
        await expect(loadBrokerConfig(objectFile)).resolves.toMatchObject({
            namespace: 'from-object',
        });

        const factoryFile = path.join(tempDir, 'config-factory.mjs');
        writeFileSync(factoryFile, 'export default async () => ({ namespace: "from-factory" });\n');
        await expect(loadBrokerConfig(factoryFile)).resolves.toMatchObject({
            namespace: 'from-factory',
        });

        const invalidFile = path.join(tempDir, 'config-invalid.mjs');
        writeFileSync(invalidFile, 'export const config = {};\n');
        await expect(loadBrokerConfig(invalidFile)).rejects.toThrow(/no default export/);
    });
});
