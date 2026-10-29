// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { api, blankQuestion, type Answer, type Session } from "./api";
import { Practice } from "./Practice";
import { AnswerDisplay } from "./AnswerInput";
import { ErrorBoundary } from "../../shared/error-boundary";
import { RenderFailure } from "./RenderFailure";
import type { GradingResponse } from "./api";

vi.mock("./api", async () => ({ ...await vi.importActual("./api"), api: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function practice(): Session {
  const question = { ...blankQuestion(), stem: "Explain", answerMode: "short_answer" as const, choiceVariant: null, options: [], answerPayload: { text: "Reference" } };
  return { id: "practice", kind: "practice", title: "Practice", createdAt: Date.now(), position: 0, mode: "ordered", finishedAt: 1, submittedAt: 1, attempts: [{
    ordinal: 0, snapshot: { question, groups: [], visuals: [], sources: [], warnings: [], missingAssets: false },
    answer: { text: "My answer" }, submittedAt: 1, skipped: false, result: null, autoResult: null, gradeKind: "ungraded", elapsedMs: 0,
  }] };
}

function Study({ initial, onError = () => {} }: { initial: Session; onError?: (error: unknown) => void }) {
  const [session, setSession] = useState(initial);
  return <Practice session={session} onSession={setSession} run={job => { void job().catch(onError); }} flushRef={{ current: async () => {} }} />;
}

it.each([
  { scoreCents: 500, maxCents: 1000, reason: "ok" },
  { scoreCents: 500, maxCents: 1000, reason: {}, evidence: {}, reviewReasons: [null, {}] },
  { scoreCents: 500, maxCents: 1000, reason: "ok", evidence: [null, {}, "Retained evidence"], reviewReasons: [] },
])("#411 safely renders malformed historical service explanations: %j", result => {
  const initial = practice();
  initial.kind = "self_test";
  initial.attempts[0].maxCents = 1000;
  initial.attempts[0].earnedCents = 500;
  initial.attempts[0].gradeKind = "ai";
  initial.attempts[0].result = false;
  // Older app versions could persist nonconforming service receipts.
  initial.attempts[0].grading = { ai: { status: "graded", result } as unknown as GradingResponse };
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(<ErrorBoundary fallback={<RenderFailure />}><Study initial={initial} /></ErrorBoundary>);
    expect(screen.queryByRole("heading", { name: "此界面暂时无法显示" }), errorSpy.mock.calls.flat().map(String).join("\n")).toBeNull();
    expect(screen.getByRole("region", { name: "本次结果" })).toBeTruthy();
    expect(api).not.toHaveBeenCalled();
  } finally { errorSpy.mockRestore(); }
});

it.each(["next", "answer card"])("locks answers while %s navigation is pending and ignores late changes", async target => {
  const initial = practice();
  initial.finishedAt = initial.submittedAt = initial.attempts[0].submittedAt = null;
  initial.attempts.push({ ...initial.attempts[0], ordinal: 1, answer: null });
  let stored = structuredClone(initial);
  let save!: () => void;
  let move!: () => void;
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "save_draft") {
      if (!save) await new Promise<void>(resolve => { save = resolve; });
      stored.attempts[request.ordinal].answer = request.answer; return undefined as never;
    }
    if (request.type === "position") {
      const captured = structuredClone({ ...stored, position: request.position });
      return await new Promise<Session>(resolve => { move = () => { stored = captured; resolve(captured); }; }) as never;
    }
    return stored as never;
  });
  render(<Study initial={initial} />);
  const next = screen.getByRole("button", { name: target === "next" ? "下一题" : /转到第 2 题/ });
  await userEvent.click(next); await waitFor(() => expect(save).toBeDefined());
  const input = screen.getByRole("textbox", { name: "作答内容" }) as HTMLTextAreaElement;
  expect(input.disabled).toBe(true);
  expect(move).toBeUndefined();
  await act(async () => save()); await waitFor(() => expect(move).toBeDefined());
  expect(input.disabled).toBe(true);
  for (const name of ["清空作答", "提交答案", "跳过此题", "下一题"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "Late unsaved answer" } });
  fireEvent.click(next);
  expect(vi.mocked(api).mock.calls.filter(([request]) => request.type === "position")).toHaveLength(1);
  expect(vi.mocked(api).mock.calls.some(([request]) => request.type === "save_draft" && request.answer?.text === "Late unsaved answer")).toBe(false);
  await act(async () => move()); await screen.findByRole("heading", { name: "第 2 / 2 题" });
  expect((screen.getByRole("textbox", { name: "作答内容" }) as HTMLTextAreaElement).disabled).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "上一题" }));
  await waitFor(() => expect(vi.mocked(api).mock.calls.filter(([request]) => request.type === "position")).toHaveLength(2));
  await act(async () => move()); await screen.findByRole("heading", { name: "第 1 / 2 题" });
  expect((screen.getByRole("textbox", { name: "作答内容" }) as HTMLTextAreaElement).value).toBe("My answer");
});

