/**
 * In-memory TTL cache for upstream leaderboard pages.
 *
 * Behaviour that matters:
 *   - A fresh entry inside its TTL is served without touching the network.
 *   - A failed refresh serves the last good value marked `stale: true` instead
 *     of throwing; the page keeps working and says the data may be old.
 *   - `429` with `Retry-After` blocks retries until the window passes, so a
 *     rate-limited upstream is never hammered in a tight loop.
 *
 * No timers, no background refresh: everything is request-driven.
 */
export function createHotCache({ now = () => Date.now() } = {}) {
  const entries = new Map();
  const blockedUntil = new Map();

  function readEntry(key) {
    return entries.get(key) || null;
  }

  return {
    /** Cache a value without fetching (used by tests and forced refresh paths). */
    set(key, value) {
      const nowMs = now();
      entries.set(key, { value, fetchedAt: new Date(nowMs).toISOString(), fetchedAtMs: nowMs });
    },

    peek(key) {
      const cached = readEntry(key);
      return cached ? { value: cached.value, fetchedAt: cached.fetchedAt, stale: false } : null;
    },

    /** True while a Retry-After backoff is still in force. */
    isBlocked(key) {
      return (blockedUntil.get(key) || 0) > now();
    },

    clear() {
      entries.clear();
      blockedUntil.clear();
    },

    /**
     * Resolve a key through the cache.
     *
     * Returns `{ value, fetchedAt, stale, error? }`. Throws only when there is
     * nothing cached to fall back to.
     */
    async load(key, { ttlMs, fetcher, force = false } = {}) {
      if (typeof fetcher !== 'function') throw new Error('Hot cache load requires a fetcher');
      const cached = readEntry(key);
      const nowMs = now();

      if (!force && cached && nowMs - cached.fetchedAtMs < ttlMs) {
        return { value: cached.value, fetchedAt: cached.fetchedAt, stale: false };
      }

      if (!force && this.isBlocked(key) && cached) {
        return { value: cached.value, fetchedAt: cached.fetchedAt, stale: true };
      }

      try {
        const value = await fetcher();
        const fetchedAt = new Date(nowMs).toISOString();
        entries.set(key, { value, fetchedAt, fetchedAtMs: nowMs });
        blockedUntil.delete(key);
        return { value, fetchedAt, stale: false };
      } catch (error) {
        if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0) {
          blockedUntil.set(key, nowMs + error.retryAfterMs);
        }
        if (cached) {
          return { value: cached.value, fetchedAt: cached.fetchedAt, stale: true, error };
        }
        throw error;
      }
    }
  };
}
