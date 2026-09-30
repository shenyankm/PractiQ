// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AnswerDisplay, AnswerInput } from "./AnswerInput";
import { Blocks, Content } from "./Content";
import { EnglishFields } from "./EnglishFields";
import { blankQuestion, errorMessage, type Question, type Snapshot } from "./api";
import { I18nProvider, t, useI18n, type Locale } from "./i18n";
import { invoke } from "./transport";
import { materialLanguage } from "./english";

vi.mock("./transport", () => ({ invoke: vi.fn() }));
let language: ReturnType<typeof useI18n>;
let saved: Locale;
function Controls() { language = useI18n(); return null; }
function wrap(children: React.ReactNode) { return render(<I18nProvider><Controls />{children}</I18nProvider>); }
async function ready() { await act(async () => {}); await waitFor(() => expect(language.ready).toBe(true)); }
async function change(value: Locale) { await act(async () => { await language.change(value); }); }
function snapshot(question: Question): Snapshot { return { question, groups: [], visuals: [], sources: [], warnings: [], missingAssets: false }; }
const content = (text: string) => screen.getByText(text).closest(".document-content")!;

beforeEach(() => {
  saved = "zh-CN";
  vi.mocked(invoke).mockReset().mockImplementation(async (_command, args) => {
    const request = args!.request as {type: string; locale?: Locale};
    if (request.type === "language") return saved;
    if (request.type === "save_language") { saved = request.locale!; return saved; }
    throw new Error(`Unexpected request: ${request.type}`);
  });
});
afterEach(cleanup);

it("formats answer lists on language changes and keeps matching pairs in separate blocks", async () => {
  const question = {...blankQuestion(), answerMode:"matching" as const, items:[
    {id:0, side:"left" as const, content:"左侧原文"}, {id:1, side:"left" as const, content:"Second (original)"},
    {id:0, side:"right" as const, content:"右侧原文"}, {id:1, side:"right" as const, content:"Target"},
  ]};
  wrap(<><AnswerDisplay answer={{correct:["A","B"]}}/><AnswerDisplay question={question} answer={{matches:[{left:0,right:0},{left:1,right:1}]}}/></>);
  await ready();
  expect(screen.getByText("A和B")).toBeTruthy();
  expect(content("左侧原文 → 右侧原文")).not.toBe(content("Second (original) → Target"));
  await change("en");
  expect(screen.getByText("A & B")).toBeTruthy();
  expect(screen.getByText("左侧原文 → 右侧原文")).toBeTruthy();
});

it("marks translation source and target blocks without guessing instructions or other material", async () => {
  const question = {...blankQuestion(), questionKind:"translation" as const, sourceLanguage:"en-US", targetLanguage:"zh-TW", stem:"请翻译这一句", instructions:"保留原意", contentBlocks:[
    {partType:"text" as const, role:"source_text", label:"材料", textValue:"Original source."},
    {partType:"text" as const, role:"target_text", textValue:"原始譯文。"},
    {partType:"text" as const, role:"material", textValue:"未知语言材料"},
  ]};
  wrap(<Content snapshot={snapshot(question)}/>); await ready();
  expect(content("Original source.").getAttribute("lang")).toBe("en-US");
  expect(screen.getByText("材料").closest("[lang]")).toBe(document.documentElement);
  expect(content("原始譯文。").getAttribute("lang")).toBe("zh-TW");
  for (const text of ["请翻译这一句","保留原意","未知语言材料"]) expect(content(text).hasAttribute("lang")).toBe(false);
  await change("en");
  expect(screen.getByText("原始譯文。")).toBeTruthy();
  expect(content("Original source.").getAttribute("lang")).toBe("en-US");
});

