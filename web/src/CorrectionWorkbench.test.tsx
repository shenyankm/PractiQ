import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import ResultReview from "./ResultReview";
import { ApiError, Client } from "./api";
import type { DocumentCorrections } from "./contracts.generated";
import { preview, question, task } from "./test-fixtures";

const original = question({ id: "ordinary", parentId: null, optionSourceId: null, answerMode: "true_false", choiceVariant: null, questionTypeId: null, stem: "Original question", sourceText: "Original question", confidence: .8 });
const detail = { ...task, status: "SUCCEEDED" as const, result: { ...task.result!, questions: [original], groups: [] } };
const sourceRef = { objectKey: "source", sha256: "a".repeat(64), sizeBytes: 17, mediaType: "text/plain" };
const metadata = { ...preview, units: [{ stage: "document_parse" as const, index: 0, questions: [], groups: [], sourceRef }], questionSources: [{ questionId: original.id!, stage: "document_parse" as const, unitIndex: 0 }], corrections: { checkpointId: detail.checkpointId!, edits: [] } };

async function open() {
  const user = userEvent.setup();
  await user.click(screen.getByText("Original question", { selector: "summary span" }));
  await user.click(screen.getByRole("button", { name: "对照原文与校对" }));
  return user;
}

it("locates saved source, saves human edits, reopens revisions and exports explicit revision", async () => {
  vi.spyOn(Client.prototype, "evidence").mockResolvedValue({ text: async () => "Original question" } as Blob);
  const save = vi.spyOn(Client.prototype, "saveCorrection").mockImplementation(async (_id, value) => ({ checkpointId: value.checkpointId, edits: [{ requestId: value.requestId, questionIndex: value.questionIndex, question: value.question, savedAt: "2026-11-06T00:00:00Z" }] }));
  const exported = vi.spyOn(Client.prototype, "exportBank").mockResolvedValue({ blob: new Blob(["zip"]), name: "revised.zip" });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:revised");
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const before = JSON.stringify([detail, metadata]);
  const view = render(<ResultReview task={detail} preview={metadata} client={new Client()} />);
  const user = await open();
  expect((await screen.findByText("Original question", { selector: "mark" })).tagName).toBe("MARK");
  expect(screen.getByRole("button", { name: "下载修订版 ZIP" }).hasAttribute("disabled")).toBe(true);
  await user.click(screen.getByRole("button", { name: "人工校对" }));
  await user.clear(screen.getByRole("textbox", { name: "题干" }));
  await user.type(screen.getByRole("textbox", { name: "题干" }), "Corrected question");
  await user.type(screen.getByRole("textbox", { name: "题型标签" }), "判断题");
  await user.click(screen.getByRole("button", { name: "保存修订" }));
  expect(await screen.findByText(/修订已保存/)).toBeTruthy();
  expect(save).toHaveBeenCalledWith(task.threadId, expect.objectContaining({ questionIndex: 0, expectedRevision: null, question: expect.objectContaining({ stem: "Corrected question", sourceText: "Original question", needsReview: true }) }));
  await user.click(screen.getByRole("button", { name: "下载修订版 ZIP" }));
  expect(exported).toHaveBeenCalledWith(detail, expect.any(String));
  await user.click(screen.getByRole("button", { name: "返回题目列表" }));
  expect(screen.getByText("Corrected question", { selector: "summary span" })).toBeTruthy();
  expect(JSON.stringify([detail, metadata])).toBe(before);
  const saved = await save.mock.results[0].value;
  view.unmount();
  render(<ResultReview task={detail} preview={{ ...metadata, corrections: saved }} client={new Client()} />);
  expect(screen.getByText("Corrected question", { selector: "summary span" })).toBeTruthy();
});

