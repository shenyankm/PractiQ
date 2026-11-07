import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UserPortal from '../../shared/cloud/AccountPortal';
import AdminPortal from './AdminPortal';
function AccountPortal() { return location.pathname === '/admin' ? <AdminPortal /> : <UserPortal />; }
import { setAccount, storageKey } from '../../shared/cloud/accountClient';
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const anonymous = { user: null, csrf: 'test-csrf', registrationEnabled: true };
afterEach(() => { cleanup(); setAccount(null); vi.unstubAllGlobals(); history.replaceState(null,'','/'); });

it('keeps token and session deletion targets separate and refreshes failed reads after creation', async () => {
  const rows: {id:string;name:string}[] = [];
  let tokenReads = 0;
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/session') return response({...anonymous,user:{id:'owner',email:'owner@example.test',name:'',role:'user',enabled:true}});
    if (path === '/api/me/tokens' && init?.method === 'POST') {rows.push({id:'token-one',name:'macOS App'}); return response({token:'pq_grade_synthetic'});}
    if (path === '/api/me/tokens') return ++tokenReads === 1 ? response({},500) : response(rows);
    if (path === '/api/me/sessions') return response([{id:'session-one',lastSeen:'2026-11-07T00:00:00Z'}]);
    if (path === '/api/me/tokens/token-one' && init?.method === 'DELETE') {rows.length=0;return response({ok:true});}
    return response({items:[],hasMore:false});
  }); vi.stubGlobal('fetch',fetcher);
  render(<AccountPortal />); const user=userEvent.setup();
  await user.click(await screen.findByRole('button',{name:'账户与安全'}));
  await screen.findByText('请求失败 (500)');
  await user.type(screen.getByLabelText('当前密码',{selector:'#token-password'}),'synthetic-password');
  await user.click(screen.getByRole('button',{name:'创建个人评分令牌'}));
  const tokenRow=(await screen.findByText('token-one')).closest('tr')!;
  expect(screen.queryByText('请求失败 (500)')).toBeNull();
  await user.click(within(tokenRow).getByRole('button',{name:'选择'}));
  await user.click(within(screen.getByText('session-one').closest('tr')!).getByRole('button',{name:'选择'}));
  expect(screen.getByLabelText('令牌编号')).toHaveProperty('value','token-one');
  expect(screen.getByLabelText('会话编号')).toHaveProperty('value','session-one');
  await user.click(screen.getByRole('button',{name:'撤销指定令牌'}));
  await waitFor(()=>expect(screen.queryByText('token-one')).toBeNull());
  expect(screen.queryByLabelText('新评分令牌')).toBeNull();
  expect(fetcher.mock.calls.some(([path,init])=>path==='/api/me/tokens/token-one'&&init?.method==='DELETE')).toBe(true);
});

it('does not show a reset link for a different selected user when a response is delayed', async () => {
  history.replaceState(null,'','/admin');
  let finish!: (value:Response)=>void;
  const pending=new Promise<Response>(resolve=>{finish=resolve;});
  const users=['one','two'].map(id=>({id,email:`${id}@example.test`,name:'',role:'user',enabled:true,limits:{}}));
  const fetcher=vi.fn(async(path:string,_init?:RequestInit)=>{
    if(path==='/api/auth/session')return response({...anonymous,user:{...users[0],id:'admin',email:'admin@example.test',role:'admin'}});
    if(path==='/api/admin/settings')return response({registrationEnabled:true,freePages:50,modelCalls:1000,tencentCalls:50,activeTasks:2});
    if(path.startsWith('/api/admin/users?'))return response(users);
    if(path.endsWith('/reset-link'))return pending;
    return response({ok:true});
  });vi.stubGlobal('fetch',fetcher);
  render(<AccountPortal />);const user=userEvent.setup();
  await user.click(within((await screen.findByText('one@example.test')).closest('tr')!).getByRole('button',{name:'选择'}));
  await user.type(screen.getByLabelText('管理员当前密码',{selector:'#reset-admin-password'}),'synthetic-password');
  await user.click(screen.getByRole('button',{name:'生成一次性重置码'}));
  await user.click(within(screen.getByText('two@example.test').closest('tr')!).getByRole('button',{name:'选择'}));
  await act(async()=>{finish(response({path:'/reset-password#one-only'}));await pending;});
  expect(screen.getByLabelText('用户编号',{selector:'#user-id'})).toHaveProperty('value','two');
  expect(screen.getByLabelText('用户编号',{selector:'#user-id'})).toHaveProperty('readOnly',true);
  expect(screen.queryByLabelText('一次性重置码')).toBeNull();
  history.replaceState(null,'','/');
});

