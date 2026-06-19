import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'pathe';

import type { MemoryType, MemoryStore as IMemoryStore, WriteMemoryInput } from '../agent/memory/types';

const MAX_ENTRIES = 1000;

/** BM25 hyper-parameters. */
const BM25_K1 = 1.5;
const BM25_B = 0.75;
/** How many times each tag term is repeated in the pseudo-document. */
const TAG_WEIGHT = 3;

export interface MemoryEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly tags: string[];
  readonly content: string;
  readonly source: 'reflection' | 'skill' | 'outcome';
  readonly type?: MemoryType;
  readonly relevanceScore?: number;
}

const VALID_TYPES: ReadonlySet<string> = new Set([
  'fact', 'insight', 'decision', 'preference', 'snippet',
  'reflection', 'skill', 'outcome',
]);

interface Bm25Document {
  readonly id: string;
  readonly terms: string[];
  readonly length: number;
}

class Bm25Scorer {
  private readonly avgdl: number;
  private readonly idf: Map<string, number>;

  constructor(documents: readonly Bm25Document[]) {
    const totalLength = documents.reduce((sum, d) => sum + d.length, 0);
    this.avgdl = totalLength / documents.length || 1;

    const df = new Map<string, number>();
    for (const doc of documents) {
      const seen = new Set(doc.terms);
      for (const term of seen) {
        df.set(term, (df.get(term) ?? 0) + 1);
      }
    }

    const N = documents.length;
    this.idf = new Map();
    for (const [term, freq] of df) {
      // Lucene-style BM25 IDF — always non-negative.
      this.idf.set(term, Math.log(1 + (N - freq + 0.5) / (freq + 0.5)));
    }
  }

  score(doc: Bm25Document, queryTerms: readonly string[]): number {
    let score = 0;
    const termFreq = new Map<string, number>();
    for (const term of doc.terms) {
      termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
    }

    for (const term of queryTerms) {
      const idf = this.idf.get(term) ?? 0;
      const tf = termFreq.get(term) ?? 0;
      if (tf === 0) continue;
      const numerator = tf * (BM25_K1 + 1);
      const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / this.avgdl));
      score += idf * (numerator / denominator);
    }

    return score;
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

export class MemoryStore implements IMemoryStore {
  private readonly memoryDir: string;

  constructor(baseDir: string) {
    this.memoryDir = join(baseDir, '.kimi-code', 'memory');
  }

