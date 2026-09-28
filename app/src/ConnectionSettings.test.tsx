// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionSettingsPanel } from "./ConnectionSettings";
import { api, type SettingsResult } from "./api";
import { toast } from "./notifications";

vi.mock("./api", async importOriginal => ({...await importOriginal<typeof import("./api")>(), api:vi.fn()}));
vi.mock("./notifications", () => ({toast:{success:vi.fn(),error:vi.fn()}}));
afterEach(() => {cleanup();vi.clearAllMocks();});
const settings: SettingsResult = {config:{base_url:"https://example.com/v1",model_id:"demo"},hasApiKey:true};
function mount() {
  render(<ConnectionSettingsPanel busy={false} run={job=>{void job();}}/>);
}

it("keeps blank autosaves non-destructive and removes a stored key only through the explicit action", async () => {
  vi.mocked(api).mockImplementation(async request => request.type === "save_settings" ? {...settings,hasApiKey:request.api_key !== ""} as never : settings as never);
  mount();
  const key = await screen.findByLabelText("API Key");
  await waitFor(()=>expect((screen.getByLabelText("模型 ID") as HTMLInputElement).value).toBe("demo"));
  await userEvent.type(key," ");
  await userEvent.tab();
  await waitFor(()=>expect(api).toHaveBeenCalledWith({type:"save_settings",config:settings.config,api_key:null}));
  const clear = screen.getByRole("button",{name:"清除已保存的 API Key"});
  await userEvent.click(clear);
  await waitFor(()=>expect(api).toHaveBeenCalledWith({type:"save_settings",config:settings.config,api_key:""}));
  expect(clear.hasAttribute("disabled")).toBe(true);
  expect((key as HTMLInputElement).placeholder).toBe("填写此地址对应的 API Key");
});

it("keeps failed removals retryable and requires a replacement-key draft to save first", async () => {
  let fail = true;
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "save_settings") {
      if (fail) throw Error("Keychain is locked");
      return {...settings,hasApiKey:request.api_key !== ""} as never;
    }
    return settings as never;
  });
  mount();
  const key = await screen.findByLabelText("API Key") as HTMLInputElement;
  await waitFor(()=>expect((screen.getByLabelText("模型 ID") as HTMLInputElement).value).toBe("demo"));
  await userEvent.click(screen.getByRole("button",{name:"清除已保存的 API Key"}));
  await waitFor(()=>expect(toast.error).toHaveBeenCalled());
  expect(key.placeholder).toBe("********************************");
  expect(api).toHaveBeenLastCalledWith({type:"save_settings",config:settings.config,api_key:""});
  fireEvent.change(key,{target:{value:"replacement-key"}});
  const clear = screen.getByRole("button",{name:"清除已保存的 API Key"});
  expect(clear.hasAttribute("disabled")).toBe(true);
  await userEvent.click(clear);
  expect(key.value).toBe("replacement-key");
  expect(vi.mocked(api).mock.calls.filter(([request])=>request.type === "save_settings")).toHaveLength(1);
  fail = false;
  fireEvent.blur(key);
  await waitFor(()=>expect(key.value).toBe(""));
  await userEvent.click(screen.getByRole("button",{name:"清除已保存的 API Key"}));
  await waitFor(()=>expect(key.placeholder).toBe("填写此地址对应的 API Key"));
});

it("requires an earlier blur save to finish before accepting a clear action", async () => {
  let finish!: (value:SettingsResult)=>void;
  const pending = new Promise<SettingsResult>(resolve=>{finish=resolve;});
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "save_settings") return request.api_key === "" ? {...settings,config:request.config,hasApiKey:false} as never : await pending as never;
    return settings as never;
  });
  mount();
  const model = await screen.findByLabelText("模型 ID") as HTMLInputElement;
  await waitFor(()=>expect(model.value).toBe("demo"));
  fireEvent.change(model,{target:{value:"updated"}});
  fireEvent.blur(model);
  await waitFor(()=>expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"save_settings",api_key:null})));
  const clear = screen.getByRole("button",{name:"清除已保存的 API Key"});
  expect(clear.hasAttribute("disabled")).toBe(true);
  await userEvent.click(clear);
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({type:"save_settings",api_key:""}));
  await act(async()=>{finish({...settings,config:{...settings.config,model_id:"updated"}});});
  await waitFor(()=>expect(clear.hasAttribute("disabled")).toBe(false));
  await userEvent.click(clear);
  await waitFor(()=>expect(api).toHaveBeenLastCalledWith({type:"save_settings",config:{...settings.config,model_id:"updated"},api_key:""}));
  expect(screen.getByRole("button",{name:"清除已保存的 API Key"}).hasAttribute("disabled")).toBe(true);
});

