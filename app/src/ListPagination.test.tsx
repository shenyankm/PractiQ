// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { api, type Bank, type SessionSummary } from "./api";

vi.mock("@tauri-apps/api/core", () => ({invoke:vi.fn().mockResolvedValue([]),isTauri:()=>false}));
vi.mock("./api", async () => ({...await vi.importActual("./api"),api:vi.fn()}));
HTMLElement.prototype.hasPointerCapture = () => false;
HTMLElement.prototype.scrollIntoView = () => {};
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const banks: Bank[] = Array.from({length:31},(_,i)=>({id:`b${i}`,title:`Bank ${i}`,description:"",count:1,createdAt:1}));
const sessions: SessionSummary[] = Array.from({length:31},(_,i)=>({id:`s${i}`,title:`Session ${i}`,createdAt:1,finishedAt:2,count:1,answered:1,correct:1,graded:1,skipped:0,elapsedMs:0,selfGraded:0,autoGraded:1}));
function page<T>(items:T[], offset:number) {
  offset=Math.min(offset,Math.floor(Math.max(0,items.length-1)/30)*30);
  return {items:items.slice(offset,offset+30),total:items.length,offset};
}
function setup() {
  let records=[...banks];
  vi.mocked(api).mockImplementation(async r => {
    switch(r.type) {
      case "banks": return records as never;
      case "banks_page": return page(records,r.offset) as never;
      case "sessions_page": return page(sessions,r.offset) as never;
      case "unfinished_session": return {id:"old",title:"Off-page unfinished",count:1,answered:0} as never;
      case "info": return {version:"test",dataDirectory:"/tmp/test"} as never;
      case "delete_bank": records=records.filter(b=>b.id!==r.id); return null as never;
      case "question_stats": return {count:31,types:{single:31}} as never;
      case "pick_import": return {ticket:"zip",title:"Imported",count:1,reviewCount:0,assetCount:0,missingAssets:[],warnings:[]} as never;
      case "settings": return {config:{},hasApiKey:false} as never;
      default: throw new Error(r.type);
    }
  });
}
async function loaded() {
  await screen.findByText("1–30 / 31 条");
  await waitFor(()=>expect(screen.getByRole("button",{name:"下一页"}).hasAttribute("disabled")).toBe(false));
}
it("pages native bank summaries, keeps all merge/study choices, and clamps after deletion", async () => {
  setup(); render(<App/>); await loaded();
  expect(screen.queryByText("Bank 30")).toBeNull();
  expect(screen.getByText("Off-page unfinished · 已提交 0/1 题")).toBeTruthy();
  expect(screen.getByRole("button",{name:"上一页"}).hasAttribute("disabled")).toBe(true);
  await userEvent.click(screen.getByRole("button",{name:"合并题库"}));
  expect(within(await screen.findByRole("dialog")).getByRole("checkbox",{name:"Bank 30（1 题）"})).toBeTruthy();
  await userEvent.click(screen.getByRole("button",{name:"取消"}));
  await userEvent.click(screen.getAllByRole("button",{name:"开始练习"})[0]);
  await userEvent.click(await screen.findByText("高级设置 · 题库、筛选与选题方式"));
  expect(within(screen.getByRole("dialog")).getByRole("checkbox",{name:"Bank 30（1）"})).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button",{name:"导入题库"}));
  await userEvent.click(await screen.findByRole("button",{name:"选择题库 ZIP"}));
  await userEvent.click(within(await screen.findByRole("dialog")).getByRole("combobox"));
  expect(await screen.findByRole("option",{name:"Bank 30"})).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button",{name:"取消"}));
  await userEvent.click(screen.getByRole("button",{name:"我的题库"}));
  await loaded();
  await userEvent.click(screen.getByRole("button",{name:"下一页"}));
  expect(await screen.findByText("31–31 / 31 条")).toBeTruthy();
  expect(screen.queryByText("Bank 0")).toBeNull();
  expect(screen.getByRole("button",{name:"下一页"}).hasAttribute("disabled")).toBe(true);
  expect(api).toHaveBeenCalledWith({type:"banks_page",limit:30,offset:30});
  await userEvent.click(screen.getByRole("button",{name:"题库操作 Bank 30"}));
  await userEvent.click(screen.getByRole("menuitem",{name:"删除题库"}));
  await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button",{name:"确认"}));
  expect(await screen.findByText("1–30 / 30 条")).toBeTruthy();
  expect(screen.getByRole("button",{name:"上一页"}).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button",{name:"下一页"}).hasAttribute("disabled")).toBe(true);
}, 15000);
it("ignores a stale history response and refreshes newly created sessions with persistent retry", async () => {
  setup(); const base=vi.mocked(api).getMockImplementation()!;
  let resolveOld:(value:unknown)=>void=()=>{};
  let delayed=true;
  let failure=false;
  let records=[...sessions];
  vi.mocked(api).mockImplementation(async r=>{
    if(r.type!=="sessions_page") return base(r);
    if(failure) throw new Error("History unavailable");
    if(r.offset===30 && delayed) return new Promise(resolve=>{resolveOld=resolve;}) as never;
    return page(records,r.offset) as never;
  });
  render(<App/>); await loaded();
  await userEvent.click(screen.getByRole("button",{name:"练习记录"}));
  await screen.findByText("Session 0");
  await userEvent.click(screen.getByRole("button",{name:"下一页"}));
  expect(await screen.findByText("加载中…")).toBeTruthy();
  expect(screen.getByRole("button",{name:"上一页"}).hasAttribute("disabled")).toBe(true);
  await userEvent.click(screen.getByRole("button",{name:"我的题库"}));
  delayed=false;
  await screen.findByText("Bank 0");
  await userEvent.click(screen.getByRole("button",{name:"练习记录"}));
  await screen.findByText("Session 30");
  await act(async()=>resolveOld({items:[{...sessions[0],title:"STALE"}],total:1,offset:0}));
  expect(screen.queryByText("STALE")).toBeNull();
  expect(screen.getByText("31–31 / 31 条")).toBeTruthy();
  await userEvent.click(screen.getByRole("button",{name:"上一页"}));
  await screen.findByText("Session 0");
  failure=true;
  await userEvent.click(screen.getByRole("button",{name:"刷新"}));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent",expect.stringContaining("History unavailable"));
  expect(screen.queryByText("还没有练习记录")).toBeNull();
  failure=false; records=[{...sessions[0],id:"new",title:"New session"},...records];
  await userEvent.click(screen.getByRole("button",{name:"重试"}));
  await screen.findByText("New session");
  expect(screen.getByText("1–30 / 32 条")).toBeTruthy();
  records=[];
  await userEvent.click(screen.getByRole("button",{name:"刷新"}));
  expect(await screen.findByText("还没有练习记录")).toBeTruthy();
  expect(screen.getByText("0–0 / 0 条")).toBeTruthy();
});

it("refreshes merge totals and clamps both lists after restoring a smaller backup", async () => {
  setup(); const base=vi.mocked(api).getMockImplementation()!;
  let bankRows=[...banks]; let historyRows=[...sessions];
  vi.mocked(api).mockImplementation(async r=>{
    if(r.type==="banks") return bankRows as never;
    if(r.type==="banks_page") return page(bankRows,r.offset) as never;
    if(r.type==="sessions_page") return page(historyRows,r.offset) as never;
    if(r.type==="merge_banks") { bankRows=[...bankRows,{...banks[0],id:"merged",title:r.title}]; return {id:"merged"} as never; }
    if(r.type==="restore") { bankRows=banks.slice(0,1); historyRows=sessions.slice(0,1); return {recoveryPath:"/tmp/recovery"} as never; }
    return base(r);
  });
  render(<App/>); await loaded();
  await userEvent.click(screen.getByRole("button",{name:"下一页"}));
  await screen.findByText("31–31 / 31 条");
  await userEvent.click(screen.getByRole("button",{name:"合并题库"}));
  const dialog=await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("checkbox",{name:"Bank 0（1 题）"}));
  await userEvent.click(within(dialog).getByRole("checkbox",{name:"Bank 30（1 题）"}));
  await userEvent.type(within(dialog).getByRole("textbox",{name:"合并后的题库名称"}),"Merged");
  await userEvent.click(within(dialog).getByRole("button",{name:"确认合并"}));
  await screen.findByText("31–32 / 32 条");
  await userEvent.click(screen.getByRole("button",{name:"练习记录"}));
  await screen.findByText("Session 0");
  await userEvent.click(screen.getByRole("button",{name:"下一页"}));
  await screen.findByText("Session 30");
  await userEvent.click(screen.getByRole("button",{name:"设置"}));
  await userEvent.click(await screen.findByRole("button",{name:"恢复备份"}));
  await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button",{name:"确认"}));
  await waitFor(()=>expect(api).toHaveBeenCalledWith({type:"restore"}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"练习记录"}).hasAttribute("disabled")).toBe(false));
  await userEvent.click(screen.getByRole("button",{name:"练习记录"}));
  await screen.findByText("1–1 / 1 条");
  expect(screen.getByText("Session 0")).toBeTruthy();
  await userEvent.click(screen.getByRole("button",{name:"我的题库"}));
  await screen.findByText("1–1 / 1 条");
  expect(screen.getByText("Bank 0")).toBeTruthy();
  expect(screen.getByRole("button",{name:"上一页"}).hasAttribute("disabled")).toBe(true);
});
