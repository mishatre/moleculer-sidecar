#!/usr/bin/env node
/**
 * Packages the standalone single-file binaries with `@yao-pkg/pkg --sea`
 * (enhanced SEA: stock Node, no patched base binaries).
 *
 * Why a staging tree instead of packaging the repository in place:
 *  - pkg's virtual filesystem cannot load modules through pnpm's *symlinked*
 *    `node_modules` (verified during the spike — see docs/packaging.md), while
 *    relative asset reads, `fs/promises`, streams and dynamic `import()` all
 *    work. The staging tree therefore gets a hoisted, symlink-free production
 *    install.
 *  - `cbor-extract` is left out on purpose: it is an optional accelerator that
 *    `cbor-x` loads inside a try/catch, and shipping it would drag a foreign
 *    native binary into every build.
 */
import { spawnSync } from 'node:child_process';
import {
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

/** Kept out of the staged install; see the header comment. */
const EXCLUDED_DEPENDENCIES = new Set(['moleculer-sidecar', 'cbor-extract']);

const TARGETS = {
    'linux-x64': {
        pkgTarget: (major) => `node${major}-linux-x64`,
        platform: 'linux',
        arch: 'x64',
        extension: '',
    },
    'win-x64': {
        pkgTarget: (major) => `node${major}-win-x64`,
        platform: 'win32',
        arch: 'x64',
        extension: '.exe',
    },
};

function parseArgs(argv) {
    const options = { targets: Object.keys(TARGETS), out: path.join(root, 'dist', 'bin') };

    for (let index = 0; index < argv.length; index++) {
        const flag = argv[index];
        if (flag === '--targets') {
            options.targets = (argv[++index] ?? '')
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean);
        } else if (flag === '--out') {
            options.out = path.resolve(argv[++index] ?? options.out);
        } else if (flag === '--node') {
            options.nodeMajor = String(argv[++index] ?? '');
        } else {
            throw new Error(`unknown argument: ${flag}`);
        }
    }

    for (const target of options.targets) {
        if (!TARGETS[target]) {
            throw new Error(
                `unknown target '${target}' — known: ${Object.keys(TARGETS).join(', ')}`,
            );
        }
    }

    return options;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        stdio: 'inherit',
        // pnpm is a .cmd shim on Windows; spawning it there needs a shell.
        shell: process.platform === 'win32',
        ...options,
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`command failed (${result.status}): ${command} ${args.join(' ')}`);
    }
    return result;
}

/** Everything pkg needs from the repository, in the layout the runtime expects. */
function stageSources(stage) {
    cpSync(path.join(root, 'dist', 'cli.mjs'), path.join(stage, 'dist', 'cli.mjs'));
    cpSync(
        path.join(root, 'dist', 'moleculer.config.mjs'),
        path.join(stage, 'dist', 'moleculer.config.mjs'),
    );
    cpSync(path.join(root, 'ui', 'dist'), path.join(stage, 'ui', 'dist'), { recursive: true });
    writeFileSync(
        path.join(stage, 'pnpm-lock.yaml'),
        readFileSync(path.join(root, 'pnpm-lock.yaml')),
    );
}

/**
 * Files inside the staged tree that are read at runtime but that pkg's walker
 * cannot see: our own compiled entry, the SPA, lab's dashboard, and the PGlite
 * wasm/data/extension files of every copy the install produced.
 */
function stagedAssetGlobs(stage) {
    const assets = ['dist/*.mjs', 'ui/dist/**/*'];

    if (existsSync(path.join(stage, 'node_modules', '@moleculer', 'lab', 'ui-dist'))) {
        assets.push('node_modules/@moleculer/lab/ui-dist/**/*');
    }

    // Lab 1.0 persists through embedded PostgreSQL (pglite), which reads its
    // wasm/data/extension files from disk at runtime.
    if (existsSync(path.join(stage, 'node_modules', '@electric-sql', 'pglite', 'dist'))) {
        assets.push('node_modules/@electric-sql/pglite/dist/**/*');
    }

    // Our own PGlite copy (0.5.x) hoists to the top level; lab 1.0 pins an
    // older 0.2.x line that pnpm nests under @moleculer/lab when both are
    // installed. Both read their wasm/data/extension files from disk at
    // runtime, so both dist trees must be staged.
    const labPgliteDist = path.join(
        stage,
        'node_modules',
        '@moleculer',
        'lab',
        'node_modules',
        '@electric-sql',
        'pglite',
        'dist',
    );
    if (existsSync(labPgliteDist)) {
        assets.push('node_modules/@moleculer/lab/node_modules/@electric-sql/pglite/dist/**/*');
    }

    return assets;
}

/**
 * Rewrites the asset globs once the tree is installed — before that the
 * `node_modules` checks above cannot succeed.
 */
