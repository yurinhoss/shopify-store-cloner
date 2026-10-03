import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {ImportSessions,ImportBatch,runImportItems} from '../lib/import-session.js';

const context=vm.createContext({TextDecoder,fetch,setTimeout});
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
