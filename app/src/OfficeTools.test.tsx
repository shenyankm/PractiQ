// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OfficeTools } from "./OfficeTools";
import { office } from "./office-api";
vi.mock("./office-api", () => ({ office: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

it("exports locally without model settings and shows the output", async () => {
  vi.mocked(office).mockResolvedValue({ paths: ["/tmp/source.docx.pdf"], count: 1 } as never);
  render(<OfficeTools mode="pdf" onMode={vi.fn()} busy={false}/>);
  fireEvent.click(screen.getByRole("button", {name:"转换／提取文件"}));
  expect(await screen.findByText("/tmp/source.docx.pdf")).toBeTruthy();
  expect(office).toHaveBeenCalledExactlyOnceWith({type:"convert",mode:"pdf"});
});

it("checks bundled capabilities without external executable controls", async () => {
  vi.mocked(office).mockResolvedValue({path:"/opt/soffice",version:"LibreOffice 26.2",capabilities:{writer_pdf:true,writer_text:true,calc_pdf:false,calc_text:false},errors:{}});
  render(<OfficeTools mode="pdf" onMode={vi.fn()} busy={false}/>);
  fireEvent.click(screen.getByRole("button", {name:"检查转换组件"}));
  expect(await screen.findByText("LibreOffice 26.2")).toBeTruthy();
  expect(screen.getByText("Excel → 分表 CSV：不可用")).toBeTruthy();
  expect(screen.queryByText("/opt/soffice")).toBeNull();
  for (const name of ["下载 LibreOffice", "选择程序位置", "恢复自动查找"]) expect(screen.queryByRole("button", {name})).toBeNull();
  vi.mocked(office).mockResolvedValue({path:null,version:null,capabilities:{writer_pdf:false,writer_text:false,calc_pdf:false,calc_text:false},errors:{}});
  fireEvent.click(screen.getByRole("button", {name:"检查转换组件"}));
  expect(await screen.findByText("内置转换组件缺失或损坏，请重新安装 PractiQ。")).toBeTruthy();
});

it("warns about hidden sheets and cancels an in-flight local conversion", async () => {
  let reject: (error: Error) => void = () => {};
  vi.mocked(office).mockImplementation(request => request.type === "cancel" ? Promise.resolve(null) : new Promise((_resolve, fail) => { reject = fail; }));
  const onMode = vi.fn();
  render(<OfficeTools mode="text" onMode={onMode} busy={false}/>);
  expect(screen.getByText(/包括隐藏表/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Word / Excel 处理方式"), {target:{value:"pdf"}});
  expect(onMode).toHaveBeenCalledWith("pdf");
  fireEvent.click(screen.getByRole("button", {name:"转换／提取文件"}));
  expect(office).toHaveBeenCalledWith({type:"convert",mode:"text"});
  fireEvent.click(screen.getByRole("button", {name:"取消本机转换"}));
  await waitFor(() => expect(office).toHaveBeenCalledWith({type:"cancel"}));
  await act(async () => reject(new Error("cancelled")));
  expect(screen.getByRole("alert").textContent).toContain("cancelled");
});
