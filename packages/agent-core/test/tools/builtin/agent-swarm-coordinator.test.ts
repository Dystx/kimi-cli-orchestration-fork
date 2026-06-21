/**
 * Verifies that `AgentSwarmTool.execution` always pairs `swarmMode.enter()`
 * with a matching `swarmMode.exit()`:
 *   - on a successful run (exit must be called once),
 *   - when `subagentHost.spawn` rejects (exit must still run so we don't
 *     leak the active swarm-mode state into the next turn),
 *   - when `swarmMode.enter` itself throws (exit must NOT run because the
 *     tool never entered swarm mode in the first place).
 *
 * The third case guards the `entered` flag in `AgentSwarmTool.execution`:
 * the `finally` block only calls `swarmMode.exit()` if `enter()` actually
 * returned, otherwise a failing `enter` would leave the tool with a phantom
 * exit call.
 *
 * The mocks below mirror the production contract: `spawn` returns a
 * `SubagentHandle`, the coordinator subscribes to `subagent.completed`
 * through `orchestrationHooks.on` (the real hook contract from Phase 5),
 * and the spawn mock fires the matching `subagent.completed` event so the
 * coordinator's `awaitCompletion` promise resolves.
 */

import { describe, it, expect, vi } from 'vitest';

import { AgentSwarmTool } from '../../../src/tools/builtin/collaboration/agent-swarm';
import type { ExecutableToolContext, ExecutableToolResult } from '../../../src/loop';
import type { RunnableToolExecution } from '../../../src/loop/types';

function makeSession(): {
  orchestrationHooks: {
    on(event: string, handler: (e: unknown) => void): () => void;
    emit(event: string, payload: unknown): void;
  };
  log: { warn: ReturnType<typeof vi.fn> };
  recordSwarmRun: ReturnType<typeof vi.fn>;
} {
  // The session mock provides the surfaces the tool reaches for:
  // `orchestrationHooks.on` (the real hook contract — the coordinator
  // subscribes directly via `subscribe()` and registers its handlers in a
  // Map), `log.warn` (used by the coordinator on retry errors), and
  // `recordSwarmRun` (invoked from the coordinator's `onDispose` callback
  // so the session can capture the lifecycle summary). Because handlers are
  // retained in a Map and dispatched by `emit`, `spawn`-time `emit` calls
  // reach the coordinator — otherwise its members would stay in `spawned`
  // state and `awaitCompletion` would never settle.
  const handlers = new Map<string, Array<(e: unknown) => void>>();
  const orchestrationHooks = {
    on(event: string, handler: (e: unknown) => void): () => void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => undefined;
    },
    emit(event: string, payload: unknown): void {
      for (const h of handlers.get(event) ?? []) h(payload);
    },
  };
  return {
    orchestrationHooks,
    log: { warn: vi.fn() },
    recordSwarmRun: vi.fn(),
  };
}

function makeContext(toolCallId: string): ExecutableToolContext {
  return {
    turnId: 't',
    toolCallId,
    signal: new AbortController().signal,
  };
}

const validArgs = {
  description: 'd',
  prompt_template: '{{item}}',
  items: ['a', 'b'],
} as never;

