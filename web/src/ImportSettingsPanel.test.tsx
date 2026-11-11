// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Client } from "../../shared/cloud/api";
import { ImportSettingsPanel } from "../../shared/cloud/ImportSettingsPanel";
import { newTaskId, taskId } from "../../shared/cloud/test-fixtures";
import type { ImportSettingsSnapshot } from "./contracts.generated";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const initial: ImportSettingsSnapshot = { revision: taskId, settings: { tencentConcurrency: 5, readRetryCount: 2, retryBaseSeconds: 1, deduplicateQuestions: false, generateAnswers: false } };

it("automatically saves valid edits without a save button", async () => {
  const fetcher = vi.fn(async (_path: string, init: RequestInit) => json(init.method === "PUT"
    ? { revision: newTaskId, settings: JSON.parse(init.body as string).settings } : initial));
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup(); render(<ImportSettingsPanel client={new Client()} />);
  const field = await screen.findByLabelText("腾讯识别并发上限");
  expect(screen.queryByRole("button", { name: "保存设置" })).toBeNull();
  await user.clear(field); await user.type(field, "2");
  await screen.findByText("设置已保存");
  expect(fetcher.mock.calls.filter(([, init]) => init.method === "PUT")).toHaveLength(1);
  expect(screen.getByText("设置已保存").closest(".settings-toast")?.parentElement).toBe(document.body);
  await user.click(screen.getByRole("button", { name: "关闭保存提示" }));
  expect(screen.queryByText("设置已保存")).toBeNull();
});

it("saves newer edits after an in-flight write using the returned revision", async () => {
  let finish!: (response: Response) => void;
  const writes: ImportSettingsSnapshot[] = [];
  const fetcher = vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method !== "PUT") return json(initial);
    const request: ImportSettingsSnapshot = JSON.parse(init.body as string);
    writes.push(request);
    if (writes.length === 1) return new Promise<Response>(resolve => { finish = resolve; });
    return json({ ...request, revision: taskId });
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup(); render(<ImportSettingsPanel client={new Client()} />);
  const field = await screen.findByLabelText("腾讯识别并发上限");
  await user.clear(field); await user.type(field, "2");
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(field).not.toHaveProperty("disabled", true);
  await user.clear(field); await user.type(field, "3");
  finish(json({ revision: newTaskId, settings: { ...initial.settings, tencentConcurrency: 2 } }));
  await screen.findByText("设置已保存");
  expect(writes).toEqual([
    { revision: taskId, settings: { ...initial.settings, tencentConcurrency: 2 } },
    { revision: newTaskId, settings: { ...initial.settings, tencentConcurrency: 3 } },
  ]);
  expect(field).toHaveProperty("value", "3");
});

it("saves service settings with a revision and reloads persisted values without model mutations or token storage", async () => {
  let saved = structuredClone(initial);
  const fetcher = vi.fn(async (path: string, init: RequestInit) => {
    expect(path).toBe("/api/import-settings");
    expect(new Headers(init.headers).get("Authorization")).toBeNull();
    if (init.method === "PUT") saved = { revision: newTaskId, settings: JSON.parse(init.body as string).settings };
    return json(saved);
  });
  vi.stubGlobal("fetch", fetcher);
  const persist = vi.spyOn(Storage.prototype, "setItem");
  const user = userEvent.setup();
  render(<ImportSettingsPanel client={new Client()} />);
  await screen.findByLabelText("腾讯识别并发上限");
  expect(screen.queryAllByRole("switch")).toHaveLength(2);
  for (const [label, value] of [["腾讯识别并发上限", "2"], ["读取失败重试次数", "0"], ["初始退避间隔（秒）", "1.5"]]) {
    await user.clear(screen.getByLabelText(label)); await user.type(screen.getByLabelText(label), value);
  }
  await screen.findByText("设置已保存");
  const writes = fetcher.mock.calls.filter(([, init]) => init.method === "PUT");
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0][1].body as string)).toEqual({ revision: taskId, settings: { ...initial.settings, tencentConcurrency: 2, readRetryCount: 0, retryBaseSeconds: 1.5 } });
  expect(persist).not.toHaveBeenCalled();
  cleanup(); render(<ImportSettingsPanel client={new Client()} />);
  expect(await screen.findByLabelText("腾讯识别并发上限")).toHaveProperty("value", "2");
  expect(screen.getByLabelText("读取失败重试次数")).toHaveProperty("value", "0");
  expect(screen.queryAllByRole("switch")).toHaveLength(2);
  expect(fetcher.mock.calls.every(([path]) => path === "/api/import-settings")).toBe(true);
});

