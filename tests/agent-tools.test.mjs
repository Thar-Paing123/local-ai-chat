import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileTools } from '../public/file-tools.js';
import { extendAgentSession, agentToolDefinitions } from '../public/agent-tools.js';
import { runToolChat } from '../public/tool-chat.js';
test('agent tool list contains plans, multi-file edits, command and Git actions',()=>{
  for(const name of ['update_plan','propose_file_changes','run_command','command_history','change_history','git_status','git_diff','git_log','git_commit','git_push'])assert.ok(agentToolDefinitions.some(t=>t.function.name===name));
});
test('plan updates are validated and inactive server features are not advertised',async()=>{
  const snapshot={id:'x',name:'fixture',enabled:true,files:new Map()};const base=createFileTools({getWorkspace:()=>snapshot,getText(){}})();const session=extendAgentSession(base,snapshot,()=>snapshot);
  assert.equal(session.definitions.some(t=>t.function.name==='run_command'),false);
  const result=await session.execute('update_plan',{steps:[{title:'Inspect source',status:'in_progress'}]});assert.deepEqual(session.plan,result.plan);
  await assert.rejects(session.execute('update_plan',{steps:[{title:'bad',status:'invented'}]}),/valid status/);
  await assert.rejects(session.execute('run_command',{command:'ls'}),/Connect/);
});
test('tool loop saves complete checkpoints and forwards plan progress',async()=>{
  let round=0,checkpoint,plan;
  const session={enabled:true,name:'fixture',instruction:'Use tools',definitions:agentToolDefinitions,execute:async name=>name==='list_files'?{files:[],total:0}:{plan:[{title:'Inspect',status:'completed'}]}};
  const response=choice=>new Response(`data: ${JSON.stringify({choices:[choice]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  await runToolChat({payload:{messages:[]},session,signal:new AbortController().signal,onText(){},onActivity(){},onProposal(){},onPlan:p=>plan=p,onCheckpoint:c=>checkpoint=c,fetcher:async()=>round++===0?response({delta:{tool_calls:[{index:0,id:'plan',function:{name:'update_plan',arguments:'{"steps":[{"title":"Inspect","status":"completed"}]}'}}]},finish_reason:'tool_calls'}):response({delta:{content:'Done'},finish_reason:'stop'})});
  assert.equal(plan[0].status,'completed');assert.equal(checkpoint.round,1);assert.equal(checkpoint.messages.at(-1).role,'tool');
});
