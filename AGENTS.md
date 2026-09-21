<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans. The tree is generated, gitignored and
regenerable (`graft build`; `.ignore` re-admits it to ripgrep so searches still
see it) — never commit or hand-edit it.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build --no-gitignore
--no-ignore` (deterministic, no API key, $0 — the two flags stop the build from
rewriting the tracked `.gitignore` and the ripgrep-re-admitting `.ignore`). Check
drift any time with `graft check` (`--json` for machine-readable drift); the
wiring graph is the source of truth and the optional `--deep` meaning layer is
not built here.
<!-- graft:end -->

### Enforced by hooks, not by request

The graft guidance above is advisory on its own. `.github/hooks/` makes it
structural, so work with it rather than around it:

- `session-start.json` (SessionStart) — injects the graft-first reminder plus the
  current freshness state into a new session.
- `pre-tool-use.json` (PreToolUse) — `grep_search` over `.ts`/`.tsx` asks for
  approval, naming the graft equivalent in the reason. Deliberately narrow:
  reaching for the graph first is the path of least resistance and the prompt is
  only the fallback, so ordinary reads are never nagged.
- `post-tool-use.json` (PostToolUse) — after an editor write, a serena mutation
  or a terminal command, the graph is *checked* first and rebuilt only when it is
  genuinely stale. The build passes `--no-gitignore --no-ignore`, so a rebuild
  can never rewrite the tracked `.gitignore`/`.ignore`.
- `post-tool-use.json` (Stop) — checks the graph, attempts one repair, rechecks,
  and blocks the stop once if real drift remains. When `stop_hook_active` is
  true it reports the remaining drift and lets the session stop, so the gate
  cannot loop.

Freshness has three states: **current** (the wiring graph matches the code),
**stale** (drift proven), and **unverified** (binary missing, timeout, or
unparseable output) — unverified is never reported as current. Scripts live in
`.github/hooks/scripts/` (see that folder's README to test them by hand); they
read the event JSON on stdin and write only hook JSON on stdout.

## Agent orchestration (coordinator + workers)

`.github/agents/` defines a six-profile hierarchy; `.github/skills/orchestrate/`
is its entry point. Select **Local → Coordinator** in the agent picker, then
`/orchestrate <task>` — only the Coordinator is user-selectable.

| Agent | Model | Job |
| --- | --- | --- |
| Coordinator | `DeepSeek V4 Pro (deepseek)` | clarify, plan, delegate, run the gates, report |
| Researcher | `DeepSeek V4.1 Flash (deepseek)` | graph-first recon returning `file:line` evidence; no edits, no terminal |
| Implementer | `DeepSeek V4.1 Flash (deepseek)` | the assigned edits plus focused checks |
| Tester | `DeepSeek V4.1 Flash (deepseek)` | owns test edits and runs `pnpm test --run` |
| Reviewer | `DeepSeek V4 Pro (deepseek)` | read-only findings on a stable tree; no edits, no terminal |
| Documenter | `DeepSeek V4.1 Flash (deepseek)` | instruction/doc updates; no terminal |

Rules the suite relies on: at most two concurrent readers, exactly one writer
(implementation, tests, docs, formatting and any command that modifies tracked
files), review required for auth/authz/signature/filesystem/orchestration
changes, and two review/fix rounds before a blocker is reported as incomplete.
Subagent calls are stateless — every dispatch carries its objective, allowed
files, constraints and acceptance criteria, and a worker returns questions to
the Coordinator instead of trying to ask the user.

Installing the suite must not touch application sources (`src/`, `ui/`,
`scripts/`); the only user-facing additions are the Coordinator profile and
`/orchestrate`.

## Formatting & linting — Biome

Biome is the only formatter/linter here (Prettier and its config were removed;
do not reintroduce them or hand-format against its output).

- `pnpm check` — lint + format + import order, read-only (use in CI)
- `pnpm check:fix` — same, applying safe fixes
- `pnpm format` / `pnpm lint` — single-concern runs (`:check` variants are read-only)
- Config: `biome.json` (4-space indent, 100 cols, single quotes, semicolons).
  Biome matches the previous Prettier output byte-for-byte on this codebase.

Note: `biome check` currently reports leftovers from the initial migration —
`noDoubleEquals`, `noImplicitAnyLet`, `noUnreachable`,
`noNonNullAssertedOptionalChain` errors plus `noExplicitAny` /
`noNonNullAssertion` warnings. They are unfixed on purpose (fixing `==` to `===`
and adding annotations can change behaviour), so don't "clean them up"
incidentally.

## Toolchain — Vite+ (tests / task runner / packaging)

`vite-plus` 0.3.3 (beta) is a devDependency; run it as `pnpm exec vp <cmd>` or
through package scripts. Keep every load on pnpm — don't reach for npx (one-off:
`pnpm dlx --package=vite-plus@0.3.3 vp <cmd>`). It does NOT replace Biome —
formatting and linting stay with Biome.

- `pnpm test` → `vp test` (Vitest; specs live in `tests/**/*.test.ts` and import
  test APIs from `vite-plus/test`, not `vitest`). `vp test` cannot compile
  moldecor decorators, so only decorator-free modules are reachable from specs.
- `vp check` is type-check only: `fmt`/`lint` are disabled in `vite.config.ts`,
  and the `fmt` options there just mirror Biome's style so a stray `vp fmt`
  cannot churn the tree. It exits non-zero on the pre-existing typing errors (the
  same set as `tsc --noEmit` — do not encode a count, just don't add new ones),
  so it is not a gate — `pnpm check` is.
- pnpm **12.5.1** is pinned via `packageManager` (corepack shims honor it).
  Settings live in `pnpm-workspace.yaml`: a `vite@*` override that keeps every
  `vite` specifier on the Vite+ core alias, `allowBuilds` (pnpm ≥11's replacement
  for `onlyBuiltDependencies`; `cbor-extract`, `esbuild`, `sqlite3` are `true` —
  unreviewed build scripts hard-fail installs, review with
  `pnpm approve-builds --all`), and a `minimumReleaseAgeExclude` entry for the
  fresh `moldecor` rc that pnpm 12's release-age policy would otherwise block.
- DevDeps carry `vite-plus` only (pinned `0.3.3`): vite-plus aliases `vite` to
  its core package internally, so no project-level `vite` row is needed
  (removed on purpose). The `vite@*` override in `pnpm-workspace.yaml` keeps any
  `vite` specifier on the core build — the `npm:` in its value is pnpm's alias
  spec syntax, not the npm client. After toolchain upgrades, confirm with
  `pnpm why vite` that only `@voidzero-dev/vite-plus-core` resolves. Future
  `vp migrate` runs may re-add a `vite` row or `catalog:` refs — re-remove or
  re-flatten to keep this style.
- `vp pack` is not wired yet: there is no `pack` block in `vite.config.ts`, so
  the published shape is whatever `pnpm build` emits (`dist/`, via
  `scripts/build-server.mjs`) plus `src/` and `ui/dist`. `exports["."]` points at
  the real `src/index.ts` entry. Add a `pack` block when the library ships.
