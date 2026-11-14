import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { RpcWorker } from "./rpc-worker.js";

const directories: string[] = [], clients: RpcWorker[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(clients.splice(0).map(client => client.close())); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "practiq-rpc-close-")); directories.push(directory);
  const path = join(directory, "worker.mjs");
  writeFileSync(path, `import {parentPort,workerData} from 'node:worker_threads';import {writeFileSync} from 'node:fs';import {join} from 'node:path';let gate;parentPort.on('message',message=>{if(message.shutdown){Atomics.store(gate,0,1);while(!Atomics.load(gate,1))Atomics.wait(gate,1,0);writeFileSync(join(workerData.directory,'closed'),'drained');parentPort.close();}else{gate=new Int32Array(message.request.gate);parentPort.postMessage({id:message.id,reply:{ok:true,value:null}});}});`);
  const client = new RpcWorker(pathToFileURL(path), directory, "WORKER_FAILED", "Worker failed"), gate = new Int32Array(new SharedArrayBuffer(8)); clients.push(client); return { directory, client, gate };
}

it("sends one private close handshake, rejects new work and waits for actual worker cleanup", async () => {
  const { directory, client, gate } = fixture(); await client.request({ gate: gate.buffer }); let settled = false;
  const closing = client.close().then(() => { settled = true; }); expect(client.close()).toBe(client.close());
  try {
    await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1)); expect(settled).toBe(false);
    await expect(client.request({ type: "status" })).rejects.toMatchObject({ code: "LOCAL_WORK_UNAVAILABLE" });
  } finally { Atomics.store(gate, 1, 1); Atomics.notify(gate, 1); await closing; }
  expect(readFileSync(join(directory, "closed"), "utf8")).toBe("drained");
});

it("bounds shutdown of an unresponsive worker without starting replacement work", async () => {
  const { client, gate } = fixture(); await client.request({ gate: gate.buffer }); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const closing = client.close(); await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1));
  await vi.advanceTimersByTimeAsync(30000); await closing;
  await expect(client.request({})).rejects.toMatchObject({ code: "LOCAL_WORK_UNAVAILABLE" });
});

it("drains admitted practice writes before closing SQLite and preserves them on restart", async () => {
  const { DatabaseClient } = await import(new URL("../.build/electron/app/desktop/client.js", import.meta.url).href);
  const directory = mkdtempSync(join(tmpdir(), "practiq-rpc-practice-")); directories.push(directory);
  const client = new DatabaseClient(directory); clients.push(client);
  const writes = ["One", "Two", "Three"].map(title => client.request({ type: "save_bank", id: null, title, description: "" })), closing = client.close();
  for (const reply of await Promise.all(writes)) expect(reply.ok).toBe(true); await closing;
  const reopened = new DatabaseClient(directory); clients.push(reopened); const reply = await reopened.request({ type: "banks" }); expect(reply).toMatchObject({ ok: true, value: expect.arrayContaining([expect.objectContaining({ title: "One" }), expect.objectContaining({ title: "Two" }), expect.objectContaining({ title: "Three" })]) });
});
