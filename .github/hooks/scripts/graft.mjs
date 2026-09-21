// graft freshness: resolve the binary, read the graph's state, and rebuild only
// when the graph is genuinely stale.
//
// Three states, and they stay distinct:
//   current    — the wiring graph matches the code (graft check exits 0)
//   stale      — drift proven, with parseable drift detail
//   unverified — binary missing, timeout, or unparseable output. Never reported
//                as current.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
    ensureStateDir,
    log,
    readState,
    repoRoot,
    shorten,
    stateDir,
    writeState,
} from './hook-io.mjs';

const FALLBACK_BIN = '/opt/homebrew/bin/graft';
const MAINTENANCE_DEADLINE_MS = 20_000;
const CHECK_TIMEOUT_MS = 8_000;
const LOCK_STALE_MS = 60_000;
// A hook must not wait long: a concurrent rebuild is already healing the graph.
const LOCK_WAIT_MS = 1_500;
// After a failed rebuild, stop retrying on every write — but only for a bounded
// window, so one transient failure cannot wedge maintenance until the next session.
const REBUILD_SUPPRESSION_MS = 60_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms) {
    Atomics.wait(sleeper, 0, 0, ms);
}

export function missingBinReason() {
    return process.env.GRAFT_BIN
        ? `GRAFT_BIN points at a file that does not exist: ${process.env.GRAFT_BIN}`
        : `graft binary not found on PATH and not at ${FALLBACK_BIN} (set GRAFT_BIN)`;
}

// Ordered candidates: an explicit GRAFT_BIN is authoritative, then PATH, then the
// macOS fallback. A GUI-launched VS Code does not necessarily inherit the shell's
// PATH order, and a shim that merely *exists* can still fail to load (a stale
// pnpm-global install, for instance) — so candidates are validated by use in
// checkState(), not by existence.
export function graftCandidates() {
    if (process.env.GRAFT_BIN) {
        try {
            const explicit = process.env.GRAFT_BIN;
            return fs.existsSync(explicit) && fs.statSync(explicit).isFile() ? [explicit] : [];
        } catch {
            return [];
        }
    }

    const seen = [];
    const consider = (candidate) => {
        try {
            if (
                !seen.includes(candidate) &&
                fs.existsSync(candidate) &&
                fs.statSync(candidate).isFile()
            ) {
                seen.push(candidate);
            }
        } catch {
            /* keep looking */
        }
    };
    for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
        if (dir) consider(path.join(dir, 'graft'));
    }
    consider(FALLBACK_BIN);
    return seen;
}

export function resolveGraftBin() {
    return graftCandidates()[0] ?? null;
}

function run(bin, args, timeoutMs) {
    try {
        const stdout = execFileSync(bin, args, {
            cwd: repoRoot,
            timeout: timeoutMs,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 8 * 1024 * 1024,
        });
        return { code: 0, stdout, stderr: '' };
    } catch (error) {
        return {
            code: typeof error?.status === 'number' ? error.status : null,
            stdout: typeof error?.stdout === 'string' ? error.stdout : '',
            stderr: typeof error?.stderr === 'string' ? error.stderr : '',
            signal: error?.signal ?? null,
        };
    }
}

// `graft check --json` prints { context, graph }: `graph.ok` is the wiring-graph
// verdict and the source of truth, while the `context` block belongs to the
// optional --deep meaning layer — ok:false there is normal in a healthy repo, so
// it must never be read as drift.
function graphVerdict(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return { ok: false, reason: 'unparseable output' };
    }
    const graph = parsed?.graph;
    if (!graph || typeof graph.ok !== 'boolean') {
        return { ok: false, reason: 'output carries no graph.ok verdict' };
    }
    return { ok: true, parsed, graph };
}

function driftDetail(parsed) {
    const graph = parsed?.graph ?? {};
    const parts = [];
    for (const key of ['added', 'removed', 'changed', 'stale']) {
        const value = graph[key];
        if (Array.isArray(value) && value.length > 0) {
            const shown = value.slice(0, 3).map(String).join(', ');
            parts.push(`${key}: ${shown}${value.length > 3 ? ` (+${value.length - 3} more)` : ''}`);
        }
    }
    if (Array.isArray(graph.coverage) && graph.coverage.length > 0) {
        parts.push(`coverage: ${graph.coverage.length} item(s)`);
    }
    return parts.length > 0 ? parts.join('; ') : 'graph.ok is false';
}

