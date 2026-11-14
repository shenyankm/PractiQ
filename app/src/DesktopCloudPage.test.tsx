// @vitest-environment jsdom
import "./import-test-setup";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CloudPage } from "./CloudPage";
import { I18nProvider } from "./i18n";
import { invoke } from "./transport";
import { Client } from "../../shared/cloud/api";
import { storageKey } from "../../shared/cloud/serviceStorage";
import { sha256 } from "../../shared/cloud/api";
import { nativeBridge, setNativeBridge } from "../../shared/cloud/transport";
import { desktopCloudBridge } from "./desktop-cloud";
import { capabilities, preview, summary, task, taskId, runId, newTaskId } from "../../shared/cloud/test-fixtures";
import type { DesktopAiSettingsView, DesktopDocumentRequest, DesktopDocumentReply, DocumentReference, DocumentCorrections } from "./contracts.generated";

vi.mock("./transport", () => ({ invoke: vi.fn() }));
const settings = (): DesktopAiSettingsView => ({ revision: taskId, preferences: { model: { provider: "openai", baseUrl: "https://model.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 1, retryBaseSeconds: 1, deduplicateQuestions: false, generateAnswers: false }, maxCalls: 16, runTimeoutSeconds: 1800, tencentCos: { enabled: false, bucket: "", region: "" } }, configured: { modelApiKey: true, tencentSecretId: true, tencentSecretKey: true } });
function fixture() {
  let view = settings(); const calls: Record<string, unknown>[] = []; const corrections: DocumentCorrections = { checkpointId: task.checkpointId!, edits: [] };
  const source: DocumentReference = { sourceType: "text", mediaType: "text/plain", fileName: "local-source.txt", sizeBytes: 4, sha256: "a".repeat(64), objectKey: `practiq-agent/sources/${"a".repeat(64)}/source.txt` };
  const handler = vi.mocked(invoke).mockImplementation(async (command, args) => {
    expect(command).toBe("request"); const request = args!.request as Record<string, unknown>; calls.push(structuredClone(request));
    switch (request.type) {
      case "language": return "zh-CN" as never;
      case "ai_settings": return structuredClone(view) as never;
      case "save_ai_settings": { const value = request.value as { revision: string; preferences: DesktopAiSettingsView["preferences"]; secrets: Record<string, string> }; expect(value.revision).toBe(view.revision); view = { revision: newTaskId, preferences: value.preferences, configured: { ...view.configured } }; for (const [key, credential] of Object.entries(value.secrets)) view.configured[key as keyof typeof view.configured] = Boolean(credential); return structuredClone(view) as never; }
      case "pick_document_sources": return [{ nativeTicket: "opaque-ticket", name: source.fileName, size: source.sizeBytes }] as never;
      case "upload_document_source": return source as never;
      case "document_request": {
        const action = request.request as DesktopDocumentRequest;
        switch (action.type) {
          case "capabilities": return { type: action.type, value: capabilities } as never;
          case "maintenance_preview": return { type: action.type, value: { previewId: taskId, expiresAt: new Date(Date.now() + 600000).toISOString(), candidates: [], hasMore: false, skipped: 0, canClean: true, pending: [] } } as never;
          case "cost_report": return { type: action.type, value: { enabled: view.preferences.cost?.enabled ?? false, currency: view.preferences.cost?.currency ?? "", utcDay: new Date().toISOString().slice(0, 10), day: null, task: null, taskLimitMicros: view.preferences.cost?.taskLimitMicros ?? null, dailyLimitMicros: view.preferences.cost?.dailyLimitMicros ?? null, recent: [] } } as never;
          case "cleanup_state": return { type: action.type, value: { ...action.value, cleaned: 1 } } as never;
          case "import_settings": return { type: action.type, value: { revision: view.revision, settings: view.preferences.import } } as never;
          case "save_import_settings": view = { ...view, revision: runId, preferences: { ...view.preferences, import: action.value.settings } }; return { type: action.type, value: { revision: view.revision, settings: view.preferences.import } } as never;
          case "list": return { type: action.type, value: { items: [summary], hasMore: false, nextCursor: null } } as never;
          case "create": return { type: action.type, value: { threadId: taskId, requestId: action.value.requestId, runId, accepted: true } } as never;
          case "reparse": return { type: action.type, value: { threadId: newTaskId, requestId: action.value.requestId, runId, accepted: true } } as never;
          case "delete": return { type: action.type, value: { threadId: action.threadId, deleted: true } } as never;
          case "export_bank_zip": return { type: action.type, value: { threadId: action.value.threadId, checkpointId: action.value.checkpointId, saved: true } } as never;
          case "detail": case "head": return { type: action.type, value: { ...task, fileName: source.fileName } } as never;
          case "preview": return { type: action.type, value: preview } as never;
          case "import_bank": return { type: action.type, value: { bankId: newTaskId, count: 2 } } as never;
          case "corrections": return { type: action.type, value: structuredClone(corrections) } as never;
          case "answer_matches": return { type: action.type, value: { checkpointId: action.checkpointId, answerTaskId: action.answerTaskId, answerCheckpointId: "answer-checkpoint", matches: [{ questionIndex: 0, candidates: [0], status: "unique" }] } } as never;
          case "answer_proposal": return { type: action.type, value: { checkpointId: action.checkpointId, answerSource: action.answerSource, question: task.result!.questions[action.questionIndex], corrections: structuredClone(corrections) } } as never;
          case "save_correction": corrections.edits!.push({ requestId: action.value.requestId, questionIndex: action.value.questionIndex, question: action.value.question, savedAt: new Date().toISOString() }); return { type: action.type, value: structuredClone(corrections) } as never;
          default: throw new Error(`Unexpected document action ${action.type}`);
        }
      }
      default: throw new Error(`Unexpected operation ${request.type}`);
    }
  });
  return { calls, source, handler, get view() { return view; } };
}
beforeEach(() => { window.practiq = { request: vi.fn(), close: vi.fn(), onCloseRequested: () => () => {} }; history.replaceState(null, "", "/"); localStorage.clear(); });
afterEach(() => { cleanup(); delete window.practiq; setNativeBridge(null); vi.clearAllMocks(); });

it("keeps the current document selection when the native picker is cancelled", async () => {
  const f = fixture(), user = userEvent.setup(); render(<I18nProvider><CloudPage /></I18nProvider>);
  const button = await screen.findByRole("button", { name: "选择文档" });
  const pick = vi.spyOn(nativeBridge()!, "pickSources");
  pick.mockResolvedValueOnce([]); await user.click(button);
  expect(screen.queryByText("一次请选择 1–10 个文件。")).toBeNull();
  await user.click(button); await screen.findByText("local-source.txt");
  pick.mockResolvedValueOnce([]); await user.click(button);
  expect(screen.getByText("local-source.txt")).toBeTruthy();
  expect(screen.queryByText("一次请选择 1–10 个文件。")).toBeNull();
  expect(f.calls.some(call => call.type === "upload_document_source")).toBe(false);
  expect(f.calls.some(call => call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "create")).toBe(false);
  await user.click(screen.getByRole("button", { name: /开始导入/ }));
  await waitFor(() => expect(f.calls.filter(call => call.type === "upload_document_source")).toEqual([{ type: "upload_document_source", ticket: "opaque-ticket" }]));
});

it("saves exact monetary preferences only explicitly and reports missing reservations without inventing a zero bill", async () => {
  const f = fixture(), user = userEvent.setup(); render(<I18nProvider><CloudPage settingsOnly /></I18nProvider>); await user.click(await screen.findByText("费用预留限制（可选）")); await user.click(screen.getByLabelText("启用费用预留限制"));
  for (const [label, value] of [["预算币种（三位大写代码）", "cny"], ["单任务费用限额", "1.000001"], ["UTC 每日费用限额", "2"], ["模型输入价格（每百万估算 tokens）", "2"], ["模型输出价格（每百万 tokens）", "8"], ["腾讯识别价格（每页）", "0.1"]]) await user.type(screen.getByLabelText(label), value);
  expect(f.calls.some(call => call.type === "save_ai_settings")).toBe(false); await user.click(screen.getByRole("button", { name: "保存 AI 设置" })); await waitFor(() => expect(f.calls.some(call => call.type === "save_ai_settings")).toBe(true));
  const saved = f.calls.find(call => call.type === "save_ai_settings")!.value as { preferences: DesktopAiSettingsView["preferences"]; secrets: object }; expect(saved.preferences.cost).toEqual({ enabled: true, currency: "CNY", taskLimitMicros: 1000001, dailyLimitMicros: 2000000, inputMicrosPerMillion: 2000000, outputMicrosPerMillion: 8000000, tencentMicrosPerPage: 100000 }); expect(saved.secrets).toEqual({});
  await user.click(await screen.findByRole("button", { name: "读取费用预留" })); await screen.findByText("已启用费用预留限制"); await screen.findByText("当日没有费用预留记录。"); expect(f.calls.filter(call => call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "cost_report")).toHaveLength(1); expect(f.calls.some(call => call.type === "document_request" && ["create", "reparse", "control"].includes((call.request as DesktopDocumentRequest).type))).toBe(false);
});

it("reads per-task retained reservations only on request and surfaces an unavailable ledger instead of zero usage", async () => {
  const f = fixture(), original = f.handler.getMockImplementation()!; let fail = false;
  f.handler.mockImplementation(async (...args) => {
    const request = args[1]?.request as { type: string; request?: DesktopDocumentRequest };
    if (request.type === "document_request" && request.request?.type === "cost_report" && fail) throw { code: "COST_STORE_UNAVAILABLE" };
    const reply = await original(...args); if (request.type === "document_request" && request.request?.type === "cost_report") return { type: "cost_report", value: { ...(reply as Extract<DesktopDocumentReply, { type: "cost_report" }>).value, day: { currency: "CNY", reservedMicros: 1234567 }, task: { currency: "CNY", reservedMicros: 234567 } } } as never; return reply;
  });
  const user = userEvent.setup(); render(<I18nProvider><CloudPage /></I18nProvider>); await user.click(await screen.findByRole("link", { name: "导入记录" })); await user.click(await screen.findByRole("button", { name: summary.fileName })); await user.click(await screen.findByText("模型用量与任务诊断"));
  expect(f.calls.some(call => call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "cost_report")).toBe(false); await user.click(await screen.findByRole("button", { name: "读取费用预留" })); await screen.findByText("当日已预留：CNY 1.234567"); await screen.findByText("本任务已预留：CNY 0.234567");
  const report = f.calls.find(call => call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "cost_report")!.request as Extract<DesktopDocumentRequest, { type: "cost_report" }>; expect(report.threadId).toBe(taskId);
  fail = true; await user.click(screen.getByRole("button", { name: "读取费用预留" })); await screen.findByText("费用预留账目无法读取或保存。现有记录保留，请核对后手动重试。"); expect(screen.queryByText("当日已预留：CNY 1.234567")).toBeNull();
});

it("requires explicitly saving private COS staging preferences and preserves credentials without starting provider work", async () => {
  const f = fixture(), user = userEvent.setup(); render(<I18nProvider><CloudPage settingsOnly /></I18nProvider>); await user.click(await screen.findByText("私有 COS 暂存（高级，可选）"));
  expect((screen.getByLabelText("启用私有 COS 暂存") as HTMLInputElement).getAttribute("aria-checked")).toBe("false");
  await user.click(screen.getByLabelText("启用私有 COS 暂存")); await user.type(screen.getByLabelText("COS 存储桶（含 APPID）"), "fixture-1250000000"); await user.type(screen.getByLabelText("COS 地域"), "ap-guangzhou");
  expect(f.calls.some(call => call.type === "save_ai_settings")).toBe(false); await user.click(screen.getByRole("button", { name: "保存 AI 设置" }));
  await waitFor(() => expect(f.calls.some(call => call.type === "save_ai_settings")).toBe(true)); const saved = f.calls.find(call => call.type === "save_ai_settings")!.value as { preferences: DesktopAiSettingsView["preferences"]; secrets: object };
  expect(saved.preferences.tencentCos).toEqual({ enabled: true, bucket: "fixture-1250000000", region: "ap-guangzhou" }); expect(saved.secrets).toEqual({}); expect(f.calls.some(call => call.type === "document_request" && ["create", "reparse", "control"].includes((call.request as DesktopDocumentRequest).type))).toBe(false);
});

it("previews task cleanup only explicitly and submits only after reviewing and confirming the displayed batch", async () => {
  const f = fixture(), original = f.handler.getMockImplementation()!;
  f.handler.mockImplementation(async (...args) => { const reply = await original(...args), request = args[1]?.request as { type: string; request?: DesktopDocumentRequest }; if (request.type === "document_request" && request.request?.type === "maintenance_preview") return { type: "maintenance_preview", value: { ...(reply as Extract<DesktopDocumentReply, { type: "maintenance_preview" }>).value, candidates: [{ threadId: taskId, kind: "expired", fileName: "expired.txt" }], hasMore: true, skipped: 2 } } as never; return reply; });
  const user = userEvent.setup(); render(<I18nProvider><CloudPage settingsOnly /></I18nProvider>); await screen.findByRole("heading", { name: "AI 任务清理" });
  expect(f.calls.some(call => call.type === "document_request" && ["maintenance_preview", "cleanup_state"].includes((call.request as DesktopDocumentRequest).type))).toBe(false);
  await user.click(screen.getByRole("button", { name: "检查可清理任务" })); await screen.findByText("expired.txt · 已过期任务"); await screen.findByText("仍有更多候选项，完成本批后请重新检查。", { exact: false });
  expect(f.calls.some(call => call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "cleanup_state")).toBe(false);
  await user.click(screen.getByRole("button", { name: "关闭清理预览" })); expect(screen.queryByText("expired.txt · 已过期任务")).toBeNull();
  await user.click(screen.getByRole("button", { name: "检查可清理任务" })); await user.click(await screen.findByRole("button", { name: "确认清理本批任务状态" })); await screen.findByText("已清理 1 项任务状态。原文、题库、练习数据和调用记录均保留。");
  const mutation = f.calls.find(call => call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "cleanup_state")!.request as Extract<DesktopDocumentRequest, { type: "cleanup_state" }>; expect(mutation.value.previewId).toBe(taskId); expect(mutation.value.requestId).toMatch(/^[a-f0-9-]{36}$/);
});

it("recovers an uncertain cleanup from its backend receipt only after explicitly continuing the pending batch", async () => {
  const f = fixture(), original = f.handler.getMockImplementation()!; let fail = true;
  f.handler.mockImplementation(async (...args) => {
    const request = args[1]?.request as { type: string; request?: DesktopDocumentRequest };
    if (request.type === "document_request" && request.request?.type === "cleanup_state" && fail) throw { code: "AI_RUNTIME_UNAVAILABLE" };
    const reply = await original(...args);
    if (request.type === "document_request" && request.request?.type === "maintenance_preview") return { type: "maintenance_preview", value: { ...(reply as Extract<DesktopDocumentReply, { type: "maintenance_preview" }>).value, pending: [{ requestId: newTaskId, previewId: runId, completed: 0, total: 1 }] } } as never;
    return reply;
  });
  const user = userEvent.setup(); render(<I18nProvider><CloudPage settingsOnly /></I18nProvider>); await user.click(await screen.findByRole("button", { name: "检查可清理任务" })); await screen.findByText("未完成的清理：已完成 0/1 项。");
  expect(f.calls.some(call => call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "cleanup_state")).toBe(false);
  await user.click(screen.getByRole("button", { name: "继续未完成清理" })); await screen.findByText("清理结果可能尚未确认。请重新检查，未完成批次只会在明确点击继续后执行。");
  fail = false; await user.click(screen.getByRole("button", { name: "检查可清理任务" })); await user.click(await screen.findByRole("button", { name: "继续未完成清理" }));
  await screen.findByText("已清理 1 项任务状态。原文、题库、练习数据和调用记录均保留。"); const values = f.calls.filter(call => call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "cleanup_state").map(call => (call.request as Extract<DesktopDocumentRequest, { type: "cleanup_state" }>).value); expect(values).toEqual([{ requestId: newTaskId, previewId: runId }]);
});

it("disables cleanup confirmation while work is active and inspection while AI settings are dirty", async () => {
  const f = fixture(), original = f.handler.getMockImplementation()!;
  f.handler.mockImplementation(async (...args) => { const reply = await original(...args), request = args[1]?.request as { type: string; request?: DesktopDocumentRequest }; if (request.type === "document_request" && request.request?.type === "maintenance_preview") return { type: "maintenance_preview", value: { ...(reply as Extract<DesktopDocumentReply, { type: "maintenance_preview" }>).value, candidates: [{ threadId: taskId, kind: "orphan", fileName: null }], canClean: false } } as never; return reply; });
  const user = userEvent.setup(); render(<I18nProvider><CloudPage settingsOnly /></I18nProvider>); await user.click(await screen.findByRole("button", { name: "检查可清理任务" }));
  await screen.findByText("请先停止 AI 任务，并等待导出和原文修复结束，再重新检查。"); expect((screen.getByRole("button", { name: "确认清理本批任务状态" }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(screen.getByLabelText("模型 ID"), "changed"); expect((screen.getByRole("button", { name: "检查可清理任务" }) as HTMLButtonElement).disabled).toBe(true);
});

it("shows an unknown call reservation and partial usage without interpreting damaged accounting as zero", async () => {
  const f = fixture(), original = f.handler.getMockImplementation()!;
  f.handler.mockImplementation(async (...args) => {
    const request = args[1]?.request as { type: string; request?: DesktopDocumentRequest }, reply = await original(...args);
    if (request.type === "document_request" && ["detail", "head"].includes(request.request?.type ?? "")) return { type: request.request!.type, value: { ...task, state: "FAILED", resumeCompatible: false, allowedActions: [], blocking: [{ code: "TASK_ACCOUNTING_UNREADABLE" }, { code: "TASK_CHECKPOINT_UNREADABLE" }], modelBudget: { limit: 8, reserved: null }, result: null, processing: null, canExportCompleted: false, status: null } } as never; return reply;
  });
  const user = userEvent.setup(); render(<I18nProvider><CloudPage /></I18nProvider>); await user.click(await screen.findByRole("link", { name: "导入记录" })); await user.click(await screen.findByRole("button", { name: summary.fileName })); await user.click(await screen.findByText("模型用量与任务诊断"));
  await screen.findByText("调用预算：预留数未知；任务上限 8 次。"); await screen.findByText("部分调用或额度记录无法验证，实际总用量可能未知。继续和重试已停用，原始记录保留。"); await screen.findByText("已知用量：1 次调用，输入 21 tokens，输出 8 tokens。"); expect(screen.queryByText("调用预算：已预留 0/8 次。")).toBeNull(); expect(screen.queryByRole("button", { name: "继续解析" })).toBeNull();
  expect(f.calls.some(call => call.type === "document_request" && ["control", "create", "reparse"].includes((call.request as DesktopDocumentRequest).type))).toBe(false);
});

it("renders exact known token totals even when their sum exceeds the JSON safe integer range", async () => {
  const f = fixture(), original = f.handler.getMockImplementation()!;
  f.handler.mockImplementation(async (...args) => {
    const request = args[1]?.request as { type: string; request?: DesktopDocumentRequest }, reply = await original(...args);
    if (request.type === "document_request" && request.request?.type === "detail") return { type: "detail", value: { ...task, usage: [runId, newTaskId, taskId].map(callKey => ({ ...task.usage[0], callKey, inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 })) } } as never; return reply;
  });
  const user = userEvent.setup(); render(<I18nProvider><CloudPage /></I18nProvider>); await user.click(await screen.findByRole("link", { name: "导入记录" })); await user.click(await screen.findByRole("button", { name: summary.fileName })); await user.click(await screen.findByText("模型用量与任务诊断")); await screen.findByText("已知用量：3 次调用，输入 27021597764222973 tokens，输出 0 tokens。");
});

it("shows unreadable saved evidence with disabled paid controls and export, then recovers only after a verified refresh", async () => {
  const f = fixture(), original = f.handler.getMockImplementation()!; let damaged = true;
  f.handler.mockImplementation(async (...args) => {
    const reply = await original(...args), request = args[1]?.request as { type: string; request?: DesktopDocumentRequest };
    if (damaged && request.type === "document_request") {
      if (request.request?.type === "detail" || request.request?.type === "head") return { type: request.request.type, value: { ...task, state: "FAILED", resumeCompatible: false, allowedActions: [], blocking: [{ code: "TASK_CHECKPOINT_UNREADABLE" }], result: null, processing: null, canExportCompleted: false, status: null } } as never;
      if (request.request?.type === "preview") return { type: "preview", value: { ...preview, state: "FAILED", units: [], corrections: null } } as never;
    }
    return reply;
  });
  const user = userEvent.setup(); render(<I18nProvider><CloudPage /></I18nProvider>); await user.click(await screen.findByRole("link", { name: "导入记录" })); await user.click(await screen.findByRole("button", { name: summary.fileName }));
  await screen.findByText("保存的任务结果或检查点无法读取，继续、重试和导出已停用。原文件、调用记录和用量记录仍保留。");
  expect((screen.getByRole("button", { name: "导入题库" }) as HTMLButtonElement).disabled).toBe(true); expect((screen.getByRole("button", { name: "导出题库 ZIP" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "继续解析" })).toBeNull(); expect(screen.queryByRole("button", { name: "重试失败单元" })).toBeNull(); expect(screen.queryByText("当前模型配置与检查点不兼容。")).toBeNull();
  expect(f.calls.some(call => call.type === "document_request" && ["create", "control", "reparse", "export_bank_zip", "import_bank"].includes((call.request as DesktopDocumentRequest).type))).toBe(false);
  damaged = false; await user.click(screen.getByRole("button", { name: "刷新任务详情" }));
  await waitFor(() => expect(screen.queryByText("保存的任务结果或检查点无法读取，继续、重试和导出已停用。原文件、调用记录和用量记录仍保留。")).toBeNull());
  await waitFor(() => expect((screen.getByRole("button", { name: "导入题库" }) as HTMLButtonElement).disabled).toBe(false));
});

it("shows encrypted credential settings, preserves blank keys and clears keys only explicitly", async () => {
  const f = fixture(), user = userEvent.setup(); render(<I18nProvider><CloudPage settingsOnly /></I18nProvider>);
  await screen.findByRole("heading", { name: "AI 模型与识别" }); expect(screen.queryByLabelText("AI 服务地址")).toBeNull();
  await user.clear(screen.getByLabelText("模型 ID")); await user.type(screen.getByLabelText("模型 ID"), "changed-model");
  await user.type(screen.getByLabelText(/腾讯 Secret Key/), "NEW_TEST_SECRET");
  await user.click(screen.getAllByRole("button", { name: "清除凭据" })[0]);
  await user.click(screen.getByRole("button", { name: "保存 AI 设置" }));
  await waitFor(() => expect(f.calls.some(call => call.type === "save_ai_settings")).toBe(true));
  const saved = f.calls.find(call => call.type === "save_ai_settings")!; expect(saved.value).toMatchObject({ preferences: { model: { modelId: "changed-model" } }, secrets: { modelApiKey: "", tencentSecretKey: "NEW_TEST_SECRET" } });
  expect((saved.value as { secrets: object }).secrets).not.toHaveProperty("tencentSecretId");
  await waitFor(() => expect((screen.getByLabelText(/腾讯 Secret Key/) as HTMLInputElement).value).toBe(""));
  expect(JSON.stringify(Object.entries(localStorage))).not.toContain("NEW_TEST_SECRET"); expect(f.calls.some(call => call.type === "status" || call.type === "configure" || call.type === "fetch")).toBe(false);
});

it("keeps dirty credentials on the settings page until saved or cancelled", async () => {
  fixture(); const user = userEvent.setup(); render(<I18nProvider><CloudPage settingsOnly /></I18nProvider>);
  await screen.findByRole("heading", { name: "AI 模型与识别" }); await user.type(screen.getByLabelText(/模型 API Key/), "EPHEMERAL_TEST_KEY");
  expect(document.dispatchEvent(new Event("practiq-cloud-before-leave", { cancelable: true }))).toBe(false);
  await screen.findByText("请先保存 AI 设置或取消修改。"); await user.click(screen.getByRole("button", { name: "取消" }));
  expect((screen.getByLabelText(/模型 API Key/) as HTMLInputElement).value).toBe(""); expect(document.dispatchEvent(new Event("practiq-cloud-before-leave", { cancelable: true }))).toBe(true);
});

it("waits for its replacement native bridge before remounting the workspace after settings reload", async () => {
  const f = fixture(), user = userEvent.setup(), fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected HTTP fallback"));
  try {
    render(<I18nProvider><CloudPage settingsOnly /></I18nProvider>);
    const model = await screen.findByLabelText("模型 ID"), previous = nativeBridge(); await user.clear(model); await user.type(model, "after-reload"); await user.click(screen.getByRole("button", { name: "保存 AI 设置" }));
    await waitFor(() => { expect(nativeBridge()).not.toBe(previous); expect(nativeBridge()?.revision).toBe(f.view.revision); });
    await waitFor(() => expect((screen.getByLabelText("模型 ID") as HTMLInputElement).value).toBe("after-reload"));
    expect(fetch).not.toHaveBeenCalled(); expect(nativeBridge()?.documents).toBeTypeOf("function");
  } finally { fetch.mockRestore(); }
});

it("flushes pending recognition preferences before explicitly discarding credential edits", async () => {
  const f = fixture(), user = userEvent.setup(), flushRef = { current: async () => {} }; render(<I18nProvider><CloudPage settingsOnly flushRef={flushRef} /></I18nProvider>);
  const concurrency = await screen.findByLabelText("腾讯识别并发上限"); await user.clear(concurrency); await user.type(concurrency, "1");
  await user.type(screen.getByLabelText(/模型 API Key/), "DISCARD_THIS_KEY");
  await user.click(screen.getByRole("button", { name: "放弃修改并重新读取" }));
  await waitFor(() => expect((screen.getByLabelText(/模型 API Key/) as HTMLInputElement).value).toBe(""));
  expect(f.view.preferences.import.tencentConcurrency).toBe(1); expect(f.calls.some(call => call.type === "save_ai_settings")).toBe(false);
});

it("uses native tickets and typed commands for the import and review workflow", async () => {
  const f = fixture(), user = userEvent.setup(); render(<I18nProvider><CloudPage /></I18nProvider>);
  await user.click(await screen.findByRole("button", { name: "选择文档" })); await screen.findByText("local-source.txt");
  expect(f.calls.filter(call => call.type === "document_request").some(call => (call.request as DesktopDocumentRequest).type === "create")).toBe(false);
  await user.click(screen.getByRole("button", { name: /开始导入/ }));
  await waitFor(() => expect(f.calls.some(call => call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "create")).toBe(true));
  const created = f.calls.find(call => call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "create")!;
  expect(created.request).toMatchObject({ type: "create", revision: taskId, value: { document: f.source } });
  await screen.findByText("根据材料选择答案"); expect(f.calls.some(call => call.type === "fetch" || call.type === "status")).toBe(false);
  const imported = vi.fn(); window.addEventListener("practiq-bank-imported", imported);
  try {
    await user.click(screen.getByRole("button", { name: "导入题库" }));
    await waitFor(() => expect(imported).toHaveBeenCalledOnce());
    expect(f.calls.find(call => call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "import_bank")?.request).toMatchObject({ type: "import_bank", value: { threadId: taskId, checkpointId: task.checkpointId, scope: "full" } });
  } finally { window.removeEventListener("practiq-bank-imported", imported); }
});

it("saves full and selected ZIPs through native commands without importing another bank", async () => {
  const f = fixture(), user = userEvent.setup(), imported = vi.fn(); window.addEventListener("practiq-bank-imported", imported);
  try {
    render(<I18nProvider><CloudPage /></I18nProvider>); await user.click(await screen.findByRole("link", { name: "导入记录" })); await user.click(await screen.findByRole("button", { name: summary.fileName }));
    await user.click(await screen.findByRole("button", { name: "导出题库 ZIP" })); await screen.findByText("题库 ZIP 已保存。");
    expect(screen.getByText("题库 ZIP 已保存。").closest("#task-detail")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "勾选本页" })); await user.click(screen.getByRole("button", { name: "导出所选题目 ZIP" }));
    await waitFor(() => expect(f.calls.filter(call => call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "export_bank_zip")).toHaveLength(2));
    const exports = f.calls.filter(call => call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "export_bank_zip").map(call => call.request);
    expect(exports[0]).toMatchObject({ value: { threadId: taskId, checkpointId: task.checkpointId, scope: "full" } }); expect(exports[1]).toMatchObject({ value: { questionIndexes: [0, 1, 2] } });
    expect(imported).not.toHaveBeenCalled(); expect(f.calls.some(call => call.type === "fetch" || call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "import_bank")).toBe(false);
  } finally { window.removeEventListener("practiq-bank-imported", imported); }
});

it("binds revised and stopped-result ZIP selections and treats native cancellation as a passive outcome", async () => {
  const f = fixture(), original = f.handler.getMockImplementation()!; let cancelled = false;
  f.handler.mockImplementation(async (...args) => { const reply = await original(...args), request = args[1]?.request as { type: string; request?: DesktopDocumentRequest }; if (cancelled && request.type === "document_request" && request.request?.type === "export_bank_zip") return { ...reply as object, value: { threadId: request.request.value.threadId, checkpointId: request.request.value.checkpointId, saved: false } } as never; return reply; });
  setNativeBridge(desktopCloudBridge(f.view)); const client = new Client(); expect(await client.saveBankZip(task, runId, [0])).toBe(true); expect(f.calls.at(-1)?.request).toMatchObject({ value: { revisionId: runId, questionIndexes: [0], scope: "full" } });
  cancelled = true; expect(await client.saveBankZip({ ...task, state: "FAILED", canExportCompleted: true })).toBe(false); expect(f.calls.at(-1)?.request).toMatchObject({ value: { scope: "completed" } });
  expect(client.pendingImports()).toEqual([]); expect(client.pendingReparses()).toEqual([]); expect(f.calls.some(call => call.type === "fetch")).toBe(false); client.disconnect();
});

it.each(["task", "checkpoint", "saved"])("rejects a mismatched %s ZIP receipt without replay or import", async kind => {
  const f = fixture(), original = f.handler.getMockImplementation()!;
  f.handler.mockImplementation(async (...args) => { const reply = await original(...args), request = args[1]?.request as { type: string; request?: DesktopDocumentRequest }; if (request.type === "document_request" && request.request?.type === "export_bank_zip") return { type: "export_bank_zip", value: { threadId: kind === "task" ? newTaskId : taskId, checkpointId: kind === "checkpoint" ? "other-checkpoint" : task.checkpointId, saved: kind === "saved" ? "true" : true } } as never; return reply; });
  setNativeBridge(desktopCloudBridge(f.view)); const client = new Client(); await expect(client.saveBankZip(task)).rejects.toMatchObject({ code: "INVALID_RESPONSE" }); expect(f.calls.filter(call => call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "export_bank_zip")).toHaveLength(1); expect(f.calls.some(call => call.type === "fetch")).toBe(false); client.disconnect();
});

it.each([false, true])("freezes generation opt-in %s only when explicitly starting native import", async enabled => {
  const f = fixture(), user = userEvent.setup(); f.view.preferences.import.generateAnswers = enabled; render(<I18nProvider><CloudPage /></I18nProvider>);
  await user.click(await screen.findByRole("button", { name: "选择文档" })); await screen.findByText("local-source.txt");
  expect(f.calls.some(call => call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "create")).toBe(false);
  await user.click(screen.getByRole("button", { name: /开始导入/ }));
  await waitFor(() => expect(f.calls.some(call => call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "create")).toBe(true));
  const created = f.calls.find(call => call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "create")!.request as Extract<DesktopDocumentRequest, { type: "create" }>;
  expect(created.value.generateAnswers ?? false).toBe(enabled); expect(created.value.documentRole ?? "questions").toBe("questions");
  expect(f.calls.some(call => call.type === "fetch")).toBe(false);
});

it("retains an uncertain create and reuses its request ID only on an explicit retry", async () => {
  const f = fixture(), bridge = desktopCloudBridge(f.view); setNativeBridge(bridge); const client = new Client(), original = f.handler.getMockImplementation()!; let fail = true;
  f.handler.mockImplementation(async (...args) => { const request = args[1]?.request as { type: string; request?: DesktopDocumentRequest }; if (request.type === "document_request" && request.request?.type === "create" && fail) throw { code: "AI_RUNTIME_UNAVAILABLE" }; return original(...args); });
  await expect(client.start({ nativeTicket: "opaque-ticket", name: f.source.fileName!, size: 4 }, capabilities, taskId, () => {})).rejects.toMatchObject({ code: "AI_RUNTIME_UNAVAILABLE" });
  expect(client.pendingImports()).toHaveLength(1); expect(client.pendingImports()[0].requestId).toBe(taskId); fail = false;
  expect((await client.retryImport(taskId)).requestId).toBe(taskId); expect(client.pendingImports()).toHaveLength(0); client.disconnect();
});

it("maps workspace state groups and adopts only acknowledged settings revisions", async () => {
  const f = fixture(), bridge = desktopCloudBridge(f.view); setNativeBridge(bridge); const client = new Client();
  await client.list(20, "review"); expect(f.calls.at(-1)?.request).toMatchObject({ type: "list", state: "WAITING_REVIEW", offset: 20 });
  const saved = await client.saveImportSettings({ revision: taskId, settings: { ...f.view.preferences.import, tencentConcurrency: 1 } }); expect(bridge.revision).toBe(saved.revision);
  await client.list(0, "active"); expect(f.calls.at(-1)?.request).toMatchObject({ type: "list", state: "active", revision: saved.revision });
  await expect(client.delete(taskId)).resolves.toEqual({ threadId: taskId, deleted: true }); expect(nativeBridge()).toBe(bridge); client.disconnect();
});

it("forwards native page cursors with zero offset and keeps cancellation distinct", async () => {
  const f = fixture(); setNativeBridge(desktopCloudBridge(f.view)); const client = new Client();
  await client.list(20, "cancelled", undefined, "opaque-cursor"); expect(f.calls.at(-1)?.request).toMatchObject({ type: "list", state: "CANCELLED", offset: 0, cursor: "opaque-cursor" }); expect(f.calls.some(call => call.type === "fetch")).toBe(false); client.disconnect();
});

it("retains deletion intent through an uncertain native response and remount, then retries only explicitly", async () => {
  const f = fixture(), original = f.handler.getMockImplementation()!; let fail = true;
  f.handler.mockImplementation(async (...args) => { const request = args[1]?.request as { type: string; request?: DesktopDocumentRequest }; if (request.type === "document_request" && request.request?.type === "delete" && fail) throw { code: "AI_RUNTIME_UNAVAILABLE" }; return original(...args); });
  setNativeBridge(desktopCloudBridge(f.view)); const first = new Client(); await expect(first.delete(taskId)).rejects.toMatchObject({ code: "AI_RUNTIME_UNAVAILABLE" }); expect(first.pendingDeletions()).toEqual([taskId]); first.disconnect();
  const previous = f.calls.length, user = userEvent.setup(); render(<I18nProvider><CloudPage /></I18nProvider>); const panel = await screen.findByRole("region", { name: "未确认的任务删除" }); expect(f.calls.slice(previous).some(call => call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "delete")).toBe(false);
  fail = false; await user.click(screen.getByRole("button", { name: "重试原任务删除" })); await screen.findByText("任务已删除。"); await waitFor(() => expect(panel.isConnected).toBe(false)); expect(new Client().pendingDeletions()).toEqual([]); expect(f.calls.some(call => call.type === "fetch")).toBe(false);
});

it("refuses deletion when recovery storage is invalid or unavailable before native mutation", async () => {
  const f = fixture(); setNativeBridge(desktopCloudBridge(f.view)); const client = new Client(), key = storageKey("practiq-delete-intents-v1", client.storageScope);
  localStorage.setItem(key, JSON.stringify([taskId, taskId])); await expect(client.delete(taskId)).rejects.toMatchObject({ code: "RECOVERY_STORAGE_UNAVAILABLE" }); expect(f.calls).toEqual([]); localStorage.removeItem(key);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("quota"); }); await expect(client.delete(taskId)).rejects.toMatchObject({ code: "RECOVERY_STORAGE_UNAVAILABLE" }); expect(f.calls).toEqual([]); vi.restoreAllMocks(); client.disconnect();
});

it("retains a deletion with a mismatched receipt and lets users dismiss only its local notice", async () => {
  const f = fixture(), original = f.handler.getMockImplementation()!; f.handler.mockImplementation(async (...args) => { const request = args[1]?.request as { type: string; request?: DesktopDocumentRequest }; if (request.type === "document_request" && request.request?.type === "delete") return { type: "delete", value: { threadId: newTaskId, deleted: true } } as never; return original(...args); });
  setNativeBridge(desktopCloudBridge(f.view)); const client = new Client(); await expect(client.delete(taskId)).rejects.toMatchObject({ code: "INVALID_RESPONSE" }); expect(client.pendingDeletions()).toEqual([taskId]); client.forgetDeletion(taskId); expect(client.pendingDeletions()).toEqual([]); expect(f.calls.some(call => call.type === "fetch")).toBe(false); client.disconnect();
});

it("verifies native artifact checksums independently of reference property order", async () => {
  const f = fixture(), bytes = new TextEncoder().encode("saved proof"), reference = { objectKey: "owned-proof", sha256: await sha256(bytes.buffer), sizeBytes: bytes.length, mediaType: "text/plain" };
  const bridge = desktopCloudBridge(f.view); setNativeBridge(bridge); let corrupt = false;
  bridge.documents = vi.fn(async () => ({ type: "artifact" as const, value: { reference: { mediaType: reference.mediaType, sizeBytes: reference.sizeBytes, sha256: reference.sha256, objectKey: reference.objectKey }, bytes: Buffer.from(corrupt ? "other proof" : bytes).toString("base64") } }));
  const client = new Client(); expect((await client.evidence(reference, taskId)).size).toBe(bytes.length); corrupt = true;
  await expect(client.evidence(reference, taskId)).rejects.toMatchObject({ code: "ARTIFACT_CHECKSUM_MISMATCH" }); client.disconnect();
});

it("abandons a disconnected native wait without forgetting or replaying its create", async () => {
  const f = fixture(), bridge = desktopCloudBridge(f.view); setNativeBridge(bridge); const documents = bridge.documents!.bind(bridge); let finish!: (value: DesktopDocumentReply) => void;
  bridge.documents = vi.fn(request => request.type === "create" ? new Promise<DesktopDocumentReply>(resolve => { finish = resolve; }) : documents(request));
  const client = new Client(), pending = client.start({ nativeTicket: "opaque-ticket", name: f.source.fileName!, size: 4 }, capabilities, taskId, () => {}), rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await waitFor(() => expect(bridge.documents).toHaveBeenCalledWith(expect.objectContaining({ type: "create" })));
  client.disconnect(); await rejected; expect(client.pendingImports()[0].requestId).toBe(taskId);
  finish({ type: "create", value: { threadId: taskId, requestId: taskId, runId, accepted: true } }); await Promise.resolve(); expect(client.pendingImports()).toHaveLength(1); expect(bridge.documents).toHaveBeenCalledOnce();
});

it("reads and saves revisions through native commands and imports only the named revision", async () => {
  const f = fixture(), bridge = desktopCloudBridge(f.view); setNativeBridge(bridge); const client = new Client();
  expect((await client.corrections(taskId)).edits).toEqual([]);
  const value = { requestId: newTaskId, checkpointId: task.checkpointId!, expectedRevision: null, questionIndex: 0, question: { ...task.result!.questions[0], stem: "Human corrected" } };
  expect((await client.saveCorrection(taskId, value)).edits![0].requestId).toBe(newTaskId);
  expect(f.calls.at(-1)?.request).toEqual({ type: "save_correction", revision: taskId, threadId: taskId, value });
  await client.exportBank(task, newTaskId); expect(f.calls.at(-1)?.request).toMatchObject({ type: "import_bank", value: { revisionId: newTaskId } });
  expect(f.calls.some(call => call.type === "fetch")).toBe(false); client.disconnect();
});

it("uses passive native commands for answer suggestions and proposals with the reviewed checkpoints", async () => {
  const f = fixture(), bridge = desktopCloudBridge(f.view); setNativeBridge(bridge); const client = new Client(), source = { taskId: newTaskId, checkpointId: "answer-checkpoint", questionIndex: 0, replaceExisting: false };
  expect((await client.answerMatches(task, newTaskId)).matches[0].status).toBe("unique"); expect(f.calls.at(-1)?.request).toEqual({ type: "answer_matches", revision: taskId, threadId: taskId, checkpointId: task.checkpointId, answerTaskId: newTaskId });
  expect((await client.answerProposal(task, 0, source)).answerSource).toEqual(source); expect(f.calls.at(-1)?.request).toEqual({ type: "answer_proposal", revision: taskId, threadId: taskId, checkpointId: task.checkpointId, questionIndex: 0, answerSource: source });
  expect(f.calls.some(call => call.type === "fetch")).toBe(false); expect(f.calls.some(call => call.type === "document_request" && (call.request as DesktopDocumentRequest).type === "save_correction")).toBe(false); client.disconnect();
});

it("uses native reparse receipts and freezes uncertain selections until explicit retry", async () => {
  const f = fixture(), bridge = desktopCloudBridge(f.view); setNativeBridge(bridge); const client = new Client(), original = f.handler.getMockImplementation()!, selection = { checkpointId: task.checkpointId!, units: [{ stage: "document_parse" as const, index: 2 }] }; let uncertain = true;
  f.handler.mockImplementation(async (...args) => { const request = args[1]?.request as { type: string; request?: DesktopDocumentRequest }; if (request.type === "document_request" && request.request?.type === "reparse" && uncertain) throw { code: "AI_RUNTIME_UNAVAILABLE" }; return original(...args); });
  await expect(client.reparse(taskId, selection)).rejects.toMatchObject({ code: "AI_RUNTIME_UNAVAILABLE", status: 0 });
  const pending = client.pendingReparses()[0]; expect(pending.selection).toEqual(selection);
  await expect(client.reparse(taskId, { ...selection, units: [{ stage: "document_parse", index: 1 }] })).rejects.toMatchObject({ code: "RECOVERY_PENDING" });
  uncertain = false; expect((await client.retryReparse(pending.requestId)).threadId).toBe(newTaskId);
  expect(f.calls.at(-1)?.request).toEqual({ type: "reparse", revision: taskId, threadId: taskId, value: { requestId: pending.requestId, selection } });
  expect(client.pendingReparses()).toEqual([]); expect(f.calls.some(call => call.type === "fetch")).toBe(false); client.disconnect();
});

it.each([["CORRECTION_CONFLICT", 409], ["CORRECTION_INVALID", 422], ["CORRECTION_HISTORY_LIMIT", 413], ["AI_RUNTIME_UNAVAILABLE", 0]] as const)("preserves correction rejection certainty for %s", async (code, status) => {
  const f = fixture(), bridge = desktopCloudBridge(f.view); setNativeBridge(bridge); const client = new Client(); f.handler.mockRejectedValue({ code });
  await expect(client.saveCorrection(taskId, { requestId: newTaskId, checkpointId: task.checkpointId!, expectedRevision: null, questionIndex: 0, question: task.result!.questions[0] })).rejects.toMatchObject({ code, status }); client.disconnect();
});
