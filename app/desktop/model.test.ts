import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { AiDatabase } from "./ai-database.js";
import { AiSettings, type AiSnapshot } from "./ai-settings.js";
import { ModelClient, modelSchema } from "./model.js";
import { schemaFor } from "./contract-source.js";
import { createHash } from "node:crypto";
const schemaHashes = {
  "UnitParseResult": "33ba531a6d4b5329c4bda94bb7fc9a98ad5f8f137245fbda36394f04f33db64b",
  "GradeResult": "87a325862f2e8470d35736d8c9cb3384a454e3aa2ed0c432e7f42b47ddd55e1f",
  "DocumentCorrections": "51f0ef60694301a05eb53ee45b7398c5e5134830bef8a3f29951f3270f634449",
  "OcrPageParseResult": "cab7fc523e7d5da963b49eae664049539c9a112f8b979d34a3bb5e1cd1342294",
  "PageParseResult": "a1ee810d148650441a3b32c1d1c08a2a01d4b7fad89f550ff6d2af51c4c2dfca"
};

const paths: string[] = [], databases: AiDatabase[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); paths.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
async function setup() {
  const path = mkdtempSync(join(tmpdir(), "practiq-model-")); paths.push(path); const database = new AiDatabase(path); databases.push(database);
  const view = await new AiSettings(path, { isAsyncEncryptionAvailable: async () => false, encryptStringAsync: async () => { throw new Error(); }, decryptStringAsync: async () => { throw new Error(); } }).view();
  const config: AiSnapshot = { revision: view.revision, preferences: { ...view.preferences, model: { ...view.preferences.model, baseUrl: "https://model.example/v1", modelId: "test-model" } }, secrets: { modelApiKey: "PRIVATE_TEST_KEY", tencentSecretId: "", tencentSecretKey: "" } };
  return { database, config, task: database.createTask("a".repeat(64), 10), input: { schema: "ImportSettings", promptVersion: "test-v1", system: "Return structured settings", text: "Document input" } };
}
const completion = (result: unknown) => ({ status: "completed", output: [{ type: "function_call", name: "ImportSettings", arguments: typeof result === "string" ? result : JSON.stringify(result) }], usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 2 } } });

it.each(Object.entries(schemaHashes))("preserves the historical %s model schema and extraction instructions", (name, expectedHash) => {
  const original = schemaFor(name);
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, key === "required" && Array.isArray(child) ? [...child].sort() : normalize(child)])) : value;
  expect(createHash("sha256").update(JSON.stringify(normalize(modelSchema(name)))).digest("hex")).toBe(expectedHash);
  expect(schemaFor(name)).toEqual(original);
});

it("rejects invalid image bytes before recording or sending a paid call", async () => {
  const { database, config, task, input } = await setup(), http = vi.fn(async () => new Response(JSON.stringify(completion(config.preferences.import))));
  const client = new ModelClient(database, http);
  await expect(client.structured(task, "bad-image", { ...input, images: [{ mediaType: "image/png", bytes: Buffer.from("not an image") }] }, config)).rejects.toThrow();
  expect(http).not.toHaveBeenCalled(); expect(database.receipt(task, "bad-image")).toBeNull();
});

