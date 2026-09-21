#!/usr/bin/env node
// Test double for the graft CLI, used by tests/orchestration-hooks.test.ts.
//
// It mirrors the real output contract: `check --json` prints { context, graph },
// and `graph.ok` is the wiring-graph verdict — the `context` block belongs to the
// optional --deep meaning layer and is ok:false even in a healthy repository.
//
// FAKE_GRAFT_MODE selects the behaviour:
//   current            check reports graph.ok (exit 0)
//   stale              check reports drift (exit 1); build fails
//   stale-then-current check reports drift until build has run, then reports ok
//   garbage            check exits 3 with unparseable output; build fails
//
// FAKE_GRAFT_STATE is the marker file the repaired modes write on build; a test
// can therefore assert whether a build ran at all.
import fs from 'node:fs';

const mode = process.env.FAKE_GRAFT_MODE ?? 'current';
const command = process.argv[2];
const stateFile = process.env.FAKE_GRAFT_STATE ?? '/tmp/fake-graft-state';

const context = {
    ok: false,
    missing: true,
    contentDrift: [],
    removed: [],
    coverage: [],
    indexDrift: [],
};
const healthy = JSON.stringify({
    context,
    graph: { ok: true, missing: false, added: [], removed: [], changed: [], stale: [] },
});
const drifted = JSON.stringify({
    context,
    graph: {
        ok: false,
        missing: false,
        added: ['src/probe.ts'],
        removed: [],
        changed: [],
        stale: [],
    },
});

if (command === 'check') {
    if (mode === 'current' || (mode === 'stale-then-current' && fs.existsSync(stateFile))) {
        process.stdout.write(`${healthy}\n`);
        process.exit(0);
    }
    if (mode === 'garbage') {
        process.stdout.write('graph check: no idea\n');
        process.exit(3);
    }
    process.stdout.write(`${drifted}\n`);
    process.exit(1);
}

if (command === 'build') {
    if (mode === 'stale' || mode === 'garbage') {
        process.stderr.write('fake build failure: graph is unwritable\n');
        process.exit(1);
    }
    fs.writeFileSync(stateFile, '1');
    process.exit(0);
}

process.exit(0);
