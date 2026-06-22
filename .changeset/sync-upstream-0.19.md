---
"@moonshot-ai/agent-core": minor
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kosong": minor
"@moonshot-ai/node-sdk": minor
"@moonshot-ai/protocol": minor
"@moonshot-ai/acp-adapter": minor
"@moonshot-ai/oauth": minor
"@moonshot-ai/telemetry": minor
---

Sync with upstream MoonshotAI/kimi-code v0.19. Brings the fork up to date with 92 upstream commits while preserving all fork-specific features (Orchestrator + SkillRouter, swarm subagent plumbing, MiniMax-M3 think-tag strip, ACP adapter telemetry, `swarm.run.snapshot` event, `skill_routing` flag enabled by default).

Notable upstream additions adopted in this sync:

- **apps/vis refactor**: storage consolidation, sidebar unread dots synced across browser tabs, fast disk-based snapshot reader.
- **TUI**: detach foreground subagents to background with Ctrl+B.
- **agent-core**: workspace `--add-dir` support, unify image-extension sniff-failed detection, additional workspace dirs in system prompt.
- **protocol**: `prompt.submitted` event, worktree support, timeouts on shell tool calls.
- **node-sdk**: telemetry `sessionStartedProperties`, sharper public types.
- **apps/vis/web**: new thin-dispatcher + `renderers.tsx` registry for `WireHeadline` / `WireRowDetail`. The fork adopts this architecture (per-kind renderers live in `renderers.tsx` now).

The merge resolved 30 conflict files / 48 conflict markers. Two `packages/agent-core/test/agent/compaction/full.test.ts` cases ("keeps messages appended while compacting an unchanged prefix" and "continues a manual compaction run when the first pass still exceeds the trigger") time out on this branch; the WIP retry path inside `runOnce` fires `triggerPostCompactHook` and `injectGoal` in an order the snapshot doesn't expect. Documented as known issues for follow-up; everything else (8542 tests) passes.