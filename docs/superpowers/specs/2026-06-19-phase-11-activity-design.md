# Phase 11 — Per-Member Tool-Call Activity — Design

## Status

Design approved. Ready for implementation planning.

## Goal

Extend the live swarm progress panel (Phase 10) to show each member's current tool call: tool name + the most informative single argument (file path, command, URL). On tool completion the activity clears.

This closes the deferred Phase 10 follow-up ("per-member tool-call activity") and gives users visibility into what their agents are actually doing during a swarm run.

## Non-goals

- Multiple concurrent tool calls per member (only the most recent is shown).
- Tool-specific custom rendering (e.g. inline file previews, shell output).
- Persisting activity across sessions.
- Aggregating member output into a final synthesis message.

## Context

Phase 10 shipped `SwarmRunSnapshot` with `SwarmMemberSnapshot[]` showing only member status (queued/running/completed/failed/cancelled). The panel renders this status next to the member name. Users can see the member is busy, but not what it's doing.

The event channel already streams `tool.call.started` and `tool.result` events keyed by `subagentId`. Swarm members are spawned subagents, so the link between subagentId and memberId exists once we track it on `subagent.spawned`.

## Architecture

Three layers, one data path:

```
Subagent calls tool
  ↓
orchestrationHooks.emit('tool.call.started', { subagentId, toolName, args })
  ↓
SwarmCoordinator (agent-core) receives the event
  ↓
  memberId = memberBySubagentId.get(subagentId)
  if memberId is undefined: drop (non-swarm agent)
  else: member.currentToolCall = { toolName, argsSummary }, emit snapshot
  ↓
SDK Session.subscribeSwarmRuns cb receives snapshot
  ↓
TUI SwarmProgressController.handleEvent stores snapshot; UsagePanelComponent
  re-renders via buildLines callback with activity included
```

The same channel handles `tool.result` (clear activity) and `subagent.spawned` (record memberId → subagentId mapping).

## Components

### 1. `packages/protocol/src/swarm.ts` — extend `SwarmMemberSnapshot`

```typescript
export interface SwarmMemberToolCall {
  readonly toolName: string;
  /** Best-effort single-argument summary (last path segment, first command token, etc.). */
  readonly argsSummary?: string;
}

export interface SwarmMemberSnapshot {
  // ... existing fields ...
  readonly currentToolCall?: SwarmMemberToolCall;
}
```

### 2. `packages/agent-core/src/agent/swarm/coordinator.ts`

Extend the coordinator:

```typescript
private readonly memberBySubagentId = new Map<string, string>();

private subscribe(): void {
  // ... existing subagent.* handlers ...

  const onSubagentSpawned = (event: SubagentSpawnedEvent) => {
    if (event.specName !== undefined) {
      const memberId = this.specBySpawnName.get(event.specName);
      if (memberId !== undefined) {
        this.memberBySubagentId.set(event.subagentId, memberId);
      }
    }
    // Or: parse the toolName from event to extract member id if known
    this.emitSnapshot();
  };

  const onToolCallStarted = (event: ToolCallStartedEvent) => {
    const memberId = this.memberBySubagentId.get(event.subagentId);
    if (memberId === undefined) return; // not a swarm member
    const member = this.members.get(memberId);
    if (member === undefined) return;
    member.currentToolCall = {
      toolName: event.toolName,
      argsSummary: summarizeArgs(event.toolName, event.args),
    };
    this.emitSnapshot();
  };

  const onToolResult = (event: ToolResultEvent) => {
    const memberId = this.memberBySubagentId.get(event.subagentId);
    if (memberId === undefined) return;
    const member = this.members.get(memberId);
    if (member === undefined) return;
    if (member.currentToolCall !== undefined) {
      member.currentToolCall = undefined;
      this.emitSnapshot();
    }
  };

  // Wire all three to orchestrationHooks.on(event, handler)
}
```

The `summarizeArgs` helper extracts the most informative single argument:

