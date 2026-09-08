import assert from "node:assert/strict";
import { test } from "node:test";
import { requiresLogin } from "../src/auth/guard";
import { MemorySessionStore } from "../src/auth/session";
import { authPayload } from "./fixtures";

test("protected routes redirect on cold start and allow an in-memory session", () => {
  const store = new MemorySessionStore();
  assert.equal(requiresLogin(store.getSnapshot()), true);
  store.replace(authPayload());
  assert.equal(requiresLogin(store.getSnapshot()), false);
  store.clear();
  assert.equal(requiresLogin(store.getSnapshot()), true);
});
