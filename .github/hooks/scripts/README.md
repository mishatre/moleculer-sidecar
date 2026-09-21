# Hook scripts

Workspace hooks that keep the graft context graph honest. Each script reads one
event as JSON on **stdin** and writes only hook JSON on **stdout**; diagnostics go
to stderr. Nothing here calls `process.exit()` after writing stdout, because piped
writes are async and would be truncated.

| Config | Event | Script | Behaviour |
| --- | --- | --- | --- |
| `session-start.json` | `SessionStart` | `session-start.mjs` | Injects the graft-first reminder + freshness state; clears the rebuild-failure marker. |
| `pre-tool-use.json` | `PreToolUse` | `pre-tool-use.mjs` | `ask` for `grep_search` over source (or unscoped); deduped per session and scope. |
| `post-tool-use.json` | `PostToolUse` | `post-tool-use.mjs` | After a write-like tool, terminal command or subagent run: **check** freshness, rebuild only when stale. |
| `post-tool-use.json` | `Stop` | `stop.mjs` | Check → one repair → recheck → block once on demonstrated drift; report-only when `stop_hook_active`. |

## Freshness states

- **current** — `graft check --json` reports `graph.ok: true` with a clean exit. The
  verdict is read from `graph.ok`, not from the exit code alone, so a shim that
  swallows a failure cannot pass itself off as current.
- **stale** — `graph.ok` is false, with the drift summarised from its `added` /
  `removed` / `changed` / `stale` lists.
- **unverified** — no candidate produced a `graph.ok` verdict, or the maintenance
  deadline expired first. Never reported as current, and never blocked on: an
  unreadable graph is not proof of drift, and blocking costs AI credits.

The `context` block in that JSON belongs to the optional `--deep` meaning layer and
is `ok: false` even in a healthy repository — it is never read as drift. That layer
is not built here; the wiring graph is the source of truth.

## Binary resolution

Candidates are tried in order — an explicit `GRAFT_BIN` (authoritative, so a typo
surfaces as `unverified`), then every `graft` on `PATH`, then
`/opt/homebrew/bin/graft`. A candidate is validated **by use**: output without a
`graph.ok` verdict means it cannot answer, and the next candidate is tried. This
matters because a GUI-launched VS Code does not necessarily inherit the shell's
`PATH` order, and a stale install (a pnpm-global shim whose native module fails to
load, say) would otherwise shadow a working binary.

## Testing by hand

Run from the repository root. Every script is safe to run directly:

```sh
echo '{"hook_event_name":"SessionStart","source":"new","session_id":"manual","cwd":"'"$PWD"'"}' \
  | node .github/hooks/scripts/session-start.mjs

echo '{"hook_event_name":"PreToolUse","tool_name":"grep_search","session_id":"manual","tool_input":{"query":"readFileSync","includePattern":"src/**"}}' \
  | node .github/hooks/scripts/pre-tool-use.mjs

echo '{"hook_event_name":"PostToolUse","tool_name":"create_file","session_id":"manual","tool_input":{"filePath":"src/tmp.ts"}}' \
  | node .github/hooks/scripts/post-tool-use.mjs

echo '{"hook_event_name":"Stop","stop_hook_active":false,"session_id":"manual"}' \
  | node .github/hooks/scripts/stop.mjs
```

Expect: silent output (`exit 0`, no stdout) when the graph is current and the tool
is not a write; a JSON object otherwise. Malformed or empty stdin must also be
silent — a hook that crashes must never break a normal session.

Failure paths, without touching the repository:

```sh
GRAFT_BIN=/nonexistent/graft node .github/hooks/scripts/stop.mjs < /dev/null
GRAFT_BIN=/nonexistent/graft sh -c 'echo "{\"hook_event_name\":\"Stop\",\"stop_hook_active\":true}" | node .github/hooks/scripts/stop.mjs'
```

The first reports `unverified` through `systemMessage`; the second also reports
rather than blocking, because `stop_hook_active` is true. An explicitly set
`GRAFT_BIN` is authoritative — a typo surfaces as `unverified` instead of being
papered over by the `/opt/homebrew/bin/graft` fallback. Only when `GRAFT_BIN` is
unset does resolution go: `PATH`, then that fallback.

## Discovering the real tool names

The published docs show `tool_name: "editFiles"`, while in-session editor tools are
named `create_file`, `replace_string_in_file`, `multi_replace_string_in_file`,
`insert_edit_into_file`, `apply_patch`, `delete_file`, `rename_file`. To capture
what this session actually sends:

```sh
GRAFT_HOOK_DEBUG=1   # set in the environment VS Code launches hooks with
```

Every received event is appended to `payloads.jsonl` in the state directory
printed below. Update `WRITE_SIGNAL` / `READ_SIGNAL` in `post-tool-use.mjs` from
captured evidence, not from guesswork.

## State and locking

Lock, session state and the debug log live **outside the repository**, in
`$TMPDIR/graft-hook-<repo>` (override with `GRAFT_HOOK_STATE_DIR`, which the test
suite relies on to isolate cases), so nothing here ever shows up in `git status`.

Maintenance is guarded by a per-repository lock whose content and existence are
published atomically (write-then-`link`), so a contender can never observe an empty
lock file and mistake it for stale. A live owner's lock is **never** stolen; a lock
whose pid is gone, or that is unreadable and older than 60 s, is recovered. A hook
waits at most 1.5 s for the lock, then falls back to a plain check and reports what
it sees, so a concurrent rebuild passes by without disturbing the session.

- Finite wait: 1.5 s for the lock, 20 s for the whole operation (checks included).
- Each check is bounded by the remaining deadline, so a pathologically slow candidate
  cannot blow the budget however many candidates are on `PATH`.
- After a failed rebuild, automatic rebuilds are suppressed for 60 s — enough to stop
  hammering a broken build on every write, bounded so a transient failure cannot wedge
  maintenance. The `Stop` repair attempt and a manual build are never suppressed.
- `Stop` never rebuilds a graph that is already current; its repair attempt applies to
  `stale` and `unverified` only.

Builds always pass `--no-gitignore --no-ignore`. Without those flags a plain
`graft build` rewrites the tracked `.gitignore` and the ripgrep-re-admitting
`.ignore`.
