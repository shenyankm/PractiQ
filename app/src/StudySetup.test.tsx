// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StudySetup } from "./StudySetup";
import { api, type QuestionRow, type Session } from "./api";
import fixture from "../fixtures/sample.json";
vi.mock("./api", async () => ({ ...(await vi.importActual<typeof import("./api")>("./api")), api: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const banks = [{id:"one",title:"题库一",count:2,description:"",createdAt:0}, {id:"two",title:"题库二",count:1,description:"",createdAt:0}];
const rows = fixture.questions.slice(0,2).map((question,i) => ({id:`q${i}`,bankId:"one",bankTitle:"题库一",question,groups:[],visuals:[],sources:[],warnings:[],missingAssets:false,favorite:false,latestResult:null})) as QuestionRow[];

it("preserves the review filter when opening study setup from the review list", async () => {
  vi.mocked(api).mockResolvedValue({count:1,types:{single:1},feasibleCounts:[1]} as never);
  render(<StudySetup banks={banks} initialBank="one" initialFilter="review" busy={false} run={job=>{void job();}} onStart={async()=>{}} onClose={()=>{}}/>);
  await screen.findByText(/可用 1 题/);
  await userEvent.click(screen.getByText(/高级设置/, {selector:"summary"}));
  expect((screen.getByLabelText("范围") as HTMLSelectElement).value).toBe("review");
  expect(screen.getByRole("status").textContent).toContain("待复核");
  expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"question_stats",filter:"review"}));
});

it("reallocates the existing random paper in place and rejects changed question content", async () => {
  let generated = 0;
  let changed = false;
  const questions = [rows[0], rows[1]].map(row => ({...row, rootType:"single"}));
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "question_stats") return {count:2,types:{single:2},feasibleCounts:[1,2]} as never;
    if (request.type === "preview_paper") {
      const ids = request.request.selection === "manual" ? request.request.question_ids : ++generated === 1 ? ["q1", "q0"] : ["q0", "q1"];
      return {questionIds:ids,digest:changed ? "changed" : "original",questions:ids.map(id => questions.find(row => row.id === id)),scores:ids.map(() => 5000),count:2} as never;
    }
    return {id:"session"} as never;
  });
  render(<StudySetup banks={banks} initialBank="one" initialFilter="" busy={false} run={job => {void job();}} onStart={async()=>{}} onClose={()=>{}}/>);
  await screen.findByText(/可用 2 题/);
  await userEvent.selectOptions(screen.getByLabelText("模式"), "self_test");
  await userEvent.selectOptions(screen.getByLabelText("出题顺序"), "random");
  await userEvent.click(screen.getByRole("button", {name:"预览题目与配分"}));
  await userEvent.click(screen.getByText("按题型分配总分", {selector:"summary"}));
  fireEvent.change(screen.getByLabelText("单选预算"), {target:{value:"100"}});
  await userEvent.click(screen.getByRole("button", {name:"按题型预算重新配分（覆盖逐题修改）"}));
  expect(api).toHaveBeenLastCalledWith(expect.objectContaining({type:"preview_paper",request:expect.objectContaining({selection:"manual",question_ids:["q1","q0"],random:false,budgets:{single:10000}})}));
  expect(generated).toBe(1);
  changed = true;
  await userEvent.click(screen.getByRole("button", {name:"按题型预算重新配分（覆盖逐题修改）"}));
  expect(screen.getByRole("alert").textContent).toContain("题目内容已变化，请重新生成组卷预览");
  await userEvent.click(screen.getByRole("button", {name:"开始考试"}));
  expect(api).toHaveBeenLastCalledWith(expect.objectContaining({type:"start_paper",paper:expect.objectContaining({question_ids:["q1","q0"],digest:"original"})}));
});

