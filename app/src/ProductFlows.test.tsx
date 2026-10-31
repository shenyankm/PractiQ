// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { api, blankQuestion, type QuestionRow, type SessionSummary } from "./api";
import fixture from "../fixtures/sample.json";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));
vi.mock("./api", async () => ({ ...await vi.importActual("./api"), api: vi.fn() }));
vi.mock("./notifications", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
HTMLElement.prototype.hasPointerCapture = () => false;
HTMLElement.prototype.scrollIntoView = () => {};
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it.each(["", "本周复习范围"])("keeps bank descriptions without adding repeated guidance (%s)", async description => {
  setup();
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async request => request.type === "banks_page"
    ? { items: [{ id: "bank", title: "English", count: 20, description }], total: 1, offset: 0 } as never
    : original(request));
  render(<App />);
  await screen.findByRole("heading", { name: "English" });
  if (description) expect(screen.getByText(description)).toBeTruthy();
  expect(screen.queryByText("选择题目开始练习，或查看内容与复核提示。")).toBeNull();
  expect(screen.getByRole("button", { name: "开始练习" })).toBeTruthy();
});

it("keeps backup exclusions available on demand and restore warnings visible", async () => {
  setup(); render(<App />);
  await screen.findByText("English");
  await userEvent.click(screen.getByRole("button", { name: "设置" }));
  const summary = await screen.findByText("备份范围与注意事项", { selector: "summary" });
  expect(screen.queryByText("管理 AI 服务连接与本地学习数据")).toBeNull();
  expect(screen.getByText("备份题库与学习记录，不含访问令牌。")).toBeTruthy();
  expect(summary.closest("details")?.open).toBe(false);
  await userEvent.click(summary);
  expect(summary.closest("details")?.open).toBe(true);
  expect(screen.getByText(/包含题库、图片、收藏、作答和评分记录/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "导入与恢复" }));
  expect(screen.getByText("替换全部本地数据，操作前需确认")).toBeTruthy();
});

it.each([false,true])("requires replacement confirmation and explicit recovery selection (%s)",async recover => {
  setup(); render(<App />);
  await screen.findByText("English");
  await userEvent.click(screen.getByRole("button",{name:"设置"}));
  const trigger = await screen.findByRole("button", { name: "导入与恢复" });
  await userEvent.click(trigger);
  await userEvent.click(screen.getByRole("menuitem",{name:recover ? "修复资源并恢复备份" : "恢复学习数据备份"}));
  await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await userEvent.click(trigger);
  await userEvent.click(screen.getByRole("menuitem",{name:recover ? "修复资源并恢复备份" : "恢复学习数据备份"}));
  expect(vi.mocked(api).mock.calls.some(([request])=>request.type==="restore")).toBe(false);
  const dialog = screen.getByRole("alertdialog");
  if(recover) expect(within(dialog).getByText(/该副本不能作为普通备份直接恢复/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button",{name:"恢复备份"}));
  await waitFor(()=>expect(api).toHaveBeenCalledWith(recover ? {type:"restore",recover_assets:true} : {type:"restore"}));
});

it("keeps desktop navigation focused on offline practice without AI import requests", async () => {
  setup(); render(<App />);
  await screen.findByText("English");
  expect(screen.queryByRole("button", { name: "导入题库" })).toBeNull();
  expect(screen.queryByRole("button", { name: "从文档解析题目" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "设置" }));
  await userEvent.click(await screen.findByRole("button", { name: "配置" }));
  expect(await screen.findByRole("heading", { name: "AI 服务", level: 1 })).toBeTruthy();
  expect(await screen.findByLabelText("模型 ID")).toBeTruthy();
  const { invoke } = await import("@tauri-apps/api/core");
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "ai_request" || command === "office_request")).toBe(false);
});

