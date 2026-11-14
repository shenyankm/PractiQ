import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Annotation, END, START, StateGraph, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { SqliteStore } from "./graph-store.js";
import { SqliteCheckpoints } from "./checkpoints.js";

const paths: string[] = [], stores: SqliteStore[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "practiq-graph-store-")); paths.push(path); return path; }
function open(path = directory()) { const store = new SqliteStore(path); stores.push(store); return store; }
afterEach(() => { stores.splice(0).forEach(store => store.stop()); paths.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });

it("persists namespace/key identity, nulls and timestamps without sharing mutable result objects", async () => {
  const path = directory(), store = open(path), namespace = ["document_tasks", "task", "units"], value = JSON.parse('{"__proto__":{"polluted":true},"result":null,"constructor":{"lc":1}}');
  await store.put(namespace, "unit", value, false); const first = (await store.get(namespace, "unit"))!; expect(first.value).toEqual(value); first.value.result = "mutated"; first.namespace[0] = "mutated";
  expect((await store.get(namespace, "unit"))!.value.result).toBeNull(); expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  await store.put(namespace, "unit", { ...value, updated: true }); const second = (await store.get(namespace, "unit"))!; expect(second.createdAt).toEqual(first.createdAt); expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
  store.stop(); const reopened = open(path); expect((await reopened.get(namespace, "unit"))!.value).toMatchObject({ updated: true, result: null });
});

it("gives every batch read the pre-write snapshot and rolls back invalid batches", async () => {
  const store = open(); await store.put(["scope"], "key", { value: "original" });
  const results = await store.batch([{ namespace: ["scope"], key: "key", value: { value: "next" } }, { namespace: ["scope"], key: "key" }, { namespacePrefix: ["scope"] }]);
  expect((results[1] as { value: unknown }).value).toEqual({ value: "original" }); expect((results[2] as { value: unknown }[])[0].value).toEqual({ value: "original" }); expect((await store.get(["scope"], "key"))!.value).toEqual({ value: "next" });
  await expect(store.batch([{ namespace: ["scope"], key: "key", value: { value: "discard" } }, { namespace: ["scope"], key: "bad", value: { value: Number.NaN } }])).rejects.toThrow(); expect((await store.get(["scope"], "key"))!.value).toEqual({ value: "next" }); expect(await store.get(["scope"], "bad")).toBeNull();
});

it("supports literal namespace prefixes, JSON filters and stable pagination", async () => {
  const store = open();
  await store.put(["task", "a%_"], "one", { state: "done", score: 1, metadata: { a: 1, b: null } }); await store.put(["task", "a%_", "child"], "two", { state: "done", score: 2 }); await store.put(["task", "other"], "three", { state: "failed", score: 3 }); await store.put(["task-extra"], "four", { score: 4 });
  expect((await store.search(["task", "a%_"], { limit: 10 })).map(item => item.key).sort()).toEqual(["one", "two"]);
  expect((await store.search(["task"], { filter: { score: { $gte: 2, $lt: 4 }, state: { $in: ["done", "failed"] } }, limit: 1, offset: 1 }))).toHaveLength(1);
  expect((await store.search(["task"], { filter: { metadata: { b: null, a: 1 } } })).map(item => item.key)).toEqual(["one"]);
  expect(await store.search(["task"], { filter: { score: { $gt: 50 } } })).toEqual([]); expect((await store.search([], { filter: { state: { $ne: "done" } } })).map(item => item.key).sort()).toEqual(["four", "three"]);
  expect(await store.search([], { limit: 0 })).toEqual([]); await expect(store.search(["missing"], { filter: { score: { $execute: "unsafe" } } })).rejects.toThrow();
});

it("lists namespaces with prefix/suffix wildcards and depth deduplication", async () => {
  const store = open(); for (const namespace of [["task", "one", "units"], ["task", "one", "calls"], ["task", "two", "units"], ["other"]]) await store.put(namespace, "key", {});
  expect(await store.listNamespaces({ prefix: ["task"], maxDepth: 2 })).toEqual([["task", "one"], ["task", "two"]]);
  expect(await store.listNamespaces({ prefix: ["task", "*"], suffix: ["units"] })).toEqual([["task", "one", "units"], ["task", "two", "units"]]);
  expect(await store.listNamespaces({ prefix: ["task"], maxDepth: 0 })).toEqual([[]]); await store.delete(["other"], "key"); expect(await store.listNamespaces({ prefix: ["other"] })).toEqual([]);
});

