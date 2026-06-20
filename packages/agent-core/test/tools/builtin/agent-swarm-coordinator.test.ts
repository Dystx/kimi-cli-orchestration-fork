/**
 * Verifies that `AgentSwarmTool.execution` always pairs `swarmMode.enter()`
 * with a matching `swarmMode.exit()`:
 *   - on a successful run (exit must be called once),
 *   - when the underlying `subagentHost.runQueued` rejects (exit must still
 *     run so we don't leak the active swarm-mode state into the next turn),
 *   - when `swarmMode.enter` itself throws (exit must NOT run because the
 *     tool never entered swarm mode in the first place).
 *
 * The third case guards the `entered` flag in `AgentSwarmTool.execution`:
 * the `finally` block only calls `swarmMode.exit()` if `enter()` actually
 * returned, otherwise a failing `enter` would leave the tool with a phantom
 * exit call.
 */

import { describe, it, expect, vi } from 'vitest';

import { AgentSwarmTool } from '../../../src/tools/builtin/collaboration/agent-swarm';
import type { ExecutableToolContext, ExecutableToolResult } from '../../../src/loop';

function makeSession() {
  // The session mock needs the two surfaces the tool reaches for:
  // `orchestrationHooks.on` (wrapped by the SwarmCoordinator subscription
  // shim) and `log.warn` (used by the coordinator on retry errors). The
  // shim returns a no-op unsubscribe so the coordinator can be constructed
  // and disposed without touching a real event bus.
  return {
    orchestrationHooks: {
      on: vi.fn(() => () => undefined),
    },
    log: { warn: vi.fn() },
  } as never;
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
  it('exits swarm mode even when runQueued rejects', async () => {
    const runQueued = vi.fn().mockRejectedValue(new Error('host down'));
    const swarmMode = { enter: vi.fn(), exit: vi.fn() } as never;
    const subagentHost = { runQueued } as never;
    const tool = new AgentSwarmTool(subagentHost, swarmMode, makeSession());

    const result: ExecutableToolResult = await tool
      .resolveExecution(validArgs)
      .execute(makeContext('call-1'));

    // The outer try/catch in `execution` converts thrown errors into a
    // structured `{ isError: true, output }` result, so the promise resolves
    // rather than rejecting. The error message should surface verbatim.
    expect(result.isError).toBe(true);
    expect(result.output).toBe('host down');
    expect(swarmMode.enter).toHaveBeenCalledTimes(1);
    expect(swarmMode.enter).toHaveBeenCalledWith('tool');
    // The whole point of the test: `runQueued` threw, but `exit` still ran
    // because the inner `finally` is reached on the rejection path.
    expect(swarmMode.exit).toHaveBeenCalledTimes(1);
  });

  it('exits swarm mode on success', async () => {
    const runQueued = vi.fn().mockResolvedValue([
      {
        task: {
          kind: 'spawn',
          data: { kind: 'spawn', index: 1, item: 'a', prompt: 'a' },
        },
        agentId: 'agent-1',
        status: 'completed',
        result: 'ok a',
      },
      {
        task: {
          kind: 'spawn',
          data: { kind: 'spawn', index: 2, item: 'b', prompt: 'b' },
        },
        agentId: 'agent-2',
        status: 'completed',
        result: 'ok b',
      },
    ]);
    const swarmMode = { enter: vi.fn(), exit: vi.fn() } as never;
    const subagentHost = { runQueued } as never;
    const tool = new AgentSwarmTool(subagentHost, swarmMode, makeSession());

    const result: ExecutableToolResult = await tool
      .resolveExecution(validArgs)
      .execute(makeContext('call-2'));

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('completed: 2');
    expect(swarmMode.enter).toHaveBeenCalledTimes(1);
    expect(swarmMode.enter).toHaveBeenCalledWith('tool');
    expect(swarmMode.exit).toHaveBeenCalledTimes(1);
  });

  it('does not call swarmMode.exit if swarmMode.enter threw', async () => {
    const runQueued = vi.fn();
    const enterError = new Error('enter failed');
    const swarmMode = {
      enter: vi.fn(() => {
        throw enterError;
      }),
      exit: vi.fn(),
    } as never;
    const subagentHost = { runQueued } as never;
    const tool = new AgentSwarmTool(subagentHost, swarmMode, makeSession());

    const result: ExecutableToolResult = await tool
      .resolveExecution(validArgs)
      .execute(makeContext('call-3'));

    // The thrown `enter` error is caught by the outer try/catch and reported
    // as a tool-level error, but the `entered` guard inside `execution` must
    // keep `exit` from being called when `enter` never succeeded.
    expect(result.isError).toBe(true);
    expect(result.output).toBe('enter failed');
    expect(swarmMode.enter).toHaveBeenCalledTimes(1);
    expect(swarmMode.exit).not.toHaveBeenCalled();
    // `runQueued` should never have been reached because the tool bailed out
    // before constructing the swarm.
    expect(runQueued).not.toHaveBeenCalled();
  });
});