const exam: SessionSummary = {
  id: "exam", title: "English · Mock exam · 20", kind: "mock_exam", createdAt: 1,
  deadlineAt: Date.now() + 60_000, finishedAt: null, submittedAt: null,
  count: 20, answered: 0, draftAnswered: 15, correct: 0, graded: 0, skipped: 0,
  elapsedMs: 0, selfGraded: 0, autoGraded: 0,
};
const row = {
  id: "q", bankId: "bank", bankTitle: "English", question: fixture.questions[0],
  groups: [], visuals: [], sources: [], warnings: [], missingAssets: false,
  favorite: false, latestResult: false,
  latestScore: { earnedCents: 900, maxCents: 1000, gradeKind: "manual" },
} as QuestionRow;
it.each(["practice", "mock_exam"] as const)("shows saved %s progress before resuming without starting work", async kind => {
  setup();
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async request => request.type === "unfinished_session"
    ? { ...exam, kind, answered: 3, draftAnswered: 15 } as never
    : original(request));
  render(<App />);
  const progress = await screen.findByRole("progressbar", { name: "继续未完成的练习" });
  expect(progress.getAttribute("value")).toBe(kind === "practice" ? "3" : "15");
  expect(progress.getAttribute("max")).toBe("20");
  expect(screen.getByText(kind === "practice" ? "已提交 3/20 题" : "已答 15/20 题 · 草稿已保存")).toBeTruthy();
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({ type: "start_paper" }));
});
function setup(question = row, failReview = false) {
  vi.mocked(api).mockImplementation(async request => {
    switch (request.type) {
      case "banks": return [{ id: "bank", title: "English", count: 20 }] as never;
      case "banks_page": return { items: [{ id: "bank", title: "English", count: 20, description: "" }], total: 1, offset: 0 } as never;
      case "unfinished_session": return exam as never;
      case "sessions_page": return { items: request.filter === "finished" ? [] : [exam], total: request.filter === "finished" ? 0 : 1, offset: 0 } as never;
      case "questions_page": {
        const pending = [question, ...(question.children || [])].some(item => item.question.needsReview && item.reviewedAt == null);
        const nodes = [question,...(question.children || [])];
        const items = request.filter === "review" && !pending ? [] : [{...question,reviewRequired:pending,hasWrong:nodes.some(n=>n.latestResult===false),hasPartialScore:nodes.some(n=>n.latestResult===false && n.latestScore && n.latestScore.earnedCents>0 && n.latestScore.earnedCents<n.latestScore.maxCents)}];
        return { items, total: items.length, offset: 0 } as never;
      }
      case "question_detail": return question as never;
      case "review_question": {
        if (failReview) throw new Error("Review failed");
        const reviewedAt = request.reviewed ? 123 : null;
        question = { ...question, reviewedAt, children: question.children?.map(child => ({ ...child, reviewedAt })) };
        return reviewedAt as never;
      }
      case "info": return { version: "test", dataDirectory: "/tmp/test" } as never;
      case "settings": return { config: { service_url: null }, hasServiceToken: false } as never;
      case "pick_import": return null as never;
      case "question_stats": return { count: 0, types: {}, feasibleCounts: [] } as never;
      default: throw new Error(`Unexpected request: ${request.type}`);
    }
  });
}

it("opens Restore backup from the bank header without starting the ZIP picker", async () => {
  setup(); render(<App/>);
  await screen.findByText("English");
  expect(api).not.toHaveBeenCalledWith({ type: "pick_import" });
  expect(screen.queryByRole("button", { name: "已有题库 ZIP？前往设置导入" })).toBeNull();
  await userEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: "导入" }));
  expect(await screen.findByRole("menuitem", { name: "导入题库 ZIP" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "恢复学习数据备份" })).toBeTruthy();
  expect(screen.getByRole("heading", { level: 1, hidden: true }).textContent).toBe("设置");
  expect(api).not.toHaveBeenCalledWith({ type: "pick_import" });
});

