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

it("preserves the entered replacement key after a failed removal and allows an explicit retry", async () => {
  let fail = true;
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "save_settings") {
      if (fail) throw Error("Keychain is locked");
      return {...settings,hasApiKey:false} as never;
    }
    return settings as never;
  });
  mount();
  const key = await screen.findByLabelText("API Key") as HTMLInputElement;
  await waitFor(()=>expect(key.hasAttribute("disabled")).toBe(false));
  fireEvent.change(key,{target:{value:"replacement-key"}});
  await userEvent.click(screen.getByRole("button",{name:"清除已保存的 API Key"}));
  await waitFor(()=>expect(toast.error).toHaveBeenCalled());
  expect(key.value).toBe("replacement-key");
  expect(api).toHaveBeenLastCalledWith({type:"save_settings",config:settings.config,api_key:""});
  fail = false;
  await userEvent.click(screen.getByRole("button",{name:"清除已保存的 API Key"}));
  await waitFor(()=>expect(key.value).toBe(""));
});

it("waits for an earlier blur save before clearing its key", async () => {
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
  await userEvent.click(screen.getByRole("button",{name:"清除已保存的 API Key"}));
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({type:"save_settings",api_key:""}));
  await act(async()=>{finish({...settings,config:{...settings.config,model_id:"updated"}});});
  await waitFor(()=>expect(api).toHaveBeenLastCalledWith({type:"save_settings",config:{...settings.config,model_id:"updated"},api_key:""}));
  expect(screen.getByRole("button",{name:"清除已保存的 API Key"}).hasAttribute("disabled")).toBe(true);
});
