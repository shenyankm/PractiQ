// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { AiTasks } from "./AiTasks";
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it.each([false, true])("hides the empty task section with modelsReady=%s", async modelsReady => {
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const { type } = (args as { request: { type: string } }).request;
    if (type === "list") return { items: [], hasMore: false };
    if (type === "batches") return { items: [], total: 0, offset: 0, operations: [] };
    return [];
  });
  await act(async () => {
    render(<AiTasks busy={false} run={job => {void job();}} onPreview={() => {}} modelsReady={modelsReady}/>);
  });
  expect(screen.queryByRole("region", {name: "导入任务"})).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
});

it("shows progress and sends only the current run when pausing", async () => {
  const state = {
    threadId: "task",
    runId: "run",
    checkpointId: "checkpoint",
    state: "RUNNING",
    phase: "prepare",
    allowedActions: ["pause"],
    blocking: [],
    failures: [],
    progress: { visuals: { total: 2, succeeded: 1, failed: 0 } },
    usage: [],
    unknownUsageCalls: ["unknown"],
  };
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const request = (args as { request: { type: string } }).request;
    return (
      request.type === "batches" ? {items:[],total:0,offset:0,operations:[]} : request.type === "operations"
        ? []
        : request.type === "list"
          ? {
              items: [
                { threadId: "task", fileName: "demo.pdf", expiresAt: "" },
              ],
              hasMore: false,
            }
          : state
    ) as never;
  });
  render(
    <AiTasks
      busy={false}
      run={(job) => {
        void job();
      }}
      onPreview={() => {}}
    />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "demo.pdf" }),
  );
  const localReads = () => vi.mocked(invoke).mock.calls.filter(([,args]) => (args as {request:{type:string}}).request.type === "operations").length;
  const beforeControl = localReads();
  await userEvent.click(await screen.findByRole("button", { name: "暂停" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("ai_request", {
      locale: "zh-CN",
      request: {
        type: "control",
        id: "task",
        action: "pause",
        run_id: "run",
        checkpoint_id: null,
        units: [],
      },
    }),
  );
  expect(screen.getByText(/完成 1\/2/)).toBeTruthy();
  await waitFor(() => expect(localReads()).toBe(beforeControl + 1));
});
it.each([new Error("请先配置模型 ID"), { message: "请先配置模型 ID" }])("preserves task errors and hides the empty section after successful retry (%j)", async error => {
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const { type } = (args as { request: { type: string } }).request;
    if (type === "batches") return {items:[],total:0,offset:0,operations:[]} as never;
    if (type === "list") throw error;
    return [] as never;
  });
  render(
    <AiTasks
      busy={false}
      run={(job) => {
        void job();
      }}
      onPreview={() => {}}
    />,
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText(/请先配置模型 ID/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  expect(toast.error).not.toHaveBeenCalled();
  expect(screen.queryByText("暂无解析任务")).toBeNull();
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const { type } = (args as { request: { type: string } }).request;
    return (type === "list" ? { items: [], hasMore: false } : type === "batches" ? {items:[],total:0,offset:0,operations:[]} : []) as never;
  });
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(screen.queryByRole("region", {name: "导入任务"})).toBeNull());
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(vi.mocked(invoke).mock.calls.every(([, args]) => ["list", "operations", "batches"].includes((args as { request: { type: string } }).request.type))).toBe(true);
});
it("requires content review before acceptance and excludes waiting tasks from batch selection", async () => {
  URL.createObjectURL = vi.fn(() => "blob:review-image");
  URL.revokeObjectURL = vi.fn();
  const state = {
    threadId: "task",
    runId: null,
    checkpointId: "cp",
    state: "WAITING_REVIEW",
    phase: "review",
    allowedActions: ["accept_partial"],
    blocking: [],
    failures: [],
    progress: {},
    usage: [],
    unknownUsageCalls: [],
  };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "read_review_image") return new ArrayBuffer(4) as never;
    const r = (args as { request: { type: string } }).request;
    if (r.type === "list")
      return {
        items: [
          {
            threadId: "task",
            fileName: "review.pdf",
            state: "WAITING_REVIEW",
            questionCount: 1,
            reviewCount: 1,
          },
        ],
        hasMore: false,
      } as never;
    if (r.type === "batches") return {items:[],total:0,offset:0,operations:[]} as never;
    if (r.type === "operations") return [] as never;
    if (r.type === "review")
      return {
        threadId: "task",
        checkpointId: "cp",
        phase: "review",
        units: [
          {
            stage: "document_parse",
            index: 0,
            questions: [
              {
                stem: "保存的候选题目",
                options: [],
                answerPayload: null,
                needsReview: true,
                missingFields: ["answerPayload"],
              },
            ],
            groups: [{ title: "材料", instructions: "已保存的材料正文" }],
            sourceRef: { mediaType: "image/png" },
            visualElements: [],
          },
        ],
        failures: [
          { stage: "document_parse", index: 1, code: "AI_PROVIDER_AUTH_ERROR" },
        ],
        quality: {},
        questionSources: [],
      } as never;
    return state as never;
  });
  const { unmount } = render(
    <AiTasks
      busy={false}
      run={(job) => {
        void job();
      }}
      onPreview={() => {}}
    />,
  );
  expect(
    (await screen.findByRole("checkbox", { name: "选择 review.pdf" }))
      .hasAttribute("disabled"),
  ).toBe(true);
  await userEvent.click(
    await screen.findByRole("button", { name: "review.pdf" }),
  );
  expect(screen.queryByRole("button", { name: "接受部分结果" })).toBeNull();
  await userEvent.click(
    await screen.findByRole("button", { name: "查看内容与审核" }),
  );
  expect(await screen.findByText("保存的候选题目")).toBeTruthy();
  expect(screen.getByText("已保存的材料正文")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "查看来源内容" }));
  expect(await screen.findByRole("img", { name: "查看来源内容" })).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("read_review_image", { id: "task", checkpointId: "cp", unit: 0, visual: null });
  expect(screen.getByText(/#2：模型鉴权失败/)).toBeTruthy();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(
        ([command, a]) =>
          command === "ai_request" && (a as { request: { type: string } }).request.type === "control",
      ),
  ).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "接受部分结果" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("ai_request", {
      locale: "zh-CN",
      request: {
        type: "control",
        id: "task",
        action: "accept_partial",
        run_id: null,
        checkpoint_id: "cp",
        units: [],
      },
    }),
  );
  unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:review-image");
});
it("edits separate bank names and can cancel a running batch without waiting for it", async () => {
  const batch = {
    id: "batch",
    status: "ready",
    items: [
      {
        threadId: "task",
        title: "quiz",
        questionCount: 3,
        reviewCount: 1,
        partial: true,
        previousVersion: true,
        status: "pending",
        bankId: null,
        error: null,
      },
    ],
  };
  let finish: ((value: unknown) => void) | undefined;
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const r = (args as { request: { type: string } }).request;
    if (r.type === "list")
      return {
        items: [
          {
            threadId: "task",
            fileName: "quiz.pdf",
            state: "COMPLETED",
            questionCount: 3,
            reviewCount: 1,
            status: "PARTIAL",
          },
        ],
        hasMore: false,
      } as never;
    if (r.type === "operations") return [] as never;
    if (r.type === "batches")
      return {items:finish ? [{ ...batch, status: "running" }] : [], total:0,offset:0,operations:[]} as never;
    if (r.type === "prepare_batch") return batch as never;
    if (r.type === "run_batch")
      return new Promise((resolve) => {
        finish = resolve;
      }) as never;
    return batch as never;
  });
  render(
    <AiTasks
      busy={false}
      run={(job) => {
        void job();
      }}
      onPreview={() => {}}
    />,
  );
  await userEvent.click(
    await screen.findByRole("checkbox", { name: "选择 quiz.pdf" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "批量导入已选任务（1）" }),
  );
  const title = await screen.findByRole("textbox", { name: "题库名称 1" });
  await userEvent.clear(title);
  await userEvent.type(title, "独立题库");
  await userEvent.click(screen.getByRole("button", { name: "确认逐项导入" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("ai_request", {
      locale: "zh-CN",
      request: { type: "run_batch", id: "batch", titles: ["独立题库"] },
    }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "停止后续导入" }),
  );
  expect(invoke).toHaveBeenCalledWith("ai_request", {
      locale: "zh-CN",
    request: { type: "cancel_batch", id: "batch" },
  });
  finish?.({ ...batch, status: "paused" });
});

