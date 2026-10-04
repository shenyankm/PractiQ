// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type Question, type Session } from "./api";
import { ListeningPlayer } from "./ListeningPlayer";
import fixture from "../fixtures/english.json";

vi.mock("./api",async original=>({...await original<typeof import("./api")>(),api:vi.fn()}));
const question=(fixture.questions as Question[]).find(item=>item.id==="listen")!;
const mockApi=vi.mocked(api);
const observers: {callback:IntersectionObserverCallback;target?:Element;disconnect:()=>void}[]=[];

beforeEach(()=>{
  mockApi.mockReset();
  mockApi.mockResolvedValue(new ArrayBuffer(2) as never);
  observers.length=0;
  vi.stubGlobal("IntersectionObserver",class {
    entry:typeof observers[number];
    constructor(callback:IntersectionObserverCallback){this.entry={callback,disconnect:vi.fn()};observers.push(this.entry);}
    observe(target:Element){this.entry.target=target;}
    disconnect(){this.entry.disconnect();}
  });
  vi.spyOn(URL,"createObjectURL").mockReturnValue("blob:audio");
  vi.spyOn(URL,"revokeObjectURL").mockImplementation(()=>{});
  vi.spyOn(HTMLMediaElement.prototype,"duration","get").mockReturnValue(3);
  const paused=new WeakSet<HTMLMediaElement>();
  vi.spyOn(HTMLMediaElement.prototype,"paused","get").mockImplementation(function(this:HTMLMediaElement){return !paused.has(this);});
  vi.spyOn(HTMLMediaElement.prototype,"play").mockImplementation(function(this:HTMLMediaElement){paused.add(this);this.dispatchEvent(new Event("play"));return Promise.resolve();});
  vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(function(this:HTMLMediaElement){if(paused.delete(this))this.dispatchEvent(new Event("pause"));});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

function reveal(index=0){
  const observer=observers[index];
  act(()=>observer.callback([{isIntersecting:true,target:observer.target} as IntersectionObserverEntry],{} as IntersectionObserver));
}
const assetCalls=()=>mockApi.mock.calls.filter(([request])=>request.type==="asset");

function strictPlayback(beforeStart?:()=>Promise<void>,restricted=false) {
  const state={used:0,position:0,active:false,limit:2,restricted};
  let paused=false;
  mockApi.mockImplementation(async request=>{
    if(request.type==="asset")return new ArrayBuffer(2) as never;
    if(request.type!=="listening_playback")return null as never;
    if(request.action==="start"){
      await beforeStart?.();
      if(!state.active){
        if(state.restricted && state.used>=state.limit)throw new Error("No listening plays remaining");
        state.used++;state.position=0;state.active=true;
      }
      paused=false;
    } else if(request.action!=="state"){
      if(!state.active)throw new Error("Listening playback has not started");
      if(paused && request.action!=="pause")throw new Error("Listening playback is paused");
      if(!paused){
        state.position=request.position!;
        if(request.action==="pause")paused=true;
        if(request.action==="end")state.active=false;
      }
    }
    return {...state} as never;
  });
  return {state,isPaused:()=>paused};
}

it.each(["practice","self_test"] as const)("records natural EOF once without pausing native %s playback first",async kind=>{
  const {state}=strictPlayback(undefined,kind!=="practice");
  const session={id:"session",kind,finishedAt:null,submittedAt:null} as Session;
  const view=render(<ListeningPlayer question={question} session={session}/>);
  reveal();
  await waitFor(()=>expect(view.container.querySelector("audio")?.getAttribute("src")).toBe("blob:audio"));
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));
  await waitFor(()=>expect(state.active).toBe(true));
  const player=view.container.querySelector("audio")!;
  const ended=vi.spyOn(HTMLMediaElement.prototype,"ended","get").mockReturnValue(true);
  act(()=>{
    player.currentTime=3;
    fireEvent.timeUpdate(player);
    player.pause();
    fireEvent.ended(player);
  });
  await waitFor(()=>expect(state.active).toBe(false));
  expect(screen.queryByRole("alert")).toBeNull();
  const requests=mockApi.mock.calls.map(([request])=>request).filter(request=>request.type==="listening_playback");
  expect(requests.filter(request=>request.action==="end")).toHaveLength(1);
  expect(requests.filter(request=>request.action==="pause")).toHaveLength(0);
  expect(state.used).toBe(1);
  ended.mockReturnValue(false);
  if(kind==="practice"){
    await userEvent.click(screen.getByRole("button",{name:"从头重听"}));
    expect(player.currentTime).toBe(0);
    expect(player.paused).toBe(true);
    expect(state.used).toBe(1);
  }
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));
  await waitFor(()=>expect(state.used).toBe(2));
  expect(player.currentTime).toBe(0);
  ended.mockReturnValue(true);
  act(()=>{player.currentTime=3;fireEvent.timeUpdate(player);player.pause();fireEvent.ended(player);});
  await waitFor(()=>expect(state.active).toBe(false));
  expect(mockApi.mock.calls.filter(([request])=>request.type==="listening_playback" && request.action==="end")).toHaveLength(2);
  expect(mockApi.mock.calls.filter(([request])=>request.type==="listening_playback" && request.action==="pause")).toHaveLength(0);
  expect((screen.getByRole("button",{name:"播放听力"}) as HTMLButtonElement).disabled).toBe(kind!=="practice");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("waits for native resume before saving progress",async()=>{
  let starts=0;
  let resume! : ()=>void;
  const resumed=new Promise<void>(resolve=>{resume=resolve;});
  const {state,isPaused}=strictPlayback(async()=>{if(++starts===2)await resumed;});
  const session={id:"session",kind:"practice",finishedAt:null,submittedAt:null} as Session;
  const view=render(<ListeningPlayer question={question} session={session}/>);
  reveal();
  await waitFor(()=>expect(view.container.querySelector("audio")?.getAttribute("src")).toBe("blob:audio"));
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));
  await waitFor(()=>expect(state.active).toBe(true));
  await userEvent.click(screen.getByRole("button",{name:"暂停播放"}));
  await waitFor(()=>expect(isPaused()).toBe(true));
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));
  await waitFor(()=>expect(starts).toBe(2));
  const player=view.container.querySelector("audio")!;
  const now=vi.spyOn(Date,"now").mockReturnValue(10_000);
  act(()=>{player.currentTime=1;fireEvent.timeUpdate(player);});
  await act(async()=>{await Promise.resolve();});
  expect(mockApi.mock.calls.filter(([request])=>request.type==="listening_playback" && request.action==="progress")).toHaveLength(0);
  await act(async()=>{resume();await resumed;});
  now.mockReturnValue(11_001);
  act(()=>{player.currentTime=1.5;fireEvent.timeUpdate(player);});
  await waitFor(()=>expect(state.position).toBe(1.5));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(state.used).toBe(1);
});

