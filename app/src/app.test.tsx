// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnswerInput } from "./AnswerInput";
import { Markdown } from "./Content";
import { canInteract, answerReady, type Question, type Session } from "./api";
import { Practice } from "./Practice";
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
    await userEvent.click(screen.getByText("错误"));
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
  await userEvent.click(screen.getByText("错误"));
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
    text_model: "demo-model",
    vision_model: "vision-model",
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
    expect((screen.getByLabelText("文本模型") as HTMLInputElement).value).toBe(
      "demo-model",
    ),
  );
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
