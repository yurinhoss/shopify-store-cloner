import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {validateReset,runReset,registerReset} from '../lib/reset.js';
const destination={shop:'destination.myshopify.com',clientId:'test',clientSecret:'test'};
const body=etapas=>({destination,etapas,confirmShop:destination.shop});
const deps=()=>({getToken:async()=> 'test-token',sleep:async()=>{},restPaginated:async()=>[],restCall:async()=>({}),gql:async()=>{throw Error('Unexpected query');}});
test('reset rejects empty selections, unknown steps and missing destination confirmation',()=>{
  for(const input of [body({}),body({produtos:'true'}),body({unknown:true}),{...body({produtos:true}),confirmShop:'other.myshopify.com'}])assert.throws(()=>validateReset(input));
  assert.equal(validateReset(body({produtos:true})).destination.shop,destination.shop);
});
test('selected pages delete only destination pages and report partial failures',async()=>{
  const events=[],calls=[],d=deps();d.restPaginated=async(shop,path)=>{assert.equal(shop,destination.shop);assert.match(path,/pages/);return [{id:1},{id:2}];};
  d.restCall=async(method,shop,path)=>{calls.push({method,shop,path});if(path.includes('/2.'))throw Error('denied');return {};};
  await runReset(body({paginas:true}),(type,data)=>events.push({type,...data}),d);
  assert.equal(calls.length,2);assert.ok(calls.every(c=>c.method==='DELETE'&&c.shop===destination.shop));assert.equal(events.at(-1).hasErrors,true);
});
test('markets paginate completely and preserve primary market',async()=>{
  const d=deps(),deleted=[],events=[];
  d.gql=async(shop,query,vars)=>{
    if(query.includes('primaryMarket'))return {primaryMarket:{id:'primary'}};
    if(query.includes('marketDelete')){deleted.push(vars.id);return {marketDelete:{deletedId:vars.id,userErrors:[]}};}
    if(query.includes('markets('))return {markets:{nodes:vars.after?[{id:'second',name:'Second'}]:[{id:'primary',name:'Primary'},{id:'first',name:'First'}],pageInfo:{hasNextPage:!vars.after,endCursor:vars.after?'end':'next'}}};
    throw Error('unexpected');
  };
  await runReset(body({markets:true}),(type,data)=>events.push({type,...data}),d);
  assert.deepEqual(deleted,['first','second']);assert.equal(events.at(-1).hasErrors,false);
});
test('files fail closed when product-image lookup fails',async()=>{
  const d=deps(),events=[];let mutations=0;
  d.restPaginated=async()=>{throw Error('denied');};d.gql=async()=>{mutations++;};
  await runReset(body({arquivos:true}),(type,data)=>events.push({type,...data}),d);
  assert.equal(mutations,0);assert.equal(events.at(-1).type,'error');
});
test('files keep images used by products and delete only other files',async()=>{
  const d=deps(),deleted=[],events=[];
  d.restPaginated=async()=>[{images:[{src:'https://cdn.example/product.jpg?v=1'}]}];
  d.gql=async(shop,query,vars)=>{
    if(query.includes('fileDelete')){deleted.push(...vars.ids);return {fileDelete:{deletedFileIds:vars.ids,userErrors:[]}};}
    return {files:{edges:[{node:{id:'keep',image:{url:'https://cdn.example/product.jpg?v=2'}}},{node:{id:'delete',url:'https://cdn.example/unused.pdf'}}],pageInfo:{hasNextPage:false}}};
  };
  await runReset(body({arquivos:true}),(type,data)=>events.push({type,...data}),d);
  assert.deepEqual(deleted,['delete']);assert.equal(events.at(-1).hasErrors,false);
});
test('menus preserve defaults',async()=>{
  const d=deps(),deleted=[];
  d.gql=async(shop,query,vars)=>query.includes('menuDelete')?(deleted.push(vars.id),{menuDelete:{deletedMenuId:vars.id,userErrors:[]}}):{menus:{nodes:[{id:'main',isDefault:true},{id:'custom',isDefault:false}],pageInfo:{hasNextPage:false}}};
  await runReset(body({menus:true}),()=>{},d);assert.deepEqual(deleted,['custom']);
});
test('shipping preserves custom zones and only deletes two-letter zones',async()=>{
  const d=deps(),deleted=[];
  d.gql=async(shop,query,vars)=>query.includes('deliveryProfileUpdate')?(deleted.push(...vars.profile.zonesToDelete),{deliveryProfileUpdate:{profile:{id:'p'},userErrors:[]}}):{deliveryProfiles:{edges:[{node:{id:'p',default:true,profileLocationGroups:[{locationGroupZones:{pageInfo:{hasNextPage:false},edges:[{node:{zone:{id:'de',name:'DE'}}},{node:{zone:{id:'custom',name:'Brasil Grátis'}}}]}}]}}]}};
  await runReset(body({fretes:true}),()=>{},d);assert.deepEqual(deleted,['de']);
});
test('HTTP reset validates before auth and returns an SSE completion',async()=>{
  const app=express(),d=deps();let auth=0;d.getToken=async()=>{auth++;return 'test';};app.use(express.json());registerReset(app,d);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}/api/reset-start`;
  try{
    const bad=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body({produtos:true}),confirmShop:''})});assert.equal(bad.status,400);assert.equal(auth,0);
    const good=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body({produtos:true}))});assert.equal(good.status,200);assert.match(good.headers.get('content-type'),/event-stream/);assert.match(await good.text(),/"type":"done"/);assert.equal(auth,1);
  }finally{await new Promise(r=>server.close(r));}
});
