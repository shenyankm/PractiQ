// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ImportBankDialog } from "./ImportBankDialog";
import { api, type Preview } from "./api";

vi.mock("./api", async () => ({ ...await vi.importActual("./api"), api: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function mount(status="PARTIAL") {
  const preview:Preview={ticket:"ticket",title:"Snapshot",count:3,reviewCount:0,warnings:[],status,processing:null,missingAssets:[],assetCount:0};
  const imported=vi.fn();
  render(<ImportBankDialog preview={preview} banks={[{id:"bank",title:"Existing",count:2}]} initialBank="new" busy={false} run={job=>void job()} onClose={vi.fn()} onImported={imported}/>);
  return imported;
}
it.each(["PARTIAL","SUCCEEDED"])("previews duplicates passively and applies explicit skip for %s",async status=>{
  const user=userEvent.setup();
  vi.mocked(api).mockImplementation(async request=>request.type==="import_duplicates" ? {groups:[{id:"group",stem:"Shared material",count:2}],check:"comparison"} as never : {bankId:"bank",count:1,duplicate:false,skippedCount:2} as never);
  const imported=mount(status);expect(api).not.toHaveBeenCalled();
  await user.selectOptions(screen.getByLabelText("导入到"),"bank");
  await screen.findByText("发现完全相同的 1 组 / 2 题。");
  expect(api).toHaveBeenCalledExactlyOnceWith({type:"import_duplicates",ticket:"ticket",bank_id:"bank"});
  await user.selectOptions(screen.getByLabelText("重复题处理"),"skip");
  await user.click(screen.getByRole("button",{name:"确认导入"}));
  await waitFor(()=>expect(imported).toHaveBeenCalledWith("bank"));
  expect(api).toHaveBeenLastCalledWith({type:"import",ticket:"ticket",bank_id:"bank",title:"Snapshot",skip_duplicates:true,duplicate_check:"comparison"});
});
it("shows read failure and retries without starting import",async()=>{
  const user=userEvent.setup();vi.mocked(api).mockRejectedValueOnce(Error("Compare failed")).mockResolvedValueOnce({groups:[],check:"new"} as never);mount();
  await user.selectOptions(screen.getByLabelText("导入到"),"bank");await screen.findByRole("alert");
  expect(screen.getByRole("button",{name:"确认导入"}).hasAttribute("disabled")).toBe(true);
  await user.click(screen.getByRole("button",{name:"重试重复题检查"}));
  await screen.findByText("发现完全相同的 0 组 / 0 题。");
  expect(screen.getByRole("button",{name:"确认导入"}).hasAttribute("disabled")).toBe(false);expect(api).toHaveBeenCalledTimes(2);
});
it("ignores a late comparison after changing destination",async()=>{
  const user=userEvent.setup();let finish!:(value:unknown)=>void;
  vi.mocked(api).mockImplementation(async request=>request.type==="import_duplicates" ? await new Promise<unknown>(resolve=>{finish=resolve;}) as never : {bankId:"new",count:3,duplicate:false} as never);
  mount();await user.selectOptions(screen.getByLabelText("导入到"),"bank");
  await user.selectOptions(screen.getByLabelText("导入到"),"new");finish({groups:[{id:"x",stem:"Late",count:2}],check:"late"});
  await user.click(screen.getByRole("button",{name:"确认导入"}));
  await waitFor(()=>expect(api).toHaveBeenLastCalledWith({type:"import",ticket:"ticket",bank_id:null,title:"Snapshot"}));expect(screen.queryByLabelText("重复题处理")).toBeNull();
});
