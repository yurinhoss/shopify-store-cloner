import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {generatePolicies,policyHtml,registerPolicies} from '../lib/policies.js';
const settings={storeName:'Example',company:'Example LLC',address:'1 Example Road, London',email:'support@example.com',phone:'+44 123456789',manager:'Seller',region:'world',returnDays:30,marketing:true};
const destination={shop:'example.myshopify.com',clientId:'test',clientSecret:'test-secret'};
test('minimal company data generate seven complete policies automatically',()=>{
 const p=generatePolicies(settings);assert.equal(p.length,7);assert.equal(new Set(p.map(x=>x.type)).size,7);assert.ok(p.every(x=>x.text&&!x.text.includes('undefined')));assert.match(p.find(x=>x.type==='REFUND_POLICY').text,/30 days/);assert.match(p.find(x=>x.type==='REFUND_POLICY').text,/14 days/);assert.match(p.find(x=>x.type==='SHIPPING_POLICY').text,/Worldwide/);
});
test('Japan is generated in Japanese and EU withdrawal is not universally asserted',()=>{
 const p=generatePolicies({...settings,region:'japan',returnDays:7});assert.match(p.find(x=>x.type==='LEGAL_NOTICE').text,/特定商取引法/);assert.match(p.find(x=>x.type==='REFUND_POLICY').text,/7日/);assert.ok(!p.find(x=>x.type==='REFUND_POLICY').text.includes('EUの消費者'));
 assert.throws(()=>generatePolicies({...settings,returnDays:7}),/14 dias/);assert.throws(()=>generatePolicies({...settings,manager:''}),/responsável/);assert.throws(()=>generatePolicies({...settings,email:'bad'}),/E-mail/);
});
test('HTML is escaped, preserving user text without scripts',()=>{assert.equal(policyHtml('<script>x</script>\n&'),'<p>&lt;script&gt;x&lt;/script&gt;<br>&amp;</p>');});
async function setup(api){const app=express();app.use(express.json());registerPolicies(app,async()=> 'token',api);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));return {post:async(path,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/policies/`+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};},close:()=>new Promise(r=>server.close(r))};}
test('preview is read-only; publish checks destination, confirmation, selection and reports partial failures',async()=>{
 const writes=[];const s=await setup(async(shop,token,q,v)=>{assert.equal(shop,destination.shop);if(q.includes('PolicySnapshot'))return {shop:{shopPolicies:[]}};writes.push(v.shopPolicy);if(v.shopPolicy.type==='PRIVACY_POLICY')return {shopPolicyUpdate:{userErrors:[{message:'Permission denied'}]}};return {shopPolicyUpdate:{shopPolicy:v.shopPolicy,userErrors:[]}};});
 try{const preview=await s.post('preview',{destination,settings});assert.equal(preview.status,200);assert.equal(writes.length,0);const body={destination,id:preview.data.id,policies:preview.data.policies.map(p=>({type:p.type,text:p.text})),confirmShop:destination.shop};
 assert.equal((await s.post('publish',{...body,confirmShop:''})).status,400);assert.equal((await s.post('publish',{...body,destination:{...destination,shop:'other.myshopify.com'}})).status,400);assert.equal(writes.length,0);
 const published=await s.post('publish',body);assert.equal(published.data.results.filter(x=>x.ok).length,6);assert.equal(published.data.results.filter(x=>!x.ok).length,1);assert.equal(writes.length,7);assert.equal((await s.post('publish',body)).status,400);
 }finally{await s.close();}
});
test('policies changed after preview cannot be overwritten',async()=>{
 let body='old',writes=0;const s=await setup(async(shop,token,q)=>{if(q.includes('PolicySnapshot'))return {shop:{shopPolicies:[{type:'SHIPPING_POLICY',body}]}};writes++;throw Error('Unexpected write');});
 try{const p=await s.post('preview',{destination,settings});body='changed';const result=await s.post('publish',{destination,id:p.data.id,policies:[{type:'SHIPPING_POLICY',text:'New'}],confirmShop:destination.shop});assert.equal(result.status,400);assert.match(result.data.error,/mudaram/);assert.equal(writes,0);}finally{await s.close();}
});
