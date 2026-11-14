import { parentPort, workerData } from "node:worker_threads";
import { AiDatabase } from "./ai-database.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { ModelClient } from "./model.js";
import { TencentClient } from "./tencent.js";
import { AppError, invariant } from "./errors.js";
import type { AiWorkerRequest } from "./ai-client.js";
import { subjectiveGrade } from "./subjective-grade.js";
import { AiStorage } from "./ai-storage.js";
import { SourceTickets } from "./source-tickets.js";
import { DocumentApi } from "./document-api.js";
import { savedCostPolicy } from "./ai-settings.js";

const database = new AiDatabase(workerData.directory), checkpoints = new SqliteCheckpoints(workerData.directory), model = new ModelClient(database), tencent = new TencentClient(database);
const sources = new SourceTickets(new AiStorage(workerData.directory));
const documents = new DocumentApi(workerData.directory, database, checkpoints, model, tencent, required => savedCostPolicy(workerData.directory, required));
invariant(parentPort, "AI_RUNTIME_UNAVAILABLE", "AI worker has no parent"); const port = parentPort;
const requests = new Set<Promise<void>>(); let closing: Promise<void> | undefined;
const close = () => closing ??= documents.close([...requests]).finally(() => { checkpoints.close(); database.close(); port.close(); });
async function request(input: AiWorkerRequest): Promise<unknown> {
  invariant(input && typeof input === "object" && !Array.isArray(input), "LOCAL_FILTER_INVALID", "Invalid AI operation");
  invariant(!documents.maintenance.busy() || input.type === "document" || input.type === "status", "MAINTENANCE_BUSY", "Wait for task-state cleanup to finish");
  switch (input.type) {
    case "status": return { ready: true, tasks: Number(database.db.prepare("SELECT COUNT(*) AS count FROM ai_tasks").get()!.count), unknownCalls: Number(database.db.prepare("SELECT COUNT(*) AS count FROM ai_calls WHERE status='unknown'").get()!.count) };
    case "pick_sources": return sources.pick(input.paths, input.revision);
    case "upload_source": return sources.upload(input.ticket, input.revision);
    case "document": return documents.request(input.request, input.config);
    case "repair_source": return documents.repairSource(input.threadId, input.value, input.path);
    case "export_bank_zip": return documents.exportBankZip(input.value, input.config, input.path);
    case "create_task": return database.createTask(input.sourceDigest, input.maxCalls);
    case "structured": return model.structured(input.taskId, input.key, input.input, input.config);
    case "grade": return subjectiveGrade(database, model, input.prepared, input.config);
    case "tencent_submit": return tencent.submit(input.taskId, input.key, input.source, input.config);
    case "tencent_query": return tencent.query(input.taskId, input.key, input.config);
    default: throw new AppError("LOCAL_FILTER_INVALID", "Unsupported AI operation");
  }
}
port.on("message", (message: { shutdown: true } | { id: number; request: AiWorkerRequest }) => {
  if ("shutdown" in message) { void close().catch(() => port.close()); return; }
  if (closing) return;
  const { id, request: input } = message;
  const work = request(input).then(value => port.postMessage({ id, reply: { ok: true, value } })).catch(error => port.postMessage({ id, reply: { ok: false, error: error instanceof AppError ? error.toJSON() : { code: "AI_OPERATION_FAILED", message: "AI operation failed" } } }));
  requests.add(work); void work.finally(() => requests.delete(work)).catch(() => {});
});
port.on("close", () => { void close().catch(() => {}); });
