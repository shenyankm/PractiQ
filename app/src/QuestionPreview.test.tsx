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

it("bounds a 1000-node material group and carries context and shared options to the focused review page", async () => {
  const questions = Array.from({length:1000}, (_, i) => ({...blankQuestion(),id:`q${i}`,parentId:i ? "q0" : null,stem:i ? `Child ${i}` : "Shared material",needsReview:i===999,optionSourceId:i ? "q0" : null}));
  questions[0].answerMode = "word_bank";
  questions[0].options = [{label:"A",content:"Shared option"}];
  render(<QuestionPreview questions={questions} reviewMode/>);
  expect(screen.getAllByRole("article")).toHaveLength(20);
  await userEvent.click(screen.getByRole("button", {name:"下一个待复核问题"}));
  expect(screen.getAllByRole("article")).toHaveLength(21);
  expect(document.activeElement).toBe(screen.getByRole("article", {name:"预览题目 1,000"}));
  expect(screen.getByText("Shared material")).toBeTruthy();
  expect(screen.getAllByText("Shared option")).toHaveLength(21);
  expect(screen.queryByText("Child 1")).toBeNull();
});

it("indexes source and quality associations once instead of scanning them for every visible question", async () => {
  let sourceReads=0, issueReads=0;
  const questions = Array.from({length:1000}, (_, i)=>({...blankQuestion(),id:`q${i}`,stem:`Indexed ${i}`}));
  const questionSources = questions.map((q,i)=>({get questionId(){sourceReads++;return q.id;},stage:"document_parse" as const,unitIndex:i}));
  const qualityIssues = questions.map(q=>({get questionId(){issueReads++;return q.id;},code:"NEEDS_REVIEW" as const}));
  render(<QuestionPreview questions={questions} questionSources={questionSources} qualityIssues={qualityIssues} reviewMode/>);
  expect(sourceReads).toBe(1000);
  expect(issueReads).toBe(1000);
  await userEvent.click(screen.getByRole("button", {name:"后 20 题"}));
  expect(sourceReads).toBe(1000);
  expect(issueReads).toBe(1000);
  expect(screen.getByText("来源：文本片段 21")).toBeTruthy();
});
