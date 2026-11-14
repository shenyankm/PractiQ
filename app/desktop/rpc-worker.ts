import { Worker } from "node:worker_threads";
import { AppError } from "./errors.js";
import type { DesktopReply } from "./bridge.js";

export class RpcWorker {
  private readonly worker: Worker;
  private sequence = 0;
  private failure?: Error;
  private closing?: Promise<void>;
  private readonly pending = new Map<number, { resolve: (reply: DesktopReply) => void; reject: (error: Error) => void }>();
  constructor(url: URL, directory: string, code: string, message: string) {
    this.worker = new Worker(url, { workerData: { directory }, env: {} });
    this.worker.on("message", ({ id, reply }: { id: number; reply: DesktopReply }) => { this.pending.get(id)?.resolve(reply); this.pending.delete(id); });
    const fail = () => { this.failure = new AppError(code, message); for (const pending of this.pending.values()) pending.reject(this.failure); this.pending.clear(); };
    this.worker.on("error", fail); this.worker.on("exit", fail);
  }
  request(request: unknown, locale?: string): Promise<DesktopReply> {
    if (this.closing) return Promise.reject(new AppError("LOCAL_WORK_UNAVAILABLE", "Worker is shutting down"));
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, request, locale }); } catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  close(): Promise<void> {
    return this.closing ??= this.failure ? this.worker.terminate().then(() => {}) : new Promise<void>(resolve => {
      // An unresponsive worker may leave unknown receipts; they must never be replayed automatically.
      const timer = setTimeout(() => { void this.worker.terminate(); }, 30000); timer.unref();
      this.worker.once("exit", () => { clearTimeout(timer); resolve(); });
      try { this.worker.postMessage({ shutdown: true }); } catch { void this.worker.terminate(); }
    });
  }
}
