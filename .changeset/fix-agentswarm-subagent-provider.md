---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Stop forcing AgentSwarm subagents onto the kimi provider; subagents now inherit the parent agent's configured model like other subagent tools, so users on non-kimi providers no longer see a kimi OAuth/rate-limit error before their own provider is ever tried.
