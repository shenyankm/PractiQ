// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Workbench, { type CorrectionLeaveGuard } from "../../shared/cloud/CorrectionWorkbench";
import { CorrectionDraftRecovery } from "../../shared/cloud/CorrectionDraftRecovery";
import { correctionDrafts, putCorrectionDraft } from "../../shared/cloud/correctionDrafts";
import { Client } from "../../shared/cloud/api";
import { setNativeBridge, type NativeBridge } from "../../shared/cloud/transport";
import { question, task } from "../../shared/cloud/test-fixtures";
const q=question({id:"draft-question",parentId:null,optionSourceId:null,answerMode:"true_false",choiceVariant:null,stem:"Original"});
function bridge(confirm=vi.fn(async()=>false)) {setNativeBridge({origin:"https://cloud.test",confirm} as unknown as NativeBridge);return confirm;}
beforeEach(()=>{localStorage.clear();globalThis.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};HTMLElement.prototype.scrollIntoView=vi.fn();});
afterEach(()=>{cleanup();setNativeBridge(null);vi.restoreAllMocks();localStorage.clear();});
it("never treats Tauri's asynchronous confirm as consent to discard an unsaved editor",async()=>{
 bridge();const browserConfirm=vi.spyOn(window,"confirm").mockImplementation((async()=>false) as never);
 const holder:{guard:CorrectionLeaveGuard}={guard:null};const changed=(value:CorrectionLeaveGuard)=>{holder.guard=value;};
 render(<Workbench task={task} preview={null} question={q} original={q} questionIndex={0} units={[]} corrections={{checkpointId:task.checkpointId!,edits:[]}} client={new Client()} onSaved={()=>{}} onClose={()=>{}} onLeaveGuardChange={changed}/>);
 const user=userEvent.setup();await user.click(screen.getByRole("button",{name:"人工校对"}));
 const stem=screen.getByLabelText(/题干/);await user.clear(stem);await user.type(stem,"Keep this draft");
 let allowed=true;await act(async()=>{allowed=holder.guard?.()??true;});
 expect(allowed).toBe(false);expect(browserConfirm).not.toHaveBeenCalled();
 expect((stem as HTMLTextAreaElement).value).toBe("Keep this draft");expect(correctionDrafts()).toHaveLength(1);
 await user.click(screen.getByRole("button",{name:"放弃本次修改"}));
 expect(holder.guard?.()).toBe(true);expect(correctionDrafts()).toHaveLength(0);
});
it("waits for a native confirmation result and preserves a draft when Cancel is chosen",async()=>{
 let finish:(value:boolean)=>void=()=>{};
 const confirm=vi.fn(()=>new Promise<boolean>(resolve=>{finish=resolve;}));bridge(confirm);
 const saved={version:1 as const,taskId:task.threadId,fileName:task.fileName,checkpointId:task.checkpointId!,questionIndex:0,revision:null,editor:{original:q,question:q,answer:"",initialAnswer:""},pending:null,updatedAt:"2026-11-07T00:00:00Z"};putCorrectionDraft(saved);
 render(<CorrectionDraftRecovery onOpen={()=>{}}/>);const user=userEvent.setup();
 await user.click(screen.getByRole("button",{name:"删除本机草稿"}));expect(correctionDrafts()).toHaveLength(1);
 await act(async()=>finish(false));expect(correctionDrafts()).toHaveLength(1);
 await user.click(screen.getByRole("button",{name:"删除本机草稿"}));
 await act(async()=>finish(true));await waitFor(()=>expect(correctionDrafts()).toHaveLength(0));
 expect(confirm).toHaveBeenCalledTimes(2);
});
