// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Payments } from "../../shared/cloud/Payments";
import { setAccount } from "../../shared/cloud/accountClient";
import { setNativeBridge, type NativeBridge } from "../../shared/cloud/transport";
import type { PaymentOffer, PaymentOrder } from "./contracts.generated";
const offer: PaymentOffer = { environment: "sandbox", amount: "0.01", subject: "Sandbox test" };
const id = "1".repeat(32), requestId = "11111111-1111-4111-8111-111111111111";
const order = (state: PaymentOrder["state"], environment: PaymentOrder["environment"] = "sandbox"): PaymentOrder => ({ id, requestId, environment, amount: "0.01", subject: "Saved order", state, refunds: [] });
function fixture(initial: PaymentOrder[] = [], disabled = false) {
  let orders = initial; let currentOffer = offer;
  const checkout = vi.fn(async (_requestId: string, _orderId?: string) => {});
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    if (init.method !== "GET") return Response.json({ok:true});
    if (path.endsWith("/offer")) return Response.json(disabled ? {detail:{code:"PAYMENT_DISABLED"}} : currentOffer, {status:disabled ? 503 : 200});
    return Response.json(orders);
  });
  setNativeBridge({ origin: "https://cloud.test", checkout, fetch } as unknown as NativeBridge);
  setAccount({user:{id:"owner",email:"test@example.test",name:"",role:"user",enabled:true},csrf:"",registrationEnabled:true});
  return { checkout, fetch, setOffer: (next: PaymentOffer) => {currentOffer=next;}, setOrders: (next: PaymentOrder[]) => {orders=next;} };
}
afterEach(() => { cleanup(); setAccount(null); setNativeBridge(null); localStorage.clear(); vi.restoreAllMocks(); });
it("reads disabled payment history passively without attempting a checkout", async () => {
  const f=fixture([],true); render(<Payments />);
  await screen.findByText(/支付当前未开通/);
  expect(screen.queryByRole("button",{name:"前往支付宝付款"})).toBeNull();
  expect(f.checkout).not.toHaveBeenCalled(); expect(f.fetch.mock.calls.every(([,init])=>init.method==="GET")).toBe(true);
});
it("blocks a new payment for an unresolved current-environment order and resumes its original identifier", async () => {
  const f=fixture([order("PENDING_PAYMENT")]); render(<Payments />); const user=userEvent.setup();
  await waitFor(()=>expect(screen.getByRole("button",{name:"前往支付宝付款"}).hasAttribute("disabled")).toBe(true));
  await user.click(screen.getByRole("button",{name:"继续原订单付款"}));
  expect(f.checkout).toHaveBeenCalledExactlyOnceWith(requestId,id);
  await user.click(screen.getByRole("button",{name:"查询支付结果"}));
  await user.click(screen.getByRole("button",{name:"关闭未付款订单"}));
  expect(f.fetch.mock.calls.filter(([,init])=>init.method==="POST").map(([path])=>path)).toEqual([`/api/me/payments/${id}/query`,`/api/me/payments/${id}/close`]);
});
it("keeps an uncertain create request across remount and rotates only its matching terminal receipt", async () => {
  const f=fixture([order("UNKNOWN","production")]); f.checkout.mockRejectedValue(new Error("lost response"));
  const user=userEvent.setup(); const first=render(<Payments />);
  await user.click(await screen.findByRole("button",{name:"前往支付宝付款"}));
  await screen.findByText(/操作未确认/);
  const original=f.checkout.mock.calls[0][0];
  first.unmount(); render(<Payments />);
  await user.click(await screen.findByRole("button",{name:"前往支付宝付款"}));
  await waitFor(()=>expect(f.checkout).toHaveBeenCalledTimes(2));
  expect(f.checkout.mock.calls[1][0]).toBe(original);
  f.setOrders([{...order("PAID"),requestId:original}]);
  await user.click(screen.getByRole("button",{name:"刷新订单"}));
  await screen.findByText(/已付款/);
  await user.click(screen.getByRole("button",{name:"前往支付宝付款"}));
  await waitFor(()=>expect(f.checkout).toHaveBeenCalledTimes(3));
  expect(f.checkout.mock.calls[2][0]).not.toBe(original);
});
it("stops before payment when durable recovery storage cannot be written", async () => {
  const f=fixture(); render(<Payments />); const user=userEvent.setup();
  await screen.findByRole("button",{name:"前往支付宝付款"});
  vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new Error("full");});
  await user.click(screen.getByRole("button",{name:"前往支付宝付款"}));
  await screen.findByText(/操作未确认/); expect(f.checkout).not.toHaveBeenCalled();
});

it("retains separate recovery requests across sandbox and production offer switches",async()=>{
 const f=fixture();f.checkout.mockRejectedValue(new Error("lost response"));const user=userEvent.setup();render(<Payments/>);
 await user.click(await screen.findByRole("button",{name:"前往支付宝付款"}));await screen.findByText(/操作未确认/);
 const sandbox=f.checkout.mock.calls[0][0];f.setOrders([{...order("UNKNOWN"),requestId:sandbox}]);
 f.setOffer({...offer,environment:"production"});await user.click(screen.getByRole("button",{name:"刷新订单"}));
 await screen.findByText(/正式收款/);await user.click(screen.getByRole("button",{name:"前往支付宝付款"}));
 await waitFor(()=>expect(f.checkout).toHaveBeenCalledTimes(2));const production=f.checkout.mock.calls[1][0];expect(production).not.toBe(sandbox);
 f.setOrders([]);f.setOffer(offer);await user.click(screen.getByRole("button",{name:"刷新订单"}));await screen.findByText(/沙箱体验/);
 await user.click(screen.getByRole("button",{name:"前往支付宝付款"}));await waitFor(()=>expect(f.checkout).toHaveBeenCalledTimes(3));
 expect(f.checkout.mock.calls[2][0]).toBe(sandbox);
});
it("preserves an unresolved legacy recovery record without reusing it in another environment",async()=>{
 const f=fixture([order("UNKNOWN")]);f.setOffer({...offer,environment:"production"});
 localStorage.setItem("practiq-payment-request-v1.service.https%3A%2F%2Fcloud.test.user.owner",requestId);
 render(<Payments/>);const user=userEvent.setup();await user.click(await screen.findByRole("button",{name:"前往支付宝付款"}));
 await waitFor(()=>expect(f.checkout).toHaveBeenCalledTimes(1));expect(f.checkout.mock.calls[0][0]).not.toBe(requestId);
 expect(localStorage.getItem("practiq-payment-request-v1.service.https%3A%2F%2Fcloud.test.user.owner")).toBe(requestId);
});
