/**
 * ReviewDraftSkills — list auto-generated draft skills waiting for approval.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { SessionLearningEngine } from '../../../session/learning-engine';

export const ReviewDraftSkillsInputSchema = z.object({});

export type ReviewDraftSkillsInput = z.infer<typeof ReviewDraftSkillsInputSchema>;

export class ReviewDraftSkillsTool implements BuiltinTool<ReviewDraftSkillsInput> {
  readonly name = 'ReviewDraftSkills';
  readonly description =
    'Lists all auto-generated draft skills waiting for review and promotion. These drafts were created by the learning engine based on detected patterns. Review them and call PromoteDraftSkill to activate the ones worth keeping.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReviewDraftSkillsInputSchema);

  constructor(private readonly engine: SessionLearningEngine) {}

  resolveExecution(_args: ReviewDraftSkillsInput): ToolExecution {
    return {
      description: 'Reviewing draft skills',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(),
    };
  }

  private async execution(): Promise<ExecutableToolResult> {
    const drafts = await this.engine.listDrafts();

    if (drafts.length === 0) {
      return { output: 'No draft skills found. Run LearnFromSession to generate some.' };
    }

    const lines = [
      'Draft Skills (awaiting review)',
      '==============================',
      '',
    ];

    for (const d of drafts) {
      lines.push(`ID: ${d.id}`);
      lines.push(`Name: ${d.name}`);
      lines.push(`Confidence: ${d.confidence}`);
      lines.push(`Description: ${d.description}`);
      lines.push(`Source: ${d.sourcePattern}`);
      lines.push('');
    }

    lines.push('To promote a draft to an active skill, call PromoteDraftSkill with the ID and a skill name.');

    return { output: lines.join('\n') };
  }
}
