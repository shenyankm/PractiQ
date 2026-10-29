import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { StrictMode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import ResultReview from "./ResultReview";
import { Client } from "./api";
import type { DocumentTaskReview } from "./contracts.generated";
import { preview, question, task } from "./test-fixtures";

function fixture(count: number) {
  const questions = Array.from({ length: count }, (_, index) => question({
    id: `quality-question-${index}`, parentId: null, optionSourceId: null,
    stem: `Prompt ${index}`, answerMode: "short_answer", questionTypeId: "short_answer", choiceVariant: null,
  }));
  const quality = { reviewRequired: true, reviewQuestionCount: count,
    issues: questions.flatMap(q => (["MISSING_FIELDS", "NEEDS_REVIEW"] as const).map(code => ({ questionId: q.id!, code }))),
  } satisfies DocumentTaskReview["quality"];
  const sources = questions.map(q => ({ questionId: q.id!, stage: "document_parse" as const, unitIndex: 0 }));
  return {
    quality,
    task: { ...task, result: { ...task.result!, questions, groups: [], visualElements: [] },
      processing: { ...task.processing!, quality, questionSources: sources } },
    preview: { ...preview, quality, questionSources: sources,
      units: [{ ...preview.units[0], questions, groups: [], visualElements: [] }] },
  };
}

it.each(["preview", "task"] as const)("defers %s quality JSON until expanded and reuses it while paging", async source => {
  const data = fixture(61), client = new Client("fake"), user = userEvent.setup();
  const nativeStringify = JSON.stringify, expected = nativeStringify(data.quality, null, 2);
  const input = nativeStringify(data), stringify = vi.spyOn(JSON, "stringify");
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const view = (quality: DocumentTaskReview["quality"]) => <StrictMode><ResultReview
    task={source === "task" ? { ...data.task, processing: { ...data.task.processing, quality } } : data.task}
    preview={source === "preview" ? { ...data.preview, quality } : null} client={client} /></StrictMode>;
  const qualityCalls = (quality: unknown) => stringify.mock.calls.filter(([value]) => value === quality).length;
  const rendered = render(view(data.quality));
  expect(qualityCalls(data.quality)).toBe(0);
  await user.click(screen.getByRole("button", { name: "来源与资源" }));
  expect(qualityCalls(data.quality)).toBe(0);
  expect(screen.queryByText(expected, { normalizer: text => text })).toBeNull();
  await user.click(screen.getByText("质量记录", { selector: "summary" }));
  expect(screen.getByText(expected, { normalizer: text => text })).toBeTruthy();
  const openedCalls = qualityCalls(data.quality);
  expect(openedCalls).toBeGreaterThan(0);
  await user.click(screen.getByRole("button", { name: "下一页资源" }));
  await user.click(screen.getByRole("button", { name: "下一页资源" }));
  await user.click(screen.getByRole("button", { name: "上一页资源" }));
  expect(qualityCalls(data.quality)).toBe(openedCalls);
  expect(screen.getByText(expected, { normalizer: text => text })).toBeTruthy();
  const changed = { ...data.quality, issues: data.quality.issues.map((issue, index) => index ? issue : { ...issue, code: "SOURCE_TEXT_NOT_FOUND" as const }) };
  rendered.rerender(view(changed));
  expect(screen.getByText(nativeStringify(changed, null, 2), { normalizer: text => text })).toBeTruthy();
  expect(qualityCalls(changed)).toBeGreaterThan(0);
  await user.click(screen.getByText("质量记录", { selector: "summary" }));
  const collapsed = { ...changed, issues: data.quality.issues };
  rendered.rerender(view(collapsed));
  expect(qualityCalls(collapsed)).toBe(0);
  expect(screen.queryByText(expected, { normalizer: text => text })).toBeNull();
  await user.click(screen.getByText("质量记录", { selector: "summary" }));
  expect(qualityCalls(collapsed)).toBeGreaterThan(0);
  await user.click(screen.getByRole("button", { name: "题目与材料" }));
  const hidden = { ...changed, issues: data.quality.issues };
  rendered.rerender(view(hidden));
  expect(qualityCalls(hidden)).toBe(0);
  await user.click(screen.getByRole("button", { name: "来源与资源" }));
  expect(screen.getByText(expected, { normalizer: text => text })).toBeTruthy();
  expect(qualityCalls(hidden)).toBeGreaterThan(0);
  expect(nativeStringify(data)).toBe(input);
  expect(fetcher).not.toHaveBeenCalled();
});

it.skipIf(!process.env.PRACTIQ_BENCH_OUTPUT)("quality serialization probe", async () => {
  const nativeStringify = JSON.stringify, client = new Client("fake"), workloads = [];
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  let target: unknown, calls = 0, milliseconds = 0;
  const stringify = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
    if (args[0] !== target) return Reflect.apply(nativeStringify, JSON, args);
    const start = performance.now();
    const result = Reflect.apply(nativeStringify, JSON, args);
    milliseconds += performance.now() - start; calls++;
    return result;
  });
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  for (const [count, tab] of [[20, "sources"], [1000, "sources"], [1000, "questions"]] as const) {
    const samples = [];
    let outputHash: string | undefined, fixtureHash: string | undefined;
    for (let iteration = 0; iteration < 8; iteration++) {
      const data = fixture(count), inputHash = hash(nativeStringify(data));
      expect(fixtureHash === undefined || fixtureHash === inputHash).toBe(true); fixtureHash = inputHash;
      const expected = nativeStringify(data.quality, null, 2), user = userEvent.setup();
      target = data.quality; calls = milliseconds = 0; stringify.mockClear();
      const rendered = render(<ResultReview task={data.task} preview={data.preview} client={client} />);
      if (tab === "sources") {
        await user.click(screen.getByRole("button", { name: "来源与资源" }));
        await user.click(screen.getByText("质量记录", { selector: "summary" }));
      }
      const pages = Math.min(10, Math.ceil(count / 20) - 1);
      for (let page = 0; page < pages; page++) await user.click(screen.getByRole("button", { name: tab === "sources" ? "下一页资源" : "下一页题目" }));
      if (tab === "sources") expect(screen.getByText(expected, { normalizer: text => text })).toBeTruthy();
      else expect(calls).toBe(0);
      const actual = hash(rendered.container.textContent || "");
      expect(outputHash === undefined || outputHash === actual).toBe(true); outputHash = actual;
      expect(hash(nativeStringify(data))).toBe(inputHash);
      if (iteration) samples.push({ calls, stringifyMs: milliseconds });
      rendered.unmount();
    }
    workloads.push({ questions: count, issues: count * 2, tab, pageUpdates: Math.min(10, Math.ceil(count / 20) - 1), inputSha256: fixtureHash, outputSha256: outputHash, samples });
  }
  expect(fetcher).not.toHaveBeenCalled();
  writeFileSync(process.env.PRACTIQ_BENCH_OUTPUT!, nativeStringify({ node: process.version, workloads }, null, 2));
}, 30000);