it("saves a visibility pause after the pending native start completes",async()=>{
  let complete! : ()=>void;
  const pending=new Promise<void>(resolve=>{complete=resolve;});
  let starting=false;
  const {state,isPaused}=strictPlayback(async()=>{starting=true;await pending;});
  const session={id:"session",kind:"practice",finishedAt:null,submittedAt:null} as Session;
  const view=render(<ListeningPlayer question={question} session={session}/>);
  reveal();
  await waitFor(()=>expect(view.container.querySelector("audio")?.getAttribute("src")).toBe("blob:audio"));
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));
  await waitFor(()=>expect(starting).toBe(true));
  const player=view.container.querySelector("audio")!;
  act(()=>{player.currentTime=0.5;fireEvent(document,new Event("visibilitychange"));});
  expect(player.paused).toBe(true);
  await act(async()=>{complete();await pending;});
  await waitFor(()=>expect(isPaused()).toBe(true));
  expect(state.position).toBe(0.5);
  expect(state.used).toBe(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["replay","seek","seek-end"] as const)("keeps paused %s positioning local until playback resumes",async action=>{
  const {state,isPaused}=strictPlayback();
  const session={id:"session",kind:"practice",finishedAt:null,submittedAt:null} as Session;
  const view=render(<ListeningPlayer question={question} session={session}/>);
  reveal();
  await waitFor(()=>expect(view.container.querySelector("audio")?.getAttribute("src")).toBe("blob:audio"));
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));
  await waitFor(()=>expect(state.active).toBe(true));
  const player=view.container.querySelector("audio")!;
  act(()=>{player.currentTime=1;});
  await userEvent.click(screen.getByRole("button",{name:"暂停播放"}));
  await waitFor(()=>expect(isPaused()).toBe(true));
  expect(state.position).toBe(1);
  const now=vi.spyOn(Date,"now").mockReturnValue(10_000);
  if(action==="replay")await userEvent.click(screen.getByRole("button",{name:"从头重听"}));
  else fireEvent.change(screen.getByRole("slider"),{target:{value:action==="seek-end"?"3":"0.5"}});
  const ended=vi.spyOn(HTMLMediaElement.prototype,"ended","get").mockReturnValue(action==="seek-end");
  act(()=>{fireEvent.timeUpdate(player);if(action==="seek-end")fireEvent.ended(player);});
  await act(async()=>{await Promise.resolve();});
  expect(mockApi.mock.calls.filter(([request])=>request.type==="listening_playback" && request.action==="progress")).toHaveLength(0);
  expect(mockApi.mock.calls.filter(([request])=>request.type==="listening_playback" && request.action==="end")).toHaveLength(0);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(player.currentTime).toBe(action==="replay"?0:action==="seek-end"?3:0.5);
  ended.mockReturnValue(false);
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));
  await waitFor(()=>expect(isPaused()).toBe(false));
  expect(player.currentTime).toBe(action==="seek"?0.5:0);
  now.mockReturnValue(11_001);
  act(()=>{player.currentTime=0.8;fireEvent.timeUpdate(player);});
  await waitFor(()=>expect(state.position).toBe(0.8));
  expect(state.used).toBe(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not read offscreen audio and releases it after entering the nearby viewport",async()=>{
  const view=render(<ListeningPlayer question={question}/>);
  expect(assetCalls()).toHaveLength(0);
  expect((screen.getByRole("button",{name:"播放听力"}) as HTMLButtonElement).disabled).toBe(false);
  reveal();
  await waitFor(()=>expect(view.container.querySelector("audio")?.getAttribute("src")).toBe("blob:audio"));
  expect(assetCalls()).toHaveLength(1);
  expect(observers[0].disconnect).toHaveBeenCalled();
  view.unmount();
  await waitFor(()=>expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:audio"));
});

