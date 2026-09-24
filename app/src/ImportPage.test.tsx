// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";
import App from "./App";
import { ImportBankDialog } from "./ImportBankDialog";
import { toast } from "./notifications";
import fixture from "../fixtures/sample.json";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));
vi.mock("./api", async () => ({
  ...(await vi.importActual<typeof import("./api")>("./api")),
  api: vi.fn(),
}));
HTMLElement.prototype.hasPointerCapture = () => false;
HTMLElement.prototype.scrollIntoView = () => {};
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("loads native pages and clamps the page after deleting the last item", async () => {
  const rows=Array.from({length:31},(_,i)=>({id:`q${i}`,bankId:"bank",bankTitle:"Paged",question:{...fixture.questions[0],stem:`Page question ${i}`},groups:[],visuals:[],sources:[],warnings:[],missingAssets:false,favorite:false,latestResult:null}));
  let deleted=false;
  vi.mocked(api).mockImplementation(async request => {
    switch(request.type) {
      case "banks": return [{id:"bank",title:"Paged",description:"",count:deleted?30:31}] as never;
      case "banks_page": return {items:[{id:"bank",title:"Paged",description:"",count:deleted?30:31}],total:1,offset:0} as never;
      case "sessions_page": return {items:[],total:0,offset:0} as never;
      case "unfinished_session": return null as never;
      case "info": return {version:"test",dataDirectory:"/tmp/test"} as never;
      case "questions_page": {
        const offset=deleted?0:request.offset;
        return {items:rows.slice(offset,offset+30),offset,total:deleted?30:31} as never;
      }
      case "delete_question": deleted=true; return null as never;
      default: throw new Error(`Unexpected request: ${request.type}`);
    }
  });
  render(<App/>);
  await userEvent.click(await screen.findByRole("button",{name:/查看题目/}));
  expect(await screen.findByText("Page question 0")).toBeTruthy();
  expect(screen.queryByText("Page question 30")).toBeNull();
  await userEvent.click(screen.getByRole("button",{name:"下一页"}));
  expect(await screen.findByText("Page question 30")).toBeTruthy();
  expect(screen.queryByText("Page question 0")).toBeNull();
  await userEvent.click(screen.getByRole("button",{name:/删除题目/}));
  const dialog=await screen.findByRole("alertdialog");
  await userEvent.click(within(dialog).getByRole("button",{name:"确认"}));
  expect(await screen.findByText("Page question 0")).toBeTruthy();
  expect(screen.queryByRole("button",{name:"上一页"})).toBeNull();
  expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"questions_page",limit:30,offset:30}));
}, 30000);