it('fetches the next administrator task page when paging without starting work', async () => {
  history.replaceState(null,'','/admin');
  const {summary}=await import('./test-fixtures');
  const fetcher=vi.fn(async(path:string,_init?:RequestInit)=>{
    if(path==='/api/auth/session')return response({...anonymous,user:{id:'admin',email:'admin@example.test',name:'',role:'admin',enabled:true}});
    if(path==='/api/admin/settings')return response({registrationEnabled:true,freePages:50,modelCalls:1000,tencentCalls:50,activeTasks:2});
    if(path.startsWith('/api/admin/users'))return response([]);
    if(path.startsWith('/api/admin/document-tasks?'))return response({items:[{...summary,fileName:path.includes('offset=20')?'second.txt':'first.txt'}],hasMore:!path.includes('offset=20')});
    return response({});
  });vi.stubGlobal('fetch',fetcher);
  render(<AccountPortal />);const user=userEvent.setup();
  await user.click(await screen.findByRole('button',{name:'任务'}));
  await user.click(screen.getByRole('button',{name:'读取任务'}));
  await screen.findByText(/first.txt/);
  await user.click(screen.getByRole('button',{name:'下一页'}));
  await screen.findByText(/second.txt/);
  expect(fetcher.mock.calls.every(([,init])=>!init?.method||init.method==='GET')).toBe(true);
  history.replaceState(null,'','/');
});

it('keeps administrator inspection and recovery available when preview loading fails', async () => {
  history.replaceState(null,'','/admin');
  const {task,summary,taskId,runId}=await import('./test-fixtures');
  let finish!: (value:Response)=>void;
  const pending=new Promise<Response>(resolve=>{finish=resolve;});
  const fetcher=vi.fn(async(path:string,_init?:RequestInit)=>{
    if(path==='/api/auth/session')return response({...anonymous,user:{id:'admin',email:'admin@example.test',name:'',role:'admin',enabled:true}});
    if(path==='/api/admin/settings')return response({registrationEnabled:true,freePages:50,modelCalls:1000,tencentCalls:50,activeTasks:2});
    if(path.startsWith('/api/admin/users'))return response([]);
    if(path.startsWith('/api/admin/document-tasks?'))return response({items:[summary],hasMore:false});
    if(path.includes('/preview'))return pending;
    return response({...task,runId,state:'RUNNING',allowedActions:['pause','interrupt']});
  });vi.stubGlobal('fetch',fetcher);
  render(<AccountPortal />);const user=userEvent.setup();
  await user.click(await screen.findByRole('button',{name:'任务'}));
  await user.click(await screen.findByRole('button',{name:taskId}));
  await screen.findByRole('heading',{name:'sample.docx'});
  expect(screen.getByRole('button',{name:'pause'})).toBeTruthy();
  await act(async()=>{finish(response({},500));await pending;});
  await screen.findByRole('alert');
  expect(screen.getByRole('heading',{name:'sample.docx'})).toBeTruthy();
  expect(screen.getByText(/fake-model/)).toBeTruthy();
  expect(screen.getByRole('button',{name:'interrupt'})).toBeTruthy();
  expect(fetcher.mock.calls.every(([,init])=>!init?.method||init.method==='GET')).toBe(true);
});