it("retains a failed draft on the current question and unlocks navigation after explicit recovery", async () => {
  const initial = practice();
  initial.finishedAt = initial.submittedAt = initial.attempts[0].submittedAt = null;
  initial.attempts.push({ ...initial.attempts[0], ordinal: 1, answer: null });
  let fail = true;
  const onError = vi.fn();
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "save_draft") { if (fail) throw new Error("Disk full"); return undefined as never; }
    return { ...initial, position: request.type === "position" ? request.position : 0 } as never;
  });
  render(<Study initial={initial} onError={onError} />);
  fireEvent.change(screen.getByRole("textbox", { name: "作答内容" }), { target: { value: "Keep my draft" } });
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: "下一题" }));
  await waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(vi.mocked(api).mock.calls.some(([request]) => request.type === "position")).toBe(false);
  const input = screen.getByRole("textbox", { name: "作答内容" }) as HTMLTextAreaElement;
  expect(input.disabled).toBe(false); expect(input.value).toBe("Keep my draft");
  expect(screen.getByRole("alert").textContent).toContain("答案保存失败");
  fail = false; await userEvent.click(screen.getByRole("button", { name: "重试保存" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: "下一题" }));
  await screen.findByRole("heading", { name: "第 2 / 2 题" });
});

it("restores editing on the original question when the destination read fails", async () => {
  const initial = practice();
  initial.finishedAt = initial.submittedAt = initial.attempts[0].submittedAt = null;
  initial.attempts.push({ ...initial.attempts[0], ordinal: 1, answer: null });
  const failure = new Error("Destination unavailable");
  const onError = vi.fn();
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "position") throw failure;
    return undefined as never;
  });
  render(<Study initial={initial} onError={onError} />);
  await userEvent.click(screen.getByRole("button", { name: "下一题" }));
  await waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(failure));
  expect(screen.getByRole("heading", { name: "第 1 / 2 题" })).toBeTruthy();
  const input = screen.getByRole("textbox", { name: "作答内容" }) as HTMLTextAreaElement;
  expect(input.disabled).toBe(false); expect(input.value).toBe("My answer");
  expect((screen.getByRole("button", { name: "下一题" }) as HTMLButtonElement).disabled).toBe(false);
});

it("keeps submission beside navigation and removes it after submitting", async () => {
  const initial = practice();
  initial.finishedAt = initial.submittedAt = initial.attempts[0].submittedAt = null;
  vi.mocked(api).mockResolvedValue({ ...initial, attempts: [{ ...initial.attempts[0], submittedAt: 2 }] });
  render(<Study initial={initial}/>);
  const navigation = screen.getByRole("navigation", { name: "题目导航" });
  const toolbar = within(navigation.parentElement!);
  expect(toolbar.getByRole("button", { name: "提交答案" })).toBeTruthy();
  expect(toolbar.getByRole("button", { name: "跳过此题" })).toBeTruthy();
  await userEvent.click(toolbar.getByRole("button", { name: "提交答案" }));
  await waitFor(() => expect(toolbar.queryByRole("button", { name: "提交答案" })).toBeNull());
  expect(toolbar.getByRole("button", { name: "下一题" })).toBeTruthy();
  expect(api).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "save_attempt", submit: true, skip: false }));
});

