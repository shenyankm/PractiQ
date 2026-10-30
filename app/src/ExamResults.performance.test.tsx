// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Profiler } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExamResults } from "./ExamResults";
import { blankQuestion, type Session } from "./api";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it.skipIf(!process.env.PRACTIQ_EXAM_BENCH_OUTPUT)("measures saved exam statistics while editing a reason", async () => {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex"), workloads = [];
  for (const count of [20, 1000]) {
    let reads = 0, duration = 0;
    const question = { ...blankQuestion(), answerMode: "short_answer" as const, stem: "Printed question", answerPayload: { text: "Printed answer" } };
    const answer = { text: "My answer" };
    const session: Session = { id: "synthetic-exam", title: "Synthetic", kind: "self_test", createdAt: 0,
      submittedAt: 1, finishedAt: null, position: 0, mode: "ordered",
      attempts: Array.from({ length: count }, (_, ordinal) => ({ ordinal,
        snapshot: { question, groups: [], visuals: [], sources: [], warnings: [], missingAssets: false },
        get answer() { if (ordinal) reads++; return answer; },
        autoResult: null, result: null, gradeKind: "ungraded", submittedAt: 1, skipped: false, elapsedMs: 0, maxCents: 300, earnedCents: null })) };
    const run = vi.fn(), onSession = vi.fn();
    const view = render(<Profiler id="exam" onRender={(_id, phase, actual) => { if (phase !== "mount") duration += actual; }}>
      <ExamResults session={session} onSession={onSession} run={run} />
    </Profiler>);
    const input = screen.getByRole("textbox", { name: "改分原因" }) as HTMLInputElement, samples = [];
    let expected: string | undefined;
    for (let iteration = 0; iteration < 8; iteration++) {
      reads = duration = 0;
      const text = "A printed reason";
      await act(async () => { fireEvent.change(input, { target: { value: "" } }); });
      for (let end = 1; end <= text.length; end++) await act(async () => { fireEvent.change(input, { target: { value: text.slice(0, end) } }); });
      const output = hash(JSON.stringify({ text: view.container.textContent, reason: input.value }));
      expected ??= output;
      expect(output).toBe(expected);
      expect(input.value).toBe(text);
      expect(invoke).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(onSession).not.toHaveBeenCalled();
      if (iteration) samples.push({ renderMs: duration, noncurrentAnswerReads: reads });
    }
    workloads.push({ questions: count, samples, outputSha256: expected });
    cleanup();
  }
  writeFileSync(process.env.PRACTIQ_EXAM_BENCH_OUTPUT!, JSON.stringify({ node: process.version,
    probeSha256: hash(readFileSync("src/ExamResults.performance.test.tsx", "utf8")), sourceSha256: hash(readFileSync("src/ExamResults.tsx", "utf8")),
    scope: "React development/JSDOM Profiler actual render durations for clearing and typing sixteen characters; one warmup and seven measured sequences per workload. Native/API substitutes, no browser, WebView or production input-latency measurement.", workloads }, null, 2) + "\n");
});