it("prepares only eligible selected tasks and clears selection across pages", async () => {
  let imported=false;
  vi.mocked(invoke).mockImplementation(async (_command,args) => {
    const request=(args as {request:{type:string;offset?:number}}).request;
    if(request.type==="list")return {items:request.offset ? [{threadId:"third",fileName:"third.pdf",state:"COMPLETED",checkpointId:"cp3"}] : [
      {threadId:"first",fileName:"first.pdf",state:"COMPLETED",checkpointId:"cp1",importedBankId:imported ? "bank" : null},
      {threadId:"second",fileName:"second.pdf",state:"COMPLETED",checkpointId:"cp2"},
    ],hasMore:!request.offset} as never;
    if(request.type==="batches")return {items:[],total:0,offset:0,operations:[]} as never;
    if(request.type==="operations")return [] as never;
    if(request.type==="prepare_batch")return {id:"batch",status:"ready",items:[]} as never;
    return null as never;
  });
  render(<AiTasks busy={false} run={job=>{void job();}} onPreview={()=>{}}/>);
  await userEvent.click(await screen.findByRole("checkbox",{name:"选择 first.pdf"}));
  await userEvent.click(screen.getByRole("checkbox",{name:"选择 second.pdf"}));
  expect(screen.getByRole("button",{name:"批量导入已选任务（2）"})).toBeTruthy();
  imported=true;
  await userEvent.click(screen.getByRole("button",{name:"刷新任务"}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"批量导入已选任务（1）"})).toBeTruthy());
  await userEvent.click(screen.getByRole("button",{name:"下一页"}));
  await screen.findByRole("checkbox",{name:"选择 third.pdf"});
  expect(screen.queryByRole("button",{name:/批量导入已选任务/})).toBeNull();
  await userEvent.click(screen.getByRole("checkbox",{name:"选择 third.pdf"}));
  await userEvent.click(screen.getByRole("button",{name:"批量导入已选任务（1）"}));
  expect(invoke).toHaveBeenCalledWith("ai_request",{locale:"zh-CN",request:{type:"prepare_batch",ids:["third"]}});
});
it("replays a pending request by its persisted ID only after explicit action", async () => {
  let pending = true;
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const r = (args as { request: { type: string } }).request;
    if (r.type === "list") return { items: [], hasMore: false } as never;
    if (r.type === "operations")
      return (
        pending
          ? [{ id: "stable-id", label: "quiz", error: { message: "响应丢失" } }]
          : []
      ) as never;
    if (r.type === "batches") return {items:[],total:0,offset:0,operations:[]} as never;
    if (r.type === "replay") {
      pending = false;
      return { accepted: true } as never;
    }
    return [] as never;
  });
  render(
    <AiTasks
      busy={false}
      run={(job) => {
        void job();
      }}
      onPreview={() => {}}
    />,
  );
  const retry = await screen.findByRole("button", { name: "重试待确认操作" });
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(
        ([, a]) =>
          (a as { request: { type: string } }).request.type === "replay",
      ),
  ).toBe(false);
  await userEvent.click(retry);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("ai_request", {
      locale: "zh-CN",
      request: { type: "replay", request_id: "stable-id" },
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "重试待确认操作" })).toBeNull(),
  );
});
it("stops polling a completed task", async () => {
  const timers = vi.spyOn(globalThis, "setTimeout");
  const state = {
    threadId: "task",
    runId: null,
    checkpointId: "cp",
    state: "COMPLETED",
    phase: "completed",
    allowedActions: [],
    blocking: [],
    failures: [],
    progress: {},
    usage: [],
    unknownUsageCalls: [],
  };
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const r = (args as { request: { type: string } }).request;
    if (r.type === "list")
      return {
        items: [{ threadId: "task", fileName: "done.pdf", state: "COMPLETED" }],
        hasMore: false,
      } as never;
    if (r.type === "get") return state as never;
    return (r.type === "batches" ? {items:[],total:0,offset:0,operations:[]} : []) as never;
  });
  render(
    <AiTasks
      busy={false}
      run={(job) => {
        void job();
      }}
      onPreview={() => {}}
    />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "done.pdf" }),
  );
  await screen.findByRole("button", { name: "预览并导入题库" });
  expect(timers.mock.calls.some(([, delay]) => delay === 2000)).toBe(false);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(
        ([, a]) => (a as { request: { type: string } }).request.type === "get",
      ),
  ).toHaveLength(1);
  timers.mockRestore();
});
it("retries task polling after a transient read failure",async()=>{
  let gets=0;
  vi.mocked(invoke).mockImplementation(async(_command,args)=>{
    const r=(args as {request:{type:string}}).request;
    if(r.type==="list") return {items:[{threadId:"task",fileName:"retry.pdf",expiresAt:""}],hasMore:false} as never;
    if(r.type==="get") {
      if(++gets===1) throw new Error("transient read");
      return {threadId:"task",state:"COMPLETED",phase:"completed",progress:{},allowedActions:[],blocking:[],failures:[],usage:[],unknownUsageCalls:[]} as never;
    }
    return (r.type === "batches" ? {items:[],total:0,offset:0,operations:[]} : []) as never;
  });
  render(<AiTasks busy={false} run={job=>{void job();}} onPreview={()=>{}}/>);
  await userEvent.click(await screen.findByRole("button",{name:"retry.pdf"}));
  await waitFor(()=>expect(gets).toBe(2),{timeout:4000});
  expect(screen.queryByText(/transient read/)).toBeNull();
});

