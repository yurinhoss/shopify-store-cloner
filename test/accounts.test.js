import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {registerAccounts} from '../lib/accounts.js';import {assetPrompt} from '../lib/builder.js';
test('accounts isolate stores, encrypt credentials, persist sessions and enforce CSRF',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cloner-auth-'));let service,server,base;
 async function start(){const app=express();app.use(express.json());service=registerAccounts(app,{directory:dir,verify:async()=>true});app.get('/api/health',(_,r)=>r.json({ok:true}));app.post('/api/probe',(req,res)=>res.json({shop:req.body.destination.shop,resolved:req.body.destination.clientSecret==='private-test-secret'}));server=app.listen(0);await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;}
 async function stop(){await new Promise(r=>server.close(r));service.close();}
 async function call(path,method='GET',body,cookie,csrf){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0],data:await r.json()};}
 try{await start();assert.equal((await call('/api/health')).status,200);assert.equal((await call('/api/stores')).status,401);
 const a=await call('/api/account/signup','POST',{email:'first@example.com',password:'long-password-one'});assert.equal(a.status,200);assert.match(a.cookie,/cloner_session=/);const am=(await call('/api/account/me','GET',null,a.cookie)).data;
 assert.equal((await call('/api/stores','POST',{},a.cookie)).status,403);
 const created=await call('/api/stores','POST',{name:'Store',shop:'demo.myshopify.com',clientId:'test-id',clientSecret:'private-test-secret'},a.cookie,am.csrfToken);assert.equal(created.status,200);const id=created.data.store.id;assert.ok(!JSON.stringify(created.data).includes('private-test-secret'));
 const b=await call('/api/account/signup','POST',{email:'second@example.com',password:'long-password-two'}),bm=(await call('/api/account/me','GET',null,b.cookie)).data;
 assert.deepEqual((await call('/api/stores','GET',null,b.cookie)).data.stores,[]);
 for(const method of ['PUT','DELETE'])assert.equal((await call('/api/stores/'+id,method,{},b.cookie,bm.csrfToken)).status,404);
 assert.equal((await call('/api/probe','POST',{destination:{storeId:id}},b.cookie,bm.csrfToken)).status,404);
 assert.equal((await call('/api/probe','POST',{destination:{storeId:id}},a.cookie,am.csrfToken)).data.resolved,true);
 await call('/api/account/preferences','PUT',{dest:id},a.cookie,am.csrfToken);
 const row=service.db.prepare('SELECT * FROM users WHERE id=?').get(am.user.id);assert.notEqual(row.password,'long-password-one');assert.ok(!service.db.prepare('SELECT secret FROM stores').get().secret.includes('private-test-secret'));
 await stop();await start();assert.equal((await call('/api/stores','GET',null,a.cookie)).data.stores.length,1);assert.equal((await call('/api/account/me','GET',null,a.cookie)).data.preferences.dest,id);
 assert.equal((await call('/api/account/login','POST',{email:'first@example.com',password:'wrong-password'})).status,401);
 const login=await call('/api/account/login','POST',{email:'first@example.com',password:'long-password-one'});assert.equal(login.status,200);
 await call('/api/account/logout','POST',{},a.cookie,am.csrfToken);assert.equal((await call('/api/stores','GET',null,a.cookie)).status,401);
 }finally{await stop();rmSync(dir,{recursive:true,force:true});}
});
test('image briefs request isolated assets even with a homepage art direction',()=>{const brand={name:'Test',segment:'fashion',palette:['#ffffff','#000000','#112233'],direction:'Build a whole homepage'};for(const kind of ['logo','favicon','banner','mobile']){const prompt=assetPrompt(kind,brand,[],true);assert.match(prompt,/ONE standalone/);assert.match(prompt,/Never render a homepage/);assert.match(prompt,/SAME asset type/);}assert.match(assetPrompt('favicon',brand),/16 and 32 pixels/);assert.match(assetPrompt('banner',brand),/No text, no buttons/);});
