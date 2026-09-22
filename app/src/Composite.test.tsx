// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuestionPreview, indexPreviewQuestions } from "./QuestionPreview";
import { AnswerInput } from "./AnswerInput";
import { QuestionEditor } from "./QuestionEditor";
import type { Question } from "./api";
import fixture from "../fixtures/composite.json";
afterEach(cleanup);
const questions=fixture.questions as Question[];
it("indexes large nested previews once and keeps orphan and unidentified roots distinct", () => {
  let reads = 0;
  const nodes = Array.from({ length: 5000 }, (_, i) => ({
    ...questions[1],
    get id() { reads++; return `q${i}`; },
    parentId: i % 5 ? `q${i - i % 5}` : null,
  }));
  const index = indexPreviewQuestions(nodes);
  expect(index.roots).toHaveLength(1000);
  expect(index.roots.slice(0, 20).flatMap(root => index.trees.get(root)!)).toHaveLength(100);
  expect(reads).toBeLessThan(5000 * 10);
  const orphan = { ...questions[1], id: "orphan", parentId: "missing" };
  const anonymous = { ...questions[1], id: undefined, parentId: undefined };
  const cycle = [{ ...orphan, id: "a", parentId: "b" }, { ...orphan, id: "b", parentId: "a" }];
  const fragments = indexPreviewQuestions([orphan, anonymous, ...cycle]);
  expect(fragments.roots).toEqual([orphan, anonymous]);
  expect(fragments.trees.get(anonymous)?.[0].index).toBe(1);
});
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
  const clone = vi.spyOn(globalThis, "structuredClone");
  render(<QuestionEditor initial={parent} initialChildren={children} busy={false} onClose={()=>{}} onSave={save}/>);
  const initialClones = clone.mock.calls.length;
  await userEvent.click(screen.getByRole("checkbox",{name:"允许重复选词"}));
  await userEvent.type(screen.getByLabelText("题干（支持 Markdown 和公式）"), " updated");
  expect(clone).toHaveBeenCalledTimes(initialClones);
  clone.mockRestore();
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
it("clears stale reference answers when the blank count changes",async()=>{
  const save=vi.fn();
  render(<QuestionEditor initial={{...questions[1],answerMode:"fill_blank",choiceVariant:null,options:[],blankCount:2,answerPayload:{answers:["a","b"]}}} busy={false} onClose={()=>{}} onSave={save}/>);
  const count=screen.getByLabelText("空位数量");
  await userEvent.clear(count);
  await userEvent.type(count,"1");
  await userEvent.click(screen.getByRole("button",{name:"保存题目"}));
  expect(save.mock.calls[0][0].answerPayload).toBeNull();
  expect(save.mock.calls[0][0].blankCount).toBe(1);
});
