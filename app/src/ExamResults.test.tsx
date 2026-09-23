// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { ExamResults } from "./ExamResults";
import { blankQuestion, type Attempt, type Session } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function exam(count = 1): Session {
  const question = { ...blankQuestion(), answerMode: "short_answer" as const, choiceVariant: null, options: [], stem: "Explain the result", answerPayload: { text: "Reference answer" } };
  const attempts: Attempt[] = Array.from({ length: count }, (_, ordinal) => ({
    ordinal,
    snapshot: { question, groups: [], visuals: [], sources: [], warnings: [], missingAssets: false },
    answer: { text: "My answer" }, autoResult: null, result: null, gradeKind: "ungraded",
    submittedAt: 1, skipped: false, elapsedMs: 0, maxCents: 300, earnedCents: null,
  }));
  return { id: "exam", kind: "self_test", title: "Exam", createdAt: 0, submittedAt: 1, finishedAt: null, position: 0, mode: "ordered", attempts };
}

it("validates manual scores and reasons before the native request", async () => {
  const user = userEvent.setup();
  const session = exam();
  const onSession = vi.fn();
  vi.mocked(invoke).mockResolvedValue(session);
  render(<ExamResults session={session} onSession={onSession} run={job => { void job(); }} />);

  await user.type(screen.getByRole("textbox", { name: "人工得分" }), "2.345");
  await user.click(screen.getByRole("button", { name: "保存人工评分" }));
  expect(screen.getByRole("alert").textContent).toContain("分数最多保留两位小数");
  expect(invoke).not.toHaveBeenCalled();

  await user.clear(screen.getByRole("textbox", { name: "人工得分" }));
  await user.type(screen.getByRole("textbox", { name: "人工得分" }), "2.25");
  await user.click(screen.getByRole("button", { name: "保存人工评分" }));
  expect(screen.getByRole("alert").textContent).toContain("请填写原因");
  expect(invoke).not.toHaveBeenCalled();

  await user.type(screen.getByRole("textbox", { name: "改分原因" }), "按细则复核");
  await user.click(screen.getByRole("button", { name: "保存人工评分" }));
  await waitFor(() => expect(onSession).toHaveBeenCalledWith(session));
  expect(invoke).toHaveBeenCalledWith("request", expect.objectContaining({ request: { type: "manual_score", id: "exam", ordinal: 0, cents: 225, reason: "按细则复核" } }));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("stops queued AI grading after the in-flight request completes", async () => {
  const user = userEvent.setup();
  const session = exam(2);
  const onSession = vi.fn();
  let finish!: (value: Session) => void;
  vi.mocked(invoke).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<ExamResults session={session} onSession={onSession} run={job => { void job(); }} />);

  await user.click(screen.getByRole("button", { name: "AI 评分／继续（2 题，将调用模型）" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  await user.click(screen.getByRole("button", { name: "停止后续评分" }));
  await act(async () => { finish(session); });
  await waitFor(() => expect(screen.queryByRole("button", { name: "停止后续评分" })).toBeNull());
  expect(onSession).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("ai_request", expect.objectContaining({ request: { type: "grade", id: "exam", ordinal: 0, retry: false } }));
});
