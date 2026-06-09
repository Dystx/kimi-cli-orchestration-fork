# OMK Fork Comprehensive Review

**Date:** 2026-06-09
**Upstream:** MoonshotAI/kimi-code (0.12.1+)
**Fork:** Dystx/kimi-code (95 commits ahead)
**Build Status:** PASS (all packages)
**Test Status:** PASS (2547 passed, 1 skipped in agent-core)

---

## 1. Architecture Overview

### 1.1 Repository Structure

```
kimi-code/
├── apps/
│   └── kimi-code/          # CLI/TUI application (heavily modified)
│   └── vis/                # Visualization app (unmodified)
├── packages/
│   ├── agent-core/         # Core agent engine (heavily modified)
│   ├── node-sdk/           # TypeScript SDK (lightly modified)
│   ├── acp-adapter/        # Agent Client Protocol (unmodified)
│   ├── migration-legacy/   # Legacy migration (unmodified)
│   ├── kaos/               # Filesystem abstraction (unmodified)
│   ├── kosong/             # LLM provider abstraction (unmodified)
│   ├── oauth/              # OAuth flows (unmodified)
│   └── telemetry/          # Telemetry client (unmodified)
├── packages/agent-core/.agents/skills/   # OMK custom skills
└── scripts/omk-mcp/        # Standalone MCP server
```

### 1.2 Key Architectural Patterns

| Pattern | Location | Description |
|---------|----------|-------------|
| **Append-only Context** | `agent/context/index.ts` | Messages queued during open tool exchanges; flushed only when all pending tool results received |
| **Two-tier Compaction** | `agent/compaction/` | Full (LLM summary) + Micro (tool result truncation). Full blocks turn; micro is transparent |
| **Agent Records (Wire Log)** | `agent/records/` | All state changes logged to append-only JSONL. Resume replays records through same mutation paths |
| **Event-driven TUI** | `apps/kimi-code/src/tui/controllers/` | Single `session.onEvent` subscription demuxed to typed handlers |
| **Reverse RPC** | `tui/reverse-rpc/` | Approval/question dialogs pushed via events; non-blocking |
| **Tool Scheduler** | `loop/tool-scheduler.ts` | Non-conflicting tools run concurrently; conflicting ones serialized via `ToolAccesses` |

---

## 2. Custom Features (Fork-Specific)

### 2.1 Orchestration Layer

**Files:**
- `src/session/orchestration-hooks.ts`
- `src/agent/injection/orchestration-skills.ts`
- `src/tui/components/dialogs/orchestration-panel.ts`

**Purpose:** Event-to-skill mapping engine. Runtime events (task.completed, subagent.completed, goal.started, etc.) automatically trigger skill activations (quality-gate, code-review, plan-first, troubleshooting, security-review, git-commit-pr).

**Integration:** `OrchestrationHooks` queues events; `OrchestrationSkillInjector` drains them as skill injections before each LLM step. Deduplicated by `event.type + JSON.stringify(payload)`.

**Risk:** Dedup set grows unbounded until drained. Large/non-serializable payloads could cause issues.

### 2.2 Learning Engine ("Hermes")

**Files:**
- `src/session/learning-engine.ts`
- `src/session/outcome-tracker.ts`
- `src/tools/builtin/learning/*.ts`

**Purpose:** Pattern detection from session outcomes. Analyzes reliable tool sequences, subagent preferences, error-avoidance patterns. Generates draft skills in `.omk/skill-drafts/`, SOUL suggestions, memory suggestions. Auto-runs on session end.

**Risk:** CPU-intensive analysis on close; no progress indication. Memory growth from pattern cache.

### 2.3 Health Monitor

**Files:**
- `src/session/health-monitor.ts`
- `src/tools/builtin/collaboration/get-session-health.ts`
- `src/tools/builtin/collaboration/get-performance-report.ts`