it("shows finished review copy, readable answers and a visible state legend without saving", () => {
  const initial = practice();
  initial.attempts.push({...initial.attempts[0], ordinal:1, answer:null, skipped:true});
  render(<Study initial={initial}/>);
  expect(screen.getByText("本次作答已结束，正在回顾作答与解析。")).toBeTruthy();
  expect(screen.getByText("本次共 2 题，作答已锁定；可切换题目回顾。")).toBeTruthy();
  expect(screen.queryByText(/草稿自动保存/)).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(within(screen.getByRole("region", {name:"我的答案"})).getByText("My answer")).toBeTruthy();
  const legend = screen.getByLabelText("本次题目状态");
  expect(legend.textContent).toContain("待判定 1");
  expect(legend.textContent).toContain("跳过 1");
  expect(api).not.toHaveBeenCalled();
});

it.each([null, {text:"  "}])("labels empty historical writing without submission hints: %j", answer => {
  const initial = practice();
  initial.attempts[0].answer = answer;
  Object.assign(initial.attempts[0].snapshot.question, {questionKind:"writing", minWords:80, maxWords:120});
  render(<Study initial={initial}/>);
  expect(screen.getByText("本次未作答")).toBeTruthy();
  expect(screen.queryByText(/仍可提交/)).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
});

it.each([false, true])("locks a pending submission (skip=%s) and shows the persisted answer", async skip => {
  const initial = practice();
  initial.finishedAt = initial.submittedAt = initial.attempts[0].submittedAt = null;
  let resolve!: (session: Session) => void;
  vi.mocked(api).mockImplementation(request => request.type === "save_attempt"
    ? new Promise<Session>(done => { resolve = done; }) as never
    : Promise.resolve(null) as never);
  render(<Study initial={initial} />);
  await userEvent.click(screen.getByRole("button", { name: skip ? "跳过此题" : "提交答案" }));
  await waitFor(() => expect(resolve).toBeDefined());
  const input = screen.getByRole("textbox", { name: "作答内容" }) as HTMLTextAreaElement;
  expect(input.disabled).toBe(true);
  expect((screen.getByRole("button", { name: "清空作答" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "Late answer" } });
  fireEvent(document, new Event("visibilitychange"));
  expect(api).toHaveBeenCalledTimes(1);
  const submitted = { ...initial, attempts: [{ ...initial.attempts[0], submittedAt: 2, skipped: skip, answer: { text: "Authoritative answer" } }] };
  await act(async () => resolve(submitted));
  await waitFor(() => expect(within(screen.getByRole("region", {name:"我的答案"})).getByText("Authoritative answer")).toBeTruthy());
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(api).toHaveBeenCalledTimes(1);
});

it.each([false, true])("restores editing and retains the answer after failed submission (skip=%s)", async skip => {
  const initial = practice();
  initial.finishedAt = initial.submittedAt = initial.attempts[0].submittedAt = null;
  let reject!: (error: Error) => void;
  vi.mocked(api).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }) as never);
  const failure = vi.fn();
  render(<Practice session={initial} onSession={vi.fn()} run={job => { void job().catch(failure); }} flushRef={{ current: async () => {} }} />);
  await userEvent.click(screen.getByRole("button", { name: skip ? "跳过此题" : "提交答案" }));
  await waitFor(() => expect(reject).toBeDefined());
  await act(async () => reject(new Error("Storage failed")));
  const input = screen.getByRole("textbox", { name: "作答内容" }) as HTMLTextAreaElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  expect(input.value).toBe("My answer");
  expect(screen.getByRole("alert").textContent).toContain("答案保存失败");
  expect(failure).toHaveBeenCalledOnce();
});