it("drops hidden type budgets when the paper changes and does not restore them with the old filter", async () => {
  const questions = [{...rows[0],rootType:"single"}, {...rows[1],rootType:"fill_blank"}];
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "question_stats") return {count:request.mode ? 1 : 2,types:request.mode ? {single:1} : {single:1,fill_blank:1},feasibleCounts:[1,2]} as never;
    if (request.type === "preview_paper") {
      const selected = request.request.mode ? questions.slice(0,1) : questions;
      return {questionIds:selected.map(row=>row.id),digest:"paper",questions:selected,scores:selected.map(()=>10000/selected.length),count:selected.length} as never;
    }
    return {id:"session"} as never;
  });
  render(<StudySetup banks={banks} initialBank="one" initialFilter="" busy={false} run={job => {void job();}} onStart={async()=>{}} onClose={()=>{}}/>);
  await screen.findByText(/可用 2 题/);
  await userEvent.selectOptions(screen.getByLabelText("模式"), "self_test");
  await userEvent.click(screen.getByRole("button", {name:"预览题目与配分"}));
  await userEvent.click(screen.getByText("按题型分配总分", {selector:"summary"}));
  fireEvent.change(screen.getByLabelText("单选预算"), {target:{value:"50"}});
  fireEvent.change(screen.getByLabelText("填空预算"), {target:{value:"50"}});
  await userEvent.click(screen.getByText(/高级设置/, {selector:"summary"}));
  await userEvent.selectOptions(screen.getByLabelText("题型"), "single");
  await screen.findByText(/可用 1 题/);
  await userEvent.click(screen.getByRole("button", {name:"预览题目与配分"}));
  await userEvent.click(screen.getByText("按题型分配总分", {selector:"summary"}));
  fireEvent.change(screen.getByLabelText("单选预算"), {target:{value:"100"}});
  await userEvent.click(screen.getByRole("button", {name:"按题型预算重新配分（覆盖逐题修改）"}));
  expect(api).toHaveBeenLastCalledWith(expect.objectContaining({type:"preview_paper",request:expect.objectContaining({budgets:{single:10000}})}));
  await userEvent.selectOptions(screen.getByLabelText("题型"), "");
  await screen.findByText(/可用 2 题/);
  await userEvent.click(screen.getByRole("button", {name:"预览题目与配分"}));
  await userEvent.click(screen.getByText("按题型分配总分", {selector:"summary"}));
  expect((screen.getByLabelText("填空预算") as HTMLInputElement).value).toBe("0");
});

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

it.each([{feasibleCounts:[1,2],expected:2}, {feasibleCounts:[3,6,9],expected:9}])("initializes an untouched count after the first statistics read succeeds on retry ($expected)", async ({feasibleCounts,expected}) => {
  vi.mocked(api).mockRejectedValueOnce(new Error("Statistics unavailable")).mockResolvedValue({count:expected,types:{single:expected},feasibleCounts} as never);
  render(<StudySetup banks={banks} initialBank="one" initialFilter="" busy={false} run={job=>{void job();}} onStart={async()=>{}} onClose={()=>{}}/>);
  const retry = await screen.findByRole("button", {name:"重试题目统计"});
  expect((screen.getByLabelText("题目数量") as HTMLInputElement).value).toBe("20");
  await userEvent.click(retry);
  await waitFor(() => expect(screen.queryByRole("button", {name:"重试题目统计"})).toBeNull());
  expect((screen.getByLabelText("题目数量") as HTMLInputElement).value).toBe(String(expected));
  expect(screen.getByRole("button", {name:"立即开始"}).hasAttribute("disabled")).toBe(false);
  expect(screen.queryByText("该数量无法由完整题组组成，请选择可用数量。")).toBeNull();
});

it("preserves a count entered while the first statistics read is pending", async () => {
  let resolveStats: (value: unknown) => void = () => {};
  vi.mocked(api).mockImplementation(async () => new Promise(resolve => { resolveStats = resolve; }) as never);
  render(<StudySetup banks={banks} initialBank="one" initialFilter="" busy={false} run={job=>{void job();}} onStart={async()=>{}} onClose={()=>{}}/>);
  fireEvent.change(screen.getByLabelText("题目数量"), {target:{value:"1"}});
  await waitFor(() => expect(api).toHaveBeenCalled());
  await act(async () => { resolveStats({count:2,types:{single:2},feasibleCounts:[1,2]}); });
  await waitFor(() => expect(screen.getByRole("button", {name:"立即开始"}).hasAttribute("disabled")).toBe(false));
  expect((screen.getByLabelText("题目数量") as HTMLInputElement).value).toBe("1");
});

