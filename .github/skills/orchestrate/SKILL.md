---
name: orchestrate
description: "Drive a task through the coordinator/worker hierarchy: baseline, recon, implementation, tests, review and documentation, with explicit gates and evidence. Use when asked to /orchestrate a task, or when a request should be broken into subtasks and dispatched to subagents."
argument-hint: "[task description, constraints, and how success will be judged]"
disable-model-invocation: true
---

# Orchestrate

This skill runs **inline in the current agent**. It does not switch agents for you: the hierarchy only works when the Coordinator is the active profile. If you are not the Coordinator, say so and stop.

## 1. Baseline (Coordinator only — never delegate this)

- `git rev-parse --short HEAD` and `git status --short` — record the starting point and any pre-existing user changes. Never reset, stash, revert or discard them.
- The gates as they stand: `pnpm test --run`, `pnpm exec tsc --noEmit`, `pnpm check`. `tsc` and `pnpm check` already fail on deliberate pre-existing debt — record *which* diagnostics exist so "no new ones" is checkable, and compare by file + rule + message, never by count.
- `graft check --json` for graph freshness.

## 2. Decide whether to delegate

Pick a tier explicitly; record the choice in the close-out (see §6).

**Tier 0 — no delegation.** The work is tiny *and* low-risk: a doc-string or
comment fix, a one-line mechanical edit whose fix is already known, or a trivial
single-file documentation change. Do it yourself and report.

**Tier 1 — delegate.** Everything else is specialist work. Ask for the smallest
unit that produces a checkable artifact. "I already understand it" is not by
itself a reason to absorb Tier 1 work — if you do it yourself anyway, the
close-out must say so and why.

Neither tier waives the mandatory review: authentication, authorization,
signatures, filesystem/VFS, or orchestration changes are always reviewed.

## 3. Split without collisions

Mark each task `read` or `write`, then schedule:

- **At most two readers in flight.** Independent investigation threads go out in the same turn so they run concurrently — dependency-ordered work does not.
- **Exactly one writer at a time**, across implementation, tests, documentation, formatting, and any command that modifies tracked files. While a worker owns the write phase, the Coordinator does not edit.
- **Review only on a frozen tree**, after the writers have stopped.

## 4. Dispatch contract

Workers are stateless and cannot ask anything. Every dispatch carries all of it:

- objective in one sentence;
- evidence already gathered, with `file:line` — never make a worker re-derive what you know;
- a **whitelist** of files it may touch;
- constraints: style rules, the do-not-touch list (deliberate lint/type debt), no commits, no `graft build`;
- dependencies: what must land first;
- acceptance criteria plus the exact command that proves them;
- the return format you expect.

## 5. Sequence

1. **Researcher** (read) — only if the facts are genuinely unknown. In this repo the graph usually answers it already; `graft_find_code` / `graft_trace_calls` first.
2. **Implementer** (write) — one at a time, with the Researcher's findings pasted in.
3. **Tester** (write) — after implementation stops; for logic-heavy changes, run it *before* implementation to land failing specs first.
4. **Reviewer** (read) — on the frozen tree. Required for authentication, authorization, signatures, filesystem/VFS, or orchestration changes.
5. **Implementer** again for review findings, then re-review. **Two rounds maximum**, then report the remaining blocker as explicitly incomplete.
6. **Documenter** (write) — only when instructions or docs genuinely changed meaning.
7. **Close out** — re-run the gates yourself against the baseline, refresh the graph if it drifted (`graft build --no-gitignore --no-ignore`), then report.

## 6. Reporting

Status (done / partial / blocked); a **Delegation** line; what changed as `path — why`; the commands actually run with observed results; review outcome; `graft check` freshness; and what remains incomplete or unverified. Never report success for a gate you did not run, never present an unverified claim as verified, and never let a missing check read as a passing one.

The Delegation line makes the §2 decision checkable instead of a private
rationalization:

`Delegation: {mode: self|delegate, role: Researcher|Implementer|Tester|Reviewer|Documenter|none, why: one sentence}`

`mode: self` pairs with `role: none` and is valid only for Tier 0 work, or for a
Tier 1 task you absorbed with an explicit reason. `mode: delegate` names the
roles actually dispatched — one line per role when several ran.
