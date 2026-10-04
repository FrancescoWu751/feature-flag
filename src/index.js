/**
 * index.js — public surface for the feature-flag library.
 *
 * Re-exports the pieces callers should depend on. Keeping the public API
 * narrow (Flag, Override, bucketFor, hashString) means internals can evolve
 * without breaking consumers.
 */
export { Flag, Override, bucketFor, hashString } from "./core.js";
