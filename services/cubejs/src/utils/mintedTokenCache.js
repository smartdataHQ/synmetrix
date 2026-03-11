const MAX_SIZE = 1000;
const BUFFER_SECONDS = 60;

const cache = new Map();

/**
 * Per-userId cache for minted HS256 Hasura JWTs.
 * Returns cached token if exp - now > 60s, otherwise null.
 */
export const mintedTokenCache = {
  /**
   * Get a cached token for the given userId.
   * @param {string} userId
   * @returns {string|null} Cached JWT or null if miss/expired
   */
  get(userId) {
    const entry = cache.get(userId);
    if (!entry) return null;

    const now = Math.floor(Date.now() / 1000);
    if (entry.exp - now <= BUFFER_SECONDS) {
      cache.delete(userId);
      return null;
    }

    return entry.token;
  },

  /**
   * Store a minted token in the cache.
   * @param {string} userId
   * @param {string} token - Minted JWT string
   * @param {number} exp - Expiration timestamp (Unix seconds)
   */
  set(userId, token, exp) {
    if (cache.size >= MAX_SIZE) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    cache.set(userId, { token, exp });
  },

  /**
   * Invalidate a specific userId's cached token.
   * @param {string} userId
   */
  invalidate(userId) {
    cache.delete(userId);
  },

  /**
   * Clear all cached tokens.
   */
  invalidateAll() {
    cache.clear();
  },
};
