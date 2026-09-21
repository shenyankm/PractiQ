// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuestionPreview } from "./QuestionPreview";
import { AnswerInput } from "./AnswerInput";
import { QuestionEditor } from "./QuestionEditor";
import type { Question } from "./api";
import fixture from "../fixtures/composite.json";
afterEach(cleanup);
const questions=fixture.questions as Question[];
it("previews complete nested groups with their shared option pool",()=>{
  render(<QuestionPreview questions={questions} groups={fixture.groups}/>);
  expect(screen.getByText("Shared article: seasons change.")).toBeTruthy();
  expect(screen.getAllByText("spring").length).toBeGreaterThan(2);
  expect(screen.getByText("words-root passage")).toBeTruthy();
  expect(screen.getByText("cloze-root passage")).toBeTruthy();
});
it("uses the same array answer for keyboard-operated word-bank children",async()=>{
  const child=questions.find(q=>q.id==="words1")!;
  const parent=questions.find(q=>q.id==="words")!;
  const change=vi.fn();
  render(<AnswerInput question={{...child,options:parent.options}} value={null} onChange={change}/>);
  const radio=screen.getAllByRole("radio")[0];radio.focus();
  await userEvent.keyboard(" ");
  expect(change).toHaveBeenCalledWith({correct:["A"]});
});
it("saves an existing composite tree without losing blank IDs or child order",async()=>{
  const parent=questions.find(q=>q.id==="words")!;
  const children=questions.filter(q=>q.parentId===parent.id);
  const save=vi.fn();
  render(<QuestionEditor initial={parent} initialChildren={children} busy={false} onClose={()=>{}} onSave={save}/>);
  await userEvent.click(screen.getByRole("checkbox",{name:"允许重复选词"}));
  await userEvent.click(screen.getByRole("button",{name:"保存题目"}));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({allowReuse:true,passage:parent.passage}),children);
});
it("keeps fragment review options separate before final IDs exist",()=>{
  const first={...questions[1],id:undefined,parentId:undefined,optionSourceId:undefined};
  const second={...first,stem:"Other question",options:[{label:"X",content:"Unique X"},{label:"Y",content:"Unique Y"}]};
  render(<QuestionPreview questions={[first,second]}/>);
  expect(screen.getByText("Unique Y")).toBeTruthy();
  expect(screen.getByText("spring")).toBeTruthy();
});
