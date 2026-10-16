// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { ExamResults } from "./ExamResults";
import { I18nProvider, useI18n } from "./i18n";
import type { Session } from "./api";
import questions from "../fixtures/sample.json";
import cases from "../fixtures/legacy-grading-errors.json";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

function LanguageSwitch() {
  const language = useI18n();
  return <button onClick={() => void language.change("en")}>English</button>;
}

it.each(cases)("replays $name in both languages without model work", async record => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const { request } = args as { request: { type: string; locale?: string } };
    if (command === "request" && request.type === "language") return "zh-CN";
    if (command === "request" && request.type === "save_language") return request.locale;
    throw new Error("Reading grading history must not start native or model work");
  });
  const session: Session = {
    id: "restored-exam", kind: "self_test", title: "Archived exam", createdAt: 1,
    submittedAt: 2, finishedAt: 3, position: 0, mode: "ordered",
    attempts: [{
      ordinal: 0, snapshot: { question: questions.questions[4], groups: [], visuals: [], sources: [], warnings: [], missingAssets: false },
      answer: { text: "Archived answer" }, autoResult: null, result: null, gradeKind: "ungraded",
      submittedAt: 2, skipped: false, elapsedMs: 0, maxCents: 100, earnedCents: null,
      grading: { lastRequest: record.response },
    }],
  } as Session;
  const original = JSON.stringify(session);
  const onSession = vi.fn(), run = vi.fn();
  render(<I18nProvider><LanguageSwitch /><ExamResults session={session} onSession={onSession} run={run} /></I18nProvider>);
  expect(await screen.findByText(record.summary["zh-CN"], { exact: false })).toBeTruthy();
  if (record.diagnostic) expect(screen.getByText(record.diagnostic, { exact: false })).toBeTruthy();
  await userEvent.setup().click(screen.getByRole("button", { name: "English" }));
  expect(await screen.findByText(record.summary.en, { exact: false })).toBeTruthy();
  if (record.diagnostic) expect(screen.getByText(record.diagnostic, { exact: false })).toBeTruthy();
  expect(JSON.stringify(session)).toBe(original);
  expect(onSession).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(vi.mocked(invoke).mock.calls.map(([, args]) => (args as {request: {type: string}}).request.type)).toEqual(["language", "save_language"]);
});
