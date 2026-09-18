import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createAgentService } from '../agent-service.mjs';
function fixture(t) {
  const base=mkdtempSync(join(tmpdir(),'agent-test-')),root=join(base,'project'),data=join(base,'data');mkdirSync(root);writeFileSync(join(root,'one.js'),'const one = 1;\n');
  let service=createAgentService(data),connection=service.connect(root);
  t.after(async()=>{await service.close();rmSync(base,{recursive:true,force:true});});
  return {base,root,data,get service(){return service;},get token(){return connection.token;},async reopen(){await service.close();service=createAgentService(data);connection=service.connect(root);}};
}
async function done(service,token,id) {
  for(let i=0;i<500;i++){const job=service.job(token,id);if(job.status!=='running')return job;await new Promise(r=>setTimeout(r,10));}
  throw new Error('Job did not finish');
}
test('agent files are scoped and symlinks and .git writes are rejected',t=>{
  const f=fixture(t);assert.deepEqual(f.service.list(f.token).files,['one.js']);
  assert.throws(()=>f.service.read(f.token,'../outside'),/relative/);
  assert.throws(()=>f.service.prepareChanges(f.token,[{path:'.git/config',before:null,after:'bad'}]),/protected/);
  writeFileSync(join(f.base,'outside'),'outside');symlinkSync(join(f.base,'outside'),join(f.root,'link'));
  assert.throws(()=>f.service.read(f.token,'link'),/Symlinks/);
  assert.throws(()=>f.service.read('invalid','one.js'),/Connect/);
});
test('multi-file proposals wait for apply and undo restores originals including new files',async t=>{
  const f=fixture(t);const item=f.service.prepareChanges(f.token,[{path:'one.js',before:'const one = 1;\n',after:'const one = 2;\n'},{path:'src/new.js',before:null,after:'export default 3;'}],'Two changes');
  assert.equal(readFileSync(join(f.root,'one.js'),'utf8'),'const one = 1;\n');assert.equal(existsSync(join(f.root,'src/new.js')),false);
  f.service.apply(f.token,item.id);assert.equal(readFileSync(join(f.root,'src/new.js'),'utf8'),'export default 3;');
  await f.reopen();assert.equal(f.service.changeHistory(f.token)[0].status,'applied');
  f.service.undo(f.token,item.id);assert.equal(readFileSync(join(f.root,'one.js'),'utf8'),'const one = 1;\n');assert.equal(existsSync(join(f.root,'src/new.js')),false);
});
test('external changes prevent a whole batch from applying or undoing',t=>{
  const f=fixture(t);const item=f.service.prepareChanges(f.token,[{path:'new.txt',before:null,after:'new'},{path:'one.js',before:'const one = 1;\n',after:'replacement'}]);
  writeFileSync(join(f.root,'one.js'),'external');assert.throws(()=>f.service.apply(f.token,item.id),/Conflict/);assert.equal(existsSync(join(f.root,'new.txt')),false);
});
test('commands run only after approval and cannot be replayed',async t=>{
  const f=fixture(t),job=await f.service.prepareJob(f.token,{kind:'command',command:'printf approved > command-result.txt; printf success'});
  assert.equal(job.status,'pending');assert.equal(existsSync(join(f.root,'command-result.txt')),false);
  await f.service.approveJob(f.token,job.id);const result=await done(f.service,f.token,job.id);
  assert.equal(result.status,'completed');assert.equal(result.output,'success');assert.equal(result.exitCode,0);
  await assert.rejects(f.service.approveJob(f.token,job.id),/already/);
});
test('rejection, cancellation, and timeout report distinct outcomes',async t=>{
  const f=fixture(t);const rejected=await f.service.prepareJob(f.token,{command:'touch should-not-exist'});f.service.cancelJob(f.token,rejected.id);await assert.rejects(f.service.approveJob(f.token,rejected.id));
  const cancelled=await f.service.prepareJob(f.token,{command:'sleep 30'});await f.service.approveJob(f.token,cancelled.id);f.service.cancelJob(f.token,cancelled.id);assert.equal((await done(f.service,f.token,cancelled.id)).status,'cancelled');
  const timed=await f.service.prepareJob(f.token,{command:'sleep 30',timeoutMs:1000});await f.service.approveJob(f.token,timed.id);assert.equal((await done(f.service,f.token,timed.id)).status,'timed_out');
  assert.equal(existsSync(join(f.root,'should-not-exist')),false);
});
test('git commits only chosen paths and pushes only after approval to a local remote',async t=>{
  const f=fixture(t);const git=(...args)=>execFileSync('git',args,{cwd:f.root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git('init','-b','main');git('config','user.email','test@example.invalid');git('config','user.name','Test');git('add','.');git('commit','-m','initial');
  writeFileSync(join(f.root,'one.js'),'updated');writeFileSync(join(f.root,'other.txt'),'unrelated');git('add','other.txt');
  const job=await f.service.prepareJob(f.token,{kind:'commit',paths:['one.js'],message:'Selected update'});
  await f.service.approveJob(f.token,job.id);assert.equal((await done(f.service,f.token,job.id)).status,'completed');
  assert.equal(git('log','-1','--format=%s').trim(),'Selected update');assert.match(git('status','--short'),/A  other.txt/);
  const remote=join(f.base,'remote.git');execFileSync('git',['init','--bare',remote],{stdio:'ignore'});git('remote','add','origin',remote);
  const push=await f.service.prepareJob(f.token,{kind:'push',remote:'origin'});assert.equal(push.status,'pending');
  await f.service.approveJob(f.token,push.id);assert.equal((await done(f.service,f.token,push.id)).status,'completed');
  assert.equal(execFileSync('git',['--git-dir',remote,'rev-parse','main'],{encoding:'utf8'}),git('rev-parse','HEAD'));
});
test('a changed selected file invalidates a prepared Git commit',async t=>{
  const f=fixture(t);const git=(...args)=>execFileSync('git',args,{cwd:f.root,stdio:'ignore'});
  git('init');git('config','user.email','test@example.invalid');git('config','user.name','Test');git('add','.');git('commit','-m','initial');
  writeFileSync(join(f.root,'new.txt'),'first');const job=await f.service.prepareJob(f.token,{kind:'commit',paths:['new.txt'],message:'new'});
  writeFileSync(join(f.root,'new.txt'),'changed');await assert.rejects(f.service.approveJob(f.token,job.id),/changed/);
});
test('restart identifies unfinished writes and restores saved originals',async t=>{
  const base=mkdtempSync(join(tmpdir(),'agent-recovery-')),root=join(base,'project'),data=join(base,'data');mkdirSync(root);writeFileSync(join(root,'file'),'before');
  let service=createAgentService(data);let token=service.connect(root).token;
  const item=service.prepareChanges(token,[{path:'file',before:'before',after:'after'}]);service.apply(token,item.id);await service.close();
  const db=new DatabaseSync(join(data,'agent.sqlite'));item.status='applying';db.prepare('UPDATE changesets SET payload=? WHERE id=?').run(JSON.stringify(item),item.id);db.close();
  service=createAgentService(data);token=service.connect(root).token;assert.equal(service.changeHistory(token)[0].status,'needs_recovery');service.recover(token,item.id);assert.equal(readFileSync(join(root,'file'),'utf8'),'before');
  await service.close();rmSync(base,{recursive:true,force:true});
});
