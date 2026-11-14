import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { AppError } from "./errors.js";
import { runPreparation, preparationSlots } from "./preparation.js";
import { officePreparation } from "./office-preparation.js";
import { prepareImage, prepareCrops } from "./image-preparation.js";
import { imageInputs } from "./image-inputs.js";
import { checkedCropFigures } from "./vision-crops.js";
import { renderPdf } from "./pdf-render.js";

const codes = { failed: "PREPARATION_FAILED", timeout: "PREPARATION_TIMEOUT" }, signal = () => new AbortController().signal;
const read = (path: string) => readFileSync(new URL(`../fixtures/${path}`, import.meta.url));
const worker = (code: string, shared?: SharedArrayBuffer) => new Worker(code, { eval: true, env: {}, execArgv: [], workerData: shared, resourceLimits: { maxOldGenerationSizeMb: 64 } });
const blocked = (shared: SharedArrayBuffer) => worker("const {workerData}=require('node:worker_threads');Atomics.store(new Int32Array(workerData),0,1);while(true)Atomics.wait(new Int32Array(workerData),1,0);", shared);

it("does not release capacity or resolve a result before its actual worker exits", async () => {
  let exited = false; const first = runPreparation(signal(), 5000, codes, () => { const value = worker("require('node:worker_threads').parentPort.postMessage(7);while(true){};"); value.on("exit", () => { exited = true; }); return value; }, value => Number(value));
  const last = runPreparation(signal(), 5000, codes, () => { expect(exited).toBe(true); return worker("require('node:worker_threads').parentPort.postMessage(8)"); }, value => Number(value));
  expect(await first).toBe(7); expect(exited).toBe(true); expect(await last).toBe(8); expect(preparationSlots.busy()).toBe(false);
});
it("keeps queued source reads lazy and shares one capacity between Office, PDF and image work", async () => {
  const shared = new SharedArrayBuffer(8), stop = new AbortController(); let exited = false; const holding = runPreparation(stop.signal, 5000, codes, () => { const value = blocked(shared); value.on("exit", () => { exited = true; }); return value; }, value => value), rejected = expect(holding).rejects.toThrow("cancel preparation");
  await vi.waitFor(() => expect(Atomics.load(new Int32Array(shared), 0)).toBe(1));
  const reads: string[] = [], source = (name: string, path: string) => () => { expect(exited).toBe(true); reads.push(name); return read(path); };
  const office = officePreparation(source("office", "office/hidden-slides.ppt"), "ppt", 300, signal()), pdf = renderPdf(source("pdf", "pdf/unembedded-cjk.pdf"), signal()), image = prepareImage(source("image", "images/gray16.png"), signal(), { inputBytes: 8 * 1024 * 1024, maxParts: 300, maxBytes: 50 * 1024 * 1024 });
  await new Promise(resolve => setTimeout(resolve, 10)); expect(reads).toEqual([]); stop.abort(new Error("cancel preparation")); await rejected;
  expect((await office).unchanged).toBe(false); expect((await pdf).images).toHaveLength(1); expect((await image).parts).toHaveLength(1); expect(reads).toEqual(["office", "pdf", "image"]); expect(preparationSlots.busy()).toBe(false);
});
it("cancels queued Office and PDF work before reading sources or creating helpers", async () => {
  const shared = new SharedArrayBuffer(8), active = new AbortController(), queued = new AbortController(), holding = runPreparation(active.signal, 5000, codes, () => blocked(shared), value => value), a = expect(holding).rejects.toThrow("active stop");
  await vi.waitFor(() => expect(Atomics.load(new Int32Array(shared), 0)).toBe(1)); const source = vi.fn(() => read("office/hidden-slides.ppt")), office = officePreparation(source, "ppt", 300, queued.signal), pdf = renderPdf(source, queued.signal), b = expect(office).rejects.toThrow("queued stop"), c = expect(pdf).rejects.toThrow("queued stop");
  queued.abort(new Error("queued stop")); await Promise.all([b, c]); expect(source).not.toHaveBeenCalled(); active.abort(new Error("active stop")); await a; expect(preparationSlots.busy()).toBe(false);
});
it("terminates timeouts and recovers after worker errors, unexpected exits and invalid messages", async () => {
  const shared = new SharedArrayBuffer(8); let exited = false;
  await expect(runPreparation(signal(), 10, codes, () => { const value = blocked(shared); value.on("exit", () => { exited = true; }); return value; }, value => value)).rejects.toMatchObject({ code: "PREPARATION_TIMEOUT" }); expect(exited).toBe(true);
  for (const code of ["throw Error('PRIVATE_KEY_NEVER_EXPOSE')", "process.exit(0)", "require('node:worker_threads').parentPort.postMessage({error:'PRIVATE /path?token=secret'})"]) {
    const failure = await runPreparation(signal(), 5000, codes, () => worker(code), value => value).catch(error => error); expect(failure).toMatchObject({ code: "PREPARATION_FAILED" }); expect(failure.message).not.toMatch(/PRIVATE|token/); expect(preparationSlots.busy()).toBe(false);
  }
  await expect(runPreparation(signal(), 5000, codes, () => worker("require('node:worker_threads').parentPort.postMessage({wrong:true})"), () => { throw new AppError("INVALID_HELPER_RESULT", "Rejected reply"); })).rejects.toMatchObject({ code: "INVALID_HELPER_RESULT" }); expect(preparationSlots.busy()).toBe(false);
  expect((await officePreparation(() => read("office/hidden-slide-mini.ppt"), "ppt", 300, signal())).slides).toHaveLength(1);
});
it("matches the existing image and crop implementations exactly without mutating originals", async () => {
  const bytes = read("images/gray16.png"), before = Buffer.from(bytes), limits = { inputBytes: 8 * 1024 * 1024, maxParts: 300, maxBytes: 50 * 1024 * 1024 };
  expect(await prepareImage(() => bytes, signal(), limits)).toEqual(await imageInputs(bytes, signal(), limits)); expect(bytes).toEqual(before);
  const boxes = [[0, 0, 1, 1], [0, 0, .5, .5]], kinds = [null, "diagram"];
  expect(await prepareCrops(() => bytes, boxes, kinds, signal())).toEqual(await checkedCropFigures(bytes, boxes, kinds, signal())); expect(bytes).toEqual(before); expect(preparationSlots.busy()).toBe(false);
});
