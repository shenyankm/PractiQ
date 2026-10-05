// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { api, blankQuestion, type QuestionPage, type QuestionRow } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));
vi.mock("./api", async () => ({ ...await vi.importActual("./api"), api: vi.fn() }));
HTMLElement.prototype.hasPointerCapture = () => false;
HTMLElement.prototype.scrollIntoView = () => {};
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function row(id: string): QuestionRow {
  return {
    id, bankId: "bank", bankTitle: "Test bank", favorite: true, latestResult: null,
    question: { ...blankQuestion(), id, stem: id, answerMode: "true_false", choiceVariant: null, options: [], answerPayload: { value: true } },
    groups: [], visuals: [], sources: [], warnings: [], missingAssets: false,
  };
}
const alpha = row("alpha");
const beta = row("beta");
const mutations = ["favorite", "delete_question", "save_question_tree", "review_question"] as const;
type Mutation = typeof mutations[number];

function setup(mutation: Mutation, delayMutation = false) {
  let mutated = false;
  let holdReload = true;
  let releaseReload: (page: QuestionPage) => void = () => {};
  let releaseMutation: () => void = () => {};
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === mutation) {
      if (delayMutation) await new Promise<void>(resolve => { releaseMutation = resolve; });
      mutated = true;
      return (mutation === "review_question" ? 123 : null) as never;
    }
    switch (request.type) {
      case "banks": return [{ id: "bank", title: "Test bank", count: 61 }] as never;
      case "banks_page": return { items: [{ id: "bank", title: "Test bank", description: "", count: 61, createdAt: 1 }], total: 1, offset: 0 } as never;
      case "info": return { version: "test", dataDirectory: "/tmp/test" } as never;
      case "unfinished_session": return null as never;
      case "question_detail": return (request.id === "alpha" ? alpha : beta) as never;
      case "questions_page":
        if (mutated && holdReload && !request.search) {
          holdReload = false;
          return await new Promise<QuestionPage>(resolve => { releaseReload = resolve; }) as never;
        }
        return { items: [request.search === "beta" ? beta : alpha], total: request.search === "beta" ? 31 : 61, offset: request.offset } as never;
      default: throw new Error(`Unexpected request: ${request.type}`);
    }
  });
  return { releaseReload: () => releaseReload({ items: [alpha], total: 61, offset: 30 }), releaseMutation: () => releaseMutation() };
}

async function openQuestions(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "查看题目" }));
  await screen.findByText("alpha");
  await waitFor(() => expect(screen.getByRole("button", { name: "下一页" }).hasAttribute("disabled")).toBe(false));
  await user.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("第 31–60 题");
  await waitFor(() => expect(screen.getByRole("button", { name: "上一页" }).hasAttribute("disabled")).toBe(false));
}

async function mutate(user: ReturnType<typeof userEvent.setup>, mutation: Mutation) {
  if (mutation === "favorite") await user.click(screen.getByRole("button", { name: "取消收藏" }));
  if (mutation === "delete_question") {
    await user.click(screen.getByRole("button", { name: "删除题目" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "确认" }));
  }
  if (mutation === "save_question_tree") {
    await user.click(screen.getByRole("button", { name: "编辑题目" }));
    await user.click(await screen.findByRole("button", { name: "保存题目" }));
  }
  if (mutation === "review_question") {
    await user.click(screen.getByRole("button", { name: /alpha/ }));
    await user.click(await screen.findByRole("button", { name: "标记已复核" }));
    await user.keyboard("{Escape}");
  }
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({ type: mutation })));
}

async function searchBeta(user: ReturnType<typeof userEvent.setup>) {
  const search = screen.getByRole("textbox", { name: "搜索题目" });
  expect(search.hasAttribute("disabled")).toBe(false);
  await user.type(search, "beta");
  await user.selectOptions(screen.getByRole("combobox", { name: "筛选题型" }), "true_false");
  await screen.findByText("beta");
  await screen.findByText("第 1–30 题");
}

it.each(mutations)("ignores an obsolete %s reload after the current search and type resolve", async mutation => {
  const user = userEvent.setup();
  const pending = setup(mutation);
  await openQuestions(user);
  await mutate(user, mutation);
  await waitFor(() => expect(vi.mocked(api).mock.calls.filter(([request]) => request.type === "questions_page" && !request.search)).toHaveLength(3));
  await searchBeta(user);
  await act(async () => pending.releaseReload());
  expect(screen.queryByText("alpha")).toBeNull();
  expect(screen.getByText("beta")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "搜索题目" })).toHaveProperty("value", "beta");
  expect(screen.getByText("第 1–30 题")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("第 31–31 题");
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({ type: "questions_page", search: "beta", mode: "true_false", offset: 30 })));
});

it("reloads the current query when a favorite mutation finishes after filtering", async () => {
  const user = userEvent.setup();
  const pending = setup("favorite", true);
  await openQuestions(user);
  await mutate(user, "favorite");
  await searchBeta(user);
  const reads = vi.mocked(api).mock.calls.filter(([request]) => request.type === "questions_page").length;
  await act(async () => pending.releaseMutation());
  await waitFor(() => expect(vi.mocked(api).mock.calls.filter(([request]) => request.type === "questions_page")).toHaveLength(reads + 1));
  expect(api).toHaveBeenLastCalledWith({ type: "questions_page", bank_ids: ["bank"], search: "beta", mode: "true_false", filter: "", limit: 30, offset: 0 });
  await act(async () => pending.releaseReload());
  expect(screen.queryByText("alpha")).toBeNull();
  expect(screen.getByText("第 1–30 题")).toBeTruthy();
});
