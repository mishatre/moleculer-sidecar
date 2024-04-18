import * as esbuild from 'esbuild';
import { emptyDir } from 'fs-extra';
import { stat } from 'fs/promises';

const outputDir = 'build';

async function printSize(fileName) {
    const stats = await stat(fileName);

    // print size in MB
    console.log(`Bundle size: ${Math.round(stats.size / 10000) / 100}MB\n\n`);
}

async function main() {
    // clean build folder
    await emptyDir(outputDir);

    build('./src/index.service.ts', { outfile: `${outputDir}/index.service.mjs` });
    build('./moleculer.config.ts', { outfile: `${outputDir}/moleculer.config.mjs` });
}

async function build(entrypoint, options) {
    const start = Date.now();

    /** @type { import('esbuild').BuildOptions } */
    const config = {
        entryPoints: [entrypoint],
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'esm',
        sourcemap: process.argv.includes('--sourcemap'),
        outExtension: {
            '.js': '.mjs',
        },
        packages: 'external',
        // suppress direct-eval warning
        logOverride: {
            'direct-eval': 'silent',
        },
        legalComments: 'none',
        ...options,
    };

    await esbuild.build(config);
    console.log(`Build took ${Date.now() - start}ms`);
    await printSize(options.outfile || options.outdir);

    if (process.argv.includes('--minify')) {
        // minify the file
        await esbuild.build({
            ...config,
            entryPoints: [outfile],
            minify: true,
            keepNames: true,
            allowOverwrite: true,
            outfile,
        });

        console.log(`Minify took ${Date.now() - start}ms`);
        await printSize(outfile);
    }
}

try {
    await main();
} catch (error) {
    console.error(error);
    process.exit(1);
}
