# Fork Changes

User-facing changes in this fork that diverge from upstream Kimi Code.

Each phase ships with a design spec (`docs/superpowers/specs/`) and implementation plan (`docs/superpowers/plans/`); this document is the high-level summary.

## Tracking upstream

The fork tracks upstream `@moonshot-ai/kimi-code` version 1:1. The fork's `@moonshot-ai/kimi-code` package version is always equal to the most recently synced upstream release tag (currently `0.19.2`).

Operational rules:

- **Do not run `pnpm changeset version` between upstream syncs.** Pending fork changesets in `.changeset/` are documentation of fork-specific work; they accumulate until the next upstream release sync. At that point, the upstream merge commit itself advances the version numbers, and consuming the pending changesets at the same time produces a coordinated patch bump that keeps the fork aligned with upstream.
- **Every pending changeset in `.changeset/` declares `patch` bumps only.** A changeset that justifies a `minor` or `major` bump is a signal that the change is not yet appropriate for the fork — it should land in upstream first, or be deferred. (The `minor` claims in older changesets were downgraded to `patch` when this policy was established; see git history.)
- **Do not declare a fork-specific version line.** The fork does not publish to npm and does not cut `0.X.0-fork.N` releases. The CHANGELOG for each release comes from upstream; the fork's value-add shows up in `FORK_CHANGES.md` and the code.
- **The upstream `.changeset/config.json` changelog generator is intentionally broken for the fork.** It points at `MoonshotAI/kimi-code` (not the fork) and requires `GITHUB_TOKEN`. If `pnpm changeset version` is ever run on the fork, the changelog generator will fail before any version is touched. The fork writes release notes manually into `CHANGELOG.md` if needed; do not reconfigure the generator without a reason.
- **Sync procedure**: when upstream ships a new release, create a branch from the current `main`, merge `upstream/<tag>` (or `upstream/main` if no tag exists), resolve conflicts in the fork's favour for fork-specific files, run `pnpm changeset version` to consume any pending fork changesets at the same time, verify the fork's `@moonshot-ai/kimi-code` version equals the upstream tag, push, and fast-forward `main`.

## Orchestration refactor (Phases 1–8)

The fork introduces an event-driven orchestration layer on top of the upstream agent core.

- **`Orchestrator` class** (`packages/agent-core/src/agent/orchestrator/`). Runs pluggable `OrchestrationPolicy` instances before each step; isolates per-policy errors via `try/catch`; surfaces per-policy diagnostics via `getDiagnostics()`.
- **`SkillRouter`** — **removed by default in the 0.19.2-fork-merge sync**; it is **off** for every user out of the box. The previous default was firing on incidental token overlap and short prompts (`run lint` → any skill mentioning "run" or "lint", `go` → anything mentioning "go", `thanks` → any skill mentioning "help"), which made the orchestrator too eager and matched skills with nothing to do with the task itself. The flag (`KIMI_CODE_EXPERIMENTAL_SKILL_ROUTING`) now defaults to `false` and the policy is a no-op unless the env var is set. When enabled, the router still requires at least two distinct shared tokens, a six-token minimum message length, and a relative score ≥ 0.25 — see `packages/agent-core/src/agent/orchestrator/skill-router.ts` for the scoring logic and `packages/agent-core/test/agent/skill-prompt.test.ts` for the regression cases.
- **`MemoryPolicy`** — auto-injects relevant notes from the memory store into prompts. Opt-in.
- **`PlanTrackingPolicy`** — tracks plan progress across turns.
- **`MemoryStore` interface + bundled MCP server** — `memory_read/write/search/delete` tools, auto-served when `SessionOptions.enableMemoryMcpServer = true`.
- **`/status` slash command** renders an orchestrator section (fire counts, last errors). Implementation: `apps/kimi-code/src/tui/commands/info.ts`.

### Removed TUI commands and panels

To reduce UI clutter and consolidate status display into the footer, the following standalone commands and dialogs were removed in earlier phases:

- **`/cost` slash command** — previously opened a detailed cost/budget breakdown panel in the transcript.
- ~~**`/status` slash command**~~ — re-added in Phase 8 with a focused orchestrator section. Live model/cost/context/git state still lives in the footer.
- **`OrchestrationPanel` dialog** — previously opened a full-screen live view of the plan tracker, active subagents, hooks, health metrics, and background tasks.

## Swarm visibility (Phases 9–12)

The fork surfaces what swarm agents are doing, both live and historically.