it("keeps a failed or conflicting save draft and reloads without automatically resubmitting", async () => {
  vi.spyOn(Client.prototype, "evidence").mockRejectedValue(Error("damaged"));
  const save = vi.spyOn(Client.prototype, "saveCorrection").mockRejectedValue(new ApiError("其他窗口已保存修订", "CORRECTION_CONFLICT", 409));
  const existing: DocumentCorrections = { checkpointId: task.checkpointId!, edits: [{ requestId: "22222222-2222-4222-8222-222222222222", questionIndex: 0, question: { ...original, stem: "Other writer" }, savedAt: "2026-11-06T00:00:00Z" }] };
  const reload = vi.spyOn(Client.prototype, "corrections").mockResolvedValue(existing);
  render(<ResultReview task={detail} preview={metadata} client={new Client()} />);
  const user = await open();
  expect(await screen.findByText("来源读取或校验失败，请重试。")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "人工校对" }));
  await user.type(screen.getByRole("textbox", { name: "题干" }), " my draft");
  await user.click(screen.getByRole("button", { name: "保存修订" }));
  expect(await screen.findByText("其他窗口已保存修订")).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "题干" }) as HTMLTextAreaElement).value).toContain("my draft");
  expect(screen.getByRole("button", { name: "返回题目列表" }).hasAttribute("disabled")).toBe(true);
  await user.click(screen.getByRole("button", { name: "重新读取已保存修订" }));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("textbox", { name: "题干" }) as HTMLTextAreaElement).value).toContain("my draft");
  await user.click(screen.getByRole("button", { name: "放弃本次修改" }));
  expect(screen.getAllByText("Other writer", { selector: ".document-content p" }).length).toBeGreaterThan(0);
});

it("renders source markup as text and provides issue navigation without model calls", async () => {
  vi.spyOn(Client.prototype, "evidence").mockResolvedValue({ text: async () => '<script>window.injected=true</script>' } as Blob);
  const { container } = render(<ResultReview task={detail} preview={metadata} client={new Client()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "问题分类" }));
  await user.click(screen.getByRole("option", { name: "题型信息缺失" }));
  expect(screen.getByText("显示 1 / 1 条记录")).toBeTruthy();
  await open();
  expect(await screen.findByText('<script>window.injected=true</script>')).toBeTruthy();
  expect(container.querySelector("script")).toBeNull();
});

it("keeps nulls and captures option changes and multiple-choice answers", async () => {
  const q = { ...original, contentBlocks: [{ partType: "text" as const, textValue: "Supplementary stem" }], answerMode: "choice" as const, choiceVariant: "single" as const, options: [{ label: "A", content: "Old option" }, { label: "B", content: "Other option" }] };
  const d = { ...detail, result: { ...detail.result, questions: [q] } };
  const save = vi.spyOn(Client.prototype, "saveCorrection").mockImplementation(async (_id, value) => ({ checkpointId: value.checkpointId, edits: [{ requestId: value.requestId, questionIndex: 0, question: value.question, savedAt: "2026-11-06T00:00:00Z" }] }));
  vi.spyOn(Client.prototype, "evidence").mockResolvedValue({ text: async () => "Original question" } as Blob);
  render(<ResultReview task={d} preview={metadata} client={new Client()} />);
  const user = await open();
  await user.click(screen.getByRole("button", { name: "人工校对" }));
  await user.clear(screen.getByRole("textbox", { name: "选项 1 内容" }));
  await user.type(screen.getByRole("textbox", { name: "选项 1 内容" }), "Revised option");
  await user.type(screen.getByRole("textbox", { name: "内容块 1 · 文本" }), " corrected");
  await user.type(screen.getByRole("textbox", { name: "参考答案" }), "B");
  await user.click(screen.getByRole("button", { name: "保存修订" }));
  await screen.findByText(/修订已保存/);
  expect(save.mock.calls[0][1].question.options[0].content).toBe("Revised option");
  expect(save.mock.calls[0][1].question.answerPayload).toEqual({ correct: ["B"] });
  expect(save.mock.calls[0][1].question.contentBlocks[0].textValue).toBe("Supplementary stem corrected");
  expect(save.mock.calls[0][1].question.sourceText).toBe(original.sourceText);
});

