# kimi-code Roadmap

> Gap analysis + implementation status, based on deep-dive of upstream Kimi Code architecture and competitor research (Claude Code, Aider, Roo Code, Cursor, Codex CLI, etc.). This fork ships the items marked **DONE** below; the rest remain open.

---

## Shipped in this fork

### Orchestration refactor (Phases 1–8)

The agent core gained an `Orchestrator` that runs pluggable `OrchestrationPolicy` instances before each step.

| Phase | Item |
|-------|------|
| 1 | `Orchestrator` core + `OrchestrationPolicy` interface |
| 2 | `MemoryStore` interface + 4 memory MCP tools + bundled MCP server |
| 3 | `SkillRouter` (auto-inject relevant skills based on prompt) |
| 4 | `SwarmCoordinator` (member lifecycle, guaranteed cleanup) |
| 5 | Real event channel via `orchestrationHooks` |
| 6 | Parallel batch dispatch in `AgentSwarmTool` |
| 7 | Event-driven completion (replace polling with promise resolution) |
| 8 | `Orchestrator.getDiagnostics()` + `/status` panel + `SkillActivationTrigger` widening |

### Swarm visibility (Phases 9–12)

| Phase | Item |
|-------|------|
| 9 | Architecture overview doc + `Session.swarmRuns` registry + `/diag` slash command + refactor cleanup |
| 10 | Real-time `SwarmProgressController` + `SwarmRunSnapshot` SDK plumbing |
| 11 | Per-member tool-call activity (`SwarmMemberToolCall`, `summarizeArgs`) |
| 12 | `subagent-host` re-emits child tool events stamped with `subagentId`; `SDKAgentAPI.onEvent` subscription |

### Search providers (WIP)

| Item | Status |
|------|--------|
| `minimax-web-search`, `minimax-image-search`, `chained-web-search` composer | Shipped |

### Upstream-aligned work

| Item | Status |
|------|--------|
| Continuous plan tracker (P0) | **DONE** — re-architected as `PlanTrackingPolicy` |
| Persistent cross-session memory (P2) | **DONE** — `MemoryStore` + `MemoryPolicy` |
| **Sync to upstream v0.19 (Phase 13)** | **DONE** — `0.19.0-fork-merge` branch. Resolved 30 conflict files / 48 markers, kept all fork-specific features (orchestrator, swarm subagent plumbing, MiniMax-M3 think-tag strip, ACP adapter telemetry). `skill_routing` is **off by default** to avoid the over-eager activation that matched skills on incidental token overlap. |
| **Sync to upstream v0.19.2 (Phase 14)** | **DONE** — `0.19.2-fork-merge` branch. Replayed the upstream `0.19.1` and `0.19.2` release commits on top of Phase 13. All fork-specific features preserved (orchestrator + SkillRouter code intact, swarm subagent plumbing, MiniMax-M3 think-tag strip, ACP adapter telemetry, `skill_routing` opt-in flag). |

---

### Known issues after the 0.19 sync

_None — all 8560 tests pass._

---

### Resolved after the 0.19 sync

The following issues were initially logged as known issues and have been fixed in subsequent commits on this branch:

- **`packages/agent-core/test/agent/compaction/full.test.ts > "keeps messages appended while compacting an unchanged prefix"`** — was timing out because the fork's WIP `runOnce` cancelled on any history length change, but the test appends a message mid-compaction. Resolution: distinguish destructive changes (length shrank, prefix mutated) from safe appends (length grew, prefix untouched). The cancellation now only fires on destructive changes, which matches upstream's contract.
- **`packages/agent-core/test/agent/compaction/full.test.ts > "continues a manual compaction run when the first pass still exceeds the trigger"`** — same root cause as above.
- **`SkillRouter` over-firing** — the flag defaulted to `true` and the scoring function required only one shared token, so skills would fire on prompts like `run lint` (matched every skill with "run" in its corpus) or `thanks` (matched anything mentioning `help`). Resolution: switch default to opt-in (`KIMI_CODE_EXPERIMENTAL_SKILL_ROUTING=1`), require at least two distinct shared tokens and a six-token minimum message length.

