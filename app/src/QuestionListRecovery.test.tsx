// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { api, blankQuestion, type QuestionPage, type QuestionRow, type Request } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));
vi.mock("./api", async () => ({ ...await vi.importActual("./api"), api: vi.fn() }));
vi.mock("./notifications", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
HTMLElement.prototype.hasPointerCapture = () => false;
HTMLElement.prototype.scrollIntoView = () => {};
afterEach(() => { cleanup(); vi.resetAllMocks(); });

type PageRequest = Extract<Request, { type: "questions_page" }>;
const row: QuestionRow = {
  id: "alpha", bankId: "bank", bankTitle: "Bank", question: { ...blankQuestion(), stem: "Previous alpha question" },
  groups: [], visuals: [], sources: [], warnings: [], missingAssets: false, favorite: false, latestResult: null,
};
const beta = { ...row, id: "beta", question: { ...row.question, stem: "Current beta question" } };
function setup(read: (request: PageRequest) => Promise<QuestionPage>) {
  const banks = [{ id: "bank", title: "Bank", description: "", count: 60, createdAt: 1 }];
  vi.mocked(api).mockImplementation(async request => {
    switch (request.type) {
      case "banks": return banks as never;
      case "banks_page": return { items: banks, total: 1, offset: 0 } as never;
      case "unfinished_session": return null as never;
      case "info": return { version: "test", dataDirectory: "/tmp/test" } as never;
      case "questions_page": return await read(request) as never;
      default: throw new Error(`Unexpected request: ${request.type}`);
    }
  });
}
async function openBank(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "查看题目" }));
  await screen.findByText(row.question.stem!);
}

it("hides previous rows, totals and actions on page failure and retries the same page", async () => {
  const user = userEvent.setup();
  let rejectPage!: (error: Error) => void;
  let fail = true;
  setup(async request => {
    if (request.offset === 30 && fail) return new Promise((_, reject) => { rejectPage = reject; });
    return { items: [request.offset ? beta : row], total: 60, offset: request.offset };
  });
  await openBank(user);
  expect(screen.getByText("60 道题目")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(rejectPage).toBeTypeOf("function"));
  expect(screen.queryByText(row.question.stem!)).toBeNull();
  expect(screen.queryByText("60 道题目")).toBeNull();
  expect(screen.queryByRole("button", { name: "编辑题目" })).toBeNull();
  expect(screen.queryByRole("button", { name: "删除题目" })).toBeNull();
  expect(screen.getByRole("button", { name: "开始练习" }).hasAttribute("disabled")).toBe(true);
  await act(async () => rejectPage(new Error("Page unavailable")));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("加载题目失败");
  expect(alert.textContent).toContain("Page unavailable");
  expect(screen.queryByText("没有找到题目")).toBeNull();
  expect(screen.queryByRole("button", { name: "收藏题目" })).toBeNull();
  fail = false;
  await user.click(within(alert).getByRole("button", { name: "重试" }));
  await screen.findByText(beta.question.stem!);
  expect(api).toHaveBeenLastCalledWith({ type: "questions_page", bank_ids: ["bank"], search: "", mode: "", filter: "", limit: 30, offset: 30 });
  expect(screen.getByText("第 31–60 题")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("retries the current bank, search, type and review filter without resetting controls", async () => {
  const user = userEvent.setup();
  let fail = false;
  setup(async request => {
    if (fail) throw new Error("Filtered read unavailable");
    return { items: [request.search ? beta : row], total: 1, offset: 0 };
  });
  await openBank(user);
  fail = true;
  await user.type(screen.getByRole("textbox", { name: "搜索题目" }), "beta");
  await user.selectOptions(screen.getByRole("combobox", { name: "筛选题型" }), "single");
  await user.click(screen.getByRole("checkbox", { name: "仅看待复核" }));
  const alert = await screen.findByRole("alert");
  expect(screen.queryByText(row.question.stem!)).toBeNull();
  fail = false;
  await user.click(within(alert).getByRole("button", { name: "重试" }));
  await screen.findByText(beta.question.stem!);
  expect(api).toHaveBeenLastCalledWith({ type: "questions_page", bank_ids: ["bank"], search: "beta", mode: "single", filter: "review", limit: 30, offset: 0 });
  expect(screen.getByRole("textbox", { name: "搜索题目" })).toHaveProperty("value", "beta");
  expect(screen.getByRole("combobox", { name: "筛选题型" })).toHaveProperty("value", "single");
  expect(screen.getByRole("checkbox", { name: "仅看待复核" }).getAttribute("aria-checked")).toBe("true");
});

it.each(["success", "failure"])("ignores obsolete %s after the current query succeeds", async outcome => {
  const user = userEvent.setup();
  let resolveOld!: (page: QuestionPage) => void;
  let rejectOld!: (error: Error) => void;
  setup(async request => {
    if (request.search === "obsolete") return new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    return { items: [request.search ? beta : row], total: 1, offset: 0 };
  });
  await openBank(user);
  const search = screen.getByRole("textbox", { name: "搜索题目" });
  await user.type(search, "obsolete");
  await waitFor(() => expect(resolveOld).toBeTypeOf("function"));
  await user.clear(search);
  await user.type(search, "beta");
  await screen.findByText(beta.question.stem!);
  await act(async () => {
    if (outcome === "success") resolveOld({ items: [row], total: 60, offset: 30 });
    else rejectOld(new Error("Obsolete failure"));
  });
  expect(screen.getByText(beta.question.stem!)).toBeTruthy();
  expect(screen.queryByText(row.question.stem!)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("1 道题目")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "下一页" })).toBeNull();
});

it("clears search, type and review filters together while preserving the bank", async () => {
  const user = userEvent.setup();
  setup(async request => ({ items: request.search || request.mode || request.filter ? [] : [row], total: request.search || request.mode || request.filter ? 0 : 1, offset: 0 }));
  await openBank(user);
  await user.type(screen.getByLabelText("搜索题目"), "absent");
  await user.selectOptions(screen.getByLabelText("筛选题型"), "single");
  await user.click(screen.getByRole("checkbox", { name: "仅看待复核" }));
  await screen.findByText("没有符合筛选的题目");
  await user.click(screen.getByRole("button", { name: "清除筛选" }));
  await screen.findByText(row.question.stem!);
  expect(screen.getByLabelText("搜索题目")).toHaveProperty("value", "");
  expect(screen.getByLabelText("筛选题型")).toHaveProperty("value", "");
  expect(screen.getByRole("checkbox", { name: "仅看待复核" }).getAttribute("aria-checked")).toBe("false");
  expect(api).toHaveBeenLastCalledWith({ type: "questions_page", bank_ids: ["bank"], search: "", mode: "", filter: "", limit: 30, offset: 0 });
});

it.each(["错题本", "收藏夹"])("distinguishes filtered emptiness from an empty %s", async label => {
  const user = userEvent.setup();
  setup(async () => ({ items: [], total: 0, offset: 0 }));
  render(<App />);
  await screen.findByRole("button", { name: "查看题目" });
  await user.click(screen.getByRole("button", { name: label }));
  await screen.findByText(label === "错题本" ? "暂时没有错题" : "还没有收藏题目");
  await user.type(screen.getByLabelText("搜索题目"), "absent");
  await screen.findByText("没有符合筛选的题目");
  expect(screen.queryByText(label === "错题本" ? "暂时没有错题" : "还没有收藏题目")).toBeNull();
});
