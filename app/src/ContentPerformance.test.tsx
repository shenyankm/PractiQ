// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Blocks, Markdown } from "./Content";
import { QuestionPreview } from "./QuestionPreview";
import { Practice } from "./Practice";
import App from "./App";
import { api, type Question, type Session } from "./api";
import { message } from "./i18n";
import { toast } from "./notifications";
import fixture from "../fixtures/sample.json";
const { parse, buttons } = vi.hoisted(() => ({parse:vi.fn(),buttons:vi.fn()}));
vi.mock("react-markdown", () => ({default:({children}:{children:string}) => {parse(children);return <span>{children}</span>;}}));
vi.mock("@/components/ui/button", async () => {
  const original=await vi.importActual<typeof import("@/components/ui/button")>("@/components/ui/button");
  return {Button:(props:React.ComponentProps<typeof original.Button>)=>{buttons(props["aria-label"]);return <original.Button {...props}/>;}};
});
vi.mock("./api", async () => ({...(await vi.importActual<typeof import("./api")>("./api")),api:vi.fn()}));
vi.mock("@tauri-apps/api/core", () => ({invoke:vi.fn(),isTauri:()=>false}));
vi.mock("./notifications", () => ({toast:{success:vi.fn(),error:vi.fn(),info:vi.fn()}}));
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

it("parses folded answers only after opening, and retains them on reopen", async () => {
  const user = userEvent.setup();
  render(<QuestionPreview questions={[{...fixture.questions[4], analysis:"Hidden formula $x^2$", sourceText:"Original source"} as Question]}/>);
  expect(parse).not.toHaveBeenCalledWith("Hidden formula $x^2$");
  expect(screen.queryByText("Original source")).toBeNull();
  await user.click(screen.getByText("答案、解析与来源"));
  expect(await screen.findByText("Original source")).toBeTruthy();
  expect(parse).toHaveBeenCalledWith("Hidden formula $x^2$");
  parse.mockClear();
  await user.click(screen.getByText("答案、解析与来源"));
  await user.click(screen.getByText("答案、解析与来源"));
  expect(parse).not.toHaveBeenCalled();
});

it("uses native exam time across wall-clock jumps and resynchronizes after sleep", async () => {
  vi.useFakeTimers();
  const wall = 1_800_000_000_000;
  vi.setSystemTime(wall);
  const snapshot = {question:fixture.questions[4] as Question,groups:[],visuals:[],sources:[],warnings:[],missingAssets:false};
  const session: Session = {id:"clock",title:"clock",kind:"mock_exam",clockNow:wall,deadlineAt:wall+60_000,createdAt:wall,finishedAt:null,submittedAt:null,position:0,mode:"ordered",attempts:[{ordinal:0,snapshot,answer:{text:"saved"},autoResult:null,result:null,gradeKind:"ungraded",submittedAt:null,skipped:false,elapsedMs:0,maxCents:100,earnedCents:null}]};
  const onSession = vi.fn();
  vi.mocked(api).mockResolvedValue({...session, clockNow:wall+3_000});
  render(<Practice session={session} onSession={onSession} run={job=>{void job();}} flushRef={{current:async()=>{}}}/>);
  vi.setSystemTime(wall - 120_000);
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(screen.getByRole("timer").textContent).toContain("0 分 59 秒");
  vi.setSystemTime(wall + 7_200_000);
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(screen.getByRole("timer").textContent).toContain("0 分 57 秒");
  expect(onSession).not.toHaveBeenCalled();
  const expired = {...session,submittedAt:wall+60_000,attempts:[{...session.attempts[0],submittedAt:wall+60_000}]};
  vi.mocked(api).mockResolvedValue(expired);
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(onSession).toHaveBeenCalledWith(expired);
});

it("keeps 1000 answer buttons mounted across navigation and supports keyboard jumps and current focus", async () => {
  const user=userEvent.setup();
  const snapshot = {question:fixture.questions[4] as Question,groups:[],visuals:[],sources:[],warnings:[],missingAssets:false};
  const session: Session = {id:"large",title:"large",createdAt:0,finishedAt:null,position:0,mode:"ordered",attempts:Array.from({length:1000},(_,ordinal)=>({ordinal,snapshot,answer:null,autoResult:null,result:null,gradeKind:"ungraded",submittedAt:null,skipped:false,elapsedMs:0}))};
  const onSession=vi.fn();
  const run=(job:()=>Promise<void>)=>{void job();};
  const flushRef={current:async()=>{}};
  vi.mocked(api).mockImplementation(async request=>request.type === "position" ? {...session,position:request.position} as never : undefined as never);
  const view=render(<Practice session={session} onSession={onSession} run={run} flushRef={flushRef}/>);
  const button=screen.getByRole("button", {name:"转到第 501 题，未作答"});
  const region=screen.getByRole("region", {name:"答题卡"});
  buttons.mockClear();
  view.rerender(<Practice session={{...session,position:1,attempts:session.attempts.map(a=>({...a}))}} onSession={onSession} run={run} flushRef={flushRef}/>);
  expect(screen.getByRole("button", {name:"转到第 501 题，未作答"})).toBe(button);
  expect(screen.getByRole("region", {name:"答题卡"})).toBe(region);
  expect(buttons.mock.calls.length).toBeLessThan(30);
  await user.click(screen.getByRole("button", {name:"定位当前题"}));
  expect(document.activeElement).toBe(screen.getByRole("button", {name:"转到第 2 题，未作答"}));
  screen.getByRole("button", {name:"转到最后一题"}).focus();
  await user.keyboard("{Enter}");
  expect(api).toHaveBeenCalledWith({type:"position",id:"large",position:999});
  expect(onSession).toHaveBeenCalledWith(expect.objectContaining({position:999}));
}, 15_000);