it("retries statistics without resetting selections, quotas, count or exam settings", async () => {
  setup();
  const base = vi.mocked(api).getMockImplementation()!;
  let resolveStats: (value: unknown) => void = () => {};
  let failing = true;
  vi.mocked(api).mockImplementation(async request => {
    if (request.type !== "question_stats") return base(request);
    if (failing) throw new Error("Statistics unavailable");
    return new Promise(resolve => { resolveStats = resolve; }) as never;
  });
  expect((await screen.findByRole("alert")).textContent).toContain("Statistics unavailable");
  await userEvent.selectOptions(screen.getByLabelText("模式"), "mock_exam");
  fireEvent.change(screen.getByLabelText("考试分钟数"), {target:{value:"45"}});
  fireEvent.change(screen.getByLabelText("考试总分"), {target:{value:"90"}});
  fireEvent.change(screen.getByLabelText("题目数量"), {target:{value:"1"}});
  await userEvent.selectOptions(screen.getByLabelText("出题顺序"), "random");
  await userEvent.click(screen.getByText(/高级设置/, {selector:"summary"}));
  await userEvent.selectOptions(screen.getByLabelText("选题方式"), "quota");
  fireEvent.change(screen.getByLabelText("单选题数"), {target:{value:"1"}});
  await userEvent.selectOptions(screen.getByLabelText("选题方式"), "manual");
  await userEvent.click(await screen.findByRole("checkbox", {name:rows[0].question.stem!}));
  failing = false;
  const retry = screen.getByRole("button", {name:"重试题目统计"});
  await userEvent.click(retry);
  expect(retry.hasAttribute("disabled")).toBe(true);
  await userEvent.click(retry);
  await waitFor(() => expect(vi.mocked(api).mock.calls.filter(([r]) => r.type === "question_stats")).toHaveLength(2));
  const requests = vi.mocked(api).mock.calls.filter(([r]) => r.type === "question_stats");
  expect(requests[1][0]).toEqual(requests[0][0]);
  expect(screen.getByRole("alert").textContent).toContain("Statistics unavailable");
  await act(async () => { resolveStats({count:2,types:{single:2},feasibleCounts:[1,2]}); });
  await waitFor(() => expect(screen.queryByRole("button", {name:"重试题目统计"})).toBeNull());
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("checkbox", {name:rows[0].question.stem!}).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("checkbox", {name:"题库一（2）"}).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("checkbox", {name:"题库二（1）"}).getAttribute("aria-checked")).toBe("false");
  expect((screen.getByLabelText("考试分钟数") as HTMLInputElement).value).toBe("45");
  expect((screen.getByLabelText("考试总分") as HTMLInputElement).value).toBe("90");
  await userEvent.selectOptions(screen.getByLabelText("选题方式"), "quota");
  expect((screen.getByLabelText("单选题数") as HTMLInputElement).value).toBe("1");
  await userEvent.selectOptions(screen.getByLabelText("选题方式"), "count");
  expect((screen.getByLabelText("题目数量") as HTMLInputElement).value).toBe("1");
  expect((screen.getByLabelText("出题顺序") as HTMLSelectElement).value).toBe("random");
  vi.mocked(api).mockImplementation(base);
  await userEvent.selectOptions(screen.getByLabelText("范围"), "wrong");
  await waitFor(() => expect((screen.getByLabelText("题目数量") as HTMLInputElement).value).toBe("2"));
  fireEvent.change(screen.getByLabelText("题目数量"), {target:{value:"1"}});
  await userEvent.selectOptions(screen.getByLabelText("范围"), "");
  await waitFor(() => expect((screen.getByLabelText("题目数量") as HTMLInputElement).value).toBe("2"));
});

