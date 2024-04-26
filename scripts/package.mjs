#!/usr/bin/env node
import { exec as execCallback } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

const outfile = 'moleculer-sidecar';

const exec = promisify(execCallback);

rmSync('./out', { recursive: true });
mkdirSync('./out');
await exec('node ./scripts/build-cjs.mjs', { cwd: '.' });
await exec(`cp $(command -v node) ./out/${outfile}`, { cwd: '.' });

const config = {
    main: '../build/index.cjs',
    output: 'sea-prep.blob',
    disableExperimentalSEAWarning: true,
    useCodeCache: true,
};
writeFileSync('./out/sea-config.json', JSON.stringify(config, null, 2));

await exec(`node --experimental-sea-config sea-config.json`, { cwd: './out' });
await exec(`codesign --remove-signature ${outfile}`, { cwd: './out' });
await exec(
    `pnpx postject ${outfile} NODE_SEA_BLOB sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
    --macho-segment-name NODE_SEA`,
    { cwd: './out' },
);
await exec(`codesign --sign - ${outfile}`, { cwd: './out' });

rmSync('./out/sea-config.json');
rmSync('./out/sea-prep.blob', { recursive: true });
