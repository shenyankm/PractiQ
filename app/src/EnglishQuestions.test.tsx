// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Content } from "./Content";
import { AnswerInput } from "./AnswerInput";
import { ListeningPlayer } from "./ListeningPlayer";
import { QuestionEditor } from "./QuestionEditor";
import { countEnglishWords } from "./english";
import { api, type Question, type Session } from "./api";
import fixture from "../fixtures/english.json";
vi.mock("./api",async importOriginal=>({...await importOriginal<typeof import("./api")>(),api:vi.fn()}));
const questions=fixture.questions as Question[];
const question=(id:string)=>questions.find(q=>q.id===id)!;
const mockApi=vi.mocked(api);
beforeEach(()=>{mockApi.mockReset();mockApi.mockResolvedValue(null as never);});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
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
it("counts contractions and hyphenated words once, without disabling submission",()=>{
  expect(countEnglishWords("It's a well-known book.\nDon't re-read it! 2026")).toBe(8);
  render(<AnswerInput question={question("write")} value={{text:"It's a well-known book."}} onChange={()=>{}}/>);
  expect(screen.getByRole("status").textContent).toContain("当前 4 词");
  expect(screen.getByRole("status").textContent).toContain("仍可提交");
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false);
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
