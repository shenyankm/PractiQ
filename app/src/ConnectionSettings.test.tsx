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
const settings: SettingsResult = {config:{service_url:"https://example.com/v1"},hasServiceToken:true};
function mount() {
  render(<ConnectionSettingsPanel busy={false} run={job=>{void job();}}/>);
}

it("retries service configuration reads in place without testing or exposing credentials", async () => {
  const configured = { config: { service_url: "http://127.0.0.1:8000" }, hasServiceToken: null };
  let reads = 0;
  vi.mocked(api).mockImplementation(async request => {
    if (request.type !== "settings") throw Error("Unexpected operation");
    if (++reads === 1) throw Error("Settings temporarily unavailable");
    return configured as never;
  });
  mount();
  expect((await screen.findByRole("alert")).textContent).toContain("Settings temporarily unavailable");
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  const address = await screen.findByLabelText("AI 服务地址") as HTMLInputElement;
  await waitFor(() => expect(address.value).toBe(configured.config.service_url));
  expect((screen.getByLabelText("AI 服务访问令牌") as HTMLInputElement).value).toBe("");
  expect(screen.queryByLabelText("模型 ID")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(vi.mocked(api).mock.calls.map(([request]) => request.type)).toEqual(["settings", "settings"]);
});

it("keeps blank autosaves non-destructive and removes a stored key only through the explicit action", async () => {
  vi.mocked(api).mockImplementation(async request => request.type === "save_settings" ? {...settings,hasServiceToken:request.service_token !== ""} as never : settings as never);
  mount();
  const key = await screen.findByLabelText("AI 服务访问令牌");
  await waitFor(()=>expect((screen.getByLabelText("AI 服务地址") as HTMLInputElement).value).toBe("https://example.com/v1"));
  await userEvent.type(key," ");
  await userEvent.tab();
  await waitFor(()=>expect(api).toHaveBeenCalledWith({type:"save_settings",config:settings.config,service_token:null}));
  const clear = screen.getByRole("button",{name:"清除已保存的访问令牌"});
  await userEvent.click(clear);
  await waitFor(()=>expect(api).toHaveBeenCalledWith({type:"save_settings",config:settings.config,service_token:""}));
  expect(clear.hasAttribute("disabled")).toBe(true);
  expect((key as HTMLInputElement).placeholder).toBe("填写此服务对应的访问令牌");
});

it("keeps failed removals retryable and requires a replacement-key draft to save first", async () => {
  let fail = true;
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "save_settings") {
      if (fail) throw Error("Keychain is locked");
      return {...settings,hasServiceToken:request.service_token !== ""} as never;
    }
    return settings as never;
  });
  mount();
  const key = await screen.findByLabelText("AI 服务访问令牌") as HTMLInputElement;
  await waitFor(()=>expect((screen.getByLabelText("AI 服务地址") as HTMLInputElement).value).toBe("https://example.com/v1"));
  await userEvent.click(screen.getByRole("button",{name:"清除已保存的访问令牌"}));
  await waitFor(()=>expect(toast.error).toHaveBeenCalled());
  expect(key.placeholder).toBe("********************************");
  expect(api).toHaveBeenLastCalledWith({type:"save_settings",config:settings.config,service_token:""});
  fireEvent.change(key,{target:{value:"replacement-key"}});
  const clear = screen.getByRole("button",{name:"清除已保存的访问令牌"});
  expect(clear.hasAttribute("disabled")).toBe(true);
  await userEvent.click(clear);
  expect(key.value).toBe("replacement-key");
  expect(vi.mocked(api).mock.calls.filter(([request])=>request.type === "save_settings")).toHaveLength(1);
  fail = false;
  fireEvent.blur(key);
  await waitFor(()=>expect(key.value).toBe(""));
  await userEvent.click(screen.getByRole("button",{name:"清除已保存的访问令牌"}));
  await waitFor(()=>expect(key.placeholder).toBe("填写此服务对应的访问令牌"));
});

it("requires an earlier blur save to finish before accepting a clear action", async () => {
  let finish!: (value:SettingsResult)=>void;
  const pending = new Promise<SettingsResult>(resolve=>{finish=resolve;});
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "save_settings") return request.service_token === "" ? {...settings,config:request.config,hasServiceToken:false} as never : await pending as never;
    return settings as never;
  });
  mount();
  const model = await screen.findByLabelText("AI 服务地址") as HTMLInputElement;
  await waitFor(()=>expect(model.value).toBe("https://example.com/v1"));
  fireEvent.change(model,{target:{value:"https://updated.example.com"}});
  fireEvent.blur(model);
  await waitFor(()=>expect(api).toHaveBeenCalledWith(expect.objectContaining({type:"save_settings",service_token:null})));
  const clear = screen.getByRole("button",{name:"清除已保存的访问令牌"});
  expect(clear.hasAttribute("disabled")).toBe(true);
  await userEvent.click(clear);
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({type:"save_settings",service_token:""}));
  await act(async()=>{finish({...settings,config:{...settings.config,service_url:"https://updated.example.com"}});});
  await waitFor(()=>expect(clear.hasAttribute("disabled")).toBe(false));
  await userEvent.click(clear);
  await waitFor(()=>expect(api).toHaveBeenLastCalledWith({type:"save_settings",config:{...settings.config,service_url:"https://updated.example.com"},service_token:""}));
  expect(screen.getByRole("button",{name:"清除已保存的访问令牌"}).hasAttribute("disabled")).toBe(true);
});

