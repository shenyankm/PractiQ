import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { PDFiumModule } from "@hyzyla/pdfium";
import { boundWasmMemory } from "./wasm-memory.js";
import { PDF_RENDER_LIMITS, renderPdf } from "./pdf-render.js";

function pdf(pages: { width: number; height: number; rotate?: number; content?: string }[]): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] >>`];
  for (const [index, page] of pages.entries()) { const text = page.content ?? "0 0 0 rg 10 10 20 20 re f"; objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Rotate ${page.rotate ?? 0} /Resources << >> /Contents ${4 + index * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`); }
  let document = "%PDF-1.7\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(document)); document += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(document); document += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}
const signal = () => new AbortController().signal;
describe("bounded PDFium normalization", () => {
  it.each([{ width: 200, height: 100 }, { width: 200.25, height: 100.75 }, { width: 200, height: 100, rotate: 90 }, { width: 200, height: 100, rotate: 180 }, { width: 200, height: 100, rotate: 270 }])("retains 200 dpi page geometry: %j", async page => {
    const result = await renderPdf(pdf([page]), signal()), rotated = page.rotate === 90 || page.rotate === 270;
    const expected = { width: Math.ceil((rotated ? page.height : page.width) * 200 / 72), height: Math.ceil((rotated ? page.width : page.height) * 200 / 72) };
    expect(result.dimensions).toEqual([expected]); expect(await sharp(result.images[0]).metadata()).toMatchObject({ ...expected, format: "png", channels: 3 });
    const pixels = await sharp(result.images[0]).raw().toBuffer(); expect(pixels.some(value => value === 0)).toBe(true); expect(pixels.some(value => value === 255)).toBe(true);
    expect(result.engine).toMatchObject({ version: 1, packageVersion: "3.0.0", policy: PDF_RENDER_LIMITS }); expect(result.engine.fontsSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("uses trusted macOS fonts for unembedded Chinese text instead of blank pages", async () => {
    const source = readFileSync(new URL("../fixtures/pdf/unembedded-cjk.pdf", import.meta.url)), before = Buffer.from(source), result = await renderPdf(source, signal());
    expect(source).toEqual(before); expect(result.dimensions).toEqual([{ width: 556, height: 278 }]);
    const { data, info } = await sharp(result.images[0]).raw().toBuffer({ resolveWithObject: true });
    for (const [left, right] of [[28, 83], [83, 139], [139, 194], [194, 250]]) { let ink = 0; for (let y = 80; y < 155; y++) for (let x = left; x < right; x++) if (data[(y * info.width + x) * info.channels] < 128) ink++; expect(ink).toBeGreaterThan(150); }
  });
  it("keeps ordered pages and rejects excessive pages or a later oversized page before publication", async () => {
    const source = pdf([{ width: 80, height: 40 }, { width: 40, height: 80 }]), result = await renderPdf(source, signal());
    expect(result.dimensions).toEqual([{ width: 223, height: 112 }, { width: 112, height: 223 }]);
    await expect(renderPdf(source, signal(), { ...PDF_RENDER_LIMITS, maxPages: 1 })).rejects.toMatchObject({ code: "PDF_PAGE_LIMIT_EXCEEDED" });
    await expect(renderPdf(pdf([{ width: 80, height: 40 }, { width: 100000, height: 100000 }]), signal())).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
    await expect(renderPdf(source, signal(), { ...PDF_RENDER_LIMITS, maxBytes: 1 })).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
  });
  it("rejects malformed sources and limits without leaving the serial preparation slot occupied", async () => {
    await expect(renderPdf(Buffer.from("not a PDF"), signal())).rejects.toMatchObject({ code: "PDF_PROCESSING_FAILED" });
    await expect(renderPdf(pdf([{ width: 80, height: 40 }]), signal(), { ...PDF_RENDER_LIMITS, maxPages: 301 })).rejects.toMatchObject({ code: "PDF_ENGINE_INVALID" });
    expect((await renderPdf(pdf([{ width: 80, height: 40 }]), signal())).images).toHaveLength(1);
  });
  it("drains timeouts, active cancellation and queued cancellation before admitting later work", async () => {
    const source = pdf([{ width: 200, height: 100 }]);
    await expect(renderPdf(source, signal(), { ...PDF_RENDER_LIMITS, timeoutMs: 1 })).rejects.toMatchObject({ code: "PDF_PROCESSING_TIMEOUT" });
    const active = new AbortController(), waiting = new AbortController(), first = renderPdf(source, active.signal), second = renderPdf(source, waiting.signal), last = renderPdf(source, signal());
    const firstCheck = expect(first).rejects.toMatchObject({ message: "active cancellation" }), secondCheck = expect(second).rejects.toMatchObject({ message: "queued cancellation" });
    await new Promise(resolve => setTimeout(resolve, 5)); waiting.abort(new Error("queued cancellation")); active.abort(new Error("active cancellation"));
    await Promise.all([firstCheck, secondCheck]); expect((await last).images).toHaveLength(1);
    const cancelled = new AbortController(); cancelled.abort(new Error("already stopped")); await expect(renderPdf(source, cancelled.signal)).rejects.toThrow("already stopped");
  });
  it("enforces a real Wasm memory maximum without allocating the maximum", async () => {
    const source = readFileSync(new URL(import.meta.resolve("@hyzyla/pdfium/pdfium.wasm"))), bounded = boundWasmMemory(source), module = await PDFiumModule({ wasmBinary: bounded });
    const memory = (module.wasmExports as unknown as { memory: WebAssembly.Memory }).memory, pages = memory.buffer.byteLength / 65536;
    expect(WebAssembly.validate(bounded)).toBe(true); expect(() => memory.grow(8193 - pages)).toThrow(RangeError); expect(memory.buffer.byteLength / 65536).toBe(pages);
    expect(() => boundWasmMemory(source, 1)).toThrow(); expect(() => boundWasmMemory(Buffer.from("invalid"))).toThrow(); expect(() => boundWasmMemory(source.subarray(0, 20))).toThrow();
  });
});
