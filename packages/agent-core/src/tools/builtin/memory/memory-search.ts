import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import type { MemoryStore } from '../../../session/memory-store';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './memory-search.md?raw';

export const MEMORY_SEARCH_TOOL_NAME = 'MemorySearch' as const;

const MemorySearchInputSchema = z.object({
  query: z.string().describe('Free-text query; matched against content and tags.'),
  tags: z.array(z.string()).optional().describe('Optional tag filter.'),
  limit: z.number().int().positive().max(50).optional().describe('Max results; default 10.'),
});

export interface MemorySearchInput {
  query: string;
  tags?: string[];
  limit?: number;
}

export class MemorySearchTool implements BuiltinTool<MemorySearchInput> {
  readonly name = MEMORY_SEARCH_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MemorySearchInputSchema);

  constructor(private readonly store: MemoryStore) {}

  resolveExecution(args: MemorySearchInput): ToolExecution {
    return {
      description: `Searching memory for "${args.query.slice(0, 60)}"`,
      approvalRule: this.name,
      execute: async () => {
        const results = await this.store.search(args.query, { tags: args.tags, limit: args.limit });
        if (results.length === 0) {
          return { isError: false, output: 'No matching memories.' };
        }
        const lines = results.map((entry) => {
          const date = new Date(entry.timestamp).toISOString().split('T')[0];
          const tags = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
          return `- (${date}) ${entry.id}${tags}: ${entry.content}`;
        });
        return { isError: false, output: lines.join('\n') };
      },
    };
  }
}
