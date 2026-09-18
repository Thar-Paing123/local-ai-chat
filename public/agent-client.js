const $ = id => document.getElementById(id);
let connection = null, selectedChange = null, selectedJob = null;
const waiting = new Map();
export async function agentRequest(route, body, token = connection?.token) {
  const response = await fetch(`/api/agent/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type':'application/json', ...(token ? {'x-workspace-token':token} : {}) }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Agent operation failed.'); return result;
}
function report(message) { $('agent-status').textContent = message; $('agent-connect-error').textContent = message; $('agent-new-error').textContent = message; }
function action(label, run) { const b=document.createElement('button');b.textContent=label;b.onclick=async()=>{b.disabled=true;try{await run();}catch(e){report(e.message);}finally{b.disabled=false;}};return b; }
function showPanel() { $('agent-panel').hidden=false; document.body.classList.add('agent-panel-open'); }
async function notifyChange() { await window.refreshAgentFiles?.(connection); }
export function getAgentConnection() { return connection; }
export async function disconnectAgent() {
  if(!connection)return;
  const old=connection;connection=null;
  try{await agentRequest('disconnect',{},old.token);}finally{
    for(const waiter of waiting.values())waiter.reject(new Error('Agent folder disconnected.'));
    waiting.clear();report('Agent disconnected');$('agent-root').textContent='No agent folder connected';
  }
}
async function loadHistory() {
  if(!connection)return;
  const token=connection.token;
  const [jobs,changes]=await Promise.all([agentRequest('jobs',undefined,token),agentRequest('changes',undefined,token)]);
  if(connection?.token!==token)return;
  $('agent-history').replaceChildren();
  for(const item of changes)$('agent-history').append(action(`${item.status} · ${item.changes.length} file(s) · ${item.explanation || 'Edit'}`,()=>reviewChange(item)));
  for(const job of jobs)$('agent-history').append(action(`${job.status} · ${job.kind} · ${job.command.slice(0,70)}`,async()=>{reviewJob(job);if(job.status==='running')await pollJob(job.id,connection.token);}));
}
function validateBuffers(changes) {
  const conflicts=window.workspaceDirtyPaths?.() || [];
  if(changes.some(c=>conflicts.includes(c.path)))throw new Error('Save or close unsaved editor files before applying or undoing this change set.');
}
export function reviewChange(item) {
  if(!connection || connection.root!==item.root)throw new Error('Connect the original agent folder to review this change.');
  selectedChange=item; const container=$('agent-review-content');container.replaceChildren();
  $('agent-review-title').textContent=`${item.status} · ${item.changes.length} file changes`;
  for(const change of item.changes){
    const block=document.createElement('details');block.open=true;
    const summary=document.createElement('summary');summary.textContent=`${change.before===null?'New file':'Modified'} · ${change.path}`;
    const columns=document.createElement('div');columns.className='agent-diff';
    for(const [label,text] of [['Before',change.before],['After',change.after]]){const section=document.createElement('section'),heading=document.createElement('strong'),pre=document.createElement('pre');heading.textContent=label;pre.textContent=text===null?'(file does not exist)':text;section.append(heading,pre);columns.append(section);}
    block.append(summary,columns);container.append(block);
  }
  $('agent-apply').hidden=item.status!=='pending';$('agent-reject').hidden=item.status!=='pending';
  $('agent-undo').hidden=item.status!=='applied';$('agent-recover').hidden=item.status!=='needs_recovery';
  $('agent-review-status').textContent=item.explanation || '';
  $('agent-review').showModal();
}
async function changeAction(route) {
  const item=selectedChange;if(!item)return;
  if(connection?.root!==item.root)throw new Error('Folder changed.');
  validateBuffers(item.changes);
  const result=await agentRequest(route,{id:item.id});
  $('agent-review').close();report(`Change set ${result.status}.`);await notifyChange();await loadHistory();
  window.dispatchEvent(new CustomEvent('agent-change-result',{detail:result}));
}
function reviewJob(job) {
  if(!connection || job.root!==connection.root)throw new Error('Connect the original agent folder.');
  selectedJob=job;showPanel();
  $('agent-command-preview').textContent=`Working folder: ${job.root}\n\n${job.command}${job.preview ? `\n\n${job.preview}` : ''}`;
  $('agent-approve-job').hidden=job.status!=='pending';$('agent-reject-job').hidden=job.status!=='pending';
  $('agent-cancel-job').hidden=job.status!=='running';
  $('agent-terminal').textContent=job.output || (job.status==='pending'?'Awaiting approval. No command has run.':'No output.');
  $('agent-job-status').textContent=job.status;
}
async function pollJob(id,token) {
  for(;;){
    const job=await agentRequest(`job?id=${encodeURIComponent(id)}`,undefined,token);
    if(connection?.token!==token)return;
    if(selectedJob?.id===id){selectedJob=job;$('agent-terminal').textContent=job.output;$('agent-job-status').textContent=`${job.status}${job.exitCode===undefined?'':` · exit ${job.exitCode}`}`;$('agent-cancel-job').hidden=job.status!=='running';}
    if(job.status!=='running' && job.status!=='pending'){
      const waiter=waiting.get(id);waiting.delete(id);await notifyChange();waiter?.resolve({status:job.status,exitCode:job.exitCode,output:job.output,truncated:job.truncated||false});await loadHistory();return;
    }
    await new Promise(resolve=>setTimeout(resolve,500));
  }
}
export async function requestAgentJob(input,signal) {
  if(!connection)throw new Error('Connect an agent folder to use terminal or Git.');
  const token=connection.token,job=await agentRequest('jobs',input,token);
  reviewJob(job);report('Approval needed: review the command and choose Run.');await loadHistory();
  return new Promise((resolve,reject)=>{
    const abort=()=>{agentRequest('cancel-job',{id:job.id},token).catch(()=>{});waiting.delete(job.id);reject(new DOMException('Stopped','AbortError'));};
    waiting.set(job.id,{resolve:result=>{signal?.removeEventListener('abort',abort);resolve(result);},reject:error=>{signal?.removeEventListener('abort',abort);reject(error);}});
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  });
}
export async function proposeAgentChanges(changes,explanation) {
  if(!connection)throw new Error('Connect an agent folder for multi-file editing.');
  const item=await agentRequest('changes',{changes,explanation});await loadHistory();return item;
}
function bind(id,handler){$(id).onclick=async()=>{const b=$(id);b.disabled=true;try{await handler();}catch(e){report(e.message);if($('agent-review').open)$('agent-review-status').textContent=e.message;}finally{b.disabled=false;}};}
export function initializeAgentUI() {
$('agent-toggle').onclick=()=>{$('agent-panel').hidden=!$('agent-panel').hidden;document.body.classList.toggle('agent-panel-open',!$('agent-panel').hidden);};
$('agent-hide').onclick=()=>{$('agent-panel').hidden=true;document.body.classList.remove('agent-panel-open');};
$('agent-connect-open').onclick=()=>{$('agent-connect-dialog').showModal();};
bind('agent-connect',async()=>{
  if((window.workspaceDirtyPaths?.()||[]).length)throw new Error('Save or close unsaved editor files before changing folders.');
  const next=await agentRequest('connect',{path:$('agent-path').value.trim()});
  await disconnectAgent();connection=next;try{localStorage.setItem('lac.agent-folder',next.root);}catch{}$('agent-root').textContent=next.root;
  $('agent-connect-dialog').close();showPanel();report('Agent folder connected. Commands require approval; edits require review.');
  window.dispatchEvent(new CustomEvent('agent-connected',{detail:next}));await loadHistory();
});
bind('agent-disconnect',async()=>{await disconnectAgent();window.dispatchEvent(new Event('agent-disconnected'));});
bind('agent-refresh',async()=>{await loadHistory();await notifyChange();});
bind('agent-prepare-command',async()=>{const job=await agentRequest('jobs',{kind:'command',command:$('agent-command').value,reason:'User terminal command'});reviewJob(job);await loadHistory();});
bind('agent-approve-job',async()=>{
  const job=selectedJob;if(!job)throw new Error('Select a command.');
  if((window.workspaceDirtyPaths?.()||[]).length)throw new Error('Save or close unsaved editor files before running commands.');
  const token=connection?.token;reviewJob(await agentRequest('approve-job',{id:job.id}));try{await pollJob(job.id,token);}catch(error){waiting.get(job.id)?.reject(error);waiting.delete(job.id);throw error;}
});
bind('agent-reject-job',async()=>{const job=await agentRequest('cancel-job',{id:selectedJob.id});reviewJob(job);waiting.get(job.id)?.resolve({status:'rejected',output:'User rejected the command.'});waiting.delete(job.id);await loadHistory();});
bind('agent-cancel-job',async()=>{await agentRequest('cancel-job',{id:selectedJob.id});});
for(const [id,route] of [['agent-apply','apply'],['agent-undo','undo'],['agent-reject','reject'],['agent-recover','recover']])bind(id,()=>changeAction(route));
for(const kind of ['status','diff','log'])bind(`agent-git-${kind}`,async()=>{const result=await agentRequest('git',{kind});$('agent-git-output').textContent=[result.branch,result.output].filter(Boolean).join('\n');});
bind('agent-git-commit',async()=>{const paths=$('agent-git-paths').value.split('\n').map(p=>p.trim()).filter(Boolean);reviewJob(await agentRequest('jobs',{kind:'commit',paths,message:$('agent-git-message').value}));await loadHistory();});
bind('agent-git-push',async()=>{reviewJob(await agentRequest('jobs',{kind:'push',remote:$('agent-git-remote').value.trim()||'origin'}));await loadHistory();});
window.addEventListener('workspace-review-proposal',event=>{if(event.detail?.changeset){try{reviewChange(event.detail.changeset);}catch(e){report(e.message);}}});

try{$('agent-path').value=localStorage.getItem('lac.agent-folder')||'';}catch{}
$('agent-new-file').onclick=()=>{$('agent-new-file-dialog').showModal();};
bind('agent-prepare-file',async()=>{const item=await proposeAgentChanges([{path:$('agent-new-path').value.trim(),before:null,after:$('agent-new-content').value}],'Create file');$('agent-new-file-dialog').close();reviewChange(item);});
window.agentConnection=getAgentConnection;

}
