// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnswerInput } from "./AnswerInput";
import { Markdown } from "./Content";
import { canInteract, answerReady, type Question, type Session } from "./api";
import { Practice } from "./Practice";
import { ExamResults } from "./ExamResults";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({invoke:vi.fn()}));
import fixture from "../fixtures/sample.json";
import { api } from "./api";
vi.mock("./api", async () => {
  const original = await vi.importActual<typeof import("./api")>("./api");
  return { ...original, api: vi.fn() };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const questions = fixture.questions as unknown as Question[];
it("renders untrusted markdown without HTML, remote images or executable links", () => {
  const { container } = render(
    <Markdown>
      {
        '<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n![remote](https://example.com/track.png)\n\n[click](javascript:alert(1))\n\n$2+2=4$'
      }
    </Markdown>,
  );
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("a")).toBeNull();
  expect(container.querySelector(".katex")).not.toBeNull();
});
describe("answer controls", () => {
  it("preserves false as a valid judgment answer", async () => {
    const changed = vi.fn();
    render(
      <AnswerInput question={questions[2]} value={null} onChange={changed} />,
    );
    await userEvent.click(screen.getByRole("radio", { name: "错误" }));
    expect(changed).toHaveBeenCalledWith({ value: false });
    expect(answerReady(questions[2], { value: false })).toBe(true);
  });
  it("allows more than one selection for multiple choice", async () => {
    let value = { correct: ["A"] };
    const changed = vi.fn();
    render(
      <AnswerInput question={questions[1]} value={value} onChange={changed} />,
    );
    await userEvent.click(screen.getByText("4"));
    expect(changed).toHaveBeenCalledWith({ correct: ["A", "C"] });
  });
  it("falls back to free response when option contents are incomplete", () => {
    const q = { ...questions[0], options: [] };
    expect(canInteract(q)).toBe(false);
    render(<AnswerInput question={q} value={null} onChange={() => {}} />);
    expect(screen.getByRole("textbox", { name: "自由作答" })).toBeTruthy();
  });
  it("sorts with accessible buttons and explicit initial-order confirmation", async () => {
    const changed = vi.fn();
    render(
      <AnswerInput question={questions[5]} value={null} onChange={changed} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "第 2 项上移" }));
    expect(changed).toHaveBeenCalledWith({ order: [1, 0, 2] });
  });
});
it("flushes the latest draft before moving to the next question", async () => {
  const snapshot = {
    question: questions[2],
    groups: [],
    visuals: [],
    sources: [],
    warnings: [],
    missingAssets: false,
  };
  const attempt = {
    ordinal: 0,
    snapshot,
    answer: null,
    autoResult: null,
    result: null,
    gradeKind: "ungraded" as const,
    submittedAt: null,
    skipped: false,
    elapsedMs: 0,
  };
  const session: Session = {
    id: "session",
    title: "test",
    createdAt: Date.now(),
    finishedAt: null,
    position: 0,
    mode: "ordered",
    attempts: [attempt, { ...attempt, ordinal: 1 }],
  };
  const mock = vi.mocked(api);
  mock.mockResolvedValue(session);
  const onSession = vi.fn();
  const flushRef = { current: async () => {} };
  render(
    <Practice
      session={session}
      onSession={onSession}
      run={(job) => {
        void job();
      }}
      flushRef={flushRef}
    />,
  );
  await userEvent.click(screen.getByRole("radio", { name: "错误" }));
  await userEvent.click(screen.getByRole("button", { name: "下一题" }));
  await waitFor(() => expect(onSession).toHaveBeenCalled());
  const calls = mock.mock.calls.map(([r]) => r);
  const move = calls.findIndex((r) => r.type === "position");
  expect(move).toBeGreaterThan(0);
  expect(calls[move - 1]).toMatchObject({
    type: "save_draft",
    answer: { value: false },
  });
});

