import { Worker } from "node:worker_threads";
import { AppError, invariant } from "./errors.js";
import { ProviderSlots } from "./provider-slots.js";

export const preparationSlots = new ProviderSlots();
/** A cancelled helper retains its capacity until exit; queued work never starts a worker. */
export function runPreparation<T>(signal: AbortSignal | undefined, timeoutMs: number, codes: { failed: string; timeout: string }, start: () => Worker, receive: (value: unknown) => T): Promise<T> {
  invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 180000, "LOCAL_FILTER_INVALID", "Invalid preparation deadline");
  return preparationSlots.run(1, signal, async () => {
    let worker: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        worker = start(); abort = () => reject(signal?.reason); signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new AppError(codes.timeout, "Preparation exceeded its time limit")), timeoutMs);
        worker.once("error", () => reject(new AppError(codes.failed, "Preparation worker failed"))); worker.once("exit", () => reject(new AppError(codes.failed, "Preparation worker exited without a result")));
        worker.once("message", value => {
          try { if (value && typeof value === "object" && "error" in value) throw new AppError(typeof value.error === "string" && /^[A-Z0-9_]{1,64}$/.test(value.error) ? value.error : codes.failed, "Preparation did not complete"); signal?.throwIfAborted(); resolve(receive(value)); } catch (error) { reject(error); }
        });
        if (signal?.aborted) abort();
      });
    } finally { clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); if (worker) await worker.terminate(); }
  });
}