it.each([
  [{code: "TASK_NOT_FOUND", httpStatus: 404}, 1],
  [{code: "TASK_EXPIRED", httpStatus: 410}, 1],
  [{httpStatus: 401}, 1],
  [{httpStatus: 422}, 1],
  [{httpStatus: 503}, 4],
  [new Error("offline"), 4],
])("bounds failed task reads and refreshes membership: %j", async (failure, expectedGets) => {
  vi.useFakeTimers();
  let gets = 0, lists = 0;
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const r = (args as {request: {type: string}}).request;
    if (r.type === "list") {
      lists++;
      return {items: gets ? [] : [{threadId: "task", fileName: "gone.pdf", expiresAt: ""}], hasMore: false} as never;
    }
    if (r.type === "get") { gets++; throw failure; }
    return (r.type === "batches" ? {items:[],total:0,offset:0,operations:[]} : []) as never;
  });
  await act(async () => { render(<AiTasks busy={false} run={job => {void job();}} onPreview={() => {}}/>); });
  await act(async () => { fireEvent.click(screen.getByRole("button", {name: "gone.pdf"})); });
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(gets).toBe(expectedGets);
  expect(lists).toBe(2);
  expect(screen.queryByRole("button", {name: "gone.pdf"})).toBeNull();
  expect(vi.mocked(invoke).mock.calls.every(([, args]) =>
    ["list", "get", "operations", "batches"].includes((args as {request: {type: string}}).request.type),
  )).toBe(true);
});

