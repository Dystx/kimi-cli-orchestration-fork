import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import type { MemoryStore } from '../../../session/memory-store';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './memory-read.md?raw';

export const MEMORY_READ_TOOL_NAME = 'MemoryRead' as const;

const MemoryReadInputSchema = z.object({
  id: z.string().min(1).describe('Memory entry id returned by MemoryWrite or MemorySearch.'),
});

export interface MemoryReadInput {
  id: string;
}

export class MemoryReadTool implements BuiltinTool<MemoryReadInput> {
  readonly name = MEMORY_READ_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MemoryReadInputSchema);

  constructor(private readonly store: MemoryStore) {}

  resolveExecution(args: MemoryReadInput): ToolExecution {
    return {
      description: `Reading memory ${args.id}`,
      approvalRule: this.name,
      execute: async () => {
        const entry = await this.store.read(args.id);
        if (entry === undefined) {
          return { isError: true, output: `No memory found for id ${args.id}.` };
        }
        const lines = [
          `id: ${entry.id}`,
          `type: ${entry.type ?? entry.source}`,
          `timestamp: ${new Date(entry.timestamp).toISOString()}`,
          `tags: ${entry.tags.join(', ') || '(none)'}`,
          '',
          entry.content,
        ];
        return { isError: false, output: lines.join('\n') };
      },
    };
  }
}
