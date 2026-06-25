---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Add an optional MiniMax web search backend alongside the existing Moonshot search. When `services.minimaxSearch` is set, kimi-code invokes the local `mavis` CLI to delegate the call to the matrix MCP search endpoint, so the daemon handles authentication. The default `WebSearch` tool tries Moonshot first and falls back to MiniMax on empty or error, and a dedicated `WebSearchMinimax` tool is also exposed for explicit use. Setting `services.minimaxImageSearch` exposes a `WebSearchImages` tool backed by the matrix MCP image search.