it("keeps ZIP import usable without models and preserves the destination bank", async () => {
  vi.mocked(invoke).mockResolvedValue([]);
  vi.mocked(api).mockImplementation(async (request) => {
    switch (request.type) {
      case "banks":
        return [
          { id: "bank-1", title: "现有题库", description: "", count: 0 },
        ] as never;
      case "banks_page": return {items:[
          { id: "bank-1", title: "现有题库", description: "", count: 0 },
        ],total:1,offset:0} as never;
      case "sessions_page": return {items:[],total:0,offset:0} as never;
      case "unfinished_session": return null as never;
      case "questions_page": return {items:[],total:0,offset:0} as never;
      case "questions":
        return [] as never;
      case "info":
        return { version: "test", dataDirectory: "/tmp/test" } as never;
      case "settings": return { config: {}, hasApiKey: false } as never;
      case "pick_import":
        return {
          ticket: "ticket",
          title: "新文件",
          count: 1,
          reviewCount: 0,
          assetCount: 0,
          missingAssets: [],
          warnings: [],
          status: "SUCCEEDED",
        } as never;
      case "import":
        return { bankId: "bank-1", count: 1, duplicate: false } as never;
      default:
        throw new Error(`Unexpected request: ${request.type}`);
    }
  });
  render(<App />);
  const open = await screen.findByRole("button", { name: /查看题目/ });
  await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
  await userEvent.click(open);
  const start = screen.getByRole("button", { name: "导入" });
  await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
  await userEvent.click(start);
  expect(
    await screen.findByRole("heading", { name: "导入题库", level: 1 }),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("navigation", {name:"主导航"})).getByRole("button", {
      name: "导入题库",
    }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "文档解析" })).toBeNull();
  expect((await screen.findByText(/暂不支持 Word 文件/)).textContent).toContain("导出为 PDF");
  expect(screen.getByText(/支持 PDF/).textContent).toContain(".jpeg");
  expect(screen.getByText(/支持 PDF/).textContent).not.toMatch(/\.gif|\.webp/);
  expect(await screen.findByRole("button", { name: "配置 AI 模型" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "选择文档…" })).toBeNull();
  expect(screen.queryByRole("button", { name: "刷新任务" })).toBeNull();
  expect(vi.mocked(invoke).mock.calls.some(([,args]) => (args as {request:{type:string}}).request.type === "list")).toBe(false);
  await userEvent.click(await screen.findByRole("button",{name:"设置"}));
  await userEvent.click(await screen.findByRole("button",{name:"恢复备份"}));
  await userEvent.click(await screen.findByRole("menuitem",{name:"导入题库 ZIP"}));
  const dialog = await screen.findByRole("dialog");
  expect(screen.queryByRole("button", {name:"选择图片资源根目录"})).toBeNull();
  expect(within(dialog).getByRole("combobox", { name: "导入到" }).textContent).toContain("新建题库");
  await userEvent.click(within(dialog).getByRole("combobox", {name:"导入到"}));
  await userEvent.click(await screen.findByRole("option",{name:"现有题库"}));
  await waitFor(() =>
    expect(
      within(dialog)
        .getByRole("button", { name: "确认导入" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "确认导入" }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith({
      type: "import",
      ticket: "ticket",
      bank_id: "bank-1",
      title: "新文件",
    }),
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.every(
        ([command, args]) =>
          command === "ai_request" &&
          (args as { request: { type: string } }).request.type &&
          ["list", "operations", "batches"].includes(
            (args as { request: { type: string } }).request.type,
          ),
      ),
  ).toBe(true);
});

