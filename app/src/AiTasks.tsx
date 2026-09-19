import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { invoke } from '@tauri-apps/api/core';
import { errorMessage, type Preview } from './api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

type Task = {threadId:string;runId:string|null;checkpointId:string|null;state:string;phase:string;allowedActions:string[];blocking:unknown[];failures:{retryable:boolean;stage:string;index:number;code:string;message?:string}[];progress:Record<string,{total:number;succeeded:number;failed:number}>;usage:{inputTokens:number|null;outputTokens:number|null}[];unknownUsageCalls:string[]};
type Summary={threadId:string;fileName:string;expiresAt:string};
type Request={type:'list';offset:number}|{type:'get'|'preview';id:string}|{type:'pick_document'}|{type:'control';id:string;action:string;run_id:string|null;checkpoint_id:string|null;units:unknown[]};
export function ai<T>(request:Request):Promise<T>{return invoke('ai_request',{request});}
const actions:Record<string,string>={pause:'暂停',resume:'继续',interrupt:'中断',retry_failed:'重试失败项',accept_partial:'接受部分结果'};
const states:Record<string,string>={PENDING:'排队中',RUNNING:'解析中',PAUSING:'正在暂停',PAUSED:'已暂停',INTERRUPTED:'已中断',FAILED:'失败',WAITING_REVIEW:'等待审核',COMPLETED:'已完成'};
export function AiTasks({busy,run,onPreview}:{busy:boolean;run:(job:()=>Promise<void>)=>void;onPreview:(p:Preview)=>void}){
 const [rows,setRows]=useState<Summary[]>([]),[offset,setOffset]=useState(0),[more,setMore]=useState(false),[selected,setSelected]=useState<string|null>(null),[task,setTask]=useState<Task|null>(null),[error,setError]=useState('');
 useEffect(()=>{if(error)toast.error(error,{id:error});},[error]);
 async function refresh(){const r=await ai<{items:Summary[];hasMore:boolean}>({type:'list',offset});setRows(r.items);setMore(r.hasMore);setError('');}
 useEffect(()=>{let active=true;void ai<{items:Summary[];hasMore:boolean}>({type:'list',offset}).then(r=>{if(active){setRows(r.items);setMore(r.hasMore);setError('');}}).catch(e=>{if(active)setError(errorMessage(e));});return()=>{active=false;};},[offset]);
 useEffect(()=>{if(!selected)return;let active=true;let timer:ReturnType<typeof setTimeout>;setTask(null);const poll=async()=>{try{const value=await ai<Task>({type:'get',id:selected});if(active){setTask(value);setError('');}}catch(e){if(active)setError(errorMessage(e));}finally{if(active)timer=setTimeout(poll,2000);}};void poll();return()=>{active=false;clearTimeout(timer);};},[selected]);
 return <div className="space-y-5">
  <p className="text-sm text-muted-foreground">请先在设置中配置模型。文件在本机处理，解析内容会发送到你配置的模型服务，可能产生费用。只有主动解析或继续任务时才会调用模型。</p>
  <div className="flex gap-3"><Button disabled={busy} onClick={()=>run(async()=>{const created=await ai<{threadId:string}|null>({type:'pick_document'});if(created){await refresh();setSelected(created.threadId);}})}>选择文档并开始解析</Button><Button variant="outline" disabled={busy} onClick={()=>run(refresh)}>刷新任务</Button></div>
  <div className="grid grid-cols-[280px_1fr] gap-5">
   <div className="space-y-2">{rows.map(r=><Button className="w-full justify-start truncate" variant={selected===r.threadId?'secondary':'outline'} key={r.threadId} onClick={()=>setSelected(r.threadId)}>{r.fileName || r.threadId.slice(0,8)}</Button>)}{!rows.length&&!error&&<p>暂无解析任务</p>}<div className="flex gap-2"><Button variant="ghost" disabled={offset===0||busy} onClick={()=>setOffset(Math.max(0,offset-20))}>上一页</Button><Button variant="ghost" disabled={!more||busy} onClick={()=>setOffset(offset+20)}>下一页</Button></div></div>
   {task && <Card><CardContent className="space-y-4 pt-6"><h2 className="font-medium">{states[task.state]||task.state}</h2><p className="text-sm">阶段：{task.phase}</p>{Object.entries(task.progress).map(([key,p])=><p className="text-sm" key={key}>{key==='visuals'?'图片':'文本'}：完成 {p.succeeded}/{p.total}，失败 {p.failed}</p>)}<p className="text-sm">已记录 {task.usage.length} 次调用；输入 {task.usage.reduce((n,u)=>n+(u.inputTokens||0),0)} / 输出 {task.usage.reduce((n,u)=>n+(u.outputTokens||0),0)} tokens；用量未知 {task.unknownUsageCalls.length} 次</p>{task.failures.length>0&&<ul className="space-y-1 text-sm text-destructive">{task.failures.map((failure,i)=><li key={i}>{failure.stage} #{failure.index+1}：{failure.message||failure.code}{failure.retryable?"（可重试）":""}</li>)}</ul>}{task.blocking.length>0&&<pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(task.blocking,null,2)}</pre>}<div className="flex flex-wrap gap-2">{task.allowedActions.map(action=><Button key={action} disabled={busy} variant="outline" onClick={()=>run(async()=>{await ai({type:'control',id:task.threadId,action,run_id:["pause","interrupt"].includes(action)?task.runId:null,checkpoint_id:["pause","interrupt"].includes(action)?null:task.checkpointId,units:[]});setTask(await ai({type:'get',id:task.threadId}));})}>{actions[action]||action}</Button>)}{task.state==='COMPLETED'&&<Button disabled={busy} onClick={()=>run(async()=>onPreview(await ai<Preview>({type:'preview',id:task.threadId})))}>预览并导入题库</Button>}</div></CardContent></Card>}
  </div>
 </div>;
}
