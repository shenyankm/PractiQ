// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Content, type MaterialReading } from "./Content";
import { AnswerInput } from "./AnswerInput";
import { ListeningPlayer } from "./ListeningPlayer";
import { QuestionEditor } from "./QuestionEditor";
import { countEnglishWords } from "./english";
import * as english from "./english";
import { api, type Question, type Session } from "./api";
import fixture from "../fixtures/english.json";
import { listeningAddress, listeningBlocks } from "../../shared/listening";
HTMLElement.prototype.scrollIntoView=()=>{};
vi.mock("./api",async importOriginal=>({...await importOriginal<typeof import("./api")>(),api:vi.fn()}));
const questions=fixture.questions as Question[];
const question=(id:string)=>questions.find(q=>q.id===id)!;
const mockApi=vi.mocked(api);
beforeEach(()=>{mockApi.mockReset();mockApi.mockResolvedValue(null as never);});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it("preserves expanded passage and scroll position across sibling questions without a dialog", async () => {
  const materialReading = {current:{} as MaterialReading};
  const go=vi.fn();
  const snapshot={question:question("words-1"),materials:[question("words")],groups:[],visuals:[],sources:[],warnings:[],missingAssets:false};
  const view=render(<Content key="first" materialDialog materialReading={materialReading} onBlank={go} snapshot={snapshot}/>);
  await userEvent.click(screen.getByRole("button",{name:"查看原文"}));
  const region=screen.getByRole("region",{name:"题目材料"});
  region.scrollTop=120; fireEvent.scroll(region);
  await userEvent.click(screen.getByRole("button",{name:"空位 1"}));
  expect(go).toHaveBeenCalledWith("words-1");
  view.rerender(<Content key="second" materialDialog materialReading={materialReading} onBlank={go} snapshot={{...snapshot,question:{...snapshot.question,id:"words-2"}}}/>);
  expect(screen.getByRole("button",{name:"收起原文"}).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("region",{name:"题目材料"}).scrollTop).toBe(120);
  expect(screen.queryByRole("dialog")).toBeNull();
  await userEvent.click(screen.getByRole("button",{name:"收起原文"}));
  expect(screen.queryByRole("region",{name:"题目材料"})).toBeNull();
});
it("keeps colon-containing material groups independent", async () => {
  const materialReading = {current:{} as MaterialReading};
  const snapshot={question:question("read-1"),materials:[{...question("read"),id:"a:b"},{...question("read"),id:"c"}],groups:[],visuals:[],sources:[],warnings:[],missingAssets:false};
  const view=render(<Content key="first" materialDialog materialReading={materialReading} snapshot={snapshot}/>);
  await userEvent.click(screen.getByRole("button",{name:"查看原文"}));
  const reader=screen.getByRole("region",{name:"题目材料"});
  reader.scrollTop=120; fireEvent.scroll(reader);
  view.rerender(<Content key="second" materialDialog materialReading={materialReading} snapshot={{...snapshot,materials:[{...question("read"),id:"a"},{...question("read"),id:"b:c"}]}}/>);
  expect(screen.queryByRole("region",{name:"题目材料"})).toBeNull();
  view.rerender(<Content key="first-again" materialDialog materialReading={materialReading} snapshot={snapshot}/>);
  expect(screen.getByRole("region",{name:"题目材料"}).scrollTop).toBe(120);
});

it("includes associated diagrams in the inline reader without exposing original pages", async () => {
  const snapshot={question:question("read-1"),materials:[question("read")],groups:[],visuals:[{id:"diagram",kind:"diagram" as const,description:"Associated source diagram",questionIds:["read-1"],sourceRef:{sha256:"a".repeat(64),objectKey:"original.png",mediaType:"image/png",sizeBytes:1}}],sources:[],warnings:[],missingAssets:false};
  render(<Content materialDialog materialReading={{current:{}}} revealOriginal={false} snapshot={snapshot}/>);
  await userEvent.click(screen.getByRole("button",{name:"查看原文"}));
  const reader=within(screen.getByRole("region",{name:"题目材料"}));
  expect(reader.getByRole("figure")).toBeTruthy();
  expect(reader.getByText("Associated source diagram")).toBeTruthy();
  expect(reader.queryByRole("button",{name:"查看原页"})).toBeNull();
});