it("makes a real bounded loopback Responses call and reuses only an identical successful receipt", async () => {
  const { database, config, task, input } = await setup(); let count = 0;
  const server = createServer(async (request, response) => {
    count++; expect(request.url).toBe("/v1/responses"); expect(request.headers.authorization).toBe("Bearer PRIVATE_TEST_KEY"); expect(database.receipt(task, "one")?.status).toBe("unknown");
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString());
    expect(body).toMatchObject({ store: false, stream: false, parallel_tool_calls: false, tool_choice: { type: "function", name: "ImportSettings" } }); expect(JSON.stringify(body)).not.toContain("PRIVATE_TEST_KEY");
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(completion(config.preferences.import)));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); config.preferences.model.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  try {
    const client = new ModelClient(database), first = await client.structured(task, "one", input, config);
    expect(first).toEqual({ value: config.preferences.import, usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 } });
    expect(await client.structured(task, "one", input, config)).toEqual(first); expect(count).toBe(1);
    await expect(client.structured(task, "one", { ...input, text: "Changed source" }, config)).rejects.toMatchObject({ code: "AI_CALL_CONFLICT" }); expect(count).toBe(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it.each(["duplicate", "usage", "incomplete", "wrong-tool"])("retains known usage and a failed receipt for %s output without retrying", async kind => {
  const { database, config, task, input } = await setup(), body: Record<string, unknown> = completion(config.preferences.import);
  if (kind === "duplicate") (body.output as { arguments: string }[])[0].arguments = '{"tencentConcurrency":1,"tencentConcurrency":2,"readRetryCount":1,"retryBaseSeconds":1}';
  if (kind === "usage") delete body.usage;
  if (kind === "incomplete") body.status = "incomplete";
  if (kind === "wrong-tool") (body.output as { name: string }[])[0].name = "Wrong";
  const http = vi.fn(async () => new Response(JSON.stringify(body))), client = new ModelClient(database, http);
  await expect(client.structured(task, "one", input, config)).rejects.toThrow(); expect(database.receipt(task, "one")?.status).toBe("failed");
  expect(database.receipt(task, "one")?.usage).toEqual(kind === "usage" ? { status: "unknown" } : { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 });
  await expect(client.structured(task, "one", input, config)).rejects.toMatchObject({ code: "AI_CALL_FAILED" }); expect(http).toHaveBeenCalledTimes(1);
});

it.each(["disconnect", "server-error", "error-envelope"])("preserves %s outcomes as unknown and never echoes upstream content", async kind => {
  const { database, config, task, input } = await setup(), http = vi.fn(async () => {
    if (kind === "disconnect") throw new Error("https://private.example?key=PRIVATE_TEST_KEY");
    return new Response(JSON.stringify({ error: { message: "PRIVATE_TEST_KEY" } }), { status: kind === "server-error" ? 500 : 200 });
  }), client = new ModelClient(database, http);
  await expect(client.structured(task, "one", input, config)).rejects.toMatchObject({ code: "AI_RESULT_UNKNOWN" });
  await expect(client.structured(task, "one", input, config)).rejects.not.toThrow("PRIVATE_TEST_KEY"); expect(http).toHaveBeenCalledTimes(1); expect(database.receipt(task, "one")?.status).toBe("unknown");
});

it("persists known usage for fractional integer tokens and never replays their paid call", async () => {
  const { database, config, task, input } = await setup(), http = vi.fn(async () => new Response(JSON.stringify(completion('{"tencentConcurrency":1.0,"readRetryCount":1,"retryBaseSeconds":1.0}')))), client = new ModelClient(database, http);
  await expect(client.structured(task, "strict-integer", input, config)).rejects.toMatchObject({ code: "AI_RESPONSE_INVALID" });
  expect(database.receipt(task, "strict-integer")).toMatchObject({ status: "failed", usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 }, result: { validationCode: "OUTPUT_INVALID" } });
  await expect(client.structured(task, "strict-integer", input, config)).rejects.toMatchObject({ code: "AI_CALL_FAILED" }); expect(http).toHaveBeenCalledTimes(1);
});

import sharp from "sharp";
it("pairs each fixed figure label with its image and enforces the fifty-image boundary before spending", async () => {
  const { database, config, task, input } = await setup(), bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toBuffer(), images = Array.from({ length: 50 }, (_, index) => ({ bytes, mediaType: "image/png" as const, label: `Fixed figure ${index}` }));
  const http = vi.fn(async (_url: string, init: RequestInit) => { const content = JSON.parse(String(init.body)).input[1].content; expect(content).toHaveLength(101); for (let index = 0; index < 50; index++) { expect(content[index * 2 + 1]).toEqual({ type: "input_text", text: `Fixed figure ${index}` }); expect(content[index * 2 + 2].type).toBe("input_image"); } return new Response(JSON.stringify(completion(config.preferences.import))); }), client = new ModelClient(database, http);
  await client.structured(task, "fifty-previews", { ...input, images }, config); expect(http).toHaveBeenCalledTimes(1);
  await expect(client.structured(task, "too-many-previews", { ...input, images: [...images, images[0]] }, config)).rejects.toMatchObject({ code: "AI_INPUT_TOO_LARGE" }); expect(database.receipt(task, "too-many-previews")).toBeNull(); expect(http).toHaveBeenCalledTimes(1);
});