it("retries a failed manual page in place and keeps choices from earlier pages", async () => {
  const all = Array.from({length:31}, (_, i) => ({...rows[0],id:`q${i}`,question:{...rows[0].question,stem:`Question ${i}`}}));
  let resolvePage: (value: unknown) => void = () => {};
  let failing = true;
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "question_stats") return {count:31,types:{single:31},feasibleCounts:Array.from({length:31}, (_, i) => i + 1)} as never;
    if (request.type === "questions_page") {
      if (request.offset === 30) {
        if (failing) throw new Error("Question page unavailable");
        return new Promise(resolve => { resolvePage = resolve; }) as never;
      }
      return {items:all.slice(0,30),total:31,offset:0} as never;
    }
    return {id:"session"} as never;
  });
  render(<StudySetup banks={banks} initialBank="one" initialFilter="review" initialSearch="sample" busy={false} run={job=>{void job();}} onStart={async()=>{}} onClose={()=>{}}/>);
  await screen.findByText(/可用 31 题/);
  await userEvent.selectOptions(screen.getByLabelText("模式"), "mock_exam");
  fireEvent.change(screen.getByLabelText("考试分钟数"), {target:{value:"45"}});
  fireEvent.change(screen.getByLabelText("题目数量"), {target:{value:"10"}});
  await userEvent.click(screen.getByText(/高级设置/, {selector:"summary"}));
  await userEvent.selectOptions(screen.getByLabelText("选题方式"), "quota");
  fireEvent.change(screen.getByLabelText("单选题数"), {target:{value:"3"}});
  await userEvent.selectOptions(screen.getByLabelText("选题方式"), "manual");
  await userEvent.click(await screen.findByRole("checkbox", {name:"Question 0"}));
  await userEvent.click(screen.getByRole("button", {name:"下一页"}));
  expect((await screen.findByRole("alert")).textContent).toContain("Question page unavailable");
  const retry = screen.getByRole("button", {name:"重试选题列表"});
  failing = false;
  await userEvent.click(retry);
  expect(retry.hasAttribute("disabled")).toBe(true);
  await userEvent.click(retry);
  await waitFor(() => expect(vi.mocked(api).mock.calls.filter(([r]) => r.type === "questions_page")).toHaveLength(3));
  const requests = vi.mocked(api).mock.calls.filter(([r]) => r.type === "questions_page");
  expect(requests[2][0]).toEqual(requests[1][0]);
  expect(requests[2][0]).toMatchObject({bank_ids:["one"],filter:"review",search:"sample",offset:30});
  expect(vi.mocked(api).mock.calls.filter(([r]) => r.type === "question_stats")).toHaveLength(1);
  await act(async () => { resolvePage({items:all.slice(30),total:31,offset:30}); });
  await userEvent.click(await screen.findByRole("checkbox", {name:"Question 30"}));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("本次 2 题");
  await userEvent.click(screen.getByRole("button", {name:"上一页"}));
  expect((await screen.findByRole("checkbox", {name:"Question 0"})).getAttribute("aria-checked")).toBe("true");
  expect((screen.getByLabelText("考试分钟数") as HTMLInputElement).value).toBe("45");
  await userEvent.selectOptions(screen.getByLabelText("选题方式"), "quota");
  expect((screen.getByLabelText("单选题数") as HTMLInputElement).value).toBe("3");
  await userEvent.selectOptions(screen.getByLabelText("选题方式"), "count");
  expect((screen.getByLabelText("题目数量") as HTMLInputElement).value).toBe("10");
});

it("clears only the successfully retried read error when both reads fail", async () => {
  let statisticsFail = true, pageFail = true;
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "question_stats") {
      if (statisticsFail) throw new Error("Statistics unavailable");
      return {count:2,types:{single:2},feasibleCounts:[1,2]} as never;
    }
    if (request.type === "questions_page") {
      if (pageFail) throw new Error("Question page unavailable");
      return {items:rows,total:2,offset:0} as never;
    }
    throw new Error(request.type);
  });
  render(<StudySetup banks={banks} initialBank="one" initialFilter="" busy={false} run={job=>{void job();}} onStart={async()=>{}} onClose={()=>{}}/>);
  await screen.findByRole("button", {name:"重试题目统计"});
  await userEvent.click(screen.getByText(/高级设置/, {selector:"summary"}));
  await userEvent.selectOptions(screen.getByLabelText("选题方式"), "manual");
  await screen.findByRole("button", {name:"重试选题列表"});
  statisticsFail = false;
  await userEvent.click(screen.getByRole("button", {name:"重试题目统计"}));
  await waitFor(() => expect(screen.queryByRole("button", {name:"重试题目统计"})).toBeNull());
  expect(screen.getByRole("alert").textContent).toContain("Question page unavailable");
  pageFail = false;
  await userEvent.click(screen.getByRole("button", {name:"重试选题列表"}));
  await screen.findByRole("checkbox", {name:rows[0].question.stem!});
  expect(screen.queryByRole("alert")).toBeNull();
});
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
  await waitFor(() => expect(api).toHaveBeenCalledWith({type:"question_stats",bank_ids:["two"],search:"",mode:"",filter:"unattempted"}));
  view.unmount();
  vi.mocked(api).mockClear();
  render(<StudySetup {...props} initialBankIds={[]}/>);
  expect(screen.getByText("请选择至少一个题库")).toBeTruthy();
  expect(screen.getByRole("button",{name:"立即开始"}).hasAttribute("disabled")).toBe(true);
  expect(api).not.toHaveBeenCalled();
});

