// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "./transport";
import { nativeCloudBridge } from "./cloudTransport";
import { Client, downloadBlob } from "../../shared/cloud/api";
import { setNativeBridge } from "../../shared/cloud/transport";
import { task } from "../../shared/cloud/test-fixtures";
vi.mock("./transport",()=>({invoke:vi.fn()}));
afterEach(()=>{vi.resetAllMocks();setNativeBridge(null);});
it("binds queued native requests to their origin without regressing session generations",async()=>{
 const pending: ((value:unknown)=>void)[]=[];
 vi.mocked(invoke).mockImplementation(()=>new Promise(resolve=>pending.push(resolve)) as never);
 const bridge=nativeCloudBridge("https://first.test",1);
 const first=bridge.pickSources(), second=bridge.pickSources();
 pending[1]({value:[],generation:3});await second;
 pending[0]({value:[],generation:2});await first;
 const third=bridge.pickSources();
 expect(vi.mocked(invoke).mock.calls[2]).toEqual(["cloud_request",{request:{type:"pick_sources"},context:{origin:"https://first.test",generation:3}}]);
 pending[2]({value:[],generation:3});await third;
});
it("does not invoke aborted reads and discards aborted in-flight responses",async()=>{
 const bridge=nativeCloudBridge("https://first.test",1), controller=new AbortController();
 controller.abort();await expect(bridge.fetch("/api/import-capabilities",{signal:controller.signal})).rejects.toMatchObject({name:"AbortError"});
 expect(invoke).not.toHaveBeenCalled();
 let finish:(value:unknown)=>void=()=>{};
 vi.mocked(invoke).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}) as never);
 const active=new AbortController();const response=bridge.fetch("/api/import-capabilities",{signal:active.signal});active.abort();
 finish({value:{status:200,mediaType:"application/json",bytes:btoa("{}")},generation:1});
 await expect(response).rejects.toMatchObject({name:"AbortError"});
});
it("honors native export/save cancellation without claiming success",async()=>{
 const bridge=nativeCloudBridge("https://first.test",1);setNativeBridge(bridge);
 vi.mocked(invoke).mockResolvedValue({value:false,generation:1} as never);
 await expect(new Client().exportBank(task)).rejects.toMatchObject({code:"DOWNLOAD_CANCELLED"});
 await expect(downloadBlob(new Blob(["draft"]),"draft.json")).rejects.toMatchObject({code:"DOWNLOAD_CANCELLED"});
 expect(vi.mocked(invoke).mock.calls.map(([,args])=>(args!.request as {type:string}).type)).toEqual(["download","save"]);
});
it("disconnects old clients when their native origin changes",async()=>{
 setNativeBridge(nativeCloudBridge("https://first.test",1));const client=new Client();
 setNativeBridge(nativeCloudBridge("https://second.test",2));
 expect(client.active).toBe(false);
 await expect(client.exportBank(task)).rejects.toMatchObject({name:"AbortError"});expect(invoke).not.toHaveBeenCalled();
});

it("awaits the native confirmation result instead of treating its Promise as consent",async()=>{
 vi.mocked(invoke).mockResolvedValue({value:false,generation:1} as never);
 expect(await nativeCloudBridge("https://cloud.test",1).confirm("Keep the draft?" )).toBe(false);
 expect(invoke).toHaveBeenCalledExactlyOnceWith("cloud_request",{request:{type:"confirm",message:"Keep the draft?"},context:{origin:"https://cloud.test",generation:1}});
});