it.each(["COMPLETED", "WAITING_REVIEW"])("retains %s controls when membership refresh fails", async state => {
  vi.useFakeTimers();
  let lists = 0, gets = 0;
  const preview = {ticket: "retained"};
  const onPreview = vi.fn();
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const {type} = (args as {request: {type: string}}).request;
    if (type === "list") {
      if (++lists > 1) throw {httpStatus: 503, message: "membership unavailable"};
      return {items: [{threadId: "task", fileName: "ready.pdf", expiresAt: ""}], hasMore: false} as never;
    }
    if (type === "get") {
      gets++;
      return {threadId: "task", state, phase: "completed", progress: {}, allowedActions: [], blocking: [], failures: [{stage: "text", index: 0, code: "TEST_FAILURE", message: "retained detail", retryable: false}], usage: [], unknownUsageCalls: []} as never;
    }
    if (type === "review") return {threadId: "task", checkpointId: "cp", phase: "completed", units: [], failures: [], quality: {}, questionSources: []} as never;
    if (type === "preview") return preview as never;
    return (type === "batches" ? {items:[],total:0,offset:0,operations:[]} : []) as never;
  });
  await act(async () => { render(<AiTasks busy={false} run={job => {void job();}} onPreview={onPreview}/>); });
  await act(async () => { fireEvent.click(screen.getByRole("button", {name: "ready.pdf"})); });
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(gets).toBe(1);
  expect(lists).toBe(5);
  expect(screen.getByText(/membership unavailable/)).toBeTruthy();
  expect(screen.getByText(/retained detail/)).toBeTruthy();
  if (state === "COMPLETED") {
    await act(async () => { fireEvent.click(screen.getByRole("button", {name: "预览并导入题库"})); });
    expect(onPreview).toHaveBeenCalledWith(preview, expect.objectContaining({threadId: "task"}));
  }
  await act(async () => { fireEvent.click(screen.getByRole("button", {name: "查看内容与审核"})); });
  expect(screen.getByRole("dialog", {name: "只读内容审核"})).toBeTruthy();
});

