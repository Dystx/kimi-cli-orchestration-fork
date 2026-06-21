# Phase 12 — subagentId Plumbing for Tool Events — Design

## Status

Design approved. Ready for implementation planning.

## Goal

Close the documented Phase 11 gap: child-agent `tool.call.started` and `tool.result` events are emitted by `turn/index.ts` without `subagentId`, so `SwarmCoordinator`'s activity tracking cannot activate in production.

The fix: `subagent-host` subscribes to each spawned child's event stream and re-emits the two event types through `session.orchestrationHooks` stamped with `subagentId`. The Phase 11 coordinator handler picks them up unchanged.

## Non-goals

- Adding `subagentId` to non-tool events (`assistant.delta`, `thinking.delta`, `content.part`, etc.). Deferred to a future phase if needed.
- Refactoring `turn/index.ts` to emit differently.
- Coordinator subscription cleanup improvements.
- Cross-session memory of in-flight tool calls.

## Context

The architecture overview doc (Phase 9) explains the existing event flow:

- `child.emitEvent(event)` → `child.rpc.emitEvent(event)` (wire protocol)
- `session.orchestrationHooks.emit(event)` (in-process pipeline)
- `SwarmCoordinator` subscribes to orchestrationHooks

The two channels serve different consumers:
- Wire (RPC) goes to remote clients (kimi-code SDK, etc.).
- OrchestrationHooks stays in-process for orchestrators (SwarmCoordinator, plus Phase 5 / 9 listeners).

Phase 5 wired `subagent-host` to emit orchestrationHooks events for the **lifecycle** of a child (`subagent.spawned`, `subagent.started`, `subagent.suspended`, `subagent.completed`, `subagent.failed`, `subagent.cancelled`) — all stamped with `subagentId` because the host knows the child id.

Phase 11 added `SwarmCoordinator` handlers for `tool.call.started` / `tool.result`. Tests pass because the test harness fires events directly with `subagentId` set. In production, these events flow through the child's wire emit, never re-stamped, so the coordinator's tool handlers receive `subagentId: undefined` and silently drop.

Phase 12 closes the gap by having `subagent-host` subscribe to each child at spawn and re-emit the two tool events through orchestrationHooks with `subagentId` stamped.

## Architecture

```
Child turn emits tool event
  ↓
child.emitEvent({ type: 'tool.call.started', ... })
  ↓ (existing) child.rpc.emitEvent — wire path (no subagentId)
  ↓ (Phase 12) child event bus → subagent-host subscriber
  ↓
  re-emits as: this.session.orchestrationHooks.emit({
    type: 'tool.call.started',
    payload: { subagentId: childId, toolName, args, ... }
  })
  ↓
SwarmCoordinator.tool.call.started handler (Phase 11, unchanged)
  → updates currentToolCall on the matching member
```

The subagent-host already owns the `childId ↔ agent` mapping (it tracks it through `subagent.spawned` → `subagent.completed`). Subscribing at spawn and unsubscribing at completion fits the existing lifecycle.

## Components

### `packages/agent-core/src/session/subagent-host.ts` (modify)

Inside the existing spawn flow (where the host currently emits `subagent.spawned` via orchestrationHooks), add a subscription to the child's event bus. On each event:
- If the type is `tool.call.started` or `tool.result`, re-emit through orchestrationHooks with `{ subagentId, ...payload }`.
- Otherwise drop (lifecycle events are already handled separately).

Unsubscribe on child completion / failure / cancellation.

Cleanest plumbing: use the child's existing `emitEvent` path. Since `child.emitEvent` calls `child.rpc.emitEvent`, the host can't easily intercept without subscribing to the wire channel. Two practical approaches:

**Option A — Subscribe to the child's RPC event stream.** Each child has its own RPC client. The host can call `child.rpc.onEvent(...)` to receive every event the child emits. Filter for the two tool types, re-emit through orchestrationHooks. Symmetric with how Phase 5 added lifecycle subscriptions.

