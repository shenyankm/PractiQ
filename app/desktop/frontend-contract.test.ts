// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PracticeStore } from "./store.js";
import { AppError } from "./errors.js";
import { api, blankQuestion } from "../src/api.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const stores: PracticeStore[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const store of stores.splice(0)) { store.close(); rmSync(store.directory, { recursive: true, force: true }); } });

it("uses real TypeScript storage responses through the frontend session consumer, including attempt patches", async () => {
  const store = new PracticeStore(mkdtempSync(join(tmpdir(), "practiq-consumer-"))); stores.push(store);
  vi.stubGlobal("window", { practiq: {
    request: async (request, locale) => { try { return { ok: true, value: store.request(request, locale) }; } catch (error) { return { ok: false, error: error instanceof AppError ? error.toJSON() : { code: "OPERATION_FAILED", message: String(error) } }; } },
    close: vi.fn(), onCloseRequested: vi.fn(),
  } });
  const bank = await api({ type: "save_bank", id: null, title: "Consumer test", description: "" });
  const question = { ...blankQuestion(), id: "one", stem: "One", answerMode: "true_false" as const, choiceVariant: null, options: [], answerPayload: { value: true }, analysis: "explanation", sourceText: "source" };
  await api({ type: "save_question_tree", bank_id: bank, root_id: null, questions: [question] });
  const preview = await api({ type: "preview_paper", request: { bank_ids: [bank], search: "", mode: "", filter: "", selection: "manual", count: 0, quotas: {}, question_ids: ["one"], random: false, total_cents: 0 } });
  const session = await api({ type: "start_paper", paper: { question_ids: preview.questionIds, kind: "practice", minutes: null, scores: preview.scores, total_cents: 0, digest: preview.digest } });
  expect(session.attempts[0].snapshot.question.stem).toBe("One");
  await api({ type: "save_draft", id: session.id, ordinal: 0, answer: { value: false }, elapsed_ms: 1 });
  const updated = await api({ type: "position", id: session.id, position: 0 });
  expect(updated.attempts[0].snapshot.question.stem).toBe("One");
  expect(updated.attempts[0].answer).toEqual({ value: false });
  const finished = await api({ type: "submit_paper", id: session.id, submit_drafts: true });
  expect(finished.attempts[0].result).toBe(false);
  expect(finished.finishedAt).toBeTypeOf("number");
});
