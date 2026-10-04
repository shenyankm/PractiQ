// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { api, blankQuestion, type Session } from "./api";
import { toast } from "./notifications";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));
vi.mock("./api", async () => ({ ...await vi.importActual("./api"), api: vi.fn() }));
vi.mock("./notifications", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
HTMLElement.prototype.hasPointerCapture = () => false;
HTMLElement.prototype.scrollIntoView = () => {};
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });

function setup() {
  let compact = true;
  const listeners = new Set<() => void>();
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({
    matches: query === "(max-width: 767px)" && compact, media: query, onchange: null,
    addListener() {}, removeListener() {}, dispatchEvent: () => true,
    addEventListener(_type: string, listener: EventListener) { if (query === "(max-width: 767px)") listeners.add(listener as () => void); },
    removeEventListener(_type: string, listener: EventListener) { listeners.delete(listener as () => void); },
  }));
  const settings = { config: { service_url: "https://service.example" }, hasServiceToken: true };
  const bank = { id: "bank", title: "English", description: "Offline", count: 2 };
  vi.mocked(api).mockImplementation(async request => {
    switch (request.type) {
      case "banks": return [bank] as never;
      case "banks_page": return { items: [bank], total: 1, offset: 0 } as never;
      case "info": return { version: "test", dataDirectory: "/tmp/test" } as never;
      case "unfinished_session": return null as never;
      case "sessions_page": return { items: [], total: 0, offset: 0 } as never;
      case "settings": return settings as never;
      case "save_settings": return { ...settings, config: request.config } as never;
      case "pick_import": return null as never;
      default: throw new Error(`Unexpected request: ${request.type}`);
    }
  });
  return { resize(wide: boolean) { compact = !wide; act(() => { listeners.forEach(listener => listener()); }); } };
}

function androidBack() {
  const event = new CustomEvent("practiq-android-back", { cancelable: true });
  act(() => { document.dispatchEvent(event); });
  return event.defaultPrevented;
}

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "打开主导航" }));
  const drawer = await screen.findByRole("dialog", { name: "主导航" });
  await user.click(within(drawer).getByRole("button", { name: "设置" }));
  await screen.findByRole("heading", { name: "设置", level: 1 });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

it("opens the compact navigation with all destinations and retains the desktop sidebar after resizing", async () => {
  const viewport = setup(); const user = userEvent.setup(); render(<App />);
  await screen.findByText("English");
  await user.click(screen.getByRole("button", { name: "打开主导航" }));
  const drawer = await screen.findByRole("dialog", { name: "主导航" });
  for (const name of ["我的题库", "错题本", "收藏夹", "练习记录", "设置", "主题", "语言"]) {
    expect(within(drawer).getByRole("button", { name })).toBeTruthy();
  }
  expect(androidBack()).toBe(true);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  viewport.resize(true);
  expect(screen.queryByRole("button", { name: "打开主导航" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "收起侧边栏" }));
  expect(screen.getByRole("button", { name: "展开侧边栏" }).getAttribute("aria-expanded")).toBe("false");
});

it("flushes a service URL draft on Android Back and leaves the homepage exit to the native activity", async () => {
  setup(); const user = userEvent.setup(); render(<App />); await openSettings(user);
  await user.click(await screen.findByRole("button", { name: "配置" }));
  const url = await screen.findByLabelText("AI 服务地址") as HTMLInputElement;
  await user.type(url, "/changed");
  expect(androidBack()).toBe(true);
  await screen.findByRole("heading", { name: "设置", level: 1 });
  expect(api).toHaveBeenCalledWith({ type: "save_settings", config: { service_url: "https://service.example/changed" }, service_token: null });
  expect(androidBack()).toBe(true);
  await screen.findByRole("heading", { name: "我的题库", level: 1 });
  await waitFor(() => expect(screen.queryByText("处理中…")).toBeNull());
  expect(androidBack()).toBe(false);
});

it("keeps the service editor and draft visible when Android Back cannot save", async () => {
  setup(); const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "save_settings") throw new Error("Save unavailable");
    return original(request);
  });
  const user = userEvent.setup(); render(<App />); await openSettings(user);
  await user.click(await screen.findByRole("button", { name: "配置" }));
  const url = await screen.findByLabelText("AI 服务地址") as HTMLInputElement;
  await user.type(url, "/draft");
  expect(androidBack()).toBe(true);
  await waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect(screen.getByRole("heading", { name: "AI 服务", level: 1 })).toBeTruthy();
  expect(url.value).toBe("https://service.example/draft");
});

