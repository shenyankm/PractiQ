// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { api, blankQuestion, type Answer, type Session } from "./api";
import { Practice } from "./Practice";
import { AnswerDisplay } from "./AnswerInput";

vi.mock("./api", async () => ({ ...await vi.importActual("./api"), api: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function practice(): Session {
  const question = { ...blankQuestion(), stem: "Explain", answerMode: "short_answer" as const, choiceVariant: null, options: [], answerPayload: { text: "Reference" } };
  return { id: "practice", kind: "practice", title: "Practice", createdAt: Date.now(), position: 0, mode: "ordered", finishedAt: 1, submittedAt: 1, attempts: [{
    ordinal: 0, snapshot: { question, groups: [], visuals: [], sources: [], warnings: [], missingAssets: false },
    answer: { text: "My answer" }, submittedAt: 1, skipped: false, result: null, autoResult: null, gradeKind: "ungraded", elapsedMs: 0,
  }] };
}

function Study({ initial }: { initial: Session }) {
  const [session, setSession] = useState(initial);
  return <Practice session={session} onSession={setSession} run={job => { void job(); }} flushRef={{ current: async () => {} }} />;
}

it("self-assesses a finished practice while keeping the answer locked and announces only the result", async () => {
  const user = userEvent.setup();
  const initial = practice();
  vi.mocked(api).mockResolvedValue({ ...initial, attempts: [{ ...initial.attempts[0], result: true, gradeKind: "self" }] });
  render(<Study initial={initial} />);
  const input = screen.getByRole("textbox", { name: "作答内容" }) as HTMLTextAreaElement;
  expect(input.disabled).toBe(true);
  await user.click(screen.getByRole("button", { name: "我答对了" }));
  await waitFor(() => expect(screen.getByRole("status", { name: "答题状态" }).textContent).toBe("第 1 题：回答正确"));
  expect(api).toHaveBeenCalledExactlyOnceWith({ type: "self_assess", id: "practice", ordinal: 0, result: true });
  expect(input.value).toBe("My answer");
  expect(input.disabled).toBe(true);
});

it.each(["skipped", "auto"])("does not offer self-assessment for a %s attempt", kind => {
  const initial = practice();
  if (kind === "skipped") initial.attempts[0].skipped = true;
  else Object.assign(initial.attempts[0], { autoResult: true, result: true, gradeKind: "auto" });
  render(<Study initial={initial} />);
  expect(screen.queryByRole("button", { name: "我答对了" })).toBeNull();
});

it("focuses the new question heading after changing questions", async () => {
  const user = userEvent.setup();
  const initial = practice();
  initial.attempts.push({ ...initial.attempts[0], ordinal: 1 });
  vi.mocked(api).mockResolvedValue({ ...initial, position: 1 });
  render(<Study initial={initial} />);
  await user.click(screen.getByRole("button", { name: "下一题" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "第 2 / 2 题" })));
  expect(api).toHaveBeenCalledExactlyOnceWith({ type: "position", id: "practice", position: 1 });
});

it("compares each blank using trim only, retaining case and punctuation differences", () => {
  const question = { ...blankQuestion(), answerMode: "fill_blank" as const };
  render(<AnswerDisplay question={question} answer={{ answers: ["Paris", "Hello", "word."] }} response={{ answers: [" Paris ", "hello", "word"] }} />);
  const rows = within(screen.getByRole("table", { name: "填空答案对照" })).getAllByRole("row");
  expect(within(rows[1]).getByText("文本一致")).toBeTruthy();
  expect(within(rows[2]).getByText("文本不一致")).toBeTruthy();
  expect(within(rows[3]).getByText("文本不一致")).toBeTruthy();
});

it("offers review of submitted unassessed practice answers without changing them", async () => {
  const user = userEvent.setup();
  const initial = practice();
  initial.finishedAt = initial.submittedAt = null;
  const base = initial.attempts[0];
  initial.attempts = [
    { ...base, result: true },
    { ...base, ordinal: 1 },
    { ...base, ordinal: 2, skipped: true },
    { ...base, ordinal: 3, submittedAt: null },
    { ...base, ordinal: 4 },
    { ...base, ordinal: 5, submittedAt: null, answer: { text: "  " } },
  ];
  vi.mocked(api).mockResolvedValueOnce(initial).mockResolvedValueOnce({ ...initial, position: 1 });
  render(<Study initial={initial} />);
  await user.click(screen.getByRole("button", { name: "结束练习" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("还有 2 题未自评。结束后仍可在练习记录中核对并补充自评。")).toBeTruthy();
  expect(within(dialog).getByText(/已提交 4 题；未提交草稿 1 题；空白 1 题/)).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "去核对" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "第 2 / 6 题" })));
  expect(vi.mocked(api).mock.calls.map(([request]) => request)).toEqual([
    { type: "session", id: "practice" },
    { type: "position", id: "practice", position: 1 },
  ]);
  expect((screen.getByRole("textbox", { name: "作答内容" }) as HTMLTextAreaElement).value).toBe("My answer");
});