it("polls unselected tasks, renders a separate table and restores focus after closing details", async () => {
  vi.useFakeTimers();
  let state = "RUNNING";
  let gets = 0;
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const r = (args as {request: {type: string}}).request;
    if (r.type === "list") return {items: [{threadId: "task", fileName: "live.pdf", state, checkpointId: "cp", createdAt: "2026-09-24T00:00:00Z", status: "PARTIAL", questionCount: 2, reviewCount: 1, previouslyImported: true}], hasMore: false} as never;
    if (r.type === "get") { gets++; return {threadId: "task", state, checkpointId: "cp", phase: "completed", progress: {}, allowedActions: [], blocking: [], failures: [], usage: [], unknownUsageCalls: []} as never; }
    return (r.type === "batches" ? {items:[],total:0,offset:0,operations:[]} : []) as never;
  });
  await act(async () => {render(<AiTasks busy={false} run={job => {void job();}} onPreview={() => {}}/>);});
  expect(screen.getByRole("table")).toBeTruthy();
  expect(screen.getByText("解析中")).toBeTruthy();
  state = "COMPLETED";
  await act(async () => {await vi.advanceTimersByTimeAsync(2000);});
  expect(screen.getByText("待导入")).toBeTruthy();
  expect(screen.getByText("部分结果")).toBeTruthy();
  expect(screen.getByText("曾导入其他版本")).toBeTruthy();
  expect(gets).toBe(0);
  expect(screen.queryByRole("button", {name: "下一页"})).toBeNull();
  const entry = screen.getByRole("button", {name: "live.pdf"});
  entry.focus();
  await act(async () => {fireEvent.click(entry);});
  expect(screen.getByRole("dialog", {name: "live.pdf"})).toBeTruthy();
  expect(gets).toBe(1);
  await act(async () => {fireEvent.click(screen.getByRole("button", {name: "关闭"}));});
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => {await vi.advanceTimersByTimeAsync(100);});
  expect(document.activeElement).toBe(entry);
});

