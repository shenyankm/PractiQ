// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Blocks, Markdown } from "./Content";
import { Practice } from "./Practice";
import { api, type Question, type Session } from "./api";
import fixture from "../fixtures/sample.json";
const { parse, buttons } = vi.hoisted(() => ({parse:vi.fn(),buttons:vi.fn()}));
vi.mock("react-markdown", () => ({default:({children}:{children:string}) => {parse(children);return <span>{children}</span>;}}));
vi.mock("@/components/ui/button", () => ({Button:({children, variant, size, ...props}: React.ComponentProps<"button"> & {variant?:string;size?:string}) => {buttons();return <button {...props}>{children}</button>;}}));
vi.mock("./api", async () => ({...(await vi.importActual<typeof import("./api")>("./api")),api:vi.fn()}));
afterEach(() => {cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.clearAllMocks();});

it("does not reparse unchanged formulas across 100 parent updates, but renders new content", () => {
  const view=render(<div><Markdown>{"$x^2$"}</Markdown><span>0</span></div>);
  for(let tick=1;tick<=100;tick++) view.rerender(<div><Markdown>{"$x^2$"}</Markdown><span>{tick}</span></div>);
  expect(parse).toHaveBeenCalledTimes(1);
  view.rerender(<div><Markdown>{"$y^2$"}</Markdown><span>100</span></div>);
  expect(parse).toHaveBeenLastCalledWith("$y^2$");
  expect(parse).toHaveBeenCalledTimes(2);
});

it("updates the practice clock without rerendering 1000 answer buttons and still autosaves", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.mocked(api).mockResolvedValue(null);
  const snapshot = {question:fixture.questions[4] as Question,groups:[],visuals:[],sources:[],warnings:[],missingAssets:false};
  const session: Session = {id:"clock",title:"clock",createdAt:0,finishedAt:null,position:0,mode:"ordered",attempts:Array.from({length:1000},(_,ordinal)=>({ordinal,snapshot,answer:null,autoResult:null,result:null,gradeKind:"ungraded",submittedAt:null,skipped:false,elapsedMs:0}))};
  render(<Practice session={session} onSession={()=>{}} run={job=>{void job();}} flushRef={{current:async()=>{}}}/>);
  const formats = vi.spyOn(Intl, "NumberFormat");
  buttons.mockClear(); parse.mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(buttons).not.toHaveBeenCalled();
  expect(parse).not.toHaveBeenCalled();
  expect(formats).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"save_draft",elapsed_ms:3000}));
  expect(buttons.mock.calls.length).toBeLessThan(20);
});


it("keeps first-occurrence blank numbering when references repeat", () => {
  render(<Blocks blocks={[{partType:"blank",questionId:"a"},{partType:"text",textValue:"between"},{partType:"blank",questionId:"a"},{partType:"blank",questionId:"b"}]} />);
  expect(screen.getAllByRole("button").map(button=>button.textContent)).toEqual(["空位 1","空位 1","空位 3"]);
});
