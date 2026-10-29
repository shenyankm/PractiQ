// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Profiler } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Practice } from "./Practice";
import { api, blankQuestion, type Session } from "./api";
import { I18nProvider, useI18n } from "./i18n";
import { invoke } from "@tauri-apps/api/core";

vi.mock("./api", async () => ({ ...await vi.importActual<typeof import("./api")>("./api"), api: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function workload(count: number, itemReads: () => void): Session {
  const question = { ...blankQuestion(), id: "short", stem: "Explain", answerMode: "short_answer" as const, choiceVariant: null, options: [] };
  const items = Array.from({ length: 100 }, (_, id) => ({ id, content: `Item ${id}`, side: id < 50 ? "left" as const : "right" as const }));
  const matching = { ...question, id: "matching", answerMode: "matching" as const, matchingVariant: "one_to_one" as const, get items() { itemReads(); return items; } };
  return { id: "drafts", title: "Drafts", createdAt: 0, finishedAt: null, position: 0, mode: "ordered", attempts: Array.from({ length: count }, (_, ordinal) => ({
    ordinal, snapshot: { question: ordinal ? matching : question, groups: [], visuals: [], sources: [], warnings: [], missingAssets: false },
    answer: ordinal ? { matches: [{ left: 0, right: 50 }] } : null, autoResult: null, result: null, gradeKind: "ungraded", submittedAt: null, skipped: false, elapsedMs: 0,
  })) };
}

it("reuses other draft states while typing and refreshes saved answers, position and language", async () => {
  vi.mocked(api).mockResolvedValue(null);
  vi.mocked(invoke).mockResolvedValue("zh-CN");
  const reads = vi.fn();
  let session = workload(20, reads);
  let language!: ReturnType<typeof useI18n>;
  function Controls() { language = useI18n(); return null; }
  const props = { onSession: vi.fn(), run: (job: () => Promise<void>) => { void job(); }, flushRef: { current: async () => {} } };
  const view = (compact = false) => <I18nProvider><Controls/><Practice session={session} {...props} compact={compact}/></I18nProvider>;
  const rendered = render(view());
  const field = await screen.findByRole("textbox", { name: "作答内容" });
  reads.mockClear();
  fireEvent.change(field, { target: { value: "Current draft" } });
  await act(async () => {});
  expect(reads).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "转到第 1 题，已作答，未提交" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "转到第 20 题，草稿未完成" })).toBeTruthy();
  session = { ...session, attempts: session.attempts.map(a => a.ordinal === 19 ? { ...a, submittedAt: 1, result: true } : a) };
  rendered.rerender(view());
  expect(screen.getByRole("button", { name: "转到第 20 题，正确" })).toBeTruthy();
  await act(async () => { await language.change("en"); });
  expect(screen.getByRole("button", { name: "Go to question 20, Correct" })).toBeTruthy();
  await act(async () => { await language.change("zh-CN"); });
  session = { ...session, position: 19 };
  rendered.rerender(view(true));
  expect(screen.getByRole("button", { name: "转到第 20 题，正确" }).getAttribute("aria-current")).toBe("step");
  const details = document.querySelector<HTMLDetailsElement>(".practice-answer-card")!;
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByRole("link", { name: "查看答题卡" }));
  expect(details.open).toBe(true);
  expect(screen.getByRole("button", { name: "转到第 20 题，正确" })).toBeTruthy();
});

it.skipIf(!process.env.PRACTIQ_PRACTICE_BENCH)("measures typing with retained matching drafts", async () => {
  vi.mocked(api).mockResolvedValue(null);
  const workloads = [];
  for (const count of [20, 1000]) {
    let reads = 0, duration = 0;
    const session = workload(count, () => { reads++; });
    const input = JSON.stringify(session);
    const samples = [];
    const outputHashes = [];
    for (let repetition = 0; repetition < 3; repetition++) {
      render(<Profiler id="practice" onRender={(_, __, actualDuration) => { duration += actualDuration; }}><Practice session={session} onSession={vi.fn()} run={job => { void job(); }} flushRef={{ current: async () => {} }} /></Profiler>);
      const field = screen.getByRole("textbox", { name: "作答内容" }) as HTMLTextAreaElement;
      for (let edit = 0; edit < 15; edit++) {
        reads = duration = 0;
        const value = `New answer ${edit}`;
        const start = performance.now();
        fireEvent.change(field, { target: { value } });
        samples.push({ inputToCommitMs: performance.now() - start, renderMs: duration, itemReads: reads });
        await act(async () => {});
        expect(field.value).toBe(value);
      }
      expect(screen.getByRole("button", { name: new RegExp(`转到第 ${count.toLocaleString("en-US")} 题，草稿未完成`) })).toBeTruthy();
      outputHashes.push(createHash("sha256").update(document.getElementById("answer-card-panel")!.textContent!).digest("hex"));
      cleanup();
    }
    expect(JSON.stringify(session)).toBe(input);
    workloads.push({ questions: count, itemsPerMatchingQuestion: 100, inputSha256: createHash("sha256").update(input).digest("hex"), outputHashes, samples });
  }
  writeFileSync(process.env.PRACTIQ_PRACTICE_BENCH!, JSON.stringify({ scope: "Local React development build with jsdom, full Practice input event through synchronous commit; three mounts and fifteen edits each. Excludes native IPC, browser layout, and physical devices.", environment: { node: process.version, platform: process.platform, architecture: process.arch }, workloads }, null, 2));
}, 20_000);
