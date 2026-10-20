import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {ImportSessions,ImportBatch,runImportItems,isTemporaryImportError} from '../lib/import-session.js';

const context=vm.createContext({TextDecoder,fetch,setTimeout,clearTimeout,crypto});
vm.runInContext(readFileSync(new URL('../public/streams.js',import.meta.url),'utf8'),context);
const stream=events=>new Response(events.map(e=>JSON.stringify(e)).join('\n')+'\n');
test('sessions isolate owners, preserve immutable settings and block concurrent resumes',()=>{
  const sessions=new ImportSessions();const body={destination:{shop:'a'},rules:{stock:10}};
  const job=sessions.acquire('alice',body);body.rules.stock=999;
  assert.equal(job.body.rules.stock,10);
  assert.throws(()=>sessions.acquire('bob',{importId:job.id}),{status:410});
  assert.throws(()=>sessions.acquire('alice',{importId:job.id}),{status:409});
  job.cursor.products=100;sessions.release(job);
  assert.equal(sessions.acquire('alice',{importId:job.id,rules:{stock:999}}).cursor.products,100);
  assert.equal(job.body.rules.stock,10);
});
test('expiration removes idle sessions but never unlocks an in-flight import',()=>{
  let now=0;const sessions=new ImportSessions({now:()=>now,ttl:10});
  const running=sessions.acquire('alice',{}), idle=sessions.acquire('alice',{});sessions.release(idle);now=20;
  assert.throws(()=>sessions.acquire('alice',{importId:idle.id}),{status:410});
  assert.throws(()=>sessions.acquire('alice',{importId:running.id}),{status:409});
});
test('205 products run as 100/100/5 with at most five workers and no repeated writes',async()=>{
  const job={cursor:{}},items=Array.from({length:205},(_,i)=>i),seen=[];
  let active=0,maxActive=0;const cursors=[];
  for(let request=0;request<3;request++) {
    const batch=new ImportBatch();
    try{await runImportItems(job,'products',items,batch,async item=>{
      active++;maxActive=Math.max(maxActive,active);
      await new Promise(r=>setTimeout(r,1));seen.push(item);active--;
    });}catch(e){assert.equal(e.message,'IMPORT_CONTINUE');}
    cursors.push(job.cursor.products);
  }
  assert.deepEqual(cursors,[100,200,205]);assert.equal(maxActive,5);
  assert.equal(new Set(seen).size,205);assert.equal(seen.length,205);
});
test('time budget yields before launching another wave',async()=>{
  let now=0;const job={cursor:{}};const batch=new ImportBatch({now:()=>now,maxMs:100});
  await assert.rejects(runImportItems(job,'products',[1,2,3,4,5,6],batch,async()=>{now=101;}),/IMPORT_CONTINUE/);
  assert.equal(job.cursor.products,5);
});
test('client rotates requests using only the server session ID',async()=>{
  const bodies=[];let calls=0;
  await context.runImportBatches({url:'https://source',destination:{clientSecret:'private'}},()=>{},{request:async(_url,options)=>{
    bodies.push(JSON.parse(options.body));calls++;
    return stream([{type:'checkpoint',importId:'same-session'},{type:'done',continue:calls<3}]);
  }});
  assert.equal(calls,3);assert.deepEqual(bodies[1],{importId:'same-session'});assert.deepEqual(bodies[2],bodies[1]);
});
test('client reconnects after lost stream and waits for in-flight work without restarting',async()=>{
  const bodies=[];let calls=0;
  await context.runImportBatches({url:'https://source'},()=>{},{wait:async()=>{},request:async(_url,options)=>{
    bodies.push(JSON.parse(options.body));calls++;
    if(calls===1)return stream([{type:'checkpoint',importId:'job'}]);
    if(calls===2)return Response.json({error:'busy'},{status:409});
    return stream([{type:'done'}]);
  }});
  assert.equal(calls,3);assert.deepEqual(bodies[2],{importId:'job'});
});
test('fatal Shopify and HTTP errors never trigger automatic replay',async()=>{
  for(const result of [()=>stream([{type:'checkpoint',importId:'job'},{type:'error',message:'Sem permissão'}]),()=>Response.json({error:'expired'},{status:410})]) {
    let calls=0;
    await assert.rejects(context.runImportBatches({},()=>{},{request:async()=>{calls++;return result();},wait:async()=>{}}));
    assert.equal(calls,1);
  }
});

