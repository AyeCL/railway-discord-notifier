type CacheEntry = {
  expiresAt: number;
};

export class EventCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs: number) {}

  begin(key: string): boolean {
    this.pruneExpired();
    if (this.entries.has(key)) {
      return false;
    }

    this.entries.set(key, {
      expiresAt: Date.now() + this.ttlMs,
    });

    return true;
  }

  markFailed(key: string): void {
    this.entries.delete(key);
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}
