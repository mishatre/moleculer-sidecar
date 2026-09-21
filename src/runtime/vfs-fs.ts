import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const nodeRequire = createRequire(import.meta.url);

/** Marker so a second install (or a nested wrapper) cannot double-wrap. */
const URL_AWARE = Symbol.for('moleculer-sidecar.urlAware');

type FsLike = Record<string, unknown>;
type FsFunction = ((target: unknown, ...rest: unknown[]) => unknown) & {
    [URL_AWARE]?: true;
};

/** `file:` URLs become paths; everything else is passed through untouched. */
export function normalizePathArgument(target: unknown): unknown {
    return target instanceof URL ? fileURLToPath(target) : target;
}

/**
 * Wraps one function so it accepts a `URL` where it accepts a path.
 * Returns the original function when there is nothing to wrap.
 */
export function urlAwareWrapper(original: unknown): unknown {
    if (typeof original !== 'function') {
        return original;
    }
    const fn = original as FsFunction;
    if (fn[URL_AWARE]) {
        return fn;
    }

    const wrapper: FsFunction = function (this: unknown, target, ...rest) {
        return fn.call(this, normalizePathArgument(target), ...rest);
    };
    wrapper[URL_AWARE] = true;
    return wrapper;
}

/**
 * Entry points that take a path-or-URL argument.
 *
 * The packaged filesystem is built on path strings: a `file:` URL is not
 * recognised, so the call falls through to the real filesystem and fails with
 * ENOENT even though the very same file is readable by path. Dependencies do
 * pass URLs — pglite reads `postgres.wasm`/`postgres.data` with
 * `(await import('fs/promises')).readFile(new URL('./postgres.wasm', import.meta.url))`
 * — so the argument is normalised before the packaged implementation sees it.
 */
const URL_AWARE_FUNCTIONS = [
    'access',
    'accessSync',
    'existsSync',
    'lstat',
    'lstatSync',
    'open',
    'openSync',
    'readFile',
    'readFileSync',
    'readdir',
    'readdirSync',
    'realpath',
    'realpathSync',
    'stat',
    'statSync',
];

/**
 * Patches one module object in place. The *CommonJS* objects are patched on
 * purpose: an ES module namespace is immutable, while the packaged runtime
 * patches the same CommonJS objects, and `import()` of a builtin exposes them
 * (verified: `await import('fs/promises')` and `require('node:fs/promises')`
 * share `readFile`).
 */
export function installUrlAwareFs(
    modules: FsLike[] = [
        nodeRequire('node:fs') as FsLike,
        nodeRequire('node:fs/promises') as FsLike,
    ],
): void {
    for (const module of modules) {
        for (const name of URL_AWARE_FUNCTIONS) {
            const original = module[name];
            const wrapped = urlAwareWrapper(original);
            if (wrapped !== original) {
                try {
                    module[name] = wrapped;
                } catch {
                    // A frozen module object simply keeps the original
                    // function; there is nothing else to do.
                }
            }
        }

        // `fs.promises.*` is a separate object with its own copies.
        const promises = module.promises as FsLike | undefined;
        if (promises && promises !== module) {
            installUrlAwareFs([promises]);
        }
    }
}
