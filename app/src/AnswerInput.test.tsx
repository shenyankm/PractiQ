// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnswerDisplay, AnswerInput, AnswerReview } from "./AnswerInput";
import { blankQuestion, type Answer, type Question } from "./api";

HTMLElement.prototype.scrollIntoView = () => {};
afterEach(cleanup);

it.each(["ordering", "matching"] as const)("normalizes %s items once per side while displaying an answer", mode => {
  const items = Array.from({length:100}, (_, i) => ({id: mode === "matching" ? i % 50 : i, side: mode === "matching" ? (i < 50 ? "left" as const : "right" as const) : null, content:`Item ${i}`}));
  const question = {...blankQuestion(), answerMode:mode, items};
  const reads = vi.fn(() => items);
  Object.defineProperty(question, "items", {get:reads});
  const answer = mode === "ordering" ? {order:items.map(item => item.id)} : {matches:Array.from({length:50}, (_, i) => ({left:i,right:i}))};
  const {container} = render(<AnswerDisplay question={question} answer={answer}/>);
  expect(container.textContent).toContain("Item 0");
  expect(container.textContent).toContain("Item 99");
  expect(reads).toHaveBeenCalledTimes(mode === "ordering" ? 1 : 2);
});

it("reviews selected choices as readable content and retains a false answer", () => {
  const question = {...blankQuestion(), options:[{label:"A",content:"Alpha"},{label:"B",content:"Beta"}]};
  const view = render(<AnswerReview question={question} answer={{correct:["B"]}}/>);
  expect(screen.getByText("Alpha")).toBeTruthy();
  expect(screen.getByText("Beta")).toBeTruthy();
  expect(screen.getAllByText("已选")).toHaveLength(1);
  expect(screen.queryByRole("radio")).toBeNull();
  view.rerender(<AnswerReview question={{...question,answerMode:"true_false"}} answer={{value:false}}/>);
  expect(screen.getByText("错误")).toBeTruthy();
  expect(screen.queryByText("本次未作答")).toBeNull();
});

function Controlled({ question }: { question: Question }) {
  const [value, setValue] = useState<Answer | null>(null);
  return <AnswerInput question={question} value={value} onChange={setValue} />;
}

it.each(["single", "multiple"] as const)("preserves %s choice updates, disabled state and label isolation", async variant => {
  const user = userEvent.setup();
  const question: Question = {...blankQuestion(), choiceVariant:variant, options:[
    {label:"A",content:"Alpha"}, {label:"B",content:"Beta"}, {label:"C",content:"Gamma"},
  ]};
  const changed = vi.fn();
  const props = {question, value:{correct:["A"]}, onChange:changed, usedOptions:["A","C"]};
  const {rerender} = render(<>
    <section aria-label="First"><AnswerInput {...props} prefix="first"/></section>
    <section aria-label="Second"><AnswerInput {...props} prefix="second"/></section>
  </>);
  const role = variant === "multiple" ? "checkbox" : "radio";
  const first = within(screen.getByRole("region", {name:"First"}));
  const second = within(screen.getByRole("region", {name:"Second"}));
  expect((first.getByRole(role, {name:/Alpha/}) as HTMLButtonElement).disabled).toBe(false);
  expect((first.getByRole(role, {name:/Gamma/}) as HTMLButtonElement).disabled).toBe(variant === "single");
  await user.click(second.getByText("Beta"));
  expect(changed).toHaveBeenLastCalledWith({correct:variant === "multiple" ? ["A","B"] : ["B"]});
  expect((first.getByRole(role, {name:/Alpha/})).getAttribute("aria-checked")).toBe("true");
  expect((first.getByRole(role, {name:/Beta/})).getAttribute("aria-checked")).toBe("false");
  expect(document.activeElement?.id).toBe("second-1");
  if (variant === "multiple") {
    rerender(<AnswerInput {...props} value={{correct:["A","B"]}} prefix="second"/>);
    await user.click(screen.getByText("Alpha"));
    expect(changed).toHaveBeenLastCalledWith({correct:["B"]});
  }
  changed.mockClear();
  rerender(<AnswerInput {...props} prefix="disabled" disabled/>);
  await user.click(screen.getByText("Beta"));
  expect(changed).not.toHaveBeenCalled();
});

