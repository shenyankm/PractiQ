import assert from "node:assert/strict";
import test from "node:test";
import { isUserCacheKey, userCacheKey } from "../src/cache/keys";
import { TERMINAL_AI_STATUSES, isPaymentTerminal, taskPollDelay } from "../src/polling";

test("business caches are isolated by user id", () => {
  const first = userCacheKey(7, "banks:mine");
  const second = userCacheKey(8, "banks:mine");
  assert.notEqual(first, second);
  assert.equal(isUserCacheKey(7, first), true);
  assert.equal(isUserCacheKey(8, first), false);
});

test("AI polling backs off from two to five seconds and knows all terminal states", () => {
  assert.deepEqual([0, 1, 2, 10].map(taskPollDelay), [2000, 3000, 4000, 5000]);
  assert.equal(TERMINAL_AI_STATUSES.has("running"), false);
  for (const status of ["succeeded", "failed", "cancelled", "timed_out"]) assert.equal(TERMINAL_AI_STATUSES.has(status), true);
});

test("payment recovery keeps only pending orders in memory", () => {
  assert.equal(isPaymentTerminal("pending"), false);
  assert.equal(isPaymentTerminal("paid"), true);
  assert.equal(isPaymentTerminal("closed"), true);
  assert.equal(isPaymentTerminal("refunded"), true);
});
