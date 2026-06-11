// ============================================================
//  ORGANIZAR PRODUTOS NAS COLEÇÕES — yq1q0e-nb
//
//  1. Smart collections → expande regras com mais palavras-chave
//     baseadas nos títulos dos produtos que deveriam estar lá
//  2. Custom collections → varre todos os produtos e adiciona
//     os que fazem sentido pelo título
// ============================================================

const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));

const DESTINO = {
  shop: "yq1q0e-nb.myshopify.com",
  clientId: "74fc1beebdcb46a1cbd0dcc38c1d2fec",
  clientSecret: "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",
};

const ORIGEM = {
  shop: "cc4dd5-2.myshopify.com",
  clientId: "015b12e6bee1201d789cccd217ad98cc",
  clientSecret: "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",
};

async function auth(loja) {
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: loja.clientId, client_secret: loja.clientSecret });
  const res = await fetch(`https://${loja.shop}/admin/oauth/access_token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
  return (await res.json()).access_token;
}

async function rest(method, shop, path, token, body = null) {
  let attempt = 0;
  while (attempt < 5) {
    const opts = { method, headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`https://${shop}/admin/api/2024-10${path}`, opts);
    if (res.status === 429) { attempt++; await sleep(2000 * attempt); continue; }
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }
  throw new Error("Rate limit");
}

async function restPaginated(shop, path, token, key) {
  const items = [];
  let url = `https://${shop}/admin/api/2024-10${path}`;
  while (url) {
    let attempt = 0;
    while (attempt < 5) {
      const res = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
      if (res.status === 429) { attempt++; await sleep(2000 * attempt); continue; }
      if (!res.ok) throw new Error(`Erro ${res.status}`);
      const data = await res.json();
      (data[key] || []).forEach(i => items.push(i));
      const link = res.headers.get("link") || "";
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
      break;
    }
  }
  return items;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
//  Extrai palavras-chave relevantes de um título de produto
// ============================================================
function extrairPalavrasChave(titulo) {
  const stop = new Set(["the","and","for","with","de","do","da","em","x","a","o","e","&","-","/"]);
  return titulo
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stop.has(w));
}

// ============================================================
//  Para uma coleção, encontra quais produtos da loja 
//  "pertencem" a ela baseado no nome da coleção
// ============================================================
function produtosQuePertencem(colTitle, produtos) {
  const palavrasCol = extrairPalavrasChave(colTitle);
  if (palavrasCol.length === 0) return [];

  return produtos.filter(p => {
    const palavrasProd = new Set(extrairPalavrasChave(p.title));
    // Produto pertence se tem pelo menos 50% das palavras da coleção no título
    let matches = 0;
    for (const w of palavrasCol) if (palavrasProd.has(w)) matches++;
    return matches / palavrasCol.length >= 0.5;
  });
}

// ============================================================
//  Expande regras de smart collection baseado nos produtos
//  que deveriam estar nela mas não estão sendo capturados
// ============================================================
function gerarRegrasExpandidas(colTitle, produtos, regrasExistentes) {
  // Pega produtos que deveriam estar na coleção
  const produtosPertinentes = produtosQuePertencem(colTitle, produtos);
  if (produtosPertinentes.length === 0) return regrasExistentes;

  // Extrai palavras-chave dos títulos pertinentes
  const contagemPalavras = {};
  for (const p of produtosPertinentes) {
    for (const w of extrairPalavrasChave(p.title)) {
      contagemPalavras[w] = (contagemPalavras[w] || 0) + 1;
    }
  }

  // Palavras que aparecem em pelo menos 30% dos produtos pertinentes
  const minOcorrencias = Math.max(1, Math.floor(produtosPertinentes.length * 0.3));
  const palavrasFrequentes = Object.entries(contagemPalavras)
    .filter(([_, c]) => c >= minOcorrencias)
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w);

  // Regras existentes
  const regrasAtuais = new Set(regrasExistentes.map(r => r.condition?.toLowerCase()));

  // Novas regras: palavras frequentes que não estão cobertas
  const novasRegras = [...regrasExistentes];
  for (const palavra of palavrasFrequentes.slice(0, 10)) {
    if (!regrasAtuais.has(palavra) && palavra.length >= 3) {
      novasRegras.push({ column: "title", relation: "contains", condition: palavra });
      regrasAtuais.add(palavra);
    }
  }

  return novasRegras;
}