it("opens material only on request and locates a gap without changing the draft",async()=>{
  const go=vi.fn();
  render(<Content materialDialog onBlank={go} blankAnswers={{"words-1":"A"}} snapshot={{question:question("words-1"),materials:[question("words")],groups:[],visuals:[],sources:[],warnings:[],missingAssets:false}}/>);
  expect(screen.queryByText("It is a")).toBeNull();
  await userEvent.click(screen.getByRole("button",{name:"查看原文"}));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByText("It is a")).toBeTruthy();
  await userEvent.click(screen.getByRole("button",{name:"空位 1 · A"}));
  expect(go).toHaveBeenCalledWith("words-1");
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(()=>expect(document.activeElement).toBe(screen.getByRole("button",{name:"查看原文"})));
});
it("opens text-only parent instructions during practice",async()=>{
  render(<Content materialDialog snapshot={{question:question("read-1"),materials:[{...question("read"),passage:[],contentBlocks:[],stem:"Parent heading",instructions:"Read this first"}],groups:[],visuals:[],sources:[],warnings:[],missingAssets:false}}/>);
  await userEvent.click(screen.getByRole("button",{name:"查看原文"}));
  expect(screen.getByText("Parent heading")).toBeTruthy();
  expect(screen.getByText("Read this first")).toBeTruthy();
});
it("counts contractions and hyphenated words once, without disabling submission",()=>{
  expect(countEnglishWords("It's a well-known book.\nDon't re-read it! 2026")).toBe(8);
  render(<AnswerInput question={question("write")} value={{text:"It's a well-known book."}} onChange={()=>{}}/>);
  expect(screen.getByRole("status").textContent).toContain("当前 4 词");
  expect(screen.getByRole("status").textContent).toContain("仍可提交");
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false);
});
it("shows only the word limits that exist",()=>{
  const write=question("write");
  const view=render(<AnswerInput question={{...write,minWords:80,maxWords:null}} value={{text:"word"}} onChange={()=>{}}/>);
  expect(screen.getByRole("status").textContent).toContain("要求：至少 80 词");
  view.rerender(<AnswerInput question={{...write,minWords:null,maxWords:120}} value={{text:"word"}} onChange={()=>{}}/>);
  expect(screen.getByRole("status").textContent).toContain("要求：至多 120 词");
  view.rerender(<AnswerInput question={{...write,minWords:80,maxWords:120}} value={{text:"word"}} onChange={()=>{}}/>);
  expect(screen.getByRole("status").textContent).toContain("要求：80–120 词");
});
it("counts a writing response once per render for the counter and both limits",()=>{
  const count = vi.spyOn(english, "countEnglishWords");
  const {rerender} = render(<AnswerInput question={question("write")} value={{text:"word ".repeat(100)}} onChange={()=>{}}/>);
  expect(screen.getByRole("status").textContent).toContain("当前 100 词");
  expect(count).toHaveBeenCalledTimes(1);
  rerender(<AnswerInput question={question("write")} value={{text:"word ".repeat(121)}} onChange={()=>{}}/>);
  expect(screen.getByRole("status").textContent).toContain("仍可提交");
  expect(count).toHaveBeenCalledTimes(2);
});
it.each(["", " \n\t", "école 中文 １２３", "a-b a‐b a‑b a–b a—b", "rock’n’roll can't 'quoted'", "e\u0301 😀 42"])("preserves Unicode word boundaries: %j", text=>{
  const expected = text.match(/[\p{L}\p{N}]+(?:['’\-‐‑][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  expect(countEnglishWords(text)).toBe(expected);
  expect(countEnglishWords(text)).toBe(expected);
});
it("disables options used in sibling gaps while allowing the current choice",()=>{
  render(<AnswerInput question={{...question("words-1"),options:question("words").options}} value={{correct:["B"]}} usedOptions={["A"]} onChange={()=>{}}/>);
  expect(screen.getAllByRole("radio")[0].hasAttribute("disabled")).toBe(true);
  expect(screen.getAllByRole("radio")[1].hasAttribute("disabled")).toBe(false);
});
it("edits translation fields and preserves source materials",async()=>{
  const save=vi.fn();
  render(<QuestionEditor initial={question("translate")} busy={false} onClose={()=>{}} onSave={save}/>);
  await userEvent.clear(screen.getByLabelText("目标语言代码"));
  await userEvent.type(screen.getByLabelText("目标语言代码"),"en-GB");
  await userEvent.click(screen.getByRole("button",{name:"保存题目"}));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({targetLanguage:"en-GB",contentBlocks:question("translate").contentBlocks}),[]);
});
it("saves writing limits and materials while preserving continuation roles", async () => {
  const user = userEvent.setup();
  const save = vi.fn();
  render(<QuestionEditor initial={{ ...question("write"), contentBlocks: [] }} busy={false} onClose={() => {}} onSave={save} />);
  await user.clear(screen.getByLabelText("作答说明"));
  await user.type(screen.getByLabelText("作答说明"), "Write a letter.");
  await user.clear(screen.getByLabelText("写作文体"));
  await user.type(screen.getByLabelText("写作文体"), "letter");
  await user.clear(screen.getByLabelText("最少词数"));
  await user.type(screen.getByLabelText("最少词数"), "80");
  await user.clear(screen.getByLabelText("最多词数"));
  await user.type(screen.getByLabelText("最多词数"), "120");
  await user.click(screen.getByRole("button", { name: "添加材料段落" }));
  await user.type(screen.getByLabelText("材料段落标签"), "A");
  await user.type(screen.getByLabelText("材料内容"), "Invite a friend.");
  await user.click(screen.getByRole("button", { name: "添加续写开头" }));
  await user.type(screen.getAllByLabelText("材料内容")[1], "Dear friend,");
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({
    instructions: "Write a letter.", writingGenre: "letter", minWords: 80, maxWords: 120,
    contentBlocks: [
      { partType: "text", role: "material", label: "A", textValue: "Invite a friend.", markdownValue: null },
      { partType: "text", role: "starter_text", label: "续写开头", textValue: "Dear friend,", markdownValue: null },
    ],
  }), []);
  await user.click(screen.getAllByRole("button", { name: "删除" })[0]);
  await user.clear(screen.getByLabelText("最少词数"));
  await user.clear(screen.getByLabelText("最多词数"));
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({
    minWords: null, maxWords: null,
    contentBlocks: [expect.objectContaining({ role: "starter_text", textValue: "Dear friend," })],
  }), []);
}, 15000);

