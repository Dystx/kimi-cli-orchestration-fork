# Phase 9 — Orchestration Refactor Architecture Overview

## Overview

Nine phases shipped between 2026-06-19 and the present, refactoring the agent loop around an `Orchestrator` core with composable `OrchestrationPolicy` implementations, a session-scoped memory subsystem, a skill router, an event-driven swarm coordinator, and a runtime diagnostics surface exposed through the TUI.

The end state is:

- **Orchestrator core** with policy registration, `beforeStep` / `afterStep` dispatch, and `onContextCompacted` / `onContextClear` notifications.
- **Three policies** (skill routing, plan tracking, …) registered against the orchestrator and isolated from one another by a per-policy `try/catch` boundary inside `runPolicies`.
- **Session-level registry** for swarm runs, so the TUI can render history that survives the lifetime of a single `Agent` instance.
- **`/diag` slash command** that surfaces `OrchestratorDiagnostics` (per-policy fire counts, last error, last fire timestamp) in the TUI, alongside the existing `/status` panel.

Each phase has its own spec + plan in this directory; this document is the entry point for new contributors who need a map of the whole refactor.

## Phase timeline

| Phase | Title | Spec | Plan | Merged (commit) |
|-------|-------|------|------|------------------|
| 1 | Orchestrator core | (none — pre-spec) | (none) | (original merge) |
| 2 | Memory subsystem | 2026-06-19-phase-2-… | … | … |
| 3 | Skill routing | 2026-06-19-phase-3-skill-routing-design.md | (none) | … |
| 4 | Swarm coordinator | 2026-06-19-phase-4-swarm-coordinator-design.md | 2026-06-19-phase-4-swarm-coordinator.md | … |
| 5 | Event channel | 2026-06-19-phase-5-event-channel-design.md | … | … |
| 6 | Parallelism | 2026-06-19-phase-6-parallelism-design.md | … | … |
| 7 | Event-driven completion | 2026-06-19-phase-7-event-driven-completion-design.md | … | … |
| 8 | Orchestrator diagnostics | 2026-06-19-phase-8-orchestrator-diagnostics-design.md | … | … |
| 9 | This mega-phase | 2026-06-19-phase-9-mega-design.md | 2026-06-19-phase-9-mega.md | … |

## Phase 1 — Orchestrator core

- **Goal:** Introduce the `Orchestrator` class with policy registration, `beforeStep` / `afterStep` dispatch, and context-compaction / context-clear notification.
- **Files:** `packages/agent-core/src/agent/orchestrator/`
- **Public APIs:** `Orchestrator`, `OrchestrationPolicy`, `OrchestratorResult`, `OrchestratorInjection`
- **Key invariants:** `runPolicies` isolates each policy's errors via try/catch; injection policy is `prompt_template: orchestrator`.

## Phase 2 — Memory subsystem

- **Goal:** Expose `MemoryStore` as first-class agent tools + bundled MCP server.
- **Files:** `packages/agent-core/src/agent/memory/`, `.../tools/builtin/memory/`, `.../mcp/memory-server.ts`
- **Public APIs:** `MemoryStore`, `MemoryWriteTool`, `MemoryReadTool`, `MemorySearchTool`, `MemoryDeleteTool`, `MemoryPolicy`
- **Key invariants:** 4 tools gated on `agent.memoryStore`; auto-routed inline injection; bundled MCP server in `dist/mcp/memory-server.mjs`.

## Phase 3 — Skill routing

- **Goal:** Auto-activate matching skills via Orchestrator before each step.
- **Files:** `packages/agent-core/src/agent/orchestrator/skill-router.ts`, `.../skill-routing-policy.ts`
- **Public APIs:** `scoreSkills`, `SkillRoutingPolicy`, `SkillActivationOrigin.trigger = 'auto-routed'`
- **Key invariants:** scoring uses token overlap on name + description + tags + whenToUse; gated by `skill_routing` experimental flag.

## Phase 4 — Swarm coordinator

- **Goal:** Extract per-run SwarmCoordinator with `getProgress` / `getResults` / `cancelAll` / `retryFailed` + guaranteed SwarmMode cleanup.
- **Files:** `packages/agent-core/src/agent/swarm/coordinator.ts`, `.../tools/builtin/collaboration/agent-swarm.ts`
- **Public APIs:** `SwarmCoordinator`, `SwarmMember`, `SwarmProgress`, `SwarmMemberStatus`
- **Key invariants:** `try/finally` in `execution` ensures `swarmMode.exit()`; coordinator can be null for test harnesses.

## Phase 5 — Event channel

- **Goal:** Wire real event channel so `SwarmCoordinator` is functional in production.
- **Files:** `packages/agent-core/src/session/orchestration/hooks.ts`, `.../session/subagent-host.ts`, `.../agent/swarm/coordinator.ts`
- **Public APIs:** `OrchestrationHooks.on(event, handler)`, `OrchestrationEvent.type = 'subagent.suspended'`
- **Key invariants:** subscribers invoked synchronously after dedup/enqueue; `getSubagentId(e)` accepts both event shapes.

## Phase 6 — Parallelism