test('client keeps retrying after eight consecutive network failures with bounded backoff',async()=>{
  let calls=0;const delays=[],bodies=[],events=[];
  await context.runImportBatches({url:'https://source'},e=>events.push(e),{wait:async ms=>delays.push(ms),request:async(_url,options)=>{
    bodies.push(JSON.parse(options.body));if(++calls<=8)throw new TypeError('network error');
    return stream([{type:'done'}]);
  }});
  assert.equal(calls,9);assert.equal(events.filter(e=>e.type==='reconnecting').length,8);
  assert.deepEqual(delays,[2000,4000,8000,16000,30000,30000,30000,30000]);
  assert.ok(bodies[0].importRequestId);assert.equal(new Set(bodies.map(b=>b.importRequestId)).size,1);
});
test('lost first checkpoint recovers the existing server job and never launches it twice',async()=>{
  const sessions=new ImportSessions();let created=0,calls=0;
  await context.runImportBatches({url:'https://source'},()=>{},{wait:async()=>{},request:async(_url,options)=>{
    calls++;const job=sessions.acquire('alice',JSON.parse(options.body));
    if(!job.finished){created++;job.cursor.products=100;job.finished=true;}
    sessions.release(job);
    if(calls===1)throw new TypeError('Failed to fetch');
    return stream([{type:'checkpoint',importId:job.id},{type:'done'}]);
  }});
  assert.equal(created,1);assert.equal(sessions.jobs.size,1);
});
test('first request still working returns its own busy ID to its owner',()=>{
  const sessions=new ImportSessions(),body={importRequestId:'fixed-request-id-123',destination:{shop:'test'}};
  const job=sessions.acquire('alice',body);
  assert.throws(()=>sessions.acquire('alice',body),e=>e.status===409&&e.importId===job.id&&e.code==='IMPORT_BUSY');
  assert.throws(()=>sessions.acquire('bob',body),e=>e.status===409&&!e.importId);
  sessions.release(job);assert.equal(sessions.acquire('alice',body),job);
});
test('temporary HTTP failures and server transport errors reconnect to the same checkpoint',async()=>{
  let calls=0;const bodies=[];
  await context.runImportBatches({},()=>{},{wait:async()=>{},request:async(_url,options)=>{
    bodies.push(JSON.parse(options.body));calls++;
    if(calls===1)return stream([{type:'checkpoint',importId:'same-job'},{type:'error',retryable:true,message:'fetch failed'}]);
    if(calls===2)return new Response('proxy unavailable',{status:502});
    if(calls===3)return Response.json({error:'wait'},{status:429,headers:{'Retry-After':'0'}});
    return stream([{type:'done'}]);
  }});
  assert.equal(calls,4);for(const body of bodies.slice(1))assert.deepEqual(body,{importId:'same-job'});
});
test('aborting an import stops reconnect attempts immediately',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(context.runImportBatches({},()=>{},{signal:controller.signal,request:async()=>{calls++;throw new TypeError('network error');},wait:async()=>{controller.abort();}}),{name:'AbortError'});
  assert.equal(calls,1);
});
test('pause and resume with the same request key preserve the cursor',()=>{
  const sessions=new ImportSessions();const body={importRequestId:'pause-request-id-123'};
  const job=sessions.acquire('alice',body);job.cursor.products=200;sessions.release(job);
  assert.equal(sessions.acquire('alice',body).cursor.products,200);
});
test('stopping a batch finishes its current wave, then preserves the next cursor',async()=>{
  const job={cursor:{}},batch=new ImportBatch();let calls=0;
  await assert.rejects(runImportItems(job,'products',[1,2,3,4,5,6],batch,async()=>{calls++;batch.stop();}),/IMPORT_CONTINUE/);
  assert.equal(calls,5);assert.equal(job.cursor.products,5);
});
test('a silent hung connection reconnects after the idle timeout',async()=>{
  let calls=0,cancelled=false;
  await context.runImportBatches({},()=>{},{idleMs:5,wait:async()=>{},request:async()=>{
    calls++;
    if(calls===1)return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"type":"checkpoint","importId":"hung-job"}\n'));},cancel(){cancelled=true;}}));
    return stream([{type:'done'}]);
  }});
  assert.equal(calls,2);assert.equal(cancelled,true);
});
test('pause aborts an active stream rather than waiting for a heartbeat',async()=>{
  const controller=new AbortController();let cancelled=false;
  const response=new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"type":"checkpoint","importId":"paused-job"}\n'));},cancel(){cancelled=true;}}));
  await assert.rejects(context.runImportBatches({},e=>{if(e.type==='checkpoint')controller.abort();},{signal:controller.signal,request:async()=>response}),{name:'AbortError'});
  assert.equal(cancelled,true);
});
test('temporary error classification excludes permissions, validation, and expired sessions',()=>{
  for(const message of ['network error','fetch failed','Shopify HTTP 503.','429: too many requests','Rate limit persistente','Limite de chamadas atingido'])assert.equal(isTemporaryImportError(new Error(message)),true,message);
  for(const message of ['Auth failed: 401','403: ACCESS_DENIED','Estoque inválido','Sessão expirada'])assert.equal(isTemporaryImportError(new Error(message)),false,message);
});
