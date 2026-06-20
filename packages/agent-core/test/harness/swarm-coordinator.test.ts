import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import type { SessionSubagentHost } from '../../src/session/subagent-host';
import { testAgent } from '../agent/harness/agent';

/**
 * Integration coverage for `AgentSwarmTool` running through the full
 * `testAgent` harness. The valuable property under test is that
 * `SwarmMode.isActive` returns to `false` after the swarm's tool call
 * finishes — both when a real `AgentSwarm` invocation happens and when a
 * normal text-only turn runs without ever touching swarm mode.
 *
 * The "exit always runs" property is already covered exhaustively by the
 * unit tests in `test/tools/builtin/agent-swarm-coordinator.test.ts`
 * (success, host rejection, `enter` throws). This file exists so the
 * lifecycle is exercised through the harness — same plumbing real turns
 * use — and a regression in the wire-up of `AgentSwarmTool` to the
 * `Agent` (constructor order, `swarmMode` binding, tool registration)
 * surfaces here.
 */
describe('SwarmCoordinator integration', () => {
  it('AgentSwarmTool leaves SwarmMode inactive after a normal run', async () => {
    const runQueued = vi.fn().mockResolvedValue([
      {
        task: {
          kind: 'spawn',
          data: { kind: 'spawn', index: 1, item: 'a', prompt: 'echo a' },
          profileName: 'coder',
          parentToolCallId: 'call_swarm',
          prompt: 'echo a',
          description: 'echo test #1 (coder)',
          runInBackground: false,
        },
        agentId: 'agent-1',
        status: 'completed',
        result: 'ok a',
      },
      {
        task: {
          kind: 'spawn',
          data: { kind: 'spawn', index: 2, item: 'b', prompt: 'echo b' },
          profileName: 'coder',
          parentToolCallId: 'call_swarm',
          prompt: 'echo b',
          description: 'echo test #2 (coder)',
          runInBackground: false,
        },
        agentId: 'agent-2',
        status: 'completed',
        result: 'ok b',
      },
    ]);
    const subagentHost = { runQueued } as unknown as SessionSubagentHost;

    const ctx = testAgent({ subagentHost });
    ctx.configure({ tools: ['AgentSwarm'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    expect(ctx.agent.swarmMode.isActive).toBe(false);

    const swarmCall: ToolCall = {
      type: 'function',
      id: 'call_swarm',
      name: 'AgentSwarm',
      arguments: JSON.stringify({
        description: 'echo test',
        prompt_template: '{{item}}',
        items: ['a', 'b'],
      }),
    };

    ctx.mockNextResponse({ type: 'text', text: 'Running the swarm.' }, swarmCall);
    ctx.mockNextResponse({ type: 'text', text: 'Swarm finished.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use AgentSwarm' }] });
    await ctx.untilTurnEnd();

    // The harness actually exercised `AgentSwarmTool.execution` through the
    // tool loop, which is the property we want covered at the integration
    // level. Without a real subagentHost mock the tool would not run.
    expect(runQueued).toHaveBeenCalledTimes(1);
    expect(ctx.agent.swarmMode.isActive).toBe(false);
  });

  it('keeps SwarmMode inactive across a normal text-only turn', async () => {
    // Companion smoke test: a turn that never touches AgentSwarm must also
    // leave swarm mode inactive. This guards against a regression where the
    // turn loop flips swarm mode on for unrelated work.
    const ctx = testAgent();
    ctx.configure();

    ctx.mockNextResponse({ type: 'text', text: 'Hello to you too.' });
    expect(ctx.agent.swarmMode.isActive).toBe(false);

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hi' }] });
    await ctx.untilTurnEnd();

    expect(ctx.agent.swarmMode.isActive).toBe(false);
  });
});