it("self-assesses a finished practice while keeping the answer locked and announces only the result", async () => {
  const user = userEvent.setup();
  const initial = practice();
  vi.mocked(api).mockResolvedValue({ ...initial, attempts: [{ ...initial.attempts[0], result: true, gradeKind: "self" }] });
  render(<Study initial={initial} />);
  expect(screen.queryByRole("textbox", { name: "作答内容" })).toBeNull();
  expect(within(screen.getByRole("region", {name:"我的答案"})).getByText("My answer")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "我答对了" }));
  await waitFor(() => expect(screen.getByRole("status", { name: "答题状态" }).textContent).toBe("第 1 题：回答正确"));
  expect(api).toHaveBeenCalledExactlyOnceWith({ type: "self_assess", id: "practice", ordinal: 0, result: true });
  expect(screen.queryByRole("textbox", { name: "作答内容" })).toBeNull();
  expect(within(screen.getByRole("region", {name:"我的答案"})).getByText("My answer")).toBeTruthy();
});

it("submits practice answers before self-assessing through the separate command", async () => {
  const user = userEvent.setup();
  const initial = practice();
  initial.finishedAt = initial.submittedAt = null;
  initial.attempts[0].submittedAt = null;
  const submitted = { ...initial, attempts: [{ ...initial.attempts[0], submittedAt: 2 }] };
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "save_attempt") return submitted as never;
    if (request.type === "self_assess") return { ...submitted, attempts: [{ ...submitted.attempts[0], result: false, gradeKind: "self" }] } as never;
    throw new Error(`Unexpected request: ${request.type}`);
  });
  render(<Study initial={initial} />);
  expect(screen.queryByRole("button", { name: "我答错了" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "提交答案" }));
  await user.click(await screen.findByRole("button", { name: "我答错了" }));
  await waitFor(() => expect(screen.getByRole("status", { name: "答题状态" }).textContent).toBe("第 1 题：回答错误"));
  expect(vi.mocked(api).mock.calls.map(([request]) => request)).toEqual([
    { type: "save_attempt", id: "practice", ordinal: 0, answer: { text: "My answer" }, elapsed_ms: expect.any(Number), submit: true, skip: false },
    { type: "self_assess", id: "practice", ordinal: 0, result: false },
  ]);
  expect(within(screen.getByRole("region", {name:"我的答案"})).getByText("My answer")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
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
  expect(within(screen.getByRole("region", {name:"我的答案"})).getByText("My answer")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
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
  const answerModes = ["short_answer", "fill_blank", "fill_blank", "true_false", "short_answer"] as const;
  initial.attempts = answers.map((answer, ordinal) => ({ ...initial.attempts[0], ordinal, answer, submittedAt: null,
    snapshot: { ...initial.attempts[0].snapshot, question: { ...initial.attempts[0].snapshot.question, answerMode: answerModes[ordinal], answerPayload: null } },
  }));
  vi.mocked(api).mockResolvedValue(initial);
  render(<Study initial={initial} />);
  expect(screen.getByText("已作答 2 / 5")).toBeTruthy();
  expect(screen.getByRole("button", { name: "转到第 2 题，未作答" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "转到第 3 题，草稿未完成" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "转到第 4 题，已作答，未提交" })).toBeTruthy();
  await user.type(screen.getByRole("textbox", { name: "作答内容" }), "answer");
  expect(screen.getByText("已作答 3 / 5")).toBeTruthy();
  await user.clear(screen.getByRole("textbox", { name: "作答内容" }));
  expect(screen.getByText("已作答 2 / 5")).toBeTruthy();
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

it("opens the compact answer card explicitly without saving or grading", async () => {
  const initial = practice();
  render(<Practice compact session={initial} onSession={vi.fn()} run={job => { void job(); }} flushRef={{current:async () => {}}}/>);
  const details = document.querySelector<HTMLDetailsElement>(".practice-answer-card")!;
  expect(details.open).toBe(false);
  await userEvent.click(screen.getByRole("link", {name:"查看答题卡"}));
  expect(details.open).toBe(true);
  expect(screen.getByRole("region", {name:"答题卡"})).toBeTruthy();
  expect(api).not.toHaveBeenCalled();
});
