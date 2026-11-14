import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Annotation, Command, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { CheckpointJson, SqliteCheckpoints } from "./checkpoints.js";

const directories: string[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "practiq-checkpoints-")); directories.push(path); return path; }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("persists a real LangGraph interrupt and resumes it after reopening SQLite", async () => {
  const path = directory(), state = Annotation.Root({ value: Annotation<number>() });
  const builder = new StateGraph(state).addNode("first", () => ({ value: 1 })).addNode("pause", input => ({ value: input.value + Number(interrupt("continue")) })).addEdge(START, "first").addEdge("first", "pause").addEdge("pause", END);
  const first = new SqliteCheckpoints(path), config = { configurable: { thread_id: "thread" } };
  const graph = builder.compile({ checkpointer: first }); const paused = await graph.invoke({ value: 0 }, config);
  expect(paused.__interrupt__).toHaveLength(1); first.close();
  const reopened = new SqliteCheckpoints(path);
  try {
    const resumed = builder.compile({ checkpointer: reopened }); expect((await resumed.getState(config)).values).toMatchObject({ value: 1 });
    expect(await resumed.invoke(new Command({ resume: 2 }), config)).toMatchObject({ value: 3 });
    const history = []; for await (const checkpoint of reopened.list(config)) history.push(checkpoint);
    expect(history.length).toBeGreaterThan(2); expect(history[0].checkpoint.v).toBe(4);
  } finally { reopened.close(); }
});

it("orders pending writes by task path and replaces only special writes on replay", async () => {
  const saver = new SqliteCheckpoints(directory()), checkpoint = { ...emptyCheckpoint(), id: "one" }, metadata = { source: "input" as const, step: 0, parents: {} }, config = { configurable: { thread_id: "thread" } };
  try {
    const saved = await saver.put(config, checkpoint, metadata);
    await saver.putWrites(saved, [["value", "first"]], "task", "😀"); await saver.putWrites(saved, [["value", "replacement"]], "task", "😀");
    await saver.putWrites(saved, [["value", "earlier"]], "other", "\uE000");
    await saver.putWrites(saved, [["__error__", "old"]], "failed"); await saver.putWrites(saved, [["__error__", "new"]], "failed");
    expect((await saver.getTuple(saved))!.pendingWrites).toEqual([["failed", "__error__", "new"], ["other", "value", "earlier"], ["task", "value", "first"]]);
    await saver.deleteThread("thread"); expect(await saver.getTuple(config)).toBeUndefined(); expect(saver.db.prepare("SELECT COUNT(*) AS count FROM checkpoint_writes").get()!.count).toBe(0);
  } finally { saver.close(); }
});

it("serializes plain document data without constructing classes or polluting prototypes", async () => {
  const serde = new CheckpointJson(), source = JSON.parse('{"__proto__":{"polluted":true},"lc":1,"type":"constructor","id":["langchain","secret"],"kwargs":{"apiKey":"OPENAI_API_KEY"}}');
  source.missing = undefined; source.values = [undefined, null, false, 0];
  const [type, bytes] = await serde.dumpsTyped(source), copy = await serde.loadsTyped(type, bytes);
  expect(copy).toEqual(source); expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  await expect(serde.dumpsTyped(new Date())).rejects.toThrow("plain JSON"); await expect(serde.loadsTyped("json", bytes)).rejects.toThrow("Unsupported");
});

it("refuses unknown checkpoint databases without changing their bytes", () => {
  const path = directory(), file = join(path, "ai-checkpoints-v1.sqlite"), db = new DatabaseSync(file); db.exec("CREATE TABLE unknown(value)"); db.close();
  const original = readFileSync(file); expect(() => new SqliteCheckpoints(path)).toThrow("Unsupported checkpoint"); expect(readFileSync(file)).toEqual(original);
});
