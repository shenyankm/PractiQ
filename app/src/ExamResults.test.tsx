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

it("shows abstention evidence and only starts grading attempts without a previous request", async () => {
  const user = userEvent.setup();
  const session = exam(3);
  session.position = 1;
  session.attempts[1].grading = { lastRequest: { status: "ungraded", result: { scoreCents: null, maxCents: 300, reason: "参考答案互相冲突", evidence: ["两份参考给出了不同定义"], reviewReasons: ["请人工核对评分依据"] } } };
  session.attempts[2].grading = { lastRequest: { status: "unknown", error: "timeout" } };
  vi.mocked(invoke).mockResolvedValue(session);
  render(<ExamResults session={session} onSession={vi.fn()} run={job => { void job(); }} />);
  expect(screen.getByText("参考答案互相冲突")).toBeTruthy();
  expect(screen.getByText("两份参考给出了不同定义")).toBeTruthy();
  expect(screen.getByText("复核提示：请人工核对评分依据")).toBeTruthy();
  expect(screen.getByText("上次请求：未能评分，需复核")).toBeTruthy();
  expect(screen.queryByText(/已有得分保留/)).toBeNull();
  await user.click(screen.getByRole("button", { name: "AI 评分／继续（1 题，将调用模型）" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  expect(invoke).toHaveBeenCalledWith("ai_request", expect.objectContaining({ request: { type: "grade", id: "exam", ordinal: 0, retry: false } }));
});

it("checks an unknown result using the existing request and distinguishes a retained score", async () => {
  const user = userEvent.setup();
  const session = exam();
  Object.assign(session.attempts[0], { earnedCents: 200, result: false, gradeKind: "ai", grading: { ai: { status: "graded", result: { scoreCents: 200, maxCents: 300, reason: "部分正确", evidence: [], reviewReasons: [] } }, lastRequest: { status: "unknown", error: "timeout" } } });
  vi.mocked(invoke).mockResolvedValue(session);
  render(<ExamResults session={session} onSession={vi.fn()} run={job => { void job(); }} />);
  expect(screen.getByText(/部分得分/)).toBeTruthy();
  expect(screen.getByText(/上次请求：评分结果待确认.*已有得分保留/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /AI 评分／继续/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: "核对上次评分结果" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  expect(invoke).toHaveBeenCalledWith("ai_request", expect.objectContaining({ request: { type: "grade", id: "exam", ordinal: 0, retry: false } }));
});

it("offers the next unattempted batch without creating a session or invoking a model", async () => {
  const user = userEvent.setup();
  const next = vi.fn();
  render(<ExamResults session={exam()} onSession={vi.fn()} onNextUnattempted={next} run={job => { void job(); }} />);
  expect((screen.getByRole("button", { name: "重练本次未得满分题" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("尚未请求 AI 评分。")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "继续下一批未做题" }));
  expect(next).toHaveBeenCalledOnce();
  expect(invoke).not.toHaveBeenCalled();
});