// ============================================================
//  MAIN
// ============================================================
async function main() {
  console.log("=".repeat(65));
  console.log("  📦 ORGANIZAR PRODUTOS NAS COLEÇÕES");
  console.log("=".repeat(65));
  console.log(`  Destino: ${DESTINO.shop}\n`);

  const tokenDest = await auth(DESTINO);
  const tokenOrig = await auth(ORIGEM);

  // ── Busca todos os produtos do destino ──
  console.log("🔍 Buscando produtos da loja destino...");
  const produtos = await restPaginated(DESTINO.shop, "/products.json?limit=250&fields=id,title,handle", tokenDest, "products");
  console.log(`   ✅ ${produtos.length} produtos\n`);

  // ── IDs de produtos já em cada coleção ──
  async function getProdutosNaColecao(colId) {
    const collects = await restPaginated(DESTINO.shop, `/collects.json?collection_id=${colId}&limit=250`, tokenDest, "collects");
    return new Set(collects.map(c => c.product_id));
  }

  // ============================================================
  //  SMART COLLECTIONS — expande regras
  // ============================================================
  console.log("=".repeat(65));
  console.log("  1️⃣  SMART COLLECTIONS — expandindo regras");
  console.log("=".repeat(65) + "\n");

  const smartCols = await restPaginated(DESTINO.shop, "/smart_collections.json?limit=250", tokenDest, "smart_collections");
  console.log(`   ${smartCols.length} smart collections\n`);

  for (let i = 0; i < smartCols.length; i++) {
    const col = smartCols[i];
    const regrasAntes = col.rules || [];
    const regrasDepois = gerarRegrasExpandidas(col.title, produtos, regrasAntes);

    const novasRegras = regrasDepois.length - regrasAntes.length;
    process.stdout.write(`[${i+1}/${smartCols.length}] ${col.title.slice(0,45).padEnd(45)}`);

    if (novasRegras === 0) {
      console.log(` — sem novas regras`);
      continue;
    }

    // Mostra quais regras vai adicionar
    const adicionadas = regrasDepois.slice(regrasAntes.length).map(r => `"${r.condition}"`).join(", ");
    process.stdout.write(` +${novasRegras} regras (${adicionadas.slice(0, 60)})`);

    try {
      await rest("PUT", DESTINO.shop, `/smart_collections/${col.id}.json`, tokenDest, {
        smart_collection: {
          id: col.id,
          rules: regrasDepois,
          disjunctive: true, // OR — qualquer regra que bater inclui o produto
        },
      });
      console.log(` ✅`);
    } catch (err) {
      console.log(` ❌ ${err.message.slice(0, 60)}`);
    }
    await sleep(300);
  }

  // ============================================================
  //  CUSTOM COLLECTIONS — adiciona produtos por título
  // ============================================================
  console.log("\n" + "=".repeat(65));
  console.log("  2️⃣  CUSTOM COLLECTIONS — adicionando produtos");
  console.log("=".repeat(65) + "\n");

  const customCols = await restPaginated(DESTINO.shop, "/custom_collections.json?limit=250", tokenDest, "custom_collections");
  console.log(`   ${customCols.length} custom collections\n`);

  let totalAdicionados = 0;

  for (let i = 0; i < customCols.length; i++) {
    const col = customCols[i];
    const produtosNaCol = await getProdutosNaColecao(col.id);
    const candidatos = produtosQuePertencem(col.title, produtos);
    const novos = candidatos.filter(p => !produtosNaCol.has(p.id));

    process.stdout.write(`[${i+1}/${customCols.length}] ${col.title.slice(0,40).padEnd(40)} ${candidatos.length} candidatos | ${novos.length} novos`);

    if (novos.length === 0) { console.log(); continue; }

    let adicionados = 0;
    for (const p of novos) {
      try {
        await rest("POST", DESTINO.shop, "/collects.json", tokenDest, { collect: { collection_id: col.id, product_id: p.id } });
        adicionados++;
        totalAdicionados++;
      } catch {} // ignora duplicados
      await sleep(100);
    }
    console.log(` → ${adicionados} adicionados`);
    await sleep(200);
  }

  // ============================================================
  //  VERIFICAÇÃO FINAL — produtos sem coleção
  // ============================================================
  console.log("\n" + "=".repeat(65));
  console.log("  3️⃣  VERIFICAÇÃO — produtos sem nenhuma coleção");
  console.log("=".repeat(65) + "\n");

  // Produtos que estão em pelo menos 1 coleção
  const todosCollects = await restPaginated(DESTINO.shop, "/collects.json?limit=250", tokenDest, "collects");
  const prodsComColecao = new Set(todosCollects.map(c => c.product_id));
  const semColecao = produtos.filter(p => !prodsComColecao.has(p.id));

  if (semColecao.length === 0) {
    console.log("   ✅ Todos os produtos estão em pelo menos 1 coleção!\n");
  } else {
    console.log(`   ⚠️  ${semColecao.length} produtos sem coleção:\n`);
    semColecao.slice(0, 30).forEach((p, i) => console.log(`   ${(i+1).toString().padStart(3)}. ${p.title.slice(0, 60)}`));
    if (semColecao.length > 30) console.log(`   ... e mais ${semColecao.length - 30}`);
    console.log("\n   💡 Esses produtos podem precisar de uma coleção nova ou ter");
    console.log("      o título ajustado pra bater com alguma coleção existente.");
  }

  console.log("\n" + "=".repeat(65));
  console.log("  ✅ CONCLUÍDO!");
  console.log(`  📦 ${totalAdicionados} produtos adicionados a custom collections`);
  console.log("=".repeat(65));
}

main().catch(err => { console.error("\n💥", err.message); process.exit(1); });
