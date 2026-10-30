// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ai } from "./ai-api";
import {
  api, missingServiceSettings,
  type Attempt, type BankPage, type GradingResponse, type Question, type QuestionPage,
  type Session, type SessionPage, type SettingsResult,
} from "./api";
import fixture from "../fixtures/native-ipc.json";
import historicalErrors from "../fixtures/legacy-grading-errors.json";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(async () => {
  vi.mocked(invoke).mockReset().mockResolvedValueOnce(null);
  await api({ type: "restore" });
  vi.mocked(invoke).mockClear();
});

it.each(Object.entries(fixture.settings))("reads the native %s settings without credential work", async (name, payload) => {
  const native: SettingsResult = payload;
  vi.mocked(invoke).mockResolvedValueOnce(native);
  const result = await api({ type: "settings" });
  expect(result).toEqual(native);
  expect(missingServiceSettings(result)).toHaveLength(name === "defaults" ? 2 : 0);
  expect(result.hasServiceToken === null || typeof result.hasServiceToken === "boolean").toBe(true);
  expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("request", expect.objectContaining({ request: { type: "settings" } }));
});

it.each([fixture.pages.emptyBanks, fixture.pages.banks, fixture.pages.nextBanks])("reads native bank pagination at offset $offset", async payload => {
  const native: BankPage = payload;
  vi.mocked(invoke).mockResolvedValueOnce(native);
  const result = await api({ type: "banks_page", limit: 1, offset: native.offset });
  expect(result).toEqual(native);
  expect(Number.isSafeInteger(result.total)).toBe(true);
  expect(Number.isSafeInteger(result.offset)).toBe(true);
  for (const bank of result.items) {
    expect(typeof bank.id).toBe("string");
    expect(typeof bank.title).toBe("string");
    expect(typeof bank.description).toBe("string");
    expect(Number.isSafeInteger(bank.count)).toBe(true);
    expect(Number.isSafeInteger(bank.createdAt)).toBe(true);
  }
});

it("keeps native question and session page fields compatible with the frontend types", async () => {
  // JSON imports widen string enums; check the actual native values before narrowing them.
  const questions: QuestionPage = {
    ...fixture.pages.questions,
    items: fixture.pages.questions.items.map(item => {
      const answerMode = item.question.answerMode;
      if (answerMode !== "short_answer") throw new Error("Unexpected native question mode");
      return { ...item, question: { ...item.question, answerMode } };
    }),
  };
  const sessions: SessionPage = {
    ...fixture.pages.sessions,
    items: fixture.pages.sessions.items.map(item => {
      const kind = item.kind;
      if (kind !== "self_test") throw new Error("Unexpected native session kind");
      return { ...item, kind };
    }),
  };
  vi.mocked(invoke).mockResolvedValueOnce(fixture.pages.questions).mockResolvedValueOnce(fixture.pages.sessions);
  expect(await api({ type: "questions_page", bank_ids: ["fixture-bank"], search: "", mode: "", filter: "", limit: 1, offset: 0, include_stats: true })).toEqual(questions);
  expect(await api({ type: "sessions_page", limit: 1, offset: 0, filter: "review" })).toEqual(sessions);
  expect(questions.items[0].question.answerMode).toBe("short_answer");
  expect(questions.stats?.count).toBe(1);
  expect(sessions.items[0].pendingGrades).toBe(0);
  expect(sessions.items[0].earnedCents).toBe(300);
});

it("preserves unknown and historical grading receipt fields", () => {
  const receipts: GradingResponse[] = Object.values(fixture.receipts);
  expect(receipts.every(receipt => typeof receipt.status === "string")).toBe(true);
  expect(fixture.receipts.unknown).toMatchObject({ status: "unknown", usageStatus: "unknown", appError: { code: "LOCAL_MODEL_RESULT_UNKNOWN" } });
  expect(fixture.receipts.historical).toEqual(historicalErrors[0].response);
});

it.each([
  ["unknown", fixture.unknownSession, "ungraded", null],
  ["graded", fixture.gradedSession, "ai", 300],
  ["manual", fixture.manualSession, "manual", 400],
] as const)("keeps the complete native %s session compatible with the frontend", async (name, payload, expectedKind, expectedScore) => {
  const kind = payload.kind;
  if (kind !== "self_test") throw new Error("Unexpected native session kind");
  const attempts: Attempt[] = payload.attempts.map(attempt => {
    const gradeKind = attempt.gradeKind;
    if (gradeKind !== "ungraded" && gradeKind !== "ai" && gradeKind !== "manual") throw new Error("Unexpected native grading kind");
    const answerMode = attempt.snapshot.question.answerMode;
    if (answerMode !== "short_answer") throw new Error("Unexpected native question mode");
    const question: Question = { ...attempt.snapshot.question, answerMode };
    expect(question.choiceVariant).toBeNull();
    expect(question.matchingVariant).toBeNull();
    expect(question.questionKind).toBeNull();
    return { ...attempt, gradeKind, snapshot: { ...attempt.snapshot, question } };
  });
  const native: Session = { ...payload, kind, attempts };
  vi.mocked(invoke).mockResolvedValueOnce(structuredClone(payload));
  const session = name === "graded"
    ? await ai({ type: "grade", id: native.id, ordinal: 0, retry: false })
    : await api({ type: "session", id: native.id });
  expect(session).toEqual(native);
  expect(session.attempts[0].gradeKind).toBe(expectedKind);
  expect(session.attempts[0].earnedCents).toBe(expectedScore);
  if (name === "unknown") expect(session.attempts[0].grading?.lastRequest).toEqual(fixture.receipts.unknown);
  if (name === "graded") expect(session.attempts[0].grading?.ai).toEqual(fixture.receipts.graded);
  if (name === "manual") expect(session.attempts[0].grading?.manual).toMatchObject({ scoreCents: 400, reason: "Reviewed against the supplied reference" });
  expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(invoke)).toHaveBeenCalledWith(name === "graded" ? "ai_request" : "request", expect.objectContaining({ request: name === "graded"
    ? { type: "grade", id: native.id, ordinal: 0, retry: false }
    : { type: "session", id: native.id } }));
});

it("returns the native restore recovery path without starting other native work", async () => {
  const native: NonNullable<Awaited<ReturnType<typeof api<{ type: "restore" }>>>> = fixture.restore;
  vi.mocked(invoke).mockResolvedValueOnce(native);
  const result = await api({ type: "restore" });
  expect(result?.recoveryPath).toBe("<temporary>/recovery.zip");
  expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
});