**Purpose:** Ring-buffered token burn rate (tokens/min over 5min window), avg turn duration, error rate, avg steps/turn. Generates actionable recommendations.

### 2.4 Memory Store

**Files:**
- `src/session/memory-store.ts`
- `src/agent/injection/memory.ts`

**Purpose:** Cross-session memory retrieval from `.omk/memory/entries.json`. Keyword + tag + workDir affinity scoring. Max 1000 entries. Injected every N turns and post-compaction.

**Risk:** Scoring is primitive (keyword-based, no embeddings). Could return irrelevant memories or miss semantically related ones.

### 2.5 Plan Tracker

**Files:**
- `src/agent/plan/tracker.ts`
- `src/agent/injection/plan-tracker.ts`
- `src/tools/builtin/planning/*.ts`

**Purpose:** File-backed structured plan state (`plan-tracker.json`). Parses markdown task lists into tasks, auto-advances current task, reports progress. Survives compaction via summary injection.

**Key fix applied:** Dynamic `filePath` based on `agent.config.cwd`. Auto-clears when all tasks done.

### 2.6 Checkpoint / Rollback

**Files:**
- `src/session/checkpoint.ts`
- `src/tools/builtin/file/checkpoint.ts`
- `src/tools/builtin/file/rollback.ts`

**Purpose:** Named snapshots of messages, goals, tasks, usage to JSON files in `<baseDir>/checkpoints/`.

**Risk:** `plan` field in checkpoints is hardcoded to `null` with a TODO. Checkpoints do not restore plan tracker state.

### 2.7 Task Registry

**Files:**
- `src/session/task-registry.ts`
- `src/tools/builtin/collaboration/task-registry.ts`

**Purpose:** Dependency-tracked persistent task list. Auto recomputes `blocked`/`pending` states. Persisted to `.omk/state/tasks.json`.

### 2.8 Cost Tracker

**Files:**
- `src/session/cost-tracker.ts`
- `src/tools/builtin/collaboration/get-cost-status.ts`
- `src/tools/builtin/collaboration/set-cost-budget.ts`
- `apps/kimi-code/src/tui/commands/cost.ts`

**Purpose:** Per-session cost estimation with budget enforcement. `/cost` slash command in TUI.

### 2.9 Subagent Cache

**Files:**
- `src/session/subagent-cache.ts`

**Purpose:** Prompt-hash keyed TTL cache for subagent results. Reduces redundant subagent spawns.

### 2.10 Shared Store & Message Bus

**Files:**
- `src/session/shared-store.ts`
- `src/session/message-bus.ts`
- `src/tools/builtin/collaboration/*-shared-state.ts`
- `src/tools/builtin/collaboration/send-message.ts`
- `src/tools/builtin/collaboration/receive-message.ts`

**Purpose:** Inter-agent pub/sub and key-value shared state for collaboration.

### 2.11 File Lock

**Files:**
- `src/session/file-lock.ts`
- `src/tools/builtin/collaboration/file-lock.ts`

**Purpose:** Cooperative file locking for parallel subagents.

### 2.12 Hook Engine

**Files:**
- `src/session/hooks/engine.ts`

**Purpose:** Shell-command hooks with regex matching, timeout (default 30s), fire-and-forget support. Input data camel→snake_cased.

**Risk:** No sandboxing. Hooks execute with full process environment access.

### 2.13 Smart Compaction Strategy

**Files:**
- `src/agent/compaction/smart-strategy.ts`

**Purpose:** Extends default compaction to protect injection messages, system reminders, and incomplete tool-call exchanges from being compacted away.

**Key fix applied:** Made default in `AgentConfig` to prevent goal/context loss during compaction.

### 2.14 Headless Mode

**Files:**
- `apps/kimi-code/src/headless/runner.ts`
- `apps/kimi-code/src/headless/watcher.ts`

**Purpose:** Non-interactive execution (`kimi -p "/goal ..."`). Supports fs.watch auto-run.

