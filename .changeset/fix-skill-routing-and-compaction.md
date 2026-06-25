---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Make `skill_routing` opt-in instead of opt-out, and tighten the router's scoring guards.

The `skill_routing` flag now defaults to `false`; enable it with `KIMI_CODE_EXPERIMENTAL_SKILL_ROUTING=1`. The previous default (`true`) caused the router to fire skills on prompts as short as `run lint` because a single shared token was enough to qualify. The router now requires:

- The user message has at least 6 tokens (was: no minimum).
- The skill's corpus shares at least 2 distinct tokens with the message (was: 1).

The same thresholds are exposed as `SkillRouterOptions.minMessageTokens` and `SkillRouterOptions.minOverlap` for callers that want different defaults.

`packages/agent-core/src/agent/compaction/full.ts`: the WIP branch's compaction round cancelled whenever history grew during the round (e.g. a tool result or user message arriving mid-compaction). Upstream's contract is to apply the compaction regardless when the prefix is untouched; cancellation should only fire when the prefix is destructively mutated (length shrank, or any existing position changed). The fork's cancellation now distinguishes the two cases, restoring upstream's behaviour and unblocking the two `compaction/full.test.ts` timeouts.