it("rejects invalid content language tags and marks known English passages without relabeling gaps", async () => {
  const translation = {...blankQuestion(), questionKind:"translation" as const, sourceLanguage:"en_<bad>", contentBlocks:[{partType:"text" as const,role:"source_text",textValue:"Untyped source"}]};
  const reading = {...blankQuestion(), questionKind:"reading" as const, stem:"中文作答说明", passage:[{partType:"text" as const,textValue:"Read the original passage."},{partType:"blank" as const,questionId:"gap"}],contentBlocks:[{partType:"text" as const,role:"instructions",textValue:"中文材料说明"}]};
  wrap(<><Content snapshot={snapshot(translation)}/><Content snapshot={snapshot(reading)}/><Blocks blocks={[{partType:"blank",questionId:"gap"}]} blankAnswers={{gap:"answer"}} language={block=>materialLanguage(reading,block.role)}/></>); await ready();
  expect(content("Untyped source").hasAttribute("lang")).toBe(false);
  expect(content("Read the original passage.").getAttribute("lang")).toBe("en");
  expect(content("中文作答说明").hasAttribute("lang")).toBe(false);
  expect(content("中文材料说明").hasAttribute("lang")).toBe(false);
  expect(screen.getByRole("button",{name:"空位 1 · answer"}).closest("[lang]")).toBe(document.documentElement);
  expect(screen.getByText("answer").getAttribute("lang")).toBe("en");
});

it("uses target language for written answers and leaves unknown writing materials unmarked", async () => {
  const question = {...blankQuestion(),answerMode:"short_answer" as const,questionKind:"writing" as const,targetLanguage:"fr-ca",contentBlocks:[
    {partType:"text" as const,role:"starter_text",textValue:"Bonjour,"},
    {partType:"text" as const,role:"material",textValue:"写一封法语信"},
  ]};
  wrap(<><AnswerInput question={question} value={{text:"Ma réponse"}} onChange={()=>{}}/><AnswerDisplay question={question} answer={{text:"Réponse originale"}}/><Content snapshot={snapshot(question)}/></>); await ready();
  expect(screen.getByRole("textbox",{name:t("作答内容")}).getAttribute("lang")).toBe("fr-CA");
  expect(content("Réponse originale").getAttribute("lang")).toBe("fr-CA");
  expect(content("Bonjour,").getAttribute("lang")).toBe("fr-CA");
  expect(content("写一封法语信").hasAttribute("lang")).toBe(false);
});

it("keeps localized missing-answer fallbacks out of the content language", async () => {
  const question = {...blankQuestion(),questionKind:"paragraph_matching" as const,answerMode:"matching" as const,items:[
    {id:0,side:"left" as const,content:"First"},{id:0,side:"right" as const,content:"Original target"},
  ]};
  wrap(<><AnswerDisplay question={question} answer={{matches:[{left:0,right:0},{left:0,right:99}]}}/><AnswerDisplay question={question} answer={{text:""}}/></>); await ready();
  expect(content("First → Original target").getAttribute("lang")).toBe("en");
  expect(content("First → 题项缺失").hasAttribute("lang")).toBe(false);
  expect(content("参考答案不完整").hasAttribute("lang")).toBe(false);
});

it.each(["file", "url"] as const)("retranslates a stored audio %s error without making a new audio request", async kind => {
  const failure = {code:"LOCAL_AUDIO_NO_LINKS"};
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command,args) => {
    const request=args!.request as {type:string};
    if (["pick_audio","import_audio_url"].includes(request.type)) throw failure;
    return original(command,args);
  });
  wrap(<EnglishFields question={{...blankQuestion(),answerMode:"listening",questionKind:"listening",audioRef:null}} patch={()=>{}} onPendingChange={()=>{}}/>); await ready();
  if (kind === "url") await userEvent.type(screen.getByRole("textbox",{name:"听力资源网址"}),"https://example.com/audio");
  await userEvent.click(screen.getByRole("button",{name:kind === "file"?"选择听力音频":"从网址获取音频"}));
  const before = screen.getByRole("alert").textContent;
  const requests=vi.mocked(invoke).mock.calls.length;
  await change("en");
  expect(screen.getByRole("alert").textContent).toBe(kind === "file"?t("音频加载或播放失败，请检查文件后重试。"):errorMessage(failure));
  expect(screen.getByRole("alert").textContent).not.toBe(before);
  expect(vi.mocked(invoke).mock.calls.slice(requests).map(([,args])=>(args!.request as {type:string}).type)).toEqual(["save_language"]);
});