function audioMocks() {
  vi.spyOn(URL,"createObjectURL").mockReturnValue("blob:audio");
  vi.spyOn(URL,"revokeObjectURL").mockImplementation(()=>{});
  let paused=true;
  vi.spyOn(HTMLMediaElement.prototype,"paused","get").mockImplementation(()=>paused);
  vi.spyOn(HTMLMediaElement.prototype,"duration","get").mockReturnValue(3);
  const play=vi.spyOn(HTMLMediaElement.prototype,"play").mockImplementation(function(this:HTMLMediaElement){paused=false;this.dispatchEvent(new Event("play"));return Promise.resolve();});
  vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(function(this:HTMLMediaElement){if(!paused){paused=true;this.dispatchEvent(new Event("pause"));}});
  const state={used:0,position:0,active:false,limit:2,restricted:true};
  mockApi.mockImplementation(async request=>{
    if(request.type === "asset")return new ArrayBuffer(2) as never;
    if(request.type === "load_listening_audio")return {bytes:new ArrayBuffer(2),mediaType:"audio/wav"} as never;
    if(request.type === "listening_playback"){
      if(request.action === "start" && !state.active){state.used++;state.active=true;}
      if(request.position != null)state.position=request.position;
      if(request.action === "end")state.active=false;
      return {...state} as never;
    }
    return null as never;
  });
  return {play,state};
}
const session={id:"s",kind:"self_test",finishedAt:null,submittedAt:null} as Session;
it("keeps native play count on pause and remount, and disables exhausted exams",async()=>{
  const {state}=audioMocks();
  const view=render(<ListeningPlayer question={question("listen")} session={session}/>);
  await waitFor(()=>expect((screen.getByRole("button",{name:"播放听力"}) as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));
  await waitFor(()=>expect(state.used).toBe(1));
  expect(screen.queryByRole("slider")).toBeNull();
  const audio=view.container.querySelector("audio")!;audio.currentTime=0.2;fireEvent.timeUpdate(audio);
  await userEvent.click(screen.getByRole("button",{name:"暂停播放"}));
  await waitFor(()=>expect(state.position).toBe(0.2));
  view.unmount();
  render(<ListeningPlayer question={question("listen")} session={session}/>);
  await waitFor(()=>expect(screen.getByText("已播放 1 / 2 遍")).toBeTruthy());
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));
  expect(state.used).toBe(1);
  state.used=2;fireEvent.ended(document.querySelector("audio")!);
  await waitFor(()=>expect((screen.getByRole("button",{name:"播放听力"}) as HTMLButtonElement).disabled).toBe(true));
});
it("does not consume a play when the browser cannot start audio",async()=>{
  const {play,state}=audioMocks();play.mockRejectedValue(new Error("decode failure"));
  render(<ListeningPlayer question={question("listen")} session={session}/>);
  await waitFor(()=>expect((screen.getByRole("button",{name:"播放听力"}) as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));
  expect(screen.getByRole("alert")).toBeTruthy();expect(state.used).toBe(0);
  expect(mockApi.mock.calls.some(([r])=>r.type==="listening_playback" && r.action==="start")).toBe(false);
});

it("records playback completion after a pending native start",async()=>{
  const {state}=audioMocks();
  let resolveStart: ((value:typeof state)=>void)|undefined;
  mockApi.mockImplementation(async request=>{
    if(request.type==="asset")return new ArrayBuffer(2) as never;
    if(request.type==="listening_playback"){
      if(request.action==="start")return await new Promise<typeof state>(resolve=>{resolveStart=resolve;}) as never;
      if(request.action==="end")state.active=false;
      return {...state} as never;
    }
    return null as never;
  });
  const view=render(<ListeningPlayer question={question("listen")} session={session}/>);
  await waitFor(()=>expect((screen.getByRole("button",{name:"播放听力"}) as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));
  await waitFor(()=>expect(resolveStart).toBeDefined());
  const player=view.container.querySelector("audio")!;
  player.currentTime=0.2;fireEvent.ended(player);
  state.used=1;state.active=true;resolveStart!({...state});
  await waitFor(()=>expect(mockApi.mock.calls.some(([r])=>r.type==="listening_playback" && r.action==="end")).toBe(true));
  expect(state.active).toBe(false);
});

it("resumes practice progress after remount and still permits seeking",async()=>{
  const {state}=audioMocks();Object.assign(state,{active:true,used:1,position:1.4,restricted:false});
  const view=render(<ListeningPlayer question={question("listen")} session={{...session,kind:"practice"}}/>);
  await waitFor(()=>expect((screen.getByRole("button",{name:"播放听力"}) as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));
  const player=view.container.querySelector("audio")!;
  expect(player.currentTime).toBe(1.4);expect(state.used).toBe(1);
  await userEvent.click(screen.getByRole("button",{name:"暂停播放"}));
  fireEvent.change(screen.getByRole("slider"),{target:{value:"0.5"}});
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));
  expect(player.currentTime).toBe(0.5);expect(state.used).toBe(1);
});

it.each(["typed", "QR", "selected"])("protects an unapplied %s listening URL and keeps it after continuing", async source => {
  const user = userEvent.setup();
  const close = vi.fn(), save = vi.fn();
  const url = "https://example.com/listening.wav";
  mockApi.mockImplementation(async request => {
    if (request.type === "pick_audio_qr") return (source === "QR" ? [{ url, label: "" }] : [{ url, label: "Track 1" }, { url: "https://example.com/other.wav", label: "Track 2" }]) as never;
    return null as never;
  });
  render(<QuestionEditor initial={{ ...question("listen"), audioRef: null }} busy={false} onClose={close} onSave={save} />);
  const input = screen.getByRole("textbox", { name: "听力资源网址" });
  if (source === "typed") await user.type(input, url);
  else {
    await user.click(screen.getByRole("button", { name: "识别二维码图片" }));
    if (source === "selected") await user.click(await screen.findByRole("button", { name: "Track 1 · " + url }));
  }
  const calls = mockApi.mock.calls.length;
  const saveButton = screen.getByRole("button", { name: "保存题目" }) as HTMLButtonElement;
  expect(saveButton.disabled).toBe(true);
  await user.click(saveButton);
  expect(save).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  await user.click(input);
  await user.keyboard("{Escape}");
  expect(close).not.toHaveBeenCalled();
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "继续编辑" }));
  expect((input as HTMLInputElement).value).toBe(url);
  expect(document.activeElement).toBe(input);
  expect(mockApi.mock.calls).toHaveLength(calls);
  await user.clear(input);
  expect(saveButton.disabled).toBe(false);
  await user.click(saveButton);
  expect(save).toHaveBeenCalledOnce();
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
  expect(mockApi.mock.calls.some(([request]) => request.type === "listening_links")).toBe(false);
});