it("bounds the material sibling navigator without dropping later children", async () => {
  const parent={...fixture.questions[4],id:"parent",answerMode:"reading",stem:"Shared passage"} as Question;
  const session: Session = {id:"material",title:"material",createdAt:0,finishedAt:null,position:0,mode:"ordered",attempts:Array.from({length:1000},(_,ordinal)=>({ordinal,snapshot:{question:{...fixture.questions[4],id:`child-${ordinal}`,parentId:"parent"} as Question,materials:[parent],groups:[],visuals:[],sources:[],warnings:[],missingAssets:false},answer:null,autoResult:null,result:null,gradeKind:"ungraded",submittedAt:null,skipped:false,elapsedMs:0}))};
  const onSession=vi.fn();
  vi.mocked(api).mockImplementation(async request=>request.type === "position" ? {...session,position:request.position} as never : undefined as never);
  render(<Practice session={session} onSession={onSession} run={job=>{void job();}} flushRef={{current:async()=>{}}}/>);
  const navigator=within(screen.getByRole("navigation", {name:"题组子题"}));
  expect(navigator.getAllByRole("button")).toHaveLength(32);
  expect(navigator.queryByRole("button", {name:"31"})).toBeNull();
  await userEvent.click(navigator.getByRole("button", {name:"下一页"}));
  expect(api).toHaveBeenCalledWith({type:"position",id:"material",position:30});
  expect(onSession).toHaveBeenCalledWith(expect.objectContaining({position:30}));
});

it("keeps App answer-card callbacks stable through busy updates and retries navigation and completion", async () => {
  const user=userEvent.setup();
  HTMLElement.prototype.scrollIntoView=()=>{};
  const bank={id:"bank",title:"Large bank",description:"",count:100,createdAt:1};
  const snapshot={question:fixture.questions[4] as Question,groups:[],visuals:[],sources:[],warnings:[],missingAssets:false};
  let session:Session={id:"large-app",kind:"practice",title:"Large practice",createdAt:1,finishedAt:null,position:0,mode:"ordered",attempts:Array.from({length:100},(_,ordinal)=>({ordinal,snapshot,answer:null,autoResult:null,result:null,gradeKind:"ungraded",submittedAt:null,skipped:false,elapsedMs:0}))};
  const positionError=new Error("Position failed"), finishError=new Error("Finish failed");
  let failPosition=true,failFinish=true;
  vi.mocked(api).mockImplementation(async request=>{
    switch(request.type){
      case "banks":return [bank] as never;
      case "banks_page":return {items:[bank],total:1,offset:0} as never;
      case "unfinished_session":return {id:session.id,title:session.title,kind:"practice",count:100,answered:0,correct:0,graded:0,elapsedMs:0} as never;
      case "info":return {version:"test",dataDirectory:"/tmp/test"} as never;
      case "session":return session as never;
      case "save_draft":return null as never;
      case "position":
        if(failPosition){failPosition=false;throw positionError;}
        session={...session,position:request.position,attempts:session.attempts.map(a=>({...a}))};
        return session as never;
      case "submit_paper":
        if(failFinish){failFinish=false;throw finishError;}
        session={...session,finishedAt:2};
        return session as never;
      default:throw new Error(`Unexpected request: ${request.type}`);
    }
  });
  render(<App/>);
  await user.click(await screen.findByRole("button",{name:"继续练习"}));
  await screen.findByRole("heading",{name:"第 1 / 100 题"});
  const retained=screen.getByRole("button",{name:"转到第 51 题，未作答"});
  const answerRenders=()=>buttons.mock.calls.filter(([name])=>typeof name === "string" && name.startsWith("转到第 ")).length;
  buttons.mockClear();
  await user.click(screen.getByRole("button",{name:"下一题"}));
  await waitFor(()=>expect(toast.error).toHaveBeenCalledWith(positionError));
  expect(screen.getByRole("heading",{name:"第 1 / 100 题"})).toBeTruthy();
  expect(answerRenders()).toBe(0);
  buttons.mockClear();
  await user.click(screen.getByRole("button",{name:"下一题"}));
  await screen.findByRole("heading",{name:"第 2 / 100 题"});
  expect(screen.getByRole("button",{name:"转到第 51 题，未作答"})).toBe(retained);
  expect(answerRenders()).toBe(2);
  await user.click(screen.getByRole("button",{name:"结束练习"}));
  const dialog=await screen.findByRole("alertdialog",{name:"结束本次练习？"});
  await user.click(within(dialog).getByRole("button",{name:"提交草稿并结束"}));
  await waitFor(()=>expect(toast.error).toHaveBeenCalledWith(finishError));
  expect(screen.getByRole("alertdialog",{name:"结束本次练习？"})).toBeTruthy();
  expect(toast.success).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button",{name:"提交草稿并结束"}));
  await waitFor(()=>expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(toast.success).toHaveBeenCalledExactlyOnceWith(message("练习已结束，记录已保存"));
  expect((screen.getByRole("textbox",{name:"作答内容"}) as HTMLTextAreaElement).disabled).toBe(true);
  await user.click(screen.getByRole("button",{name:"上一题"}));
  await screen.findByRole("heading",{name:"第 1 / 100 题"});
  expect(toast.success).toHaveBeenCalledTimes(1);
  expect(api).toHaveBeenCalledWith({type:"submit_paper",id:"large-app",submit_drafts:true});
}, 15_000);
