/**
 * Shared plumbing for this repo's agent hooks (`.github/hooks/*.json`).
 *
 * VS Code runs a hook as a shell command, hands it the event as JSON on stdin
 * and reads JSON back from stdout — silence means "no opinion, carry on". The
 * helpers below pin that contract down in one place so each hook script only
 * has to spell out its own policy.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolved from this file, not from the process cwd, so hooks work either way. */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const LOG_FILE = join(tmpdir(), 'vscode-agent-hooks.jsonl');

/** Tool names vary in casing and punctuation across VS Code builds: flatten them. */
export function toolKey(toolName) {
    return String(toolName ?? '')
        .replace(/[^a-z0-9]/gi, '')
        .toLowerCase();
}

export function readHookInput() {
    try {
        const raw = readFileSync(0, 'utf8').trim();
        return raw === '' ? {} : JSON.parse(raw);
    } catch {
        // An unreadable event must not break the session: treat it as "no opinion".
        return {};
    }
}

/** Write the hook's reply. Pass a falsy payload for "no opinion". */
export function reply(payload) {
    if (payload) {
        process.stdout.write(`${JSON.stringify(payload)}\n`);
    }
}

/**
 * Append every event to a temp log. The first runs use it to discover the exact
 * `tool_name` strings this VS Code build sends — the matchers below are written
 * to tolerate renaming, and this is how we tell whether they still match.
 */
export function logHookEvent(input) {
    const line = JSON.stringify({
        at: new Date().toISOString(),
        event: input.hook_event_name ?? null,
        tool: input.tool_name ?? null,
    });
    try {
        appendFileSync(LOG_FILE, `${line}\n`);
    } catch {
        // Logging is best-effort: never let it break the agent session.
    }
}

function graftBin() {
    const configured = process.env.GRAFT_BIN;
    if (configured) {
        return configured;
    }
    const installed = ['/opt/homebrew/bin/graft', '/usr/local/bin/graft'];
    return installed.find((path) => existsSync(path)) ?? 'graft';
}

/** Run a graft subcommand; never throws, so a broken graph cannot break the agent. */
export function runGraft(args, timeout = 20_000) {
    try {
        const output = execFileSync(graftBin(), args, {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout,
        });
        return { ok: true, output: String(output) };
    } catch (error) {
        const output = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim();
        return { ok: false, output: output || String(error?.message ?? error) };
    }
}

/** Collapse graft output into something that fits in a hook reply. */
export function summarize(output, limit = 700) {
    const text = String(output).replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
