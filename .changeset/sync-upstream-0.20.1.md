---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/protocol": patch
"@moonshot-ai/acp-adapter": patch
"@moonshot-ai/kimi-code-oauth": patch
"@moonshot-ai/kimi-telemetry": patch
"@moonshot-ai/server": patch
"@moonshot-ai/migration-legacy": patch
"@moonshot-ai/monorepo": patch
---

Sync fork to upstream v0.20.1.

Brings in upstream commits from 0.20.0 (`#1061` → release, plus 32 feature / fix / refactor PRs) and 0.20.1 (`#1124` → release, plus 3 patch commits): bearer-token auth and `--host` / `--allowed-host` opt-in for the server; the new `!` shell-mode prefix in the CLI; Ctrl+U / Ctrl+D paging in the task output viewer, Alt+S session-only model switch, ctrl+t todo expand, the `/plugins` tabbed-panel redesign, working-tip behind composing spinner; web: auto-grow composer + expandable editing, LaTeX math via KaTeX, inline edit-diffs in tool call cards, full accumulated subagent progress, copy button on user messages, plan-review card with plan body and approach choices; agent-core: `loadAgentsMdForRoots` now returns `{ content, warning }` so oversized AGENTS.md surfaces a visible warning rather than truncating silently, truncated skill descriptions are marked with an ellipsis, hooks can carry `cwd` and `env`, plugin session-start reminders are re-injected after `/reload`, the `session.cwd`-aware stdio MCP server path; CLI: `-c` shorthand for `--continue`, `update` alias for `upgrade`, third-party plugin install confirm, config hint in max-steps error, the cli spawn `EFTYPE` resolution for kimi web on Windows; plugin marketplace: Superpowers is now sourced from GitHub, installed plugins show update badges.

All fork-specific features are preserved — orchestrator runtime + `SkillRoutingPolicy`, swarm subagent plumbing + `subagentId` event stamping, MiniMax-M3 dual-channel think-tag strip, ACP adapter telemetry, `swarm.run.snapshot` event, `minimax-web-search` / `minimax-image-search` / `chained-web-search` providers, `Session.swarmRuns` registry, `MemoryStore` + `MemoryPolicy`, fork-specific `Persistent Memory` block in `system.md`.

**Skill routing is still off by default.** The `skill_routing` flag in `packages/agent-core/src/flags/registry.ts` continues to default to `false`; the policy short-circuits in `beforeStep` unless `KIMI_CODE_EXPERIMENTAL_SKILL_ROUTING=1` is set. The merge had zero structural impact on the orchestrator / `SkillRoutingPolicy` / `scoreSkills` code path. Regression coverage at `packages/agent-core/test/agent/skill-prompt.test.ts` and `packages/agent-core/test/agent/orchestrator/skill-router.test.ts` is unchanged.

The merge from upstream `b7dc001a` (`@moonshot-ai/kimi-code@0.20.1`) into the `0.20.1-fork-merge` branch had 8 conflict files, all resolved by taking upstream's structural change and re-applying the fork's additive delta. No `minor` bump — see `FORK_CHANGES.md` → "Tracking upstream" for the policy that keeps changesets at `patch` only.