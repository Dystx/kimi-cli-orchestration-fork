---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/protocol": patch
"@moonshot-ai/acp-adapter": patch
"@moonshot-ai/kimi-code-oauth": patch
"@moonshot-ai/kimi-telemetry": patch
---

Sync fork to upstream v0.19.2.

Brings in upstream commits from 0.19.1 (`#983` → release, `#995` → changelog) and 0.19.2 (`#997` → release): web workspace drag-reorder + collapsed-group localStorage persistence, plan-review sensitivity in yolo mode, the free-text "Other" option in question prompts, mid-history interrupted tool-call realignment on resume, workspace-local config read at ACP session start, large-file read perf improvement, and the TUI working-tip / Alt+S session-model-switch / ctrl+t todo-expand / Tab completion / running-bash-expand / `-c` continue shorthand fixes. All fork-specific features are preserved — orchestrator runtime + `SkillRoutingPolicy`, swarm subagent plumbing + `subagentId` event stamping, MiniMax-M3 dual-channel think-tag strip, ACP adapter telemetry, `swarm.run.snapshot` event, `minimax-web-search` / `minimax-image-search` / `chained-web-search` providers.

**Skill routing is now off by default.** The previous default was firing the orchestrator's `SkillRouter` on incidental token overlap, so skills activated even when the user's prompt had nothing to do with them (e.g. `run lint` activated every skill mentioning "run" or "lint"). The `skill_routing` flag in `packages/agent-core/src/flags/registry.ts` now defaults to `false`; the policy short-circuits in `beforeStep` unless `KIMI_CODE_EXPERIMENTAL_SKILL_ROUTING=1` is set in the environment. When enabled, the router still requires `minOverlap: 2` distinct shared tokens, `minMessageTokens: 6`, and a relative score ≥ 0.25. Regression coverage: `packages/agent-core/test/agent/skill-prompt.test.ts` and `packages/agent-core/test/agent/orchestrator/skill-router.test.ts`.

The merge from upstream `0bcd9843` (`@moonshot-ai/kimi-code@0.19.2`) into `0.19.0-fork-merge` had zero conflict markers; the fork's agent-core orchestrator directory and the kimi-code CLI/TUI delta were disjoint from upstream's web refactor + TUI polish in this window. No `major` bump — see `FORK_CHANGES.md` for the per-feature delta and `ROADMAP.md` Phase 14 for the integration notes.