it("stores model and OSS configuration without returning an API key to the form", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const { ConnectionSettingsPanel } = await import("./ConnectionSettings");
  const config = {
    base_url: "https://api.example.com/v1",
    model_id: "demo-model",
    oss_url: "https://bucket.example.com",
  };
  vi.mocked(api).mockResolvedValue({ config, hasApiKey: true });
  render(
    <ConnectionSettingsPanel
      busy={false}
      run={(job) => {
        void job();
      }}
    />,
  );
  await waitFor(() =>
    expect((screen.getByLabelText("模型 ID") as HTMLInputElement).value).toBe(
      "demo-model",
    ),
  );
  expect(screen.queryByLabelText("供应商地址预设")).toBeNull();
  expect(screen.queryByLabelText("文本模型")).toBeNull();
  expect(screen.queryByLabelText("视觉模型")).toBeNull();
  const key = screen.getByLabelText("API Key") as HTMLInputElement;
  expect(key.type).toBe("password");
  expect(key.value).toBe("");
  expect(key.placeholder).toBe("********************************");
  expect(screen.queryByRole("button", {name:"保存"})).toBeNull();
  await userEvent.type(screen.getByLabelText("模型 ID"), "-updated");
  await waitFor(() => expect(api).toHaveBeenCalledWith({type:"save_settings",config:{...config,model_id:"demo-model-updated"},api_key:null}));
  expect(screen.queryByRole("checkbox")).toBeNull();
  await waitFor(() => expect(key.closest("fieldset")?.disabled).toBe(false));
  await userEvent.type(key,"replacement-key");
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"save_settings",api_key:"replacement-key"})));

});

it("shows numeric partial credit after an exam and locks answer controls", () => {
  const session: Session={id:"exam",kind:"self_test",title:"test",createdAt:0,submittedAt:1,finishedAt:null,position:0,mode:"ordered",attempts:[{ordinal:0,snapshot:{question:questions[4],groups:[],visuals:[],sources:[],warnings:[],missingAssets:false},answer:{text:"复习"},autoResult:null,result:false,gradeKind:"manual",submittedAt:1,skipped:false,elapsedMs:0,maxCents:500,earnedCents:300,grading:{manual:{scoreCents:300,reason:"部分得分"}}}]};
  render(<Practice session={session} onSession={()=>{}} run={()=>{}} flushRef={{current:async()=>{}}}/>);
  expect(screen.getByText("3 / 5 分")).toBeTruthy();
  expect(screen.queryByText("回答错误")).toBeNull();
  expect((screen.getByRole("textbox",{name:"作答内容"}) as HTMLTextAreaElement).disabled).toBe(true);
  expect(screen.getByText(/正确率（满分题/)).toBeTruthy();
});


function examSession(): Session {
  return {id:"exam",kind:"mock_exam",title:"test",createdAt:0,deadlineAt:Date.now()-1,submittedAt:null,finishedAt:null,position:0,mode:"ordered",attempts:[{ordinal:0,favorite:true,snapshot:{id:"q",favorite:false,question:questions[4],groups:[],visuals:[],sources:[],warnings:[],missingAssets:false},answer:{text:"durable"},autoResult:null,result:null,gradeKind:"ungraded",submittedAt:null,skipped:false,elapsedMs:0,maxCents:500,earnedCents:null}]};
}

it("coalesces blocked draft writes and flushes the latest answer before navigation", async () => {
  const session = {...examSession(), deadlineAt: null};
  session.attempts.push({...session.attempts[0], ordinal: 1});
  const pending: (() => void)[] = [];
  vi.mocked(api).mockImplementation(request => request.type === "save_draft"
    ? new Promise(resolve => { pending.push(() => resolve(null as never)); })
    : Promise.resolve(session) as never);
  render(<Practice session={session} onSession={vi.fn()} run={job => {void job();}} flushRef={{current:async()=>{}}}/>);
  const input = screen.getByRole("textbox", {name:"作答内容"});
  fireEvent.change(input, {target:{value:"first"}});
  await waitFor(() => expect(pending).toHaveLength(1));
  for (let i=0;i<20;i++) fireEvent.change(input, {target:{value:`draft ${i}`}});
  await userEvent.click(screen.getByRole("button", {name:"下一题"}));
  expect(pending).toHaveLength(1);
  expect(vi.mocked(api).mock.calls.some(([r])=>r.type==="position")).toBe(false);
  await act(async()=>pending[0]());
  expect(pending).toHaveLength(2);
  expect(api).toHaveBeenLastCalledWith(expect.objectContaining({type:"save_draft",answer:{text:"draft 19"}}));
  await act(async()=>pending[1]());
  await waitFor(()=>expect(api).toHaveBeenLastCalledWith({type:"position",id:"exam",position:1}));
});