it("keeps a failed listening URL guarded without retrying when continuing", async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  const url = "https://example.com/unavailable.wav";
  mockApi.mockRejectedValue({ code: "LOCAL_AUDIO_NO_LINKS" });
  render(<QuestionEditor initial={{ ...question("listen"), audioRef: null }} busy={false} onClose={close} onSave={vi.fn()} />);
  const input = screen.getByRole("textbox", { name: "听力资源网址" });
  await user.type(input, url);
  await user.click(screen.getByRole("button", { name: "查找网页中的播放地址" }));
  await screen.findByRole("alert");
  await user.keyboard("{Escape}");
  expect(close).not.toHaveBeenCalled();
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "继续编辑" }));
  expect((input as HTMLInputElement).value).toBe(url);
  expect(mockApi.mock.calls.filter(([request]) => request.type === "listening_links")).toHaveLength(1);
});

it("saves a playback address and listening controls without loading or storing audio", async () => {
  const user=userEvent.setup(), save=vi.fn();
  render(<QuestionEditor initial={{...question("listen"),audioRef:null,missingFields:["media","material"]}} busy={false} onClose={()=>{}} onSave={save}/>);
  expect(screen.queryByRole("button",{name:"选择听力音频"})).toBeNull();
  await user.type(screen.getByLabelText("听力资源网址"),"https://example.com/listen.wav#track");
  await user.click(screen.getByRole("button",{name:"应用播放地址"}));
  await user.clear(screen.getByLabelText("开始秒数"));await user.type(screen.getByLabelText("开始秒数"),"0.5");
  await user.type(screen.getByLabelText("结束秒数（可留空）"),"2.5");
  await user.clear(screen.getByLabelText("考试播放次数"));await user.type(screen.getByLabelText("考试播放次数"),"3");
  await user.clear(screen.getByLabelText("听力原文"));await user.type(screen.getByLabelText("听力原文"),"Original transcript");
  await user.click(screen.getByRole("button",{name:"保存题目"}));
  const saved=save.mock.calls[0][0] as Question;
  expect(listeningAddress(saved)).toBe("https://example.com/listen.wav");
  expect(saved).toMatchObject({audioRef:null,audioStartSeconds:.5,audioEndSeconds:2.5,examPlayCount:3,missingFields:["material"],transcript:[{partType:"text",textValue:"Original transcript"}]});
  expect(mockApi).not.toHaveBeenCalled();
});