it("performs read/modify/write atomically across independent connections", async () => {
  const path = directory(), first = open(path), second = open(path);
  await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? first : second).update(["budget"], "unit", value => ({ spent: Number(value?.spent ?? 0) + 1 }))));
  expect((await first.get(["budget"], "unit"))!.value.spent).toBe(20);
});

it("reads only the exact namespace and refuses corrupt values or closed storage", async () => {
  const store = open(); await store.put(["budget"], "one", { spent: 1 }); await store.put(["budget", "other"], "two", { spent: 2 });
  expect(store.readNamespace(["budget"]).map(item => item.key)).toEqual(["one"]); expect(store.readNamespace(["absent"])).toEqual([]);
  store.db.prepare("UPDATE store_items SET value='[]' WHERE key='one'").run(); expect(() => store.readNamespace(["budget"])).toThrow(); store.stop(); expect(() => store.readNamespace(["budget"])).toThrow();
});

it("never silently truncates a full namespace at the accounting limit", () => {
  const store = open(); store.db.exec(`WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<10000) INSERT INTO store_items SELECT '["budget"]',printf('%05d',n),'{}',0,0 FROM rows`);
  expect(store.readNamespace(["budget"])).toHaveLength(10000); store.db.prepare("INSERT INTO store_items VALUES('[\"budget\"]','extra','{}',0,0)").run(); expect(() => store.readNamespace(["budget"])).toThrow(); expect(store.db.prepare("SELECT count(*) AS n FROM store_items").get()!.n).toBe(10001);
});

it.each(["undefined", "date", "cycle", "unsafe-number", "function", "accessor"])("rejects %s values without publishing a partial write", async kind => {
  const store = open(), cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; let invoked = false;
  const value = kind === "undefined" ? { value: undefined } : kind === "date" ? { value: new Date() } : kind === "cycle" ? cyclic : kind === "unsafe-number" ? { value: 1e20 } : kind === "function" ? { value: () => 1 } : { get value() { invoked = true; return "unexpected"; } };
  await expect(store.put(["scope"], "key", value)).rejects.toThrow(); expect(await store.get(["scope"], "key")).toBeNull(); expect(invoked).toBe(false);
});

it("rejects invalid identities and unconfigured semantic operations without network work", async () => {
  const store = open();
  for (const namespace of [[], ["contains.period"], ["contains:colon"], ["langgraph"]]) await expect(store.put(namespace, "key", {})).rejects.toThrow();
  await expect(store.put(["scope"], "key", {}, ["text"])).rejects.toMatchObject({ code: "STORE_INDEX_UNSUPPORTED" }); await expect(store.search(["scope"], { query: "invoke embeddings" })).rejects.toMatchObject({ code: "STORE_QUERY_UNSUPPORTED" }); expect(await store.search([])).toEqual([]);
  store.stop(); await expect(store.get(["scope"], "key")).rejects.toMatchObject({ code: "EXECUTION_STORE_UNAVAILABLE" });
});

it("uses the persisted Store through an actual LangGraph.js node after a checkpoint restart", async () => {
  const path = directory(), first = open(path), state = Annotation.Root({ done: Annotation<boolean>() });
  const builder = new StateGraph(state).addNode("save", async (_state, config: LangGraphRunnableConfig) => { await config.store!.put(["task", "units"], "one", { complete: true }, false); return { done: false }; }).addNode("read", async (_state, config: LangGraphRunnableConfig) => ({ done: (await config.store!.get(["task", "units"], "one"))!.value.complete === true })).addEdge(START, "save").addEdge("save", "read").addEdge("read", END);
  const checkpoints = new SqliteCheckpoints(path), config = { configurable: { thread_id: "store-integration" } };
  try { await builder.compile({ checkpointer: checkpoints, store: first, interruptBefore: ["read"] }).invoke({ done: false }, config); first.stop(); const reopened = open(path); expect(await builder.compile({ checkpointer: checkpoints, store: reopened }).invoke(null, config)).toMatchObject({ done: true }); }
  finally { checkpoints.close(); }
});

it("preserves unknown nonempty Store databases without mutation", () => {
  const path = directory(), file = join(path, "ai-store-v1.sqlite"), unknown = new DatabaseSync(file); unknown.exec("CREATE TABLE keep(value TEXT); INSERT INTO keep VALUES('retained')"); unknown.close(); const bytes = readFileSync(file);
  expect(() => new SqliteStore(path)).toThrow("Unsupported LangGraph.js Store"); expect(readFileSync(file)).toEqual(bytes);
});
