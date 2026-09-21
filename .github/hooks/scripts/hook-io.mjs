// Shared helpers for the workspace hooks.
//
// Contract: hooks read one JSON event on stdin and write ONLY hook JSON on
// stdout. Diagnostics go to stderr, and nothing here ever calls process.exit()
// after writing stdout — piped writes are async and would be truncated.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// <repo>/.github/hooks/scripts/<file> -> <repo>
export const repoRoot = path.dirname(path.dirname(path.dirname(here)));

// Lock/state live outside the repo: they must never show up in git status.
// GRAFT_HOOK_STATE_DIR overrides the location so tests can isolate themselves.
export const stateDir =
    process.env.GRAFT_HOOK_STATE_DIR ??
    path.join(os.tmpdir(), `graft-hook-${repoRoot.replace(/[^a-zA-Z0-9]/g, '_').slice(-40)}`);

export function ensureStateDir() {
    try {
        fs.mkdirSync(stateDir, { recursive: true });
    } catch {
        /* best effort */
    }
}

export function readEvent() {
    try {
        const raw = fs.readFileSync(0, 'utf8').trim();
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

// VS Code ignores the matchers in hook config, so every script filters on the
// tool name itself. Normalizing means a casing or separator change cannot
// silently disable a hook.
export function normalizeToolName(name) {
    return String(name ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

export function emit(payload) {
    if (payload == null) return;
    process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function log(message) {
    try {
        process.stderr.write(`[graft-hook] ${message}\n`);
    } catch {
        /* stderr may be closed */
    }
}

export function readState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

export function writeState(state) {
    ensureStateDir();
    const target = path.join(stateDir, 'state.json');
    const temp = `${target}.${process.pid}.tmp`;
    try {
        // Write-then-rename so a concurrent reader never sees a half-written file.
        fs.writeFileSync(temp, JSON.stringify(state));
        fs.renameSync(temp, target);
    } catch {
        try {
            fs.rmSync(temp, { force: true });
        } catch {
            /* best effort */
        }
    }
}

// Set GRAFT_HOOK_DEBUG=1 to capture every event a hook receives. This is how the
// real wire tool names get discovered — the docs' example payload uses
// `editFiles`, while editor tools are named `create_file` /
// `replace_string_in_file` in-session.
export function recordDebugEvent(event) {
    if (!process.env.GRAFT_HOOK_DEBUG) return;
    try {
        ensureStateDir();
        fs.appendFileSync(
            path.join(stateDir, 'payloads.jsonl'),
            `${JSON.stringify({ at: new Date().toISOString(), event })}\n`,
        );
    } catch {
        /* best effort */
    }
}

export function shorten(value, max = 240) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    const flat = String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