it("decodes a QR code locally but requires applying its address before saving", async () => {
  const user=userEvent.setup(), save=vi.fn(), url="https://example.com/listening.wav";
  mockApi.mockResolvedValue([{url,label:""}] as never);
  render(<QuestionEditor initial={{...question("listen"),audioRef:null,missingFields:["media"]}} busy={false} onClose={()=>{}} onSave={save}/>);
  await user.click(screen.getByRole("button",{name:"识别二维码图片"}));
  expect(screen.getByLabelText("听力资源网址")).toHaveProperty("value",url);
  expect(screen.getByRole("button",{name:"保存题目"})).toHaveProperty("disabled",true);
  await user.click(screen.getByRole("button",{name:"应用播放地址"}));
  await user.click(screen.getByRole("button",{name:"保存题目"}));
  expect(listeningAddress(save.mock.calls[0][0])).toBe(url);
  expect(mockApi.mock.calls.map(([r])=>r.type)).toEqual(["pick_audio_qr"]);
});

it("preserves a stored address on reopen and rejects private replacements without requests", async () => {
  const user=userEvent.setup(), save=vi.fn(), url="https://example.com/old.wav";
  const initial={...question("listen"),audioRef:null,contentBlocks:listeningBlocks(question("listen").contentBlocks,url)};
  render(<QuestionEditor initial={initial} busy={false} onClose={()=>{}} onSave={save}/>);
  const input=screen.getByLabelText("听力资源网址");expect(input).toHaveProperty("value",url);
  await user.clear(input);await user.type(input,"http://127.0.0.1/private.wav");
  await user.click(screen.getByRole("button",{name:"应用播放地址"}));
  expect(await screen.findByRole("alert")).toBeTruthy();expect(mockApi).not.toHaveBeenCalled();
  expect(screen.getByRole("button",{name:"保存题目"})).toHaveProperty("disabled",true);
  await user.clear(input);await user.type(input,url);await user.click(screen.getByRole("button",{name:"保存题目"}));
  expect(listeningAddress(save.mock.calls[0][0])).toBe(url);
});

