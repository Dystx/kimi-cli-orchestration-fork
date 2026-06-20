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
    // with the auto-routed trigger, which:
    //   1. Emits a `skill.activated` event on the agent's RPC.
    //   2. Injects the rendered skill body into `agent.context.history`
    //      inline (the orchestrator's turn is already active, so the
    //      SkillManager cannot enqueue a new `turn.prompt`; it appends
    //      to the live conversation instead).
    const activated = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'skill.activated',
    );
    expect(activated).toBeDefined();
    const args = (activated as { args: Record<string, unknown> }).args;
    expect(args['skillName']).toBe('database-helper');
    expect(args['trigger']).toBe('auto-routed');

    const inlineSkillMessages = ctx.agent.context.history.filter(
      (message) =>
        message.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            part.type === 'text' &&
            part.text.includes('database-helper body') &&
            part.text.includes('trigger="auto-routed"'),
        ),
    );
    expect(inlineSkillMessages.length).toBe(1);
    const origin = inlineSkillMessages[0]?.origin;
    expect(origin).toMatchObject({
      kind: 'skill_activation',
      skillName: 'database-helper',
      trigger: 'auto-routed',
    });
  });
});
