// PreToolUse — the one raw-search prompt.
//
// Deliberately narrow: only `grep_search` over source (or over an unscoped
// search, which in this repo means source) asks for approval. Reads are never
// gated; SessionStart carries the reminder. The prompt is deduped per session
// and per scope, so a workflow that genuinely needs grep is not interrupted
// repeatedly.
import {
    emit,
    log,
    normalizeToolName,
    readEvent,
    readState,
    recordDebugEvent,
    writeState,
} from './hook-io.mjs';

const GREP_TOOL = 'grepsearch';
const SOURCE_SCOPE = /(\.tsx?\b|\.mts\b|\.cts\b|\bsrc\/|\bui\/|\btests\/)/i;

function scopeOf(input) {
    const raw = input?.includePattern ?? input?.include ?? input?.path ?? '';
    return String(raw).trim();
}

function main() {
    const event = readEvent();
    recordDebugEvent(event);

    if (normalizeToolName(event?.tool_name) !== GREP_TOOL) return;

    const scope = scopeOf(event?.tool_input);
    // A search explicitly scoped to docs, config or markdown is not the case
    // this hook exists to redirect.
    const targetsSource = scope === '' || SOURCE_SCOPE.test(scope);
    if (!targetsSource) return;

    const sessionId = String(event?.session_id ?? 'unknown');
    const key = scope === '' ? '<unscoped>' : scope;
    const state = readState();
    const approved = state.sessionId === sessionId ? (state.grepScopes ?? []) : [];
    if (approved.includes(key)) return;

    if (state.sessionId !== sessionId) {
        writeState({ sessionId, grepScopes: [key] });
    } else {
        writeState({ ...state, grepScopes: [...approved, key] });
    }

    emit({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason:
                'graft-first: the graph usually answers this for a fraction of the tokens. Read-only alternatives: graft_find_code (how does X work), graft_trace_calls (who calls / blast radius), graft_file_api (a file\'s API), graft_repo_map (orientation) — or the CLI `graft ask "<query>" --source`, `graft skeleton <file>`. Approve to grep the source tree anyway.',
        },
    });
}

try {
    main();
} catch (error) {
    log(`pre-tool-use failed: ${error?.message ?? error}`);
}
