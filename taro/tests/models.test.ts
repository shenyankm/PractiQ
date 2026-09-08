import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalyticsSnapshot } from "../src/api/contracts";
import {
  beginHomeLoad,
  initialHomeState,
  isSnapshotEmpty,
  rejectHomeLoad,
  resolveHomeLoad,
} from "../src/pages/home/model";
import { initialBankState, reduceBankList } from "../src/pages/banks/model";
import { bank } from "./fixtures";

const emptySnapshot: AnalyticsSnapshot = {
  summary: {
    owned_banks: 0,
    favorite_banks: 0,
    attempts: 0,
    correct: 0,
    wrong: 0,
    sessions: 0,
    active_sessions: 0,
    active_imports: 0,
    accuracy: 0,
  },
  recentSessions: [],
  weakQuestions: [],
};

test("home state distinguishes initial loading, empty data, refresh, and retained-data errors", () => {
  const loading = beginHomeLoad(initialHomeState);
  assert.equal(loading.phase, "loading");

  const ready = resolveHomeLoad(loading, emptySnapshot);
  assert.equal(ready.phase, "ready");
  assert.equal(isSnapshotEmpty(ready.data!), true);

  const refreshing = beginHomeLoad(ready);
  assert.equal(refreshing.phase, "refreshing");

  const failedRefresh = rejectHomeLoad(refreshing, "offline");
  assert.equal(failedRefresh.phase, "ready");
  assert.equal(failedRefresh.data, emptySnapshot);
  assert.equal(failedRefresh.error, "offline");
});

test("bank reducer discards expired scope responses", () => {
  const mineLoading = reduceBankList(initialBankState, {
    type: "begin",
    scope: "mine",
    mode: "replace",
    requestId: 1,
  });
  const favoriteLoading = reduceBankList(mineLoading, {
    type: "begin",
    scope: "favorites",
    mode: "replace",
    requestId: 2,
  });
  const staleMine = reduceBankList(favoriteLoading, {
    type: "success",
    scope: "mine",
    mode: "replace",
    requestId: 1,
    items: [bank(1)],
    pagination: { cursor: "mine-next", limit: 30, hasMore: true },
  });

  assert.equal(staleMine, favoriteLoading);

  const favorites = reduceBankList(staleMine, {
    type: "success",
    scope: "favorites",
    mode: "replace",
    requestId: 2,
    items: [bank(2)],
    pagination: { cursor: "", limit: 30, hasMore: false },
  });
  assert.deepEqual(favorites.items.map((item) => item.id), [2]);
  assert.equal(favorites.hasMore, false);
});

test("bank pagination appends unique items and records the next cursor", () => {
  const loaded = reduceBankList(
    reduceBankList(initialBankState, {
      type: "begin",
      scope: "mine",
      mode: "replace",
      requestId: 1,
    }),
    {
      type: "success",
      scope: "mine",
      mode: "replace",
      requestId: 1,
      items: [bank(1)],
      pagination: { cursor: "page-2", limit: 30, hasMore: true },
    },
  );
  const loadingMore = reduceBankList(loaded, {
    type: "begin",
    scope: "mine",
    mode: "append",
    requestId: 2,
  });
  const complete = reduceBankList(loadingMore, {
    type: "success",
    scope: "mine",
    mode: "append",
    requestId: 2,
    items: [bank(1), bank(2)],
    pagination: { cursor: "", limit: 30, hasMore: false },
  });

  assert.deepEqual(complete.items.map((item) => item.id), [1, 2]);
  assert.equal(complete.cursor, "");
  assert.equal(complete.hasMore, false);
});
