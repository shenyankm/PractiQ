// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { api, blankQuestion, type QuestionRow, type SessionSummary } from "./api";
import { toast } from "./notifications";
import fixture from "../fixtures/sample.json";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));
vi.mock("./api", async () => ({ ...await vi.importActual("./api"), api: vi.fn() }));
vi.mock("./notifications", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
HTMLElement.prototype.hasPointerCapture = () => false;
HTMLElement.prototype.scrollIntoView = () => {};
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const exam: SessionSummary = {
  id: "exam", title: "English · Mock exam · 20", kind: "mock_exam", createdAt: 1,
  deadlineAt: Date.now() + 60_000, finishedAt: null, submittedAt: null,
  count: 20, answered: 0, draftAnswered: 15, correct: 0, graded: 0, skipped: 0,
  elapsedMs: 0, selfGraded: 0, autoGraded: 0,
};
const row = {
  id: "q", bankId: "bank", bankTitle: "English", question: fixture.questions[0],
  groups: [], visuals: [], sources: [], warnings: [], missingAssets: false,
  favorite: false, latestResult: false,
  latestScore: { earnedCents: 900, maxCents: 1000, gradeKind: "manual" },
} as QuestionRow;
function setup(question = row, failReview = false) {
  vi.mocked(api).mockImplementation(async request => {
    switch (request.type) {
      case "banks": return [{ id: "bank", title: "English", count: 20 }] as never;
      case "banks_page": return { items: [{ id: "bank", title: "English", count: 20, description: "" }], total: 1, offset: 0 } as never;
      case "unfinished_session": return exam as never;
      case "sessions_page": return { items: request.filter === "finished" ? [] : [exam], total: request.filter === "finished" ? 0 : 1, offset: 0 } as never;
      case "questions_page": {
        const pending = [question, ...(question.children || [])].some(item => item.question.needsReview && item.reviewedAt == null);
        const items = request.filter === "review" && !pending ? [] : [question];
        return { items, total: items.length, offset: 0 } as never;
      }
      case "review_question": {
        if (failReview) throw new Error("Review failed");
        const reviewedAt = request.reviewed ? 123 : null;
        question = { ...question, reviewedAt, children: question.children?.map(child => ({ ...child, reviewedAt })) };
        return reviewedAt as never;
      }
      case "info": return { version: "test", dataDirectory: "/tmp/test" } as never;
      case "settings": return { config: { base_url: null, model_id: null }, hasApiKey: false } as never;
      case "pick_import": return null as never;
      case "question_stats": return { count: 0, types: {}, feasibleCounts: [] } as never;
      default: throw new Error(`Unexpected request: ${request.type}`);
    }
  });
}

it("opens the existing offline ZIP entry with an explicit append/replace distinction", async () => {
  setup(); render(<App/>);
  await screen.findByText("English");
  await userEvent.click(screen.getByRole("button", { name: "已有题库 ZIP？前往设置导入" }));
  expect(await screen.findByRole("menuitem", { name: "导入题库 ZIP" })).toBeTruthy();
  expect(screen.getByText("追加题库，不替换已有学习记录")).toBeTruthy();
  expect(screen.getByText("替换全部本地数据，操作前需确认")).toBeTruthy();
  await userEvent.click(screen.getByRole("menuitem", { name: "导入题库 ZIP" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith({ type: "pick_import" }));
});

it("shows saved exam answers, filters history natively and focuses the page heading", async () => {
  setup(); render(<App/>);
  expect(await screen.findByText(/已答 15\/20 题 · 草稿已保存/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "继续考试" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "查看全部" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith({ type: "sessions_page", limit: 30, offset: 0, filter: "active" }));
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "练习记录", level: 1 }));
  await userEvent.selectOptions(screen.getByLabelText("练习记录状态"), "finished");
  expect(await screen.findByText("没有符合此状态的记录")).toBeTruthy();
  expect(api).toHaveBeenCalledWith({ type: "sessions_page", limit: 30, offset: 0, filter: "finished" });
});

it("distinguishes partial credit in the review list and starts unattempted practice explicitly", async () => {
  setup(); render(<App/>);
  await screen.findByText("English");
  await userEvent.click(screen.getByRole("button", { name: "查看题目" }));
  expect(await screen.findByText("部分得分")).toBeTruthy();
  expect(screen.getByText("上次 9 / 10 分")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "我的题库" }));
  await screen.findByText("English");
  await userEvent.click(screen.getByRole("button", { name: "题库操作 English" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "练习未做题" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({ type: "question_stats", bank_ids: ["bank"], filter: "unattempted" })));
  expect(screen.getByRole("button", { name: "立即开始" }).hasAttribute("disabled")).toBe(true);
});

