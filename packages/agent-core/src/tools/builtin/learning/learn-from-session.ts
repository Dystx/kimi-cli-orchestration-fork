/**
 * LearnFromSession — triggers Hermes-style learning analysis.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { SessionLearningEngine } from '../../../session/learning-engine';

export const LearnFromSessionInputSchema = z.object({
  write_drafts: z
    .boolean()
    .optional()
    .describe('If true, write draft skills to disk for later review. Defaults to true.'),
});

export type LearnFromSessionInput = z.infer<typeof LearnFromSessionInputSchema>;

export class LearnFromSessionTool implements BuiltinTool<LearnFromSessionInput> {
  readonly name = 'LearnFromSession';
  readonly description =
    'Analyzes the current session outcomes, detects recurring patterns, and generates draft skill suggestions, SOUL.md updates, and memory suggestions. This is the Hermes-style learning loop: reflect on experience → extract patterns → create reusable skills. Use this after completing significant work or when you notice a pattern worth preserving.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(LearnFromSessionInputSchema);

  constructor(private readonly engine: SessionLearningEngine) {}

  resolveExecution(args: LearnFromSessionInput): ToolExecution {
    return {
      description: 'Analyzing session for learning patterns',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private async execution(args: LearnFromSessionInput): Promise<ExecutableToolResult> {
    const report = await this.engine.analyze();
    const writeDrafts = args.write_drafts ?? true;

    if (writeDrafts && report.draftSkills.length > 0) {
      await this.engine.writeDrafts(report);
    }

    const lines: string[] = ['Session Learning Report', '=======================', ''];

    if (report.patterns.length > 0) {
      lines.push('Detected Patterns:');
      for (const p of report.patterns) {
        lines.push(`  [${p.type}] ${p.description}`);
      }
      lines.push('');
    }

    if (report.draftSkills.length > 0) {
      lines.push(`Draft Skills (${writeDrafts ? 'written to ~/.kimi-code/skill-drafts/' : 'proposed'}):`);
      for (const d of report.draftSkills) {
        lines.push(`  • ${d.name} (${d.confidence} confidence)`);
        lines.push(`    ${d.description}`);
      }
      lines.push('');
    }

    if (report.soulSuggestions.length > 0) {
      lines.push('SOUL.md Suggestions:');
      for (const s of report.soulSuggestions) {
        lines.push(`  • ${s}`);
      }
      lines.push('');
    }

    if (report.memorySuggestions.length > 0) {
      lines.push('Memory Suggestions:');
      for (const s of report.memorySuggestions) {
        lines.push(`  • ${s}`);
      }
      lines.push('');
    }

    if (
      report.patterns.length === 0 &&
      report.draftSkills.length === 0 &&
      report.soulSuggestions.length === 0 &&
      report.memorySuggestions.length === 0
    ) {
      lines.push('No clear patterns detected yet. More session data needed for learning.');
    }

    return { output: lines.join('\n') };
  }
}