function refreshStagedAssets(stage) {
    const file = path.join(stage, 'package.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.pkg.assets = stagedAssetGlobs(stage);
    writeFileSync(file, `${JSON.stringify(manifest, null, 4)}\n`);
    return manifest.pkg.assets;
}

function writeStagedManifest(stage, target, options) {
    const dependencies = Object.fromEntries(
        Object.entries(repoManifest.dependencies).filter(
            ([name]) => !EXCLUDED_DEPENDENCIES.has(name),
        ),
    );

    const staged = {
        name: repoManifest.name,
        version: repoManifest.version,
        private: true,
        // ES modules, like the sources — see scripts/build-server.mjs.
        type: 'module',
        bin: 'dist/cli.mjs',
        pkg: {
            targets: [TARGETS[target].pkgTarget(options.nodeMajor)],
            assets: stagedAssetGlobs(stage),
            ignore: ['**/*.md', '**/*.map', '**/*.d.ts'],
            compress: 'Brotli',
            nativeBuild: false,
            seaConfig: { disableExperimentalSEAWarning: true },
        },
        dependencies,
    };

    writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(staged, null, 4)}\n`);
}

/**
 * Makes the staged directory its own pnpm workspace. The one native build
 * script is denied on purpose: `cbor-extract` is unused.
 */
function writeStagedWorkspace(stage) {
    writeFileSync(
        path.join(stage, 'pnpm-workspace.yaml'),
        [
            'packages: []',
            'allowBuilds:',
            '    cbor-extract: false',
            'peerDependencyRules:',
            '    ignoreMissing:',
            '        - "@electric-sql/pglite-pgvector"',
            '        - "@electric-sql/pglite-age"',
            '        - "@electric-sql/pglite-pg_hashids"',
            '        - "@electric-sql/pglite-pg_ivm"',
            '        - "@electric-sql/pglite-pg_textsearch"',
            '        - "@electric-sql/pglite-pg_uuidv7"',
            '        - "@electric-sql/pglite-pgtap"',
            '',
        ].join('\n'),
    );
}

function installProductionDependencies(stage) {
    // --no-optional: cbor-x's optional `cbor-extract` pulls per-platform
    // prebuild packages, and the host's (darwin) binaries must never ship in a
    // linux/win build — cbor-x falls back to its JS codec.
    // --no-frozen-lockfile: the staged manifest drops the self-link and
    // cbor-extract, so the copied lockfile is updated rather than validated
    // (pnpm keeps the recorded resolutions for everything it still needs).
    run(
        'pnpm',
        ['install', '--node-linker=hoisted', '--prod', '--no-optional', '--no-frozen-lockfile'],
        { cwd: stage },
    );
}

/** No .node file is expected at all — any one is a foreign native binary. */
function assertNoForeignNatives(stage) {
    const natives = readdirSync(path.join(stage, 'node_modules'), {
        recursive: true,
        withFileTypes: true,
    })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.node'))
        .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));

    if (natives.length > 0) {
        throw new Error(
            `the staged tree contains native binaries for another platform:\n  ${natives.join('\n  ')}`,
        );
    }
}

function packageBinary(stage, target, options) {
    const definition = TARGETS[target];
    const output = path.join(options.out, `${repoManifest.name}-${target}${definition.extension}`);
    const pkgDir = path.dirname(require.resolve('@yao-pkg/pkg/package.json'));
    const pkgBin = path.join(pkgDir, require('@yao-pkg/pkg/package.json').bin.pkg);

    mkdirSync(options.out, { recursive: true });
    run(
        process.execPath,
        [
            pkgBin,
            '.',
            '--sea',
            '--targets',
            definition.pkgTarget(options.nodeMajor),
            '--output',
            output,
        ],
        { cwd: stage },
    );

    return output;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    options.nodeMajor = options.nodeMajor ?? process.versions.node.split('.')[0];

    const entry = path.join(root, 'dist', 'cli.mjs');
    if (!existsSync(entry)) {
        throw new Error('dist/cli.mjs is missing — run `pnpm build:server` first');
    }
    if (!existsSync(path.join(root, 'ui', 'dist', 'index.html'))) {
        throw new Error('ui/dist/index.html is missing — run `pnpm build:ui` first');
    }

    console.log(
        `packaging ${repoManifest.name}@${repoManifest.version} for node${options.nodeMajor}: ${options.targets.join(', ')}`,
    );

    const results = [];
    for (const target of options.targets) {
        const stage = path.join(root, 'build', 'pack', target);
        console.log(`\n=== ${target} ===`);
        rmSync(stage, { recursive: true, force: true });
        mkdirSync(stage, { recursive: true });

        stageSources(stage);
        writeStagedWorkspace(stage);
        writeStagedManifest(stage, target, options);
        installProductionDependencies(stage);
        // The asset globs depend on which packages the install produced.
        const assets = refreshStagedAssets(stage);
        console.log(`assets: ${assets.join(', ')}`);

        assertNoForeignNatives(stage);

        const output = packageBinary(stage, target, options);
        const size = statSync(output).size;

        // Keep the stage (it is gitignored) so a failing run can be inspected,
        // but report the size of everything the user has to ship: exactly one
        // file.
        results.push({ target, output, size });
    }

    console.log('\n=== artifacts ===');
    for (const { target, output, size } of results) {
        console.log(`${target.padEnd(10)} ${path.relative(root, output)} (${formatSize(size)})`);
    }
    console.log('\nShip the binary alone; it needs no Node, no node_modules and no sidecar files.');
}

function formatSize(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

main();