it("clears the displayed new endpoint only after its blur autosave succeeds", async () => {
  const next = {...settings,config:{...settings.config,service_url:"https://other.example.com/v1"}};
  let finish!: (value:SettingsResult)=>void;
  const pending = new Promise<SettingsResult>(resolve=>{finish=resolve;});
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "save_settings") return request.service_token === "" ? {...next,hasServiceToken:false} as never : await pending as never;
    return settings as never;
  });
  mount();
  const base = await screen.findByLabelText("AI 服务地址") as HTMLInputElement;
  await waitFor(()=>expect(base.value).toBe(settings.config.service_url));
  await userEvent.clear(base);
  await userEvent.type(base,next.config.service_url!);
  const clear = screen.getByRole("button",{name:"清除已保存的访问令牌"});
  expect(clear.hasAttribute("disabled")).toBe(true);
  await userEvent.tab();
  await userEvent.click(clear);
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({type:"save_settings",service_token:""}));
  await act(async()=>{finish(next);});
  await waitFor(()=>expect(clear.hasAttribute("disabled")).toBe(false));
  await userEvent.click(clear);
  expect(api).toHaveBeenLastCalledWith({type:"save_settings",config:next.config,service_token:""});
  expect(base.value).toBe(next.config.service_url);
});

it("does not turn a failed endpoint autosave into a credential deletion or overwrite its draft", async () => {
  let reject!: (error:Error)=>void;
  const pending = new Promise<SettingsResult>((_resolve,fail)=>{reject=fail;});
  vi.mocked(api).mockImplementation(async request => request.type === "save_settings" ? await pending as never : settings as never);
  mount();
  const base = await screen.findByLabelText("AI 服务地址") as HTMLInputElement;
  await waitFor(()=>expect(base.value).toBe(settings.config.service_url));
  await userEvent.clear(base);
  await userEvent.type(base,"https://other.example.com/v1");
  await userEvent.tab();
  await act(async()=>{reject(Error("Active grading prevents configuration changes"));});
  expect(await screen.findByRole("button",{name:"重试保存"})).toBeTruthy();
  const clear = screen.getByRole("button",{name:"清除已保存的访问令牌"});
  expect(clear.hasAttribute("disabled")).toBe(true);
  await userEvent.click(clear);
  expect(base.value).toBe("https://other.example.com/v1");
  expect(vi.mocked(api).mock.calls.every(([request])=>request.type !== "save_settings" || request.service_token === null)).toBe(true);
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({type:"save_settings",service_token:""}));
});

it("does not clear while a reverted endpoint draft still follows an older pending save", async () => {
  const next = {...settings,config:{...settings.config,service_url:"https://other.example.com/v1"}};
  let finish!: (value:SettingsResult)=>void;
  const pending = new Promise<SettingsResult>(resolve=>{finish=resolve;});
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "save_settings") return request.config.service_url === next.config.service_url ? await pending as never : {...settings,hasServiceToken:request.service_token !== ""} as never;
    return settings as never;
  });
  mount();
  const base = await screen.findByLabelText("AI 服务地址") as HTMLInputElement;
  await waitFor(()=>expect(base.value).toBe(settings.config.service_url));
  fireEvent.change(base,{target:{value:next.config.service_url}});
  fireEvent.blur(base);
  fireEvent.change(base,{target:{value:settings.config.service_url}});
  const clear = screen.getByRole("button",{name:"清除已保存的访问令牌"});
  expect(clear.hasAttribute("disabled")).toBe(true);
  await act(async()=>{finish(next);});
  expect(base.value).toBe(settings.config.service_url);
  expect(clear.hasAttribute("disabled")).toBe(true);
  await userEvent.click(clear);
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({type:"save_settings",service_token:""}));
  fireEvent.blur(base);
  await waitFor(()=>expect(clear.hasAttribute("disabled")).toBe(false));
  await userEvent.click(clear);
  expect(api).toHaveBeenLastCalledWith({type:"save_settings",config:settings.config,service_token:""});
});

it("retains connection test results inline and clears them when the address changes", async () => {
  const user=userEvent.setup();
  vi.mocked(api).mockImplementation(async request=>{
    if(request.type === "test_settings")throw new Error("Service temporarily unavailable");
    return settings as never;
  });
  mount(); await waitFor(()=>expect(screen.getByLabelText("AI 服务地址")).toHaveProperty("value",settings.config.service_url));
  await user.click(screen.getByRole("button",{name:"测试"}));
  expect((await screen.findByRole("alert")).textContent).toContain("Service temporarily unavailable");
  await user.type(screen.getByLabelText("AI 服务地址"),"/changed");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("clears the previous connection verdict when the saved token is removed", async () => {
  vi.mocked(api).mockResolvedValue(settings as never);
  mount();
  await waitFor(()=>expect(screen.getByLabelText("AI 服务地址")).toHaveProperty("value",settings.config.service_url));
  await userEvent.click(screen.getByRole("button",{name:"测试"}));
  expect((await screen.findByRole("status")).textContent).toContain("连接测试通过");
  await userEvent.click(screen.getByRole("button",{name:"清除已保存的访问令牌"}));
  expect(screen.queryByRole("status")).toBeNull();
});
