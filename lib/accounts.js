import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID,scrypt,timingSafeEqual,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {mkdirSync,existsSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {promisify} from 'node:util';
const derive=promisify(scrypt), hash=x=>createHash('sha256').update(x).digest('hex');
export function registerAccounts(app,{directory,verify,production=false,publicDir}){
 if(!directory)throw Error('DATA_DIR obrigatório para contas persistentes.');
 mkdirSync(directory,{recursive:true,mode:0o700});const dbPath=join(directory,'accounts.sqlite'),keyPath=join(directory,'credentials.key');
 if(existsSync(dbPath)&&!existsSync(keyPath))throw Error('Chave de credenciais ausente. Restaure o backup.');
 if(!existsSync(keyPath))writeFileSync(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});
 const key=readFileSync(keyPath);if(key.length!==32)throw Error('Chave de credenciais inválida.');
 const db=new DatabaseSync(dbPath);chmodSync(dbPath,0o600);db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,password TEXT NOT NULL,preferences TEXT NOT NULL DEFAULT '{}',ai TEXT);
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS stores(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,shop TEXT NOT NULL,secret TEXT NOT NULL,UNIQUE(user_id,shop));`);
 const seal=value=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);return JSON.stringify([iv.toString('base64'),Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]).toString('base64'),c.getAuthTag().toString('base64')]);};
 const open=value=>{const [iv,data,tag]=JSON.parse(value),d=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64'));d.setAuthTag(Buffer.from(tag,'base64'));return JSON.parse(Buffer.concat([d.update(Buffer.from(data,'base64')),d.final()]).toString());};
 const route=(method,path,fn)=>app[method](path,async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.status||400).json({error:e.message.includes('UNIQUE constraint')?'Este cadastro já existe.':e.message});}});
 const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
 const publicAPI=req=>req.method==='GET'&&(req.originalUrl.split('?')[0]==='/api/health'||/^\/api\/builder\/package\/[a-f0-9-]{36}\.zip$/.test(req.originalUrl.split('?')[0]));
 app.use((req,res,next)=>{const raw=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('cloner_session='))?.slice(15);if(raw){const s=db.prepare('SELECT sessions.*,users.email FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>?').get(hash(raw),Date.now());if(s)req.account={id:s.user_id,email:s.email,csrf:s.csrf,token:s.token};}if(req.path.startsWith('/api/')||['/','/index.html','/login','/login.html'].includes(req.path))res.set('Cache-Control','no-store');next();});
 app.use('/api',(req,res,next)=>{if(publicAPI(req)||['/api/account/login','/api/account/signup'].includes(req.originalUrl.split('?')[0]))return next();if(!req.account)return res.status(401).json({error:'Entre na sua conta para continuar.'});if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.headers['x-csrf-token']!==req.account.csrf)return res.status(403).json({error:'Sessão inválida. Atualize a página.'});next();});
 const attempts=new Map();
 function throttle(req){const k=req.ip,now=Date.now();for(const [key,v] of attempts)if(v.until<now)attempts.delete(key);const v=attempts.get(k)||{count:0,until:now+15*60000};if(++v.count>20)fail('Muitas tentativas. Aguarde 15 minutos.',429);attempts.set(k,v);}
 function session(req,res,id){db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(token),id,csrf,Date.now()+30*86400000);res.cookie('cloner_session',token,{httpOnly:true,secure:production,sameSite:'lax',path:'/',maxAge:30*86400000});res.json({ok:true});}
 for(const action of ['signup','login'])route('post','/api/account/'+action,async(req,res)=>{
  if(req.headers['sec-fetch-site']==='cross-site')fail('Origem inválida.',403);
  if(req.headers.origin&&req.headers.origin!==`${req.protocol}://${req.get('host')}`)fail('Origem inválida.',403);
  if(!req.is('application/json'))fail('Use JSON.');throttle(req);
  const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||password.length<10||password.length>256)fail('Informe um e-mail válido e uma senha de 10 a 256 caracteres.');
  const user=db.prepare('SELECT * FROM users WHERE email=?').get(email),salt=action==='signup'?randomBytes(16).toString('hex'):(user?.salt||'00000000000000000000000000000000');
  const passwordHash=await derive(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  if(action==='signup'){if(user)fail('Não foi possível criar a conta com este e-mail.');const id=randomUUID();db.prepare('INSERT INTO users(id,email,salt,password) VALUES(?,?,?,?)').run(id,email,salt,passwordHash.toString('hex'));return session(req,res,id);}
  if(!user||!timingSafeEqual(passwordHash,Buffer.from(user.password,'hex')))fail('E-mail ou senha incorretos.',401);session(req,res,user.id);
 });
 route('get','/api/account/me',(req,res)=>{const u=db.prepare('SELECT preferences,ai FROM users WHERE id=?').get(req.account.id);res.json({user:{id:req.account.id,email:req.account.email},csrfToken:req.account.csrf,preferences:JSON.parse(u.preferences),hasAIKey:!!u.ai});});
 route('post','/api/account/logout',(req,res)=>{db.prepare('DELETE FROM sessions WHERE token=?').run(req.account.token);res.clearCookie('cloner_session',{path:'/',httpOnly:true,secure:production,sameSite:'lax'});res.json({ok:true});});
 route('put','/api/account/preferences',(req,res)=>{const prefs={};for(const field of ['origin','dest']){const id=req.body[field];if(id&&!db.prepare('SELECT id FROM stores WHERE id=? AND user_id=?').get(id,req.account.id))fail('Loja não encontrada.');prefs[field]=id||'';}db.prepare('UPDATE users SET preferences=? WHERE id=?').run(JSON.stringify(prefs),req.account.id);res.json({ok:true});});
 route('put','/api/account/ai',(req,res)=>{const value=String(req.body.key||'').trim();if(value&&!/^sk-[A-Za-z0-9_-]{15,}$/.test(value))fail('Chave inválida.');db.prepare('UPDATE users SET ai=? WHERE id=?').run(value?seal(value):null,req.account.id);res.json({ok:true,hasAIKey:!!value});});
 const metadata=s=>({id:s.id,name:s.name,shop:s.shop,clientId:open(s.secret).clientId});
 route('get','/api/stores',(req,res)=>res.json({stores:db.prepare('SELECT * FROM stores WHERE user_id=? ORDER BY name').all(req.account.id).map(metadata)}));
 for(const method of ['post','put'])route(method,method==='post'?'/api/stores':'/api/stores/:id',async(req,res)=>{
  const previous=method==='put'?db.prepare('SELECT * FROM stores WHERE id=? AND user_id=?').get(req.params.id,req.account.id):null;if(method==='put'&&!previous)fail('Loja não encontrada.',404);
  const name=String(req.body.name||'').trim(),shop=String(req.body.shop||'').trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/$/,'');
  const secret={clientId:String(req.body.clientId||'').trim(),clientSecret:String(req.body.clientSecret||'').trim()||(previous?open(previous.secret).clientSecret:'')};
  if(!name||name.length>100||!/^[-a-z0-9]+\.myshopify\.com$/.test(shop)||!secret.clientId||!secret.clientSecret)fail('Preencha o nome, domínio Shopify e credenciais.');
  await verify(shop,secret.clientId,secret.clientSecret);const id=previous?.id||randomUUID();if(previous)db.prepare('UPDATE stores SET name=?,shop=?,secret=? WHERE id=? AND user_id=?').run(name,shop,seal(secret),id,req.account.id);else db.prepare('INSERT INTO stores VALUES(?,?,?,?,?)').run(id,req.account.id,name,shop,seal(secret));res.json({ok:true,store:{id,name,shop,clientId:secret.clientId}});
 });
 route('delete','/api/stores/:id',(req,res)=>{const r=db.prepare('DELETE FROM stores WHERE id=? AND user_id=?').run(req.params.id,req.account.id);if(!r.changes)fail('Loja não encontrada.',404);res.json({ok:true});});
 app.use('/api',(req,res,next)=>{try{if(req.body){const resolve=d=>{if(!d?.storeId)return d;const s=db.prepare('SELECT * FROM stores WHERE id=? AND user_id=?').get(d.storeId,req.account.id);if(!s)fail('Loja não encontrada.',404);return {shop:s.shop,...open(s.secret)};};if(req.body.storeId)req.body=resolve(req.body);for(const field of ['origin','destination'])if(req.body[field])req.body[field]=resolve(req.body[field]);req.body._accountId=req.account?.id;if(req.body.apiKey==='@account'){const u=db.prepare('SELECT ai FROM users WHERE id=?').get(req.account.id);if(!u.ai)fail('Cadastre sua chave de IA.');req.body.apiKey=open(u.ai);}}next();}catch(e){res.status(e.status||400).json({error:e.message});}});
 if(publicDir){app.get(['/','/index.html'],(req,res)=>req.account?res.sendFile(join(publicDir,'index.html')):res.redirect('/login'));app.get(['/login','/login.html'],(req,res)=>req.account?res.redirect('/'):res.sendFile(join(publicDir,'login.html')));}
 return {db,close:()=>db.close()};
}
