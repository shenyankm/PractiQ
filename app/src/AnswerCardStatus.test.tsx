// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { api, blankQuestion, type Attempt, type Session } from "./api";
import { Practice } from "./Practice";

vi.mock("./api", async () => ({ ...await vi.importActual("./api"), api: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function session(attempts: Partial<Attempt>[], exam = false): Session {
  const question = { ...blankQuestion(), stem: "Explain", answerMode: "short_answer" as const, options: [], answerPayload: { text: "Reference" } };
  return { id: "markers", kind: exam ? "self_test" : "practice", title: "Markers", createdAt: 1, position: 0, mode: "ordered", finishedAt: null, submittedAt: null,
    attempts: attempts.map((attempt, ordinal) => ({ ordinal, snapshot: { question, groups: [], visuals: [], sources: [], warnings: [], missingAssets: false },
      answer: null, submittedAt: null, skipped: false, result: null, autoResult: null, gradeKind: "ungraded", elapsedMs: 0, ...attempt,
    })),
  };
}

it.each([
  { attempt: {}, label: "未作答", marker: "circle", legend: "未作答" },
  { attempt: { answer: { text: "  " } }, label: "未作答", marker: "circle", legend: "未作答" },
  { attempt: { answer: { text: "Draft" } }, label: "已作答，未提交", marker: "pencil", legend: "草稿" },
  { attempt: { answer: { text: "Submitted" }, submittedAt: 1 }, label: "已提交，待判定", marker: "check", legend: "已提交" },
  { attempt: { submittedAt: 1, result: true }, label: "正确", marker: "check", legend: "已提交" },
  { attempt: { submittedAt: 1, result: false }, label: "错误", marker: "x", legend: "错误" },
  { attempt: { submittedAt: 1, result: false, earnedCents: 100, maxCents: 200 }, exam: true, label: "部分得分", marker: "x", legend: "未得满分" },
  { attempt: { submittedAt: 1, result: false, earnedCents: 0, maxCents: 200 }, exam: true, label: "未得满分", marker: "x", legend: "未得满分" },
  { attempt: { skipped: true, submittedAt: 1, result: false }, label: "已跳过", marker: "skip-forward", legend: "跳过" },
])("shows the legend's $marker for $label without changing the accessible name", ({ attempt, exam, label, marker, legend }) => {
  render(<Practice session={session([attempt], exam)} onSession={vi.fn()} run={job => { void job(); }} flushRef={{ current: async () => {} }} />);
  const card = within(screen.getByRole("region", { name: "答题卡" }));
  const button = card.getByRole("button", { name: `转到第 1 题，${label}` });
  // Decorative graphics have no accessible role; inspect their rendered shape.
  const icon = button.querySelector(`svg.lucide-${marker}`);
  expect(icon).not.toBeNull();
  expect(icon?.getAttribute("aria-hidden")).toBe("true");
  expect(button.textContent).toBe("1");
  expect(button.getAttribute("title")).toBe(label);
  expect(button.getAttribute("aria-current")).toBe("step");
  expect(button.classList.contains("underline")).toBe(true);
  expect(screen.getByText(legend, { selector: "p > span" }).querySelector(`svg.lucide-${marker}`)).not.toBeNull();
});

it("marks incomplete fill drafts and exact-text mismatches", () => {
  const initial = session([{}, {}]);
  const snapshot = { ...initial.attempts[0].snapshot, question: { ...initial.attempts[0].snapshot.question, answerMode: "fill_blank" as const, blankCount: 2 } };
  initial.attempts = [
    { ...initial.attempts[0], snapshot, answer: { answers: ["first", ""] } },
    { ...initial.attempts[1], snapshot, answer: { answers: ["first", "second"] }, submittedAt: 1, result: false, gradeKind: "auto" },
  ];
  render(<Practice session={initial} onSession={vi.fn()} run={job => { void job(); }} flushRef={{ current: async () => {} }} />);
  expect(screen.getByRole("button", { name: "转到第 1 题，草稿未完成" }).querySelector("svg.lucide-pencil")).not.toBeNull();
  expect(screen.getByRole("button", { name: "转到第 2 题，文本不完全一致" }).querySelector("svg.lucide-x")).not.toBeNull();
});

it("updates the current draft marker and preserves flagged keyboard navigation", async () => {
  const user = userEvent.setup();
  const initial = session([{}, { answer: { text: "Draft" }, flagged: true }]);
  vi.mocked(api).mockImplementation(async request => request.type === "position" ? { ...initial, position: request.position } as never : null as never);
  function Study() {
    const [value, setValue] = useState(initial);
    return <Practice session={value} onSession={setValue} run={job => { void job(); }} flushRef={{ current: async () => {} }} />;
  }
  render(<Study/>);
  await user.type(screen.getByRole("textbox", { name: "作答内容" }), "Draft");
  expect(screen.getByRole("button", { name: "转到第 1 题，已作答，未提交" }).querySelector("svg.lucide-pencil")).not.toBeNull();
  await user.clear(screen.getByRole("textbox", { name: "作答内容" }));
  expect(screen.getByRole("button", { name: "转到第 1 题，未作答" }).querySelector("svg.lucide-circle")).not.toBeNull();
  const flagged = screen.getByRole("button", { name: "转到第 2 题，已作答，未提交，待检查" });
  expect(flagged.classList.contains("ring-2")).toBe(true);
  flagged.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "第 2 / 2 题" })));
  expect(flagged.getAttribute("aria-current")).toBe("step");
  expect(flagged.querySelector("svg.lucide-pencil")).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "定位当前题" }));
  expect(document.activeElement).toBe(flagged);
});
