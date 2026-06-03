export interface SharedStoreEntry {
  readonly value: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly ttlMs?: number | undefined;
}

/**
 * Session-level shared key-value store for inter-agent state sharing.
 *
 * Unlike the message bus (point-to-point, ephemeral), the shared store
 * provides durable, structured state that any agent can read or write.
 * Entries are namespaced and optionally support TTL for automatic cleanup.
 */
export class SessionSharedStore {
  private readonly data = new Map<string, SharedStoreEntry>();

  get(key: string): unknown | undefined {
    const entry = this.data.get(key);
    if (entry === undefined) return undefined;
    if (entry.ttlMs !== undefined && Date.now() - entry.updatedAt > entry.ttlMs) {
      this.data.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: unknown, ttlMs?: number): void {
    const now = Date.now();
    const existing = this.data.get(key);
    this.data.set(key, {
      value,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ttlMs,
    });
  }

  delete(key: string): boolean {
    return this.data.delete(key);
  }

  has(key: string): boolean {
    const entry = this.data.get(key);
    if (entry === undefined) return false;
    if (entry.ttlMs !== undefined && Date.now() - entry.updatedAt > entry.ttlMs) {
      this.data.delete(key);
      return false;
    }
    return true;
  }

  keys(): string[] {
    this.evictExpired();
    return Array.from(this.data.keys());
  }

  entries(): Array<{ key: string; value: unknown }> {
    this.evictExpired();
    return Array.from(this.data.entries()).map(([key, entry]) => ({ key, value: entry.value }));
  }

  clear(): void {
    this.data.clear();
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.data) {
      if (entry.ttlMs !== undefined && now - entry.updatedAt > entry.ttlMs) {
        this.data.delete(key);
      }
    }
  }
}
