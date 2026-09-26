// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StudySetup } from "./StudySetup";
import { api, type QuestionRow, type Session } from "./api";
import fixture from "../fixtures/sample.json";
vi.mock("./api", async () => ({ ...(await vi.importActual<typeof import("./api")>("./api")), api: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const banks = [{id:"one",title:"题库一",count:2,description:"",createdAt:0}, {id:"two",title:"题库二",count:1,description:"",createdAt:0}];
const rows = fixture.questions.slice(0,2).map((question,i) => ({id:`q${i}`,bankId:"one",bankTitle:"题库一",question,groups:[],visuals:[],sources:[],warnings:[],missingAssets:false,favorite:false,latestResult:null})) as QuestionRow[];
function setup() {
  const onStart = vi.fn(async (_s: Session) => {});
  vi.mocked(api).mockImplementation(async r => {
    if(r.type === "question_stats") return {count:rows.length,types:{single:rows.length},feasibleCounts:[1,2]} as never;
    if(r.type === "questions_page") return {items:rows,total:rows.length,offset:0} as never;
    if(r.type === "preview_paper") {
      const selected=r.request.selection === "manual" ? rows.filter(q=>r.request.question_ids.includes(q.id)) : r.request.selection === "quota" ? rows.slice(0,r.request.quotas.single || 0) : rows.slice(0,r.request.count);
      return {questionIds:selected.map(q=>q.id),digest:"preview",questions:selected,scores:selected.map(()=>r.request.total_cents/selected.length),count:selected.length} as never;
    }
    if(r.type === "start_paper" && r.paper.kind !== "practice" && r.paper.scores.reduce((a,b)=>a+b,0)!==r.paper.total_cents) throw new Error("分值之和必须等于总分");
    return {id:"session"} as never;
  });
  render(<StudySetup banks={banks} initialBank="one" initialFilter="" busy={false} run={job => { void job(); }} onStart={onStart} onClose={() => {}}/>);
  return onStart;
}
it("starts ordinary practice directly with the selected questions and no exam scores", async () => {
  const started = setup();
  const button = screen.getByRole("button",{name:"立即开始"});
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  expect(screen.queryByRole("button",{name:/预览题目/})).toBeNull();
  await userEvent.click(button);
  await waitFor(() => expect(started).toHaveBeenCalled());
  expect(api).toHaveBeenCalledWith({type:"start_paper",paper:{digest:"preview",question_ids:["q0","q1"],kind:"practice",minutes:null,scores:[],total_cents:0}});
});
it("never turns clearing the last selected bank into all banks", async () => {
  setup();
  await screen.findByText(/可用 2 题/);
  await userEvent.click(screen.getByText(/高级设置/, { selector: "summary" }));
  await userEvent.click(screen.getByRole("checkbox",{name:"题库一（2）"}));
  expect(await screen.findByText("请选择至少一个题库")).toBeTruthy();
  expect(screen.getByRole("button",{name:"立即开始"}).hasAttribute("disabled")).toBe(true);
  expect(vi.mocked(api).mock.calls.filter(([r])=>r.type === "question_stats")).toHaveLength(1);
  await userEvent.click(screen.getByRole("button",{name:"全选可用题库"}));
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({bank_ids:["one","two"]})));
});
it("requires a fresh exam preview and validates the score total", async () => {
  setup();
  await screen.findByText(/可用 2 题/);
  await userEvent.selectOptions(screen.getByLabelText("模式"), "self_test");
  expect(screen.queryByRole("button",{name:"开始考试"})).toBeNull();
  await userEvent.click(screen.getByRole("button",{name:"预览题目与配分"}));
  await userEvent.clear(screen.getByLabelText("第 1 题分值"));
  await userEvent.type(screen.getByLabelText("第 1 题分值"), "40");
  await userEvent.click(screen.getByRole("button",{name:"开始考试"}));
  expect(screen.getByRole("alert").textContent).toContain("分值之和必须等于总分");
  expect(vi.mocked(api).mock.calls.some(([r])=>r.type === "start_paper")).toBe(true);
  await userEvent.clear(screen.getByLabelText("考试总分"));
  await userEvent.type(screen.getByLabelText("考试总分"), "90");
  expect(screen.queryByRole("button",{name:"开始考试"})).toBeNull();
  await userEvent.click(screen.getByRole("button",{name:"预览题目与配分"}));
  await userEvent.click(screen.getByRole("button",{name:"开始考试"}));
  await waitFor(() => expect(api).toHaveBeenCalledWith({type:"start_paper",paper:{digest:"preview",question_ids:["q0","q1"],kind:"self_test",minutes:null,scores:[4500,4500],total_cents:9000}}));
});
it("keeps manual and per-type question selection available for practice", async () => {
  setup();
  await screen.findByText(/可用 2 题/);
  await userEvent.click(screen.getByText(/高级设置/, { selector: "summary" }));
  await userEvent.selectOptions(screen.getByLabelText("选题方式"), "quota");
  await userEvent.clear(screen.getByLabelText("单选题数"));
  await userEvent.type(screen.getByLabelText("单选题数"), "1");
  await userEvent.click(screen.getByRole("button",{name:"立即开始"}));
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"start_paper",paper:expect.objectContaining({question_ids:["q0"]})})));
  await userEvent.selectOptions(screen.getByLabelText("选题方式"), "manual");
  await userEvent.click(await screen.findByRole("checkbox",{name:rows[1].question.stem!}));
  await userEvent.click(screen.getByRole("button",{name:"立即开始"}));
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"start_paper",paper:expect.objectContaining({question_ids:["q1"]})})));
});

