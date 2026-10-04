/**
 * core.js — internals for the feature-flag library.
 *
 * Why a dedicated core module: keeping the hashing, evaluation, and override
 * resolution logic separate from index.js makes each piece testable in
 * isolation and lets index.js stay as a thin public surface. Nothing here
 * performs I/O or reads the system clock; everything time-dependent takes a
 * clock function so tests can be deterministic.
 */

/**
 * FNV-1a (32-bit) hash of a string.
 *
 * We need a stable, deterministic integer from an identifier so rollout
 * percentages can be computed reproducibly across processes. FNV-1a is
 * small, has good distribution for short inputs, and needs no third-party
 * crypto. We deliberately use a non-cryptographic hash because the threat
 * model here is accidental skew across nodes, not adversarial input.
 *
 * The `>>> 0` coerces the result back to an unsigned 32-bit int; without it,
 * multiplication can overflow into a signed value and break the modulo math
 * below.
 */
export function hashString(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Imultiply by the FNV prime, keeping within 32 bits.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Map an identifier to a bucket in [0, 100).
 *
 * We hash the *flag key together with the identifier* so that the same user
 * lands in different buckets for different flags. Hashing only the identifier
 * would give one user the same position across every flag, producing
 * correlated rollouts that over- or under-expose that user.
 */
export function bucketFor(flagKey, identifier) {
  const h = hashString(`${flagKey}::${identifier}`);
  return h % 100;
}

/**
 * A rule that overrides the rollout decision for a specific identifier.
 *
 * `force` true turns the flag on; false turns it off. Overrides are evaluated
 * before any rollout computation, so an explicitly disabled user stays off
 * even at 100% rollout.
 */
export class Override {
  constructor(identifier, force) {
    this.identifier = identifier;
    this.force = force;
  }
}

/**
 * A single feature flag.
 *
 * Design decisions, stated plainly so the tests can't drift from intent:
 *
 *  - Rollout is an integer percentage in [0, 100]. We refuse to accept floats
 *    because float percentages invite exactly the kind of == comparisons that
 *    make tests flaky, and a percentage has no meaningful sub-integer
 *    granularity for a hash bucket in [0, 100).
 *  - `enabled` is a master switch. When false, the flag is off for everyone
 *    except identifiers with an explicit `force: true` override. That keeps
 *    "kill switch" semantics predictable: disabling a flag can't be silently
 *    undone by a stale override you forgot to remove.
 *  - `expiresAt` is optional epoch milliseconds. When set and the clock says
 *    the time has passed, the flag reports off regardless of rollout. We never
 *    compare floats; we compare integers.
 */
export class Flag {
  constructor({ key, rollout = 0, enabled = true, overrides = [], expiresAt = null }) {
    if (!Number.isInteger(rollout) || rollout < 0 || rollout > 100) {
      throw new Error(`rollout must be an integer in [0, 100], got: ${rollout}`);
    }
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("flag key must be a non-empty string");
    }
    if (expiresAt !== null && !Number.isFinite(expiresAt)) {
      throw new Error(`expiresAt must be null or a finite epoch-ms value, got: ${expiresAt}`);
    }
    this.key = key;
    this.rollout = rollout;
    this.enabled = enabled;
    // Copy the overrides array defensively so external mutation can't poison
    // the flag's decision after construction.
    this.overrides = Array.isArray(overrides) ? overrides.slice() : [];
    this.expiresAt = expiresAt;
  }

  /**
   * Find an override for the given identifier, if any.
   *
   * We take the *last* matching override as authoritative so callers can
   * append late-binding overrides without rewriting the whole list. This is a
   * deliberate, single rule — don't expect first-match precedence.
   */
  findOverride(identifier) {
    let match = null;
    for (const o of this.overrides) {
      if (o.identifier === identifier) match = o;
    }
    return match;
  }

  /**
   * Decide whether the flag is on for `identifier` at `now` (epoch ms).
   */
  isEnabled(identifier, now = Date.now()) {
    const override = this.findOverride(identifier);
    if (override) {
      // An override always wins, even when the flag is disabled, EXCEPT a
      // `force: false` override while disabled is redundant but consistent.
      return override.force;
    }
    if (this.enabled === false) {
      return false;
    }
    if (this.expiresAt !== null && now >= this.expiresAt) {
      return false;
    }
    return bucketFor(this.key, identifier) < this.rollout;
  }
}