it("finds page links and existing-image QR addresses without applying or playing them", async () => {
  const user=userEvent.setup(), save=vi.fn(), url="https://example.com/track.wav";
  mockApi.mockResolvedValue([{url,label:"Track"},{url:"https://example.com/two.wav",label:"Two"}] as never);
  render(<QuestionEditor initial={{...question("listen"),audioRef:null}} images={[{hash:"a".repeat(64),label:"QR"}]} busy={false} onClose={()=>{}} onSave={save}/>);
  await user.type(screen.getByLabelText("听力资源网址"),"https://example.com/page");
  await user.click(screen.getByRole("button",{name:"查找网页中的播放地址"}));
  await user.click(await screen.findByRole("button",{name:"Track · "+url}));
  expect(screen.getByRole("button",{name:"保存题目"})).toHaveProperty("disabled",true);
  await user.click(screen.getByText("识别题目图片中的二维码"));
  await user.click(screen.getByRole("button",{name:"识别图片 1 · QR"}));
  await waitFor(()=>expect(mockApi).toHaveBeenCalledWith({type:"decode_audio_qr",hash:"a".repeat(64)}));
  expect(mockApi.mock.calls.some(([r])=>r.type==="load_listening_audio")).toBe(false);
});

it.each(["cancel","failure"])("keeps the applied address after QR %s", async outcome => {
  const user=userEvent.setup(), save=vi.fn(), url="https://example.com/old.wav";
  if(outcome==="cancel")mockApi.mockResolvedValue(null as never);else mockApi.mockRejectedValue({code:"LOCAL_AUDIO_QR_INVALID"});
  render(<QuestionEditor initial={{...question("listen"),audioRef:null,contentBlocks:listeningBlocks([],url)}} busy={false} onClose={()=>{}} onSave={save}/>);
  await user.click(screen.getByRole("button",{name:"识别二维码图片"}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"保存题目"})).toHaveProperty("disabled",false));
  expect(screen.getByLabelText("听力资源网址")).toHaveProperty("value",url);
  await user.click(screen.getByRole("button",{name:"保存题目"}));expect(listeningAddress(save.mock.calls[0][0])).toBe(url);
});