it("opens the existing offline ZIP entry with an explicit append/replace distinction", async () => {
  setup(); render(<App/>);
  await screen.findByText("English");
  await userEvent.click(screen.getByRole("button", { name: "设置" }));
  await userEvent.click(await screen.findByRole("button", { name: "导入与恢复" }));
  expect(await screen.findByRole("menuitem", { name: "导入题库 ZIP" })).toBeTruthy();
  expect(screen.getByText("追加题库，不替换已有学习记录")).toBeTruthy();
  expect(screen.getByText("替换全部本地数据，操作前需确认")).toBeTruthy();
  await userEvent.click(screen.getByRole("menuitem", { name: "导入题库 ZIP" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith({ type: "pick_import" }));
});

it.each([false, true])("routes empty states through Restore backup before ZIP selection (existing bank=%s)", async existing => {
  setup();
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async request => {
    const banks = existing ? [{ id: "bank", title: "Empty bank", count: 0, description: "" }] : [];
    if (request.type === "banks") return banks as never;
    if (request.type === "banks_page") return { items: banks, total: banks.length, offset: 0 } as never;
    if (request.type === "unfinished_session") return null as never;
    if (request.type === "pick_import") return { ticket: "zip", title: "Imported", count: 1, reviewCount: 0, assetCount: 0, missingAssets: [], warnings: [] } as never;
    return original(request);
  });
  render(<App />);
  const importButton = await screen.findByRole("button", { name: existing ? "导入" : "导入题库 ZIP" });
  await waitFor(() => expect(importButton.hasAttribute("disabled")).toBe(false));
  await userEvent.click(importButton);
  await screen.findByRole("menuitem", { name: "导入题库 ZIP" });
  expect(api).not.toHaveBeenCalledWith({ type: "pick_import" });
  await userEvent.click(screen.getByRole("menuitem", { name: "导入题库 ZIP" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith({ type: "pick_import" }));
  const target = await screen.findByRole("combobox", { name: "导入到" });
  expect((target as HTMLSelectElement).value).toBe("new");
  expect(screen.getByRole("heading", { level: 1, hidden: true }).textContent).toBe("设置");
});

it("requires Restore backup and explicit destination selection from a question list", async () => {
  setup();
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "pick_import") return { ticket: "zip", title: "Imported", count: 1, reviewCount: 0, assetCount: 0, missingAssets: [], warnings: [] } as never;
    if (request.type === "import") return { bankId: "bank", count: 1, duplicate: false } as never;
    return original(request);
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "查看题目" }));
  for (const name of ["导入题库 ZIP", "新增题目", "开始练习"]) {
    expect(within(screen.getByRole("banner")).queryByRole("button", { name })).toBeNull();
  }
  expect(screen.queryByRole("checkbox", { name: "仅看待复核" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "设置" }));
  await userEvent.click(await screen.findByRole("button", { name: "导入与恢复" }));
  await screen.findByRole("menuitem", { name: "导入题库 ZIP" });
  expect(api).not.toHaveBeenCalledWith({ type: "pick_import" });
  await userEvent.click(screen.getByRole("menuitem", { name: "导入题库 ZIP" }));
  const target = await screen.findByRole("combobox", { name: "导入到" });
  expect((target as HTMLSelectElement).value).toBe("new");
  await userEvent.selectOptions(target, "bank");
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({ type: "import" }));
  await userEvent.click(screen.getByRole("button", { name: "确认导入" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith({ type: "import", ticket: "zip", bank_id: "bank", title: "Imported" }));
});

it("shows saved exam answers, filters history natively and focuses the page heading", async () => {
  setup(); render(<App/>);
  expect(await screen.findByText(/已答 15\/20 题 · 草稿已保存/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "继续考试" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "查看全部" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith({ type: "sessions_page", limit: 30, offset: 0, filter: "active" }));
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "练习记录", level: 1 }));
  await userEvent.selectOptions(screen.getByLabelText("练习记录状态"), "finished");
  expect(await screen.findByText("没有符合此状态的记录")).toBeTruthy();
  expect(api).toHaveBeenCalledWith({ type: "sessions_page", limit: 30, offset: 0, filter: "finished" });
});

it.each(["practice", "mock_exam"] as const)("keeps %s results, unknown counts and submitted totals in history", async kind => {
  setup();
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async request => request.type === "sessions_page"
    ? { items: [{ ...exam, title: "Saved result", kind, finishedAt: 1, submittedAt: 1, answered: 20, graded: 15, correct: 10, skipped: 1, pendingGrades: 4, earnedCents: 1000, totalCents: 2000 }], total: 1, offset: 0 } as never
    : original(request));
  render(<App/>);
  await screen.findByText("English");
  await userEvent.click(screen.getByRole("button", { name: "练习记录" }));
  await screen.findByRole("heading", { name: "Saved result" });
  expect(screen.getByText(kind === "practice" ? "已判定 15 题，答对 10 题 · 正确率 67%" : "预估成绩 10 / 20 分")).toBeTruthy();
  expect(screen.getByText(kind === "practice" ? "未答/跳过 1 题 · 未判定 4 题" : "未答/跳过 1 题 · 待评分 4 题")).toBeTruthy();
  expect(screen.getByText("已提交 20/20 题")).toBeTruthy();
  await userEvent.click(screen.getByText("判定详情", { selector: "summary" }));
  expect(screen.getByText("自动判定 0 · 自评 0 · 跳过 1 · 未判定 4")).toBeTruthy();
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({ type: "start_paper" }));
});

it("distinguishes partial credit in the review list", async () => {
  setup(); render(<App/>);
  await screen.findByText("English");
  await userEvent.click(screen.getByRole("button", { name: "查看题目" }));
  expect(await screen.findByText("部分得分")).toBeTruthy();
  expect(screen.getByText("上次 9 / 10 分")).toBeTruthy();
});