**Risk:** ENTIRELY UNTRACKED in git. Tight coupling to SDK session events and telemetry. Upstream event type changes could break silently.

### 2.15 Hierarchical Config Loader

**Files:**
- `src/config/hierarchical-loader.ts`

**Purpose:** Loads `SOUL.md` from global/project/subdirectory hierarchy.

**Risk:** UNTRACKED in git.

### 2.16 OMK MCP Server

**Files:**
- `scripts/omk-mcp/omk-project-server.cjs`

**Purpose:** Standalone MCP server exposing `.omk/memory/` graph state via stdio JSON-RPC.

**Risk:** No build-step dependency on upstream. Referenced by MCP config.

### 2.17 Agent Batch Tool

**Files:**
- `src/tools/builtin/collaboration/agent-batch.ts`

**Purpose:** Spawn 2-8 parallel subagents with aggregation strategies (concat/vote/best_of).

### 2.18 Code Execution Sandbox

**Files:**
- `src/tools/builtin/shell/execute-code.ts`

**Purpose:** Execute Python/JS in Docker sandbox.

### 2.19 Code Index

**Files:**
- `src/tools/builtin/code/build-code-index.ts`
- `src/tools/builtin/code/query-code-index.ts`

**Purpose:** Repository code indexing and querying.

### 2.20 Custom Profiles

**Files:**
- `src/profile/default/architect.yaml`
- `src/profile/default/reviewer.yaml`

**Purpose:** New agent profiles for specialized roles.

---

## 3. Recent Critical Fixes

### 3.1 Compaction Orphaned Tool Calls (Four-Layer Defense)

**Problem:** `Error: 400 tool_call_id ... is not found` after compaction.

**Fixes applied:**
1. **`trimTrailingOpenToolExchange` rewritten** — Walks backward from end of history, finds FIRST incomplete exchange anywhere (not just at end), truncates there.
2. **`beforeStep` calls `closeOpenToolExchanges`** — Before every LLM call, ensures no open exchanges exist.
3. **`applyCompaction` strips orphaned results** — Reconstructs history, builds set of kept tool call IDs, strips tool results whose assistant was compacted away, clears stale `pendingToolResultIds`.
4. **`FullCompaction` validates and logs** — Sends detailed compaction diagnostics to agent log for debugging.

**Files:** `projector.ts`, `context/index.ts`, `full.ts`, `turn-step.ts`

### 3.2 Plan Tracker Path Resolution

**Problem:** Plan file saved in session dir instead of workdir; not cleared after completion.

**Fix:** Dynamic `filePath` getter based on `agent.config.cwd`. `clear()` method called when all tasks done.

**Files:** `plan/tracker.ts`, `plan/index.ts`

### 3.3 Plan Mode Clarify Step

**Problem:** Plan mode would explore without clarifying ambiguous requests first.

**Fix:** Added explicit "Clarify" step as step 1 of plan mode workflow. Strengthened instructions to use AskUserQuestion before exploring when request is unclear.

**Files:** `injection/plan-mode.ts`

### 3.4 Goal System Refactor Merge

**Problem:** Upstream moved `session/goal.ts` → `agent/goal/index.ts`; fork had customizations on old location.

**Fix:** Resolved 16 merge conflicts, re-applied custom changes to new location. GoalMode now on Agent instead of Session.

### 3.5 Smart Compaction Default

**Problem:** Default compaction strategy would compact away injection messages and incomplete tool exchanges.

**Fix:** Changed `AgentConfig` default from `DefaultCompactionStrategy` to `SmartCompactionStrategy`.

---

## 4. Issues & Risks

### 4.1 Critical Risks