it.each([false, true])("drains newer drafts after a failed write and reports latest failure=%s", async failLatest => {
  const session = {...examSession(), deadlineAt: null};
  session.attempts.push({...session.attempts[0], ordinal: 1});
  const pending: {resolve: () => void; reject: (error: Error) => void}[] = [];
  vi.mocked(api).mockImplementation(request => request.type === "save_draft"
    ? new Promise((resolve, reject) => { pending.push({resolve: () => resolve(null as never), reject}); })
    : Promise.resolve(session) as never);
  const failure = vi.fn();
  render(<Practice session={session} onSession={vi.fn()} run={job => {void job().catch(failure);}} flushRef={{current:async()=>{}}}/>);
  const input = screen.getByRole("textbox", {name:"作答内容"});
  fireEvent.change(input, {target:{value:"first"}});
  await waitFor(() => expect(pending).toHaveLength(1));
  fireEvent.change(input, {target:{value:"latest"}});
  await userEvent.click(screen.getByRole("button", {name:"下一题"}));
  await act(async () => pending[0].reject(new Error("first failed")));
  expect(pending).toHaveLength(2);
  expect(api).toHaveBeenLastCalledWith(expect.objectContaining({type:"save_draft",answer:{text:"latest"}}));
  expect(vi.mocked(api).mock.calls.some(([r]) => r.type === "position")).toBe(false);
  const latestError = new Error("latest failed");
  await act(async () => { if (failLatest) pending[1].reject(latestError); else pending[1].resolve(); });
  if (failLatest) {
    expect(failure).toHaveBeenCalledWith(latestError);
    expect(screen.getByRole("alert").textContent).toContain("答案保存失败");
    expect(vi.mocked(api).mock.calls.some(([r]) => r.type === "position")).toBe(false);
  } else {
    await waitFor(() => expect(api).toHaveBeenLastCalledWith({type:"position",id:"exam",position:1}));
    expect(failure).not.toHaveBeenCalled();
    expect(screen.getByText(/· 已保存/)).toBeTruthy();
  }
});

it("keeps grading idle when the shared UI lock declines the job", async () => {
  const session=examSession();session.submittedAt=1;session.attempts[0].submittedAt=1;
  const onSession=vi.fn();
  const {rerender}=render(<ExamResults session={session} onSession={onSession} run={()=>{}}/>);
  const button=screen.getByRole("button",{name:/AI 评分／继续/}) as HTMLButtonElement;
  await userEvent.click(button);
  expect(button.disabled).toBe(false);
  expect(screen.queryByText("停止后续评分")).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValue(session);
  rerender(<ExamResults session={session} onSession={onSession} run={job=>{void job();}}/>);
  await userEvent.click(button);
  await waitFor(()=>expect(onSession).toHaveBeenCalledWith(session));
});

it("replaces an unsaved timeout edit with the durable submitted answer", async () => {
  const session=examSession();
  const props={onSession:vi.fn(),run:(job:()=>Promise<void>)=>{void job();},flushRef:{current:async()=>{}}};
  const {rerender}=render(<Practice session={session} {...props}/>);
  vi.mocked(api).mockRejectedValueOnce(new Error("exam submitted"));
  fireEvent.change(screen.getByRole("textbox",{name:"作答内容"}),{target:{value:"unsaved after deadline"}});
  await waitFor(()=>expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"save_draft",answer:{text:"unsaved after deadline"}})));
  const locked={...session,submittedAt:1,attempts:[{...session.attempts[0],submittedAt:1}]};
  rerender(<Practice session={locked} {...props}/>);
  const input=screen.getByRole("textbox",{name:"作答内容"}) as HTMLTextAreaElement;
  expect(input.value).toBe("durable");
  expect(input.disabled).toBe(true);
});

it("uses live favorite state and refreshes the session after toggling", async () => {
  const session=examSession();session.submittedAt=1;
  const onSession=vi.fn();
  vi.mocked(api).mockResolvedValue(session);
  render(<Practice session={session} onSession={onSession} run={job=>{void job();}} flushRef={{current:async()=>{}}}/>);
  await userEvent.click(screen.getByRole("button",{name:"取消收藏"}));
  expect(api).toHaveBeenCalledWith({type:"favorite",id:"q",value:false});
  await waitFor(()=>expect(onSession).toHaveBeenCalledWith(session));
  expect(api).toHaveBeenCalledWith({type:"session",id:"exam"});
});