it("mounts only 30 score inputs and preserves edits across a 1000-question paper", async () => {
  const questions = Array.from({length:1000}, (_,i)=>({...rows[0],id:`q${i}`,question:{...rows[0].question,id:`q${i}`,stem:`Question ${i}`}}));
  vi.mocked(api).mockImplementation(async r => {
    if(r.type === "question_stats") return {count:1000,types:{single:1000},feasibleCounts:[1000]} as never;
    if(r.type === "preview_paper") return {questionIds:questions.map(q=>q.id),digest:"large",questions,scores:questions.map(()=>10),count:1000} as never;
    return {id:"session"} as never;
  });
  render(<StudySetup banks={banks} initialBank="one" initialFilter="" busy={false} run={job=>{void job();}} onStart={async()=>{}} onClose={()=>{}}/>);
  expect(screen.queryByRole("checkbox", {name:"题库一（2）"})).toBeNull();
  await screen.findByText(/可用 1,000 题/);
  await userEvent.selectOptions(screen.getByLabelText("模式"), "self_test");
  await userEvent.click(screen.getByRole("button", {name:"预览题目与配分"}));
  expect(document.querySelectorAll('input[aria-label$="题分值"]')).toHaveLength(30);
  fireEvent.change(screen.getByLabelText("第 1 题分值"), {target:{value:"0.20"}});
  await userEvent.click(screen.getByRole("button", {name:"下一页"}));
  fireEvent.change(screen.getByLabelText("第 31 题分值"), {target:{value:"0.00"}});
  expect(screen.queryByLabelText("第 1 题分值")).toBeNull();
  await userEvent.click(screen.getByRole("button", {name:"上一页"}));
  expect((screen.getByLabelText("第 1 题分值") as HTMLInputElement).value).toBe("0.20");
  await userEvent.click(screen.getByRole("button", {name:"开始考试"}));
  const start = vi.mocked(api).mock.calls.find(([r])=>r.type === "start_paper")?.[0];
  expect(start).toMatchObject({type:"start_paper",paper:{scores:expect.arrayContaining([20,0])}});
  if(start?.type !== "start_paper") throw new Error("paper was not started");
  expect(start.paper.scores).toHaveLength(1000);
  expect(start.paper.scores[0]).toBe(20);
  expect(start.paper.scores[30]).toBe(0);
  expect(start.paper.scores.reduce((n,score)=>n+score,0)).toBe(10000);
});


it("reloads a manual page when a pending filter is immediately reverted",async()=>{
  setup();
  await screen.findByText(/可用 2 题/);
  await userEvent.click(screen.getByText(/高级设置/,{selector:"summary"}));
  await userEvent.selectOptions(screen.getByLabelText("选题方式"),"manual");
  await screen.findByRole("checkbox",{name:rows[0].question.stem!});
  const search = screen.getByRole("textbox",{name:"搜索题目"});
  fireEvent.change(search,{target:{value:"temporary"}});
  expect(screen.queryByRole("checkbox",{name:rows[0].question.stem!})).toBeNull();
  fireEvent.change(search,{target:{value:""}});
  await screen.findByRole("checkbox",{name:rows[0].question.stem!});
  expect(vi.mocked(api).mock.calls.filter(([request])=>request.type==="questions_page")).toHaveLength(2);
});

it("combines fresh manual-page statistics without scanning the filter twice",async()=>{
  const stats = {count:2,types:{single:2},feasibleCounts:[1,2]};
  vi.mocked(api).mockImplementation(async request=>{
    if(request.type==="question_stats")return stats as never;
    if(request.type==="questions_page")return {items:rows,total:2,offset:0,...(request.include_stats ? {stats}:{})} as never;
    throw new Error(request.type);
  });
  render(<StudySetup banks={banks} initialBank="one" initialFilter="" busy={false} run={job=>{void job();}} onStart={async()=>{}} onClose={()=>{}}/>);
  await screen.findByText(/可用 2 题/);
  await userEvent.click(screen.getByText(/高级设置/,{selector:"summary"}));
  await userEvent.selectOptions(screen.getByLabelText("选题方式"),"manual");
  await screen.findByRole("checkbox",{name:rows[0].question.stem!});
  await userEvent.type(screen.getByRole("textbox",{name:"搜索题目"}),"shared");
  await waitFor(()=>expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"questions_page",search:"shared",include_stats:true})));
  await screen.findByText(/关键词：shared/);
  expect(vi.mocked(api).mock.calls.filter(([r])=>r.type==="question_stats")).toHaveLength(1);
});
