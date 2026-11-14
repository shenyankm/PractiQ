import { randomUUID } from "node:crypto";
import type { DesktopMaintenanceCandidate, DesktopMaintenancePreview, DesktopMaintenanceReceipt, DesktopMaintenanceRequest } from "../src/contracts.generated.js";
import { validateContract } from "./contracts.js";
import { unreadableEvidence } from "./document-diagnostics.js";
import type { DocumentRuntime } from "./document-runtime.js";
import { invariant } from "./errors.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const namespace = ["document_maintenance"];
type Candidate = DesktopMaintenanceCandidate & { fingerprint: string | null };
interface Plan { expires: number; candidates: Candidate[] }
interface Journal { version: 1; requestId: string; previewId: string; status: "pending" | "completed"; candidates: Candidate[]; completed: string[] }

/** Explicit, bounded task-state cleanup. Shared bytes and paid receipts never belong to this namespace. */
export class DocumentMaintenance {
  private readonly previews = new Map<string, Plan>();
  private running?: { requestId: string; previewId: string; done: Promise<DesktopMaintenanceReceipt> };
  constructor(private readonly runtime: DocumentRuntime, private readonly idle: (preview?: boolean) => boolean) {}
  busy(): boolean { return Boolean(this.running); }
  async settle(): Promise<void> { await this.running?.done.catch(() => {}); }
  private exists(id: string): boolean { return Boolean(this.runtime.tasks.db.prepare("SELECT 1 FROM document_tasks WHERE id=?").get(id)); }
  private journal(requestId: string): Journal | null {
    const item = this.runtime.store.read(namespace, requestId); if (!item) return null;
    const value = item.value as unknown as Journal;
    invariant(value.version === 1 && value.requestId === requestId && uuid.test(value.requestId) && uuid.test(value.previewId) && ["pending", "completed"].includes(value.status) && Object.keys(value).sort().join() === "candidates,completed,previewId,requestId,status,version" && Array.isArray(value.candidates) && value.candidates.length > 0 && value.candidates.length <= 100 && Array.isArray(value.completed) && new Set(value.completed).size === value.completed.length, "MAINTENANCE_RECEIPT_INVALID", "Saved cleanup receipt is unreadable; it remains unchanged");
    for (const candidate of value.candidates) {
      const { fingerprint, ...publicValue } = candidate; validateContract("DesktopMaintenanceCandidate", publicValue);
      invariant(uuid.test(candidate.threadId) && (candidate.kind === "orphan" ? fingerprint === null : typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint)), "MAINTENANCE_RECEIPT_INVALID", "Saved cleanup candidate is invalid");
    }
    const ids = new Set(value.candidates.map(candidate => candidate.threadId));
    invariant(ids.size === value.candidates.length && value.completed.every(id => ids.has(id)) && (value.status !== "completed" || ids.size === value.completed.length), "MAINTENANCE_RECEIPT_INVALID", "Saved cleanup progress is invalid"); return value;
  }
  async preview(): Promise<DesktopMaintenancePreview> {
    invariant(!this.busy(), "MAINTENANCE_BUSY", "Wait for task-state cleanup to finish");
    const now = Date.now(), candidates = new Map<string, Candidate>(); let skipped = 0, more = false;
    const add = (candidate: Candidate) => { if (candidates.has(candidate.threadId)) return; if (candidates.size === 100) { more = true; return; } candidates.set(candidate.threadId, candidate); };
    for (const row of this.runtime.tasks.db.prepare("SELECT id FROM document_tasks ORDER BY created_at,id").iterate()) {
      try { const candidate = this.runtime.tasks.cleanupCandidate(String(row.id), now); if (candidate) add(candidate); }
      catch (error) { if (!unreadableEvidence(error)) throw error; skipped++; }
      if (more) break;
    }
    if (!more) for (const row of this.runtime.checkpoints.db.prepare("SELECT thread_id FROM checkpoints UNION SELECT thread_id FROM checkpoint_writes ORDER BY thread_id").iterate()) {
      const thread = String(row.thread_id), id = thread.startsWith("document:") ? thread.slice(9) : "";
      if (!uuid.test(id)) { skipped++; continue; }
      if (!this.exists(id)) add({ threadId: id, kind: "orphan", fileName: null, fingerprint: null }); if (more) break;
    }
    if (!more) for (const row of this.runtime.store.db.prepare("SELECT DISTINCT namespace FROM store_items ORDER BY namespace").iterate()) {
      const path: unknown = JSON.parse(String(row.namespace)); if (!Array.isArray(path) || path[0] !== "document_tasks") continue;
      const id = path[1]; if (typeof id !== "string" || !uuid.test(id)) { skipped++; continue; }
      if (!this.exists(id)) add({ threadId: id, kind: "orphan", fileName: null, fingerprint: null }); if (more) break;
    }
    const pending = await this.runtime.store.search(namespace, { filter: { status: "pending" }, limit: 21 });
    invariant(pending.length <= 20, "MAINTENANCE_HISTORY_LIMIT", "Resolve unfinished cleanup batches before starting another");
    const previewId = randomUUID(), expires = now + 10 * 60_000;
    for (const [id, plan] of this.previews) if (plan.expires <= now) this.previews.delete(id);
    if (this.previews.size >= 8) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(previewId, { expires, candidates: [...candidates.values()] });
    const value: DesktopMaintenancePreview = { previewId, expiresAt: new Date(expires).toISOString(), candidates: [...candidates.values()].map(({ fingerprint: _fingerprint, ...candidate }) => candidate), hasMore: more, skipped, canClean: this.idle(true), pending: pending.map(item => { const saved = this.journal(item.key)!; return { requestId: saved.requestId, previewId: saved.previewId, completed: saved.completed.length, total: saved.candidates.length }; }) };
    validateContract("DesktopMaintenancePreview", value); return value;
  }
  run(input: unknown): Promise<DesktopMaintenanceReceipt> {
    validateContract("DesktopMaintenanceRequest", input); const request = structuredClone(input) as DesktopMaintenanceRequest;
    request.requestId = request.requestId.toLowerCase(); request.previewId = request.previewId.toLowerCase();
    if (this.running) { invariant(this.running.requestId === request.requestId && this.running.previewId === request.previewId, "MAINTENANCE_BUSY", "Another cleanup batch is running"); return this.running.done; }
    const done = this.perform(request).finally(() => { this.running = undefined; }); this.running = { ...request, done }; return done;
  }
  private verify(candidate: Candidate, resume: boolean): void {
    if (!this.exists(candidate.threadId)) { invariant(candidate.kind === "orphan" || resume, "MAINTENANCE_PREVIEW_STALE", "Reviewed task changed; inspect cleanup again"); return; }
    invariant(candidate.kind !== "orphan", "MAINTENANCE_PREVIEW_STALE", "An orphan now belongs to a task; inspect cleanup again");
    const current = this.runtime.tasks.cleanupCandidate(candidate.threadId, Date.now());
    invariant(current && current.fingerprint === candidate.fingerprint, "MAINTENANCE_PREVIEW_STALE", "Reviewed task changed; inspect cleanup again");
  }
  private async perform(request: DesktopMaintenanceRequest): Promise<DesktopMaintenanceReceipt> {
    let saved = this.journal(request.requestId);
    invariant(!saved || saved.previewId === request.previewId, "REQUEST_CONFLICT", "Cleanup request ID belongs to another preview");
    if (saved?.status === "completed") return { ...request, cleaned: saved.completed.length };
    invariant(this.idle(), "MAINTENANCE_BUSY", "Stop AI work, exports and source repairs before task-state cleanup");
    if (!saved) {
      invariant((await this.runtime.store.search(namespace, { filter: { status: "pending" }, limit: 1 })).length === 0, "MAINTENANCE_PENDING", "Explicitly finish the pending cleanup batch before starting another");
      const plan = this.previews.get(request.previewId); invariant(plan && Date.now() < plan.expires && plan.candidates.length > 0, "MAINTENANCE_PREVIEW_STALE", "Cleanup preview expired or is empty; inspect it again");
      for (const candidate of plan.candidates) this.verify(candidate, false);
      saved = { version: 1, ...request, status: "pending", candidates: structuredClone(plan.candidates), completed: [] };
      await this.runtime.store.put(namespace, request.requestId, saved);
    }
    for (const candidate of saved.candidates) {
      if (saved.completed.includes(candidate.threadId)) continue;
      this.verify(candidate, true); await this.runtime.delete(candidate.threadId);
      saved.completed.push(candidate.threadId); await this.runtime.store.put(namespace, request.requestId, saved);
    }
    saved.status = "completed"; await this.runtime.store.put(namespace, request.requestId, saved);
    const receipt = { ...request, cleaned: saved.completed.length }; validateContract("DesktopMaintenanceReceipt", receipt); return receipt;
  }
}