| Risk | Severity | Description |
|------|----------|-------------|
| **Untracked Files (14)** | HIGH | `headless/`, `memory-store.ts`, `checkpoint.ts`, `orchestration-hooks.ts`, `hierarchical-loader.ts`, `cost.ts`, `orchestration-panel.ts` are not in git. If lost, significant custom logic is gone. |
| **Headless Mode Untracked** | HIGH | `apps/kimi-code/src/headless/` is entirely untracked and tightly coupled to SDK events. Most likely victim of upstream breaking changes. |
| **Constructor Bloat** | MEDIUM | `Session` and `Agent` constructors carry 10+ new dependencies. Upstream refactors could break the fork. |
| **AgentRecords Replay Fragility** | MEDIUM | Replay throws if first record is not metadata. Corrupted/partial wire files fail hard rather than recovering. |

### 4.2 Medium Risks

| Risk | Severity | Description |
|------|----------|-------------|
| **God Class: KimiTUI** | MEDIUM | ~1900 LOC. Handles layout, session lifecycle, transcript, dialog, theme, signals, input history. |
| **Large Event Handler** | MEDIUM | `session-event-handler.ts` ~1060 LOC with giant switch. Single point of failure for all event routing. |
| **Goal Driver Loop Unbounded** | MEDIUM | `driveGoal` loops while goal active. Budget checks exist but model that never calls `complete` could loop until hard budget. |
| **Subagent Budget Cooperative** | MEDIUM | Token/time budgets checked between turns, not during LLM call. Single long turn can exceed budget. |
| **File Format Drift** | MEDIUM | New persisted files (`plan-tracker.json`, `entries.json`, task registry, file locks) in session dir. Upstream metadata changes may conflict. |
| **Tool Namespace Collision** | LOW-MED | ~20 new tool names. If upstream adds identical names, collisions occur. |
| **Compaction Retry Race** | LOW-MED | Retry logic mutates `compactedCount`. History mutation during compaction detected by reference equality — concurrent mutations could slip through. |

### 4.3 Minor Risks

| Risk | Severity | Description |
|------|----------|-------------|
| **MemoryStore Scoring Primitive** | LOW | Keyword-based, no embeddings. Could miss semantically related memories. |
| **HookEngine No Sandbox** | LOW | Shell commands with regex matching, full environment access. |
| **Native Module Hook Global** | LOW | `installNativeModuleHook()` patches `node:module._load` permanently. No uninstall function. |
| **MicroCompaction Experimental** | LOW | Disabled by default. If enabled, truncates old tool results aggressively. |
| **Background fd Download** | LOW | Fire-and-forget promise with no retry or user-visible failure path. |
| **Tight pi-tui Coupling** | LOW | `CustomEditor` casts to `AutocompleteInternals`; `normalizeCapsLockedCtrl` reaches into Kitty CSI sequences. |

---

## 5. Code Quality Assessment

### 5.1 Build & Test Status

| Package | Build | Tests | Notes |
|---------|-------|-------|-------|
| agent-core | PASS | 2547 pass, 1 skip | All quality gates pass |
| apps/kimi-code | PASS | Not run | Build completes (7.19 MB bundle) |
| node-sdk | PASS | Not run | Additive changes only |
| All others | PASS | Not run | Unmodified or lightly modified |

### 5.2 Type Safety

- TypeScript strict mode assumed
- `AgentOptions` has many new optional fields — upstream type changes could cascade
- Some `any` types exist in custom code (e.g., hook engine payload handling)

### 5.3 Test Coverage

- Custom features have tests: `learning-engine.test.ts`, `outcome-tracker.test.ts`, `plan-tracking-integration.test.ts`
- Compaction fixes have tests: `projector.test.ts` (8 tests), `full.test.ts` (44 tests)
- Headless mode: NO TESTS (untracked)
- Orchestration panel: NO TESTS (untracked)

---

## 6. Upstream Merge Status

### 6.1 What Was Absorbed