it("keeps expired imported tasks readable without fetching expired results", async () => {
  const openBank = vi.fn();
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const r = (args as {request: {type: string}}).request;
    if (r.type === "list") return {items: [{threadId: "old", fileName: "old.pdf", state: "EXPIRED", importedBankId: "bank"}], hasMore: false} as never;
    if (r.type === "get") throw Error("must not fetch an expired result");
    return (r.type === "batches" ? {items:[],total:0,offset:0,operations:[]} : []) as never;
  });
  render(<AiTasks busy={false} run={job => {void job();}} onPreview={() => {}} onOpenBank={openBank}/>);
  await userEvent.click(await screen.findByRole("button", {name: "old.pdf"}));
  expect(screen.getByText("任务已过期，请重新选择文档。已有题库不受影响。")).toBeTruthy();
  expect(screen.queryByRole("button", {name: "预览并导入题库"})).toBeNull();
  await userEvent.click(screen.getByRole("button", {name: "查看题库"}));
  expect(openBank).toHaveBeenCalledWith("bank");
});

it("discards an old page poll and a closed drawer's delayed detail", async () => {
  vi.useFakeTimers();
  let resolveList: (value: unknown) => void = () => {};
  let resolveDetail: (value: unknown) => void = () => {};
  let firstPageReads = 0;
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const r = (args as {request: {type: string; offset?: number}}).request;
    if (r.type === "list") {
      if (r.offset === 20) return {items:[{threadId:"new",fileName:"new.pdf",state:"COMPLETED"}],hasMore:false} as never;
      if (++firstPageReads === 1) return {items:[{threadId:"old",fileName:"old.pdf",state:"RUNNING"}],hasMore:true} as never;
      return new Promise(resolve => {resolveList=resolve;}) as never;
    }
    if (r.type === "get") return new Promise(resolve => {resolveDetail=resolve;}) as never;
    return (r.type === "batches" ? {items:[],total:0,offset:0,operations:[]} : []) as never;
  });
  await act(async () => {render(<AiTasks busy={false} run={job => {void job();}} onPreview={() => {}}/>);});
  await act(async () => {await vi.advanceTimersByTimeAsync(2000);});
  await act(async () => {fireEvent.click(screen.getByRole("button", {name:"下一页"}));});
  await act(async () => {resolveList({items:[{threadId:"stale",fileName:"STALE.pdf",state:"RUNNING"}],hasMore:true});});
  expect(screen.queryByText("STALE.pdf")).toBeNull();
  expect(screen.getByRole("button",{name:"new.pdf"})).toBeTruthy();
  await act(async () => {fireEvent.click(screen.getByRole("button",{name:"new.pdf"}));});
  await act(async () => {fireEvent.click(screen.getByRole("button",{name:"关闭"}));});
  await act(async () => {resolveDetail({threadId:"new",state:"RUNNING",phase:"prepare",progress:{},allowedActions:["pause"],blocking:[],failures:[],usage:[],unknownUsageCalls:[]});});
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button",{name:"暂停"})).toBeNull();
});


it("pages local batch history independently while keeping task import errors", async () => {
  vi.mocked(invoke).mockImplementation(async (_command,args) => {
    const r=(args as {request:{type:string;offset?:number;thread_ids?:string[]}}).request;
    if(r.type==="list") return {items:[{threadId:"task",fileName:"ready.pdf",state:"COMPLETED",checkpointId:"cp"}],hasMore:false} as never;
    if(r.type==="batches") return {items:[{id:`batch-${r.offset}`,status:"paused",items:[{threadId:"task",title:`History ${r.offset}`,status:"failed",error:null}]}],total:21,offset:r.offset,operations:[{threadId:"task",checkpointId:"cp",state:"failed"}]} as never;
    return [] as never;
  });
  render(<AiTasks busy={false} run={job=>{void job();}} onPreview={()=>{}}/>);
  const history=await screen.findByRole("region",{name:"导入批次"});
  await userEvent.click(within(history).getByRole("button",{name:"下一页"}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith("ai_request",{locale:"zh-CN",request:{type:"batches",offset:20,thread_ids:["task"]}}));
  expect(await screen.findByText(/History 20/)).toBeTruthy();
  expect(screen.getByText("导入失败")).toBeTruthy();
  expect(within(history).getByRole("button",{name:"下一页"}).hasAttribute("disabled")).toBe(true);
});
