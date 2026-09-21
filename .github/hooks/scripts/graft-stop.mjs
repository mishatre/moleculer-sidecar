#!/usr/bin/env node
/**
 * Stop gate — don't let a session finish on a stale graph.
 *
 * `graft check` compares the graph against the actual file contents: it exits 1
 * and lists the added/removed symbols when the two disagree. Because graft-sync
 * rebuilds after every write this should rarely fire; when it does, the change
 * came from somewhere the write hook cannot see — a terminal command, a git
 * operation, or a manual save.
 */
import { logHookEvent, readHookInput, reply, runGraft, summarize } from './hook-io.mjs';

/** Only *structural* drift is worth blocking on; any other failure is a warning. */
const DRIFT = /rebuild the structure|is stale|out of date|drift/i;

function main() {
    const input = readHookInput();
    logHookEvent(input);

    // A previous Stop hook already sent the agent back to work: don't loop.
    if (input.stop_hook_active) {
        return;
    }

    const { ok, output } = runGraft(['check'], 15_000);
    if (ok) {
        return;
    }

    if (!DRIFT.test(output)) {
        reply({
            systemMessage: `graft check failed, but not with a staleness error: ${summarize(output)}`,
        });
        return;
    }

    reply({
        hookSpecificOutput: {
            hookEventName: 'Stop',
            decision: 'block',
            reason: [
                'graft/ is stale relative to the code, so its file:line spans and call edges no longer',
                'match the tree. Run `graft build` (deterministic, no key, unchanged files replay from',
                `cache) before finishing. Details: ${summarize(output)}`,
            ].join(' '),
        },
    });
}

main();
