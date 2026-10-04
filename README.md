# feature-flag

A small, dependency-free TypeScript feature-flag library with rollout percentages and per-identifier overrides. ESM only.

```js
import { Flag, Override } from "./src/index.js";

const beta = new Flag({
  key: "beta-ui",
  rollout: 25,
  overrides: [new Override("user-42", true)],
});

if (beta.isEnabled("user-42")) {
  // always on for this user
}
```

## Why this exists

The problem: you want to turn a feature on for a fraction of users, reproducibly, without a database or a third-party service. This library hashes the flag key together with the identifier so the same user lands in the same bucket for a given flag, but different flags distribute independently.

Trade-off: the hash is FNV-1a, not cryptographic. That is intentional — the goal is deterministic distribution across processes, not resistance to adversarial input. If an attacker can pick their identifier and cares about which bucket they land in, they can brute-force it. That is out of scope.

## Behaviour, stated plainly

- `rollout` is an integer percentage in `[0, 100]`. Floats are rejected. There is no sub-integer granularity for a 100-bucket hash.
- `enabled: false` is a kill switch: the flag is off for everyone except identifiers with an explicit `force: true` override. A stale `force: true` override will keep someone on even when the flag is disabled — remove overrides you no longer want.
- Overrides are evaluated before rollout. The **last** matching override for an identifier wins, so you can append rather than rewrite.
- `expiresAt` is epoch milliseconds. When `now >= expiresAt`, the flag reports off (except for a `force: true` override, which always wins). Passing the clock explicitly to `isEnabled` makes evaluation deterministic and testable.

## Exports

- `Flag` — the flag class. Constructor: `{ key, rollout?, enabled?, overrides?, expiresAt? }`. Method: `isEnabled(identifier, now?)`.
- `Override` — `{ identifier, force }`.
- `bucketFor(flagKey, identifier)` — the `[0, 100)` bucket for an identifier under a flag.
- `hashString(input)` — the underlying FNV-1a hash, exposed for debugging.

## The awkward edge

A `force: true` override bypasses both the kill switch and expiration. That is deliberate — an override is an explicit statement that this identifier is special. The cost is that overrides must be cleaned up manually; there is no auto-expiry on overrides, only on the flag itself.