it("announces save failures, retries the draft and labels the current answer-card state", async () => {
  const session = examSession(); session.deadlineAt = null;
  vi.mocked(api).mockRejectedValue(new Error("disk unavailable"));
  render(<Practice session={session} onSession={()=>{}} run={job=>{void job().catch(()=>{});}} flushRef={{current:async()=>{}}}/>);
  fireEvent.change(screen.getByRole("textbox",{name:"作答内容"}),{target:{value:"新的草稿"}});
  expect((await screen.findByRole("alert")).textContent).toContain("答案保存失败");
  const current = screen.getByRole("button",{name:"转到第 1 题，已作答，未提交"});
  expect(current.getAttribute("aria-current")).toBe("step");
  vi.mocked(api).mockResolvedValue(session);
  await userEvent.click(screen.getByRole("button",{name:"重试保存"}));
  await waitFor(()=>expect(screen.queryByRole("alert")).toBeNull());
  expect(api).toHaveBeenLastCalledWith(expect.objectContaining({type:"save_draft",answer:{text:"新的草稿"}}));
});

it("moves focus into finish confirmation and restores it when cancelling without submitting", async () => {
  const session = examSession(); session.deadlineAt = null;
  vi.mocked(api).mockResolvedValue(session);
  render(<Practice session={session} onSession={()=>{}} run={job=>{void job();}} flushRef={{current:async()=>{}}}/>);
  const trigger = screen.getByRole("button",{name:"交卷"});
  await userEvent.click(trigger);
  expect(await screen.findByRole("alertdialog",{name:"确认交卷？"})).toBeTruthy();
  const cancel = screen.getByRole("button",{name:"继续作答"});
  await waitFor(()=>expect(document.activeElement).toBe(cancel));
  await userEvent.click(cancel);
  await waitFor(()=>expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(()=>expect(document.activeElement).toBe(trigger));
  expect(vi.mocked(api).mock.calls.some(([r])=>r.type === "submit_paper")).toBe(false);
});

it("opens the verified image in a keyboard-dismissable detail dialog", async () => {
  const {Content} = await import("./Content");
  URL.createObjectURL = vi.fn(() => "blob:image");
  URL.revokeObjectURL = vi.fn();
  vi.mocked(api).mockResolvedValue(new ArrayBuffer(5));
  render(<Content snapshot={{question:questions[4],groups:[],sources:[],warnings:[],missingAssets:false,visuals:[{id:"v",kind:"image",description:"题目配图",questionIds:["q"],imageRef:{sha256:"digest",objectKey:"image",mediaType:"image/png",sizeBytes:5}}]}}/>);
  await userEvent.click(await screen.findByRole("button",{name:"放大查看图片"}));
  expect(await screen.findByRole("dialog",{name:"查看图片"})).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole("button",{name:"放大查看图片"}));
  expect(api).toHaveBeenCalledWith({type:"asset",hash:"digest"});
});

