import test from 'node:test';
import assert from 'node:assert/strict';
import {marketMutation,prepare,ensureMarket,readMarkets} from '../lib/planner.js';
const variables={input:{currencySettings:{baseCurrency:'BHD',localCurrencies:false},name:'Bahrain'}};
const rejection={market:null,userErrors:[{field:['input','currencySettings','baseCurrency'],message:'The specified currency is not supported.'}]};
test('unsupported currency retries once with shop currency for create and update',async()=>{
 for(const key of ['marketCreate','marketUpdate']){
  const seen=[];const call=async(q,v)=>{seen.push(v);return {[key]:seen.length===1?rejection:{market:{id:'one'},userErrors:[]}};};
  const result=await marketMutation(call,'mutation',variables,key,'EUR');
  assert.equal(result.currency,'EUR');assert.equal(seen.length,2);assert.equal(seen[1].input.currencySettings.baseCurrency,'EUR');assert.equal(seen[1].input.currencySettings.localCurrencies,false);assert.equal(variables.input.currencySettings.baseCurrency,'BHD');
 }
});
test('other errors, partial writes and failed fallback never trigger repeated creation',async()=>{
 for(const payload of [{...rejection,market:{id:'created'}},{market:null,userErrors:[{field:['input','name'],message:'Denied'}]}]){
  let calls=0;await marketMutation(async()=>{calls++;return {marketCreate:payload};},'',variables,'marketCreate','EUR');assert.equal(calls,1);
 }
 let calls=0;await assert.rejects(marketMutation(async()=>{calls++;return {marketCreate:rejection};},'',variables,'marketCreate','EUR'),/not supported/);assert.equal(calls,2);
});
test('unsupported territory preview is nonblocking and never creates a market',async()=>{
 const call=async q=>q.includes('PlannerShop')?{shop:{name:'Store',currencyCode:'EUR'}}:q.includes('PlannerLocales')?{shopLocales:[{locale:'en',published:true}]}:q.includes('PlannerCurrencies')?{__type:{enumValues:[{name:'EUR'}]}}:{markets:{nodes:[],pageInfo:{hasNextPage:false}}};
 const plan=await prepare(call,{mode:'markets',countries:['AQ','CU','GU','BH']});assert.ok(plan.rows.slice(0,3).every(r=>r.skipReason&&!r.error));assert.equal(plan.rows[3].fallbackCurrency,'EUR');
 let writes=0;await assert.rejects(ensureMarket(async()=>{writes++;},plan.rows[0]),/Território/);assert.equal(writes,0);
});

test('existing countries in grouped markets are skipped even when local languages are absent',async()=>{
 const call=async q=>q.includes('PlannerShop')?{shop:{name:'Store',currencyCode:'EUR'}}:q.includes('PlannerLocales')?{shopLocales:[]}:q.includes('PlannerCurrencies')?{__type:{enumValues:[{name:'EUR'}]}}:{markets:{nodes:[{id:'group',regions:{nodes:[{code:'FR'},{code:'DE'},{code:'PT'}]}}],pageInfo:{hasNextPage:false}}};
 const plan=await prepare(call,{mode:'markets',countries:['PT','DE']});
 assert.ok(plan.rows.every(r=>r.skipReason&&!r.error));assert.ok(plan.rows.every(r=>r.marketId==='group'));
});

test('grouped market coverage includes countries beyond the first page',async()=>{
 let calls=0;
 const markets=await readMarkets(async(q,v)=>{calls++;if(q.includes('PlannerMarketRegions')){assert.equal(v.after,'next');return {market:{regions:{nodes:[{code:'PT'}],pageInfo:{hasNextPage:false}}}};}return {markets:{nodes:[{id:'group',regions:{nodes:[{code:'FR'},{code:'DE'}],pageInfo:{hasNextPage:true,endCursor:'next'}}}],pageInfo:{hasNextPage:false}}};});
 assert.equal(calls,2);assert.deepEqual(markets[0].regions.nodes.map(r=>r.code),['FR','DE','PT']);
});
