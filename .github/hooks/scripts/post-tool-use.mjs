// PostToolUse — keep the graph honest after anything that could touch a file.
//
// Freshness is *checked* first and the graph is rebuilt only when it is actually
// stale. That ordering is the reason this hook can afford to be generous about
// which tools it reacts to: a missed tool name costs nothing here, because the
// Stop gate still catches the drift.

import { maintain } from './graft.mjs';
import { emit, log, normalizeToolName, readEvent, recordDebugEvent, shorten } from './hook-io.mjs';

// Anything whose name implies a write to disk. Read-only tools must never match:
// `readFile`, `grepSearch`, `listDir`, `getErrors`, `serena.find_symbol`, ...
const WRITE_SIGNAL = /(create|replace|insert|edit|patch|write|delete|rename|apply)/;
const READ_SIGNAL =
    /(read|grep|search|list|fetch|get|find|summary|todo|usages|selection|lastcommand|stats|check|freshness|diagnostic|screenshot|viewimage|navigate|click|hover|drag|typeinpage|render|askquestion|config|initialinstructions|open_dashboard)/;
// Terminal commands and subagent runs can change files without an editor tool.
const SIDE_CHANNELS =
    /^(runinterminal|sendtoterminal|killterminal|createandruntask|runsubagent|memory)$/;

function isWriteLike(normalized) {
    if (SIDE_CHANNELS.test(normalized)) return true;
    if (READ_SIGNAL.test(normalized)) return false;
    return WRITE_SIGNAL.test(normalized);
}

function main() {
    const event = readEvent();
    recordDebugEvent(event);

    const tool = normalizeToolName(event?.tool_name);
    if (!isWriteLike(tool)) return;

    const result = maintain({ forceRebuild: false });
    if (result.state === 'current') return;

    // Never let a stale or unverified graph read as current. Anything else is
    // silent — a rebuild that worked does not need to interrupt the model.
    const detail =
        result.reason ??
        result.detail ??
        (result.suppressed ? 'a previous rebuild failed in this session' : 'unknown');
    emit({
        hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: `graft graph is ${result.state}: ${shorten(detail)} — do not claim graph freshness; retry with \`graft build --no-gitignore --no-ignore\` or report it as unverified.`,
        },
    });
}

try {
    main();
} catch (error) {
    log(`post-tool-use failed: ${error?.message ?? error}`);
}