---

## Open items

### P1 — High impact

#### Checkpoint / Rollback

- **Problem**: No instant revert for bad edits. User must manually undo or rely on git.
- **Competitor patterns**: Claude Code `Esc-Esc` rollback, Aider `/undo` reverts last commit, Cursor "Restore Checkpoint" UI.
- **Approach**: file-level snapshots in `~/.kimi-code/checkpoints/{sessionId}/`, or git-auto-commit per turn. CLI: `/checkpoint` + `/rollback`.

#### Test / Lint Integration

- **Problem**: Agent cannot validate its own work in-loop.
- **Competitor patterns**: Aider `/test <cmd>` + `/lint <cmd>`, Cursor background cloud agents.
- **Approach**: Auto-detect project test runner + linter, run after edits, surface failures as injected events the orchestrator can route to a `quality-gate` skill.

### P2 — Medium impact

#### Repo Map

- **Problem**: Agent must read files individually or use Glob/Grep. Large codebases are expensive to explore.
- **Competitor patterns**: Aider's auto-built repo map (file names, top-level signatures, imports) with token budget; Claude Code's agentic codebase search.
- **Approach**: Background AST/ctags-based map generation, cached in session directory, injected as a summary or exposed as `GetRepoMap` tool.

#### Git-Native Workflows

- **Problem**: Changes are not auto-tracked.
- **Competitor patterns**: Aider auto-commits every change; Cursor branch-per-task.
- **Approach**: Configurable auto-commit hooks, branch-per-task workflow, git status injection.

### P3 — Architectural

#### Architect / Editor Split

- **Problem**: Single model does both planning and implementation. Complex refactors benefit from separation.
- **Competitor patterns**: Aider `--architect` (architect + editor models), Roo Code multi-mode.
- **Approach**: Multi-model config (`architect_model` vs `editor_model`), or specialized subagent roles for plan vs execute.

#### Parallel Subagent DAG

- **Problem**: The current `SwarmCoordinator` runs parallel but has no dependency DAG, file locks, or worktree isolation.
- **Competitor patterns**: Claude Code Agent Teams with shared task list; IOSM dependency DAGs + worktree isolation.
- **Approach**: Task queue with dependency resolution; worktree-based isolation per parallel subagent; parent coordinates via shared plan tracker.

### P3 — Operational

#### Cost Tracking

- **Problem**: No per-session or per-task cost awareness.
- **Competitor patterns**: AiderDesk per-task cost tracking; Claude Code usage telemetry.
- **Approach**: Expose usage in TUI (already partial via `UsagePanelComponent`), attribute costs to plan-tracker tasks, budget alerts.

### P4 — Speculative

#### Browser / Preview Control

- **Problem**: No way to preview frontend changes from the TUI.
- **Competitor patterns**: Claude Code "Claude in Chrome", Playwright MCP.
- **Approach**: MCP browser control + preview server detection.

---

## Deferred from the prior roadmap

These were on the original Phase 1-8 list and were either folded into the orchestration refactor or pushed back:

- **Continuous Plan Tracker** — folded into `PlanTrackingPolicy` (Phase 8).
- **Persistent Cross-Session Memory** — shipped via `MemoryStore` + `MemoryPolicy` (Phase 2).
- **Parallel Subagent Orchestration** — partial: parallel spawn works (Phase 6); dependency DAG and worktree isolation deferred to P3 above.

## Process

Each new feature still goes through:

1. **Brainstorm** (one-question-at-a-time clarification → design)
2. **Spec** (`docs/superpowers/specs/`)
3. **Plan** (`docs/superpowers/plans/`)
4. **Subagent-driven execution** (fresh subagent per task + two-stage review)
5. **Quality gates** (lint, typecheck, test, build)
6. **Merge to main** with no-ff commit message summarizing scope

Specs + plans live alongside the code, so the rationale for every change stays searchable.