it("shows partial credit from a material group's child when the parent has no result", async () => {
  setup({ ...row, latestResult: null, latestScore: null, children: [row] });
  render(<App/>);
  await screen.findByText("English");
  await userEvent.click(screen.getByRole("button", { name: "错题本" }));
  expect(await screen.findByText("部分得分")).toBeTruthy();
  expect(screen.getByText(/未评分不算错题。/)).toBeTruthy();
  expect(within(screen.getByRole("banner")).queryByRole("button", { name: "导入题库 ZIP" })).toBeNull();
});

it("keeps all questions visible and confirms or revokes the whole material tree without hiding original warnings", async () => {
  const pending: QuestionRow = {
    ...row, id: "root", latestResult: null, latestScore: null,
    question: { ...blankQuestion(), id: "root", stem: "Shared material", answerMode: "reading", choiceVariant: null, options: [] },
    children: [{ ...row, id: "child", question: { ...row.question, id: "child", parentId: "root", needsReview: true, missingFields: ["answerPayload"], answerPayload: null } }],
  };
  setup(pending); render(<App />);
  await screen.findByText("English");
  await userEvent.click(screen.getByRole("button", { name: "查看题目" }));
  expect(await screen.findByRole("img", { name: "待复核" })).toBeTruthy();

  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({ type: "questions_page", filter: "", offset: 0 })));
  await userEvent.click(screen.getByRole("button", { name: /Shared material/ }));
  let dialog = await screen.findByRole("dialog", { name: "题目详情" });
  expect(within(dialog).getByText("此操作应用于本题及全部子题；原始质量提示会保留。")).toBeTruthy();
  expect(await within(dialog).findByText("内容待复核，仍可练习。")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "标记已复核" }));
  expect(await within(dialog).findByRole("button", { name: "撤销复核确认" })).toBeTruthy();
  expect(api).toHaveBeenCalledWith({ type: "review_question", id: "root", reviewed: true });
  expect(within(dialog).getAllByText("已人工复核，原始质量提示已保留。")).toHaveLength(2);
  expect(within(dialog).getAllByText(/缺失：/)).toHaveLength(1);
  expect(within(dialog).queryByText("内容待复核，仍可练习。")).toBeNull();
  await userEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
  expect(await screen.findByRole("button", { name: /Shared material/ })).toBeTruthy();

  const reviewedRow = await screen.findByRole("button", { name: /Shared material/ });
  expect(screen.queryByRole("img", { name: "待复核" })).toBeNull();
  await userEvent.click(reviewedRow);
  dialog = await screen.findByRole("dialog", { name: "题目详情" });
  await userEvent.click(within(dialog).getByRole("button", { name: "撤销复核确认" }));
  expect(await within(dialog).findByRole("button", { name: "标记已复核" })).toBeTruthy();
  expect(api).toHaveBeenCalledWith({ type: "review_question", id: "root", reviewed: false });
  expect(within(dialog).getByText("内容待复核，仍可练习。")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
  expect(await screen.findByRole("img", { name: "待复核" })).toBeTruthy();
  expect(pending.children?.[0].question.needsReview).toBe(true);
  expect(pending.children?.[0].question.missingFields).toEqual(["answerPayload"]);
});