**Option B — Pass a per-child `onToolEvent` callback to the turn constructor.** More invasive; requires threading the callback through `turn/index.ts` and the loop.

Pick **Option A** — minimal blast radius.

### `packages/agent-core/test/session/subagent-host-tool-events.test.ts` (new)

Unit test:
- Build a `Session` mock with an `orchestrationHooks` that records all emissions.
- Spawn a child via `subagent-host.spawn(...)`.
- Fire a `tool.call.started` event on the child's RPC.
- Assert the orchestrationHooks received a `tool.call.started` event with `payload.subagentId` matching the child's id.
- Fire a `tool.result`.
- Assert the orchestrationHooks received a `tool.result` event with `subagentId` set.
- Fire a non-tool event (e.g. `assistant.delta`) — assert it is **not** re-emitted (lifecycle events are managed separately).
- Complete the child; assert the subscription was torn down.

### Cleanup

After Phase 12 lands:
- Remove the Phase 11 TODO comment in `coordinator.ts` (the `tool.call.started` handler now receives `subagentId` in production).
- Update the architecture overview doc: mark Phase 11's "Known gap" callout as resolved.

## Data flow

1. `subagent-host.spawn()` creates a child Agent with id `childId`. Existing lifecycle path: emit `subagent.spawned` via orchestrationHooks. **Phase 12 adds:** subscribe to `child.rpc.onEvent` and store the unsubscribe handle alongside `this.activeChildren.set(childId, agent)`.
2. Child turn emits `tool.call.started` via `child.emitEvent` → `child.rpc.emitEvent` → wire event delivered to RPC clients. **Phase 12 adds:** the host's subscriber also receives the event, filters by type, re-emits via `this.session.orchestrationHooks.emit({ type, payload: { subagentId: childId, ...eventFields } })`.
3. `SwarmCoordinator` subscriber (Phase 11) receives the orchestrationHooks event with `subagentId` set. Updates `currentToolCall` for the matching member.
4. On `subagent.completed` / `subagent.failed` / `subagent.cancelled`, the existing lifecycle path emits the terminal event. **Phase 12 adds:** call the unsubscribe handle stored in step 1, then delete it from the activeChildren map.
5. `subagent-host.dispose()` already iterates `this.activeChildren` and cancels; **Phase 12 adds:** unsubscribe all subscribers before clearing the map.

## Error handling

- Subscriber callbacks wrapped in try/catch (mirroring `OrchestrationHooks.emit`).
- Re-emit failures (orchestrationHooks absent) silently dropped.
- Double-unsubscribe (e.g. unsubscribe called twice) is safe — the child RPC's `onEvent` returns a no-op unsubscribe on second call.

## Testing

- Unit (new): `subagent-host-tool-events.test.ts` — covers steps 2-4 above.
- Regression: existing `subagent-host.test.ts`, `SwarmCoordinator` tests should pass without modification (Phase 11 already exercises the orchestrationHooks path).
- Smoke (manual): start a swarm in the TUI, watch activity appear in the live panel.

## Risks

| Risk | Mitigation |
|------|------------|
| Subscriber leak on child completion | Unsubscribe in the existing lifecycle handlers (completion / failure / cancel / dispose). |
| Double-re-emission if a different code path already stamps subagentId | Check `event.subagentId` before re-emitting; skip if already set. |
| Performance: per-tool-call re-emit overhead | Negligible — synchronous no-op when orchestrationHooks absent; single Map lookup + emit otherwise. |
| Tests that mock orchestrationHooks fire `tool.call.started` directly with `subagentId` already set | Coordinator's handler is idempotent (it just looks up the member). No regression risk. |

## Out of scope

- Adding `subagentId` to non-tool events.
- Changing `turn/index.ts`.
- Coordinator subscription improvements.

## Open questions

None for v1.