it("shares nearby audio of the same hash until the final player unmounts",async()=>{
  const first=render(<ListeningPlayer question={question}/>);
  const second=render(<ListeningPlayer question={question}/>);
  reveal(0);reveal(1);
  await waitFor(()=>expect(first.container.querySelector("audio")?.getAttribute("src")).toBe("blob:audio"));
  await waitFor(()=>expect(second.container.querySelector("audio")?.getAttribute("src")).toBe("blob:audio"));
  expect(assetCalls()).toHaveLength(1);
  first.unmount();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  second.unmount();
  await waitFor(()=>expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:audio"));
});

it("loads on an explicit offscreen play request and waits for metadata before starting",async()=>{
  const duration=vi.spyOn(HTMLMediaElement.prototype,"duration","get").mockReturnValue(NaN);
  const view=render(<ListeningPlayer question={question}/>);
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));
  await waitFor(()=>expect(view.container.querySelector("audio")?.getAttribute("src")).toBe("blob:audio"));
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  duration.mockReturnValue(3);
  fireEvent.loadedMetadata(view.container.querySelector("audio")!);
  await waitFor(()=>expect(screen.getByRole("button",{name:"暂停播放"})).toBeTruthy());
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  expect(assetCalls()).toHaveLength(1);
});

it("cancels a pending play when the page is hidden before loading completes",async()=>{
  let resolve!:(bytes:ArrayBuffer)=>void;
  mockApi.mockReturnValue(new Promise<ArrayBuffer>(done=>{resolve=done;}) as ReturnType<typeof api>);
  const view=render(<ListeningPlayer question={question}/>);
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));
  fireEvent(document,new Event("visibilitychange"));
  await act(async()=>resolve(new ArrayBuffer(2)));
  await waitFor(()=>expect(view.container.querySelector("audio")?.getAttribute("src")).toBe("blob:audio"));
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
});

it("allows retrying a failed asset read without consuming an exam play",async()=>{
  const state={used:0,position:0,active:false,limit:2,restricted:true};
  let reads=0;
  mockApi.mockImplementation(async request=>{
    if(request.type==="asset"){
      if(++reads===1)throw new Error("missing");
      return new ArrayBuffer(2) as never;
    }
    if(request.type==="listening_playback"){
      if(request.action==="start"){state.used++;state.active=true;}
      return {...state} as never;
    }
    return null as never;
  });
  const session={id:"session",kind:"self_test",finishedAt:null,submittedAt:null} as Session;
  render(<ListeningPlayer question={question} session={session}/>);
  await waitFor(()=>expect((screen.getByRole("button",{name:"播放听力"}) as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(state.used).toBe(0);
  await userEvent.click(screen.getByRole("button",{name:"播放听力"}));
  await waitFor(()=>expect(state.used).toBe(1));
  expect(assetCalls()).toHaveLength(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("releases the previous audio when its source changes",async()=>{
  const view=render(<ListeningPlayer question={question}/>);
  reveal();
  await waitFor(()=>expect(view.container.querySelector("audio")?.getAttribute("src")).toBe("blob:audio"));
  vi.mocked(URL.createObjectURL).mockReturnValue("blob:replacement");
  view.rerender(<ListeningPlayer question={{...question,audioRef:{...question.audioRef!,sha256:"f".repeat(64)}}}/>);
  await waitFor(()=>expect(view.container.querySelector("audio")?.getAttribute("src")).toBe("blob:replacement"));
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:audio");
});
