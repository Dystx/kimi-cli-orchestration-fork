# Kimi CLI Orchestration Fork

> **An event-driven orchestration layer for Kimi Code CLI.** This fork adds automatic skill injection, adaptive prompts, and configurable event-to-skill mappings — so your agent adapts its behavior based on what happens in the session.

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Tests](https://img.shields.io/badge/tests-2617%20passed-brightgreen)]() [![Upstream](https://img.shields.io/badge/upstream-MoonshotAI%2Fkimi--code-blue)](https://github.com/MoonshotAI/kimi-code)

[Documentation](https://moonshotai.github.io/kimi-code/en/) · [Issues](https://github.com/MoonshotAI/kimi-code/issues) · [中文](README.zh-CN.md)

---

## What this fork adds

The upstream [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) is an AI coding agent that runs in your terminal. **This fork adds an orchestration system** that watches session events and automatically injects relevant skills into the conversation — no manual prompting required.

### How it works

When a subagent finishes with a diff → inject `code-review`.  
When a task completes → inject `quality-gate`.  
When health degrades → inject `troubleshooting`.  
When a cron job fires → inject `plan-first`.

All configurable via `config.toml`.

```toml
[orchestration]
enabled = true
max_queue_size = 50
max_injection_size = 4000
cooldown_ms = 300000
max_skill_repetition = 3

[[orchestration.mappings]]
event = "subagent.completed"
skill = "code-review"
condition = "hasDiff"
priority = 3

[[orchestration.mappings]]
event = "task.completed"
skill = "quality-gate"
condition = "isCodeTask"
priority = 2

[[orchestration.mappings]]
event = "health.degraded"
skill = "troubleshooting"
priority = 0
```

### Features

- **15 event types** — `task.*`, `subagent.*`, `goal.*`, `health.degraded`, `cron.fired`, `hook.fired`, `mcp.failed`
- **6 built-in conditions** — `hasDiff`, `isCodeTask`, `testFailure`, `runtimeError`, `goalActive`, `taskCountGt2`
- **Priority queue** — lower number = higher priority, FIFO within same priority
- **Rate limiting** — cooldown per event type prevents spam
- **Deduplication** — identical events are suppressed within a rolling window
- **Repetition suppression** — skills stop injecting after `max_skill_repetition` consecutive triggers
- **Effectiveness tracking** — records turn outcomes per skill to learn which mappings work
- **Adaptive goal continuation** — recent events are summarized and appended to goal continuation prompts
- **Persistence** — queue and history survive session restarts via `orchestration.json`
- **Memory integration** — effectiveness insights are persisted to the memory store for cross-session recall

---

## Install

Same as upstream. No Node.js required.

- **macOS or Linux**:

```sh
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

- **Homebrew (macOS/Linux)**:

```sh
brew install kimi-code
```

- **Windows (PowerShell)**:

```powershell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

Then run:

```sh
kimi --version
```

## Quick Start

```sh
cd your-project
kimi
```

On first launch, run `/login` inside Kimi Code CLI and choose either Kimi Code OAuth or a Moonshot AI Open Platform API key.

## Configure orchestration

Add to `~/.kimi-code/config.toml` (global) or `.kimi-code/config.toml` (project-level):

```toml
[orchestration]
enabled = true
max_queue_size = 50
max_injection_size = 4000
cooldown_ms = 300000
max_skill_repetition = 3

[[orchestration.mappings]]
event = "subagent.completed"
skill = "code-review"
condition = "hasDiff"
priority = 3

[[orchestration.mappings]]
event = "task.completed"
skill = "quality-gate"
condition = "isCodeTask"
priority = 2

[[orchestration.mappings]]
event = "goal.started"
skill = "plan-first"
condition = "taskCountGt2"
priority = 1

[[orchestration.mappings]]
event = "health.degraded"
skill = "troubleshooting"
priority = 0

[[orchestration.mappings]]
event = "subagent.completed"
skill = "evidence-contract"
condition = "hasDiff"
priority = 3

[[orchestration.mappings]]
event = "goal.blocked"
skill = "test-debug-loop"
condition = "testFailure"
priority = 0

[[orchestration.mappings]]
event = "goal.paused"
skill = "troubleshooting"
condition = "runtimeError"
priority = 0

[[orchestration.mappings]]
event = "task.created"
skill = "plan-first"
condition = "taskCountGt2"
priority = 1
```

**Events:** `task.completed`, `task.failed`, `task.created`, `task.unblocked`, `subagent.completed`, `subagent.failed`, `subagent.started`, `goal.started`, `goal.completed`, `goal.blocked`, `goal.paused`, `health.degraded`, `cron.fired`, `hook.fired`, `mcp.failed`.

**Conditions:** `hasDiff`, `isCodeTask`, `testFailure`, `runtimeError`, `goalActive`, `taskCountGt2`.

## Upstream features

This fork includes all upstream Kimi Code CLI features:

- Single-binary distribution
- Blazing-fast TUI startup
- Video input
- AI-native MCP configuration
- Rich plugin ecosystem
- Subagents for focused, parallel work
- Lifecycle hooks
- Editor & IDE integration (ACP)

See [upstream documentation](https://moonshotai.github.io/kimi-code/en/) for details.

## Develop

Requirements: Node.js ≥ 24.15.0, pnpm 10.33.0.

```sh
git clone https://github.com/Dystx/kimi-cli-orchestration-fork.git
cd kimi-cli-orchestration-fork
pnpm install
```

```sh
pnpm dev:cli    # run the CLI in dev mode
pnpm test       # run tests
pnpm typecheck  # TypeScript check
pnpm lint       # oxlint
pnpm build      # build all packages
```

### Test coverage

- **2,617 tests passing** across 181 test files
- **20 orchestration-specific integration tests** covering all event types, persistence, rate-limiting, dedup, skill injection, and memory integration

## Docs

- [Getting Started](https://moonshotai.github.io/kimi-code/en/guides/getting-started)
- [Configuration](https://moonshotai.github.io/kimi-code/en/configuration/config-files)
- [Command reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-command)

## Community

- [Upstream issues](https://github.com/MoonshotAI/kimi-code/issues)
- For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## License

Released under the [MIT License](LICENSE).
