// Failed-attempt limiter used for logins and password changes (#5, #14).
//
// Each key (a username, a user id, or an IP address) counts consecutive failures. Every
// `maxFailures` failures lock the key, and each new lockout lasts twice as long as the last
// (1 min, 2, 4, … up to `maxLockMs`). A success clears the key; a key with no failures for
// `forgetMs` is forgotten. The map is capped so random keys can't grow memory without limit.
class Limiter {
  constructor({ maxFailures, baseLockMs, maxLockMs, forgetMs, maxKeys = 10_000 }) {
    Object.assign(this, { maxFailures, baseLockMs, maxLockMs, forgetMs, maxKeys });
    this.entries = new Map();
  }

  // Milliseconds until `key` may try again (0 = not locked).
  lockedFor(key, now = Date.now()) {
    const e = this.entries.get(key);
    if (!e) return 0;
    if (now - e.last > this.forgetMs) { this.entries.delete(key); return 0; }
    return Math.max(0, e.lockedUntil - now);
  }

  // Record a failure; returns true if this failure started a lockout.
  fail(key, now = Date.now()) {
    let e = this.entries.get(key);
    if (!e || now - e.last > this.forgetMs) e = { count: 0, lockouts: 0, lockedUntil: 0 };
    e.count++;
    e.last = now;
    let locked = false;
    if (e.count >= this.maxFailures) {
      e.lockedUntil = now + Math.min(this.baseLockMs * 2 ** e.lockouts, this.maxLockMs);
      e.lockouts++;
      e.count = 0;
      locked = true;
    }
    this.entries.delete(key); // re-insert so Map order is "least recently failed first"
    this.entries.set(key, e);
    this.prune(now);
    return locked;
  }

  succeed(key) { this.entries.delete(key); }

  prune(now = Date.now()) {
    for (const [k, e] of this.entries) {
      if (this.entries.size <= this.maxKeys && now - e.last <= this.forgetMs) break;
      this.entries.delete(k);
    }
  }
}

const waitText = (ms) => {
  const min = Math.ceil(ms / 60_000);
  return min <= 1 ? 'a minute' : `${min} minutes`;
};

module.exports = { Limiter, waitText };
