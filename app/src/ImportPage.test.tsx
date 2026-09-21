// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));
vi.mock("./api", async () => ({
  ...(await vi.importActual<typeof import("./api")>("./api")),
  api: vi.fn(),
}));
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("keeps JSON import usable without models and preserves the destination bank", async () => {
  vi.mocked(invoke).mockResolvedValue([]);
  vi.mocked(api).mockImplementation(async (request) => {
    switch (request.type) {
      case "banks":
        return [
          { id: "bank-1", title: "现有题库", description: "", count: 0 },
        ] as never;
      case "sessions":
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
    within(screen.getByRole("navigation")).getByRole("button", {
      name: "导入题库",
    }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "文档解析" })).toBeNull();
  expect(screen.getByText(/暂不支持 Word 文件/).textContent).toContain("导出为 PDF");
  expect(screen.getByText(/支持 PDF/).textContent).toContain(".jpeg");
  expect(screen.getByText(/支持 PDF/).textContent).not.toMatch(/\.gif|\.webp/);
  expect(await screen.findByRole("button", { name: "配置 AI 模型" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "选择文档…" })).toBeNull();
  expect(screen.queryByRole("button", { name: "刷新任务" })).toBeNull();
  expect(vi.mocked(invoke).mock.calls.some(([,args]) => (args as {request:{type:string}}).request.type === "list")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "选择题库 JSON" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("combobox", { name: "导入到" }).textContent).toContain(
    "现有题库",
  );
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
      case "sessions":
      case "questions": return [] as never;
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
  expect(within(screen.getByRole("navigation")).getByRole("button", { name: "导入题库" })).toBeTruthy();
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
    await waitFor(() => expect(api).toHaveBeenCalledWith({ type: "questions", bank_id: null, bank_ids: [banks[index].id], search: "", mode: "", filter: "" }));
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
      case "sessions": return [] as never;
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
  const dialog = await screen.findByRole("dialog");
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
    if (r.type === "info") return {version:"test",dataDirectory:"/tmp/test"} as never;
    if (r.type === "settings") return {config:{},hasApiKey:false} as never;
    return [] as never;
  });
  vi.mocked(invoke).mockResolvedValue([]);
  render(<App/>);
  await userEvent.click(await screen.findByRole("button",{name:"导入第一份题库"}));
  expect(await screen.findByRole("button",{name:"配置 AI 模型"})).toBeTruthy();
  expect(screen.getByRole("button",{name:"选择题库 JSON"}).hasAttribute("disabled")).toBe(false);
  expect(within(screen.getByRole("navigation")).getByRole("button",{name:"导入题库"}).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByRole("button",{name:"上一页"})).toBeNull();
});

it("returns from model setup to the original import destination after saving", async () => {
  let settings = {config:{base_url:"https://example.com/v1",model_id:null as string|null,oss_url:null},hasApiKey:true};
  vi.mocked(api).mockImplementation(async r => {
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
  await userEvent.click(screen.getByRole("button",{name:"保存并返回导入"}));
  expect(await screen.findByRole("heading",{name:"导入题库",level:1})).toBeTruthy();
  expect(await screen.findByRole("button",{name:"选择文档…"})).toBeTruthy();
  await userEvent.click(screen.getByRole("button",{name:"选择题库 JSON"}));
  expect(within(await screen.findByRole("dialog")).getByRole("combobox").textContent).toContain("追加目标");
  expect(vi.mocked(invoke).mock.calls.some(([,a]) => (a as {request:{type:string}}).request.type === "pick_document")).toBe(false);
});

it("continues the existing session from home without creating another paper", async () => {
  const session = {id:"existing",title:"旧练习",createdAt:1,finishedAt:null,position:0,mode:"ordered",attempts:[{ordinal:0,snapshot:{question:{stem:"题目",answerMode:"short_answer",options:[],items:[],answerPayload:null,contentBlocks:[],needsReview:false,missingFields:[]},groups:[],visuals:[],sources:[],warnings:[],missingAssets:false},answer:null,result:null,autoResult:null,gradeKind:"ungraded",submittedAt:null,skipped:false,elapsedMs:0}]};
  vi.mocked(api).mockImplementation(async r => {
    if(r.type === "sessions") return [{...session,count:1,answered:0}] as never;
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
