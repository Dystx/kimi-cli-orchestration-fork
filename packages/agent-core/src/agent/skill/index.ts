import { randomUUID } from 'node:crypto';

import type { ActivateSkillPayload } from '#/rpc';
import type { ContentPart } from '@moonshot-ai/kosong';

import type { Agent } from '..';
import { ErrorCodes, KimiError } from '#/errors';
import { isUserActivatableSkillType, type SkillRegistry } from '../../skill';
import type { SkillActivationOrigin } from '../context';
import { renderAutoRoutedSkillPrompt, renderUserSlashSkillPrompt } from './prompt';

export class SkillManager {
  constructor(
    protected readonly agent: Agent,
    public readonly registry: SkillRegistry,
  ) {}

  activate(
    input: ActivateSkillPayload,
    trigger: SkillActivationOrigin['trigger'] = 'user-slash',
  ): void {
    const skill = this.registry.getSkill(input.name);
    if (skill === undefined) {
      throw new KimiError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${input.name}" was not found`);
    }
    if (!isUserActivatableSkillType(skill.metadata.type)) {
      throw new KimiError(ErrorCodes.SKILL_TYPE_UNSUPPORTED, `Skill "${skill.name}" cannot be activated by the user`);
    }

    const skillArgs = input.args ?? '';
    const origin: SkillActivationOrigin = {
      kind: 'skill_activation',
      activationId: randomUUID(),
      skillName: skill.name,
      trigger,
      skillType: skill.metadata.type,
      skillPath: skill.path,
      skillSource: skill.source,
      skillArgs: input.args,
    };

    if (trigger === 'auto-routed') {
      // Auto-routed skills fire inside the orchestrator's `beforeStep`
      // hook, while the user's turn is already active. `TurnFlow.launch`
      // rejects `turn.prompt` in that state with `turn.agent_busy`, so we
      // emit the activation observability events directly and inject the
      // rendered skill content into the conversation inline (the same
      // way the model-driven SkillTool does). This is what makes the
      // routed skill body actually reach the model.
      this.emitActivation(origin);
      const skillContent = this.registry.renderSkillPrompt(skill, skillArgs);
      this.agent.context.appendUserMessage(
        [
          {
            type: 'text' as const,
            text: renderAutoRoutedSkillPrompt({
              skillName: skill.name,
              skillArgs,
              skillContent,
              skillSource: skill.source,
            }),
          },
        ],
        origin,
      );
      return;
    }

    const skillContent = this.registry.renderSkillPrompt(skill, skillArgs);
    const wrapped: ContentPart[] = [
      {
        type: 'text' as const,
        text: renderUserSlashSkillPrompt({
          skillName: skill.name,
          skillArgs,
          skillContent,
          skillSource: skill.source,
        }),
      },
    ];

    this.recordActivation(origin, wrapped);
  }

  recordActivation(
    origin: SkillActivationOrigin,
    input?: readonly ContentPart[] | undefined,
  ): void {
    this.emitActivation(origin);
    if (input !== undefined) {
      this.agent.turn.prompt(input, origin);
    }
  }

  private emitActivation(origin: SkillActivationOrigin): void {
    this.agent.emitEvent({
      type: 'skill.activated',
      activationId: origin.activationId,
      skillName: origin.skillName,
      trigger: origin.trigger,
      skillArgs: origin.skillArgs,
      skillPath: origin.skillPath,
      skillSource: origin.skillSource,
    });
    this.agent.telemetry.track('skill_invoked', {
      skill_name: origin.skillName,
      trigger: origin.trigger,
    });
    if (origin.skillType === 'flow') {
      this.agent.telemetry.track('flow_invoked', {
        flow_name: origin.skillName,
      });
    }
  }
}