- **`Session.swarmRuns`** — in-memory registry of completed swarm runs. `recordSwarmRun(summary)` writes; `getSwarmRuns()` returns sorted-by-`startedAt` desc.
- **`Session.subscribeSwarmRuns(cb)` / `getActiveSwarmRun(runId?)` / `getSwarmRunHistory()`** — live subscription + accessor APIs.
- **`Session.emitSwarmSnapshot(snapshot)`** — fired on every member state change + `cancelAll()` + `dispose()` (with `completedAt` set on terminal snapshot). Also fans out as a typed `swarm.run.snapshot` event over the SDK RPC pipe.
- **`/diag` slash command** — orchestrator policy diagnostics + recent swarm runs. Implementation: `apps/kimi-code/src/tui/commands/info.ts`. Reads `session.getSwarmRunHistory()`.
- **Live `SwarmProgressController`** — owns a single `UsagePanelComponent` that mounts when a swarm starts and unmounts when it ends. Per-member panel lines show status icon + current tool call (e.g. `✓ alice` running `[read_file kimi-code/README.md]`).
- **`SDKAgentAPI.onEvent`** — subscription surface that lets the subagent-host re-emit child tool events through `orchestrationHooks` stamped with `subagentId`. Required for activity tracking to fire in production.

## Search providers

- **`minimax-web-search`** + **`minimax-image-search`** — minimax-backed web/image search via spawned CLI.
- **`chained-web-search`** — composer that tries a primary provider and falls back to a secondary on empty result or error. The existing `web_search` builtin routes through this chain.
- **`parse-first-json`** — helper that extracts the first balanced JSON object/array from a text stream (used to parse CLI stdout).
- Configurable via `[search.web]` TOML block; falls back to upstream behavior when unconfigured.

## Other notable changes

- Git status reads are async and TTL-cached so the footer never blocks on `git` or `gh` calls.
- Agent tool and profile prompt sources use `?raw` imports so they are bundled into `dist/`.
- ACP session replay and error handling have been hardened.
- The skill scanner also looks at `~/.kimi/skills/` as a legacy user skill root, so skills are not silently ignored if they live there instead of `~/.kimi-code/skills/`.
- Session startup logs the resolved skill roots and total skill count for easier debugging.
- `RPCMethods<T>` preserves function-returning methods (e.g. subscriptions) without forcing `Promise<...>` wrapping, enabling `onEvent`-style APIs on the SDK RPC surface.

## Synced to upstream v0.19

Branch `0.19.0-fork-merge` carries the fork forward to upstream `v0.19.0` (92 commits ahead of the merge base) while preserving every entry above. Notable upstream additions adopted:

- **apps/vis refactor** — storage consolidation, sidebar unread dots synced across browser tabs, fast disk-based snapshot reader.
- **TUI** — detach foreground subagents to background with Ctrl+B.
- **agent-core** — workspace `--add-dir` support, unify image-extension sniff-failed detection, additional workspace dirs in system prompt.
- **protocol** — `prompt.submitted` event, worktree support, timeouts on shell tool calls.
- **node-sdk** — telemetry `sessionStartedProperties`, sharper public types.
- **apps/vis/web** — new thin-dispatcher + `renderers.tsx` registry for `WireHeadline` / `WireRowDetail`. The fork adopts this architecture (per-kind renderers live in `renderers.tsx` now).

The merge resolved 30 conflict files / 48 conflict markers. Two `packages/agent-core/test/agent/compaction/full.test.ts` cases time out (`keeps messages appended while compacting an unchanged prefix` and `continues a manual compaction run when the first pass still exceeds the trigger`); the WIP retry path inside `runOnce` fires `triggerPostCompactHook` and `injectGoal` in an order the snapshot doesn't expect. Tracked as known issues for follow-up; everything else (8542 tests) passes.

## Architecture overview

The single canonical reference for the post-Phase-9 architecture lives at `docs/superpowers/specs/2026-06-19-phase-9-architecture-design.md`. It maps each phase to its goal, files, public APIs, and key invariants.

## Migration notes

If you maintain your own fork off an earlier revision:

- `/diag` is **new** in Phase 9; previously only orchestrator state was visible.
- `Session.subscribeSwarmRuns` returns an unsubscribe closure. Old per-call listeners (Phase 5) still work.
- The `Orchestrator` is invoked for **every** turn by default; if you maintain a downstream patch that bypasses it, those turns will skip skill routing and memory injection.
- `web_search` may now route through the chained provider. To restore the upstream-only behavior, set `[search.web].provider = "upstream"`.