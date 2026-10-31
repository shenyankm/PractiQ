// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api, type QuestionPage } from "./api";
import { useQuestionListPage } from "./QuestionListPage";

vi.mock("./api", async () => ({ ...(await vi.importActual<typeof import("./api")>("./api")), api: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

function setup() {
  vi.useFakeTimers();
  vi.mocked(api).mockImplementation(async request => {
    if (request.type !== "questions_page") throw new Error(request.type);
    return { items: [], total: 90, offset: request.offset } as never;
  });
  return renderHook(({ page, bank }) => useQuestionListPage(page, bank), { initialProps: { page: "questions", bank: "one" } });
}

it("reads the initial question page without a debounce delay", async () => {
  setup();
  await act(async () => {});
  expect(api).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "questions_page", offset: 0 }));
});

it.each(["pagination", "mode", "bank", "page", "refresh"])("reads %s immediately without requesting the previous query page", async action => {
  const view = setup();
  await act(async () => { await vi.advanceTimersByTimeAsync(150); });
  await act(async () => { view.result.current.setOffset(30); await vi.advanceTimersByTimeAsync(150); });
  vi.mocked(api).mockClear();
  await act(async () => {
    if (action === "pagination") view.result.current.setOffset(60);
    if (action === "mode") view.result.current.setMode("single");
    if (action === "bank") view.rerender({ page: "questions", bank: "two" });
    if (action === "page") view.rerender({ page: "favorite", bank: "one" });
    if (action === "refresh") view.result.current.refresh();
  });
  expect(api).toHaveBeenCalledExactlyOnceWith({ type: "questions_page", bank_ids: action === "page" ? [] : [action === "bank" ? "two" : "one"], search: "", mode: action === "mode" ? "single" : "", filter: action === "page" ? "favorite" : "", limit: 30, offset: action === "pagination" ? 60 : action === "refresh" ? 30 : 0 });
});

it("debounces successive keyword edits from a later page and reads only the latest first page", async () => {
  const { result, unmount } = setup();
  await act(async () => { await vi.advanceTimersByTimeAsync(150); });
  await act(async () => { result.current.setOffset(30); await vi.advanceTimersByTimeAsync(150); });
  vi.mocked(api).mockClear();
  act(() => result.current.setSearch("a"));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  act(() => result.current.setSearch("ab"));
  await act(async () => { await vi.advanceTimersByTimeAsync(149); });
  expect(api).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(api).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ search: "ab", offset: 0 }));
  vi.mocked(api).mockClear();
  act(() => result.current.setSearch("cancelled"));
  unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(150); });
  expect(api).not.toHaveBeenCalled();
});

it("uses the current keyword immediately when an explicit filter replaces a pending search", async () => {
  const { result } = setup();
  await act(async () => { await vi.advanceTimersByTimeAsync(150); });
  act(() => result.current.setSearch("pending"));
  vi.mocked(api).mockClear();
  await act(async () => result.current.setMode("single"));
  expect(api).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ search: "pending", mode: "single", offset: 0 }));
  await act(async () => { await vi.advanceTimersByTimeAsync(150); });
  expect(api).toHaveBeenCalledTimes(1);
});

it("ignores an older page response after an immediate filter read", async () => {
  const { result } = setup();
  await act(async () => { await vi.advanceTimersByTimeAsync(150); });
  let release!: (value: QuestionPage) => void;
  vi.mocked(api).mockImplementation(async request => {
    if (request.type !== "questions_page") throw new Error(request.type);
    if (request.offset === 30 && !request.mode) return await new Promise<QuestionPage>(resolve => { release = resolve; }) as never;
    return { items: [], total: 3, offset: 0 } as never;
  });
  await act(async () => result.current.setOffset(30));
  expect(release).toBeTypeOf("function");
  await act(async () => result.current.setMode("single"));
  expect(result.current.questionTotal).toBe(3);
  await act(async () => release({ items: [], total: 90, offset: 30 }));
  expect(result.current.questionTotal).toBe(3);
  expect(result.current.offset).toBe(0);
});
