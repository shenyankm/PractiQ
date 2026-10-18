// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { api, blankQuestion, type Attempt, type Session } from "./api";
import { Practice } from "./Practice";

vi.mock("./api", async () => ({ ...await vi.importActual("./api"), api: vi.fn() }));
// JSDOM has no layout; browser tests verify the popover's size and position.
beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

function session(attempts: Partial<Attempt>[], exam = false): Session {
  const question = { ...blankQuestion(), stem: "Explain", answerMode: "short_answer" as const, options: [], answerPayload: { text: "Reference" } };
  return { id: "markers", kind: exam ? "self_test" : "practice", title: "Markers", createdAt: 1, position: 0, mode: "ordered", finishedAt: null, submittedAt: null,
    attempts: attempts.map((attempt, ordinal) => ({ ordinal, snapshot: { question, groups: [], visuals: [], sources: [], warnings: [], missingAssets: false },
      answer: null, submittedAt: null, skipped: false, result: null, autoResult: null, gradeKind: "ungraded", elapsedMs: 0, ...attempt,
    })),
  };
}

it.each([
  { attempt: {}, label: "未作答", status: "unanswered", marker: "circle", legend: "未作答" },
  { attempt: { answer: { text: "  " } }, label: "未作答", status: "unanswered", marker: "circle", legend: "未作答" },
  { attempt: { answer: { text: "Draft" } }, label: "已作答，未提交", status: "answered", marker: "pencil", legend: "已作答" },
  { attempt: { answer: { text: "Submitted" }, submittedAt: 1 }, label: "已提交，待判定", status: "pending", marker: "circle-dashed", legend: "待判定" },
  { attempt: { submittedAt: 1, result: true }, label: "正确", status: "correct", marker: "check", legend: "正确" },
  { attempt: { submittedAt: 1, result: false }, label: "错误", status: "incorrect", marker: "x", legend: "错误" },
  { attempt: { submittedAt: 1, result: false, earnedCents: 100, maxCents: 200 }, exam: true, label: "部分得分", status: "partial", marker: "circle-dot", legend: "部分得分" },
  { attempt: { submittedAt: 1, result: false, earnedCents: 0, maxCents: 200 }, exam: true, label: "未得满分", status: "incorrect", marker: "x", legend: "未得满分" },
  { attempt: { skipped: true, submittedAt: 1, result: false }, label: "已跳过", status: "skipped", marker: "skip-forward", legend: "跳过" },
])("shows the legend's $marker for $label without changing the accessible name", async ({ attempt, exam, label, status, marker, legend }) => {
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
  expect(button.getAttribute("data-answer-state")).toBe(status);
  await userEvent.click(screen.getByRole("button", { name: "答题卡状态说明" }));
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
  expect(screen.getByRole("button", { name: "转到第 1 题，草稿未完成" }).getAttribute("data-answer-state")).toBe("draft");
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
  expect(flagged.querySelector("svg.lucide-flag")).not.toBeNull();
  expect(flagged.getAttribute("data-answer-state")).toBe("answered");
  flagged.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "第 2 / 2 题" })));
  expect(flagged.getAttribute("aria-current")).toBe("step");
  expect(flagged.getAttribute("data-answer-state")).toBe("answered");
  expect(flagged.querySelector("svg.lucide-flag")).not.toBeNull();
  expect(flagged.querySelector("svg.lucide-pencil")).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "定位当前题" }));
  expect(document.activeElement).toBe(flagged);
});

it("keeps the legend collapsed and restores focus after closing the popover", async () => {
  const user = userEvent.setup();
  render(<Practice session={session([{}])} onSession={vi.fn()} run={job => { void job(); }} flushRef={{ current: async () => {} }} />);
  const trigger = screen.getByRole("button", { name: "答题卡状态说明" });
  expect(screen.queryByRole("dialog", { name: "答题卡状态说明" })).toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  trigger.focus();
  await user.keyboard("{Enter}");
  const help = screen.getByRole("dialog", { name: "答题卡状态说明" });
  expect(within(help).getByText("待检查")).toBeTruthy();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(screen.queryByRole("dialog", { name: "答题卡状态说明" })).toBeNull();
  await user.click(trigger);
  await user.click(within(screen.getByRole("dialog", { name: "答题卡状态说明" })).getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(api).not.toHaveBeenCalled();
});
