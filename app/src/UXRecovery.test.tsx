// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { api, blankQuestion, type Session } from "./api";
import { ai } from "./ai-api";
import { toast } from "./notifications";
import { canCloseWindow } from "./useUnsavedChanges";

const native = vi.hoisted(() => ({
  enabled: false,
  close: null as null | ((event: { preventDefault: () => void }) => Promise<void>),
  destroy: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => native.enabled }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  onCloseRequested: async (close: typeof native.close) => { native.close = close; return () => {}; },
  destroy: native.destroy,
}) }));
vi.mock("./api", async () => ({ ...await vi.importActual("./api"), api: vi.fn() }));
vi.mock("./ai-api", () => ({ ai: vi.fn() }));
vi.mock("./notifications", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
HTMLElement.prototype.hasPointerCapture = () => false;
HTMLElement.prototype.scrollIntoView = () => {};
afterEach(() => { cleanup(); vi.clearAllMocks(); native.enabled = false; native.close = null; });

function setup() {
  const bank = { id: "bank", title: "English", description: "Offline", count: 2 };
  const question = { ...blankQuestion(), id: "q", stem: "Explain", answerMode: "short_answer" as const, answerPayload: { text: "Reference" }, needsReview: true };
  let session: Session = {
    id: "exam", title: "Saved exam", kind: "self_test", createdAt: 1, submittedAt: 1, finishedAt: null,
    bankIds: [bank.id], position: 0, mode: "ordered",
    attempts: [0, 1].map(ordinal => ({ ordinal, snapshot: { question, groups: [], visuals: [], sources: [], warnings: [], missingAssets: false }, answer: { text: "Answer" }, autoResult: null, result: null, gradeKind: "ungraded", submittedAt: 1, skipped: false, elapsedMs: 0, maxCents: 1000, earnedCents: null })),
  };
  vi.mocked(api).mockImplementation(async request => {
    switch (request.type) {
      case "banks": return [bank] as never;
      case "banks_page": return { items: [bank], total: 1, offset: 0 } as never;
      case "info": return { version: "test", dataDirectory: "/tmp/test" } as never;
      case "unfinished_session": return null as never;
      case "questions_page": return { items: [{ id: "q", bankId: bank.id, bankTitle: bank.title, question, reviewRequired: true, favorite: false }], total: 1, offset: 0 } as never;
      case "pick_import": return { ticket: "zip", title: "Imported", count: 1, reviewCount: 0, assetCount: 0, missingAssets: [], warnings: [] } as never;
      case "import": return { bankId: bank.id, count: 1, duplicate: false } as never;
      case "save_bank": return bank.id as never;
      case "sessions_page": return { items: [{ ...session, count: 2, answered: 2, graded: 0, correct: 0, skipped: 0, elapsedMs: 0, selfGraded: 0, autoGraded: 0, pendingGrades: 2 }], total: 1, offset: 0 } as never;
      case "session": return session as never;
      case "position": session = { ...session, position: request.position }; return session as never;
      case "manual_score": return session as never;
      case "settings": return { config: { service_url: null }, hasServiceToken: false } as never;
      case "save_settings": return { config: request.config, hasServiceToken: false } as never;
      default: throw new Error(`Unexpected request: ${request.type}`);
    }
  });
  return vi.mocked(api).getMockImplementation()!;
}

async function openExam(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "练习记录" }));
  await user.click(await screen.findByRole("button", { name: "核对评分" }));
  await screen.findByRole("textbox", { name: "人工得分" });
}

it("protects changed editor drafts on native window close and quits only after explicit discard", async () => {
  setup(); native.enabled = true;
  const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole("button", { name: "题库操作 English" }));
  await user.click(screen.getByRole("menuitem", { name: "编辑题库" }));
  await user.type(await screen.findByRole("textbox", { name: "题库名称" }), " draft");
  const preventDefault = vi.fn();
  await act(async () => { await native.close!({ preventDefault }); });
  const confirmation = await screen.findByRole("alertdialog", { name: "放弃未保存的更改并退出？" });
  expect(preventDefault).toHaveBeenCalled();
  expect(native.destroy).not.toHaveBeenCalled();
  await user.click(within(confirmation).getByRole("button", { name: "取消" }));
  expect((screen.getByRole("textbox", { name: "题库名称" }) as HTMLInputElement).value).toBe("English draft");
  await act(async () => { await native.close!({ preventDefault }); });
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "确认" }));
  await waitFor(() => expect(native.destroy).toHaveBeenCalledOnce());
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({ type: "save_bank" }));
});

it("closes an unchanged native window without a discard prompt", async () => {
  setup(); native.enabled = true; render(<App />);
  await screen.findByText("English");
  await act(async () => { await native.close!({ preventDefault: vi.fn() }); });
  expect(native.destroy).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it.each(["banks", "info"] as const)("recovers an initial %s read without restarting or replaying mutations", async type => {
  const original = setup(); let failed = false;
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === type && !failed) { failed = true; throw new Error("Initial read failed"); }
    return original(request);
  });
  const user = userEvent.setup(); render(<App />);
  await screen.findByRole("button", { name: "重试读取概览" });
  if (type === "banks") {
    expect(screen.getByText("题库概览读取失败")).toBeTruthy();
    expect(screen.getByRole("button", { name: "导入" }).hasAttribute("disabled")).toBe(true);
  }
  await user.click(screen.getByRole("button", { name: "重试读取概览" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "重试读取概览" })).toBeNull());
  expect(screen.getByText("1 个题库 · 2 道题目")).toBeTruthy();
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({ type: "import" }));
});