it("opens study setup from each bank card with that bank selected", async () => {
  const banks = [
    { id: "bank-1", title: "题库一", description: "", count: 2 },
    { id: "bank-2", title: "题库二", description: "", count: 3 },
    { id: "empty", title: "空题库", description: "", count: 0 },
  ];
  vi.mocked(api).mockImplementation(async (request) => {
    switch (request.type) {
      case "banks": return banks as never;
      case "banks_page": return {items:banks,total:banks.length,offset:0} as never;
      case "sessions_page": return {items:[],total:0,offset:0} as never;
      case "unfinished_session": return null as never;
      case "questions_page": return {items:[],total:0,offset:0} as never;
      case "question_stats": return {count:0,types:{}} as never;
      case "info": return { version: "test", dataDirectory: "/tmp/test" } as never;
      default: throw new Error(`Unexpected request: ${request.type}`);
    }
  });
  render(<App />);
  const actions = await screen.findAllByRole("button", { name: "开始练习" });
  await waitFor(() => expect(actions[0].hasAttribute("disabled")).toBe(false));
  expect(actions).toHaveLength(2);
  expect(screen.getByRole("button", { name: "导入题目" })).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "导入题库" })).toHaveLength(1);
  expect(within(screen.getByRole("navigation", {name:"主导航"})).getByRole("button", { name: "导入题库" })).toBeTruthy();
  for (const index of [1, 0]) {
    const card = screen.getByText(banks[index].title, { selector: '[data-slot="card-title"]' }).closest('[data-slot="card"]');
    expect(card).not.toBeNull();
    within(card as HTMLElement).getByRole("button", { name: `题库操作 ${banks[index].title}` }).focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("menuitem", { name: "编辑题库" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "删除题库" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(card as HTMLElement).getByRole("button", { name: "开始练习" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByText(/高级设置/, { selector: "summary" }));
    for (const [i, bank] of banks.entries()) {
      expect(within(dialog).getByRole("checkbox", { name: `${bank.title}（${bank.count}）` }).getAttribute("aria-checked")).toBe(String(i === index));
    }
    await waitFor(() => expect(api).toHaveBeenCalledWith({ type: "question_stats", bank_id: null, bank_ids: [banks[index].id], search: "", mode: "", filter: "" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(within(card as HTMLElement).getByRole("button", { name: "开始练习" })));
  }
});

it("merges banks only after selecting sources and confirming in the dialog", async () => {
  vi.mocked(api).mockImplementation(async (request) => {
    switch (request.type) {
      case "banks": return [
        { id: "one", title: "题库一", description: "", count: 2 },
        { id: "two", title: "题库二", description: "", count: 3 },
      ] as never;
      case "banks_page": return {items:[
        { id: "one", title: "题库一", description: "", count: 2 },
        { id: "two", title: "题库二", description: "", count: 3 },
      ],total:2,offset:0} as never;
      case "sessions_page": return {items:[],total:0,offset:0} as never;
      case "unfinished_session": return null as never;
      case "info": return { version: "test", dataDirectory: "/tmp/test" } as never;
      case "merge_banks": return "merged" as never;
      default: throw new Error(`Unexpected request: ${request.type}`);
    }
  });
  render(<App />);
  const entry = await screen.findByRole("button", { name: "合并题库" });
  await waitFor(() => expect(entry.hasAttribute("disabled")).toBe(false));
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "合并后的题库名称" })).toBeNull();
  await userEvent.click(entry);
  let dialog = await screen.findByRole("dialog");
  await userEvent.type(within(dialog).getByRole("textbox", {name:"合并后的题库名称"}), "discard");
  await userEvent.click(within(dialog).getByRole("checkbox", {name:"题库一（2 题）"}));
  await userEvent.click(within(dialog).getByRole("button", {name:"取消"}));
  await waitFor(() => expect(document.activeElement).toBe(entry));
  await userEvent.click(entry);
  dialog = await screen.findByRole("dialog");
  expect((within(dialog).getByRole("textbox", {name:"合并后的题库名称"}) as HTMLInputElement).value).toBe("");
  expect(within(dialog).getByRole("checkbox", {name:"题库一（2 题）"}).getAttribute("aria-checked")).toBe("false");
  const submit = within(dialog).getByRole("button", { name: "确认合并" });
  await userEvent.type(within(dialog).getByRole("textbox", { name: "合并后的题库名称" }), "  综合复习  ");
  await userEvent.click(within(dialog).getByRole("checkbox", { name: "题库一（2 题）" }));
  expect(submit.hasAttribute("disabled")).toBe(true);
  await userEvent.click(within(dialog).getByRole("checkbox", { name: "题库二（3 题）" }));
  expect(within(dialog).getByRole("status").textContent).toContain("共 5 题");
  expect(submit.hasAttribute("disabled")).toBe(false);
  expect(vi.mocked(api).mock.calls.some(([r]) => r.type === "merge_banks")).toBe(false);
  await userEvent.click(submit);
  await waitFor(() => expect(api).toHaveBeenCalledWith({ type: "merge_banks", bank_ids: ["one", "two"], title: "综合复习" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("guides an empty library to import without requiring AI settings", async () => {
  vi.mocked(api).mockImplementation(async r => {
    if (r.type === "banks_page") return {items:[],total:0,offset:0} as never;
    if (r.type === "unfinished_session") return null as never;
    if (r.type === "info") return {version:"test",dataDirectory:"/tmp/test"} as never;
    if (r.type === "settings") return {config:{},hasApiKey:false} as never;
    return [] as never;
  });
  vi.mocked(invoke).mockResolvedValue([]);
  render(<App/>);
  await userEvent.click(await screen.findByRole("button",{name:"导入第一份题库"}));
  expect(await screen.findByRole("button",{name:"配置 AI 模型"})).toBeTruthy();
  expect(screen.queryByRole("button",{name:"选择题库 ZIP"})).toBeNull();
  expect(screen.queryByText("导入已有题库")).toBeNull();
  expect(within(screen.getByRole("navigation", {name:"主导航"})).getByRole("button",{name:"导入题库"}).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByRole("button",{name:"上一页"})).toBeNull();
});

it("keeps model fields on a secondary settings page and refreshes the summary after saving", async () => {
  let settings = {config:{base_url:"https://example.com/v1",model_id:"",oss_url:null},hasApiKey:true};
  vi.mocked(api).mockImplementation(async r => {
    if (r.type === "banks_page") return {items:[],total:0,offset:0} as never;
    if (r.type === "unfinished_session") return null as never;
    if (r.type === "settings") return settings as never;
    if (r.type === "save_settings") { settings = {...settings,config:r.config as typeof settings.config}; return settings as never; }
    if (r.type === "info") return {version:"test",dataDirectory:"/tmp/test"} as never;
    return [] as never;
  });
  render(<App/>);
  await userEvent.click(await screen.findByRole("button",{name:"设置"}));
  expect((await screen.findByText("未配置")).getAttribute("data-slot")).toBe("badge");
  expect(screen.queryByText("用于文档解析与主观题评分")).toBeNull();
  expect(screen.queryByLabelText("Base URL")).toBeNull();
  expect(screen.getByRole("button",{name:"导出备份"})).toBeTruthy();
  await userEvent.click(screen.getByRole("button",{name:"配置"}));
  expect(await screen.findByRole("heading",{name:"AI 模型",level:1})).toBeTruthy();
  expect(screen.queryByRole("button",{name:"导出备份"})).toBeNull();
  expect(screen.getByRole("button",{name:"设置"}).getAttribute("aria-current")).toBe("page");
  const model = await screen.findByLabelText("模型 ID");
  await waitFor(() => expect(model.closest("fieldset")?.disabled).toBe(false));
  await userEvent.clear(model);
  await userEvent.type(model,"new-model");
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"save_settings"})));
  await userEvent.click(screen.getByRole("button",{name:"返回设置"}));
  expect((await screen.findByText("已配置")).getAttribute("data-slot")).toBe("badge");
});

it("autosaves model setup and returns to the original import destination", async () => {
  let settings = {config:{base_url:"https://example.com/v1",model_id:null as string|null,oss_url:null},hasApiKey:true};
  vi.mocked(api).mockImplementation(async r => {
    if (r.type === "banks_page") return {items:[{id:"bank",title:"追加目标",count:0,description:""}],total:1,offset:0} as never;
    if (r.type === "unfinished_session") return null as never;
    if (r.type === "banks") return [{id:"bank",title:"追加目标",count:0,description:""}] as never;
    if (r.type === "info") return {version:"test",dataDirectory:"/tmp/test"} as never;
    if (r.type === "settings") return settings as never;
    if (r.type === "save_settings") { settings = {...settings,config:r.config as typeof settings.config}; return settings as never; }
    if (r.type === "pick_import") return {ticket:"t",title:"文件",count:1,reviewCount:0,assetCount:0,missingAssets:[],warnings:[],status:"SUCCEEDED"} as never;
    return [] as never;
  });
  vi.mocked(invoke).mockImplementation(async (_c,args) => ((args as {request:{type:string}}).request.type === "list" ? {items:[],hasMore:false} : []) as never);
  render(<App/>);
  const entry = await screen.findByRole("button",{name:"导入题目"});
  await waitFor(() => expect(entry.hasAttribute("disabled")).toBe(false));
  await userEvent.click(entry);
  await userEvent.click(await screen.findByRole("button",{name:"配置 AI 模型"}));
  const vision = await screen.findByLabelText("模型 ID");
  await waitFor(() => expect(vision.closest("fieldset")?.disabled).toBe(false));
  await userEvent.type(vision,"vision");
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"save_settings"})));
  await waitFor(() => expect(screen.getByRole("button",{name:"返回导入"}).hasAttribute("disabled")).toBe(false));
  await userEvent.click(screen.getByRole("button",{name:"返回导入"}));
  expect(await screen.findByRole("heading",{name:"导入题库",level:1})).toBeTruthy();
  expect(await screen.findByRole("button",{name:"选择文档…"})).toBeTruthy();
  await userEvent.click(await screen.findByRole("button",{name:"设置"}));
  await userEvent.click(await screen.findByRole("button",{name:"恢复备份"}));
  await userEvent.click(await screen.findByRole("menuitem",{name:"导入题库 ZIP"}));
  expect(within(await screen.findByRole("dialog")).getByRole("combobox").textContent).toContain("新建题库");
  expect(vi.mocked(invoke).mock.calls.some(([,a]) => (a as {request:{type:string}}).request.type === "pick_document")).toBe(false);
});