export function checkState(candidates, { deadline, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
    const list = Array.isArray(candidates) ? candidates : candidates ? [candidates] : [];
    if (list.length === 0) return { state: 'unverified', reason: missingBinReason() };

    let lastReason = 'no graft candidate could answer';
    for (const bin of list) {
        const remaining = deadline ? deadline - Date.now() : timeoutMs;
        if (remaining <= 0) {
            return {
                state: 'unverified',
                reason: 'maintenance deadline reached before a check could finish',
            };
        }
        const result = run(
            bin,
            ['check', '--json'],
            Math.max(1_000, Math.min(timeoutMs, remaining)),
        );
        if (result.signal) {
            lastReason = `graft check killed (${result.signal}) [${bin}]`;
            continue;
        }
        const verdict = graphVerdict(result.stdout);
        if (!verdict.ok) {
            // Output we cannot interpret is not proof of drift: this candidate
            // simply cannot answer, so fall through to the next one.
            lastReason = `graft check exited ${result.code ?? '?'} (${verdict.reason}): ${shorten(result.stderr || result.stdout, 160)} [${bin}]`;
            continue;
        }
        if (verdict.graph.ok) {
            // Confirmed in sync — but only accept it from a clean exit, so a shim
            // that swallows a failure cannot pass itself off as current.
            if (result.code === 0) return { state: 'current', bin };
            lastReason = `graft check reported graph.ok but exited ${result.code} [${bin}]`;
            continue;
        }
        return { state: 'stale', detail: driftDetail(verdict.parsed), bin };
    }
    return { state: 'unverified', reason: lastReason };
}

export function rebuild(bin, timeoutMs) {
    // --no-gitignore/--no-ignore: without them a build rewrites the tracked
    // .gitignore and the ripgrep-re-admitting .ignore.
    const result = run(bin, ['build', '--no-gitignore', '--no-ignore'], timeoutMs);
    if (result.code === 0) return { ok: true };
    return {
        ok: false,
        reason: shorten(
            result.stderr || result.stdout || `graft build exited ${result.code ?? '?'}`,
            200,
        ),
    };
}

function lockFile() {
    return path.join(stateDir, 'maintenance.lock');
}

function ownerAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

function releaseIfStale() {
    const file = lockFile();
    try {
        const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
        const age = Date.now() - (Number(owner?.at) || 0);
        if (age > LOCK_STALE_MS || !ownerAlive(Number(owner?.pid))) {
            fs.rmSync(file, { force: true });
            log(`recovered a stale maintenance lock (pid ${owner?.pid}, age ${age}ms)`);
            return true;
        }
        return false;
    } catch {
        // Unreadable, or created but not yet written. Only steal it once it is old
        // enough: deleting it immediately would take the lock away from a live
        // owner that is mid-publish.
        let age;
        try {
            age = Date.now() - fs.statSync(file).mtimeMs;
        } catch {
            return false; // it vanished; the caller retries the create
        }
        if (age > LOCK_STALE_MS) {
            fs.rmSync(file, { force: true });
            log(`recovered an unreadable maintenance lock (age ${age}ms)`);
            return true;
        }
        return false;
    }
}

function acquireLock(deadline) {
    ensureStateDir();
    const file = lockFile();
    const payload = JSON.stringify({ pid: process.pid, at: Date.now() });
    while (Date.now() < deadline) {
        const temp = `${file}.${process.pid}.tmp`;
        try {
            // Publish content and existence atomically: link fails when the lock is
            // already there, so a contender can never observe an empty lock file.
            fs.writeFileSync(temp, payload);
            fs.linkSync(temp, file);
            fs.rmSync(temp, { force: true });
            return true;
        } catch (error) {
            fs.rmSync(temp, { force: true });
            if (error?.code !== 'EEXIST') return false;
            if (releaseIfStale()) continue;
            if (Date.now() >= deadline) return false;
            sleep(120);
        }
    }
    return false;
}

function releaseLock() {
    try {
        const owner = JSON.parse(fs.readFileSync(lockFile(), 'utf8'));
        if (Number(owner?.pid) !== process.pid) return; // someone else owns it now
        fs.rmSync(lockFile(), { force: true });
    } catch {
        /* unreadable or already gone */
    }
}

// Check first, rebuild only when it is genuinely needed. `forceRebuild` is the
// Stop hook's single repair attempt: it lets a repair run even when the previous
// check was unverified (a graph that cannot be read is exactly what a rebuild
// fixes), but it never rebuilds a graph that is already current.
export function maintain({ forceRebuild = false } = {}) {
    const candidates = graftCandidates();
    if (candidates.length === 0) return { state: 'unverified', reason: missingBinReason() };

    const deadline = Date.now() + MAINTENANCE_DEADLINE_MS;
    const state = readState();
    const failedAt = Number(state.rebuildFailedAt) || 0;
    const failedRecently = failedAt > 0 && Date.now() - failedAt < REBUILD_SUPPRESSION_MS;

    if (!acquireLock(Math.min(deadline, Date.now() + LOCK_WAIT_MS))) {
        // Another run is already maintaining the graph. Report what we can see
        // rather than inventing an unverified verdict, and never steal the lock.
        return checkState(candidates, { deadline });
    }

    try {
        const before = checkState(candidates, { deadline });
        if (before.state === 'current') return before;

        if (before.state === 'stale' || forceRebuild) {
            if (failedRecently && !forceRebuild) return { ...before, suppressed: true };
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                return { ...before, reason: 'maintenance deadline reached before the rebuild' };
            const attempt = rebuild(
                before.bin ?? candidates[0],
                Math.min(remaining, MAINTENANCE_DEADLINE_MS),
            );
            if (!attempt.ok) {
                writeState({
                    ...readState(),
                    rebuildFailedAt: Date.now(),
                    rebuildFailure: attempt.reason,
                });
                return { ...before, rebuild: { tried: true, ...attempt } };
            }
            const after = checkState(candidates, { deadline });
            if (after.state !== 'current') {
                writeState({
                    ...readState(),
                    rebuildFailedAt: Date.now(),
                    rebuildFailure: after.reason ?? after.detail,
                });
                return { ...after, rebuild: { tried: true, ok: true }, rebuilt: true };
            }
            const cleared = readState();
            delete cleared.rebuildFailedAt;
            delete cleared.rebuildFailure;
            writeState(cleared);
            return { state: 'current', rebuilt: true };
        }

        return before;
    } finally {
        releaseLock();
    }
}
