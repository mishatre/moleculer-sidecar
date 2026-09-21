// Contract tests for the graft hooks: the scripts' real interface is
// stdin -> stdout/exit, so they are exercised as subprocesses against a fake
// graft binary. Nothing here touches the working repository's graph.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = path.join(repoRoot, '.github', 'hooks', 'scripts');
const fakeGraft = path.join(repoRoot, 'tests', 'fixtures', 'fake-graft.mjs');

type HookResult = { stdout: string; status: number };

function runHook(script: string, payload: unknown, env: Record<string, string> = {}): HookResult {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-hook-test-'));
    const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
    try {
        const stdout = execFileSync('node', [path.join(scriptsDir, script)], {
            input,
            encoding: 'utf8',
            env: {
                ...process.env,
                GRAFT_HOOK_STATE_DIR: stateDir,
                GRAFT_BIN: fakeGraft,
                FAKE_GRAFT_MODE: 'current',
                FAKE_GRAFT_STATE: path.join(stateDir, 'fake-state'),
                ...env,
            },
        });
        return { stdout: stdout.trim(), status: 0 };
    } catch (error) {
        const failure = error as { stdout?: string; status?: number };
        return { stdout: String(failure.stdout ?? '').trim(), status: failure.status ?? -1 };
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
}

function parse(result: HookResult): Record<string, unknown> {
    return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe('session-start', () => {
    it('injects graft-first guidance and the freshness state', () => {
        const result = runHook('session-start.mjs', {
            hook_event_name: 'SessionStart',
            source: 'new',
            session_id: 'test',
        });
        expect(result.status).toBe(0);
        const output = parse(result) as { hookSpecificOutput: { additionalContext: string } };
        expect(output.hookSpecificOutput.additionalContext).toContain('graft-first');
        expect(output.hookSpecificOutput.additionalContext).toContain('graph freshness: current');
    });

    it('never reports an unverified graph as current', () => {
        const result = runHook(
            'session-start.mjs',
            { hook_event_name: 'SessionStart', source: 'new' },
            { GRAFT_BIN: '/nonexistent/graft' },
        );
        const output = parse(result) as { hookSpecificOutput: { additionalContext: string } };
        expect(output.hookSpecificOutput.additionalContext).toContain(
            'graph freshness: unverified',
        );
    });

    it('always injects guidance, and never breaks the session on malformed input', () => {
        for (const payload of ['not json', '']) {
            const result = runHook('session-start.mjs', payload);
            expect(result.status).toBe(0);
            const output = parse(result) as { hookSpecificOutput: { additionalContext: string } };
            expect(output.hookSpecificOutput.additionalContext).toContain('graft-first');
        }
    });
});

describe('pre-tool-use', () => {
    it('asks before grepping source', () => {
        const result = runHook('pre-tool-use.mjs', {
            hook_event_name: 'PreToolUse',
            tool_name: 'grep_search',
            session_id: 'test',
            tool_input: { query: 'readFileSync', includePattern: 'src/**' },
        });
        const output = parse(result) as {
            hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
        };
        expect(output.hookSpecificOutput.permissionDecision).toBe('ask');
        expect(output.hookSpecificOutput.permissionDecisionReason).toContain('graft_find_code');
    });

    it('asks for an unscoped search, which in this repo means source', () => {
        const result = runHook('pre-tool-use.mjs', {
            hook_event_name: 'PreToolUse',
            tool_name: 'grep_search',
            session_id: 'test',
            tool_input: { query: 'listening on' },
        });
        expect(result.stdout).not.toBe('');
    });

    it('does not nag about a search scoped to docs, or about reads', () => {
        expect(
            runHook('pre-tool-use.mjs', {
                hook_event_name: 'PreToolUse',
                tool_name: 'grep_search',
                session_id: 'test',
                tool_input: { query: 'hooks', includePattern: 'docs/**' },
            }).stdout,
        ).toBe('');
        expect(
            runHook('pre-tool-use.mjs', {
                hook_event_name: 'PreToolUse',
                tool_name: 'read_file',
                session_id: 'test',
                tool_input: { filePath: 'src/index.ts', startLine: 1, endLine: 10 },
            }).stdout,
        ).toBe('');
    });

    it('is silent on malformed input', () => {
        expect(runHook('pre-tool-use.mjs', '{').stdout).toBe('');
        expect(runHook('pre-tool-use.mjs', '').stdout).toBe('');
    });
});

describe('post-tool-use', () => {
    it('is silent when the graph is already current', () => {
        expect(
            runHook('post-tool-use.mjs', {
                hook_event_name: 'PostToolUse',
                tool_name: 'create_file',
                tool_input: { filePath: 'src/tmp.ts' },
            }).stdout,
        ).toBe('');
    });

    it('reports a stale graph it could not repair', () => {
        const result = runHook(
            'post-tool-use.mjs',
            {
                hook_event_name: 'PostToolUse',
                tool_name: 'replace_string_in_file',
                tool_input: { filePath: 'src/tmp.ts' },
            },
            { FAKE_GRAFT_MODE: 'stale' },
        );
        const output = parse(result) as { hookSpecificOutput: { additionalContext: string } };
        expect(output.hookSpecificOutput.additionalContext).toContain('graft graph is stale');
    });

    it('reports an unverified graph rather than staying silent', () => {
        const result = runHook(
            'post-tool-use.mjs',
            {
                hook_event_name: 'PostToolUse',
                tool_name: 'mcp_serena_replace_symbol_body',
                tool_input: {},
            },
            { GRAFT_BIN: '/nonexistent/graft' },
        );
        const output = parse(result) as { hookSpecificOutput: { additionalContext: string } };
        expect(output.hookSpecificOutput.additionalContext).toContain('unverified');
    });

    it('ignores read-only tools, however they are spelled', () => {
        for (const tool of [
            'read_file',
            'grep_search',
            'list_dir',
            'get_errors',
            'mcp_serena_find_symbol',
            'mcp_graft_graft_check_freshness',
        ]) {
            const result = runHook(
                'post-tool-use.mjs',
                { hook_event_name: 'PostToolUse', tool_name: tool, tool_input: {} },
                { FAKE_GRAFT_MODE: 'stale' },
            );
            expect(result.stdout, `${tool} should not trigger maintenance`).toBe('');
        }
    });
});

describe('stop', () => {
    it('is silent when the wiring graph is current', () => {
        expect(
            runHook('stop.mjs', { hook_event_name: 'Stop', stop_hook_active: false }).stdout,
        ).toBe('');
    });

    it('repairs drift and then stays silent', () => {
        expect(
            runHook(
                'stop.mjs',
                { hook_event_name: 'Stop', stop_hook_active: false },
                { FAKE_GRAFT_MODE: 'stale-then-current' },
            ).stdout,
        ).toBe('');
    });

    it('blocks once when drift survives the repair', () => {
        const result = runHook(
            'stop.mjs',
            { hook_event_name: 'Stop', stop_hook_active: false },
            { FAKE_GRAFT_MODE: 'stale' },
        );
        const output = parse(result) as {
            hookSpecificOutput: { decision: string; reason: string };
        };
        expect(output.hookSpecificOutput.decision).toBe('block');
        expect(output.hookSpecificOutput.reason).toContain('stale');
    });

    it('reports instead of blocking when stop_hook_active is true, so it cannot loop', () => {
        const result = runHook(
            'stop.mjs',
            { hook_event_name: 'Stop', stop_hook_active: true },
            { FAKE_GRAFT_MODE: 'stale' },
        );
        const output = parse(result) as Record<string, unknown>;
        expect(output.systemMessage).toBeDefined();
        expect(output.hookSpecificOutput).toBeUndefined();
    });

    it('never blocks on an unverified graph', () => {
        const result = runHook(
            'stop.mjs',
            { hook_event_name: 'Stop', stop_hook_active: false },
            { GRAFT_BIN: '/nonexistent/graft' },
        );
        const output = parse(result) as Record<string, unknown>;
        expect(output.systemMessage).toBeDefined();
        expect(output.hookSpecificOutput).toBeUndefined();
    });

    it('treats malformed drift output as unverified, not as drift', () => {
        const result = runHook(
            'stop.mjs',
            { hook_event_name: 'Stop', stop_hook_active: false },
            { FAKE_GRAFT_MODE: 'garbage' },
        );
        const output = parse(result) as Record<string, unknown>;
        expect(output.systemMessage).toBeDefined();
        expect(output.hookSpecificOutput).toBeUndefined();
    });

    it('stays silent on malformed or empty input', () => {
        expect(runHook('stop.mjs', '{"hook_event_name":').stdout).toBe('');
        expect(runHook('stop.mjs', '').stdout).toBe('');
    });
});

describe('binary resolution', () => {
    // A GUI-launched VS Code does not necessarily see the shell's PATH order, so a
    // shim that exists but cannot load must not shadow a working binary.
    function makeShim(dir: string, body: string): string {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'graft');
        fs.writeFileSync(file, `#!${process.execPath}\n${body}`);
        fs.chmodSync(file, 0o755);
        return file;
    }

    const brokenBody =
        "process.stdout.write('node-gyp-build: native module missing\\n');\nprocess.exit(1);\n";

    it('falls through a candidate that cannot answer', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-shim-'));
        try {
            const brokenDir = path.join(root, 'broken');
            const goodDir = path.join(root, 'good');
            makeShim(brokenDir, brokenBody);
            const fixtureBody = fs.readFileSync(fakeGraft, 'utf8').replace(/^#!.*\n/, '');
            makeShim(goodDir, fixtureBody);

            const result = runHook(
                'stop.mjs',
                { hook_event_name: 'Stop', stop_hook_active: false },
                {
                    GRAFT_BIN: '',
                    PATH: `${brokenDir}${path.delimiter}${goodDir}`,
                    FAKE_GRAFT_MODE: 'current',
                },
            );
            // Reaching the working shim means current, which is silent.
            expect(result.stdout).toBe('');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('never blocks when no candidate can give a definitive answer', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-shim-'));
        try {
            const dir = path.join(root, 'broken');
            makeShim(dir, brokenBody);
            const result = runHook(
                'stop.mjs',
                { hook_event_name: 'Stop', stop_hook_active: false },
                { GRAFT_BIN: '', PATH: dir },
            );
            // Whether a working fallback exists is machine-specific; what must never
            // happen is a block on evidence that was never established.
            expect(result.stdout).not.toContain('"decision":"block"');
            if (result.stdout !== '') {
                const output = parse(result) as Record<string, unknown>;
                expect(output.systemMessage).toBeDefined();
            }
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('maintenance behaviour', () => {
    it('never rebuilds a graph that is already current, even for the Stop repair', () => {
        const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-marker-'));
        const marker = path.join(markerDir, 'built');
        try {
            const result = runHook(
                'stop.mjs',
                { hook_event_name: 'Stop', stop_hook_active: false },
                { FAKE_GRAFT_MODE: 'current', FAKE_GRAFT_STATE: marker },
            );
            expect(result.stdout).toBe('');
            // The fake writes this marker only when it is asked to build.
            expect(fs.existsSync(marker), 'a current graph must not be rebuilt').toBe(false);
        } finally {
            fs.rmSync(markerDir, { recursive: true, force: true });
        }
    });

    it('does not steal a lock held by a live owner', () => {
        const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-lock-'));
        const marker = path.join(lockDir, 'built');
        try {
            fs.writeFileSync(
                path.join(lockDir, 'maintenance.lock'),
                JSON.stringify({ pid: process.pid, at: Date.now() }),
            );
            const result = runHook(
                'stop.mjs',
                { hook_event_name: 'Stop', stop_hook_active: false },
                {
                    GRAFT_HOOK_STATE_DIR: lockDir,
                    FAKE_GRAFT_MODE: 'stale-then-current',
                    FAKE_GRAFT_STATE: marker,
                },
            );
            expect(fs.existsSync(marker), 'a live owner lock must not be stolen').toBe(false);
            // It falls back to a plain check, so the drift is still reported.
            expect(result.stdout).not.toBe('');
        } finally {
            fs.rmSync(lockDir, { recursive: true, force: true });
        }
    });

    it('recovers a lock whose owner is gone', () => {
        const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-lock-'));
        const marker = path.join(lockDir, 'built');
        try {
            // A pid that cannot be alive, with a fresh timestamp: dead owners are
            // recovered immediately, however young the lock is.
            fs.writeFileSync(
                path.join(lockDir, 'maintenance.lock'),
                JSON.stringify({ pid: 999_999, at: Date.now() }),
            );
            const result = runHook(
                'stop.mjs',
                { hook_event_name: 'Stop', stop_hook_active: false },
                {
                    GRAFT_HOOK_STATE_DIR: lockDir,
                    FAKE_GRAFT_MODE: 'stale-then-current',
                    FAKE_GRAFT_STATE: marker,
                },
            );
            expect(fs.existsSync(marker), 'the dead owner lock should be recovered').toBe(true);
            expect(result.stdout).toBe('');
        } finally {
            fs.rmSync(lockDir, { recursive: true, force: true });
        }
    });
});

describe('script hygiene', () => {
    it('never calls process.exit after writing stdout, and writes no stray output', () => {
        for (const file of fs.readdirSync(scriptsDir)) {
            if (!file.endsWith('.mjs')) continue;
            const source = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
            // Comments may discuss these calls; only real ones are a problem.
            const code = source
                .split('\n')
                .filter((line) => !line.trim().startsWith('//'))
                .join('\n');
            expect(code, `${file} must not call process.exit()`).not.toContain('process.exit');
            expect(code, `${file} must not use console.log`).not.toContain('console.log');
        }
    });
});
