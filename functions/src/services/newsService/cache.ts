/**
 * Minimal in-memory TTL cache.
 *
 * Cloud Functions instances are reused across invocations, so this meaningfully
 * cuts repeated outbound feed/resolver calls within an instance's lifetime
 * without any external dependency. It is intentionally per-instance and lossy.
 */
type Entry<T> = {
  value: T;
  expiresAt: number;
};

export class TtlCache<T> {
  private readonly store = new Map<string, Entry<T>>();
  private readonly pending = new Map<string, Promise<T>>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 500) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.store.size >= this.maxEntries) {
      // Evict the oldest inserted key (Map preserves insertion order).
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /**
   * Get the cached value or compute, store, and return it. Concurrent calls
   * for the same key share one in-flight compute instead of each running the
   * full fetch (thundering-herd protection on cold caches).
   */
  async getOrSet(key: string, compute: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const inFlight = this.pending.get(key);
    if (inFlight) {
      return inFlight;
    }

    const promise = compute()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, promise);
    return promise;
  }
}
