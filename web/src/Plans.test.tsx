import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Payments } from "../../shared/cloud/Payments";
import type { AccountPlan } from "./contracts.generated";
afterEach(() => { cleanup();vi.restoreAllMocks();localStorage.clear(); });
it("renders the shared catalog and expired grant ledger without exposing browser checkout",async()=>{
 const plan:AccountPlan={checkoutEnabled:false,environment:null,sandboxAmount:null,products:[
 {id:"free",name:"Free",amount:"0.00",pages:50,durationDays:null,activeTasks:1,priority:false},
 {id:"plus",name:"Plus",amount:"39.00",pages:100,durationDays:30,activeTasks:2,priority:false},
 {id:"pro",name:"Pro",amount:"99.00",pages:300,durationDays:30,activeTasks:3,priority:true},
 {id:"pages50",name:"50 页加量包",amount:"19.90",pages:50,durationDays:365,activeTasks:1,priority:false}],
 balance:{plan:"free",expiresAt:null,activeTasks:1,freePages:50,freeUsedPages:12,freeRemainingPages:38,remainingPages:38,
 grants:[{orderId:"saved",productId:"plus",totalPages:100,usedPages:40,remainingPages:0,expiresAt:"2026-10-01T00:00:00Z",state:"expired"}]}};
 const fetcher=vi.fn(async(path:string)=>Response.json(path==="/api/me/plans"?plan:[]));vi.stubGlobal("fetch",fetcher);
 render(<Payments/>);await screen.findByRole("heading",{name:"当前套餐 · Free"});
 expect(screen.getByText("已到期")).toBeTruthy();expect(screen.getByText("¥39")).toBeTruthy();expect(screen.getByText("¥99")).toBeTruthy();
 expect(screen.getByRole("button",{name:"购买 Plus"})).toHaveProperty("disabled",true);
 expect(fetcher.mock.calls.map(([path])=>path).sort()).toEqual(["/api/me/payments","/api/me/plans"]);
});
