import { describe, expect, it, vi } from 'vitest';
import { HookEngine } from '../../src/session/hooks/engine';

describe('HookEngine orchestration events', () => {
  it('emits hook.fired for user-registered hooks', async () => {
    const emit = vi.fn();
    const engine = new HookEngine([], {
      onOrchestrationEvent: emit,
    });

    engine.register({
      event: 'PostToolUse',
      command: 'echo user-hook',
    });

    await engine.trigger('PostToolUse', { matcherValue: 'Bash' });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'hook.fired',
        payload: expect.objectContaining({
          event: 'PostToolUse',
          action: 'allow',
        }),
      }),
    );
  });

  it('does not emit hook.fired for system hooks', async () => {
    const emit = vi.fn();
    const engine = new HookEngine([], {
      onOrchestrationEvent: emit,
    });

    engine.registerSystem({
      event: 'PostToolUse',
      command: 'echo system-hook',
    });

    await engine.trigger('PostToolUse', { matcherValue: 'Bash' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits hook.fired when mixed user + system hooks', async () => {
    const emit = vi.fn();
    const engine = new HookEngine([], {
      onOrchestrationEvent: emit,
    });

    engine.registerSystem({
      event: 'PostToolUse',
      command: 'echo system-hook',
    });
    engine.register({
      event: 'PostToolUse',
      command: 'echo user-hook',
    });

    await engine.trigger('PostToolUse', { matcherValue: 'Bash' });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'hook.fired',
      }),
    );
  });
});