  async write(entry: WriteMemoryInput): Promise<MemoryEntry> {
    const memory: MemoryEntry = {
      id: randomUUID(),
      timestamp: Date.now(),
      tags: [...(entry.tags ?? [])],
      content: entry.content,
      source: 'reflection',
      type: entry.type ?? 'fact',
    };

    await mkdir(this.memoryDir, { recursive: true });
    const filePath = join(this.memoryDir, 'entries.json');

    const entries = await this.loadAll();
    entries.push(memory);

    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => a.timestamp - b.timestamp);
      entries.splice(0, entries.length - MAX_ENTRIES);
    }

    const tempPath = `${filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(entries, null, 2), 'utf-8');
    await rename(tempPath, filePath);
    return memory;
  }

  async read(id: string): Promise<MemoryEntry | undefined> {
    const entries = await this.loadAll();
    return entries.find((m) => m.id === id);
  }

  async search(
    query: string,
    options?: { readonly tags?: readonly string[]; readonly limit?: number },
  ): Promise<MemoryEntry[]> {
    const limit = options?.limit ?? 10;
    const tags = options?.tags;
    const queryTerms = tokenize(query);
    const hasQuery = queryTerms.length > 0;

    const entries = await this.loadAll();
    if (entries.length === 0) return [];

    const docs = entries.map((m) => {
      const terms = tokenize(m.content);
      for (const tag of m.tags) {
        const tagTerms = tokenize(tag);
        for (let i = 0; i < TAG_WEIGHT; i++) terms.push(...tagTerms);
      }
      return { id: m.id, terms, length: terms.length };
    });
    const scorer = new Bm25Scorer(docs);

    const scored = entries.map((memory, index) => {
      const doc = docs[index]!;
      let score = hasQuery ? scorer.score(doc, queryTerms) : 0;
      const queryLower = query.toLowerCase().trim();
      if (queryLower.length > 0 && memory.content.toLowerCase().includes(queryLower)) {
        score += 3;
      }
      const tagsLower = new Set(memory.tags.map((t) => t.toLowerCase()));
      let tagMatch = false;
      if (tags !== undefined) {
        for (const tag of tags) {
          if (tagsLower.has(tag.toLowerCase())) {
            score += 2;
            tagMatch = true;
          }
        }
      }
      // Without a query, only return memories that have explicit tag matches.
      // Preserves the original findRelevant gating for backward compatibility.
      if (!hasQuery && !tagMatch) return { memory, score: 0 };
      const ageDays = (Date.now() - memory.timestamp) / (1000 * 60 * 60 * 24);
      score += Math.max(0, 3 - ageDays * 0.5);
      if (memory.source === 'reflection') score += 0.5;
      return { memory, score };
    });

    return scored
      .filter(({ score }) => score > 0)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ memory, score }) => ({ ...memory, relevanceScore: Math.round(score * 100) / 100 }));
  }

  async delete(id: string): Promise<boolean> {
    const entries = await this.loadAll();
    const next = entries.filter((m) => m.id !== id);
    if (next.length === entries.length) return false;
    const filePath = join(this.memoryDir, 'entries.json');
    const tempPath = `${filePath}.tmp`;
    await mkdir(this.memoryDir, { recursive: true });
    await writeFile(tempPath, JSON.stringify(next, null, 2), 'utf-8');
    await rename(tempPath, filePath);
    return true;
  }

  // Backward-compatible helpers.
  /**
   * @deprecated Use {@link write} instead. Preserved for backward compatibility
   * with `LearningEngine` and existing callers that pass a `source`.
   */
  async addMemory(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): Promise<MemoryEntry> {
    const memory: MemoryEntry = {
      ...entry,
      id: randomUUID(),
      timestamp: Date.now(),
    };

    await mkdir(this.memoryDir, { recursive: true });
    const filePath = join(this.memoryDir, 'entries.json');

    const entries = await this.loadAll();
    entries.push(memory);

    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => a.timestamp - b.timestamp);
      entries.splice(0, entries.length - MAX_ENTRIES);
    }

    const tempPath = `${filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(entries, null, 2), 'utf-8');
    await rename(tempPath, filePath);
    return memory;
  }

  async findRelevant(
    query: string,
    tags?: string[],
    limit = 10,
    workDirTag?: string,
  ): Promise<MemoryEntry[]> {
    return this.searchWithWorkDirBoost(query, tags, limit, workDirTag);
  }

  async loadMemories(): Promise<MemoryEntry[]> {
    const entries = await this.loadAll();
    return entries.toSorted((a, b) => b.timestamp - a.timestamp);
  }

  formatForInjection(memories: MemoryEntry[]): string {
    if (memories.length === 0) return '';

    const lines = ['## Cross-Session Memories', ''];

    for (const memory of memories) {
      const date = new Date(memory.timestamp).toISOString().split('T')[0];
      lines.push(`- [${date}] ${memory.content}`);
      if (memory.tags.length > 0) {
        lines.push(`  Tags: ${memory.tags.join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  private async searchWithWorkDirBoost(
    query: string,
    tags: string[] | undefined,
    limit: number,
    workDirTag: string | undefined,
  ): Promise<MemoryEntry[]> {
    const queryTerms = tokenize(query);
    const hasQuery = queryTerms.length > 0;

    const entries = await this.loadAll();
    if (entries.length === 0) return [];

    const docs = entries.map((m) => {
      const terms = tokenize(m.content);
      for (const tag of m.tags) {
        const tagTerms = tokenize(tag);
        for (let i = 0; i < TAG_WEIGHT; i++) terms.push(...tagTerms);
      }
      return { id: m.id, terms, length: terms.length };
    });
    const scorer = new Bm25Scorer(docs);

    const workDirLower = workDirTag?.toLowerCase();

    const scored = entries.map((memory, index) => {
      const doc = docs[index]!;
      let score = hasQuery ? scorer.score(doc, queryTerms) : 0;
      const queryLower = query.toLowerCase().trim();
      if (queryLower.length > 0 && memory.content.toLowerCase().includes(queryLower)) {
        score += 3;
      }
      const tagsLower = new Set(memory.tags.map((t) => t.toLowerCase()));
      let tagMatch = false;
      if (tags !== undefined) {
        for (const tag of tags) {
          if (tagsLower.has(tag.toLowerCase())) {
            score += 2;
            tagMatch = true;
          }
        }
      }
      let workDirMatch = false;
      if (workDirLower !== undefined && tagsLower.has(workDirLower)) {
        score += 4;
        workDirMatch = true;
      }
      // Without a query, only return memories that have explicit tag or workDir matches.
      // Preserves the original findRelevant gating for backward compatibility.
      if (!hasQuery && !tagMatch && !workDirMatch) return { memory, score: 0 };
      const ageDays = (Date.now() - memory.timestamp) / (1000 * 60 * 60 * 24);
      score += Math.max(0, 3 - ageDays * 0.5);
      if (memory.source === 'reflection') score += 0.5;
      return { memory, score };
    });

    return scored
      .filter(({ score }) => score > 0)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ memory, score }) => ({ ...memory, relevanceScore: Math.round(score * 100) / 100 }));
  }

  private async loadAll(): Promise<MemoryEntry[]> {
    const filePath = join(this.memoryDir, 'entries.json');
    try {
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content) as unknown;
      if (!Array.isArray(parsed)) return [];
      const result: MemoryEntry[] = [];
      for (const entry of parsed) {
        if (this.isValidMemoryEntry(entry)) result.push(entry);
      }
      return result;
    } catch {
      return [];
    }
  }

  private isValidMemoryEntry(entry: unknown): entry is MemoryEntry {
    if (typeof entry !== 'object' || entry === null) return false;
    const e = entry as Record<string, unknown>;
    const typeOk = e['type'] === undefined || VALID_TYPES.has(e['type'] as string);
    return (
      typeof e['id'] === 'string' &&
      typeof e['timestamp'] === 'number' &&
      Array.isArray(e['tags']) &&
      (e['tags'] as unknown[]).every((t: unknown) => typeof t === 'string') &&
      typeof e['content'] === 'string' &&
      (e['source'] === 'reflection' || e['source'] === 'skill' || e['source'] === 'outcome') &&
      typeOk
    );
  }
}
