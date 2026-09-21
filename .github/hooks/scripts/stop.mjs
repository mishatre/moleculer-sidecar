// Stop — the safety net. Check the graph, attempt ONE repair, recheck, and block
// the stop only when drift is demonstrated and the session has not already been
// continued by this hook (stop_hook_active), so the gate cannot loop.
//
// Unverified is reported, never blocked on: a missing binary or a timeout is not
// proof of drift, and blocking costs credits.

import { maintain } from './graft.mjs';
import { emit, log, readEvent, recordDebugEvent, shorten } from './hook-io.mjs';

function main() {
    const event = readEvent();
    recordDebugEvent(event);

    const result = maintain({ forceRebuild: true });
    if (result.state === 'current') return;

    const detail = shorten(result.reason ?? result.detail ?? 'unknown state');
    const repair = result.rebuild?.tried
        ? ` (one repair attempt: ${result.rebuild.ok === false ? shorten(result.rebuild.reason) : 'did not resolve it'})`
        : ' (no repair attempt was possible)';
    const advice =
        'Fix with `graft build --no-gitignore --no-ignore`, or report the graph as unverified.';

    if (result.state === 'stale') {
        if (event?.stop_hook_active === true) {
            emit({
                systemMessage: `graft drift remains after one repair — graph is stale: ${detail}${repair}. ${advice}`,
            });
            return;
        }
        emit({
            hookSpecificOutput: {
                hookEventName: 'Stop',
                decision: 'block',
                reason: `The graft graph is stale relative to the code: ${detail}${repair}. ${advice}`,
            },
        });
        return;
    }

    emit({
        systemMessage: `graft freshness could not be verified: ${detail}${repair}. ${advice}`,
    });
}

try {
    main();
} catch (error) {
    log(`stop failed: ${error?.message ?? error}`);
}