it("debounces statistics, pages manual choices and preserves selections across pages", async () => {
  setup();
  await screen.findByText(/可用 2 题/);
  expect(vi.mocked(api).mock.calls.some(([r]) => r.type === "questions_page")).toBe(false);
  const all = Array.from({length:31}, (_, i) => ({...rows[0],id:`q${i}`,question:{...rows[0].question,stem:`Question ${i}`}}));
  vi.mocked(api).mockImplementation(async r => {
    if (r.type === "question_stats") return {count:31,types:{single:31},feasibleCounts:Array.from({length:31}, (_, i) => i + 1)} as never;
    if (r.type === "questions_page") return {items:all.slice(r.offset,r.offset+r.limit),total:31,offset:r.offset} as never;
    if (r.type === "preview_paper") return {questionIds:r.request.question_ids,digest:"preview",questions:[],scores:[],count:2} as never;
    return {id:"session"} as never;
  });
  await userEvent.click(screen.getByText(/高级设置/, { selector: "summary" }));
  vi.mocked(api).mockClear();
  const search = screen.getByRole("textbox", {name:"搜索题目"});
  for (const value of ["s","sa","sam","samp","sampl","sample"]) fireEvent.change(search,{target:{value}});
  await screen.findByText(/可用 31 题/);
  expect(vi.mocked(api).mock.calls.map(([r])=>r.type)).toEqual(["question_stats"]);
  await userEvent.selectOptions(screen.getByLabelText("选题方式"),"manual");
  await userEvent.click(await screen.findByRole("checkbox",{name:"Question 0"}));
  await userEvent.click(screen.getByRole("button",{name:"下一页"}));
  await userEvent.click(await screen.findByRole("checkbox",{name:"Question 30"}));
  expect(screen.queryByRole("checkbox",{name:"Question 0"})).toBeNull();
  await userEvent.click(screen.getByRole("button",{name:"上一页"}));
  expect((await screen.findByRole("checkbox",{name:"Question 0"})).getAttribute("aria-checked")).toBe("true");
  await userEvent.click(screen.getByRole("button",{name:"立即开始"}));
  await waitFor(()=>expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"start_paper",paper:expect.objectContaining({question_ids:["q0","q30"]})})));
});


it("uses whole-group defaults, offers nearby counts and never silently changes an entered count", async () => {
  const started = setup();
  vi.mocked(api).mockImplementation(async r => {
    if (r.type === "question_stats") return {count:24,types:{reading:8},feasibleCounts:[3,6,9,12,15,18,21,24]} as never;
    if (r.type === "preview_paper") return {questionIds:["group"],digest:"preview",questions:rows,scores:[],count:r.request.count} as never;
    return {id:"session"} as never;
  });
  await screen.findByText(/可用 24 题/);
  const count = screen.getByLabelText("题目数量") as HTMLInputElement;
  expect(count.value).toBe("18");
  fireEvent.change(count, {target:{value:"20"}});
  expect(count.value).toBe("20");
  expect(screen.getByRole("button",{name:"立即开始"}).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button",{name:"选择 18 小题"})).toBeTruthy();
  await userEvent.click(screen.getByRole("button",{name:"选择 21 小题"}));
  expect(count.value).toBe("21");
  await userEvent.click(screen.getByRole("button",{name:"立即开始"}));
  await waitFor(() => expect(started).toHaveBeenCalled());
  expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"preview_paper",request:expect.objectContaining({count:21})}));
});

it("reports selected material groups and answerable subquestions separately", async () => {
  setup();
  const groups = rows.map((q, i) => ({...q,answerableCount:3,question:{...q.question,stem:`材料 ${i}`,answerMode:"reading"}}));
  vi.mocked(api).mockImplementation(async r => {
    if (r.type === "question_stats") return {count:6,types:{reading:2},feasibleCounts:[3,6]} as never;
    if (r.type === "questions_page") return {items:groups,total:2,offset:0} as never;
    return {id:"session"} as never;
  });
  await screen.findByText(/可用 6 题/);
  await userEvent.click(screen.getByText(/高级设置/, {selector:"summary"}));
  await userEvent.selectOptions(screen.getByLabelText("选题方式"), "manual");
  await userEvent.click(await screen.findByRole("checkbox", {name:/材料 0/}));
  await userEvent.click(screen.getByRole("checkbox", {name:/材料 1/}));
  expect(screen.getByRole("status").textContent).toContain("本次 2 组 / 6 小题");
  await userEvent.selectOptions(screen.getByLabelText("选题方式"), "quota");
  expect(screen.getByText("阅读理解（可用 2 组）")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("阅读理解组数"), {target:{value:"2"}});
  expect(screen.getByRole("status").textContent).toContain("2 组 + 0 单题；小题数将在生成时确定");
});


it("keeps an explicit resumed bank scope instead of falling back to every bank", async () => {
  vi.mocked(api).mockResolvedValue({count:1,types:{single:1},feasibleCounts:[1]} as never);
  const props = {banks,initialBank:"one",initialFilter:"unattempted",busy:false,run:(job:()=>Promise<void>)=>{void job();},onStart:async()=>{},onClose:()=>{}};
  const view = render(<StudySetup {...props} initialBankIds={["two"]}/>);
  await waitFor(() => expect(api).toHaveBeenCalledWith({type:"question_stats",bank_id:null,bank_ids:["two"],search:"",mode:"",filter:"unattempted"}));
  view.unmount();
  vi.mocked(api).mockClear();
  render(<StudySetup {...props} initialBankIds={[]}/>);
  expect(screen.getByText("请选择至少一个题库")).toBeTruthy();
  expect(screen.getByRole("button",{name:"立即开始"}).hasAttribute("disabled")).toBe(true);
  expect(api).not.toHaveBeenCalled();
});