it("continues the existing session from home without creating another paper", async () => {
  const session = {id:"existing",title:"旧练习",createdAt:1,finishedAt:null,position:0,mode:"ordered",attempts:[{ordinal:0,snapshot:{question:{stem:"题目",answerMode:"short_answer",options:[],items:[],answerPayload:null,contentBlocks:[],needsReview:false,missingFields:[]},groups:[],visuals:[],sources:[],warnings:[],missingAssets:false},answer:null,result:null,autoResult:null,gradeKind:"ungraded",submittedAt:null,skipped:false,elapsedMs:0}]};
  vi.mocked(api).mockImplementation(async r => {
    if (r.type === "banks_page") return {items:[],total:0,offset:0} as never;
    if(r.type === "unfinished_session") return {...session,count:1,answered:0} as never;
    if(r.type === "info") return {version:"test",dataDirectory:"/tmp/test"} as never;
    if(r.type === "session") return session as never;
    return [] as never;
  });
  render(<App/>);
  const button = await screen.findByRole("button",{name:"继续练习"});
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  await userEvent.click(button);
  expect(await screen.findByRole("textbox",{name:"作答内容"})).toBeTruthy();
  expect(api).toHaveBeenCalledWith({type:"session",id:"existing"});
  expect(vi.mocked(api).mock.calls.some(([r]) => r.type === "start_paper")).toBe(false);
});

