import { expect, it, vi } from "vitest";
import { ProviderSlots } from "./provider-slots.js";

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

it("cancels queued work without releasing a running provider slot", async () => {
  const slots = new ProviderSlots(), running = gate(), first = vi.fn(() => running.promise), cancelled = vi.fn(async () => {}), last = vi.fn(async () => "last"), abort = new AbortController();
  const a = slots.run(1, undefined, first); await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
  const b = slots.run(1, abort.signal, cancelled), rejected = expect(b).rejects.toThrow("cancelled"), c = slots.run(1, undefined, last);
  abort.abort(new Error("cancelled")); await rejected; await Promise.resolve(); expect(last).not.toHaveBeenCalled(); expect(cancelled).not.toHaveBeenCalled();
  running.release(); await a; expect(await c).toBe("last");
});

it("bounds the queue before entering work and drains after provider failures", async () => {
  const slots = new ProviderSlots(), running = gate(), first = slots.run(1, undefined, async () => { await running.promise; throw new Error("provider failed"); });
  const failed = expect(first).rejects.toThrow("provider failed"); await Promise.resolve();
  const work = vi.fn(async () => true), pending = Array.from({ length: 64 }, () => slots.run(1, undefined, work));
  await expect(slots.run(1, undefined, work)).rejects.toMatchObject({ code: "QUEUE_FULL" }); expect(work).not.toHaveBeenCalled();
  running.release(); await failed; expect(await Promise.all(pending)).toEqual(Array(64).fill(true)); expect(work).toHaveBeenCalledTimes(64);
});

it("holds the configured bound across callers and rejects invalid or already aborted entries", async () => {
  const slots = new ProviderSlots(), running = gate(); let active = 0, peak = 0;
  const jobs = Array.from({ length: 5 }, () => slots.run(2, undefined, async () => { peak = Math.max(peak, ++active); await running.promise; active--; }));
  await vi.waitFor(() => expect(active).toBe(2)); expect(peak).toBe(2); running.release(); await Promise.all(jobs); expect(peak).toBe(2);
  const work = vi.fn(async () => {}); await expect(slots.run(0, undefined, work)).rejects.toThrow("concurrency");
  await expect(slots.run(1, AbortSignal.abort(new Error("stopped")), work)).rejects.toThrow("stopped"); expect(work).not.toHaveBeenCalled();
});
