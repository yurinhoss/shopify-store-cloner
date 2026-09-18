// Restored from commit 2dfaedf17e12cac02cd9417b0b8ed9e069f3d874.
import {credentials} from './planner.js';
export const RESET_STEPS = ['markets','fretes','colecoes','paginas','menus','descontos','arquivos','produtos'];
export function validateReset(body) {
  credentials(body?.destination);
  const etapas=body.etapas;
  if(!etapas||typeof etapas!=='object'||Array.isArray(etapas)||Object.keys(etapas).some(k=>!RESET_STEPS.includes(k)||typeof etapas[k]!=='boolean')||!RESET_STEPS.some(k=>etapas[k]===true))throw new Error('Selecione pelo menos uma etapa válida.');
  if(body.confirmShop!==body.destination.shop)throw new Error('Confirme o domínio exato da loja de destino.');
  return body;
}
export function registerReset(app, dependencies) {
  const active=new Set();
  app.post('/api/reset-start',async(req,res)=>{
    try{validateReset(req.body);}catch(e){return res.status(400).json({error:e.message});}
    const shop=req.body.destination.shop.toLowerCase();
    if(active.has(shop))return res.status(409).json({error:'Já existe um reset em andamento nesta loja.'});
    active.add(shop);
    res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();
    let closed=false;res.on('close',()=>{closed=true;});
    const send=(type,data)=>{if(!closed)res.write(`data: ${JSON.stringify({type,...data})}\n\n`);};
    const guarded={...dependencies};
    for(const name of ['gql','restCall','restPaginated','getToken'])guarded[name]=async(...args)=>{if(closed)throw new Error('Conexão encerrada; reset interrompido.');return dependencies[name](...args);};
    const heartbeat=setInterval(()=>{if(!closed)res.write(': keepalive\n\n');},15000);
    try{await runReset(req.body,send,guarded);}catch(e){send('error',{msg:e.message});}
    finally{clearInterval(heartbeat);active.delete(shop);res.end();}
  });
}

