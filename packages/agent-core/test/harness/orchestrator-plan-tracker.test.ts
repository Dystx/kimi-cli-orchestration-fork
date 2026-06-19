import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { testAgent } from '../agent/harness/agent';
import { TODO_STORE_KEY } from '#/tools/builtin/state/todo-list';

describe('Orchestrator plan tracker integration', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-plan-tracker-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('syncs plan markdown to the todo store during a turn', async () => {
    const ctx = testAgent({ homedir: tmp });
    ctx.configure();

    await ctx.agent.planMode.enter('integration-test-plan', true);

    const planPath = ctx.agent.planMode.planFilePath;
    expect(planPath).not.toBeNull();

    await writeFile(
      planPath!,
      '# Plan\n## Research\n- [x] read docs\n- [ ] write code\n',
      'utf-8',
    );

    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const todos = ctx.agent.tools.storeData()[TODO_STORE_KEY];
    expect(todos).toEqual([
      { title: 'Research', status: 'in_progress' },
      { title: 'read docs', status: 'done' },
      { title: 'write code', status: 'pending' },
    ]);
  });
});
