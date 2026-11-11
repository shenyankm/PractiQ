// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionSettingsPanel } from "./ConnectionSettings";
import { api, type SettingsResult } from "./api";

vi.mock("./api", async importOriginal => ({...await importOriginal<typeof import("./api")>(), api:vi.fn()}));
vi.mock("./notifications", () => ({toast:{success:vi.fn(),error:vi.fn()}}));
afterEach(() => {cleanup();vi.clearAllMocks();});
function mount() {
  render(<ConnectionSettingsPanel busy={false} run={job=>{void job();}}/>);
}

it("defaults empty installations to direct model access without reading keys or calling models", async () => {
  vi.mocked(api).mockResolvedValue({config:{service_url:null}} as never);
  mount();
  expect(await screen.findByLabelText("模型 API 地址")).toBeTruthy();
  expect(screen.getByLabelText("模型 ID")).toBeTruthy();
  expect((screen.getByLabelText("模型 API Key") as HTMLInputElement).value).toBe("");
  expect(screen.getByRole("button",{name:"测试连接"}).hasAttribute("disabled")).toBe(true);
  expect(vi.mocked(api).mock.calls.map(([request])=>request.type)).toEqual(["settings"]);
});

it("saves direct model keys separately and tests only after saving, with explicit clearing", async () => {
  const direct:SettingsResult={config:{service_url:"https://old-service.example.com",model:{base_url:"https://models.example.com/v1",model_id:"fixture-model"}},hasApiKey:false};
  vi.mocked(api).mockImplementation(async request => {
    if(request.type==="save_settings")return {...direct,config:request.config,hasApiKey:request.api_key!==""} as never;
    if(request.type==="test_settings")return null as never;
    return direct as never;
  });
  mount();
  const key=await screen.findByLabelText("模型 API Key") as HTMLInputElement;
  fireEvent.change(key,{target:{value:"dummy-model-key"}});
  fireEvent.blur(key);
  await waitFor(()=>expect(api).toHaveBeenCalledWith({type:"save_settings",config:direct.config,api_key:"dummy-model-key"}));
  await waitFor(()=>expect(key.value).toBe(""));
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({type:"test_settings"}));
  await userEvent.click(screen.getByRole("button",{name:"测试连接"}));
  await waitFor(()=>expect(api).toHaveBeenCalledWith({type:"test_settings",config:direct.config,api_key:null}));
  await userEvent.click(screen.getByRole("button",{name:"清除已保存的 API Key"}));
  await waitFor(()=>expect(api).toHaveBeenCalledWith({type:"save_settings",config:direct.config,api_key:""}));
});


it("saves and tests a personal service using its address alone", async () => {
  const config = { service_url: "http://127.0.0.1:8090" };
  vi.mocked(api).mockImplementation(async request => request.type === "test_settings" ? null as never : request.type === "save_settings" ? {config:request.config} as never : {config} as never);
  mount();
  const address = await screen.findByLabelText("AI 服务地址");
  expect(screen.queryByLabelText("AI 服务访问令牌")).toBeNull();
  expect(document.querySelector('input[type="password"]')).toBeNull();
  fireEvent.change(address, {target:{value:"http://127.0.0.1:8091"}});
  fireEvent.blur(address);
  await waitFor(() => expect(api).toHaveBeenCalledWith({type:"save_settings",config:{service_url:"http://127.0.0.1:8091"}}));
  expect(api).not.toHaveBeenCalledWith(expect.objectContaining({type:"test_settings"}));
  await userEvent.click(screen.getByRole("button",{name:"测试连接"}));
  await waitFor(() => expect(api).toHaveBeenCalledWith({type:"test_settings",config:{service_url:"http://127.0.0.1:8091"}}));
});