it("uses the existing dirty-editor confirmation before Android Back can leave a bank edit", async () => {
  setup(); const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole("button", { name: "题库操作 English" }));
  await user.click(await screen.findByRole("menuitem", { name: "编辑题库" }));
  const title = await screen.findByLabelText("题库名称") as HTMLInputElement;
  await user.type(title, " changed");
  expect(androidBack()).toBe(true);
  const confirm = await screen.findByRole("alertdialog", { name: "放弃未保存的更改？" });
  await user.click(within(confirm).getByRole("button", { name: "继续编辑" }));
  expect(title.value).toBe("English changed");
  expect(androidBack()).toBe(true);
  const nextConfirm = await screen.findByRole("alertdialog", { name: "放弃未保存的更改？" });
  await user.click(within(nextConfirm).getByRole("button", { name: "放弃更改" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({ type: "save_bank" }));
});

it("dismisses the restore menu before navigating back and keeps ZIP import an explicit action", async () => {
  setup(); const user = userEvent.setup(); render(<App />); await openSettings(user);
  await user.click(screen.getByRole("button", { name: "恢复备份" }));
  expect(await screen.findByRole("menuitem", { name: "导入题库 ZIP" })).toBeTruthy();
  expect(androidBack()).toBe(true);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(screen.getByRole("heading", { name: "设置", level: 1 })).toBeTruthy();
  expect(api).not.toHaveBeenCalledWith({ type: "pick_import" });
  await user.click(screen.getByRole("button", { name: "恢复备份" }));
  await user.click(await screen.findByRole("menuitem", { name: "导入题库 ZIP" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith({ type: "pick_import" }));
});

it("saves an unfinished practice draft before returning to history and resumes the same snapshot", async () => {
  setup(); const original = vi.mocked(api).getMockImplementation()!;
  let session: Session = { id: "practice", title: "Offline practice", kind: "practice", createdAt: 1, finishedAt: null, mode: "ordered", position: 0, attempts: [{
    ordinal: 0, snapshot: { question: { ...blankQuestion(), answerMode: "short_answer", stem: "Explain", answerPayload: { text: "Reference" } }, groups: [], visuals: [], sources: [], warnings: [], missingAssets: false },
    answer: null, result: null, autoResult: null, gradeKind: "ungraded", submittedAt: null, elapsedMs: 0, skipped: false,
  }] };
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "unfinished_session") return { ...session, count: 1, answered: 0, correct: 0, graded: 0, skipped: 0, elapsedMs: 0, selfGraded: 0, autoGraded: 0 } as never;
    if (request.type === "session") return session as never;
    if (request.type === "save_draft") {
      session = { ...session, attempts: [{ ...session.attempts[0], answer: request.answer }] };
      return null as never;
    }
    return original(request);
  });
  const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole("button", { name: "继续练习" }));
  await user.type(await screen.findByLabelText("作答内容"), "My draft");
  expect(androidBack()).toBe(true);
  await screen.findByRole("heading", { name: "练习记录", level: 1 });
  expect(api).toHaveBeenCalledWith(expect.objectContaining({ type: "save_draft", id: "practice", answer: { text: "My draft" } }));
  await user.click(screen.getByRole("button", { name: "打开主导航" }));
  await user.click(within(await screen.findByRole("dialog", { name: "主导航" })).getByRole("button", { name: "我的题库" }));
  await user.click(await screen.findByRole("button", { name: "继续练习" }));
  expect((await screen.findByLabelText("作答内容") as HTMLTextAreaElement).value).toBe("My draft");
  expect(session.attempts[0].snapshot.question.stem).toBe("Explain");
});

it("consumes Android Back while a native operation is pending", async () => {
  setup(); const original = vi.mocked(api).getMockImplementation()!;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "banks") await pending;
    return original(request);
  });
  render(<App />);
  await screen.findByText("处理中…");
  expect(androidBack()).toBe(true);
  await act(async () => { finish(); });
  await waitFor(() => expect(screen.queryByText("处理中…")).toBeNull());
  expect(androidBack()).toBe(false);
});
