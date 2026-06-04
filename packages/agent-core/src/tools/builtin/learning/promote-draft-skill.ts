/**
 * PromoteDraftSkill — move a draft skill to the active skills directory.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { SessionLearningEngine } from '../../../session/learning-engine';

export const PromoteDraftSkillInputSchema = z.object({
  draft_id: z.string().describe('The ID of the draft skill to promote (from ReviewDraftSkills).'),
  skill_name: z
    .string()
    .describe('The directory name for the promoted skill (e.g., "bug-fix-pattern"). Use kebab-case.'),
});

export type PromoteDraftSkillInput = z.infer<typeof PromoteDraftSkillInputSchema>;

export class PromoteDraftSkillTool implements BuiltinTool<PromoteDraftSkillInput> {
  readonly name = 'PromoteDraftSkill';
  readonly description =
    'Promotes an auto-generated draft skill to the active skills directory (~/.kimi-code/skills/<skill-name>/). Once promoted, the skill is loaded automatically in future sessions. Use this after reviewing drafts with ReviewDraftSkills.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(PromoteDraftSkillInputSchema);

  constructor(private readonly engine: SessionLearningEngine) {}

  resolveExecution(args: PromoteDraftSkillInput): ToolExecution {
    return {
      description: `Promoting draft skill ${args.draft_id}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private async execution(args: PromoteDraftSkillInput): Promise<ExecutableToolResult> {
    const skillPath = await this.engine.promoteDraft(args.draft_id, args.skill_name);
    return {
      output: `Draft skill promoted to ${skillPath}. It will be loaded automatically in future sessions.`,
    };
  }
}
