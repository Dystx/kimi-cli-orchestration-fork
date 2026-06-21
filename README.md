# Kimi CLI — Orchestration Fork

> **Event-driven orchestration + live swarm visibility for [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code).** This fork adds an adaptive policy layer, a real-time swarm progress panel, a `/diag` diagnostics view, and minimax-backed web/image search — all layered on top of the upstream CLI without breaking its surface.

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Upstream](https://img.shields.io/badge/upstream-MoonshotAI%2Fkimi--code-blue)](https://github.com/MoonshotAI/kimi-code) [![Tests](https://img.shields.io/badge/tests-3,200%2B%20passed-brightgreen)]()
[Documentation](https://moonshotai.github.io/kimi-code/en/) · [Issues](https://github.com/MoonshotAI/kimi-code/issues) · [中文](README.zh-CN.md)

---

## What's in this fork

Twelve landed phases plus a search-provider stack, all on top of upstream Kimi Code CLI:

| Area | What you get |
|------|--------------|
| **Orchestration policies** | `Orchestrator` runs pluggable `OrchestrationPolicy` instances before each step. Built-ins include skill routing (auto-inject relevant skills), memory injection (surface prior notes), and plan tracking. Every policy exposes `recordError(name, error)` so its own failures stay observable. |
| **Live swarm panel** | When `AgentSwarmTool` runs, a `SwarmProgressController` mounts a panel that updates on every per-member state change + dispose. Each member shows its current tool call (e.g. `[read_file kimi-code/README.md]`) alongside its status icon. Auto-shows when a swarm starts, auto-hides when it ends. |
| **`/diag` diagnostics** | Slash command renders orchestrator-policy fire counts + last errors plus a recent-swarm-runs list. Reads `Session.getSwarmRunHistory()` and `Orchestrator.getDiagnostics()`. |
| **Memory MCP server** | Bundled MCP server ships four tools (`memory_read/write/search/delete`) plus a `MemoryPolicy` that auto-surfaces relevant notes into the conversation. Opt-in via `SessionOptions.enableMemoryMcpServer`. |
| **Skill routing** | `SkillRouter` scores the active skills against the user's prompt and pre-injects the best matches. Gated behind the `skill_routing` experimental flag. |
| **Search providers** | `minimax-web-search`, `minimax-image-search`, and a `chained-web-search` fallback composer. `web_search` builtin routes through the chain. Selected via config; falls back gracefully. |
| **Cross-cutting** | `Session.emitSwarmSnapshot` fires on every member transition, fans out as a typed `swarm.run.snapshot` event over the SDK RPC pipe, and is mirrored in the SDK's session-local cache so SDK consumers don't need a separate subscription. |

Everything upstream still works: single-binary distribution, MCP, plugins, subagents, hooks, ACP. None of this fork's APIs are invasive — `/diag` is opt-in, swarm panel is auto-managed, search providers fall back to upstream defaults if config is missing.

---

## Install

Same as upstream.

- **macOS / Linux**: `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`
- **Homebrew**: `brew install kimi-code`
- **Windows (PowerShell)**: `irm https://code.kimi.com/kimi-code/install.ps1 | iex`

Verify: `kimi --version`.

## Quick start

```sh
cd your-project
kimi
```

On first launch, run `/login` inside the TUI and choose Kimi Code OAuth or a Moonshot AI Open Platform API key.

Then try:

- `/status` — overall session status + orchestrator section.
- `/diag` — orchestrator policy diagnostics + recent swarm runs.
- Run a swarm (via the `agent_swarm` tool / `subagent` skill) and watch the live panel update.

## Configure

`~/.kimi-code/config.toml` (global) or `.kimi-code/config.toml` (project-level).

### Orchestration (opt-in)

```toml
[orchestration]
enabled = true

[[orchestration.mappings]]
event = "subagent.completed"
skill = "code-review"
condition = "hasDiff"
priority = 3
```

Mappings are stored as config; the `Orchestrator` reads them at session start. `event` is one of the lifecycle event types emitted by the agent core; `skill` names a skill under `~/.kimi/skills/`. Conditions are evaluated against the event payload.

### Memory MCP

`SessionOptions.enableMemoryMcpServer = true` opens the bundled memory server with `memory_read/write/search/delete`. The `MemoryPolicy` can also auto-inject relevant notes into prompts.

### Search providers

```toml
[search.web]
provider = "chained"   # primary → fallback on empty / error
primary  = "minimax"
fallback = "upstream"
```

The chain tries the primary first and only consumes the fallback when the primary returns no results or errors.

## Develop

Requirements: Node.js ≥ 24.15.0, pnpm 10.33.0.

```sh
git clone https://github.com/Dystx/kimi-cli-orchestration-fork.git
cd kimi-cli-orchestration-fork
pnpm install
```

```sh
pnpm dev:cli        # run the CLI in dev mode
pnpm test           # vitest
pnpm typecheck      # tsc --noEmit across all packages
pnpm lint           # oxlint
pnpm build          # build every package
```

### Project layout

```
apps/kimi-code/               # the CLI binary
packages/agent-core/          # Orchestrator, SwarmCoordinator, Session, MCP
packages/protocol/            # shared wire types (SwarmRunSnapshot, AgentEvent, etc.)
packages/node-sdk/            # the kimi-code-sdk SDK (consumed by kimi-code)
docs/superpowers/specs/       # design specs (one per phase)
docs/superpowers/plans/       # implementation plans
```

Phases 1–12 are documented individually under `docs/superpowers/specs/`; the architecture overview lives at `docs/superpowers/specs/2026-06-19-phase-9-architecture-design.md`.

## Test coverage

- 3,200+ tests across agent-core, node-sdk, and kimi-code.
- Integration tests cover orchestration policies (skill routing, memory injection, plan tracking), swarm coordinator (member lifecycle, snapshot emission, activity tracking), SDK plumbing (subscribe/active/history caches), and the search provider chain.

## Community

- [Upstream issues](https://github.com/MoonshotAI/kimi-code/issues) — report bugs against upstream first; this fork inherits its behavior except for the additions above.
- See [SECURITY.md](SECURITY.md) for vulnerability reporting.
- See [FORK_CHANGES.md](FORK_CHANGES.md) for the full diff summary vs upstream.

## License

MIT. See [LICENSE](LICENSE).