it.each([true, false])("keeps unassessed answers while finishing with submit_drafts=%s", async submitDrafts => {
  const user = userEvent.setup();
  const initial = practice();
  initial.finishedAt = initial.submittedAt = null;
  initial.attempts.push({ ...initial.attempts[0], ordinal: 1, submittedAt: null });
  vi.mocked(api).mockResolvedValueOnce(initial).mockResolvedValueOnce({ ...initial, finishedAt: 2 });
  render(<Study initial={initial} />);
  await user.click(screen.getByRole("button", { name: "结束练习" }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: submitDrafts ? "提交草稿并结束（保留未判定）" : "草稿记为跳过并结束（保留未判定）" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(vi.mocked(api).mock.calls.map(([request]) => request)).toEqual([
    { type: "session", id: "practice" },
    { type: "submit_paper", id: "practice", submit_drafts: submitDrafts },
  ]);
  expect(screen.getByRole("status", { name: "答题状态" }).textContent).toBe("第 1 题：未判定");
});

it("counts partial drafts and false answers but excludes empty values, including the current edit", async () => {
  const user = userEvent.setup();
  const initial = practice();
  initial.kind = "self_test";
  initial.finishedAt = initial.submittedAt = null;
  const answers: (Answer | null)[] = [{ text: "  " }, { answers: [" ", ""] }, { answers: ["first", ""] }, { value: false }, null];
  initial.attempts = answers.map((answer, ordinal) => ({ ...initial.attempts[0], ordinal, answer, submittedAt: null }));
  initial.attempts[2].snapshot = { ...initial.attempts[2].snapshot, question: { ...initial.attempts[2].snapshot.question, answerMode: "fill_blank" } };
  vi.mocked(api).mockResolvedValue(initial);
  render(<Study initial={initial} />);
  expect(screen.getByText("已作答 2 / 5。草稿自动保存，可随时离开后继续。")).toBeTruthy();
  expect(screen.getByRole("button", { name: "转到第 2 题，未作答" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "转到第 3 题，草稿未完成" })).toBeTruthy();
  await user.type(screen.getByRole("textbox", { name: "作答内容" }), "answer");
  expect(screen.getByText("已作答 3 / 5。草稿自动保存，可随时离开后继续。")).toBeTruthy();
  await user.clear(screen.getByRole("textbox", { name: "作答内容" }));
  expect(screen.getByText("已作答 2 / 5。草稿自动保存，可随时离开后继续。")).toBeTruthy();
});

it("announces an exam score only once and focuses a heading with its question number", () => {
  const initial = practice();
  initial.kind = "self_test";
  initial.attempts.push({ ...initial.attempts[0], ordinal: 1, earnedCents: 100, maxCents: 300 });
  initial.position = 1;
  render(<Study initial={initial} />);
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.getByRole("status").textContent).toContain("当前题：1 / 3 分");
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "第 2 / 2 题" }));
});
