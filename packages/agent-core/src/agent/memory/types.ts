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