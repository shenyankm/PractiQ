// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    type: "save_attempt",
    answer: { value: false },
    submit: false,
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
  await userEvent.click(screen.getByRole("button", { name: "保存连接配置" }));
  await waitFor(() =>
    expect(vi.mocked(api)).toHaveBeenCalledWith({
      type: "save_settings",
      config,
      api_key: null,
    }),
  );
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(screen.getByRole("button", { name: "保存连接配置" }));
  await waitFor(() =>
    expect(vi.mocked(api)).toHaveBeenCalledWith({
      type: "save_settings",
      config,
      api_key: "",
    }),
  );
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
  await waitFor(()=>expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"save_attempt",answer:{text:"unsaved after deadline"}})));
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
  expect(api).toHaveBeenLastCalledWith(expect.objectContaining({type:"save_attempt",answer:{text:"新的草稿"},submit:false}));
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
  vi.mocked(api).mockResolvedValue("data:image/png;base64,cGl4ZWw=");
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
    request: { type: "grade", id: session.id, ordinal: 0, retry: true },
  }));
});

it("preserves native filters, whole-label selection and disabled controls in study setup", async () => {
  const { StudySetup } = await import("./StudySetup");
  const user = userEvent.setup();
  const session = examSession();
  const row = { ...session.attempts[0].snapshot, id: "question", bankId: "bank", bankTitle: "题库甲", favorite: false, latestResult: null };
  vi.mocked(api).mockImplementation(async request => (request.type === "questions" ? [row] : session) as never);
  const props = { banks: [{ id: "bank", title: "题库甲", description: "", count: 1, createdAt: 0 }], initialBank: null, initialFilter: "", onClose: vi.fn(), onStart: vi.fn(), run: (job: () => Promise<void>) => { void job(); } };
  const { rerender } = render(<StudySetup {...props} busy={false} />);
  await screen.findByText(/可用 1 题/);
  await user.click(screen.getByText("高级设置 · 题库、筛选与选题方式"));
  await user.click(screen.getByRole("button", { name: "清空选择" }));
  await user.click(screen.getByText("题库甲（1）"));
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({ type: "questions", bank_ids: ["bank"] })));
  await user.selectOptions(screen.getByRole("combobox", { name: "范围" }), "wrong");
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({ type: "questions", filter: "wrong" })));
  await user.selectOptions(screen.getByRole("combobox", { name: "选题方式" }), "manual");
  await user.click(screen.getByText(row.question.stem!));
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
