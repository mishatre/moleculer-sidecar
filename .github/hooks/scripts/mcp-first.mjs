#!/usr/bin/env node
/**
 * PreToolUse gate — make the built-in search/read tools the *last* resort.
 *
 * The context graph answers most "where is X / how does X work" questions in
 * one call at a fraction of the tokens of a grep-then-read-the-file loop, but
 * nothing in the repo can guarantee a model reaches for it: instructions are
 * advisory. This hook turns the cheap path into an explicit decision, and the
 * reason text doubles as the redirect to the right tool.
 */
import { logHookEvent, readHookInput, reply, toolKey } from './hook-io.mjs';

/** Repo-wide text search — `graft_find_all` is the exhaustive equivalent. */
const GATED_SEARCH_TOOLS = new Set(['grepsearch', 'codebasesearch']);

/** Whole-file reads are only worth gating for indexed source, not docs or config. */
const GATED_READ_TOOLS = new Set(['readfile']);
const INDEXED_SOURCE = /\.(ts|tsx|mts|cts)$/i;

const REASON = [
    'This repo is indexed by graft — answer from the context graph instead of grepping and reading',
    'whole files: graft_find_code (where/how does X work, code inlined), graft_find_all (every',
    'occurrence), graft_trace_calls (callers, callees, blast radius before an edit), graft_file_api',
    "(a file's API surface in ~200 tokens), graft_repo_map (orientation); for symbol-level work use",
    'serena find_symbol / get_symbols_overview / find_referencing_symbols / search_for_pattern.',
    'Approve only when the graph genuinely lacks the answer — unindexed files, or non-code content.',
].join(' ');

const ADDITIONAL_CONTEXT =
    'Prefer graft/serena MCP tools over built-in search and whole-file reads in this repo.';

function main() {
    const input = readHookInput();
    logHookEvent(input);

    const key = toolKey(input.tool_name);
    const toolInput = input.tool_input ?? {};
    const filePath = String(toolInput.filePath ?? toolInput.path ?? toolInput.file ?? '');

    const gated =
        GATED_SEARCH_TOOLS.has(key) || (GATED_READ_TOOLS.has(key) && INDEXED_SOURCE.test(filePath));

    if (!gated) {
        return;
    }

    reply({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: REASON,
            additionalContext: ADDITIONAL_CONTEXT,
        },
    });
}

main();
