import { pathToFileURL } from 'node:url';

/**
 * Loads a module file by absolute path. A literal `import()` is kept on purpose:
 * it resolves a TypeScript `--config` under tsx and a `.js`/`.mjs`/`.cjs` file in
 * a packaged binary, where a file URL is what the loader expects.
 */
export async function loadModuleFile(file: string): Promise<unknown> {
    return import(pathToFileURL(file).href);
}