```typescript
function summarizeArgs(toolName: string, args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  // File-system tools: file_path / path
  for (const key of ['file_path', 'path']) {
    const v = record[key];
    if (typeof v === 'string') return shortenPath(v);
  }
  // Shell tools: command
  if (typeof record['command'] === 'string') return truncate(record['command'], 48);
  // Generic URL: url
  if (typeof record['url'] === 'string') return truncate(record['url'], 48);
  // Generic first string value
  for (const v of Object.values(record)) {
    if (typeof v === 'string') return truncate(v, 48);
  }
  return undefined;
}

function shortenPath(p: string): string {
  const parts = p.split('/');
  return parts.length <= 1 ? p : parts.slice(-2).join('/');  // keep parent/file
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
```

### 3. `packages/agent-core/test/agent/swarm/coordinator-activity.test.ts`

New unit tests:
- Coordinator sets `currentToolCall` on `tool.call.started` for tracked member.
- Coordinator clears `currentToolCall` on `tool.result`.
- Tool events for unknown subagentId are no-ops.
- `summarizeArgs` returns the expected summary for each tool type.
- Snapshot reflects the updated `currentToolCall`.

### 4. `apps/kimi-code/src/tui/components/messages/swarm-progress.tsx` — render activity

Extend `SwarmProgressMessage`:

```typescript
export function SwarmProgressMessage({ snapshot }: { snapshot: SwarmRunSnapshot }): string[] {
  const lines: string[] = [
    chalk.bold(`Swarm ${snapshot.runId}`),
    ` ${snapshot.totals.completed}/${snapshot.memberCount} done · ...`,
  ];
  for (const m of snapshot.members) {
    const detail = m.errorMessage !== undefined ? ` — ${m.errorMessage}` : '';
    const activity = m.currentToolCall !== undefined
      ? chalk.dim(` [${m.currentToolCall.toolName}${m.currentToolCall.argsSummary !== undefined ? ` ${m.currentToolCall.argsSummary}` : ''}]`)
      : '';
    lines.push(colorizeForStatus(m.status, `  ${STATUS_ICON[m.status]} ${m.memberId}${detail}`) + activity);
  }
  return lines;
}
```

No controller changes — the snapshot carries the activity; the existing `buildLines` callback re-runs on every snapshot.

## Data flow

1. `AgentSwarmTool.runSwarm` spawns a member → `subagent.spawned` event with `subagentId`. Coordinator records `memberBySubagentId.set(subagentId, memberId)`. Snapshot emits.
2. Member calls `read_file({file_path: '/Users/cheng/kimi-code/README.md'})` → `tool.call.started`. Coordinator sets `currentToolCall = { toolName: 'read_file', argsSummary: 'kimi-code/README.md' }`. Snapshot emits.
3. SDK `subscribeSwarmRuns` cb receives snapshot. TUI `SwarmProgressController` re-renders panel. `UsagePanelComponent.invalidate()` runs `buildLines` → panel shows `[read_file kimi-code/README.md]` next to the member.
4. Tool returns → `tool.result`. Coordinator clears `currentToolCall`. Snapshot emits (with `currentToolCall: undefined`). Panel re-renders without the activity.
5. Swarm ends → `coordinator.dispose()` emits final snapshot. Panel unmounts.

## Error handling

- Tool events for unknown subagentId: drop silently (not a swarm member).
- `summarizeArgs` returns `undefined` for non-object or empty args; component renders bare `[toolName]`.
- Malformed event payload: try/catch around `summarizeArgs`; fall through to `undefined`.

## Testing

- Unit (agent-core): `coordinator-activity.test.ts` covering the four scenarios above plus summarizeArgs variants.
- Unit (agent-core): existing `coordinator-snapshot.test.ts` should still pass (no regression).
- TUI: existing `swarm-progress.tsx` manual smoke (panel renders with + without activity).
- Build: typecheck + build should pass.

## Risks

| Risk | Mitigation |
|------|------------|
| Multiple events per tool call (delta) | Only `tool.call.started` and `tool.result` are tracked. `tool.call.delta` ignored. |
| `summarizeArgs` is heuristic | Documented as best-effort; tool-specific rendering is a future phase. |
| Member spawn event shape varies | Coordinator only records mapping if it can derive a memberId; otherwise the member will silently never get activity updates (acceptable for v1). |
| Activity may flash during fast tool calls | Re-render storm is bounded by tool call rate (~1/sec in practice). |

## Out of scope

- Multi-tool-per-member queue.
- Custom rendering per tool type.
- Cross-session activity history.

## Open questions

None for v1.