it("preserves an unsaved draft on a stale write and reloads the newer service revision explicitly", async () => {
  let reads = 0;
  const fetcher = vi.fn(async (_path: string, init: RequestInit) => init.method === "PUT"
    ? json({ detail: { code: "IMPORT_SETTINGS_CONFLICT" } }, 409)
    : json(++reads === 1 ? initial : { revision: newTaskId, settings: { ...initial.settings, tencentConcurrency: 3 } }));
  vi.stubGlobal("fetch", fetcher); const user = userEvent.setup();
  render(<ImportSettingsPanel client={new Client()} />);
  const field = await screen.findByLabelText("腾讯识别并发上限"); await user.clear(field); await user.type(field, "2");
  await screen.findByText(/设置已在其他页面更新/);
  expect(field).toHaveProperty("value", "2");
  expect(fetcher.mock.calls.filter(([, init]) => init.method === "PUT")).toHaveLength(1);
  expect(screen.queryByText("设置已保存")).toBeNull();
  await user.click(screen.getByRole("button", { name: "重新读取设置" }));
  await waitFor(() => expect(field).toHaveProperty("value", "3"));
});

it("keeps malformed successful writes uncertain and never automatically replays them", async () => {
  const fetcher = vi.fn(async (_path: string, init: RequestInit) => json(init.method === "PUT" ? {} : initial));
  vi.stubGlobal("fetch", fetcher); const user = userEvent.setup();
  render(<ImportSettingsPanel client={new Client()} />);
  const field = await screen.findByLabelText("读取失败重试次数"); await user.clear(field); await user.type(field, "0");
  await screen.findByText(/导入设置响应无效/);
  expect(field).toHaveProperty("value", "0"); expect(screen.queryByText("设置已保存")).toBeNull();
  expect(fetcher.mock.calls.filter(([, init]) => init.method === "PUT")).toHaveLength(1);
});

it("recovers failed reads explicitly and rejects settings outside the trusted bounds before HTTP", async () => {
  let ready = false;
  const fetcher = vi.fn(async () => json(ready ? initial : { revision: taskId, settings: { ...initial.settings, tencentConcurrency: 6 } }));
  vi.stubGlobal("fetch", fetcher); const user = userEvent.setup();
  const client = new Client(); render(<ImportSettingsPanel client={client} />);
  await screen.findByText(/导入设置响应无效/); expect(screen.queryByRole("button", { name: "保存设置" })).toBeNull();
  ready = true; await user.click(screen.getByRole("button", { name: "重新读取设置" })); await screen.findByLabelText("腾讯识别并发上限");
  const before = fetcher.mock.calls.length;
  await expect(client.saveImportSettings({ ...initial, settings: { ...initial.settings, readRetryCount: -1 } })).rejects.toThrow(/响应无效/);
  expect(fetcher.mock.calls).toHaveLength(before);
});

it("keeps an empty zero-valued draft pending without writing it", async () => {
  const fetcher = vi.fn(async () => json({ ...initial, settings: { ...initial.settings, readRetryCount: 0 } }));
  vi.stubGlobal("fetch", fetcher);
  const pending = vi.fn(); const user = userEvent.setup();
  render(<ImportSettingsPanel client={new Client()} onPendingChange={pending} />);
  const field = await screen.findByLabelText("读取失败重试次数");
  await waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
  await user.clear(field);
  expect(pending).toHaveBeenLastCalledWith(true);
  expect(screen.getByText("数值无效，尚未保存")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("makes personal execution settings editable without an administrator", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json(initial)));
  render(<ImportSettingsPanel client={new Client()} />);
  expect(await screen.findByLabelText("腾讯识别并发上限")).toHaveProperty("disabled", false);
});
