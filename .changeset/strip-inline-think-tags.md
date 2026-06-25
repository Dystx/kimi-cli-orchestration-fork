---
"@moonshot-ai/kosong": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Strip inline `<think>...</think>` reasoning tags out of OpenAI-compatible chat responses. Some providers (notably MiniMax-M3) ship their chain-of-thought inline inside the regular `content` field as `<think>...</think>` blocks instead of routing it through a dedicated `reasoning_content` field. The OpenAI legacy provider now recognises those tags and routes the reasoning to `ThinkPart` so the harness can render it as hidden reasoning rather than leaking the literal `<think>` text into the visible reply. Works in both the streaming and non-stream response paths, and carries state across SSE chunks so a tag split mid-token is still recognised.