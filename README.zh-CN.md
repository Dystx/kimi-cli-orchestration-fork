# Kimi CLI Orchestration Fork

> **Kimi Code CLI 的事件驱动编排层。** 这个 Fork 添加了自动技能注入、自适应提示和可配置的事件-技能映射 —— 让 Agent 根据会话中发生的事件自动调整行为。

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Tests](https://img.shields.io/badge/tests-2617%20passed-brightgreen)]() [![上游](https://img.shields.io/badge/上游-MoonshotAI%2Fkimi--code-blue)](https://github.com/MoonshotAI/kimi-code)

[文档](https://moonshotai.github.io/kimi-code/zh/) · [Issues](https://github.com/MoonshotAI/kimi-code/issues) · [English](README.md)

---

## 这个 Fork 添加了什么

上游的 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) 是一个运行在终端中的 AI 编程助手。**这个 Fork 添加了一个编排系统**，它会监视会话事件并自动将相关技能注入对话 —— 无需手动提示。

### 工作原理

当子 Agent 完成并带有代码差异时 → 注入 `code-review`。  
当任务完成时 → 注入 `quality-gate`。  
当健康状态下降时 → 注入 `troubleshooting`。  
当定时任务触发时 → 注入 `plan-first`。

全部通过 `config.toml` 配置。

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

### 特性

- **15 种事件类型** — `task.*`、`subagent.*`、`goal.*`、`health.degraded`、`cron.fired`、`hook.fired`、`mcp.failed`
- **6 种内置条件** — `hasDiff`、`isCodeTask`、`testFailure`、`runtimeError`、`goalActive`、`taskCountGt2`
- **优先级队列** — 数字越小优先级越高，相同优先级按 FIFO 处理
- **速率限制** — 按事件类型冷却，防止刷屏
- **去重** — 滚动窗口内相同事件会被抑制
- **重复抑制** — 技能在连续触发 `max_skill_repetition` 次后停止注入
- **效果追踪** — 记录每个技能的回合结果，学习哪些映射有效
- **自适应目标续行** — 将近期事件摘要附加到目标续行提示中
- **持久化** — 队列和历史通过 `orchestration.json` 在会话重启后恢复
- **记忆集成** — 效果洞察持久化到记忆存储，支持跨会话回忆

---

## 安装

与上游相同。无需 Node.js。

- **macOS 或 Linux**：

```sh
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

- **Homebrew (macOS/Linux)**：

```sh
brew install kimi-code
```

- **Windows (PowerShell)**：

```powershell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

然后运行：

```sh
kimi --version
```

## 快速开始

```sh
cd your-project
kimi
```

首次启动时，在 Kimi Code CLI 中输入 `/login`，选择 Kimi Code OAuth 或 Moonshot AI Open Platform API 密钥登录。

## 配置编排

添加到 `~/.kimi-code/config.toml`（全局）或 `.kimi-code/config.toml`（项目级）：

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

**事件：** `task.completed`、`task.failed`、`task.created`、`task.unblocked`、`subagent.completed`、`subagent.failed`、`subagent.started`、`goal.started`、`goal.completed`、`goal.blocked`、`goal.paused`、`health.degraded`、`cron.fired`、`hook.fired`、`mcp.failed`。

**条件：** `hasDiff`、`isCodeTask`、`testFailure`、`runtimeError`、`goalActive`、`taskCountGt2`。

## 上游功能

此 Fork 包含所有上游 Kimi Code CLI 功能：

- 二进制发行，零环境依赖
- 极速 TUI 启动
- 视频输入
- AI-native MCP 配置
- 丰富的插件生态
- 子 Agent 聚焦并行工作
- 生命周期 hooks
- 编辑器 / IDE 集成（ACP）

详情见[上游文档](https://moonshotai.github.io/kimi-code/zh/)。

## 开发

要求：Node.js ≥ 24.15.0，pnpm 10.33.0。

```sh
git clone https://github.com/Dystx/kimi-cli-orchestration-fork.git
cd kimi-cli-orchestration-fork
pnpm install
```

```sh
pnpm dev:cli    # 开发模式运行 CLI
pnpm test       # 运行测试
pnpm typecheck  # TypeScript 检查
pnpm lint       # oxlint
pnpm build      # 构建所有包
```

### 测试覆盖

- **2,617 个测试通过**，覆盖 181 个测试文件
- **20 个编排专属集成测试**，覆盖所有事件类型、持久化、速率限制、去重、技能注入和记忆集成

## 文档

- [快速上手](https://moonshotai.github.io/kimi-code/zh/guides/getting-started)
- [配置](https://moonshotai.github.io/kimi-code/zh/configuration/config-files)
- [命令参考](https://moonshotai.github.io/kimi-code/zh/reference/kimi-command)

## 社区

- [上游 Issues](https://github.com/MoonshotAI/kimi-code/issues)
- 安全漏洞见 [SECURITY.md](SECURITY.md)。

## 许可

基于 [MIT 许可证](LICENSE) 发布。
