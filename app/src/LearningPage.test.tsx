// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LearningPage } from "./LearningPage";
import { api, type LearningOverview } from "./api";

vi.mock("./api", async()=>({...await vi.importActual("./api"),api:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
function fixture():LearningOverview {
  const counts={submitted:5,skipped:1,ungraded:1,auto:{graded:2,correct:1},selfAssessed:{graded:1,correct:1},ai:{graded:0,correct:0},manual:{graded:0,correct:0}};
  return {days:7,since:1,through:9,counts,banks:[{id:"bank",title:"Algebra",available:true,counts}],kinds:[{kind:"single",counts}],review:[{rootId:"group",bankId:"bank",bankTitle:"Algebra",stem:"Complete material group",count:3,reason:"repeated_wrong",lastAnsweredAt:1,causes:["misread"]}],backup:{lastBackupAt:null,newAttempts:5,changedNotes:0,due:true}};
}
function mount() {
  const props={revision:0,busy:false,run:(job:()=>Promise<void>)=>void job(),onStart:vi.fn(),onPractice:vi.fn()};
  render(<LearningPage {...props}/>);return props;
}
it("loads passively, separates scoring and starts a complete recommended group only on demand",async()=>{
  const user=userEvent.setup(),data=fixture();
  vi.mocked(api).mockImplementation(async request=>{
    if(request.type==="learning_overview")return data as never;
    if(request.type==="preview_paper")return {questionIds:["group"],digest:"frozen"} as never;
    if(request.type==="start_paper")return {id:"practice"} as never;
    throw Error("Unexpected request");
  });
  const props=mount();
  await screen.findByText("Complete material group");expect(api).toHaveBeenCalledTimes(1);
  const table=within(screen.getByRole("heading",{name:"按题库"}).parentElement!);
  expect(table.getByText("50%")).toBeTruthy();expect(table.getByRole("columnheader",{name:"自动判定正确率"})).toBeTruthy();
  expect(screen.queryByRole("button",{name:"前往备份"})).toBeNull();
  expect(screen.queryByText("尚未导出学习数据备份。")).toBeNull();
  await user.click(screen.getByRole("button",{name:"开始复习 3 题"}));
  await waitFor(()=>expect(props.onStart).toHaveBeenCalledWith({id:"practice"}));
  expect(api).toHaveBeenCalledWith({type:"preview_paper",request:expect.objectContaining({bank_ids:["bank"],question_ids:["group"],selection:"manual",filter:"",search:"",mode:""})});
  expect(api).toHaveBeenCalledWith({type:"start_paper",paper:{question_ids:["group"],digest:"frozen",kind:"practice",minutes:null,scores:[],total_cents:0}});
});
it("filters by cause, changes date range and opens targeted practice",async()=>{
  const user=userEvent.setup();vi.mocked(api).mockResolvedValue(fixture() as never);const props=mount();
  await screen.findByText("Complete material group");await user.selectOptions(screen.getByLabelText("按错因筛选"),"knowledge");
  expect(screen.queryByText("Complete material group")).toBeNull();expect(screen.getByRole("button",{name:"开始复习 0 题"}).hasAttribute("disabled")).toBe(true);
  await user.selectOptions(screen.getByLabelText("统计范围"),"30");
  await waitFor(()=>expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"learning_overview",days:30})));
  const section=screen.getByRole("heading",{name:"按题型"}).parentElement!;
  await user.click(within(section).getByRole("button",{name:"专项练习"}));expect(props.onPractice).toHaveBeenCalledWith(null,"single");
});
it("retains read failures until retry and renders empty histories honestly",async()=>{
  const user=userEvent.setup();const empty=fixture();empty.review=[];empty.banks=[];empty.kinds=[];
  vi.mocked(api).mockRejectedValueOnce(Error("Read failed")).mockResolvedValue(empty as never);mount();
  await screen.findByRole("alert");expect(api).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button",{name:"重试"}));
  await screen.findByText("暂无待复习题目。");
  expect(screen.getAllByText("此时间范围内暂无已提交作答。")).toHaveLength(2);
});
