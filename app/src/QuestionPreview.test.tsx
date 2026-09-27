// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuestionPreview } from "./QuestionPreview";
import { blankQuestion } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(cleanup);

it("filters review issues, preserves material context and focuses the next issue across pages", async () => {
  const questions = Array.from({ length: 43 }, (_, index) => ({ ...blankQuestion(), id: `q${index}`, stem: `Question ${index}`, needsReview: index === 1 || index === 41 }));
  questions[1].parentId = "q0";
  render(<QuestionPreview questions={questions} reviewMode questionSources={[{ questionId: "q41", stage: "vision_parse", unitIndex: 7 }]} qualityIssues={[{ questionId: "q41", code: "SOURCE_TEXT_NOT_FOUND" }]} renderSource={() => <button>Open source</button>}/>);
  expect(screen.getByText("Question 0")).toBeTruthy();
  expect(screen.getByText("Question 1")).toBeTruthy();
  expect(screen.queryByText("Question 2")).toBeNull();
  expect(screen.getByText("来源：第 8 页")).toBeTruthy();
  expect(screen.getByText("未能在来源中定位原文，请核对题目与原文。")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open source" })).toBeTruthy();
  await userEvent.click(screen.getByRole("checkbox", { name: "仅看待复核" }));
  expect(screen.getByText("Question 2")).toBeTruthy();
  expect(screen.queryByText("Question 41")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "下一个待复核问题" }));
  expect(document.activeElement).toBe(screen.getByRole("article", { name: "预览题目 2" }));
  await userEvent.click(screen.getByRole("button", { name: "下一个待复核问题" }));
  expect(document.activeElement).toBe(screen.getByRole("article", { name: "预览题目 42" }));
  expect(screen.queryByText("Question 2")).toBeNull();
});