- **Goal:** Restore parallel batch dispatch in `AgentSwarmTool.runSwarm` (parallel `Promise.all` spawn + parallel completion).
- **Files:** `packages/agent-core/src/tools/builtin/collaboration/agent-swarm.ts`
- **Public APIs:** same as Phase 4 (no new surface)
- **Key invariants:** real `agentId` returned by each spawn → registered before completion await; coordinator waits all in parallel.

## Phase 7 — Event-driven completion

- **Goal:** Replace 100ms `waitFor` polling with event-driven Promise resolution.
- **Files:** `packages/agent-core/src/agent/swarm/coordinator.ts`, `.../tools/builtin/collaboration/agent-swarm.ts`
- **Public APIs:** `SwarmCoordinator.awaitCompletion(agentId, signal)`
- **Key invariants:** event handlers resolve pending promises synchronously; abort signal rejects; dispose rejects all pending.

## Phase 8 — Orchestrator diagnostics

- **Goal:** Surface runtime state of every `OrchestrationPolicy`.
- **Files:** `packages/agent-core/src/agent/orchestrator/index.ts`, `.../plan-tracking-policy.ts`, `.../skill-routing-policy.ts`, `apps/kimi-code/src/tui/components/messages/status-panel.ts`
- **Public APIs:** `Orchestrator.getDiagnostics()`, `Orchestrator.recordError(policyName, error)`, `PolicyDiagnostic`, `OrchestratorDiagnostics`, `SessionStatusSnapshot.orchestrator`
- **Key invariants:** accumulator updated by `runPolicies` + `recordError`; /status panel renders orchestrator section.

## Phase 9 — This mega-phase

- **Goal:** Architecture doc + session-level swarm registry + `/diag` slash command + refactor cleanup.
- **Files:** `docs/superpowers/specs/2026-06-19-phase-9-architecture-design.md`, `packages/agent-core/src/session/index.ts`, `.../agent/swarm/coordinator.ts`, `.../tools/builtin/collaboration/agent-swarm.ts`, `apps/kimi-code/src/tui/commands/info.ts`, `apps/kimi-code/src/tui/components/messages/diag-panel.ts`, `packages/protocol/src/events.ts`, `packages/agent-core/src/agent/orchestrator/types.ts`
- **Public APIs:** `SwarmRunSummary`, `Session.recordSwarmRun(summary)`, `Session.getSwarmRuns()`, `/diag` slash command.
- **Key invariants:** `OrchestratorDiagnostics` hoisted to protocol package (single source of truth); dead `OrchestrationHooks.on` cast removed.

## How to extend the system

### Adding a new OrchestrationPolicy

1. Create `packages/agent-core/src/agent/orchestrator/my-policy.ts`:

   ```typescript
   export class MyPolicy implements OrchestrationPolicy {
     readonly name = 'my-policy';
     async beforeStep(ctx) { return { injections: [] }; }
     // optional: afterStep, onContextCompacted, onContextClear
   }
   ```

2. Register in `Agent` constructor (`packages/agent-core/src/agent/index.ts`):

   ```typescript
   this.orchestrator.registerPolicy(new MyPolicy(this));
   ```

3. Add tests for the policy in `packages/agent-core/test/agent/orchestrator/`.
4. If the policy catches errors itself, route them via `this.agent.orchestrator.recordError('my-policy', error)`.

### Adding a new builtin tool

1. Create `packages/agent-core/src/tools/builtin/category/my-tool.ts` implementing `BuiltinTool<MyToolInput>`.
2. Re-export from `packages/agent-core/src/tools/builtin/index.ts`.
3. Register in `packages/agent-core/src/agent/tool/index.ts` `initializeBuiltinTools()` (guard on dependencies).
4. Add the tool name to `packages/agent-core/src/profile/default/agent.yaml`.
5. Add unit tests in `packages/agent-core/test/tools/builtin/`.

### Adding a new slash command (TUI)

1. Add the command entry to `BUILTIN_SLASH_COMMANDS` in `apps/kimi-code/src/tui/commands/registry.ts`.
2. Add a `case` in `handleBuiltInSlashCommand` in `apps/kimi-code/src/tui/commands/dispatch.ts`.
3. Implement the handler function (e.g. in `apps/kimi-code/src/tui/commands/info.ts`).
4. Re-export the handler from `apps/kimi-code/src/tui/commands/dispatch.ts` if needed.

### Debugging orchestrator policy failures

1. Run `/diag` in the TUI to see per-policy fire counts and last errors.
2. Check `getDiagnostics().policies[i].lastError` for the most recent error message and timestamp.
3. Look at `agent.log` for the full stack trace.
4. If a policy silently swallows its errors, add `this.agent.orchestrator.recordError(name, error)` to the catch block.

### Adding a new MCP server

1. Create the server file in `packages/agent-core/src/mcp/my-server.ts` exporting a `startMyMcpServer()` function.
2. Add a config helper in `packages/agent-core/src/mcp/builtin-servers.ts`.
3. Extend `tsdown.config.ts` entry list.
4. Add auto-registration option to `SessionOptions` (mirroring `enableMemoryMcpServer`).