it("confirms a lost save response by its retained request ID without resubmitting", async () => {
  vi.spyOn(Client.prototype, "evidence").mockResolvedValue({ text: async () => "Original question" } as Blob);
  let accepted: DocumentCorrections | null = null;
  const save = vi.spyOn(Client.prototype, "saveCorrection").mockImplementation(async (_id, value) => {
    accepted = { checkpointId: value.checkpointId, edits: [{ requestId: value.requestId, questionIndex: 0, question: value.question, savedAt: "2026-11-06T00:00:00Z" }] };
    throw new ApiError("连接中断", "NETWORK_ERROR");
  });
  vi.spyOn(Client.prototype, "corrections").mockImplementation(async () => accepted!);
  render(<ResultReview task={detail} preview={metadata} client={new Client()} />);
  const user = await open();
  await user.click(screen.getByRole("button", { name: "人工校对" }));
  await user.type(screen.getByRole("textbox", { name: "题干" }), " retained");
  await user.click(screen.getByRole("button", { name: "保存修订" }));
  expect(await screen.findByText(/保存请求 ID：/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "重新读取已保存修订" }));
  expect(await screen.findByText(/上次保存已确认/)).toBeTruthy();
  expect(save).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("textbox", { name: "题干" })).toBeNull();
});

it("shows matching reference indices within each side and saves explicit pairs", async () => {
  const q = { ...original, answerMode: "matching" as const, matchingVariant: "one_to_one" as const, items: [{ side: "left" as const, content: "Left item" }, { side: "right" as const, content: "Right item" }] };
  const save = vi.spyOn(Client.prototype, "saveCorrection").mockImplementation(async (_id, value) => ({ checkpointId: value.checkpointId, edits: [{ requestId: value.requestId, questionIndex: 0, question: value.question, savedAt: "2026-11-06T00:00:00Z" }] }));
  vi.spyOn(Client.prototype, "evidence").mockResolvedValue({ text: async () => "Original question" } as Blob);
  render(<ResultReview task={{ ...detail, result: { ...detail.result, questions: [q] } }} preview={metadata} client={new Client()} />);
  const user = await open();
  await user.click(screen.getByRole("button", { name: "人工校对" }));
  expect(screen.getByText("题项编号：左侧 0 Left item；右侧 0 Right item")).toBeTruthy();
  await user.type(screen.getByRole("textbox", { name: "参考答案" }), "0=0");
  await user.click(screen.getByRole("button", { name: "保存修订" }));
  await screen.findByText(/修订已保存/);
  expect(save.mock.calls[0][1].question.answerPayload).toEqual({ matches: [{ left: 0, right: 0 }] });
});

it("locks every editable field during a delayed save and unlocks a definite rejection", async () => {
  vi.spyOn(Client.prototype, "evidence").mockResolvedValue({ text: async () => "Original question" } as Blob);
  let reject!: (error: Error) => void;
  const save = vi.spyOn(Client.prototype, "saveCorrection").mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  render(<ResultReview task={detail} preview={metadata} client={new Client()} />);
  const user = await open();
  await user.click(screen.getByRole("button", { name: "人工校对" }));
  const stem = screen.getByRole("textbox", { name: "题干" }) as HTMLTextAreaElement;
  await user.type(stem, " submitted");
  await user.click(screen.getByRole("button", { name: "保存修订" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  for (const control of screen.getByRole("form", { name: "人工校对题目" }).querySelectorAll("input,textarea,select,button")) {
    expect(control.matches(":disabled")).toBe(true);
  }
  await user.type(stem, " should not be lost");
  expect(stem.value).toBe("Original question submitted");
  await act(async () => reject(new ApiError("修改无效", "CORRECTION_INVALID", 422)));
  expect(await screen.findByText("修改无效")).toBeTruthy();
  expect(stem.matches(":disabled")).toBe(false);
  await user.type(stem, " corrected");
  expect(stem.value).toBe("Original question submitted corrected");
});

it("keeps an unconfirmed request and its submitted draft locked until explicit recovery", async () => {
  vi.spyOn(Client.prototype, "evidence").mockResolvedValue({ text: async () => "Original question" } as Blob);
  const save = vi.spyOn(Client.prototype, "saveCorrection").mockRejectedValue(new ApiError("lost", "NETWORK_ERROR"));
  render(<ResultReview task={detail} preview={metadata} client={new Client()} />);
  const user = await open();
  await user.click(screen.getByRole("button", { name: "人工校对" }));
  await user.click(screen.getByRole("button", { name: "保存修订" }));
  const id = save.mock.calls[0][1].requestId;
  expect(await screen.findByText(new RegExp(id))).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "题干" }).matches(":disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "放弃本次修改" })).toHaveProperty("disabled", true);
  await user.click(screen.getByRole("button", { name: "保存修订" }));
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[1][1].requestId).toBe(id);
});
