import test from 'node:test';
import assert from 'node:assert/strict';
import {COUNTRIES,EXCLUDED,selectCountries,resolveLocale,shippingNames} from '../lib/countries.js';
import {prepare,ensureMarket,ensureShipping,checkPayload,money,credentials,readMarkets} from '../lib/planner.js';
const country=code=>COUNTRIES.find(c=>c.code===code);
const locales=(...codes)=>codes.map(locale=>({locale,published:true,name:locale}));
const connection=nodes=>({nodes,pageInfo:{hasNextPage:false,endCursor:null}});
test('complete catalog, unique countries and all 50 exclusions enforced on the server',()=>{
 assert.equal(COUNTRIES.length,249);assert.equal(new Set(COUNTRIES.map(c=>c.code)).size,249);assert.equal(EXCLUDED.size,50);
 for(const code of EXCLUDED)assert.throws(()=>selectCountries([code]),/excluído/);
 assert.equal(selectCountries(['PT','PT']).length,1);assert.throws(()=>selectCountries([]));assert.throws(()=>selectCountries(['ZZ']));
});
test('languages depend on each destination, including publication state and Portuguese variants',()=>{
 assert.equal(resolveLocale(country('PT'),locales('en','pt-PT')).primary,'pt-PT');
 assert.ok(resolveLocale(country('PT'),locales('en','pt-BR')).error);
 assert.ok(resolveLocale(country('FR'),locales('en','de')).error);
 assert.equal(resolveLocale(country('FR'),locales('en','fr')).primary,'fr');
 assert.equal(resolveLocale(country('FR'),locales('en','de'),'en').primary,'en');
 assert.ok(resolveLocale(country('FR'),[...locales('en'),{locale:'fr',published:false}]).error);
 assert.ok(resolveLocale(country('FR'),locales('fr')).error);
 assert.ok(resolveLocale(country('FR'),locales('en'),'fr').error);
 assert.deepEqual(resolveLocale(country('US'),locales('en')).alternate,[]);
});
test('money accepts free shipping, rejects invalid amounts and rounds JPY',()=>{
 assert.equal(money(4.9,1,'EUR'),'4.90');assert.equal(money(7.9,160,'JPY'),'1264');assert.equal(money(0,1,'USD'),'0.00');
 for(const x of [-1,'',NaN,Infinity])assert.throws(()=>money(x,1,'EUR'));
});
test('credentials cannot target arbitrary hosts and payload errors are not success',()=>{
 assert.throws(()=>credentials({shop:'localhost',clientId:'x',clientSecret:'x'}));
 assert.throws(()=>credentials({shop:'a.myshopify.com.evil.com',clientId:'x',clientSecret:'x'}));
 assert.throws(()=>checkPayload({userErrors:[{message:'Access denied'}]},'update'),/Access denied/);
 assert.throws(()=>shippingNames(country('PT'),{standard:''}));
});
test('market pagination preserves individual markets after the first page',async()=>{
 let calls=0;const rows=await readMarkets(async(q,v)=>{calls++;return {markets:{nodes:[{id:String(calls)}],pageInfo:{hasNextPage:calls===1,endCursor:'next'}}};});assert.equal(calls,2);assert.equal(rows.length,2);
});
test('preview is read only and identifies existing individual markets',async()=>{
 const call=async q=>{assert.ok(!q.includes('mutation'));if(q.includes('PlannerShop'))return {shop:{name:'Test',currencyCode:'EUR'}};if(q.includes('PlannerLocales'))return {shopLocales:locales('en','pt-PT')};return {markets:connection([{id:'pt',regions:connection([{code:'PT'}])}])};};
 const p=await prepare(call,{mode:'markets',countries:['PT']});assert.equal(p.rows[0].marketId,'pt');assert.equal(p.rows[0].locale.primary,'pt-PT');
});
function shippingCall(zones,methods=[]) {return async q=>{
 if(q.includes('PlannerShop'))return {shop:{name:'Test',currencyCode:'EUR'}};
 if(q.includes('PlannerProfiles'))return {deliveryProfiles:connection([{id:'profile',name:'General',default:true,profileLocationGroups:[{locationGroup:{id:'group',locations:connection([{id:'loc',name:'Warehouse'}])}}]}])};
 if(q.includes('PlannerZones'))return {deliveryProfile:{profileLocationGroups:[{locationGroupZones:connection(zones.map((codes,i)=>({zone:{id:String(i),countries:codes.map(code=>({code:{countryCode:code,restOfWorld:false}}))},methodDefinitions:connection(methods)})))}]}};
 throw new Error(q);
};}
test('grouped shipping zones block only affected countries',async()=>{
 const p=await prepare(shippingCall([['PT','ES']]),{mode:'shipping',countries:['PT','BR']});
 assert.match(p.rows[0].error,/agrupada/);assert.ok(!p.rows[1].error);assert.deepEqual(p.prices,{standard:'4.90',express:'7.90'});
});
test('existing methods are updated by ID without deleting unrelated methods',async()=>{
 const p=await prepare(shippingCall([['PT']],[{id:'standard',name:'CTT Standard'},{id:'express',name:'CTT Expresso'},{id:'pickup',name:'Pickup'}]),{mode:'shipping',countries:['PT']});
 let variables;await ensureShipping(async(q,v)=>{variables=v;return {deliveryProfileUpdate:{userErrors:[]}};},p,p.rows[0]);
 const zone=variables.profile.locationGroupsToUpdate[0].zonesToUpdate[0];assert.equal(zone.methodDefinitionsToCreate.length,0);assert.deepEqual(zone.methodDefinitionsToUpdate.map(m=>m.id),['standard','express']);assert.ok(!zone.methodDefinitionsToDelete);
});
test('repeat market apply reuses web presence and market, and never writes excluded countries through preview',async()=>{
 const mutations=[];const call=async(q,v)=>{if(q.includes('PlannerPresences'))return {webPresences:connection([{id:'web',subfolderSuffix:'pt',defaultLocale:{locale:'pt-PT'},alternateLocales:[{locale:'en'}]}])};mutations.push(v);return {marketUpdate:{market:{id:'market'},userErrors:[]}};};
 await ensureMarket(call,{...country('PT'),marketId:'market',locale:resolveLocale(country('PT'),locales('en','pt-PT'))});
 assert.equal(mutations.length,1);assert.equal(mutations[0].id,'market');assert.deepEqual(mutations[0].input.webPresences,['web']);assert.equal(mutations[0].input.currencySettings.localCurrencies,true);
});
import express from 'express';
import {registerPlanner} from '../lib/planner.js';
test('HTTP preview/apply validates destination, rejects replay and reports mutation errors',async()=>{
 const app=express();app.use(express.json());let writes=0;
 const fake=async(shop,token,q)=>{
  if(q.includes('PlannerShop'))return {shop:{name:'Test',currencyCode:'EUR'}};
  if(q.includes('PlannerLocales'))return {shopLocales:locales('en','pt-PT')};
  if(q.includes('PlannerMarkets'))return {markets:connection([{id:'market',regions:connection([{code:'PT'}])}])};
  if(q.includes('PlannerPresences'))return {webPresences:connection([{id:'web',subfolderSuffix:'pt',defaultLocale:{locale:'pt-PT'},alternateLocales:[{locale:'en'}]}])};
  if(q.includes('PlannerUpdate')){writes++;return {marketUpdate:{userErrors:[{message:'Test mutation rejected'}]}};}
  throw new Error(q);
 };
 registerPlanner(app,async()=> 'test-token',fake);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const destination={shop:'test.myshopify.com',clientId:'id',clientSecret:'secret'};
 const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try {
  const r=await post('/api/planner/preview',{destination,mode:'markets',countries:['PT']});assert.equal(r.status,200);const plan=await r.json();assert.equal(writes,0);
  const wrong=await post('/api/planner/apply',{destination:{...destination,shop:'other.myshopify.com'},id:plan.id});assert.equal(wrong.status,400);assert.equal(writes,0);
  const applied=await post('/api/planner/apply',{destination,id:plan.id});const stream=await applied.text();assert.match(stream,/Test mutation rejected/);assert.match(stream,/"failed":1/);assert.equal(writes,1);
  const replay=await post('/api/planner/apply',{destination,id:plan.id});assert.equal(replay.status,400);assert.equal(writes,1);
 }finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