it.each([true, false])("confirms finishing practice with submit_drafts=%s and restores focus on cancel", async (submitDrafts) => {
  const user = userEvent.setup();
  const session = { ...examSession(), kind: "practice" as const, deadlineAt: null };
  vi.mocked(api).mockResolvedValue(session);
  render(<Practice session={session} onSession={vi.fn()} run={job => { void job(); }} flushRef={{ current: async () => {} }} />);
  const trigger = screen.getByRole("button", { name: "结束练习" });
  await user.click(trigger);
  expect(await screen.findByRole("alertdialog", { name: "结束本次练习？" })).toBeTruthy();
  const cancel = screen.getByRole("button", { name: "继续作答" });
  expect(document.activeElement).toBe(cancel);
  await user.click(cancel);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  expect(vi.mocked(api).mock.calls.some(([r]) => r.type === "submit_paper")).toBe(false);
  await user.click(trigger);
  await screen.findByRole("alertdialog");
  await user.click(screen.getByRole("button", { name: submitDrafts ? "提交草稿并结束" : "草稿记为跳过并结束" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith({ type: "submit_paper", id: session.id, submit_drafts: submitDrafts }));
});

it("requires fee confirmation before retrying AI grading", async () => {
  const user = userEvent.setup();
  const session = examSession();
  session.submittedAt = 1;
  session.attempts[0].grading = { lastRequest: { status: "FAILED", error: "模型暂不可用" } };
  vi.mocked(invoke).mockResolvedValue(session);
  render(<ExamResults session={session} onSession={vi.fn()} run={job => { void job(); }} />);
  const trigger = screen.getByRole("button", { name: "重新评分当前题" });
  await user.click(trigger);
  expect(screen.getByRole("alertdialog", { name: "重新评分当前题？" })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  expect(invoke).not.toHaveBeenCalled();
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "确认重新评分" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("ai_request", {
      locale: "zh-CN",
    request: { type: "grade", id: session.id, ordinal: 0, retry: true },
  }));
});

it("preserves native filters, whole-label selection and disabled controls in study setup", async () => {
  const { StudySetup } = await import("./StudySetup");
  const user = userEvent.setup();
  const session = examSession();
  const row = { ...session.attempts[0].snapshot, id: "question", bankId: "bank", bankTitle: "题库甲", favorite: false, latestResult: null };
  vi.mocked(api).mockImplementation(async request => (request.type === "question_stats" ? {count:1,types:{short_answer:1}} : request.type === "questions_page" ? {items:[row],total:1,offset:0} : request.type === "preview_paper" ? {questionIds:[row.id],digest:"preview",questions:[row],scores:[],count:1} : session) as never);
  const props = { banks: [{ id: "bank", title: "题库甲", description: "", count: 1, createdAt: 0 }], initialBank: null, initialFilter: "", onClose: vi.fn(), onStart: vi.fn(), run: (job: () => Promise<void>) => { void job(); } };
  const { rerender } = render(<StudySetup {...props} busy={false} />);
  await screen.findByText(/可用 1 题/);
  await user.click(screen.getByText("高级设置 · 题库、筛选与选题方式"));
  await user.click(screen.getByRole("button", { name: "清空选择" }));
  await user.click(screen.getByText("题库甲（1）"));
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({ type: "question_stats", bank_ids: ["bank"] })));
  await user.selectOptions(screen.getByRole("combobox", { name: "范围" }), "wrong");
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({ type: "question_stats", filter: "wrong" })));
  await user.selectOptions(screen.getByRole("combobox", { name: "选题方式" }), "manual");
  await user.click(await screen.findByText(row.question.stem!));
  expect(screen.getByRole("checkbox", { name: row.question.stem! }).getAttribute("aria-checked")).toBe("true");
  await user.click(screen.getByRole("button", { name: "立即开始" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({ type: "start_paper", paper: expect.objectContaining({ question_ids: ["question"] }) })));
  rerender(<StudySetup {...props} busy />);
  for (const control of [...screen.getAllByRole("checkbox"), ...screen.getAllByRole("combobox")]) {
    expect((control as HTMLButtonElement).disabled).toBe(true);
  }
});

