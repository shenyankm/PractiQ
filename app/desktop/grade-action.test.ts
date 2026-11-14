import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { PracticeStore } from "./store.js";
import { previewPaper } from "./paper.js";
import { gradeAction } from "./grade-action.js";
import type { AiSnapshot } from "./ai-settings.js";

function seed(directory: string): string {
  const store = new PracticeStore(directory);
  try {
    const bank = store.saveBank(null, "Worker grade", "");
    store.request({ type: "save_question_tree", bank_id: bank, root_id: null, questions: [{ id: "one", stem: "Explain", questionTypeId: "简答", answerMode: "short_answer", answerPayload: { text: "Reference evidence" }, sourceScore: 5, scoringRubric: "Reference evidence", sourceText: "Original source", needsReview: false }] });
    const preview = previewPaper(store.db, store.assets, { bank_ids: [bank], search: "", mode: "", filter: "", selection: "manual", count: 0, quotas: {}, question_ids: ["one"], random: false, total_cents: 1000 });
    const session = store.sessions.createPaper({ question_ids: preview.questionIds, kind: "self_test", minutes: null, scores: preview.scores, total_cents: 1000, digest: preview.digest });
    store.sessions.writeAttempt(session.id, 0, { text: "Student answer" }, 0, false, false); store.sessions.submit(session.id, true); return session.id;
  } finally { store.close(); }
}
const snapshot = (baseUrl: string): AiSnapshot => ({ revision: randomUUID(), preferences: { model: { provider: "openai", baseUrl, modelId: "test", maxOutputTokens: 1000, timeoutSeconds: 5 }, import: { tencentConcurrency: 2, readRetryCount: 1, retryBaseSeconds: 1 }, maxCalls: 10, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "TEST_PRIVATE_KEY", tencentSecretId: "", tencentSecretKey: "" } });
function finish(response: ServerResponse) {
  response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ status: "completed", output: [{ type: "function_call", name: "GradeResult", arguments: JSON.stringify({ scoreCents: 300, maxCents: 500, reason: "Partial credit", evidence: [], reviewReasons: [], criteria: [{ criterion: "Reference", scoreCents: 300, maxCents: 500, referenceQuote: "Reference evidence", answerQuote: "Student answer", reason: "Compared the supplied evidence" }] }) }], usage: { input_tokens: 10, output_tokens: 5 } }));
}
async function clients(directory: string) {
  const { AiClient } = await import(fileURLToPath(new URL("../.build/electron/app/desktop/ai-client.js", import.meta.url))), { DatabaseClient } = await import(fileURLToPath(new URL("../.build/electron/app/desktop/client.js", import.meta.url)));
  return { AiClient, database: new DatabaseClient(directory), ai: new AiClient(directory) };
}

it("makes one real worker grading call while offline edits continue and preserves a concurrent manual decision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "practiq-grade-workers-")), id = seed(directory), { database, ai } = await clients(directory);
  let response: ServerResponse | undefined, arrived!: () => void, calls = 0;
  const requested = new Promise<void>(resolve => { arrived = resolve; });
  const server = createServer((request, reply) => { calls++; expect(request.headers.authorization).toBe("Bearer TEST_PRIVATE_KEY"); response = reply; arrived(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = snapshot(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`), settings = { snapshot: async () => config }, request = { type: "grade", id, ordinal: 0, retry: false };
  writeFileSync(join(directory, "electron-ai-settings-v1.json"), JSON.stringify({ version: 1, revision: config.revision, preferences: config.preferences, secrets: { modelApiKey: null, tencentSecretId: null, tencentSecretKey: null } }));
  try {
    const pending = gradeAction(request, "en", settings, database, () => ai); await requested;
    const practiceCopy = new DatabaseSync(join(directory, "practiq.sqlite"), { readOnly: true });
    try { expect(JSON.parse(String(practiceCopy.prepare("SELECT response FROM grade_requests").get()!.response)).status).toBe("unknown"); expect(String(practiceCopy.prepare("SELECT input FROM grade_requests").get()!.input)).not.toContain("TEST_PRIVATE_KEY"); } finally { practiceCopy.close(); }
    expect((await gradeAction(request, "zh-CN", settings, database, () => ai)).attempts[0].grading?.lastRequest?.status).toBe("unknown"); expect(calls).toBe(1);
    expect(await database.request({ type: "save_bank", id: null, title: "Still works", description: "" })).toMatchObject({ ok: true });
    expect(await database.request({ type: "manual_score", id, ordinal: 0, cents: 800, reason: "Manual review" })).toMatchObject({ ok: true });
    finish(response!); expect((await pending).attempts[0]).toMatchObject({ earnedCents: 800, gradeKind: "manual", grading: { ai: { result: { scoreCents: 600, assessmentMaxCents: 500 } } } });
    expect(await ai.call({ type: "status" })).toMatchObject({ tasks: 1, unknownCalls: 0 });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await ai.close(); await database.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("does not replay an unknown paid result after worker restart and permits only an explicit new retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "practiq-grade-retry-")), id = seed(directory), { database, ai: initial, AiClient } = await clients(directory); let ai = initial, calls = 0;
  const server = createServer((request, response) => { calls++; if (calls === 1) request.socket.destroy(); else finish(response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = snapshot(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`), settings = { snapshot: async () => config }, request = { type: "grade", id, ordinal: 0, retry: false };
  writeFileSync(join(directory, "electron-ai-settings-v1.json"), JSON.stringify({ version: 1, revision: config.revision, preferences: config.preferences, secrets: { modelApiKey: null, tencentSecretId: null, tencentSecretKey: null } }));
  try {
    expect((await gradeAction(request, "en", settings, database, () => ai)).attempts[0]).toMatchObject({ earnedCents: null, grading: { lastRequest: { status: "unknown" } } }); expect(calls).toBe(1);
    await ai.close(); ai = new AiClient(directory); const runtime = vi.fn(() => ai);
    expect((await gradeAction(request, "en", settings, database, runtime)).attempts[0].grading?.lastRequest?.status).toBe("unknown"); expect(runtime).not.toHaveBeenCalled(); expect(calls).toBe(1);
    expect((await gradeAction({ ...request, retry: true }, "en", settings, database, runtime)).attempts[0]).toMatchObject({ earnedCents: 600, gradeKind: "ai" }); expect(calls).toBe(2);
    expect(await ai.call({ type: "status" })).toMatchObject({ tasks: 2, unknownCalls: 1 });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await ai.close(); await database.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("rejects unexpected grading fields before loading secrets or creating native receipts", async () => {
  const settings = { snapshot: vi.fn() }, database = { request: vi.fn() }, runtime = vi.fn();
  await expect(gradeAction({ type: "grade", id: "session", ordinal: 0, retry: false, endpoint: "https://attacker.example" }, "en", settings, database, runtime)).rejects.toMatchObject({ code: "LOCAL_FILTER_INVALID" });
  expect(settings.snapshot).not.toHaveBeenCalled(); expect(database.request).not.toHaveBeenCalled(); expect(runtime).not.toHaveBeenCalled();
});

it("does not record uncertainty or start workers for an unconfigured model", async () => {
  const settings = { snapshot: async () => snapshot("") }, database = { request: vi.fn() }, runtime = vi.fn();
  await expect(gradeAction({ type: "grade", id: "session", ordinal: 0, retry: false }, "en", settings, database, runtime)).rejects.toMatchObject({ code: "LOCAL_MODEL_URL_REQUIRED" }); expect(database.request).not.toHaveBeenCalled(); expect(runtime).not.toHaveBeenCalled();
});
