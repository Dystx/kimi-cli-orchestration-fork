/**
 * Shared types for the agent-level memory API.
 *
 * NOTE: Name collision with the existing `MemoryStore` class.
 * The class `MemoryStore` is defined in `packages/agent-core/src/session/memory-store.ts`.
 * This file declares an interface with the same name that the class will implement
 * (see Task 2 of the Phase 2 memory subsystem plan).
 *
 * Consumer guidance:
 *   - Import this interface from the deep path
 *     `'@moonshot-ai/agent-core/agent/memory/types'` (or the relative
 *     `'../../agent/memory/types'`) and alias it to avoid colliding with the class,
 *     e.g. `import type { MemoryStore as IMemoryStore } from '<deep-path>';`.
 *   - Do NOT re-export this interface from any package barrel
 *     (e.g. `packages/agent-core/src/index.ts`); doing so would create a latent
 *     name collision the moment the class is re-exported alongside it.
 */
import type { MemoryEntry } from '../../session/memory-store';

export type MemoryType = 'fact' | 'insight' | 'decision' | 'preference' | 'snippet' | 'reflection' | 'skill' | 'outcome';

export interface WriteMemoryInput {
  readonly content: string;
  readonly tags?: readonly string[];
  readonly type?: MemoryType;
}

export interface MemoryStore {
  write(entry: WriteMemoryInput): Promise<MemoryEntry>;
  read(id: string): Promise<MemoryEntry | undefined>;
  search(
    query: string,
    options?: { readonly tags?: readonly string[]; readonly limit?: number },
  ): Promise<MemoryEntry[]>;
  delete(id: string): Promise<boolean>;
}
