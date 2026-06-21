import { describe, expect, it, vi } from 'vitest';

import { SessionSubagentHost } from '../../src/session/subagent-host';
import type { OrchestrationHooks } from '../../src/session/orchestration-hooks';

function makeChildRpc() {
  const subscribers: Array<(event: unknown) => void> = [];
  return {
    subscribers,
    onEvent: vi.fn((cb: (event: unknown) => void) => {
      subscribers.push(cb);
      return () => {
        const idx = subscribers.indexOf(cb);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    }),
    emit: vi.fn((event: unknown) => {
      for (const cb of subscribers) cb(event);
    }),
  };
}

function makeOrchestrationHooks() {
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const hooks = {
    emitted,
    emit: vi.fn((event: { type: string; payload: Record<string, unknown> }) => {
      emitted.push(event);
    }),
  };
  return hooks as unknown as OrchestrationHooks & { emitted: typeof emitted };
}

function makeSession() {
  // Minimal session-shaped object — the bridge method doesn't dereference
  // any session state, so the bare mock is enough to satisfy the
  // `SessionSubagentHost` constructor.
  return {
    orchestrationHooks: undefined,
    metadata: { agents: {} },
    writeMetadata: vi.fn(async () => {}),
  } as never;
}

describe('subagent-host tool event bridge', () => {
  it('re-emits tool.call.started through orchestrationHooks with subagentId', () => {
    const hooks = makeOrchestrationHooks();
    const host = new SessionSubagentHost(makeSession(), 'main');
    const childRpc = makeChildRpc();
    const unsubscribe = host.attachChildToolEventBridge('child-1', childRpc, hooks);
    childRpc.emit({
      type: 'tool.call.started',
      toolName: 'read_file',
      args: { file_path: '/tmp/foo.md' },
    });
    expect(hooks.emitted).toHaveLength(1);
    expect(hooks.emitted[0]).toMatchObject({
      type: 'tool.call.started',
      payload: expect.objectContaining({ subagentId: 'child-1' }),
    });
    unsubscribe();
  });

  it('re-emits tool.result with subagentId', () => {
    const hooks = makeOrchestrationHooks();
    const host = new SessionSubagentHost(makeSession(), 'main');
    const childRpc = makeChildRpc();
    const unsubscribe = host.attachChildToolEventBridge('child-2', childRpc, hooks);
    childRpc.emit({ type: 'tool.result', toolCallId: 'tc-1' });
    expect(hooks.emitted[0]?.payload?.['subagentId']).toBe('child-2');
    unsubscribe();
  });

  it('does not re-emit non-tool events', () => {
    const hooks = makeOrchestrationHooks();
    const host = new SessionSubagentHost(makeSession(), 'main');
    const childRpc = makeChildRpc();
    const unsubscribe = host.attachChildToolEventBridge('child-3', childRpc, hooks);
    childRpc.emit({ type: 'assistant.delta', delta: 'hello' });
    childRpc.emit({ type: 'thinking.delta', delta: '...' });
    expect(hooks.emitted).toHaveLength(0);
    unsubscribe();
  });

  it('stops re-emitting after unsubscribe', () => {
    const hooks = makeOrchestrationHooks();
    const host = new SessionSubagentHost(makeSession(), 'main');
    const childRpc = makeChildRpc();
    const unsubscribe = host.attachChildToolEventBridge('child-4', childRpc, hooks);
    childRpc.emit({ type: 'tool.call.started', toolName: 'shell' });
    expect(hooks.emitted).toHaveLength(1);
    unsubscribe();
    childRpc.emit({ type: 'tool.result' });
    expect(hooks.emitted).toHaveLength(1);
  });
});