it("ignores late QR results across mode changes and removes the old address on removal", async () => {
  const user=userEvent.setup(), save=vi.fn();let finish!:(value:unknown)=>void;
  mockApi.mockImplementation(async ()=>await new Promise<unknown>(resolve=>{finish=resolve;}) as never);
  render(<QuestionEditor initial={{...question("listen"),audioRef:null,contentBlocks:listeningBlocks([],"https://example.com/old.wav")}} busy={false} onClose={()=>{}} onSave={save}/>);
  await user.click(screen.getByRole("button",{name:"识别二维码图片"}));
  await user.selectOptions(screen.getByRole("combobox",{name:"答题方式"}),"short_answer");
  finish([{url:"https://example.com/late.wav",label:""}]);
  await waitFor(()=>expect(screen.getByRole("button",{name:"保存题目"})).toHaveProperty("disabled",false));
  await user.selectOptions(screen.getByRole("combobox",{name:"答题方式"}),"listening");
  expect(screen.getByLabelText("听力资源网址")).toHaveProperty("value","");
  await user.type(screen.getByLabelText("听力资源网址"),"https://example.com/new.wav");
  await user.click(screen.getByRole("button",{name:"应用播放地址"}));
  await user.click(screen.getByRole("button",{name:"移除音频"}));
  await user.click(screen.getByRole("button",{name:"保存题目"}));expect(listeningAddress(save.mock.calls[0][0])).toBeNull();
});

it("loads online audio only after play and releases memory when the player closes", async () => {
  const {play}=audioMocks(), url="https://example.com/listen.wav";
  const view=render(<ListeningPlayer question={{...question("listen"),audioRef:null,contentBlocks:listeningBlocks([],url)}}/>);
  expect(mockApi).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));
  await waitFor(()=>expect(play).toHaveBeenCalledOnce());
  expect(mockApi.mock.calls.map(([r])=>r.type)).toEqual(["load_listening_audio"]);
  view.unmount();await waitFor(()=>expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:audio"));
});

it("allows explicit retry after an online load failure without keeping failed audio in memory", async () => {
  const {play}=audioMocks(); let loads=0;
  mockApi.mockImplementation(async r=>{
    if(r.type==="load_listening_audio") { if(++loads===1)throw {code:"LOCAL_AUDIO_DOWNLOAD_FAILED"};return {bytes:new ArrayBuffer(2),mediaType:"audio/wav"} as never; }
    return null as never;
  });
  render(<ListeningPlayer question={{...question("listen"),audioRef:null,contentBlocks:listeningBlocks([],"https://example.com/audio.wav")}}/>);
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));await screen.findByRole("alert");
  expect(loads).toBe(1);expect(play).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));await waitFor(()=>expect(play).toHaveBeenCalledOnce());
  expect(loads).toBe(2);
});

it("ignores a late online load when the question changes and does not preload the replacement", async () => {
  const {play}=audioMocks();let finish!:(value:unknown)=>void;
  mockApi.mockImplementation(async ()=>await new Promise<unknown>(resolve=>{finish=resolve;}) as never);
  const first={...question("listen"),audioRef:null,contentBlocks:listeningBlocks([],"https://example.com/first.wav")};
  const view=render(<ListeningPlayer question={first}/>);
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));
  view.rerender(<ListeningPlayer question={{...first,id:"another",contentBlocks:listeningBlocks([],"https://example.com/second.wav")}}/>);
  finish({bytes:new ArrayBuffer(2),mediaType:"audio/wav"});
  await waitFor(()=>expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:audio"));
  expect(mockApi.mock.calls.map(([r])=>r)).toEqual([{type:"load_listening_audio",url:"https://example.com/first.wav"}]);
  expect(play).not.toHaveBeenCalled();
});