it("handles ZIP picker cancellation and package/export errors without importing", async () => {
  const notified=vi.spyOn(toast,"error");
  let failImport=false;
  vi.mocked(invoke).mockResolvedValue([]);
  vi.mocked(api).mockImplementation(async request=>{
    switch(request.type){
      case "banks": return [{id:"bank",title:"Shared",description:"",count:1}] as never;
      case "banks_page": return {items:[{id:"bank",title:"Shared",description:"",count:1}],total:1,offset:0} as never;
      case "sessions_page": return {items:[],total:0,offset:0} as never;
      case "unfinished_session": return null as never;
      case "info": return {version:"test",dataDirectory:"/tmp/test"} as never;
      case "settings": return {config:{},hasApiKey:false} as never;
      case "pick_import": if(failImport)throw new Error("ZIP read failed"); return null as never;
      case "export_bank": throw new Error("Missing image");
      default: throw new Error(request.type);
    }
  });
  render(<App/>);
  const operations=await screen.findByRole("button",{name:"题库操作 Shared"});
  await waitFor(()=>expect(operations.hasAttribute("disabled")).toBe(false));
  operations.focus(); await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("menuitem",{name:"导出题库 ZIP"}));
  await waitFor(()=>expect(notified).toHaveBeenCalledWith(expect.objectContaining({message:"Missing image"})));
  expect(api).toHaveBeenCalledWith({type:"export_bank",bank_id:"bank"});
  await userEvent.click(screen.getByRole("button",{name:"导入题库"}));
  await userEvent.click(screen.getByRole("button",{name:"设置"}));
  const picker=await screen.findByRole("button",{name:"恢复备份"});
  await userEvent.click(picker);
  await userEvent.click(await screen.findByRole("menuitem",{name:"导入题库 ZIP"}));
  await waitFor(()=>expect(api).toHaveBeenCalledWith({type:"pick_import"}));
  expect(screen.queryByRole("dialog")).toBeNull();
  failImport=true;
  await waitFor(()=>expect(picker.hasAttribute("disabled")).toBe(false));
  await userEvent.click(picker);
  await userEvent.click(await screen.findByRole("menuitem",{name:"导入题库 ZIP"}));
  await waitFor(()=>expect(notified).toHaveBeenCalledWith(expect.objectContaining({message:"ZIP read failed"})));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(vi.mocked(api).mock.calls.some(([r])=>r.type==="import")).toBe(false);
  notified.mockRestore();
});

