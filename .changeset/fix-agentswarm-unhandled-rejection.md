---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Fix an unhandled promise rejection that could crash the CLI when a subagent provider returned an error during AgentSwarm execution.
