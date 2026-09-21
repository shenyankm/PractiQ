// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { I18nProvider, message, MessageError, systemLocale, number, list, locale, t, translate, useI18n, type Locale } from "./i18n";
import { en } from "./locales/en";
import { zhCN } from "./locales/zh-CN";
import native from "./locales/native.json";
import { date, duration, errorMessage, type Session, type Question } from "./api";
import App from "./App";
import { QuestionEditor, blankQuestion } from "./QuestionEditor";
import { Practice } from "./Practice";
import { toast } from "./notifications";
import { Toaster } from "./components/ui/sonner";
import fixture from "../fixtures/sample.json";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));
let saved: Locale | null = null;
let failSave = false;
let language: ReturnType<typeof useI18n>;
function Controls() { language = useI18n(); return null; }
function wrap(children: React.ReactNode) { return render(<I18nProvider><Controls />{children}</I18nProvider>); }
async function ready() { await act(async () => {}); await waitFor(() => expect(language.ready).toBe(true)); }
async function change(locale: Locale) { await act(async () => language.change(locale)); }
beforeEach(() => {
  saved = null; failSave = false;
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["zh-CN"] });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== "request") throw new Error("Unexpected model request");
    const request = (args as { request: { type: string; locale?: Locale } }).request;
    switch (request.type) {
      case "language": return saved;
      case "save_language": if (failSave) throw { code: "LOCAL_LANGUAGE_INVALID", message: "语言设置无效" }; saved = request.locale!; return saved;
      case "banks": case "sessions": case "questions": return [];
      case "info": return { version: "test", dataDirectory: "/test" };
      case "settings": return { config: { base_url: null, model_id: null, oss_url: null }, hasApiKey: false };
      default: throw new Error(`Unexpected command: ${request.type}`);
    }
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("has complete dictionaries, matching parameters and count plurals", () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
  const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const [key, value] of Object.entries(en)) {
    expect(value.trim(), key).not.toBe("");
    expect(slots(value), key).toEqual(slots(key));
  }
  for (const pair of Object.values(native)) expect(slots(pair.en)).toEqual(slots(pair["zh-CN"]));
  expect(translate("en", "{0} 题", { 0: 1 })).toBe("1 question");
  expect(translate("en", "{0} 题", { 0: 2 })).toBe("2 questions");
  expect(translate("en", "{0} 个题库 · {1} 道题目", { 0: 1, 1: 1234 })).toBe("1 bank · 1,234 questions");
  expect(translate("zh-CN", "已导入 {0} 道题目", { 0: 2 })).toBe("已导入 2 道题目");
});
it("resolves the system language and prefers a saved selection across remounts", async () => {
  expect(systemLocale(["zh-TW"])).toBe("zh-CN");
  expect(systemLocale(["zh-Hans-CN"])).toBe("zh-CN");
  expect(systemLocale(["fr-FR", "zh-CN"])).toBe("en");
  expect(systemLocale([])).toBe("en");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en-US"] });
  const view = wrap(<App />); await ready();
  expect(await screen.findByRole("heading", { name: "My banks" })).toBeTruthy();
  await change("zh-CN");
  expect(document.documentElement.lang).toBe("zh-CN");
  view.unmount(); wrap(<App />); await ready();
  expect(await screen.findByRole("heading", { name: "我的题库" })).toBeTruthy();
});
it("switches through the sidebar and retains language on save failure", async () => {
  wrap(<App />); await ready();
  const select = await screen.findByRole("combobox", { name: "语言" });
  select.focus(); expect(document.activeElement).toBe(select);
  await userEvent.selectOptions(select, "en");
  expect(await screen.findByRole("heading", { name: "My banks" })).toBeTruthy();
  expect(saved).toBe("en");
  failSave = true; await change("zh-CN");
  expect(document.documentElement.lang).toBe("en");
  expect(screen.getByRole("alert").textContent).toContain("Could not save language settings");
  expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === "ai_request")).toHaveLength(0);
  expect(vi.mocked(invoke).mock.calls.some(([, args]) => JSON.stringify(args).includes('"save_settings"'))).toBe(false);
});
it("keeps editor input and an open dialog while changing all its labels", async () => {
  wrap(<QuestionEditor initial={blankQuestion()} busy={false} onClose={() => {}} onSave={() => {}} />); await ready();
  const input = screen.getByLabelText("题干（支持 Markdown 和公式）");
  fireEvent.change(input, { target: { value: "原文 unchanged" } });
  await change("en");
  expect(screen.getByRole("dialog").textContent).toContain("Edit question");
  expect(screen.getByLabelText("Question text (Markdown and equations supported)")).toBe(input);
  expect((input as HTMLTextAreaElement).value).toBe("原文 unchanged");
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
});
it("preserves a draft and snapshot during switching without submitting or grading", async () => {
  const question = { ...fixture.questions[0], answerMode: "short_answer", stem: "原题 must stay unchanged", answerPayload: { text: "原答案" }, options: [] } as unknown as Question;
  const session: Session = { id: "session", title: "历史名称", createdAt: 1, finishedAt: null, position: 0, mode: "ordered", attempts: [{ ordinal: 0, snapshot: { question, groups: [], visuals: [], sources: [], warnings: [], missingAssets: false }, answer: { text: "draft 原文" }, autoResult: null, result: null, gradeKind: "ungraded", submittedAt: null, skipped: false, elapsedMs: 0 }] };
  wrap(<Practice session={session} onSession={() => {}} run={job => { void job(); }} flushRef={{ current: async () => {} }} />); await ready();
  const before = vi.mocked(invoke).mock.calls.length;
  const input = screen.getByRole("textbox", { name: "作答内容" });
  await change("en");
  expect(screen.getByRole("textbox", { name: "Your answer" })).toBe(input);
  expect((input as HTMLTextAreaElement).value).toBe("draft 原文");
  expect(screen.getByText("原题 must stay unchanged")).toBeTruthy();
  expect(screen.getByText("历史名称")).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.slice(before).map(([, args]) => (args as {request:{type:string}}).request.type)).toEqual(["save_language"]);
});
it("retranslates stored errors and visible notifications while preserving diagnostics", async () => {
  const error = new MessageError(message("分数超过上限"));
  function ErrorView() { useI18n(); return <p>{errorMessage(error)}</p>; }
  wrap(<><ErrorView /><Toaster /></>); await ready();
  act(() => { toast.success(message("已导入 {0} 道题目", { 0: 1 })); });
  await change("en");
  expect(screen.getByText("Score exceeds the limit")).toBeTruthy();
  expect(await screen.findByText("Imported 1 question")).toBeTruthy();
  expect(errorMessage({ code: "LOCAL_RESOURCE_PATH_UNSAFE", params: { key: "../x" }, message: "原始诊断" })).toContain("Unsafe resource path: ../x");
  expect(errorMessage({ code: "UNRECOGNIZED", requestId: "r1", httpStatus: 500, message: "original detail" })).toContain("original detail (UNRECOGNIZED · r1 · 500)");
  expect(t("主导航")).toBe("Main navigation");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
it("retries an initial read failure without saving settings", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("disk offline"));
  wrap(<App />); await ready();
  expect(screen.getByRole("alert").textContent).toContain("disk offline");
  saved = "en";
  await act(async () => language.reload());
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.documentElement.lang).toBe("en");
  expect(vi.mocked(invoke).mock.calls.some(([,a]) => JSON.stringify(a).includes("save_"))).toBe(false);
});
it("ignores stale StrictMode initialization after a manual selection", async () => {
  const first = deferred<Locale>();
  vi.mocked(invoke).mockImplementationOnce(() => first.promise);
  render(<StrictMode><I18nProvider><Controls /></I18nProvider></StrictMode>);
  await ready(); await change("en");
  await act(async () => first.resolve("zh-CN"));
  expect(language.locale).toBe("en");
  expect(document.documentElement.lang).toBe("en");
});
it("serializes rapid saves and ignores a delayed reload", async () => {
  wrap(null); await ready();
  const read = deferred<Locale>();
  vi.mocked(invoke).mockImplementationOnce(() => read.promise);
  let reload!: Promise<void>;
  act(() => { reload = language.reload(); });
  const write = deferred<null>();
  vi.mocked(invoke).mockImplementationOnce(() => write.promise);
  let save!: Promise<void>;
  act(() => { save = language.change("en"); });
  expect(language.saving).toBe(true);
  await change("zh-CN");
  expect(language.locale).toBe("zh-CN");
  await act(async () => { write.resolve(null); await save; });
  await act(async () => { read.resolve("zh-CN"); await reload; });
  expect(language.locale).toBe("en");
  expect(language.saving).toBe(false);
  expect(vi.mocked(invoke).mock.calls.filter(([,a]) => JSON.stringify(a).includes("save_language"))).toHaveLength(1);
});
it("does not let an unmounted provider overwrite a new window state", async () => {
  const old = deferred<Locale>();
  vi.mocked(invoke).mockImplementationOnce(() => old.promise);
  const view = wrap(null); view.unmount();
  saved = "en"; wrap(null); await ready();
  await act(async () => old.resolve("zh-CN"));
  expect(locale()).toBe("en");
  expect(document.documentElement.lang).toBe("en");
});
it.each(["en", null] as const)("reloads restored preference %s through the settings UI", async (restored) => {
  saved = "zh-CN";
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en-US"] });
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if ((args as {request:{type:string}}).request.type === "restore") {
      saved = restored; return { recoveryPath: "/backup/original" };
    }
    return original(command, args);
  });
  wrap(<App />); await ready();
  await userEvent.click(screen.getByRole("button", { name: "设置" }));
  await userEvent.click(await screen.findByRole("button", { name: "恢复备份" }));
  await userEvent.click(screen.getByRole("button", { name: "确认" }));
  await waitFor(() => expect(document.documentElement.lang).toBe("en"));
  expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "ai_request")).toHaveLength(0);
});
it.each(["en", "zh-CN"] as const)("formats dates, durations, counts and precision in %s", async (value) => {
  saved = value; wrap(null); await ready();
  const timestamp = Date.UTC(2025, 0, 2, 13, 4, 5);
  expect(date(timestamp)).toBe(new Intl.DateTimeFormat(value, {year:"numeric",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(timestamp));
  expect(duration(0)).toBe(value === "en" ? "0 min 0 sec" : "0 分 0 秒");
  expect(duration(3661999)).toBe(value === "en" ? "61 min 1 sec" : "61 分 1 秒");
  expect(number(1234.567, 2)).toBe("1,234.57");
  expect(number(0, 2)).toBe("0.00");
  expect(list(["A", "B"])).toBe(value === "en" ? "A & B" : "A和B");
});
it.each(["en", "zh-CN"] as const)("imports offline JSON and saves an unchanged model form in %s", async value => {
  saved = value;
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const r = (args as {request:{type:string}}).request;
    if (command === "ai_request" && ["operations", "batches"].includes(r.type)) return [];
    if (r.type === "pick_import") return {ticket:"ticket",title:"原文 filename",count:1,reviewCount:0,assetCount:0,missingAssets:[],warnings:[],status:"SUCCEEDED"};
    if (r.type === "import") return {bankId:"bank",count:1,duplicate:false};
    if (r.type === "save_settings") return {config:{},hasApiKey:false};
    return original(command,args);
  });
  wrap(<App />); await ready();
  await userEvent.click(screen.getByRole("button", {name:t("导入第一份题库")}));
  await userEvent.click(await screen.findByRole("button", {name:t("选择题库 JSON")}));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", {name:t("确认导入")}));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("request", expect.objectContaining({locale:value,request:expect.objectContaining({type:"import",ticket:"ticket",title:"原文 filename"})})));
  await userEvent.click(screen.getByRole("button", {name:t("设置")}));
  const model = await screen.findByLabelText(t("模型 ID"));
  await waitFor(() => expect(model.closest("fieldset")?.disabled).toBe(false));
  await userEvent.type(model,"model-original");
  await change(value === "en" ? "zh-CN" : "en");
  expect((screen.getByLabelText(t("模型 ID")) as HTMLInputElement).value).toBe("model-original");
  await userEvent.click(screen.getByRole("button", {name:t("保存连接配置")}));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("request", expect.objectContaining({request:expect.objectContaining({type:"save_settings",config:expect.objectContaining({model_id:"model-original"})})})));
  expect(vi.mocked(invoke).mock.calls.filter(([c,a]) => c === "ai_request" && !["operations","batches"].includes((a as {request:{type:string}}).request.type))).toHaveLength(0);
});
it.each(["en", "zh-CN"] as const)("keeps grading explicit and formats partial scores in %s", async value => {
  saved = value;
  const { ExamResults } = await import("./ExamResults");
  const q = {...fixture.questions[4],answerMode:"short_answer",stem:"原题",answerPayload:{text:"参考"},missingFields:[]} as unknown as Question;
  const session: Session = {id:"exam",kind:"self_test",title:"历史",createdAt:1,submittedAt:1,finishedAt:null,position:0,mode:"ordered",attempts:[{ordinal:0,snapshot:{question:q,groups:[],visuals:[],sources:[],warnings:[],missingAssets:false},answer:{text:"用户答案"},autoResult:null,result:false,gradeKind:"ai",submittedAt:1,skipped:false,elapsedMs:0,maxCents:300,earnedCents:100,grading:{lastRequest:{status:"FAILED",error:"原始诊断"}}}]};
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (c,a) => c === "ai_request" ? session : original(c,a));
  const changed = vi.fn();
  wrap(<ExamResults session={session} onSession={changed} run={job => {void job();}} />); await ready();
  expect(screen.getByText(/33.3%/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", {name:t("重新评分当前题")}));
  await change(value === "en" ? "zh-CN" : "en");
  expect(screen.getByRole("alertdialog", {name:t("重新评分当前题？")})).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "ai_request")).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", {name:t("重新评分当前题")}));
  await userEvent.click(screen.getByRole("button", {name:t("确认重新评分")}));
  await waitFor(() => expect(changed).toHaveBeenCalledWith(session));
  expect(invoke).toHaveBeenCalledWith("ai_request",{locale:locale(),request:{type:"grade",id:"exam",ordinal:0,retry:true}});
});
it.each(["cancel", "failure"])("keeps preference when native restore returns %s", async outcome => {
  saved = "en";
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (c,a) => {
    if ((a as {request:{type:string}}).request.type === "restore") {
      if (outcome === "failure") throw new Error("invalid archive");
      return null;
    }
    return original(c,a);
  });
  wrap(<App />); await ready();
  await userEvent.click(screen.getByRole("button", {name:"Settings"}));
  await userEvent.click(await screen.findByRole("button", {name:t("恢复备份")}));
  await userEvent.click(screen.getByRole("button", {name:t("确认")}));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("request",{locale:"en",request:{type:"restore"}}));
  await act(async () => {});
  expect(language.locale).toBe("en");
  expect(saved).toBe("en");
  expect(vi.mocked(invoke).mock.calls.filter(([,a]) => (a as {request:{type:string}}).request.type === "language")).toHaveLength(1);
});
it("ignores stale read failures and permits retry after a rejected write", async () => {
  const stale = deferred<Locale>();
  vi.mocked(invoke).mockImplementationOnce(() => stale.promise);
  render(<StrictMode><I18nProvider><Controls /></I18nProvider></StrictMode>); await ready();
  await change("en");
  await act(async () => stale.reject(new Error("stale failure")));
  expect(language.error).toBeNull();
  failSave = true; await change("zh-CN");
  expect(language.locale).toBe("en"); expect(language.saving).toBe(false);
  failSave = false; await change("zh-CN");
  expect(language.locale).toBe("zh-CN"); expect(language.error).toBeNull();
});
it("keeps translation parameters checked by TypeScript", () => {
  // Compiled by tsc in app-check; never invoke malformed calls at runtime.
  const invalidCalls = () => {
    // @ts-expect-error Required interpolation argument cannot be omitted.
    t("{0} 题");
    // @ts-expect-error The dictionary does not define this message.
    t("not a dictionary key");
    // @ts-expect-error Parameter names must match the source sentence.
    message("已导入 {0} 道题目", { count: 2 });
  };
  expect(typeof invalidCalls).toBe("function");
});