it("reports committed import success, clears review filters and retries only reads after refresh failure", async () => {
  const original = setup(); let committed = false, failed = false;
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "import") committed = true;
    if (request.type === "banks" && committed && !failed) { failed = true; throw new Error("Refresh failed"); }
    return original(request);
  });
  const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole("button", { name: "查看题目" }));
  await user.click(screen.getByRole("checkbox", { name: "仅看待复核" }));
  await user.click(screen.getByRole("button", { name: "导入题库 ZIP" }));
  await user.click(await screen.findByRole("button", { name: "确认导入" }));
  await screen.findByRole("button", { name: "重试读取概览" });
  expect(toast.success).toHaveBeenCalledWith({ key: "已导入 {0} 道题目", params: { 0: 1 } });
  expect(toast.error).not.toHaveBeenCalled();
  expect((screen.getByRole("checkbox", { name: "仅看待复核" }) as HTMLButtonElement).getAttribute("data-state")).toBe("unchecked");
  await user.click(screen.getByRole("button", { name: "重试读取概览" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "重试读取概览" })).toBeNull());
  expect(vi.mocked(api).mock.calls.filter(([r]) => r.type === "import")).toHaveLength(1);
});

it("keeps the import preview retryable when the write itself fails", async () => {
  const original = setup();
  vi.mocked(api).mockImplementation(async request => { if (request.type === "import") throw new Error("Write failed"); return original(request); });
  const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole("button", { name: "导入" }));
  await user.click(await screen.findByRole("button", { name: "确认导入" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect(screen.getByRole("dialog", { name: "导入题库" })).toBeTruthy();
  expect(toast.success).not.toHaveBeenCalled();
});

it("does not turn a committed bank save into a failed write when the overview cannot reload", async () => {
  const original = setup(); let committed = false;
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "save_bank") committed = true;
    if (request.type === "banks" && committed) throw new Error("Refresh failed");
    return original(request);
  });
  const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole("button", { name: "题库操作 English" }));
  await user.click(screen.getByRole("menuitem", { name: "编辑题库" }));
  await user.type(await screen.findByRole("textbox", { name: "题库名称" }), " saved");
  await user.click(screen.getByRole("button", { name: "保存题库" }));
  await screen.findByRole("button", { name: "重试读取概览" });
  expect(toast.success).toHaveBeenCalledWith({ key: "题库已保存" });
  expect(toast.error).not.toHaveBeenCalled();
});

it("retains manual grading drafts per question across navigation, failures and re-entry, clearing only a successful save", async () => {
  const original = setup(); let failSave = true;
  vi.mocked(api).mockImplementation(async request => { if (request.type === "manual_score" && failSave) throw new Error("Score save failed"); return original(request); });
  const user = userEvent.setup(); render(<App />);
  await screen.findByText("English"); await openExam(user);
  await user.type(screen.getByRole("textbox", { name: "人工得分" }), "2");
  await user.type(screen.getByRole("textbox", { name: "改分原因" }), "Checked rubric");
  expect(canCloseWindow()).toBe(false);
  await user.click(screen.getByRole("button", { name: "下一题" }));
  expect((screen.getByRole("textbox", { name: "人工得分" }) as HTMLInputElement).value).toBe("");
  await user.click(screen.getByRole("button", { name: "上一题" }));
  await user.click(screen.getByRole("button", { name: "练习记录" }));
  await user.click(await screen.findByRole("button", { name: "核对评分" }));
  expect((await screen.findByRole("textbox", { name: "人工得分" }) as HTMLInputElement).value).toBe("2");
  expect((screen.getByRole("textbox", { name: "改分原因" }) as HTMLInputElement).value).toBe("Checked rubric");
  await user.click(screen.getByRole("button", { name: "保存人工评分" }));
  await screen.findByRole("alert");
  expect((screen.getByRole("textbox", { name: "人工得分" }) as HTMLInputElement).value).toBe("2");
  failSave = false;
  await user.click(screen.getByRole("button", { name: "保存人工评分" }));
  await waitFor(() => expect((screen.getByRole("textbox", { name: "人工得分" }) as HTMLInputElement).value).toBe(""));
  expect(canCloseWindow()).toBe(true);
});

it("returns from AI configuration to the same grading question without automatically grading", async () => {
  setup(); vi.mocked(ai).mockRejectedValue({ code: "LOCAL_SERVICE_URL_REQUIRED" });
  const user = userEvent.setup(); render(<App />);
  await screen.findByText("English"); await openExam(user);
  await user.click(screen.getByRole("button", { name: "下一题" }));
  await user.type(screen.getByRole("textbox", { name: "人工得分" }), "3");
  await user.click(screen.getByRole("button", { name: /AI 评分／继续/ }));
  await user.click(await screen.findByRole("button", { name: "配置 AI 服务" }));
  await user.type(await screen.findByRole("textbox", { name: "AI 服务地址" }), "http://127.0.0.1:8000");
  await user.click(screen.getByRole("button", { name: "返回评分" }));
  await screen.findByRole("heading", { name: "第 2 / 2 题" });
  expect((screen.getByRole("textbox", { name: "人工得分" }) as HTMLInputElement).value).toBe("3");
  expect(ai).toHaveBeenCalledTimes(1);
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({ type: "test_settings" }));
});