it("keeps exam confirmation open on failure and disables duplicate submissions while pending", async () => {
  const user = userEvent.setup();
  const session = { ...examSession(), deadlineAt: null };
  const failed = vi.fn();
  let rejectSubmission!: (reason: Error) => void;
  vi.mocked(api).mockImplementation(request => request.type === "submit_paper"
    ? new Promise((_resolve, reject) => { rejectSubmission = reject; })
    : Promise.resolve(session) as never);
  render(<Practice session={session} onSession={vi.fn()} run={job => { void job().catch(failed); }} flushRef={{ current: async () => {} }} />);
  await user.click(screen.getByRole("button", { name: "交卷" }));
  await screen.findByRole("alertdialog", { name: "确认交卷？" });
  expect(screen.queryByRole("button", { name: "草稿记为跳过并结束" })).toBeNull();
  const confirm = screen.getByRole("button", { name: "确认交卷" }) as HTMLButtonElement;
  await user.click(confirm);
  await waitFor(() => expect(api).toHaveBeenCalledWith({ type: "submit_paper", id: session.id, submit_drafts: true }));
  expect(confirm.disabled).toBe(true);
  await user.keyboard("{Escape}");
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  rejectSubmission(new Error("保存失败"));
  await waitFor(() => expect(failed).toHaveBeenCalled());
  expect(confirm.disabled).toBe(false);
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "继续作答" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

it("autosaves drafts without testing, reports failures and keeps testing explicit", async () => {
  const { ConnectionSettingsPanel } = await import("./ConnectionSettings");
  const { toast } = await import("./notifications");
  const success = vi.spyOn(toast, "success").mockImplementation(() => "notice");
  const failure = vi.spyOn(toast, "error").mockImplementation(() => "notice");
  const settings = {config:{base_url:"https://example.com/v1",model_id:"demo",oss_url:null},hasApiKey:true};
  let failSave = false;
  const flushRef = { current: async () => {} };
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "save_settings") {
      if (failSave) throw Error("save failed");
      return {...settings,config:request.config} as never;
    }
    if (request.type === "test_settings") return null as never;
    return settings as never;
  });
  render(<ConnectionSettingsPanel busy={false} run={job => { void job().catch(failure); }} flushRef={flushRef} />);
  const model = await screen.findByLabelText("模型 ID");
  await waitFor(() => expect((model as HTMLInputElement).value).toBe("demo"));
  expect(screen.queryByRole("button",{name:"保存"})).toBeNull();
  await userEvent.type(model,"-changed");
  await waitFor(() => expect(success).toHaveBeenCalledWith(expect.objectContaining({key:"连接配置已保存"})));
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({type:"test_settings"}));
  expect(vi.mocked(api).mock.calls.filter(([request])=>request.type==="save_settings")).toHaveLength(1);
  failSave=true;
  await userEvent.type(model,"-failed");
  await waitFor(() => expect(failure).toHaveBeenCalledWith(expect.objectContaining({message:"save failed"})));
  expect((model as HTMLInputElement).value).toBe("demo-changed-failed");
  await expect(flushRef.current()).rejects.toThrow("save failed");
  await userEvent.click(screen.getByRole("button",{name:"测试"}));
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({type:"test_settings"}));
  failSave=false;
  await userEvent.click(screen.getByRole("button",{name:"重试保存"}));
  await waitFor(() => expect(success).toHaveBeenCalledTimes(2));
  await userEvent.click(screen.getByRole("button",{name:"测试"}));
  await waitFor(() => expect(success).toHaveBeenCalledWith(expect.objectContaining({key:"连接测试通过"})));
  expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"test_settings",config:expect.objectContaining({model_id:"demo-changed-failed"}),api_key:null}));
  success.mockRestore(); failure.mockRestore();
});

it("clears a newly saved API key from the webview before testing the Keychain copy", async () => {
  const { ConnectionSettingsPanel } = await import("./ConnectionSettings");
  const settings = {config:{base_url:"https://example.com/v1",model_id:"demo",oss_url:null},hasApiKey:false};
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "save_settings") return {...settings,hasApiKey:true} as never;
    if (request.type === "test_settings") return null as never;
    return settings as never;
  });
  render(<ConnectionSettingsPanel busy={false} run={job => { void job(); }} />);
  const key = await screen.findByLabelText("API Key") as HTMLInputElement;
  expect(screen.queryByText(/解析配置还缺/)).toBeNull();
  expect(screen.getByRole("button", {name:"测试"}).hasAttribute("disabled")).toBe(true);
  await userEvent.type(key,"replacement-key");
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"save_settings",api_key:"replacement-key"})));
  await waitFor(() => expect(key.value).toBe(""));
  await userEvent.click(screen.getByRole("button",{name:"测试"}));
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"test_settings",api_key:null})));
});

it("uses the pending settings save when navigation flushes", async () => {
  const { ConnectionSettingsPanel } = await import("./ConnectionSettings");
  const settings = {config:{base_url:"https://example.com/v1",model_id:"demo",oss_url:null},hasApiKey:true};
  let finishSave!: (value: typeof settings) => void;
  const pending = new Promise<typeof settings>(resolve => { finishSave = resolve; });
  const flushRef = { current: async () => {} };
  vi.mocked(api).mockImplementation(async request => request.type === "save_settings" ? await pending as never : settings as never);
  render(<ConnectionSettingsPanel busy={false} run={job => { void job(); }} flushRef={flushRef} />);
  await userEvent.type(await screen.findByLabelText("模型 ID"), "-new");
  await waitFor(() => expect(vi.mocked(api).mock.calls.filter(([request]) => request.type === "save_settings")).toHaveLength(1));
  const flush = flushRef.current();
  expect(vi.mocked(api).mock.calls.filter(([request]) => request.type === "save_settings")).toHaveLength(1);
  await act(async () => { finishSave({...settings,config:{...settings.config,model_id:"demo-new"}}); await flush; });
  expect(vi.mocked(api).mock.calls.filter(([request]) => request.type === "save_settings")).toHaveLength(1);
});