export async function runReset(body, send, {getToken, gql, restPaginated, restCall, sleep = ms=>new Promise(r=>setTimeout(r,ms))}) {
  const { destination, etapas } = body;
  let hasErrors = false;
  const log = (msg, status = "info") => {
    if(status==='error'||/❌|⚠/u.test(msg)||/\| [1-9][0-9]* erros/.test(msg)){hasErrors=true;status='error';}
    send("log", {msg,status});
  };
  const connection = async (key, fields) => {
    const nodes=[]; let after=null;
    do {
      const data=await gql(destination.shop, `query($after:String){${key}(first:100,after:$after){nodes{${fields}}pageInfo{hasNextPage endCursor}}}`,{after},token);
      const page=data[key]; if(!page?.nodes||!page.pageInfo)throw new Error('Resposta incompleta: '+key);
      nodes.push(...page.nodes);
      if(!page.pageInfo.hasNextPage)break;
      if(!page.pageInfo.endCursor||page.pageInfo.endCursor===after)throw new Error('Paginação inválida: '+key);
      after=page.pageInfo.endCursor;
    } while(true);
    return nodes;
  };
  let token;
  const progress = (step, current, total) => send("progress", { step, current, total });

  try {
    log("🔑 Autenticando na loja destino...");
    const tokenDest = token = await getToken(destination.shop, destination.clientId, destination.clientSecret);
    log(`✅ Autenticado em ${destination.shop}`, "success");

    // ── MARKETS: apaga todos, menos o principal (a Shopify não deixa) ──
    if (etapas.markets) {
      log("━━━━━━━━━━ RESET: MARKETS ━━━━━━━━━━");
      const primary = await gql(destination.shop, 'query { primaryMarket { id } }', {}, tokenDest);
      if(!primary.primaryMarket?.id)throw new Error('Não foi possível identificar o mercado principal; nenhum mercado foi apagado.');
      const todos = await connection('markets', 'id name');
      const apagar = todos.filter(m => m.id !== primary.primaryMarket.id);
      log(`🌍 ${todos.length} markets | ${apagar.length} serão apagados (o principal fica)`);
      let ok = 0, erros = 0;
      for (let i = 0; i < apagar.length; i++) {
        progress("reset_markets", i + 1, apagar.length);
        try {
          const r = await gql(destination.shop,
            `mutation($id:ID!){marketDelete(id:$id){deletedId userErrors{message}}}`,
            { id: apagar[i].id }, tokenDest);
          if ((r.marketDelete?.userErrors || []).length > 0) {
            erros++;
            log(`  ⚠️ ${apagar[i].name}: ${r.marketDelete.userErrors[0].message.slice(0, 70)}`);
          } else ok++;
        } catch (e) { erros++; log(`  ❌ ${apagar[i].name}: ${e.message.slice(0, 70)}`); }
        await sleep(150);
      }
      log(`✅ Markets: ${ok} apagados | ${erros} erros`, "success");
    }

    // ── FRETES: apaga todas as zonas do perfil geral, independentemente do nome ──
    if (etapas.fretes) {
      log("━━━━━━━━━━ RESET: FRETES ━━━━━━━━━━");
      const profData = await gql(destination.shop, `
        query { deliveryProfiles(first: 10) { edges { node { id default
          profileLocationGroups { locationGroup { id }
            locationGroupZones(first: 100) { pageInfo { hasNextPage } edges { node { zone { id name } } } } } } } } }`, {}, tokenDest);
      const profile = profData.deliveryProfiles.edges.map(e => e.node).find(p => p.default);
      if (!profile) { log("❌ Perfil de entrega padrão não encontrado", "error"); }
      else {
        if(profile.profileLocationGroups.some(g=>g.locationGroupZones.pageInfo.hasNextPage))throw new Error('O perfil tem mais de 100 zonas em um grupo. Nenhuma zona foi apagada; divida o reset pelo administrador Shopify.');
        const zonas = [];
        for (const lg of profile.profileLocationGroups)
          for (const ze of lg.locationGroupZones.edges)
            zonas.push(ze.node.zone);
        const apagar = [...new Map(zonas.map(z=>[z.id,z])).values()];
        log(`🚚 Perfil geral: ${apagar.length} zonas serão apagadas, incluindo nomes completos e personalizados.`);
        if(!apagar.length)log('ℹ️ O perfil geral já está sem zonas de frete.');
        let ok = 0, erros = 0;
        for (let i = 0; i < apagar.length; i += 20) {
          const lote = apagar.slice(i, i + 20);
          progress("reset_fretes", Math.min(i + 20, apagar.length), apagar.length);
          try {
            const r = await gql(destination.shop,
              `mutation($id:ID!,$profile:DeliveryProfileInput!){deliveryProfileUpdate(id:$id,profile:$profile){profile{id}userErrors{field message}}}`,
              { id: profile.id, profile: { zonesToDelete: lote.map(z => z.id) } }, tokenDest);
            if ((r.deliveryProfileUpdate?.userErrors || []).length > 0) {
              erros += lote.length;
              log(`  ⚠️ ${r.deliveryProfileUpdate.userErrors[0].message.slice(0, 80)}`);
            } else if(!r.deliveryProfileUpdate?.profile?.id){throw new Error('Shopify não confirmou a atualização do perfil.');}
            else ok += lote.length;
          } catch (e) { erros += lote.length; log(`  ❌ ${e.message.slice(0, 80)}`); }
          await sleep(300);
        }
        log(`✅ Fretes: ${ok} zonas apagadas | ${erros} erros`, "success");
      }
    }

    // ── COLEÇÕES: apaga smart + custom ──
    if (etapas.colecoes) {
      log("━━━━━━━━━━ RESET: COLEÇÕES ━━━━━━━━━━");
      const smart = await restPaginated(destination.shop, "/smart_collections.json?limit=250&fields=id,title", tokenDest, "smart_collections");
      const custom = await restPaginated(destination.shop, "/custom_collections.json?limit=250&fields=id,title", tokenDest, "custom_collections");
      log(`📚 ${smart.length} smart + ${custom.length} custom a apagar`);
      let ok = 0, erros = 0;
      const apagarLista = [
        ...smart.map(c => ({ id: c.id, tipo: "smart_collections" })),
        ...custom.map(c => ({ id: c.id, tipo: "custom_collections" })),
      ];
      for (let i = 0; i < apagarLista.length; i += 5) {
        const lote = apagarLista.slice(i, i + 5);
        progress("reset_colecoes", Math.min(i + 5, apagarLista.length), apagarLista.length);
        const rs = await Promise.allSettled(lote.map(c =>
          restCall("DELETE", destination.shop, `/${c.tipo}/${c.id}.json`, tokenDest)));
        for (const r of rs) r.status === "fulfilled" ? ok++ : erros++;
        await sleep(250);
      }
      log(`✅ Coleções: ${ok} apagadas | ${erros} erros`, "success");
    }

    // ── PÁGINAS ──
    if (etapas.paginas) {
      log("━━━━━━━━━━ RESET: PÁGINAS ━━━━━━━━━━");
      const pgs = await restPaginated(destination.shop, "/pages.json?limit=250&fields=id,title", tokenDest, "pages");
      log(`📄 ${pgs.length} páginas a apagar`);
      let ok = 0, erros = 0;
      for (let i = 0; i < pgs.length; i += 5) {
        const lote = pgs.slice(i, i + 5);
        progress("reset_paginas", Math.min(i + 5, pgs.length), pgs.length);
        const rs = await Promise.allSettled(lote.map(p =>
          restCall("DELETE", destination.shop, `/pages/${p.id}.json`, tokenDest)));
        for (const r of rs) r.status === "fulfilled" ? ok++ : erros++;
        await sleep(250);
      }
      log(`✅ Páginas: ${ok} apagadas | ${erros} erros`, "success");
    }

    // ── MENUS: apaga os que a Shopify deixa (os padrão do sistema ficam) ──
    if (etapas.menus) {
      log("━━━━━━━━━━ RESET: MENUS ━━━━━━━━━━");
      try {
        const menus = await connection('menus','id title isDefault');
        const apagar = menus.filter(m => !m.isDefault);
        log(`📑 ${menus.length} menus | ${apagar.length} podem ser apagados`);
        let ok = 0, erros = 0;
        for (const m of apagar) {
          try {
            const r = await gql(destination.shop,
              `mutation($id:ID!){menuDelete(id:$id){deletedMenuId userErrors{message}}}`,
              { id: m.id }, tokenDest);
            if ((r.menuDelete?.userErrors || []).length > 0) { erros++; }
            else ok++;
          } catch { erros++; }
          await sleep(150);
        }
        log(`✅ Menus: ${ok} apagados | ${erros} erros`, "success");
      } catch (e) { log(`⚠️ Menus: ${e.message.slice(0, 80)}`); }
    }

    // ── DESCONTOS ──
    if (etapas.descontos) {
      log("━━━━━━━━━━ RESET: DESCONTOS ━━━━━━━━━━");
      const prs = await restPaginated(destination.shop, "/price_rules.json?limit=250", tokenDest, "price_rules");
      log(`🎟️ ${prs.length} descontos a apagar`);
      let ok = 0, erros = 0;
      for (let i = 0; i < prs.length; i++) {
        progress("reset_descontos", i + 1, prs.length);
        try { await restCall("DELETE", destination.shop, `/price_rules/${prs[i].id}.json`, tokenDest); ok++; }
        catch { erros++; }
        await sleep(150);
      }
      log(`✅ Descontos: ${ok} apagados | ${erros} erros`, "success");
    }

    // ── ARQUIVOS: apaga fotos/vídeos soltos, PROTEGENDO as fotos dos produtos ──
    if (etapas.arquivos) {
      log("━━━━━━━━━━ RESET: ARQUIVOS ━━━━━━━━━━");

      // 1. Lista as fotos que os produtos USAM — essas são intocáveis.
      //    (senão a loja ficaria com todos os produtos sem imagem)
      const protegidos = new Set();
      try {
        const prods = await restPaginated(destination.shop, "/products.json?limit=250&fields=id,images", tokenDest, "products");
        for (const p of prods)
          for (const img of (p.images || []))
            if (img.src) protegidos.add(img.src.split("?")[0].split("/").pop());
        log(`🛡️ ${protegidos.size} fotos de produto protegidas (não serão apagadas)`);
      } catch (e) { throw new Error('Reset de arquivos interrompido: não foi possível verificar as imagens dos produtos. '+e.message); }

      // 2. Lista todos os arquivos da loja e separa o que pode apagar
      const apagarIds = [];
      let puladosProt = 0, cursor = null;
      while (true) {
        const after = cursor ? `, after: "${cursor}"` : "";
        const q = `query { files(first: 100${after}) { edges { cursor node { ... on MediaImage { id image { url } } ... on GenericFile { id url } ... on Video { id } } } pageInfo { hasNextPage endCursor } } }`;
        const d = await gql(destination.shop, q, {}, tokenDest);
        for (const e of d.files.edges) {
          const n = e.node;
          if (!n.id) continue;
          const u = n?.image?.url || n?.url;
          const fname = u ? u.split("/").pop().split("?")[0] : null;
          if (fname && protegidos.has(fname)) { puladosProt++; continue; }
          apagarIds.push(n.id);
        }
        if (!d.files.pageInfo.hasNextPage) break;
        if(!d.files.pageInfo.endCursor||cursor===d.files.pageInfo.endCursor)throw new Error('Paginação inválida de arquivos.');
        cursor = d.files.pageInfo.endCursor;
      }
      log(`🖼️ ${apagarIds.length} arquivos a apagar | ${puladosProt} protegidos (em uso por produtos)`);

      // 3. Apaga em rodadas de 750 (3 chamadas de 250 ao mesmo tempo)
      //    — o máximo que a Shopify aceita por chamada é 250, então a gente
      //    compensa mandando 3 chamadas em paralelo por rodada.
      let ok = 0, erros = 0;
      const TAM_LOTE = 250, PARALELO = 3;
      const passo = TAM_LOTE * PARALELO; // 750 por rodada
      for (let i = 0; i < apagarIds.length; i += passo) {
        const rodada = [];
        for (let j = 0; j < PARALELO; j++) {
          const lote = apagarIds.slice(i + j * TAM_LOTE, i + (j + 1) * TAM_LOTE);
          if (lote.length === 0) break;
          rodada.push(
            gql(destination.shop,
              `mutation($ids:[ID!]!){fileDelete(fileIds:$ids){deletedFileIds userErrors{message}}}`,
              { ids: lote }, tokenDest)
            .then(r => ({ lote, r }))
            .catch(e => ({ lote, erro: e }))
          );
        }
        const resultados = await Promise.all(rodada);
        for (const res of resultados) {
          if (res.erro) { erros += res.lote.length; log(`  ❌ ${res.erro.message.slice(0, 70)}`); continue; }
          const deletados = (res.r.fileDelete?.deletedFileIds || []).length;
          ok += deletados;
          const ue = res.r.fileDelete?.userErrors || [];
          erros += res.lote.length - deletados;
          if (ue.length > 0) log(`  ⚠️ ${ue[0].message.slice(0, 70)}`);
        }
        progress("reset_arquivos", Math.min(i + passo, apagarIds.length), apagarIds.length);
        log(`  🗑️ ${ok} de ${apagarIds.length} apagados...`);
        await sleep(500);
      }
      log(`✅ Arquivos: ${ok} apagados | ${puladosProt} protegidos | ${erros} erros`, "success");
    }

    // ── PRODUTOS (⚠️ apaga TUDO) ──
    if (etapas.produtos) {
      log("━━━━━━━━━━ RESET: PRODUTOS ⚠️ ━━━━━━━━━━");
      const prods = await restPaginated(destination.shop, "/products.json?limit=250&fields=id", tokenDest, "products");
      log(`📦 ${prods.length} produtos a apagar — isso pode demorar alguns minutos`);
      let ok = 0, erros = 0;
      for (let i = 0; i < prods.length; i += 5) {
        const lote = prods.slice(i, i + 5);
        progress("reset_produtos", Math.min(i + 5, prods.length), prods.length);
        const rs = await Promise.allSettled(lote.map(p =>
          restCall("DELETE", destination.shop, `/products/${p.id}.json`, tokenDest)));
        for (const r of rs) r.status === "fulfilled" ? ok++ : erros++;
        if (i % 100 === 0 && i > 0) log(`  🗑️ ${ok} apagados até agora...`);
        await sleep(300);
      }
      log(`✅ Produtos: ${ok} apagados | ${erros} erros`, "success");
    }

    send("done", { hasErrors, msg: hasErrors ? "Reset finalizado com pendências. Confira os erros antes de repetir." : "Reset concluído. Você pode clonar novamente as etapas selecionadas." });
  } catch (err) {
    send("error", { msg: `💥 Erro fatal no reset: ${err.message}` });
  }
};


