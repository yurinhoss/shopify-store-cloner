import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {paginateShopify} from '../lib/pagination.js';
const context=vm.createContext({TextDecoder});
vm.runInContext(readFileSync(new URL('../public/streams.js',import.meta.url),'utf8'),context);
const read=context.readOperationStream;
const response=text=>new Response(text);
test('SSE decodes split UTF-8 and an unterminated completion line',async()=>{
  const bytes=new TextEncoder().encode('data: {"type":"log","msg":"Japão"}\n\ndata: {"type":"done"}');
  const events=[];let index=0;
  await read(new Response(new ReadableStream({pull(c){index<bytes.length?c.enqueue(bytes.slice(index,index+=1)):c.close();}})),'sse',e=>events.push(e));
  assert.equal(events[0].msg,'Japão');assert.equal(events[1].type,'done');
});
test('clean EOF without done reports interruption in both protocols',async()=>{
  for(const [format,text] of [['sse','data: {"type":"log","msg":"started"}\n\n'],['ndjson','{"log":"started"}\n']])await assert.rejects(read(response(text),format,()=>{}),/Conexão interrompida/);
});
test('fatal operation errors do not become successful completion',async()=>{
  for(const format of ['sse','ndjson'])await assert.rejects(read(response((format==='sse'?'data: ':'')+'{"type":"error","message":"Permissão negada"}\n'),format,()=>{}),/Permissão negada/);
});
test('NDJSON requires explicit completion and rejects HTTP errors',async()=>{
  await read(response('{"type":"done"}\n'),'ndjson',()=>{});
  await assert.rejects(read(new Response('unavailable',{status:503}),'ndjson',()=>{}),/503/);
});
test('pagination stops after five throttled requests',async()=>{
  let calls=0;
  await assert.rejects(paginateShopify('test.myshopify.com','/products.json','test','products','2026-07',{request:async()=>{calls++;return new Response('',{status:429});},wait:async()=>{}}),/Limite de chamadas/);
  assert.equal(calls,5);
});
test('pagination retries without duplicates and reads all pages',async()=>{
  let calls=0;
  const result=await paginateShopify('test.myshopify.com','/products.json','test','products','2026-07',{request:async()=>{calls++;if(calls===1)return new Response('',{status:429});return Response.json({products:[{id:calls}]},{headers:calls===2?{link:'<https://test.myshopify.com/admin/api/2026-07/products.json?page_info=next>; rel="next"'}:{}});},wait:async()=>{}});
  assert.deepEqual(result,[{id:2},{id:3}]);assert.equal(calls,3);
});
test('pagination never forwards access tokens to a foreign next-page host',async()=>{
  let calls=0;
  await assert.rejects(paginateShopify('test.myshopify.com','/products.json','test','products','2026-07',{request:async()=>{calls++;return Response.json({products:[]},{headers:{link:'<https://other.example/products>; rel="next"'}});}}),/fora da loja/);
  assert.equal(calls,1);
});