it("shows partial credit from a material group's child when the parent has no result", async () => {
  setup({ ...row, latestResult: null, latestScore: null, children: [row] });
  render(<App/>);
  await screen.findByText("English");
  await userEvent.click(screen.getByRole("button", { name: "错题本" }));
  expect(await screen.findByText("部分得分")).toBeTruthy();
  expect(screen.getByText(/未评分不算错题。/)).toBeTruthy();
});

it("filters pending reviews and confirms or revokes the whole material tree without hiding original warnings", async () => {
  const pending: QuestionRow = {
    ...row, id: "root", latestResult: null, latestScore: null,
    question: { ...blankQuestion(), id: "root", stem: "Shared material", answerMode: "reading", choiceVariant: null, options: [] },
    children: [{ ...row, id: "child", question: { ...row.question, id: "child", parentId: "root", needsReview: true, missingFields: ["answerPayload"], answerPayload: null } }],
  };
  setup(pending); render(<App />);
  await screen.findByText("English");
  await userEvent.click(screen.getByRole("button", { name: "查看题目" }));
  expect(await screen.findByRole("img", { name: "待复核" })).toBeTruthy();
  await userEvent.click(screen.getByRole("checkbox", { name: "仅看待复核" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({ type: "questions_page", filter: "review", offset: 0 })));
  await userEvent.click(screen.getByRole("button", { name: /Shared material/ }));
  let dialog = screen.getByRole("dialog", { name: "题目详情" });
  expect(within(dialog).getByText("此操作应用于本题及全部子题；原始质量提示会保留。")).toBeTruthy();
  expect(await within(dialog).findByText("内容待复核，仍可练习。")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "标记已复核" }));
  expect(await within(dialog).findByRole("button", { name: "撤销复核确认" })).toBeTruthy();
  expect(api).toHaveBeenCalledWith({ type: "review_question", id: "root", reviewed: true });
  expect(within(dialog).getAllByText("已人工复核，原始质量提示已保留。")).toHaveLength(2);
  expect(within(dialog).getAllByText(/缺失：/)).toHaveLength(1);
  expect(within(dialog).queryByText("内容待复核，仍可练习。")).toBeNull();
  await userEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
  expect(await screen.findByText("没有找到题目")).toBeTruthy();
  await userEvent.click(screen.getByRole("checkbox", { name: "仅看待复核" }));
  const reviewedRow = await screen.findByRole("button", { name: /Shared material/ });
  expect(screen.queryByRole("img", { name: "待复核" })).toBeNull();
  await userEvent.click(reviewedRow);
  dialog = screen.getByRole("dialog", { name: "题目详情" });
  await userEvent.click(within(dialog).getByRole("button", { name: "撤销复核确认" }));
  expect(await within(dialog).findByRole("button", { name: "标记已复核" })).toBeTruthy();
  expect(api).toHaveBeenCalledWith({ type: "review_question", id: "root", reviewed: false });
  expect(within(dialog).getByText("内容待复核，仍可练习。")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
  expect(await screen.findByRole("img", { name: "待复核" })).toBeTruthy();
  expect(pending.children?.[0].question.needsReview).toBe(true);
  expect(pending.children?.[0].question.missingFields).toEqual(["answerPayload"]);
});

it.each([null, 123])("preserves review state when saving the confirmation fails (reviewedAt=%s)", async reviewedAt => {
  setup({ ...row, reviewedAt, question: { ...row.question, needsReview: true, missingFields: ["answerPayload"] } }, true);
  render(<App />);
  await screen.findByText("English");
  await userEvent.click(screen.getByRole("button", { name: "查看题目" }));
  await userEvent.click(await screen.findByRole("button", { name: new RegExp(row.question.stem!) }));
  const dialog = screen.getByRole("dialog", { name: "题目详情" });
  const action = reviewedAt == null ? "标记已复核" : "撤销复核确认";
  await userEvent.click(within(dialog).getByRole("button", { name: action }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(new Error("Review failed")));
  expect(within(dialog).getByRole("button", { name: action }).hasAttribute("disabled")).toBe(false);
  expect(within(dialog).getByText(reviewedAt == null ? "内容待复核，仍可练习。" : "已人工复核，原始质量提示已保留。")).toBeTruthy();
  expect(within(dialog).getByText(/缺失：/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
  expect(screen.queryByRole("img", { name: "待复核" }) != null).toBe(reviewedAt == null);
});
