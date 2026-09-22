import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory name used under the OS data location (ProgramData, Application Support, XDG). */
const APP_DIR = 'moleculer-sidecar';

export interface PathOptions {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    home?: string;
    cwd?: string;
    packaged?: boolean;
}

/**
 * True when this process runs from a packaged binary. `pkg` sets `process.pkg`
 * for both its standard and SEA modes; the official Node SEA sets `sea.isSea()`.
 */
export function isPackaged(proc: unknown = process): boolean {
    const marker = (proc as { pkg?: unknown } | undefined)?.pkg;

    return typeof marker === 'object' && marker !== null;
}

/**
 * File of the module that executes this call. Callers that need their own path
 * must compute it themselves (`fileURLToPath(import.meta.url)`) — a helper
 * returns *its* file.
 */
export function currentModuleFile(): string {
    return fileURLToPath(import.meta.url);
}

/** Resolved path, following symlinks when the file exists (tsx reports realpaths). */
function canonical(file: string): string {
    const resolved = path.resolve(file);
    try {
        return realpathSync.native(resolved);
    } catch {
        return resolved;
    }
}

/** True when `argv1` is `file`, i.e. the process was started on that module directly. */
export function isMainModule(file: string, argv1: string | undefined = process.argv[1]): boolean {
    if (!argv1) {
        return false;
    }

    const entry = canonical(argv1);
    const current = canonical(file);

    return process.platform === 'win32'
        ? entry.toLowerCase() === current.toLowerCase()
        : entry === current;
}

/** Directory of the calling module. */
export function moduleDir(file: string = currentModuleFile()): string {
    return path.dirname(file);
}

/**
 * Project root holding `package.json`. Sources and compiled output sit at
 * different depths (`src/runtime` vs `dist`), so the manifest is searched for
 * instead of counted — which keeps the same code working in a checkout, under
 * `node dist/cli.mjs` and inside a packaged binary.
 */
export function findAppRoot(dir: string = moduleDir(), limit = 4): string {
    let current = path.resolve(dir);

    for (let depth = 0; depth <= limit; depth++) {
        if (existsSync(path.join(current, 'package.json'))) {
            return current;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }

    return path.resolve(dir);
}

/**
 * OS default location for writable state (PGlite data, logs). A service starts
 * with an arbitrary working directory, so paths must never be cwd-relative there.
 */
export function defaultDataDir(options: PathOptions = {}): string {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const home = options.home ?? os.homedir();

    if (platform === 'win32') {
        const base = env.ProgramData?.trim() || env.LOCALAPPDATA?.trim() || 'C:\\ProgramData';
        return path.join(base, APP_DIR);
    }

    if (platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', APP_DIR);
    }

    const base = env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share');
    return path.join(base, APP_DIR);
}

/**
 * Data directory in use: `DATA_DIR` wins, a packaged binary uses the OS location,
 * and a source checkout keeps its long-standing `./.data` (so dev state on disk
 * does not move out from under an existing install).
 */
export function resolveDataDir(options: PathOptions = {}): string {
    const env = options.env ?? process.env;
    const override = env.DATA_DIR?.trim();
    if (override) {
        return path.resolve(override);
    }

    const packaged = options.packaged ?? isPackaged();
    if (packaged) {
        return defaultDataDir(options);
    }

    return path.join(options.cwd ?? process.cwd(), '.data');
}

/** `resolveDataDir()` with the directory created, for callers that need it to exist. */
export function ensureDataDir(options: PathOptions = {}): string {
    const dir = resolveDataDir(options);
    mkdirSync(dir, { recursive: true });
    return dir;
}
