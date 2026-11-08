// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Payments } from "../../shared/cloud/Payments";
import { setAccount } from "../../shared/cloud/accountClient";
import { setNativeBridge, type NativeBridge } from "../../shared/cloud/transport";
import type { AccountPlan, PaymentOrder } from "./contracts.generated";
const catalog: AccountPlan = {
  environment:"sandbox", checkoutEnabled:true, sandboxAmount:"0.01",
  balance:{plan:"free",expiresAt:null,activeTasks:1,freePages:50,freeUsedPages:0,freeRemainingPages:50,remainingPages:50,grants:[]},
  products:[
    {id:"free",name:"Free",amount:"0.00",pages:50,durationDays:null,activeTasks:1,priority:false},
    {id:"plus",name:"Plus",amount:"39.00",pages:100,durationDays:30,activeTasks:2,priority:false},
    {id:"pro",name:"Pro",amount:"99.00",pages:300,durationDays:30,activeTasks:3,priority:true},
    {id:"pages50",name:"50 页加量包",amount:"19.90",pages:50,durationDays:365,activeTasks:1,priority:false},
  ],
};
const id="1".repeat(32),requestId="11111111-1111-4111-8111-111111111111";
const order=(state:PaymentOrder["state"],environment:PaymentOrder["environment"]="sandbox"):PaymentOrder=>({id,requestId,environment,amount:"0.01",subject:"Saved order",state,refunds:[],productId:"plus"});
function fixture(initial:PaymentOrder[]=[],enabled=true){
 let orders=initial,current:AccountPlan={...catalog,checkoutEnabled:enabled};
 const checkout=vi.fn(async(_requestId:string,_orderId?:string,_productId?:string)=>{});
 const fetch=vi.fn(async(path:string,init:RequestInit)=>{
  if(init.method!=="GET")return Response.json({ok:true});
  return Response.json(path==="/api/me/plans"?current:orders);
 });
 setNativeBridge({origin:"https://cloud.test",checkout,fetch} as unknown as NativeBridge);
 setAccount({user:{id:"owner",email:"test@example.test",name:"",role:"user",enabled:true},csrf:"",registrationEnabled:true});
 return {checkout,fetch,setCatalog:(next:AccountPlan)=>{current=next;},setOrders:(next:PaymentOrder[])=>{orders=next;}};
}
afterEach(()=>{cleanup();setAccount(null);setNativeBridge(null);localStorage.clear();vi.restoreAllMocks();});
it("shows exact prices and available offline features while checkout is disabled",async()=>{
 const f=fixture([],false);render(<Payments/>);
 await screen.findByText(/支付当前未开通/);
 for(const name of ["购买 Plus","购买 Pro","购买 50 页加量包"])expect(screen.getByRole("button",{name}).hasAttribute("disabled")).toBe(true);
 expect(screen.getByText("¥39")).toBeTruthy();expect(screen.getByText("¥99")).toBeTruthy();
 expect(screen.getByText(/19.90，365 天有效/)).toBeTruthy();expect(screen.getByText(/无需登录即可离线使用/)).toBeTruthy();
 expect(f.checkout).not.toHaveBeenCalled();expect(f.fetch.mock.calls.every(([,init])=>init.method==="GET")).toBe(true);
});
it("passes the selected SKU with one durable identifier only after an explicit purchase",async()=>{
 const f=fixture();render(<Payments/>);const user=userEvent.setup();
 await screen.findByRole("heading",{name:"Plus"});expect(f.checkout).not.toHaveBeenCalled();
 await user.click(screen.getByRole("button",{name:"购买 Plus"}));
 expect(f.checkout).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^[a-f0-9-]{36}$/),undefined,"plus");
 await screen.findByText(/继续同一请求/);
 expect(screen.getByRole("button",{name:"购买 Pro"}).hasAttribute("disabled")).toBe(true);
});
it("blocks duplicate payment and resumes only the original server order",async()=>{
 const f=fixture([order("PENDING_PAYMENT")]);render(<Payments view="orders"/>);const user=userEvent.setup();
 await user.click(await screen.findByRole("button",{name:"继续原订单付款"}));
 expect(f.checkout).toHaveBeenCalledExactlyOnceWith(requestId,id);
 await user.click(screen.getByRole("button",{name:"查询支付结果"}));
 await user.click(screen.getByRole("button",{name:"关闭未付款订单"}));
 expect(f.fetch.mock.calls.filter(([,init])=>init.method==="POST").map(([path])=>path)).toEqual([`/api/me/payments/${id}/query`,`/api/me/payments/${id}/close`]);
});
it("retains a lost purchase across remount and clears only its matching terminal receipt",async()=>{
 const f=fixture();f.checkout.mockRejectedValue(new Error("lost response"));const user=userEvent.setup();
 const first=render(<Payments/>);await user.click(await screen.findByRole("button",{name:"购买 Pro"}));await screen.findByText(/操作未确认/);
 const original=f.checkout.mock.calls[0][0];first.unmount();render(<Payments/>);
 await user.click(await screen.findByRole("button",{name:"继续确认原购买"}));
 expect(f.checkout.mock.calls[1]).toEqual([original,undefined,"pro"]);
 f.setOrders([{...order("PAID"),requestId:original,productId:"pro"}]);
 await user.click(screen.getByRole("button",{name:"刷新额度"}));
 await waitFor(()=>expect(screen.queryByRole("button",{name:"继续确认原购买"})).toBeNull());
 await user.click(screen.getByRole("button",{name:"购买 Plus"}));
 expect(f.checkout.mock.calls[2][0]).not.toBe(original);
});
it("stops before checkout when durable storage cannot be written",async()=>{
 const f=fixture();render(<Payments/>);const user=userEvent.setup();await screen.findByRole("button",{name:"购买 Plus"});
 vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new Error("full");});
 await user.click(screen.getByRole("button",{name:"购买 Plus"}));await screen.findByText(/操作未确认/);expect(f.checkout).not.toHaveBeenCalled();
});
it("keeps sandbox and production recovery identifiers independent",async()=>{
 const f=fixture();f.checkout.mockRejectedValue(new Error("lost"));const user=userEvent.setup();render(<Payments/>);
 await user.click(await screen.findByRole("button",{name:"购买 Plus"}));await screen.findByText(/操作未确认/);
 const sandbox=f.checkout.mock.calls[0][0];f.setCatalog({...catalog,environment:"production",sandboxAmount:null});
 await user.click(screen.getByRole("button",{name:"刷新额度"}));
 await waitFor(()=>expect(screen.queryByRole("button",{name:"继续确认原购买"})).toBeNull());
 await user.click(screen.getByRole("button",{name:"购买 Pro"}));await screen.findByText(/操作未确认/);
 const production=f.checkout.mock.calls[1][0];expect(production).not.toBe(sandbox);
 f.setCatalog(catalog);await user.click(screen.getByRole("button",{name:"刷新额度"}));
 await user.click(await screen.findByRole("button",{name:"继续确认原购买"}));expect(f.checkout.mock.calls[2]).toEqual([sandbox,undefined,"plus"]);
});
it("fails closed on malformed recovery and on a legacy request with unknown environment",async()=>{
 const f=fixture();localStorage.setItem("practiq-plan-request-v1.service.https%3A%2F%2Fcloud.test.user.owner.sandbox","bad-json");
 const first=render(<Payments/>);await screen.findByText(/付款恢复记录无法读取/);
 expect(screen.getByRole("button",{name:"购买 Plus"}).hasAttribute("disabled")).toBe(true);first.unmount();localStorage.clear();
 localStorage.setItem("practiq-payment-request-v1.service.https%3A%2F%2Fcloud.test.user.owner",requestId);
 render(<Payments/>);await screen.findByText(/旧版未确认付款请求/);expect(f.checkout).not.toHaveBeenCalled();
});
it("renders paid expiry and frozen or expired grants without claiming spendable pages",async()=>{
 const f=fixture();f.setCatalog({...catalog,balance:{...catalog.balance,plan:"plus",expiresAt:"2026-12-01T00:00:00Z",remainingPages:75,grants:[{orderId:id,productId:"pages50",totalPages:50,usedPages:0,remainingPages:0,expiresAt:"2026-12-01T00:00:00Z",state:"refund_pending"}]}});
 render(<Payments/>);await screen.findByText("退款待确认，额度已冻结");
 expect(screen.getByText(/不自动续费/)).toBeTruthy();
 expect(screen.getAllByRole("button",{name:"当前套餐到期后可购买"}).every(button=>button.hasAttribute("disabled"))).toBe(true);
 expect(screen.getByRole("button",{name:"购买 50 页加量包"}).hasAttribute("disabled")).toBe(false);
});

it("stops new checkout after a failed balance refresh until a successful manual read",async()=>{
 const f=fixture();render(<Payments/>);const user=userEvent.setup();await screen.findByRole("button",{name:"购买 Plus"});
 f.fetch.mockRejectedValueOnce(new Error("disconnected"));await user.click(screen.getByRole("button",{name:"刷新额度"}));
 await screen.findByText(/套餐与订单读取失败/);expect(screen.queryByRole("button",{name:"购买 Plus"})).toBeNull();
 expect(f.checkout).not.toHaveBeenCalled();await user.click(screen.getByRole("button",{name:"刷新额度"}));
 await screen.findByRole("button",{name:"购买 Plus"});
});

it("shows verified provider closure separately from historical payment and hides retry controls",async()=>{
 const f=fixture([{...order("PAID"),providerClosed:true}]);render(<Payments view="orders"/>);
 await screen.findByText(/支付宝交易已关闭，权益已停止/);
 expect(screen.queryByRole("button",{name:"继续原订单付款"})).toBeNull();expect(f.checkout).not.toHaveBeenCalled();
});
