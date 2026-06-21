# Kimi CLI — 编排分支

> **为 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) 提供事件驱动编排 + 实时 Swarm 可视化。** 本分支在上游 CLI 之上新增自适应策略层、实时 Swarm 进度面板、`/diag` 诊断视图，以及 minimax 提供的网页 / 图像搜索能力——所有扩展都不破坏上游接口。

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Upstream](https://img.shields.io/badge/upstream-MoonshotAI%2Fkimi--code-blue)](https://github.com/MoonshotAI/kimi-code) [![Tests](https://img.shields.io/badge/tests-3,200%2B%20passed-brightgreen)]()
[文档](https://moonshotai.github.io/kimi-code/zh/) · [问题反馈](https://github.com/MoonshotAI/kimi-code/issues) · [English](README.md)

---

## 本分支的新增内容

十二个已落地的阶段 + 一套搜索后端，全部基于上游 Kimi Code CLI：

| 模块 | 能力 |
|------|------|
| **编排策略** | `Orchestrator` 在每一步前运行可插拔的 `OrchestrationPolicy`。内置策略包括技能路由（自动注入相关技能）、记忆注入（浮出过往笔记）和计划追踪。每个策略都暴露 `recordError(name, error)`，使其自身失败可观测。 |
| **实时 Swarm 面板** | 当 `AgentSwarmTool` 运行时，`SwarmProgressController` 挂载一个面板，在每次成员状态变更 + 销毁时刷新。每个成员在状态图标旁显示其当前工具调用（例如 `[read_file kimi-code/README.md]`）。Swarm 启动时自动显示，结束时自动隐藏。 |
| **`/diag` 诊断** | 斜杠命令渲染编排策略触发次数 + 最近错误，以及最近的 swarm 运行记录。读取 `Session.getSwarmRunHistory()` 和 `Orchestrator.getDiagnostics()`。 |
| **Memory MCP 服务器** | 内置 MCP 服务器提供四个工具（`memory_read/write/search/delete`），加一个自动将相关笔记注入对话的 `MemoryPolicy`。通过 `SessionOptions.enableMemoryMcpServer` 启用。 |
| **技能路由** | `SkillRouter` 根据用户提示对活跃技能打分，并预先注入最佳匹配。受 `skill_routing` 实验性开关控制。 |
| **搜索后端** | `minimax-web-search`、`minimax-image-search`，以及一个 `chained-web-search` 回退编排器。`web_search` 内置工具走这条链。通过配置选择；缺失时优雅回退。 |
| **横切能力** | `Session.emitSwarmSnapshot` 在每次成员转换时触发，作为类型化的 `swarm.run.snapshot` 事件通过 SDK RPC 管道扇出，并在 SDK 的会话本地缓存中镜像，这样 SDK 消费者无需单独订阅。 |

所有上游能力均不受影响：单二进制分发、MCP、插件、子代理、钩子、ACP。本分支的 API 均非侵入式——`/diag` 是可选的，Swarm 面板自动管理，搜索后端在配置缺失时回退到上游默认值。

---

## 安装

与上游一致。

- **macOS / Linux**：`curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`
- **Homebrew**：`brew install kimi-code`
- **Windows (PowerShell)**：`irm https://code.kimi.com/kimi-code/install.ps1 | iex`

验证：`kimi --version`。

## 快速开始

```sh
cd your-project
kimi
```

首次启动时，在 TUI 内执行 `/login` 并选择 Kimi Code OAuth 或 Moonshot AI 开放平台 API Key。

然后试试：

- `/status` — 总会话状态 + 编排器小节。
- `/diag` — 编排策略诊断 + 最近 swarm 运行记录。
- 运行一个 swarm（通过 `agent_swarm` 工具 / `subagent` 技能）并观察实时面板更新。

## 配置

`~/.kimi-code/config.toml`（全局）或 `.kimi-code/config.toml`（项目级）。

### 编排（可选）

```toml
[orchestration]
enabled = true

[[orchestration.mappings]]
event = "subagent.completed"
skill = "code-review"
condition = "hasDiff"
priority = 3
```

映射以配置形式存储；`Orchestrator` 在会话启动时读取。`event` 是 agent-core 发射的生命周期事件类型之一；`skill` 命名 `~/.kimi/skills/` 下的技能。条件针对事件 payload 求值。

### Memory MCP

`SessionOptions.enableMemoryMcpServer = true` 开启内置记忆服务器，提供 `memory_read/write/search/delete`。`MemoryPolicy` 也可以自动将相关笔记注入提示。

### 搜索后端

```toml
[search.web]
provider = "chained"   # primary → fallback on empty / error
primary  = "minimax"
fallback = "upstream"
```

链式策略先尝试主后端，仅在主后端无结果或出错时使用回退。

## 开发

要求：Node.js ≥ 24.15.0，pnpm 10.33.0。

```sh
git clone https://github.com/Dystx/kimi-cli-orchestration-fork.git
cd kimi-cli-orchestration-fork
pnpm install
```

```sh
pnpm dev:cli        # 开发模式下运行 CLI
pnpm test           # vitest
pnpm typecheck      # 所有包执行 tsc --noEmit
pnpm lint           # oxlint
pnpm build          # 构建所有包
```

### 项目结构

```
apps/kimi-code/               # CLI 二进制
packages/agent-core/          # Orchestrator、SwarmCoordinator、Session、MCP
packages/protocol/            # 共享线协议类型（SwarmRunSnapshot、AgentEvent 等）
packages/node-sdk/            # kimi-code-sdk SDK（被 kimi-code 消费）
docs/superpowers/specs/       # 各阶段设计规格
docs/superpowers/plans/       # 实施计划
```

阶段 1–12 在 `docs/superpowers/specs/` 下分别记录；架构总览位于 `docs/superpowers/specs/2026-06-19-phase-9-architecture-design.md`。

## 测试覆盖

- 跨 agent-core、node-sdk、kimi-code 共 3,200+ 测试。
- 集成测试覆盖编排策略（技能路由、记忆注入、计划追踪）、swarm coordinator（成员生命周期、快照发射、活动追踪）、SDK 管道（subscribe/active/history 缓存）以及搜索后端链。

## 社区

- [上游问题](https://github.com/MoonshotAI/kimi-code/issues) — 请先针对上游报告 Bug；除上述新增外本分支沿用其行为。
- 漏洞报告参见 [SECURITY.md](SECURITY.md)。
- 与上游的完整差异参见 [FORK_CHANGES.md](FORK_CHANGES.md)。

## 许可证

MIT。参见 [LICENSE](LICENSE)。