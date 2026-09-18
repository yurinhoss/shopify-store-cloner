import { randomUUID } from 'node:crypto';
import { COUNTRIES, selectCountries, resolveLocale, resolveCurrency, shippingNames } from './countries.js';
const VERSION='2026-07';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function checkPayload(payload, field) {
  if (!payload) throw new Error(`Resposta vazia da Shopify: ${field}`);
  if (payload.userErrors?.length) throw new Error(payload.userErrors.map(e=>`${(e.field||[]).join('.')}: ${e.message}`).join('; '));
  return payload;
}
export function credentials(value) {
  if (!value || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(value.shop||'')) throw new Error('Use o domínio da loja: nome.myshopify.com.');
  if (!value.clientId || !value.clientSecret) throw new Error('Preencha Client ID e Client Secret da loja de destino.');
  return value;
}
export async function api(shop, token, query, variables={}) {
  for(let attempt=0;attempt<5;attempt++) {
    const res=await fetch(`https://${shop}/admin/api/${VERSION}/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(45000)});
    if(res.status===429) {await sleep(1000*(attempt+1));continue;}
    if(!res.ok) throw new Error(`Shopify HTTP ${res.status}. Verifique as permissões do app.`);
    const result=await res.json();
    if(result.errors?.every(e=>e.extensions?.code==='THROTTLED')) {await sleep(1000*(attempt+1));continue;}
    if(result.errors?.length) throw new Error(result.errors.map(e=>e.message).join('; '));
    if(!result.data) throw new Error('A Shopify não retornou dados.');
    return result.data;
  }
  throw new Error('Limite da Shopify atingido. Aguarde e gere outra prévia.');
}
async function pages(call,query,key,variables={}) {
  const result=[]; let after=null;
  do {const data=(await call(query,{...variables,after}))[key]; result.push(...data.nodes); after=data.pageInfo.hasNextPage?data.pageInfo.endCursor:null;} while(after);
  return result;
}
export async function readMarkets(call) {
  const markets=await pages(call,`query PlannerMarkets($after:String){markets(first:50,after:$after){nodes{id name status regions(first:2){nodes{... on MarketRegionCountry{code}} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}`,'markets');
  for(const market of markets){
    let info=market.regions?.pageInfo;
    while(info?.hasNextPage){
      const cursor=info.endCursor;
      if(!cursor)throw new Error('Paginação de países incompleta. Gere outra prévia.');
      const next=(await call(`query PlannerMarketRegions($id:ID!,$after:String){market(id:$id){regions(first:100,after:$after){nodes{... on MarketRegionCountry{code}} pageInfo{hasNextPage endCursor}}}}`,{id:market.id,after:cursor})).market?.regions;
      if(!next||next.pageInfo.hasNextPage&&next.pageInfo.endCursor===cursor)throw new Error('Não foi possível ler todos os países do mercado.');
      market.regions.nodes.push(...next.nodes);info=next.pageInfo;
    }
  }
  return markets;
}
async function readShipping(call) {
  return pages(call,`query PlannerProfiles($after:String){deliveryProfiles(first:5,after:$after){nodes{id name default profileLocationGroups{locationGroup{id locations(first:10){nodes{id name}}}}} pageInfo{hasNextPage endCursor}}}`,'deliveryProfiles');
}
async function readZones(call,profileId,groupId) {
  const nodes=[];let after=null;
  do {
    const data=await call(`query PlannerZones($id:ID!,$group:ID!,$after:String){deliveryProfile(id:$id){profileLocationGroups(locationGroupId:$group){locationGroupZones(first:10,after:$after){nodes{zone{id name countries{code{countryCode restOfWorld}}} methodDefinitions(first:20){nodes{id name active} pageInfo{hasNextPage}}} pageInfo{hasNextPage endCursor}}}}}`,{id:profileId,group:groupId,after});
    const connection=data.deliveryProfile?.profileLocationGroups[0]?.locationGroupZones;
    if(!connection) throw new Error('Local de envio não encontrado.');
    if(connection.nodes.some(z=>z.methodDefinitions.pageInfo.hasNextPage)) throw new Error('Uma zona tem mais de 20 tarifas. Revise no admin antes de continuar.');
    nodes.push(...connection.nodes);after=connection.pageInfo.hasNextPage?connection.pageInfo.endCursor:null;
  } while(after);
  return nodes;
}
export async function exchangeRate(currency,manual) {
  if(currency==='EUR') return {rate:1,source:'EUR',date:new Date().toISOString().slice(0,10)};
  if(manual!==undefined && manual!==null && manual!=='') {
    const rate=Number(manual);
    if(!Number.isFinite(rate)||rate<=0||rate>1000000) throw new Error('Taxa de câmbio inválida.');
    return {rate,source:'Taxa informada',date:new Date().toISOString().slice(0,10)};
  }
  try {
    const r=await fetch(`https://api.frankfurter.dev/v1/latest?base=EUR&symbols=${encodeURIComponent(currency)}`,{signal:AbortSignal.timeout(10000)});
    if(!r.ok) throw new Error();
    const data=await r.json(),rate=data.rates?.[currency];
    if(!Number.isFinite(rate)||rate<=0||Date.now()-Date.parse(data.date)>7*86400000) throw new Error();
    return {rate,date:data.date,source:'Frankfurter / bancos centrais'};
  } catch {throw new Error(`Não foi possível consultar EUR → ${currency}. Informe a taxa de câmbio e gere a prévia novamente.`);}
}
export function money(amount,rate,currency) {
  const n=Number(amount);
  if(!Number.isFinite(n)||n<0||n>10000||amount==='') throw new Error('Preço de frete inválido.');
  const digits=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
  return (n*rate).toFixed(digits);
}
export async function prepare(call,input) {
  if(!['markets','shipping'].includes(input.mode)) throw new Error('Aba inválida.');
  const countries=selectCountries(input.countries);
  const shop=(await call('query PlannerShop{shop{name currencyCode}}')).shop;
  const result={mode:input.mode,shop,rows:[]};
  if(input.mode==='markets') {
    const {shopLocales}=await call('query PlannerLocales{shopLocales{locale name published}}');
    result.locales=shopLocales;
    const markets=await readMarkets(call);
    const currencyType=await call('query PlannerCurrencies{__type(name:"CurrencyCode"){enumValues{name}}}');
    result.currencyCodes=currencyType.__type.enumValues.map(v=>v.name);

    for(const c of countries) {
      const locale=resolveLocale(c,shopLocales,input.locales?.[c.code]);
      if(UNSUPPORTED_MARKET_REGIONS.has(c.code)){result.rows.push({...c,locale,skipReason:'Território não aceito pela Shopify como mercado separado.',action:'Ignorado: mercado separado não suportado'});continue;}
      const matches=markets.filter(m=>m.regions.nodes.some(r=>r.code===c.code));
      if(matches.length){result.rows.push({...c,locale,marketId:matches[0].id,skipReason:'Já incluído em Market existente. Configuração preservada.',action:'Pular mercado existente'});continue;}
      const {currency,warning:currencyWarning}=resolveCurrency(c,result.currencyCodes,shop.currencyCode);
      const chosen=input.marketIds?.[c.code] ? matches.find(m=>m.id===input.marketIds[c.code]) : matches.length===1?matches[0]:null;
      const currencyError=!currency?'Não foi possível identificar a moeda da loja. Teste a conexão novamente.':null;
      result.rows.push({...c,currency,currencyWarning,fallbackCurrency:shop.currencyCode,locale,marketId:chosen?.id,marketChoices:matches.map(m=>({id:m.id,name:m.name})),paths:locale.primary?[...new Set([locale.primary,...locale.alternate])].map(l=>`/${l.toLowerCase()}-${c.code.toLowerCase()}`):[],action:chosen?'Corrigir mercado individual, moeda e subpasta':'Criar mercado individual',error:currencyError || (matches.length>1&&!chosen?'Selecione qual mercado individual corrigir (há duplicados).':locale.error)});
    }
  } else {
    const profiles=await readShipping(call);
    result.profiles=profiles.map(p=>({id:p.id,name:p.name,default:p.default,groups:p.profileLocationGroups.map(g=>({id:g.locationGroup.id,name:g.locationGroup.locations.nodes.map(l=>l.name).join(', ')||g.locationGroup.id}))}));
    const profile=input.profileId?profiles.find(p=>p.id===input.profileId):profiles.find(p=>p.default);
    if(!profile) throw new Error('Perfil de frete não encontrado.');
    const group=input.groupId?profile.profileLocationGroups.find(g=>g.locationGroup.id===input.groupId):profile.profileLocationGroups.length===1?profile.profileLocationGroups[0]:null;
    result.profileId=profile.id;
    if(!group) {result.selectionRequired=true;return result;}
    result.groupId=group.locationGroup.id;
    const zones=await readZones(call,profile.id,result.groupId);
    result.fx=await exchangeRate(shop.currencyCode,input.exchangeRate);
    result.prices={standard:money(input.standard??4.9,result.fx.rate,shop.currencyCode),express:money(input.express??7.9,result.fx.rate,shop.currencyCode)};
    for(const c of countries) {
      const matches=zones.filter(z=>z.zone.countries.some(p=>p.code.countryCode===c.code||p.code.restOfWorld));
      const zone=matches[0];
      const error=matches.length>1?'País encontrado em várias zonas. Revise no admin.':zone&&(zone.zone.countries.length!==1||zone.zone.countries[0].code.restOfWorld)?'País coberto por zona agrupada. Separe a zona no admin para criar frete individual.':null;
      result.rows.push({...c,names:shippingNames(c,input.names?.[c.code]),zone,action:zone?'Atualizar/adicionar tarifas na zona individual':'Criar zona individual',error});
    }
  }
  return result;
}
export function marketCurrency(row) {
  if(!/^[A-Z]{3}$/.test(row.currency||''))throw new Error('Moeda explícita não definida. Gere outra prévia.');
  return {baseCurrency:row.currency,localCurrencies:false};
}
// These region codes were explicitly rejected by Markets in API 2026-07.
// Keep them in the catalog (shipping has different rules), but do not create Markets.
export const UNSUPPORTED_MARKET_REGIONS = new Set('AQ GU MP MH VI FM PW PR AS KP CU BV HM'.split(' '));
export async function marketMutation(call,query,variables,key,fallbackCurrency) {
  let result=await call(query,variables);
  const payload=result[key],errors=payload?.userErrors||[];
  const rejectedCurrency=errors.length>0 && !payload.market && errors.every(e=>
    (e.field||[]).join('.').endsWith('currencySettings.baseCurrency') && /currency.*not supported/i.test(e.message));
  const original=variables.input.currencySettings.baseCurrency;
  if(rejectedCurrency && fallbackCurrency && fallbackCurrency!==original){
    const retry={...variables,input:{...variables.input,currencySettings:{...variables.input.currencySettings,baseCurrency:fallbackCurrency}}};
    result=await call(query,retry);
    checkPayload(result[key],key);
    return {result,currency:fallbackCurrency};
  }
  return {result,currency:original};
}
export async function ensureMarket(call,row) {
  row={...row};
  if(UNSUPPORTED_MARKET_REGIONS.has(row.code))throw new Error('Território não aceito como mercado separado.');
  const originalCurrency=row.currency;
  const currencySettings=marketCurrency(row);
  const rawCall=call;
  call=async(query,variables)=>{
    const key=query.includes('mutation PlannerCreate(')?'marketCreate':query.includes('mutation PlannerUpdate(')?'marketUpdate':null;
    if(!key)return rawCall(query,variables);
    const {result,currency}=await marketMutation(rawCall,query,variables,key,row.fallbackCurrency);
    row.currency=currency;currencySettings.baseCurrency=currency;
    return result;
  };
  let id=row.marketId;
  if(!id) {
    const r=checkPayload((await call(`mutation PlannerCreate($input:MarketCreateInput!){marketCreate(input:$input){market{id} userErrors{field message}}}`,{input:{name:row.name,status:'ACTIVE',conditions:{regionsCondition:{regions:[{countryCode:row.code}]}},currencySettings}})).marketCreate,'marketCreate');
    id=r.market.id;
  }
  const current=(await call(`query PlannerMarketPresence($id:ID!){market(id:$id){webPresences(first:100){nodes{id} pageInfo{hasNextPage}}}}`,{id})).market;
  if(!current||current.webPresences.pageInfo.hasNextPage)throw new Error('Não foi possível ler as associações atuais do mercado.');
  const presences=await pages(call,`query PlannerPresences($after:String){webPresences(first:50,after:$after){nodes{id subfolderSuffix defaultLocale{locale} alternateLocales{locale} markets(first:2){nodes{id} pageInfo{hasNextPage}}} pageInfo{hasNextPage endCursor}}}`,'webPresences');
  const suffix=row.code.toLowerCase();
  const sameLocales=p=>p.defaultLocale?.locale===row.locale.primary&&JSON.stringify(p.alternateLocales.map(l=>l.locale).sort())===JSON.stringify([...row.locale.alternate].sort());
  const candidates=presences.filter(p=>p.subfolderSuffix===suffix);
  let presence=candidates.find(sameLocales);
  if(!presence && candidates.length) {
    // Reuse orphaned presences from failed runs, or the presence owned solely by this market.
    presence=candidates.find(p=>p.markets&&!p.markets.pageInfo.hasNextPage&&p.markets.nodes.every(m=>m.id===id));
    if(!presence)throw new Error('A subpasta está compartilhada com outro mercado. Não foi alterada; revise os idiomas compartilhados no admin.');
    checkPayload((await call(`mutation PlannerPresenceUpdate($id:ID!,$input:WebPresenceUpdateInput!){webPresenceUpdate(id:$id,input:$input){webPresence{id} userErrors{field message}}}`,{id:presence.id,input:{defaultLocale:row.locale.primary,alternateLocales:row.locale.alternate}})).webPresenceUpdate,'webPresenceUpdate');
  }
  if(!presence)presence=checkPayload((await call(`mutation PlannerPresence($input:WebPresenceCreateInput!){webPresenceCreate(input:$input){webPresence{id} userErrors{field message}}}`,{input:{subfolderSuffix:suffix,defaultLocale:row.locale.primary,alternateLocales:row.locale.alternate}})).webPresenceCreate,'webPresenceCreate').webPresence;
  const associated=current.webPresences.nodes.map(p=>p.id);
  const input={status:'ACTIVE',currencySettings,webPresencesToAdd:associated.includes(presence.id)?[]:[presence.id],webPresencesToDelete:associated.filter(existing=>existing!==presence.id)};
  const updated=checkPayload((await call(`mutation PlannerUpdate($id:ID!,$input:MarketUpdateInput!){marketUpdate(id:$id,input:$input){market{id currencySettings{localCurrencies baseCurrency{currencyCode}} webPresences(first:10){nodes{id defaultLocale{locale} alternateLocales{locale} rootUrls{locale url}}}} userErrors{field message}}}`,{id,input})).marketUpdate,'marketUpdate').market;
  const actual=updated?.webPresences?.nodes.find(p=>p.id===presence.id);
  if(updated?.currencySettings?.localCurrencies!==false||updated?.currencySettings?.baseCurrency?.currencyCode!==row.currency||!actual||!sameLocales(actual))throw new Error('A Shopify não confirmou moeda e idiomas solicitados. Gere nova prévia para revisar o resultado.');
  const urls=actual.rootUrls?.map(u=>u.url)||[];
  return `${originalCurrency!==row.currency?'Moeda '+originalCurrency+' recusada; usando '+row.currency+' (moeda da loja). ':''}${row.currency} · ${row.locale.primary}${row.locale.alternate.length?' + '+row.locale.alternate.join(', '):''} · ${urls.join(' | ')||'/'+row.locale.primary.toLowerCase()+'-'+suffix}`;
}
export async function ensureShipping(call,plan,row) {
  const existing=row.zone?.methodDefinitions.nodes||[];
  const create=[],update=[];
  row.names.forEach((name,i)=> {
    const match=existing.filter(m=>m.name===name);
    if(match.length>1) throw new Error(`Tarifas duplicadas com nome ${name}. Revise no admin.`);
    const method={name,active:true,rateDefinition:{price:{amount:i===0?plan.prices.standard:plan.prices.express,currencyCode:plan.shop.currencyCode}}};
    if(match.length) update.push({...method,id:match[0].id}); else create.push(method);
  });
  const zone={methodDefinitionsToCreate:create,methodDefinitionsToUpdate:update};
  const group={id:plan.groupId};
  if(row.zone) group.zonesToUpdate=[{id:row.zone.zone.id,...zone}];
  else group.zonesToCreate=[{name:`${row.code} — ${row.name}`,countries:[{code:row.code,includeAllProvinces:true}],...zone}];
  checkPayload((await call(`mutation PlannerShipping($id:ID!,$profile:DeliveryProfileInput!){deliveryProfileUpdate(id:$id,profile:$profile){profile{id} userErrors{field message}}}`,{id:plan.profileId,profile:{locationGroupsToUpdate:[group]}})).deliveryProfileUpdate,'deliveryProfileUpdate');
  return `Fretes: ${plan.shop.currencyCode} ${plan.prices.standard} / ${plan.prices.express}`;
}
export function registerPlanner(app,getToken, apiCall=api) {
  const plans=new Map(),locks=new Set();
  const cleanup=setInterval(()=>{for(const [id,p] of plans) if(p.expires<Date.now()) plans.delete(id);},60000);cleanup.unref();
  app.get('/api/planner/countries',(_req,res)=>res.json({countries:COUNTRIES}));
  app.post('/api/planner/preview',async(req,res)=> {
    try {
      const dest=credentials(req.body.destination);
      const token=await getToken(dest.shop,dest.clientId,dest.clientSecret);
      const call=(q,v)=>apiCall(dest.shop,token,q,v);
      const input={...req.body};delete input.destination;
      const plan=await prepare(call,input);
      const id=randomUUID();
      if(plans.size>=1000) throw new Error('Muitas prévias ativas; tente novamente em alguns minutos.');
      plans.set(id,{accountId:req.account?.id,shop:dest.shop,clientId:dest.clientId,input,plan,expires:Date.now()+15*60000});
      res.json({ok:true,id,...plan});
    } catch(e) {res.status(400).json({ok:false,error:e.message});}
  });
  app.post('/api/planner/apply',async(req,res)=> {
    let dest,stored,call,acquired=false;
    try {
      dest=credentials(req.body.destination);stored=plans.get(req.body.id);
      if(!stored||stored.accountId!==req.account?.id||stored.expires<Date.now()||stored.shop!==dest.shop||stored.clientId!==dest.clientId) throw new Error('Prévia expirada ou loja alterada. Gere outra prévia.');
      if(stored.plan.selectionRequired||!stored.plan.rows.length||stored.plan.rows.some(r=>r.error)) throw new Error('Resolva os avisos bloqueantes antes de aplicar.');
      if(locks.has(dest.shop)) throw new Error('Já existe uma configuração em andamento nesta loja.');
      locks.add(dest.shop);acquired=true;
      const token=await getToken(dest.shop,dest.clientId,dest.clientSecret);
      call=(q,v)=>apiCall(dest.shop,token,q,v);
    } catch(e) {if(acquired) locks.delete(dest.shop);return res.status(400).json({ok:false,error:e.message});}
    res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();
    const send=x=>{if(!res.destroyed)res.write(`data: ${JSON.stringify(x)}\n\n`);};
    const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': heartbeat\n\n');},15000);
    let ok=0,failed=0,skipped=0;
    try {
      // Re-read immediately before writes; preserve the reviewed exchange rate.
      const fresh=await prepare(call,{...stored.input,exchangeRate:stored.plan.fx?.rate});
      if(fresh.selectionRequired||fresh.rows.some(r=>r.error)) throw new Error('A loja mudou desde a prévia. Gere outra prévia antes de aplicar.');
      if(fresh.rows.some((r,i)=>r.currency!==stored.plan.rows[i].currency || r.marketId!==stored.plan.rows[i].marketId || r.zone?.zone.id!==stored.plan.rows[i].zone?.zone.id)) throw new Error('Mercados ou zonas alterados desde a prévia. Gere outra prévia.');
      if(fresh.rows.some((r,i)=>r.locale?.primary!==stored.plan.rows[i].locale?.primary || JSON.stringify(r.locale?.alternate)!==JSON.stringify(stored.plan.rows[i].locale?.alternate))) throw new Error('Idiomas alterados desde a prévia. Gere outra prévia.');
      if(fresh.profileId!==stored.plan.profileId||fresh.groupId!==stored.plan.groupId||fresh.shop.currencyCode!==stored.plan.shop.currencyCode) throw new Error('Perfil ou moeda alterados. Gere outra prévia.');
      plans.delete(req.body.id);
      for(const row of fresh.rows) {
        if(res.destroyed) break;
        if(row.skipReason){skipped++;send({type:'row',code:row.code,skipped:true,message:row.skipReason});continue;}
        try {const message=fresh.mode==='markets'?await ensureMarket(call,row):await ensureShipping(call,fresh,row);ok++;send({type:'row',code:row.code,ok:true,message});}
        catch(e) {failed++;send({type:'row',code:row.code,ok:false,message:e.message});}
        await sleep(150);
      }
      send({type:'done',ok,failed,skipped});
    } catch(e) {send({type:'error',message:e.message});}
    finally {clearInterval(heartbeat);locks.delete(dest.shop);res.end();}
  });
}

