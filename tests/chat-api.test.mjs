import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('storage HTTP API persists chats, serves attachments, and rejects cross-origin writes', async t => {
  const directory=mkdtempSync(join(tmpdir(),'chat-api-'));
  const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'0',CHAT_DATA_DIR:directory},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{child.kill('SIGTERM'); await new Promise(resolve=>child.once('exit',resolve)); rmSync(directory,{recursive:true,force:true});});
  const base=await new Promise((resolve,reject)=>{
    let log=''; const timer=setTimeout(()=>reject(new Error('Server startup timed out')),5000);
    child.once('error',reject);
    child.stdout.on('data',chunk=>{ log+=chunk;const match=/http:\/\/localhost:\d+/.exec(log);if(match){clearTimeout(timer);resolve(match[0]);} });
  });
  const headers={'content-type':'application/json'};
  const thread={id:'api-test',title:'API test',createdAt:1,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,aGVsbG8='}}]}]};
  let response=await fetch(`${base}/api/threads/api-test`,{method:'PUT',headers,body:JSON.stringify({thread,version:0})});
  assert.equal(response.status,200); const saved=(await response.json()).thread;
  response=await fetch(base+saved.messages[0].content[0].image_url.url);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(await response.text(),'hello');
  response=await fetch(`${base}/api/threads`);assert.deepEqual((await response.json()).threads,[saved]);
  response=await fetch(`${base}/api/threads/api-test`,{method:'PUT',headers,body:JSON.stringify({thread,version:0})});assert.equal(response.status,409);
  response=await fetch(`${base}/api/threads/api-test`,{method:'DELETE',headers:{...headers,origin:'https://unrelated.example'},body:'{"version":1}'});assert.equal(response.status,403);
  response=await fetch(`${base}/api/threads/api-test`,{method:'DELETE',headers,body:'{"version":1}'});assert.equal(response.status,200);
  response=await fetch(`${base}/api/threads`);assert.deepEqual((await response.json()).threads,[]);
});
