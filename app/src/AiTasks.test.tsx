// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { AiTasks } from './AiTasks';
vi.mock('sonner',()=>({toast:{error:vi.fn()}}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('shows progress and sends only the current run when pausing',async()=>{
 const state={threadId:'task',runId:'run',checkpointId:'checkpoint',state:'RUNNING',phase:'prepare',allowedActions:['pause'],blocking:[],failures:[],progress:{visuals:{total:2,succeeded:1,failed:0}},usage:[],unknownUsageCalls:['unknown']};
 vi.mocked(invoke).mockImplementation(async (_command,args)=>{
  const request=(args as {request:{type:string}}).request;
  return (request.type==='list'?{items:[{threadId:'task',fileName:'demo.pdf',expiresAt:''}],hasMore:false}:state) as never;
 });
 render(<AiTasks busy={false} run={job=>{void job();}} onPreview={()=>{}}/>);
 await userEvent.click(await screen.findByRole('button',{name:'demo.pdf'}));
 await userEvent.click(await screen.findByRole('button',{name:'暂停'}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('ai_request',{request:{type:'control',id:'task',action:'pause',run_id:'run',checkpoint_id:null,units:[]}}));
 expect(screen.getByText(/完成 1\/2/)).toBeTruthy();
});
it('reports missing configuration without starting an import',async()=>{
 vi.mocked(invoke).mockRejectedValue({message:'请先配置视觉模型'});
 render(<AiTasks busy={false} run={job=>{void job();}} onPreview={()=>{}}/>);
 await waitFor(()=>expect(toast.error).toHaveBeenCalledWith('请先配置视觉模型',{id:'请先配置视觉模型'}));
 expect(screen.queryByRole('alert')).toBeNull();
 expect(screen.queryByText('请先配置视觉模型')).toBeNull();
});
