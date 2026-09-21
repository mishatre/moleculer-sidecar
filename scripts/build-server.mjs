/**
 * Builds the artifacts the packaged binary needs:
 *
 *   dist/cli.mjs                 the whole CLI as one ES module
 *   dist/moleculer.config.mjs    the broker config, also an ES module
 *
 * dist/cli.mjs is a bundle of src/index.ts and keeps its entry-point guard, so
 * the same file works when run directly (`node dist/cli.mjs --help`) and when it
 * is injected into the packaged executable.
 *
 * ES modules, matching the sources: our own modules are bundled into one file
 * while every dependency stays external (`--packages=external`) and is served by
 * the packaged filesystem at runtime. The one place that needs care is a *named*
 * import from a CommonJS dependency: the packaged CommonJS named-export
 * detection only reports the first key of `module.exports`, so those go through
 * `src/runtime/cjs-interop.ts`, which reaches them via the default export.
 *
 * Type checking stays where it was: `pnpm check` and `vp check`.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const shared = {
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // node_modules are served from the packaged filesystem instead of inlined.
    packages: 'external',
    sourcemap: false,
    logLevel: 'warning',
    banner: { js: '#!/usr/bin/env node' },
};

const targets = [
    { entry: 'src/index.ts', outfile: 'dist/cli.mjs' },
    { entry: 'moleculer.config.ts', outfile: 'dist/moleculer.config.mjs' },
];

await Promise.all(
    targets.map(({ entry, outfile }) => build({ ...shared, entryPoints: [entry], outfile })),
);

for (const { outfile } of targets) {
    const file = path.join(root, outfile);
    if (!existsSync(file)) {
        throw new Error(`build produced no output: ${outfile}`);
    }
    console.log(`build:server → ${outfile} (${(statSync(file).size / 1024).toFixed(0)} kB)`);
}