it("keeps a confirmed document import in the task list and opens its bank only on request", async () => {
  let imported = false;
  vi.mocked(api).mockImplementation(async r => {
    if (r.type === "banks") return imported ? [{id:"bank", title:"Parsed", description:"", count:2}] as never : [] as never;
    if (r.type === "banks_page") return {items:[], total:0, offset:0} as never;
    if (r.type === "unfinished_session") return null as never;
    if (r.type === "info") return {version:"test", dataDirectory:"/tmp/test"} as never;
    if (r.type === "settings") return {config:{base_url:"https://example.com", model_id:"model"}, hasApiKey:true} as never;
    if (r.type === "import") {imported = true; return {bankId:"bank", count:2, duplicate:false} as never;}
    if (r.type === "questions_page") return {items:[], total:0, offset:0} as never;
    throw Error(r.type);
  });
  vi.mocked(invoke).mockImplementation(async (_command,args) => {
    const r = (args as {request:{type:string}}).request;
    if (r.type === "list") return {items:[{threadId:"task", fileName:"source.txt", state:"COMPLETED", checkpointId:"cp", createdAt:"2026-09-24T00:00:00Z", questionCount:2, reviewCount:0, importedBankId:imported ? "bank" : null}], hasMore:false} as never;
    if (r.type === "get") return {threadId:"task", state:"COMPLETED", checkpointId:"cp", phase:"completed", progress:{}, allowedActions:[], blocking:[], failures:[], usage:[], unknownUsageCalls:[]} as never;
    if (r.type === "preview") return {ticket:"ticket",title:"Parsed",count:2,reviewCount:0,assetCount:0,missingAssets:[],warnings:[],status:"SUCCEEDED"} as never;
    return [] as never;
  });
  render(<App/>);
  await userEvent.click(await screen.findByRole("button", {name:"导入题库"}));
  const tasks = await screen.findByRole("region", {name:"导入任务"});
  expect(screen.getByText("从文档创建题库").closest('[data-slot="card"]')?.contains(tasks)).toBe(false);
  await userEvent.click(await screen.findByRole("button", {name:"source.txt"}));
  await userEvent.click(await screen.findByRole("button", {name:"预览并导入题库"}));
  await userEvent.click(within(await screen.findByRole("dialog", {name:"导入题库"})).getByRole("button", {name:"确认导入"}));
  await waitFor(() => expect(screen.queryByRole("dialog", {name:"导入题库"})).toBeNull());
  expect(screen.getByRole("dialog", {name:"source.txt"})).toBeTruthy();
  expect(screen.getByRole("heading", {name:"已导入"})).toBeTruthy();
  expect(vi.mocked(api).mock.calls.filter(([r]) => r.type === "import")).toHaveLength(1);
  expect(vi.mocked(api).mock.calls.some(([r]) => r.type === "questions_page")).toBe(false);
  await userEvent.click(screen.getByRole("button", {name:"查看题库"}));
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"questions_page",bank_id:"bank"})));
});


it("reports a failed local import and blocks duplicate submission until retry", async () => {
  let rejectImport: (error: Error) => void = () => {};
  const errors: unknown[] = [];
  const onState = vi.fn(), onImported = vi.fn(), onClose = vi.fn();
  vi.mocked(api).mockImplementation(() => new Promise((_resolve, reject) => {rejectImport = reject;}) as never);
  render(<ImportBankDialog preview={{processing:null,ticket:"ticket",title:"Parsed",count:1,reviewCount:0,assetCount:0,missingAssets:[],warnings:[],status:"SUCCEEDED"}} banks={[]} initialBank="new" busy={false} run={job => {void job().catch(error => errors.push(error));}} onClose={onClose} onImported={onImported} onState={onState}/>);
  const submit = screen.getByRole("button",{name:"确认导入"});
  await act(async () => {fireEvent.click(submit); fireEvent.click(submit);});
  expect(api).toHaveBeenCalledTimes(1);
  expect(onState).toHaveBeenCalledWith("importing");
  const failure = new Error("disk full");
  await act(async () => {rejectImport(failure);});
  expect(onState).toHaveBeenLastCalledWith("failed", failure);
  expect(onClose).not.toHaveBeenCalled();
  expect(onImported).not.toHaveBeenCalled();
  expect(errors).toEqual([failure]);
  vi.mocked(api).mockResolvedValue({bankId:"bank",count:1,duplicate:false} as never);
  await act(async () => {fireEvent.click(submit);});
  expect(api).toHaveBeenCalledTimes(2);
  expect(onImported).toHaveBeenCalledWith("bank");
});
