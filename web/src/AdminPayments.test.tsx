import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminPayments } from "./AdminPayments";
import { setAccount, storageKey } from "../../shared/cloud/accountClient";
import type { AdministrationPaymentOrder } from "./contracts.generated";
const id = 'a'.repeat(32), requestId = '11111111-1111-4111-8111-111111111111';
const order: AdministrationPaymentOrder = {id,requestId,ownerId:'customer',createdAt:'2026-11-09T00:00:00Z',state:'PAID',amount:'39.00',subject:'Plus test order',environment:'production',refunds:[],productId:'plus',providerClosed:false,grant:{orderId:id,productId:'plus',state:'active',totalPages:100,usedPages:0,remainingPages:100,expiresAt:'2026-12-09T00:00:00Z'}};
beforeEach(() => { localStorage.clear(); setAccount({user:{id:'admin',email:'admin@example.test',name:'',role:'admin',enabled:true},csrf:'test-csrf',registrationEnabled:true}); });
afterEach(() => { cleanup(); setAccount(null); vi.restoreAllMocks(); });
function setup(options: {lost?:boolean; reject?:boolean; readFailure?:boolean; pageFull?:boolean} = {}) {
  const current = structuredClone(order); let writes=0, succeed=false;
  const calls: {path:string;method:string;body:Record<string,unknown>}[]=[];
  vi.stubGlobal('fetch',vi.fn(async(path:string,init:RequestInit)=>{
    const method=init.method||'GET', body=init.body?JSON.parse(String(init.body)):{};calls.push({path,method,body});
    if(path.includes('/refunds/')&&path.endsWith('/query')) {
      if(succeed) {current.refunds[0].state='SUCCESS';current.grant!.state='refunded';}
      return Response.json(current.refunds[0]);
    }
    if(path.endsWith('/refunds')) {
      writes++;
      if(options.reject)return Response.json({detail:{code:'PASSWORD_REQUIRED'}},{status:403});
      if(!current.refunds.length)current.refunds=[{id:String(body.requestId),amount:String(body.amount),state:'UNKNOWN'}];
      current.grant!.state='refund_pending';
      if(options.lost&&writes===1)throw new TypeError('Connection lost');
      return Response.json(current.refunds[0]);
    }
    if(path.endsWith('/query'))return Response.json(current);
    if(path.startsWith('/api/admin/payments?')) {
      if(options.readFailure)throw Error('Cannot read orders');
      return Response.json(options.pageFull ? Array.from({length:50},(_,i)=>({...current,id:i.toString(16).padStart(32,'0')})) : [current]);
    }
    if(path===`/api/admin/payments/${id}`)return Response.json(current);
    throw Error('Unexpected request '+path);
  }));
  return {calls,current,confirm:()=>{succeed=true;}};
}
async function select() { await userEvent.click(await screen.findByRole('button',{name:'查看订单 '+id})); }
async function fill() {
  await userEvent.type(screen.getByLabelText('管理员当前密码'),'private-current-password');
  await userEvent.clear(screen.getByLabelText('退款金额（元）'));await userEvent.type(screen.getByLabelText('退款金额（元）'),'39.00');
  await userEvent.type(screen.getByLabelText('退款原因'),'Requested full refund');
}
it('lists, looks up and queries orders passively before explicit refund',async()=>{
  const {calls}=setup();render(<AdminPayments/>);await select();
  expect(screen.getByText(/已用或预留 0 \/ 100/)).toBeTruthy();expect(calls.every(c=>c.method==='GET')).toBe(true);
  await userEvent.click(screen.getByRole('button',{name:'读取原订单'}));
  await userEvent.click(screen.getByRole('button',{name:'查询支付宝订单'}));
  await waitFor(()=>expect(calls.some(c=>c.path===`/api/admin/payments/${id}/query`)).toBe(true));
  expect(calls.some(c=>c.path.endsWith('/refunds'))).toBe(false);
});
it('retains a lost refund across remount, retries only the original request and reconciles it',async()=>{
  const {calls,confirm}=setup({lost:true});const view=render(<AdminPayments/>);await select();await fill();
  await userEvent.click(screen.getByRole('button',{name:'确认发起退款'}));
  await screen.findByRole('alert');expect(screen.getByLabelText('管理员当前密码')).toHaveProperty('value','');
  const key=storageKey('practiq-admin-refund-v1'),saved=JSON.parse(localStorage.getItem(key)!);
  expect(saved).toMatchObject({orderId:id,amount:'39.00',reason:'Requested full refund'});
  expect(JSON.stringify(saved)).not.toContain('private-current-password');
  view.unmount();render(<AdminPayments/>);await select();
  expect(calls.filter(c=>c.path.endsWith('/refunds'))).toHaveLength(1);
  await userEvent.type(screen.getByLabelText('管理员当前密码'),'private-current-password');
  await userEvent.click(screen.getByRole('button',{name:'显式重试原退款'}));
  await screen.findByText(/退款结果待确认，权益保持冻结/);
  const writes=calls.filter(c=>c.path.endsWith('/refunds'));expect(writes).toHaveLength(2);expect(writes[0].body).toEqual(writes[1].body);
  confirm();await userEvent.click(screen.getByRole('button',{name:'查询退款 '+saved.requestId}));
  await screen.findByText('原退款已确认成功。');expect(localStorage.getItem(key)).toBeNull();
  expect(calls.filter(c=>c.path.endsWith('/refunds'))).toHaveLength(2);
});
it('clears only definitively rejected refund intents and never stores passwords',async()=>{
  setup({reject:true});render(<AdminPayments/>);await select();await fill();
  await userEvent.click(screen.getByRole('button',{name:'确认发起退款'}));await screen.findByText('请核对当前密码。');
  expect(localStorage.getItem(storageKey('practiq-admin-refund-v1'))).toBeNull();
});
it('blocks new refunds when a retained recovery record is malformed',async()=>{
  const key=storageKey('practiq-admin-refund-v1');localStorage.setItem(key,'{bad');
  setup();render(<AdminPayments/>);await select();expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.getByRole('button',{name:'确认发起退款'})).toHaveProperty('disabled',true);
  expect(localStorage.getItem(key)).toBe('{bad');
});
it('shows read failures and supports bounded list navigation and refresh',async()=>{
  const {calls}=setup({pageFull:true});render(<AdminPayments/>);
  await userEvent.click(await screen.findByRole('button',{name:'下一页'}));
  await waitFor(()=>expect(calls.some(c=>c.path.endsWith('offset=50'))).toBe(true));
  await userEvent.click(screen.getByRole('button',{name:'上一页'}));await userEvent.click(screen.getByRole('button',{name:'刷新订单'}));
  cleanup();setup({readFailure:true});render(<AdminPayments/>);await screen.findByRole('alert');
});
it('does not send a refund when local recovery persistence fails',async()=>{
  const {calls}=setup();render(<AdminPayments/>);await select();await fill();
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('storage unavailable');});
  await userEvent.click(screen.getByRole('button',{name:'确认发起退款'}));await screen.findByRole('alert');
  expect(calls.some(c=>c.path.endsWith('/refunds'))).toBe(false);
});
it('does not overwrite an unconfirmed refund created by another window',async()=>{
  const {calls}=setup();render(<AdminPayments/>);await select();await fill();
  const key=storageKey('practiq-admin-refund-v1');
  const other={orderId:id,requestId,amount:'39.00',reason:'Original request from another window'};
  localStorage.setItem(key,JSON.stringify(other));
  await userEvent.click(screen.getByRole('button',{name:'确认发起退款'}));
  await screen.findByText('另一个窗口有未确认退款，请先核对保留的原请求。');
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(other);
  expect(calls.some(c=>c.path.endsWith('/refunds'))).toBe(false);
  expect(screen.getByLabelText('退款原因')).toHaveProperty('value',other.reason);
});
it('reconciles a retained successful refund after provider closure without another refund',async()=>{
  const {calls,current}=setup();
  const key=storageKey('practiq-admin-refund-v1');
  localStorage.setItem(key,JSON.stringify({orderId:id,requestId,amount:'39.00',reason:'Response lost before verified provider closure'}));
  current.providerClosed=true;current.refunds=[{id:requestId,amount:'39.00',state:'SUCCESS'}];current.grant!.state='refunded';
  render(<AdminPayments/>);await select();
  expect(screen.getByRole('button',{name:'显式重试原退款'})).toHaveProperty('disabled',true);
  const query=screen.getByRole('button',{name:'查询退款 '+requestId});expect(query).toHaveProperty('disabled',false);
  await userEvent.click(query);await screen.findByText('原退款已确认成功。');
  expect(localStorage.getItem(key)).toBeNull();
  expect(screen.queryByText(/保留的退款请求/)).toBeNull();
  expect(calls.some(c=>c.path.endsWith('/refunds'))).toBe(false);
});
