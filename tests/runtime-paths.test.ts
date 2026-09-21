import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vite-plus/test';

import {
    defaultDataDir,
    ensureDataDir,
    findAppRoot,
    isMainModule,
    isPackaged,
    resolveDataDir,
} from '../src/runtime/paths.js';

const tempDir = mkdtempSync(path.join(tmpdir(), 'sidecar-paths-'));

afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

describe('isPackaged', () => {
    it('only trusts a real pkg marker', () => {
        expect(isPackaged({} as NodeJS.Process)).toBe(false);
        expect(isPackaged({ pkg: undefined } as unknown as NodeJS.Process)).toBe(false);
        expect(isPackaged({ pkg: null } as unknown as NodeJS.Process)).toBe(false);
        expect(
            isPackaged({ pkg: { entrypoint: '/snapshot/app.js' } } as unknown as NodeJS.Process),
        ).toBe(true);
    });
});

describe('defaultDataDir', () => {
    it('uses ProgramData on Windows, then LOCALAPPDATA, then the built-in default', () => {
        expect(defaultDataDir({ platform: 'win32', env: { ProgramData: 'C:\\ProgramData' } })).toBe(
            path.join('C:\\ProgramData', 'moleculer-sidecar'),
        );
        expect(
            defaultDataDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData' } }),
        ).toBe(path.join('C:\\Users\\me\\AppData', 'moleculer-sidecar'));
        expect(defaultDataDir({ platform: 'win32', env: {} })).toBe(
            path.join('C:\\ProgramData', 'moleculer-sidecar'),
        );
    });

    it('uses Application Support on macOS', () => {
        expect(defaultDataDir({ platform: 'darwin', home: '/Users/me', env: {} })).toBe(
            path.join('/Users/me', 'Library', 'Application Support', 'moleculer-sidecar'),
        );
    });

    it('uses XDG_DATA_HOME on Linux when set', () => {
        expect(defaultDataDir({ platform: 'linux', home: '/home/me', env: {} })).toBe(
            path.join('/home/me', '.local', 'share', 'moleculer-sidecar'),
        );
        expect(
            defaultDataDir({
                platform: 'linux',
                home: '/home/me',
                env: { XDG_DATA_HOME: '/data' },
            }),
        ).toBe(path.join('/data', 'moleculer-sidecar'));
    });
});

describe('resolveDataDir', () => {
    it('lets DATA_DIR win over everything', () => {
        expect(
            resolveDataDir({
                env: { DATA_DIR: path.join(tempDir, 'explicit') },
                packaged: true,
                cwd: tempDir,
            }),
        ).toBe(path.join(tempDir, 'explicit'));
    });

    it('uses the OS location when packaged and ./.data in a checkout', () => {
        expect(
            resolveDataDir({ env: {}, packaged: true, platform: 'linux', home: '/home/me' }),
        ).toBe(path.join('/home/me', '.local', 'share', 'moleculer-sidecar'));
        expect(resolveDataDir({ env: {}, packaged: false, cwd: tempDir })).toBe(
            path.join(tempDir, '.data'),
        );
    });
});

describe('ensureDataDir', () => {
    it('creates the resolved directory', () => {
        const target = path.join(tempDir, 'created', 'data');
        expect(ensureDataDir({ env: { DATA_DIR: target } })).toBe(target);
        expect(existsSync(target)).toBe(true);
    });
});

describe('isMainModule', () => {
    it('matches the same file and nothing else', () => {
        const file = path.join(tempDir, 'entry.ts');
        expect(isMainModule(file, file)).toBe(true);
        expect(isMainModule(file, './entry.ts')).toBe(false);
        expect(isMainModule(file, undefined)).toBe(false);
    });

    it('sees through symlinks, which is how tsx reports the entry file', () => {
        const real = path.join(tempDir, 'real');
        const link = path.join(tempDir, 'link');
        mkdirSync(real, { recursive: true });
        writeFileSync(path.join(real, 'entry.ts'), '');
        symlinkSync(real, link, 'dir');

        expect(isMainModule(path.join(real, 'entry.ts'), path.join(link, 'entry.ts'))).toBe(true);
    });
});

describe('findAppRoot', () => {
    it('walks up to the directory holding package.json', () => {
        const root = path.join(tempDir, 'app');
        const moduleDir = path.join(root, 'dist', 'src');
        mkdirSync(moduleDir, { recursive: true });
        writeFileSync(path.join(root, 'package.json'), '{}\n');
        expect(findAppRoot(moduleDir)).toBe(root);
    });

    it('finds the project root from a packaged bundle at dist/cli.cjs', () => {
        // Layout inside a packaged binary: <project>/dist/cli.cjs with the assets
        // (ui/dist, dist/moleculer.config.cjs) staged next to it.
        const project = path.join(tempDir, 'staged');
        mkdirSync(path.join(project, 'dist'), { recursive: true });
        writeFileSync(path.join(project, 'package.json'), '{}\n');
        writeFileSync(path.join(project, 'dist', 'cli.cjs'), '');
        expect(findAppRoot(path.join(project, 'dist'))).toBe(project);
    });

    it('prefers the closest manifest and does not walk forever', () => {
        const root = path.join(tempDir, 'nested');
        const nested = path.join(root, 'dist', 'src');
        mkdirSync(nested, { recursive: true });
        writeFileSync(path.join(root, 'package.json'), '{}\n');
        writeFileSync(path.join(root, 'dist', 'package.json'), '{}\n');
        expect(findAppRoot(nested)).toBe(path.join(root, 'dist'));

        const orphan = path.join(tempDir, 'orphan', 'deep');
        mkdirSync(orphan, { recursive: true });
        expect(findAppRoot(orphan, 0)).toBe(orphan);
    });
});