it("clears the displayed new endpoint only after its blur autosave succeeds", async () => {
  const next = {...settings,config:{...settings.config,base_url:"https://other.example.com/v1"}};
  let finish!: (value:SettingsResult)=>void;
  const pending = new Promise<SettingsResult>(resolve=>{finish=resolve;});
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "save_settings") return request.api_key === "" ? {...next,hasApiKey:false} as never : await pending as never;
    return settings as never;
  });
  mount();
  const base = await screen.findByLabelText("Base URL") as HTMLInputElement;
  await waitFor(()=>expect(base.value).toBe(settings.config.base_url));
  await userEvent.clear(base);
  await userEvent.type(base,next.config.base_url!);
  const clear = screen.getByRole("button",{name:"清除已保存的 API Key"});
  expect(clear.hasAttribute("disabled")).toBe(true);
  await userEvent.tab();
  await userEvent.click(clear);
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({type:"save_settings",api_key:""}));
  await act(async()=>{finish(next);});
  await waitFor(()=>expect(clear.hasAttribute("disabled")).toBe(false));
  await userEvent.click(clear);
  expect(api).toHaveBeenLastCalledWith({type:"save_settings",config:next.config,api_key:""});
  expect(base.value).toBe(next.config.base_url);
});

it("does not turn a failed endpoint autosave into a credential deletion or overwrite its draft", async () => {
  let reject!: (error:Error)=>void;
  const pending = new Promise<SettingsResult>((_resolve,fail)=>{reject=fail;});
  vi.mocked(api).mockImplementation(async request => request.type === "save_settings" ? await pending as never : settings as never);
  mount();
  const base = await screen.findByLabelText("Base URL") as HTMLInputElement;
  await waitFor(()=>expect(base.value).toBe(settings.config.base_url));
  await userEvent.clear(base);
  await userEvent.type(base,"https://other.example.com/v1");
  await userEvent.tab();
  await act(async()=>{reject(Error("Active parsing prevents configuration changes"));});
  expect(await screen.findByRole("button",{name:"重试保存"})).toBeTruthy();
  const clear = screen.getByRole("button",{name:"清除已保存的 API Key"});
  expect(clear.hasAttribute("disabled")).toBe(true);
  await userEvent.click(clear);
  expect(base.value).toBe("https://other.example.com/v1");
  expect(vi.mocked(api).mock.calls.every(([request])=>request.type !== "save_settings" || request.api_key === null)).toBe(true);
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({type:"save_settings",api_key:""}));
});

it("does not clear while a reverted endpoint draft still follows an older pending save", async () => {
  const next = {...settings,config:{...settings.config,base_url:"https://other.example.com/v1"}};
  let finish!: (value:SettingsResult)=>void;
  const pending = new Promise<SettingsResult>(resolve=>{finish=resolve;});
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "save_settings") return request.config.base_url === next.config.base_url ? await pending as never : {...settings,hasApiKey:request.api_key !== ""} as never;
    return settings as never;
  });
  mount();
  const base = await screen.findByLabelText("Base URL") as HTMLInputElement;
  await waitFor(()=>expect(base.value).toBe(settings.config.base_url));
  fireEvent.change(base,{target:{value:next.config.base_url}});
  fireEvent.blur(base);
  fireEvent.change(base,{target:{value:settings.config.base_url}});
  const clear = screen.getByRole("button",{name:"清除已保存的 API Key"});
  expect(clear.hasAttribute("disabled")).toBe(true);
  await act(async()=>{finish(next);});
  expect(base.value).toBe(settings.config.base_url);
  expect(clear.hasAttribute("disabled")).toBe(true);
  await userEvent.click(clear);
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({type:"save_settings",api_key:""}));
  fireEvent.blur(base);
  await waitFor(()=>expect(clear.hasAttribute("disabled")).toBe(false));
  await userEvent.click(clear);
  expect(api).toHaveBeenLastCalledWith({type:"save_settings",config:settings.config,api_key:""});
});
