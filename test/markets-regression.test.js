import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureMarket,prepare} from '../lib/planner.js';
const con=nodes=>({nodes,pageInfo:{hasNextPage:false}});
const row={code:'DE',name:'Alemanha',currency:'EUR',marketId:'market',locale:{primary:'de',alternate:['en']}};
const web=(language='de',owners=[])=>({id:'web',subfolderSuffix:'de',defaultLocale:{locale:language},alternateLocales:language==='de'?[{locale:'en'}]:[],markets:con(owners.map(id=>({id})))});
function api(presences,options={}){
 const seen=[];
 return {seen,call:async(q,v)=>{
  if(q.includes('PlannerMarketPresence'))return {market:{webPresences:con(options.associated||[])}};
  if(q.includes('PlannerPresences'))return {webPresences:con(presences)};
  seen.push({q,v});
  if(q.includes('PlannerPresenceUpdate'))return {webPresenceUpdate:{webPresence:{id:'web'},userErrors:[]}};
  if(q.includes('PlannerUpdate')){
    // Contract taken from 2026-07 MarketUpdateInput; the old field must fail this test.
    assert.ok(!Object.hasOwn(v.input,'webPresences'));
    assert.deepEqual(v.input.currencySettings,{baseCurrency:'EUR',localCurrencies:false});
    return {marketUpdate:{market:{id:'market',currencySettings:{baseCurrency:{currencyCode:options.returnCurrency||'EUR'},localCurrencies:false},webPresences:con([{...web(),rootUrls:[{locale:'de',url:'https://store.example/de-de'},{locale:'en',url:'https://store.example/en-de'}]}])},userErrors:[]}};
  }
  throw new Error('Unexpected mutation '+q);
 }};
}
test('Germany explicitly sets EUR, adds the web presence and confirms /de-de',async()=>{
 const mock=api([web()],{associated:[{id:'old-shared'}]});const result=await ensureMarket(mock.call,row);
 assert.match(result,/EUR · de \+ en/);assert.match(result,/\/de-de/);
 assert.deepEqual(mock.seen[0].v.input.webPresencesToAdd,['web']);assert.deepEqual(mock.seen[0].v.input.webPresencesToDelete,['old-shared']);
});
test('failed old runs with orphaned or exclusively owned English subfolder can be repaired',async()=>{
 for(const owners of [[],['market']]){
  const mock=api([web('en',owners)]);await ensureMarket(mock.call,row);
  assert.match(mock.seen[0].q,/webPresenceUpdate/);assert.deepEqual(mock.seen[0].v.input,{defaultLocale:'de',alternateLocales:['en']});
 }
});
test('a web presence shared with another market is not rewritten',async()=>{
 const mock=api([web('en',['other'])]);await assert.rejects(ensureMarket(mock.call,row),/compartilhada/);assert.equal(mock.seen.length,0);
});
test('a successful mutation with the wrong effective currency is reported as failure',async()=>{
 const mock=api([web()],{returnCurrency:'USD'});await assert.rejects(ensureMarket(mock.call,row),/não confirmou/);
});
test('preview skips existing markets including duplicates without asking for a selection',async()=>{
 const call=async q=>{
  if(q.includes('PlannerShop'))return {shop:{name:'Store',currencyCode:'USD'}};
  if(q.includes('PlannerLocales'))return {shopLocales:[{locale:'en',published:true},{locale:'de',published:true}]};
  if(q.includes('PlannerCurrencies'))return {__type:{enumValues:[{name:'EUR'},{name:'USD'}]}};
  return {markets:con(['m1','m2'].map(id=>({id,name:id,regions:con([{code:'DE'}])})))};
 };
 const blocked=await prepare(call,{mode:'markets',countries:['DE']});assert.ok(blocked.rows[0].skipReason);assert.ok(!blocked.rows[0].error);assert.equal(blocked.rows[0].marketId,'m1');
});
