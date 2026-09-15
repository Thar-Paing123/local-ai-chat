import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatStorage } from '../chat-storage.mjs';
import { createChatRepository } from '../public/chat-repository.js';
const image = 'data:image/png;base64,aGVsbG8=';
const makeThread = (id = 'test') => ({ id, title: 'Example', createdAt: 123, messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect image' }, { type: 'image_url', image_url: { url: image } }], attachments: [{name:'shot.png',dataUrl:image},{name:'code.js',text:'const a = 1;'}] }] });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(),'local-chat-test-')); let storage = createChatStorage(dir);
  t.after(() => { storage.close(); rmSync(dir,{recursive:true,force:true}); });
  return { dir, get storage() { return storage; }, reopen() { storage.close(); storage = createChatStorage(dir); } };
}
test('chat and disk attachments survive restart and hydrate for the model', t => {
  const f = fixture(t), saved = f.storage.save(makeThread(),0);
  assert.equal(saved.version,1); assert.ok(!JSON.stringify(saved).includes('base64'));
  assert.equal(readdirSync(join(f.dir,'attachments')).length,2);
  assert.equal(f.storage.hydrate(saved.messages)[0].content[1].image_url.url,image);
  f.reopen(); assert.deepEqual(f.storage.list(),[saved]);
  const item = saved.messages[0].attachments[1]; assert.equal(f.storage.getAttachment(item.id).bytes.toString(),'const a = 1;');
});
test('idempotent migration keeps conflicting server chats and does not resurrect deletions', t => {
  const {storage} = fixture(t); storage.save({...makeThread(),title:'Existing'},0);
  const ids = storage.import([makeThread()]); assert.notEqual(ids[0],'test');
  assert.deepEqual(storage.import([makeThread()]),ids); assert.equal(storage.list().length,2);
  storage.delete(ids[0],1); storage.import([makeThread()]); assert.equal(storage.list().length,1);
});
test('stale versions cannot overwrite or delete another tab’s changes', t => {
  const {storage} = fixture(t); const saved=storage.save(makeThread(),0);
  const newer=storage.save({...saved,title:'Changed'},1);
  assert.throws(()=>storage.save({...saved,title:'Stale'},1),e=>e.status===409);
  assert.throws(()=>storage.delete('test',1),e=>e.status===409);
  assert.deepEqual(storage.list(),[newer]);
});
test('failed imports roll back rows and newly written attachments', t => {
  const f=fixture(t);
  assert.throws(()=>f.storage.import([makeThread(),{...makeThread('invalid'),messages:[{role:'tool',content:'bad'}]}]));
  assert.equal(f.storage.list().length,0); assert.equal(readdirSync(join(f.dir,'attachments')).length,0);
});
test('shared attachments remain until the last referencing chat is deleted', t => {
  const f=fixture(t); f.storage.save(makeThread('one'),0); f.storage.save(makeThread('two'),0);
  f.storage.delete('one',1); assert.equal(readdirSync(join(f.dir,'attachments')).length,2);
  f.storage.delete('two',1); assert.equal(readdirSync(join(f.dir,'attachments')).length,0);
  assert.throws(()=>f.storage.getAttachment('../../etc/passwd'));
});
test('browser migration retains its backup and serializes chat saves', async t => {
  const {storage}=fixture(t), values=new Map([['lac.threads',JSON.stringify([makeThread()])]]); let imports=0;
  const fetcher = async (path,init) => {
    const input=init.body ? JSON.parse(init.body):{};
    try {
      let result;
      if(path==='/api/threads/import'){imports++;result={ids:storage.import(input.threads)};}
      else if(init.method==='GET') result={threads:storage.list()};
      else if(init.method==='PUT') result={thread:storage.save(input.thread,input.version)};
      else {storage.delete(path.split('/').at(-1),input.version);result={deleted:true};}
      return {ok:true,json:async()=>result};
    }catch(error){return{ok:false,json:async()=>({error:error.message})};}
  };
  const browser={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
  const repo=createChatRepository({fetcher,storage:browser}); const [thread]=await repo.load();
  await repo.load(); assert.equal(imports,1); assert.ok(values.has('lac.threads'));
  thread.title='First'; const first=repo.save(thread); thread.title='Second'; const second=repo.save(thread);
  await Promise.all([first,second]); assert.equal(storage.list()[0].title,'Second'); assert.equal(repo.unsaved,false);
  await repo.remove(thread); assert.equal(storage.list().length,0);
});
