import { test } from "node:test";
import assert from "node:assert/strict";
import { Flag, Override, bucketFor, hashString } from "../src/index.js";

// --- hashString & bucketFor ------------------------------------------------

test("hashString is deterministic for the same input", () => {
  const a = hashString("user-123");
  const b = hashString("user-123");
  assert.equal(a, b);
});

test("hashString differs for different inputs", () => {
  // Not a cryptographic guarantee — just a sanity check that we didn't
  // accidentally return a constant.
  const a = hashString("user-123");
  const b = hashString("user-124");
  assert.notEqual(a, b);
});

test("hashString returns an unsigned 32-bit int", () => {
  const h = hashString("anything");
  assert.ok(Number.isInteger(h));
  assert.ok(h >= 0 && h <= 0xffffffff);
});

test("bucketFor is in [0, 100)", () => {
  for (let i = 0; i < 1000; i++) {
    const b = bucketFor("flag", `user-${i}`);
    assert.ok(b >= 0 && b < 100, `bucket ${b} out of range for user-${i}`);
  }
});

test("bucketFor is deterministic and stable across calls", () => {
  assert.equal(bucketFor("flagA", "user-1"), bucketFor("flagA", "user-1"));
});

test("bucketFor differs per flag for the same identifier", () => {
  const a = bucketFor("flagA", "user-1");
  const b = bucketFor("flagB", "user-1");
  assert.notEqual(a, b);
});

test("bucketFor distributes across the range over many identifiers", () => {
  // We don't assert exact percentages (flaky); we assert that at least one
  // identifier lands in the bottom half and at least one in the top half,
  // which catches a hash that always returns the same bucket.
  let low = false, high = false;
  for (let i = 0; i < 1000; i++) {
    const b = bucketFor("flag", `user-${i}`);
    if (b < 50) low = true; else high = true;
  }
  assert.ok(low && high, "hash did not spread across the range");
});

// --- Flag construction ------------------------------------------------------

test("Flag defaults: enabled true, rollout 0", () => {
  const f = new Flag({ key: "x" });
  assert.equal(f.enabled, true);
  assert.equal(f.rollout, 0);
  assert.deepEqual(f.overrides, []);
  assert.equal(f.expiresAt, null);
});

test("Flag rejects non-integer rollout", () => {
  assert.throws(() => new Flag({ key: "x", rollout: 50.5 }), /rollout/);
});

test("Flag rejects rollout below 0", () => {
  assert.throws(() => new Flag({ key: "x", rollout: -1 }), /rollout/);
});

test("Flag rejects rollout above 100", () => {
  assert.throws(() => new Flag({ key: "x", rollout: 101 }), /rollout/);
});

test("Flag rejects empty key", () => {
  assert.throws(() => new Flag({ key: "" }), /key/);
});

test("Flag rejects non-finite expiresAt", () => {
  assert.throws(() => new Flag({ key: "x", expiresAt: NaN }), /expiresAt/);
});

test("Flag copies overrides defensively", () => {
  const overrides = [new Override("u1", true)];
  const f = new Flag({ key: "x", overrides });
  overrides.push(new Override("u2", false));
  assert.equal(f.overrides.length, 1);
  assert.equal(f.overrides[0].identifier, "u1");
});

// --- Flag evaluation --------------------------------------------------------

test("0% rollout is off for everyone", () => {
  const f = new Flag({ key: "x", rollout: 0 });
  assert.equal(f.isEnabled("user-1"), false);
});

test("100% rollout is on for everyone", () => {
  const f = new Flag({ key: "x", rollout: 100 });
  assert.equal(f.isEnabled("user-1"), true);
});

test("rollout splits identifiers deterministically", () => {
  // Pick a threshold and verify that the set of enabled users is exactly
  // those whose bucket is below the threshold — no more, no less.
  const rollout = 30;
  const f = new Flag({ key: "split", rollout });
  for (let i = 0; i < 1000; i++) {
    const id = `user-${i}`;
    const expected = bucketFor("split", id) < rollout;
    assert.equal(f.isEnabled(id), expected, `mismatch for ${id}`);
  }
});

test("disabled flag is off for everyone without an override", () => {
  const f = new Flag({ key: "x", rollout: 100, enabled: false });
  assert.equal(f.isEnabled("user-1"), false);
});

test("force:true override wins even when flag is disabled", () => {
  const f = new Flag({
    key: "x",
    rollout: 0,
    enabled: false,
    overrides: [new Override("vip", true)],
  });
  assert.equal(f.isEnabled("vip"), true);
});

test("force:false override wins even at 100% rollout", () => {
  const f = new Flag({
    key: "x",
    rollout: 100,
    overrides: [new Override("blocked", false)],
  });
  assert.equal(f.isEnabled("blocked"), false);
});

test("last matching override wins", () => {
  const f = new Flag({
    key: "x",
    rollout: 0,
    overrides: [
      new Override("u", true),
      new Override("u", false),
      new Override("u", true),
    ],
  });
  assert.equal(f.isEnabled("u"), true);
});

test("override only applies to its own identifier", () => {
  const f = new Flag({
    key: "x",
    rollout: 0,
    overrides: [new Override("u1", true)],
  });
  assert.equal(f.isEnabled("u1"), true);
  assert.equal(f.isEnabled("u2"), false);
});

test("expiresAt in the future keeps the flag on", () => {
  const now = 1000;
  const f = new Flag({ key: "x", rollout: 100, expiresAt: 2000 });
  assert.equal(f.isEnabled("u", now), true);
});

test("expiresAt in the past turns the flag off", () => {
  const now = 3000;
  const f = new Flag({ key: "x", rollout: 100, expiresAt: 2000 });
  assert.equal(f.isEnabled("u", now), false);
});

test("expiresAt exactly at now counts as expired", () => {
  // Deliberate choice: now >= expiresAt means expired. Documented in README.
  const now = 2000;
  const f = new Flag({ key: "x", rollout: 100, expiresAt: 2000 });
  assert.equal(f.isEnabled("u", now), false);
});

test("expiration does not affect a force:true override", () => {
  const now = 3000;
  const f = new Flag({
    key: "x",
    rollout: 100,
    expiresAt: 2000,
    overrides: [new Override("vip", true)],
  });
  assert.equal(f.isEnabled("vip", now), true);
});

test("flag with no expiration uses the provided clock for nothing", () => {
  // Ensures we don't accidentally require a clock when expiresAt is null.
  const f = new Flag({ key: "x", rollout: 100 });
  assert.equal(f.isEnabled("u", 12345), true);
});
