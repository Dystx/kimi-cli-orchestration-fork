import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { testAgent } from '../agent/harness/agent';
import { SkillManager } from '../../src/agent/skill';
import { FLAG_DEFINITIONS, FlagResolver } from '../../src/flags';
import { SkillRegistry } from '../../src/skill';

describe('SkillRoutingPolicy integration', () => {
  let dir: string;
  let skillDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'skill-routing-'));
    skillDir = join(dir, 'skills');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'database-helper.md'),
      [
        '---',
        'name: database-helper',
        'description: Database migration and backup helpers.',
        'whenToUse: When the user asks about database migration.',
        '---',
        '',
        '# database-helper body',
      ].join('\n'),
      'utf-8',
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('auto-activates a matching skill when the flag is on', async () => {
    const flags = new FlagResolver({}, FLAG_DEFINITIONS, { skill_routing: true });
    const ctx = testAgent({
      homedir: dir,
      // The harness accepts an `experimentalFlags` resolver, but not a
      // `skillRoots` option, so the SkillManager is attached below after
      // construction.
      experimentalFlags: flags,
    });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const registry = new SkillRegistry();
    await registry.loadRoots([{ path: skillDir, source: 'project' }]);
    (ctx.agent as unknown as { skills: SkillManager | null }).skills = new SkillManager(
      ctx.agent,
      registry,
    );

    ctx.rpc.prompt({
      input: [{ type: 'text', text: 'Help me with the database migration' }],
    });
    await ctx.untilTurnEnd();

    // The skill routing policy fires inside the orchestrator's `beforeStep`
    // hook, before the model call. It should call `agent.skills.activate`
    // with the auto-routed trigger, which emits a `skill.activated` event
    // on the agent's RPC. That event is the most reliable end-to-end
    // observable of the auto-activation (the wrapped skill prompt that
    // `SkillManager.activate` tries to enqueue is dropped because the
    // turn is already active by the time the policy runs).
    const activated = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'skill.activated',
    );
    expect(activated).toBeDefined();
    const args = (activated as { args: Record<string, unknown> }).args;
    expect(args['skillName']).toBe('database-helper');
    expect(args['trigger']).toBe('auto-routed');
  });
});