it('keeps administrator task details bound to the latest selection after a delayed read', async () => {
  history.replaceState(null,'','/admin');
  const {task,preview,summary,taskId,newTaskId}=await import('./test-fixtures');
  let finish!: (value:Response)=>void;
  const delayed=new Promise<Response>(resolve=>{finish=resolve;});
  const fetcher=vi.fn(async(path:string,_init?:RequestInit)=>{
    if(path==='/api/auth/session')return response({...anonymous,user:{id:'admin',email:'admin@example.test',name:'',role:'admin',enabled:true}});
    if(path==='/api/admin/settings')return response({registrationEnabled:true,freePages:50,modelCalls:1000,tencentCalls:50,activeTasks:2});
    if(path.startsWith('/api/admin/users'))return response([]);
    if(path.startsWith('/api/admin/document-tasks?'))return response({items:[summary,{...summary,threadId:newTaskId,fileName:'second.docx'}],hasMore:false});
    if(path.includes('/preview'))return response({...preview,threadId:path.includes(newTaskId)?newTaskId:taskId});
    if(path===`/api/admin/document-tasks/${taskId}`)return delayed;
    return response({...task,threadId:newTaskId,fileName:'second.docx'});
  });vi.stubGlobal('fetch',fetcher);
  render(<AccountPortal />);const user=userEvent.setup();
  await user.click(await screen.findByRole('button',{name:'任务'}));
  await user.click(await screen.findByRole('button',{name:taskId}));
  await user.click(screen.getByRole('button',{name:newTaskId}));
  await screen.findByRole('heading',{name:'second.docx'});
  await act(async()=>{finish(response(task));await delayed;});
  expect(screen.queryByRole('heading',{name:'sample.docx'})).toBeNull();
  expect(screen.getByRole('heading',{name:'second.docx'})).toBeTruthy();
  expect(fetcher.mock.calls.every(([,init])=>!init?.method||init.method==='GET')).toBe(true);
});
it('discards an older session response after a newer account reload completes', async () => {
  const {capabilities, taskId} = await import('./test-fixtures');
  let finishFirst!: (value: Response) => void;
  const first = new Promise<Response>(resolve => {finishFirst = resolve;});
  let reads = 0;
  const account = (id: string) => ({...anonymous,csrf:`csrf-${id}`,user:{id,email:`${id}@example.test`,name:'',role:'user',enabled:true}});
  const fetcher = vi.fn(async (path: string) => {
    if (path === '/api/auth/session') return ++reads === 1 ? first : response(account('new'));
    if (path === '/api/import-capabilities') return response(capabilities);
    if (path === '/api/import-settings') return response({revision:taskId,settings:{tencentConcurrency:5,readRetryCount:2,retryBaseSeconds:1,deduplicateQuestions:false,generateAnswers:false}});
    return response({items:[],hasMore:false});
  }); vi.stubGlobal('fetch',fetcher);
  render(<AccountPortal />);
  await waitFor(() => expect(reads).toBe(1));
  act(() => {window.dispatchEvent(new Event('practiq-session-expired'));});
  await screen.findByText('new@example.test');
  await act(async () => {finishFirst(response(account('old'))); await first;});
  expect(screen.queryByText('old@example.test')).toBeNull();
  expect(storageKey('draft')).toBe('draft.user.new');
});
it('loads an anonymous session and exposes login, registration and assisted recovery', async () => {
  const fetcher = vi.fn(async (_path: string, _init?: RequestInit) => response(anonymous)); vi.stubGlobal('fetch', fetcher);
  render(<AccountPortal />);
  expect(await screen.findByRole('heading', { name: '登录 PractiQ' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '注册账户' })).toBeTruthy();
  expect(screen.getByText(/忘记密码请联系管理员/)).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe('/api/auth/session');
});
it('submits login with session CSRF and retains a rejected login without replay', async () => {
  const fetcher = vi.fn(async (path: string, _init?: RequestInit) => path === '/api/auth/session' ? response(anonymous) : response({ detail: { code: 'INVALID_CREDENTIALS' } }, 401)); vi.stubGlobal('fetch', fetcher);
  render(<AccountPortal />); const user = userEvent.setup();
  await user.type(await screen.findByLabelText('登录邮箱'), 'one@example.test');
  await user.type(screen.getByLabelText('密码'), 'long-test-password');
  await user.click(screen.getByRole('button', { name: '登录' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '邮箱或密码错误，或账户已停用。');
  expect(fetcher.mock.calls.filter(([path]) => path === '/api/auth/login')).toHaveLength(1);
  const init = fetcher.mock.calls[1][1] as RequestInit;
  expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('test-csrf');
  expect(init.credentials).toBe('same-origin');
});
it('namespaces local recovery by authenticated user and never adopts old keys', () => {
  setAccount({ ...anonymous, user: { id: 'user-one', email: 'one@example.test', name: '', role: 'user', enabled: true } });
  expect(storageKey('practiq-import-intents-v1')).toBe('practiq-import-intents-v1.user.user-one');
  setAccount({ ...anonymous, user: { id: 'user-two', email: 'two@example.test', name: '', role: 'user', enabled: true } });
  expect(storageKey('practiq-import-intents-v1')).toBe('practiq-import-intents-v1.user.user-two');
});
it('lets an administrator select a user, change limits and issue a bounded reset link explicitly', async () => {
  history.replaceState(null, '', '/admin');
  const userRow = { id: 'selected-user', email: 'other@example.test', name: '', role: 'user', enabled: true, limits: { freePages:50 } };
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/session') return response({ ...anonymous, user: { ...userRow, id: 'admin', role: 'admin' } });
    if (path === '/api/admin/users?offset=0') return response([userRow]);
    if (path === '/api/admin/settings') return response({registrationEnabled:true,freePages:50,modelCalls:123,tencentCalls:9,activeTasks:3});
    if (path.endsWith('/reset-link')) return response({ path: '/reset-password#once-only-reset' });
    expect(init?.method).toBe('PATCH'); return response({ ok: true });
  }); vi.stubGlobal('fetch', fetcher);
  render(<AccountPortal />); const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '选择' }));
  expect(screen.getByLabelText('用户编号', { selector: '#user-id' })).toHaveProperty('value', 'selected-user');
  expect(screen.getByLabelText('每日模型调用数')).toHaveProperty('value', '123');
  const pages = screen.getByLabelText('免费页数总额度（含已用页数）');
  expect(pages).toHaveProperty('value', '50');
  await user.clear(pages); await user.type(pages, '75');
  await user.type(screen.getByLabelText('管理员当前密码', { selector: '#admin-password' }), 'long-test-password');
  await user.click(screen.getByRole('button', { name: '更新指定用户' }));
  await screen.findByText('操作已完成。');
  expect(fetcher.mock.calls.some(([path, init]) => path === '/api/admin/users/selected-user' && init?.method === 'PATCH')).toBe(true);
  const update = fetcher.mock.calls.find(([path, init]) => path === '/api/admin/users/selected-user' && init?.method === 'PATCH');
  expect(JSON.parse(update?.[1]?.body as string).limits.freePages).toBe(75);
  expect(JSON.parse(update?.[1]?.body as string).limits.modelCalls).toBe(123);
  await user.type(screen.getByLabelText('管理员当前密码', { selector: '#reset-admin-password' }), 'long-test-password');
  await user.click(screen.getByRole('button', { name: '生成一次性重置码' }));
  expect(await screen.findByLabelText('一次性重置码')).toHaveProperty('value', 'once-only-reset');
  history.replaceState(null, '', '/');
});
it('denies the administration UI to a normal user without fetching administrative records', async () => {
  history.replaceState(null, '', '/admin');
  const fetcher = vi.fn(async () => response({ ...anonymous, user: { id: 'ordinary', email: 'one@example.test', name: '', role: 'user', enabled: true } })); vi.stubGlobal('fetch', fetcher);
  render(<AccountPortal />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('没有管理权限。'));
  expect(fetcher).toHaveBeenCalledTimes(1);
  history.replaceState(null, '', '/');
});
it('keeps pending records bound to the original account and stops its client after a switch', async () => {
  const { Client } = await import('../../shared/cloud/api');
  const snapshot = (id: string) => ({ ...anonymous, user: { id, email: `${id}@example.test`, name: '', role: 'user' as const, enabled: true } });
  setAccount(snapshot('one')); const first = new Client();
  const sha = 'a'.repeat(64);
  const pending = { requestId: '11111111-1111-4111-8111-111111111111', graphId: 'document_parser', failurePolicy: 'return_partial', document: { sourceType: 'text', fileName: 'private-one.txt', mediaType: 'text/plain', sizeBytes: 4, sha256: sha, objectKey: `practiq-agent/sources/${sha}/source.txt` } };
  localStorage.setItem(storageKey('practiq-import-intents-v1'), JSON.stringify([pending]));
  setAccount(snapshot('two')); const second = new Client();
  expect(first.active).toBe(false);
  expect(second.pendingImports()).toEqual([]);
  expect(first.pendingImports()).toEqual([pending]);
  await expect(first.capabilities()).rejects.toHaveProperty('name','AbortError');
  localStorage.clear();
});
it('preserves selected source files across portal pages without submitting them', async () => {
  const { capabilities, taskId, summary, task, preview } = await import('./test-fixtures');
  let accountId='navigation';
  const fetcher = vi.fn(async (path: string) => {
    if (path === '/api/auth/session') return response({ ...anonymous, user: { id:accountId, email:`${accountId}@example.test`, name:'', role:'user', enabled:true } });
    if (path === '/api/import-capabilities') return response(capabilities);
    if (path === '/api/import-settings') return response({ revision:taskId, settings:{ tencentConcurrency:5, readRetryCount:2, retryBaseSeconds:1, deduplicateQuestions:false, generateAnswers:false } });
    if (path.startsWith('/api/me/banks')) return response({items:[summary],hasMore:false});
    if (path === `/api/document-tasks/${taskId}`) return response(task);
    if (path.includes(`/api/document-tasks/${taskId}/preview`)) return response(preview);
    if (path.startsWith('/api/me/usage')) return response({ limits:{freePages:50,modelCalls:1000,tencentCalls:50,activeTasks:2},usedPages:50,remainingPages:0,daily:[],calls:[{call_key:'unknown-call',scope:'grade:test',kind:'modelCalls',day:'2026-11-07',record:{status:'started',usageStatus:'unknown'}}] });
    return response({items:[],hasMore:false});
  }); vi.stubGlobal('fetch',fetcher);
  render(<AccountPortal />); const user = userEvent.setup();
  await user.upload(await screen.findByLabelText('选择文档'),new File(['private source'],'pending-portal.txt',{type:'text/plain'}));
  await user.click(screen.getByRole('button',{name:'用量'}));
  await screen.findByRole('heading',{name:'个人用量'});
  expect(await screen.findByText('未知用量')).toBeTruthy();
  expect(screen.getByText(/免费识别额度：剩余 0 \/ 50 页/)).toBeTruthy();
  expect(screen.getByText(/免费页数已用尽/)).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'导入工作区'}));
  expect(screen.getByText('pending-portal.txt')).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'我的题库'}));
  await user.click(await screen.findByRole('button',{name:'查看结果与下载'}));
  await screen.findByRole('heading',{name:'sample.docx'});
  await user.click(screen.getByRole('link',{name:'开始导入'}));
  expect(screen.getByText('pending-portal.txt')).toBeTruthy();
  const taskReads=fetcher.mock.calls.filter(([path])=>path===`/api/document-tasks/${taskId}`).length;
  accountId='switched';
  act(()=>{window.dispatchEvent(new Event('practiq-session-expired'));});
  await screen.findByText('switched@example.test');
  await screen.findByRole('main',{name:'开始导入'});
  expect(fetcher.mock.calls.filter(([path])=>path===`/api/document-tasks/${taskId}`)).toHaveLength(taskReads);
  expect(fetcher.mock.calls.some(([path]) => path === '/api/uploads' || path === '/api/document-tasks')).toBe(false);
});
