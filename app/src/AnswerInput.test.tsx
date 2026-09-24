// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnswerDisplay, AnswerInput } from "./AnswerInput";
import { blankQuestion, type Answer, type Question } from "./api";

HTMLElement.prototype.scrollIntoView = () => {};
afterEach(cleanup);

function Controlled({ question }: { question: Question }) {
  const [value, setValue] = useState<Answer | null>(null);
  return <AnswerInput question={question} value={value} onChange={setValue} />;
}

it("adds blank inputs only when the source leaves the count open", async () => {
  const user = userEvent.setup();
  const question = { ...blankQuestion(), answerMode: "fill_blank" as const, blankCount: null, choiceVariant: null, options: [] };
  render(<Controlled question={question} />);

  await user.type(screen.getByRole("textbox", { name: "第 1 空" }), "甲");
  await user.click(screen.getByRole("button", { name: "增加一空" }));
  await user.type(screen.getByRole("textbox", { name: "第 2 空" }), "乙");
  expect((screen.getByRole("textbox", { name: "第 1 空" }) as HTMLInputElement).value).toBe("甲");
  expect((screen.getByRole("textbox", { name: "第 2 空" }) as HTMLInputElement).value).toBe("乙");
});

it("replaces a matching selection for one left item while preserving the others", async () => {
  const user = userEvent.setup();
  const question = { ...blankQuestion(), answerMode: "matching" as const, choiceVariant: null, matchingVariant: "many_to_one" as const, options: [], items: [
    { id: 0, side: "left" as const, content: "左一" }, { id: 1, side: "left" as const, content: "左二" },
    { id: 0, side: "right" as const, content: "右甲" }, { id: 1, side: "right" as const, content: "右乙" },
  ] };
  const changed = vi.fn();
  const { rerender } = render(<AnswerInput question={question} value={{ matches: [{ left: 1, right: 0 }] }} onChange={changed} />);

  screen.getByRole("combobox", { name: "匹配 左一" }).focus();
  await user.keyboard("{Enter}");
  await user.click(screen.getByRole("option", { name: "右乙" }));
  expect(changed).toHaveBeenCalledWith({ matches: [{ left: 1, right: 0 }, { left: 0, right: 1 }] });
  rerender(<AnswerInput question={question} value={{ matches: [{ left: 1, right: 0 }, { left: 0, right: 1 }] }} onChange={changed} />);
  screen.getByRole("combobox", { name: "匹配 左一" }).focus();
  await user.keyboard("{Enter}");
  await user.click(screen.getByRole("option", { name: "右甲" }));
  expect(changed).toHaveBeenLastCalledWith({ matches: [{ left: 1, right: 0 }, { left: 0, right: 0 }] });
});

it("labels unlabeled paragraph choices by position instead of ID", async () => {
  const question = { ...blankQuestion(), answerMode: "matching" as const, matchingVariant: "one_to_one" as const, questionKind: "paragraph_matching" as const, items: [
    { id: 5, side: "left" as const, content: "Find this paragraph" },
    { id: 6, side: "left" as const, content: "Find another paragraph" },
    { id: 42, side: "right" as const, content: "First paragraph" },
    { id: 88, side: "right" as const, content: "Second paragraph" },
  ] };
  render(<AnswerInput question={question} value={null} onChange={() => {}} />);
  screen.getByRole("combobox", { name: "匹配 Find this paragraph" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("option", { name: "1" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "2" })).toBeTruthy();
});

it("shows source answers and missing ordering or matching references clearly", () => {
  const question = { ...blankQuestion(), answerMode: "ordering" as const, choiceVariant: null, options: [], items: [{ id: 0, content: "第一项" }, { id: 1, content: "第二项" }] };
  const { rerender } = render(<AnswerDisplay answer={null} question={question} />);
  expect(screen.getByText("原文未提供标准答案，可保持未判定或自行评价。")).toBeTruthy();

  rerender(<AnswerDisplay answer={{ value: false }} question={question} />);
  expect(screen.getByText("错误")).toBeTruthy();
  rerender(<AnswerDisplay answer={{ answers: ["甲", "乙"] }} question={question} />);
  expect(screen.getAllByRole("listitem").map(item => item.textContent?.trim())).toEqual(["甲", "乙"]);
  rerender(<AnswerDisplay answer={{ order: [1, 99] }} question={question} />);
  expect(screen.getByText("第二项 → 题项缺失")).toBeTruthy();
  const matching = { ...question, answerMode: "matching" as const, items: [{ id: 0, side: "left" as const, content: "第一项" }, { id: 0, side: "right" as const, content: "目标" }] };
  rerender(<AnswerDisplay answer={{ matches: [{ left: 0, right: 99 }] }} question={matching} />);
  expect(screen.getByText("第一项 → 题项缺失")).toBeTruthy();
});
