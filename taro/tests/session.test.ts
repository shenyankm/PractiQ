import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySessionStore } from "../src/auth/session";
import { authPayload } from "./fixtures";

test("memory session replaces tokens atomically and notifies subscribers", () => {
  const store = new MemorySessionStore();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });

  const first = store.replace(authPayload("first", "refresh-first"));
  const second = store.replace(authPayload("second", "refresh-second"));

  assert.equal(first.tokens.accessToken, "first");
  assert.equal(second.tokens.accessToken, "second");
  assert.equal(store.getSnapshot()?.tokens.refreshToken, "refresh-second");
  assert.equal(notifications, 2);

  store.clear();
  assert.equal(store.getSnapshot(), null);
  assert.equal(notifications, 3);
  unsubscribe();
});

test("a fresh store never restores a previous process session", () => {
  const firstProcess = new MemorySessionStore();
  firstProcess.replace(authPayload());

  const coldStart = new MemorySessionStore();
  assert.equal(coldStart.getSnapshot(), null);
});
