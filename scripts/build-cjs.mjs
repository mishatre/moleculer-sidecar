import * as esbuild from 'esbuild';
import { emptyDir } from 'fs-extra';
import { stat } from 'fs/promises';

const outputDir = 'build';

async function printSize(fileName) {
    const stats = await stat(fileName);

    // print size in MB
    console.log(`Bundle size: ${Math.round(stats.size / 10000) / 100}MB\n\n`);
}

const nativeNodeModulesPlugin = {
    name: 'native-node-modules',
    setup(build) {
        // If a ".node" file is imported within a module in the "file" namespace, resolve
        // it to an absolute path and put it into the "node-file" virtual namespace.
        build.onResolve({ filter: /\.node$/, namespace: 'file' }, (args) => {
            console.log(args);
            return {
                path: require.resolve(args.path, { paths: [args.resolveDir] }),
                namespace: 'node-file',
            };
        });

        // Files in the "node-file" virtual namespace call "require()" on the
        // path from esbuild of the ".node" file in the output directory.
        build.onLoad({ filter: /.*/, namespace: 'node-file' }, (args) => ({
            contents: `
          import path from ${JSON.stringify(args.path)}
          try { module.exports = require(path) }
          catch {}
        `,
        }));

        // If a ".node" file is imported within a module in the "node-file" namespace, put
        // it in the "file" namespace where esbuild's default loading behavior will handle
        // it. It is already an absolute path since we resolved it to one above.
        build.onResolve({ filter: /\.node$/, namespace: 'node-file' }, (args) => {
            console.log(args);
            return {
                path: args.path,
                namespace: 'file',
            };
        });

        // Tell esbuild's default loading behavior to use the "file" loader for
        // these ".node" files.
        let opts = build.initialOptions;
        opts.loader = opts.loader || {};
        opts.loader['.node'] = 'file';
    },
};

async function main() {
    // clean build folder
    await emptyDir(outputDir);
    build('./src/index.ts', { outdir: outputDir });
}

async function build(entrypoint, options) {
    const start = Date.now();

    /** @type { import('esbuild').BuildOptions } */
    const config = {
        entryPoints: [entrypoint],
        plugins: [nativeNodeModulesPlugin],
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'cjs',
        sourcemap: process.argv.includes('--sourcemap'),
        outExtension: {
            '.js': '.cjs',
        },
        //packages: 'external',
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