it.each(["short_answer", "writing", "fill_blank"] as const)("keeps saved %s text literal in review", mode => {
  const value = "<example>**saved**</example>\n  # literal heading";
  const question: Question = {...blankQuestion(), answerMode:mode === "fill_blank" ? "fill_blank" : "short_answer", questionKind:mode === "writing" ? "writing" : null};
  const answer = mode === "fill_blank" ? {answers:[value]} : {text:value};
  const {container} = render(<AnswerReview question={question} answer={answer}/>);
  expect(container.textContent).toContain(value);
  expect(container.querySelector("example, strong, h1")).toBeNull();
});

it("keeps the submitted fill response literal while rendering reference Markdown", () => {
  const value = "<example>**saved**</example>\nsecond line";
  const {container} = render(<AnswerDisplay question={{...blankQuestion(),answerMode:"fill_blank"}} answer={{answers:["**Reference**"]}} response={{answers:[value]}}/>);
  expect(container.textContent).toContain(value);
  expect(container.querySelector("strong")?.textContent).toBe("Reference");
});

it.each([{options:[]},{options:[{label:"A",content:"Only imported option"}]}])("retains free-text fallback responses for incomplete choices: %j", ({options}) => {
  const value="<example>**Preserved response**</example>";
  const {container}=render(<AnswerReview question={{...blankQuestion(),options}} answer={{text:value}}/>);
  expect(container.textContent).toContain(value);
  expect(container.querySelector("example, strong")).toBeNull();
});

it("labels missing slots in partial fill review without trimming saved text", () => {
  render(<AnswerReview question={{...blankQuestion(),answerMode:"fill_blank",blankCount:3}} answer={{answers:["  saved\ntext  ",""," \n "]}}/>);
  expect(screen.getAllByRole("listitem").map(item=>item.textContent)).toEqual(["  saved\ntext  ","未作答","未作答"]);
});

it("labels whitespace-only fill responses in reference comparison", () => {
  render(<AnswerDisplay question={{...blankQuestion(),answerMode:"fill_blank"}} answer={{answers:["Reference"]}} response={{answers:[" \n "]}}/>);
  expect(screen.getAllByText("未作答")).toHaveLength(2);
});

it("adds blank inputs only when the source leaves the count open", async () => {
  const user = userEvent.setup();
  const question = { ...blankQuestion(), answerMode: "fill_blank" as const, blankCount: null, choiceVariant: null, options: [] };
  render(<Controlled question={question} />);

  await user.type(screen.getByRole("textbox", { name: "第 1 空" }), "甲");
  await user.click(screen.getByRole("button", { name: "添加一空" }));
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

  expect((screen.getByRole("combobox", { name: "匹配 左一" }) as HTMLSelectElement).value).toBe("");
  expect(changed).not.toHaveBeenCalled();
  await user.selectOptions(screen.getByRole("combobox", { name: "匹配 左一" }), "1");
  expect(changed).toHaveBeenCalledWith({ matches: [{ left: 1, right: 0 }, { left: 0, right: 1 }] });
  rerender(<AnswerInput question={question} value={{ matches: [{ left: 1, right: 0 }, { left: 0, right: 1 }] }} onChange={changed} />);
  await user.selectOptions(screen.getByRole("combobox", { name: "匹配 左一" }), "0");
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
  expect(screen.getAllByRole("option", { name: "1" })).toHaveLength(2);
  expect(screen.getAllByRole("option", { name: "2" })).toHaveLength(2);
});

it("shows source answers and missing ordering or matching references clearly", () => {
  const question = { ...blankQuestion(), answerMode: "ordering" as const, choiceVariant: null, options: [], items: [{ id: 0, content: "第一项" }, { id: 1, content: "第二项" }] };
  const { rerender } = render(<AnswerDisplay answer={null} question={question} />);
  expect(screen.getByText("原文未提供标准答案，可保持未判定或自行评估。")).toBeTruthy();

  rerender(<AnswerDisplay answer={{ value: false }} question={question} />);
  expect(screen.getByText("错误")).toBeTruthy();
  rerender(<AnswerDisplay answer={{ answers: ["甲", "乙"] }} question={question} />);
  expect(screen.getAllByRole("listitem").map(item => item.textContent?.trim())).toEqual(["甲", "乙"]);
  rerender(<AnswerDisplay answer={{ order: [1, 99] }} question={question} />);
  expect(screen.getByText("第二项 → 缺少题项")).toBeTruthy();
  const matching = { ...question, answerMode: "matching" as const, items: [{ id: 0, side: "left" as const, content: "第一项" }, { id: 0, side: "right" as const, content: "目标" }] };
  rerender(<AnswerDisplay answer={{ matches: [{ left: 0, right: 99 }] }} question={matching} />);
  expect(screen.getByText("第一项 → 缺少题项")).toBeTruthy();
});
