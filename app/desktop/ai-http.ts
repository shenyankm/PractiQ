import { AppError, invariant } from "./errors.js";
import { parseAiJson } from "./ai-json.js";

export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;
export async function responseBytes(response: Response, limit: number): Promise<Buffer> {
  let success = false;
  const reader = response.body?.getReader();
  try {
    const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    invariant(!encoding || encoding === "identity", "AI_RESPONSE_ENCODING", "Compressed provider responses are not accepted");
    const size = response.headers.get("content-length");
    invariant(size === null || /^\d+$/.test(size) && Number(size) <= limit, "AI_RESPONSE_TOO_LARGE", "Provider response exceeds its byte limit");
    if (!reader) { success = true; return Buffer.alloc(0); }
    const chunks: Buffer[] = []; let length = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) { success = true; return Buffer.concat(chunks, length); }
      length += value.length; invariant(length <= limit, "AI_RESPONSE_TOO_LARGE", "Provider response exceeds its byte limit"); chunks.push(Buffer.from(value));
    }
  } finally { if (reader) { if (!success) await reader.cancel().catch(() => {}); reader.releaseLock(); } }
}
export async function jsonResponse(response: Response, limit: number): Promise<unknown> {
  try { return parseAiJson(new TextDecoder("utf-8", { fatal: true }).decode(await responseBytes(response, limit))); }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError("AI_RESPONSE_INVALID", "Provider response is not valid JSON"); }
}
