#!/usr/bin/env node
/**
 * PostToolUse — keep `graft/` in sync with the code after every write.
 *
 * `graft build` replays unchanged files from its extraction cache (measured at
 * ~0.15s on this repo), so rebuilding on every edit is cheaper than reasoning
 * about when the graph went stale. Success is deliberately silent: a hook that
 * reports after each edit would spend the very tokens the graph exists to save.
 */
import { logHookEvent, readHookInput, reply, runGraft, summarize, toolKey } from './hook-io.mjs';

/** Anything that can change the code also invalidates the graph. */
const WRITE_TOOL = /edit|replace|createfile|insert|rename|delete|write|apply|patch|move/;

function main() {
    const input = readHookInput();
    logHookEvent(input);

    if (!WRITE_TOOL.test(toolKey(input.tool_name))) {
        return;
    }

    const { ok, output } = runGraft(['build']);
    if (ok) {
        return;
    }

    reply({
        hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: [
                '`graft build` failed after this edit, so graft/ is stale and its file:line spans',
                'and call edges may no longer match the tree. Run it manually to see the full',
                `error. Output: ${summarize(output)}`,
            ].join(' '),
        },
    });
}

main();