it.each([null, 123])("preserves review state when saving the confirmation fails (reviewedAt=%s)", async reviewedAt => {
  setup({ ...row, reviewedAt, question: { ...row.question, needsReview: true, missingFields: ["answerPayload"] } }, true);
  render(<App />);
  await screen.findByText("English");
  await userEvent.click(screen.getByRole("button", { name: "查看题目" }));
  await userEvent.click(await screen.findByRole("button", { name: new RegExp(row.question.stem!) }));
  const dialog = await screen.findByRole("dialog", { name: "题目详情" });
  const action = reviewedAt == null ? "标记已复核" : "撤销复核确认";
  await userEvent.click(within(dialog).getByRole("button", { name: action }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(within(dialog).getByText(/Review failed/)).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: action }).hasAttribute("disabled")).toBe(false);
  expect(within(dialog).getByText(reviewedAt == null ? "内容待复核，仍可练习。" : "已人工复核，原始质量提示已保留。")).toBeTruthy();
  expect(within(dialog).getByText(/缺失：/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
  expect(screen.queryByRole("img", { name: "待复核" }) != null).toBe(reviewedAt == null);
});

it("creates an empty bank through the existing editor and native command", async () => {
  const user = userEvent.setup(); setup();
  const original = vi.mocked(api).getMockImplementation()!;
  let saved = false;
  const empty = {id:"created",title:"My new bank",description:"A local collection",count:0};
  vi.mocked(api).mockImplementation(async request => {
    if(request.type === "save_bank") { saved=true; return empty.id as never; }
    if(saved && request.type === "banks") return [empty] as never;
    if(saved && request.type === "banks_page") return {items:[empty],total:1,offset:0} as never;
    return original(request);
  });
  render(<App/>); await screen.findByText("English");
  await user.click(screen.getByRole("button",{name:"新建题库"}));
  const dialog = screen.getByRole("dialog",{name:"新建题库"});
  await user.type(within(dialog).getByLabelText("题库名称"),empty.title);
  await user.type(within(dialog).getByLabelText("说明"),empty.description);
  await user.click(within(dialog).getByRole("button",{name:"保存题库"}));
  await screen.findByRole("heading",{name:empty.title});
  expect(api).toHaveBeenCalledWith({type:"save_bank",id:null,title:empty.title,description:empty.description});
  expect(screen.queryByRole("button",{name:"导入题库 ZIP"})).toBeNull();
});

it("history emptiness offers a read-only return to all records", async () => {
  const user = userEvent.setup(); setup(); render(<App/>);
  await screen.findByText("English");
  await user.click(screen.getByRole("button",{name:"练习记录"}));
  await user.selectOptions(screen.getByLabelText("练习记录状态"),"finished");
  await screen.findByText("没有符合此状态的记录");
  await user.click(screen.getByRole("button",{name:"查看全部记录"}));
  await screen.findByText("待核对");
  expect(api).toHaveBeenCalledWith({type:"sessions_page",limit:30,offset:0});
});

it("appends an untitled import using the selected bank title without prompting for a new-bank title", async () => {
  const user = userEvent.setup(); setup();
  const original=vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async request => {
    if(request.type === "pick_import")return {ticket:"untitled",title:"",count:1,reviewCount:0,assetCount:0,missingAssets:[],warnings:[]} as never;
    if(request.type === "import")return {bankId:"bank",count:1,duplicate:false} as never;
    return original(request);
  });
  render(<App/>); await screen.findByText("English");
  await user.click(screen.getByRole("button",{name:"导入"}));
  await user.click(await screen.findByRole("menuitem",{name:"导入题库 ZIP"}));
  const dialog=await screen.findByRole("dialog",{name:"导入题库"});
  expect(within(dialog).getByRole("button",{name:"确认导入"}).hasAttribute("disabled")).toBe(true);
  await user.selectOptions(within(dialog).getByLabelText("导入到"),"bank");
  expect(within(dialog).queryByLabelText("题库名称")).toBeNull();
  await user.click(within(dialog).getByRole("button",{name:"确认导入"}));
  await waitFor(()=>expect(api).toHaveBeenCalledWith({type:"import",ticket:"untitled",bank_id:"bank",title:"English"}));
});

it("keeps favorites visible and moves editing and deletion into a question menu",async()=>{
 setup();render(<App/>);
 await userEvent.click(await screen.findByRole('button',{name:'查看题目'}));
 await screen.findByRole('button',{name:'收藏题目'});
 expect(screen.queryByRole('button',{name:'编辑题目'})).toBeNull();
 await userEvent.click(screen.getByRole('button',{name:'题目更多操作 1'}));
 expect(screen.getByRole('menuitem',{name:'编辑题目'})).toBeTruthy();
 await userEvent.click(screen.getByRole('menuitem',{name:'删除题目'}));
 expect(screen.getByRole('alertdialog',{name:'删除这道题目？'})).toBeTruthy();
 expect(api).not.toHaveBeenCalledWith(expect.objectContaining({type:'delete_question'}));
});

it("distinguishes an empty favorites list from a search with no matches",async()=>{
 setup();const original=vi.mocked(api).getMockImplementation()!;
 vi.mocked(api).mockImplementation(async request=>request.type==='questions_page'?{items:[],total:0,offset:0} as never:original(request));
 render(<App/>);
 await userEvent.click(await screen.findByRole('button',{name:'收藏夹'}));
 await screen.findByText('还没有收藏题目');
 expect(await screen.findByRole('button',{name:'浏览题库'})).toBeTruthy();
 await userEvent.type(screen.getByLabelText('搜索题目'),'no match');
 await screen.findByText('没有符合筛选的题目');
 expect(screen.queryByRole('button',{name:'浏览题库'})).toBeNull();
});
