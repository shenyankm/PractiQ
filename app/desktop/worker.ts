import { parentPort, workerData } from "node:worker_threads";
import { PracticeStore } from "./store.js";
import { AppError, invariant } from "./errors.js";

const store = new PracticeStore(workerData.directory);
invariant(parentPort, "OPERATION_FAILED", "Database worker has no parent");
const port = parentPort;
let queue = Promise.resolve();
let closing: Promise<void> | undefined;
const close = () => closing ??= queue.finally(() => { store.close(); port.close(); });
port.on("message", (input: { shutdown: true } | { id: number; request: unknown; locale?: string }) => {
  if ("shutdown" in input) { void close().catch(() => port.close()); return; }
  if (closing) return;
  const { id, request, locale } = input;
  queue = queue.then(async () => {
    try { port.postMessage({ id, reply: { ok: true, value: await store.request(request, locale) } }); }
    catch (error) {
      port.postMessage({ id, reply: { ok: false, error: error instanceof AppError ? error.toJSON() : { code: "OPERATION_FAILED", message: "Local operation failed" } } });
    }
  });
});
port.on("close", () => { void close().catch(() => {}); });