Upstream commits merged:
- `f2863af` — fix: keep login fallback prompt visible (#594)
- `0abde86` — fix(tui): clarify grouped subagent progress (#587)
- `f863127` — feat: custom color themes (#484)
- `d85dc0b` — feat: add Claude Codex import skill (#582)
- `7cb4a23` — fix: truncate queued messages to a single line (#586)

### 6.2 What Was Rejected/Modified

- Goal system: Upstream moved GoalMode to Agent; fork re-applied custom budget/hook logic
- Compaction: Upstream changes merged; fork added four-layer defense on top
- Plan mode: Upstream instructions merged; fork added Clarify step
- TUI: Upstream theme/customization changes merged cleanly

### 6.3 Merge Conflict Resolution

16 merge conflicts resolved. Key areas:
1. `agent/goal/index.ts` — moved from `session/goal.ts`, re-applied custom fields
2. `session/index.ts` — constructor ordering, new manager instantiation
3. `agent/index.ts` — `memoryStore` field added back (upstream removed it)
4. `agent/tool/index.ts` — custom tool registration ordering
5. `agent/turn/index.ts` — goal driver loop integration

---

## 7. Recommendations

### 7.1 Immediate Actions

1. **COMMIT UNTRACKED FILES NOW** — 14 untracked files represent core functionality:
   ```
   apps/kimi-code/src/headless/
   apps/kimi-code/src/tui/commands/cost.ts
   apps/kimi-code/src/tui/components/dialogs/orchestration-panel.ts
   packages/agent-core/src/agent/injection/memory.ts
   packages/agent-core/src/agent/injection/orchestration-skills.ts
   packages/agent-core/src/config/hierarchical-loader.ts
   packages/agent-core/src/session/checkpoint.ts
   packages/agent-core/src/session/memory-store.ts
   packages/agent-core/src/session/orchestration-hooks.ts
   packages/agent-core/src/tools/execute-code/
   ```

2. **Add headless mode tests** — Currently untested and most likely to break on upstream changes.

3. **Document persisted file schemas** — `plan-tracker.json`, `entries.json`, task registry, etc.

### 7.2 Short-term Improvements

4. **Wrap session managers behind interface** — Create `OrchestrationContext` interface to reduce `AgentOptions`/`Agent` constructor churn during upstream merges.

5. **Namespace custom tools** — Prefix with `Omk` (e.g., `OmkAgentBatch`, `OmkPlanTracker`) to avoid upstream collisions.

6. **Add bounded dedup in OrchestrationHooks** — Use LRU or max-size set instead of unbounded growth.

7. **Implement checkpoint plan restoration** — Complete the TODO in `SessionCheckpointManager`.

### 7.3 Long-term Architecture

8. **Extract KimiTUI into smaller controllers** — Dialog manager, theme controller, session lifecycle manager.

9. **Make SessionEventHandler modular** — Split the giant switch into per-event controller classes.

10. **Add semantic memory scoring** — Consider lightweight embeddings or BM25 instead of keyword scoring.

11. **Add explicit max-continuation bound to goal driver** — Beyond token/turn/time budgets, add a max-continuation-turns limit.

---

## 8. File Inventory

### 8.1 New Files (not in upstream)

| File | Lines | Purpose |
|------|-------|---------|
| `src/session/orchestration-hooks.ts` | ~200 | Event-to-skill mapping |
| `src/session/learning-engine.ts` | ~300 | Pattern detection & draft skills |
| `src/session/health-monitor.ts` | ~150 | Token burn rate & recommendations |
| `src/session/memory-store.ts` | ~120 | Cross-session memory retrieval |
| `src/session/checkpoint.ts` | ~180 | Session snapshot manager |
| `src/session/task-registry.ts` | ~250 | Persistent task queue |
| `src/session/cost-tracker.ts` | ~100 | Cost estimation |
| `src/session/subagent-cache.ts` | ~80 | Subagent result cache |
| `src/session/shared-store.ts` | ~60 | KV shared state |
| `src/session/message-bus.ts` | ~50 | Inter-agent pub/sub |
| `src/session/file-lock.ts` | ~80 | Cooperative file locks |
| `src/session/outcome-tracker.ts` | ~120 | Outcome tracking for learning |
| `src/agent/plan/tracker.ts` | ~300 | Structured plan state |
| `src/agent/injection/plan-tracker.ts` | ~80 | Plan tracker injection |
| `src/agent/injection/orchestration-skills.ts` | ~60 | Orchestration skill injection |
| `src/agent/injection/memory.ts` | ~80 | Memory injection |
| `src/agent/compaction/smart-strategy.ts` | ~150 | Smart compaction |
| `src/config/hierarchical-loader.ts` | ~100 | Hierarchical SOUL.md loading |
| `src/tools/builtin/collaboration/*.ts` | ~20 files | Collaboration tools |
| `src/tools/builtin/learning/*.ts` | ~4 files | Learning tools |
| `src/tools/builtin/planning/*.ts` | ~3 files | Planning tools |
| `src/tools/builtin/file/checkpoint.ts` | ~114 | Checkpoint tool |
| `src/tools/builtin/file/rollback.ts` | ~101 | Rollback tool |
| `src/tools/builtin/shell/execute-code.ts` | ~210 | Code execution sandbox |
| `src/tools/builtin/code/*.ts` | ~2 files | Code index tools |
| `apps/kimi-code/src/headless/*.ts` | ~2 files | Headless mode |
| `apps/kimi-code/src/tui/commands/cost.ts` | ~50 | /cost command |
| `apps/kimi-code/src/tui/components/dialogs/orchestration-panel.ts` | ~200 | Orchestration HUD |
| `scripts/omk-mcp/omk-project-server.cjs` | ~281 | MCP server |

### 8.2 Modified Files (vs upstream)

| File | Key Changes |
|------|-------------|
| `src/agent/index.ts` | Added `memoryStore`, `planTracker`, hooks, orchestration |
| `src/agent/context/index.ts` | Four-layer compaction safety, orphaned tool cleanup |
| `src/agent/context/projector.ts` | Rewrote `trimTrailingOpenToolExchange` |
| `src/agent/compaction/full.ts` | Validation logging, plan tracker append |
| `src/agent/compaction/strategy.ts` | SmartCompaction default |
| `src/agent/turn/index.ts` | Goal driver, budget checks, hooks |
| `src/agent/injection/manager.ts` | Added orchestration injector |
| `src/agent/injection/plan-mode.ts` | Clarify step |
| `src/agent/goal/index.ts` | Budget, hooks, wall-clock tracking |
| `src/agent/tool/index.ts` | ~20 new tool registrations |
| `src/session/index.ts` | 10+ new manager instantiations |
| `src/session/subagent-host.ts` | Budget enforcement, worktree, BTW mode |
| `src/tools/builtin/index.ts` | New tool exports |
| `apps/kimi-code/src/cli/commands.ts` | `--agent-file`, `--mcp-config-file` flags |
| `apps/kimi-code/src/tui/commands/status.ts` | /status command |
| `apps/kimi-code/src/tui/commands/loop.ts` | /loop command |
| `packages/node-sdk/src/sdk-rpc-client.ts` | `agentFile`, `mcpConfigFile` options |

---

## 9. Conclusion

The OMK fork is a substantial enhancement to kimi-code with a well-designed orchestration layer, learning system, and collaboration tools. The recent upstream merge (0.12.1+) was executed cleanly with 16 conflicts resolved. All quality gates pass.

**Biggest concern:** 14 untracked files including headless mode and core session managers. These must be committed to git immediately to prevent data loss.

**Second concern:** Constructor bloat in Session and Agent classes makes future upstream merges risky. An abstraction layer (e.g., `OrchestrationContext`) would reduce coupling.

**Strength:** The compaction safety net (four-layer defense against orphaned tool calls) is robust and well-tested. The plan tracker, goal system, and orchestration hooks work together effectively.

**Overall assessment:** Healthy fork with active development. Needs git hygiene and interface abstraction for long-term maintainability.
