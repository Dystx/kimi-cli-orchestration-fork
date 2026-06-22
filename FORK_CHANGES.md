# Fork Changes

User-facing changes in this fork that diverge from upstream Kimi Code.

Each phase ships with a design spec (`docs/superpowers/specs/`) and implementation plan (`docs/superpowers/plans/`); this document is the high-level summary.

## Orchestration refactor (Phases 1–8)

The fork introduces an event-driven orchestration layer on top of the upstream agent core.

- **`Orchestrator` class** (`packages/agent-core/src/agent/orchestrator/`). Runs pluggable `OrchestrationPolicy` instances before each step; isolates per-policy errors via `try/catch`; surfaces per-policy diagnostics via `getDiagnostics()`.
- **`SkillRouter`** — auto-scores and pre-injects relevant skills based on the user's prompt. Enabled by default; disable with `KIMI_CODE_EXPERIMENTAL_SKILL_ROUTING=0` if the activation is too eager for your workflow.
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

## Architecture overview

The single canonical reference for the post-Phase-9 architecture lives at `docs/superpowers/specs/2026-06-19-phase-9-architecture-design.md`. It maps each phase to its goal, files, public APIs, and key invariants.

## Migration notes

If you maintain your own fork off an earlier revision:

- `/diag` is **new** in Phase 9; previously only orchestrator state was visible.
- `Session.subscribeSwarmRuns` returns an unsubscribe closure. Old per-call listeners (Phase 5) still work.
- The `Orchestrator` is invoked for **every** turn by default; if you maintain a downstream patch that bypasses it, those turns will skip skill routing and memory injection.
- `web_search` may now route through the chained provider. To restore the upstream-only behavior, set `[search.web].provider = "upstream"`.