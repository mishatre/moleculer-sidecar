// SessionStart — inject the graft-first reminder and the graph's current state,
// and clear the rebuild-failure marker so a new session tries again.

import { checkState, graftCandidates, missingBinReason } from './graft.mjs';
import { emit, log, readEvent, readState, recordDebugEvent, writeState } from './hook-io.mjs';

function main() {
    const event = readEvent();
    recordDebugEvent(event);

    const state = readState();
    if (state.rebuildFailedAt) {
        delete state.rebuildFailedAt;
        delete state.rebuildFailure;
        writeState(state);
    }

    const candidates = graftCandidates();
    const freshness =
        candidates.length > 0
            ? checkState(candidates)
            : { state: 'unverified', reason: missingBinReason() };

    const lines = [
        'graft-first (enforced by .github/hooks): this repo is indexed in `graft/` — a generated, gitignored context graph. Consult it before grepping or reading source: graft_find_code / graft_trace_calls / graft_file_api / graft_repo_map, or the CLI `graft ask "<q>" --source` / `graft skeleton <file>` / `graft callers <sym>`. Ranked hits are top-N only; use graft_find_all or `graft grep "<literal>"` when you need every occurrence.',
        `graph freshness: ${freshness.state}${freshness.detail ? ` (${freshness.detail})` : ''}${freshness.reason ? ` (${freshness.reason})` : ''} — an unverified graph is never current.`,
        'gates: `pnpm test --run` (specs in tests/**/*.test.ts), `pnpm exec tsc --noEmit`, `pnpm check` (Biome, the only formatter/linter). tsc and Biome already fail on deliberate pre-existing debt — add no new diagnostics and do not clean that debt up incidentally.',
        'agent suite: `/orchestrate` drives the Coordinator with Researcher / Implementer / Tester / Reviewer / Documenter. One writer at a time; the Coordinator runs the gates.',
    ];

    emit({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') },
    });
}

try {
    main();
} catch (error) {
    log(`session-start failed: ${error?.message ?? error}`);
}