describe('AgentSwarmTool + SwarmCoordinator lifecycle', () => {
  it('exits swarm mode even when spawn rejects', async () => {
    // No `orchestrationHooks.emit` is needed here — the spawn rejection
    // bubbles out of `runSwarm` before `registerMember`/`awaitCompletion`
    // ever run, so the coordinator stays empty. The outer try/catch in
    // `execution` converts the thrown error into a structured
    // `{ isError: true, output }` result and the inner finally still fires
    // `swarmMode.exit()`.
    const spawn = vi.fn().mockRejectedValue(new Error('host down'));
    const swarmMode = { enter: vi.fn(), exit: vi.fn() };
    const subagentHost = { spawn };
    const tool = new AgentSwarmTool(subagentHost as never, swarmMode as never, makeSession() as never);

    const result: ExecutableToolResult = await (tool.resolveExecution(validArgs) as RunnableToolExecution).execute(makeContext('call-1'));

    // The outer try/catch in `execution` converts thrown errors into a
    // structured `{ isError: true, output }` result, so the promise resolves
    // rather than rejecting. The error message should surface verbatim.
    expect(result.isError).toBe(true);
    expect(result.output).toBe('host down');
    expect(swarmMode.enter).toHaveBeenCalledTimes(1);
    expect(swarmMode.enter).toHaveBeenCalledWith('tool');
    // The whole point of the test: `spawn` threw, but `exit` still ran
    // because the inner `finally` is reached on the rejection path.
    expect(swarmMode.exit).toHaveBeenCalledTimes(1);
  });

  it('exits swarm mode on success', async () => {
    // Build a session whose `orchestrationHooks` retains its subscribers,
    // then have `spawn` fire `subagent.completed` after `runSwarm`'s
    // `registerMember` has had a chance to run. The cleanest way to order
    // "registerMember before emit" is to defer the emit one macrotask via
    // `setTimeout(..., 0)`: the spawn promise resolves first (so the
    // continuation runs registerMember + arms `awaitCompletion`), and only
    // then does the queued emit fire and flip the member to `completed`,
    // resolving the per-member promise so the loop proceeds to the next item.
    const session = makeSession();
    let counter = 0;
    const spawn = vi.fn().mockImplementation(() => {
      counter += 1;
      const agentId = `agent-${counter}`;
      setTimeout(() => {
        // Mirror the real `OrchestrationEvent` shape so the coordinator
        // reads `resultSummary` from `payload` rather than the
        // (always-undefined) top-level `result` field. The body content
        // flows through to the rendered XML via `m.result.result`.
        session.orchestrationHooks.emit('subagent.completed', {
          type: 'subagent.completed',
          payload: { subagentId: agentId, resultSummary: 'ok' },
        });
      }, 0);
      return Promise.resolve({
        agentId,
        profileName: 'coder',
        resumed: false,
        completion: Promise.resolve(),
      });
    });
    const swarmMode = { enter: vi.fn(), exit: vi.fn() };
    const subagentHost = { spawn };
    const tool = new AgentSwarmTool(subagentHost as never, swarmMode as never, session as never);

    const result: ExecutableToolResult = await (tool.resolveExecution(validArgs) as RunnableToolExecution).execute(makeContext('call-2'));

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('completed: 2');
    expect(swarmMode.enter).toHaveBeenCalledTimes(1);
    expect(swarmMode.enter).toHaveBeenCalledWith('tool');
    expect(swarmMode.exit).toHaveBeenCalledTimes(1);
  });

  it('does not call swarmMode.exit if swarmMode.enter threw', async () => {
    const spawn = vi.fn();
    const enterError = new Error('enter failed');
    const swarmMode = {
      enter: vi.fn(() => {
        throw enterError;
      }),
      exit: vi.fn(),
    };
    const subagentHost = { spawn };
    const tool = new AgentSwarmTool(subagentHost as never, swarmMode as never, makeSession() as never);

    const result: ExecutableToolResult = await (tool.resolveExecution(validArgs) as RunnableToolExecution).execute(makeContext('call-3'));

    // The thrown `enter` error is caught by the outer try/catch and reported
    // as a tool-level error, but the `entered` guard inside `execution` must
    // keep `exit` from being called when `enter` never succeeded.
    expect(result.isError).toBe(true);
    expect(result.output).toBe('enter failed');
    expect(swarmMode.enter).toHaveBeenCalledTimes(1);
    expect(swarmMode.exit).not.toHaveBeenCalled();
    // `spawn` should never have been reached because the tool bailed out
    // before constructing the swarm.
    expect(spawn).not.toHaveBeenCalled();
  });
});