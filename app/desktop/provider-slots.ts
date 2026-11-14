import { invariant } from "./errors.js";

interface Waiting { limit: number; enter: () => void; signal?: AbortSignal; abort: () => void }
/** One process-wide queue per provider boundary, including document graphs and grading. */
export class ProviderSlots {
  private active = 0;
  private readonly waiting: Waiting[] = [];
  busy(): boolean { return this.active > 0 || this.waiting.length > 0; }
  async run<T>(limit: number, signal: AbortSignal | undefined, perform: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted(); invariant(Number.isSafeInteger(limit) && limit >= 1 && limit <= 16, "LOCAL_FILTER_INVALID", "Invalid provider concurrency");
    invariant(this.waiting.length < 64, "QUEUE_FULL", "Provider queue is full");
    await new Promise<void>((resolve, reject) => {
      const entry: Waiting = { limit, signal, enter: resolve, abort: () => { const index = this.waiting.indexOf(entry); if (index >= 0) { this.waiting.splice(index, 1); signal?.removeEventListener("abort", entry.abort); reject(signal?.reason); this.drain(); } } };
      this.waiting.push(entry); signal?.addEventListener("abort", entry.abort, { once: true }); if (signal?.aborted) entry.abort(); else this.drain();
    });
    try { signal?.throwIfAborted(); return await perform(); } finally { this.active--; this.drain(); }
  }
  private drain(): void {
    while (this.waiting.length && this.active < this.waiting[0].limit) { const entry = this.waiting.shift()!; entry.signal?.removeEventListener("abort", entry.abort); this.active++; entry.enter(); }
  }
}
export const modelSlots = new ProviderSlots(), tencentSlots = new ProviderSlots();
