// ============================================================
//  SHOPIFY STORE CLONER — Server
//  Roda em http://localhost:3000
// ============================================================

import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// ============================================================
//  SHOPIFY API HELPERS
// ============================================================
async function getToken(shop, clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  return (await res.json()).access_token;
}

async function restCall(method, shop, path, token, body = null) {
  let attempt = 0;
  while (attempt < 5) {
    const opts = {
      method,
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`https://${shop}/admin/api/2024-10${path}`, opts);
    if (res.status === 429) { attempt++; await sleep(2000 * attempt); continue; }
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
  throw new Error("Rate limit persistente");
}

// ============================================================
//  Baixa imagem como base64 (resolve problema de CDN entre lojas)
// ============================================================
async function downloadBase64(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 500) return null; // muito pequeno = placeholder
    return Buffer.from(buf).toString("base64");
  } catch { return null; }
}

// Upload de imagem como base64 via GraphQL fileCreate
async function uploadFileBase64(base64, filename, tokenDest, shopDest) {
  if (!base64) return null;
  const ext = filename.split(".").pop().toLowerCase() || "jpg";
  const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
  // Usa staging uploads do Shopify pra upload de base64
  const mutation = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          ... on MediaImage {
            id
            image { url }
          }
        }
        userErrors { field message }
      }
    }
  `;
  try {
    const data = await gql(shopDest, mutation, {
      files: [{ originalSource: `data:${mime};base64,${base64}`, contentType: "IMAGE", filename }]
    }, tokenDest);
    return data.fileCreate?.files?.[0]?.image?.url || null;
  } catch { return null; }
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
      (data[key] || []).forEach((i) => items.push(i));
      const link = res.headers.get("link") || "";
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
      break;
    }
  }
  return items;
}

async function gql(shop, query, variables, token) {
  const res = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Processa items em lotes paralelos de N
async function batch(items, fn, concurrency = 5, delayMs = 100) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const res = await Promise.allSettled(chunk.map(fn));
    results.push(...res);
    if (i + concurrency < items.length) await sleep(delayMs);
  }
  return results;
}

// ============================================================
//  API: TEST AUTH
// ============================================================
app.post("/api/auth", async (req, res) => {
  const { shop, clientId, clientSecret } = req.body;
  try {
    const token = await getToken(shop, clientId, clientSecret);
    const data = await gql(shop, `query { shop { name myshopifyDomain currencyCode } }`, {}, token);
    res.json({ ok: true, shop: data.shop });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ============================================================
//  API: CLONE (SSE — Server-Sent Events)
// ============================================================
// ============================================================
//  LÓGICA DO CLONE — roda em background, mandando eventos pro job
// ============================================================
const runClone = async (body, send) => {
  const { origin, destination, options, customize } = body;

  // Função que substitui nome da loja e email em qualquer texto
  function replaceContent(text) {
    if (!text || typeof text !== 'string') return text;
    let result = text;
    if (customize?.originName && customize?.destName) {
      result = result.split(customize.originName).join(customize.destName);
      // Também tenta case-insensitive
      const regex = new RegExp(customize.originName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      result = result.replace(regex, customize.destName);
    }
    if (customize?.originEmail && customize?.destEmail) {
      result = result.split(customize.originEmail).join(customize.destEmail);
    }
    return result;
  }

  const log = (msg, status = "info") => send("log", { msg, status });
  const progress = (step, current, total) => send("progress", { step, current, total });

  try {
    log("🔑 Autenticando nas duas lojas...");
    const tokenOrig = await getToken(origin.shop, origin.clientId, origin.clientSecret);
    const tokenDest = await getToken(destination.shop, destination.clientId, destination.clientSecret);
    log("✅ Autenticado nas duas lojas", "success");

    if (customize?.originName && customize?.destName) {
      log(`🔄 Substituir: "${customize.originName}" → "${customize.destName}" em todo conteúdo`);
    }
    if (customize?.originEmail && customize?.destEmail) {
      log(`🔄 Substituir: "${customize.originEmail}" → "${customize.destEmail}" em todo conteúdo`);
    }

    const productIdMap = {};
    const collectionIdMap = {};
    const origIdToHandle = {};
    const handleToDestId = {};

    // ==== PRODUTOS ====
    if (options.products) {
      log("━━━━━━━━━━ ETAPA 1: PRODUTOS ━━━━━━━━━━");
      const produtos = await restPaginated(origin.shop, "/products.json?limit=250", tokenOrig, "products");
      log(`📦 ${produtos.length} produtos na origem`);

      const existentes = await restPaginated(destination.shop, "/products.json?limit=250&fields=id,handle", tokenDest, "products");
      const handlesDest = new Map();
      existentes.forEach((p) => handlesDest.set(p.handle, p.id));

      let criados = 0, pulados = 0, falha = 0;

      // Pré-mapeia os que já existem (rápido)
      for (const p of produtos) {
        origIdToHandle[p.id] = p.handle;
        if (handlesDest.has(p.handle)) {
          productIdMap[p.id] = handlesDest.get(p.handle);
          handleToDestId[p.handle] = handlesDest.get(p.handle);
          pulados++;
        }
      }
      log(`⏭️ ${pulados} já existem, criando ${produtos.length - pulados} novos (5 em paralelo)...`);

      const novos = produtos.filter(p => !handlesDest.has(p.handle));
      for (let i = 0; i < novos.length; i += 5) {
        const chunk = novos.slice(i, i + 5);
        await Promise.allSettled(chunk.map(async (p) => {
          try {
            const images = (p.images || []).map((img) => ({ src: img.src, alt: img.alt || "" }));
            const variants = (p.variants || []).map((v) => ({
              option1: v.option1, option2: v.option2, option3: v.option3,
              price: v.price, compare_at_price: v.compare_at_price,
              sku: v.sku, barcode: v.barcode,
              inventory_management: v.inventory_management,
              inventory_policy: v.inventory_policy || "continue",
              inventory_quantity: v.inventory_quantity || 100,
              requires_shipping: v.requires_shipping, taxable: v.taxable,
              weight: v.weight, weight_unit: v.weight_unit,
            }));
            const opts = (p.options || []).map((o) => ({ name: o.name, values: o.values }));
            const data = await restCall("POST", destination.shop, "/products.json", tokenDest, {
              product: {
                title: p.title, body_html: replaceContent(p.body_html),
                vendor: p.vendor, product_type: p.product_type,
                handle: p.handle, tags: p.tags,
                status: p.status || "active", published: true,
                options: opts, variants, images,
              },
            });
            productIdMap[p.id] = data.product.id;
            handleToDestId[p.handle] = data.product.id;
            criados++;
          } catch (err) { falha++; }
        }));
        progress("products", Math.min(i + 5, novos.length), novos.length);
        if (criados % 20 === 0 && criados > 0) log(`✅ ${criados} produtos criados...`);
        await sleep(50);
      }
      log(`✅ Produtos: ${criados} criados | ${pulados} já existiam | ${falha} erros`, "success");
    }

    // ==== SMART COLLECTIONS ====
    if (options.collections) {
      log("━━━━━━━━━━ ETAPA 2: SMART COLLECTIONS ━━━━━━━━━━");
      const cols = await restPaginated(origin.shop, "/smart_collections.json?limit=250", tokenOrig, "smart_collections");
      const existentes = await restPaginated(destination.shop, "/smart_collections.json?limit=250&fields=id,handle", tokenDest, "smart_collections");
      const handlesDest = new Map();
      existentes.forEach((c) => handlesDest.set(c.handle, c.id));

      let criados = 0, pulados = 0;
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        progress("smart_collections", i + 1, cols.length);
        if (handlesDest.has(c.handle)) {
          collectionIdMap[c.id] = handlesDest.get(c.handle);
          pulados++; continue;
        }
        try {
          const body = { smart_collection: { title: c.title, handle: c.handle, body_html: replaceContent(c.body_html), rules: c.rules, disjunctive: c.disjunctive, sort_order: c.sort_order, published: true } };
          if (c.image?.src) {
            const b64 = await downloadBase64(c.image.src);
            body.smart_collection.image = b64 ? { attachment: b64 } : { src: c.image.src };
          }
          const data = await restCall("POST", destination.shop, "/smart_collections.json", tokenDest, body);
          collectionIdMap[c.id] = data.smart_collection.id;
          criados++;
        } catch {}
        await sleep(100);
      }
      log(`✅ Smart collections: ${criados} criadas | ${pulados} já existiam`, "success");

      // CUSTOM COLLECTIONS
      log("━━━━━━━━━━ ETAPA 3: CUSTOM COLLECTIONS ━━━━━━━━━━");
      const customCols = await restPaginated(origin.shop, "/custom_collections.json?limit=250", tokenOrig, "custom_collections");
      const existentesCust = await restPaginated(destination.shop, "/custom_collections.json?limit=250&fields=id,handle", tokenDest, "custom_collections");
      const handlesDestCust = new Map();
      existentesCust.forEach((c) => handlesDestCust.set(c.handle, c.id));

      let criadosC = 0, puladosC = 0, totalCollects = 0;
      for (let i = 0; i < customCols.length; i++) {
        const c = customCols[i];
        progress("custom_collections", i + 1, customCols.length);
        let destColId;
        if (handlesDestCust.has(c.handle)) {
          destColId = handlesDestCust.get(c.handle);
          collectionIdMap[c.id] = destColId;
          puladosC++;
        } else {
          try {
            const body = { custom_collection: { title: c.title, handle: c.handle, body_html: replaceContent(c.body_html), sort_order: c.sort_order || "manual", published: true } };
            if (c.image?.src) {
              const b64 = await downloadBase64(c.image.src);
              body.custom_collection.image = b64 ? { attachment: b64 } : { src: c.image.src };
            }
            const data = await restCall("POST", destination.shop, "/custom_collections.json", tokenDest, body);
            destColId = data.custom_collection.id;
            collectionIdMap[c.id] = destColId;
            criadosC++;
          } catch { continue; }
        }
        // Add collects in order
        try {
          const collects = await restPaginated(origin.shop, `/collects.json?collection_id=${c.id}&limit=250`, tokenOrig, "collects");
          let pos = 1;
          for (const col of collects) {
            const newProdId = productIdMap[col.product_id];
            if (!newProdId) continue;
            try {
              await restCall("POST", destination.shop, "/collects.json", tokenDest, {
                collect: { collection_id: destColId, product_id: newProdId, position: pos++ },
              });
              totalCollects++;
            } catch {}
            await sleep(50);
          }
        } catch {}
        await sleep(80);
      }
      log(`✅ Custom collections: ${criadosC} criadas | ${puladosC} existiam | ${totalCollects} collects`, "success");
    }

    // ==== PÁGINAS ====
    if (options.pages) {
      log("━━━━━━━━━━ ETAPA 4: PÁGINAS ━━━━━━━━━━");
      const pages = await restPaginated(origin.shop, "/pages.json?limit=250", tokenOrig, "pages");
      const existentes = await restPaginated(destination.shop, "/pages.json?limit=250&fields=handle", tokenDest, "pages");
      const handlesDest = new Set(existentes.map((p) => p.handle));
      let criados = 0;
      for (const p of pages) {
        if (handlesDest.has(p.handle)) continue;
        try {
          await restCall("POST", destination.shop, "/pages.json", tokenDest, {
            page: { title: p.title, handle: p.handle, body_html: replaceContent(p.body_html), published: true },
          });
          criados++;
        } catch {}
        await sleep(80);
      }
      log(`✅ Páginas: ${criados} criadas`, "success");
    }

    // ==== MENUS ====
    if (options.menus) {
      log("━━━━━━━━━━ ETAPA 5: MENUS ━━━━━━━━━━");
      const queryMenus = `query { menus(first: 20) { edges { node { id title handle items { title type url resourceId items { title type url resourceId } } } } } }`;
      const dataOrig = await gql(origin.shop, queryMenus, {}, tokenOrig);
      const dataDest = await gql(destination.shop, queryMenus, {}, tokenDest);
      const menusDestino = new Map();
      dataDest.menus.edges.forEach((e) => menusDestino.set(e.node.handle, e.node));

      function remapItem(item) {
        const novo = { title: item.title, type: "HTTP", url: item.url || "#" };
        if (item.items?.length > 0) novo.items = item.items.map(remapItem);
        return novo;
      }

      for (const e of dataOrig.menus.edges) {
        const menu = e.node;
        const items = (menu.items || []).map(remapItem);
        if (menusDestino.has(menu.handle)) {
          const dest = menusDestino.get(menu.handle);
          try {
            await gql(destination.shop, `mutation menuUpdate($id:ID!,$title:String!,$handle:String!,$items:[MenuItemUpdateInput!]!){menuUpdate(id:$id,title:$title,handle:$handle,items:$items){menu{id}userErrors{message}}}`,
              { id: dest.id, title: menu.title, handle: menu.handle, items }, tokenDest);
          } catch {}
        } else {
          try {
            await gql(destination.shop, `mutation menuCreate($title:String!,$handle:String!,$items:[MenuItemCreateInput!]!){menuCreate(title:$title,handle:$handle,items:$items){menu{id}userErrors{message}}}`,
              { title: menu.title, handle: menu.handle, items }, tokenDest);
          } catch {}
        }
      }
      log("✅ Menus copiados", "success");
    }

    // ==== POLÍTICAS ====
    if (options.policies) {
      log("━━━━━━━━━━ ETAPA 6: POLÍTICAS ━━━━━━━━━━");
      try {
        const dataP = await gql(origin.shop, `query { shop { shopPolicies { type body } } }`, {}, tokenOrig);
        for (const pol of dataP.shop.shopPolicies || []) {
          if (!pol.body?.trim()) continue;
          try {
            await gql(destination.shop, `mutation shopPolicyUpdate($shopPolicy:ShopPolicyInput!){shopPolicyUpdate(shopPolicy:$shopPolicy){shopPolicy{type}userErrors{message}}}`,
              { shopPolicy: { type: pol.type, body: replaceContent(pol.body) } }, tokenDest);
          } catch {}
        }
        log("✅ Políticas copiadas", "success");
      } catch (err) {
        log("⚠️ Sem permissão para políticas (ative read_legal_policies no app) — pulando", "error");
      }
    }

    // ==== ARQUIVOS (banners, ícones) ====
    if (options.files) {
      log("━━━━━━━━━━ ETAPA 7: ARQUIVOS (banners, ícones) ━━━━━━━━━━");

      // ── 7.1 Lista os arquivos da ORIGEM ──
      const arquivos = [];
      let cursor = null;
      while (true) {
        const after = cursor ? `, after: "${cursor}"` : "";
        const q = `query { files(first: 100${after}) { edges { cursor node { ... on MediaImage { id alt image { url originalSrc } fileStatus } ... on GenericFile { id url alt fileStatus } } } pageInfo { hasNextPage endCursor } } }`;
        const data = await gql(origin.shop, q, {}, tokenOrig);
        for (const e of data.files.edges) {
          const n = e.node;
          const url = n?.image?.originalSrc || n?.image?.url || n?.url;
          if (url && n.fileStatus === "READY") {
            const filename = url.split("/").pop().split("?")[0];
            arquivos.push({ url, alt: n.alt || "", filename });
          }
        }
        if (!data.files.pageInfo.hasNextPage) break;
        cursor = data.files.pageInfo.endCursor;
      }
      log(`📁 ${arquivos.length} arquivos encontrados na origem`);

      // ── 7.2 REMOVE as fotos de produto da lista ──
      // Pegadinha da Shopify: a API de "files" devolve TAMBÉM as fotos dos
      // produtos, não só os banners da aba Conteúdo → Arquivos. Como as fotos
      // de produto já sobem junto com os produtos na Etapa 1, subir aqui de
      // novo = tudo duplicado. Então a gente lista as fotos de produto da
      // origem e tira elas da lista.
      const fotosProduto = new Set();
      try {
        const prods = await restPaginated(origin.shop, "/products.json?limit=250&fields=id,images", tokenOrig, "products");
        for (const p of prods) {
          for (const img of (p.images || [])) {
            if (img.src) fotosProduto.add(img.src.split("?")[0].split("/").pop());
          }
        }
      } catch (e) { log(`⚠️ Não consegui listar fotos de produto: ${e.message.slice(0,60)}`); }

      const soArquivosReais = arquivos.filter(a => !fotosProduto.has(a.filename));
      log(`🖼️ ${arquivos.length - soArquivosReais.length} fotos de produto ignoradas (já sobem na Etapa 1) → ${soArquivosReais.length} arquivos de verdade`);

      // ── 7.3 PULA o que já existe no destino ──
      // Se um clone anterior deu erro no meio, os arquivos que já subiram
      // ficam salvos — então a gente lista o destino e só sobe o que falta.
      const filenameMapDest = {}; // nome do arquivo → URL no destino
      const lerArquivosDestino = async () => {
        let c = null, total = 0;
        while (true) {
          const after = c ? `, after: "${c}"` : "";
          const q = `query { files(first: 100${after}) { edges { cursor node { ... on MediaImage { image { url } fileStatus } ... on GenericFile { url fileStatus } } } pageInfo { hasNextPage endCursor } } }`;
          const d = await gql(destination.shop, q, {}, tokenDest);
          for (const e of d.files.edges) {
            const n = e.node;
            const u = n?.image?.url || n?.url;
            if (u && n.fileStatus === "READY") {
              filenameMapDest[u.split("/").pop().split("?")[0]] = u;
              total++;
            }
          }
          if (!d.files.pageInfo.hasNextPage) break;
          c = d.files.pageInfo.endCursor;
        }
        return total;
      };
      await lerArquivosDestino();

      const paraSubir = soArquivosReais.filter(a => !filenameMapDest[a.filename]);
      const jaExistem = soArquivosReais.length - paraSubir.length;
      log(`⏭️ ${jaExistem} já existem no destino | ⬆️ ${paraSubir.length} a subir`);

      // ── 7.4 SOBE EM LOTES DE 10 (muito mais rápido) ──
      // Em vez de baixar cada foto pro servidor e re-enviar (lento), a gente
      // manda a URL da CDN da origem e a PRÓPRIA SHOPIFY busca o arquivo.
      // E em vez de 1 por vez, vão 10 numa chamada só.
      let uploaded = 0, falhasUpload = 0;
      for (let i = 0; i < paraSubir.length; i += 10) {
        const lote = paraSubir.slice(i, i + 10);
        progress("files", Math.min(i + 10, paraSubir.length), paraSubir.length);
        const inputs = lote.map(arq => {
          const ext = arq.filename.split(".").pop().toLowerCase();
          const isImage = ["png","gif","webp","svg","jpg","jpeg","avif","heic"].includes(ext);
          return {
            filename: arq.filename,
            alt: arq.alt,
            contentType: isImage ? "IMAGE" : "FILE",
            duplicateResolutionMode: "REPLACE",
            originalSource: arq.url,
          };
        });
        try {
          const r = await gql(destination.shop,
            `mutation fileCreate($files:[FileCreateInput!]!){fileCreate(files:$files){files{id}userErrors{message}}}`,
            { files: inputs }, tokenDest);
          const erros = r.fileCreate?.userErrors || [];
          if (erros.length === 0) {
            uploaded += lote.length;
          } else {
            // O lote falhou — tenta um por um com base64 (plano B, mais lento mas garantido)
            for (const arq of lote) {
              try {
                const b64 = await downloadBase64(arq.url);
                if (!b64) { falhasUpload++; continue; }
                const ext = arq.filename.split(".").pop().toLowerCase();
                const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : ext === "svg" ? "image/svg+xml" : "image/jpeg";
                const r2 = await gql(destination.shop,
                  `mutation fileCreate($files:[FileCreateInput!]!){fileCreate(files:$files){files{id}userErrors{message}}}`,
                  { files: [{ filename: arq.filename, alt: arq.alt, contentType: "IMAGE", duplicateResolutionMode: "REPLACE", originalSource: `data:${mime};base64,${b64}` }] },
                  tokenDest);
                if ((r2.fileCreate?.userErrors || []).length === 0) uploaded++;
                else falhasUpload++;
              } catch { falhasUpload++; }
              await sleep(150);
            }
          }
        } catch { falhasUpload += lote.length; }
        await sleep(300);
      }
      log(`✅ Arquivos: ${uploaded} enviados | ${jaExistem} reaproveitados | ${falhasUpload} falhas`, "success");

      // ── 7.5 Espera processar e monta o mapa de URLs (origem → destino) ──
      if (paraSubir.length > 0) {
        for (let tentativa = 1; tentativa <= 6; tentativa++) {
          await sleep(5000);
          const prontos = await lerArquivosDestino();
          const faltam = soArquivosReais.filter(a => !filenameMapDest[a.filename]).length;
          log(`⏳ Tentativa ${tentativa}/6 — ${prontos} prontos no destino | ${faltam} ainda processando`);
          if (faltam === 0) break;
        }
      }

      const urlMap = {};
      for (const arq of soArquivosReais) {
        const destUrl = filenameMapDest[arq.filename];
        if (destUrl) urlMap[arq.url] = destUrl;
      }
      log(`🔄 ${Object.keys(urlMap).length} URLs mapeadas para substituição no tema`, "success");
      customize._urlMap = urlMap;
      customize._filenameMapDest = filenameMapDest;
      customize._originShopCDN = origin.shop.replace(".myshopify.com", "");
    }

    // ==== TEMA ====
    if (options.theme) {
      log("━━━━━━━━━━ ETAPA 8: TEMA (settings + templates + sections) ━━━━━━━━━━");
      const temasOrig = await restCall("GET", origin.shop, "/themes.json", tokenOrig);
      const temasDest = await restCall("GET", destination.shop, "/themes.json", tokenDest);
      const tOrigem = temasOrig.themes.find((t) => t.role === "main");
      const tDestino = temasDest.themes.find((t) => t.role === "main");

      if (tOrigem && tDestino) {
        const assetsOrig = await restCall("GET", origin.shop, `/themes/${tOrigem.id}/assets.json`, tokenOrig);

        // Agora copia TODOS os assets — incluindo imagens/fonts dentro de assets/
        // (antes só copiava .css/.js/.json/.svg, e os banners que vivem DENTRO
        //  do tema como assets/banner.jpg nunca eram copiados)
        let keys = (assetsOrig.assets || []).map((a) => a.key);

        // Ordem importa: settings_data.json (onde ficam os banners da home)
        // vai por ÚLTIMO, depois que sections/templates/imagens já existem.
        const peso = (k) => {
          if (k === "config/settings_data.json") return 99;
          if (k.startsWith("config/")) return 90;
          if (k.startsWith("templates/")) return 50;
          if (k.startsWith("sections/")) return 40;
          if (k.startsWith("snippets/")) return 30;
          if (k.startsWith("layout/")) return 20;
          if (k.startsWith("locales/")) return 60;
          return 10; // assets/ primeiro (imagens do tema disponíveis antes)
        };
        keys.sort((a, b) => peso(a) - peso(b));

        // Função que troca QUALQUER url do CDN da origem pela do destino,
        // casando pelo NOME do arquivo (mais robusto que URL exata, porque
        // a Shopify muda os caminhos internos entre lojas)
        const trocarUrls = (value) => {
          if (customize._urlMap) {
            for (const [origUrl, destUrl] of Object.entries(customize._urlMap)) {
              value = value.split(origUrl).join(destUrl);
              const origBase = origUrl.split("?")[0];
              const destBase = destUrl.split("?")[0];
              if (origBase !== origUrl) value = value.split(origBase).join(destBase);
            }
          }
          if (customize._filenameMapDest) {
            for (const [fname, destUrl] of Object.entries(customize._filenameMapDest)) {
              // regex: qualquer https://cdn.shopify.com/....../NOME-DO-ARQUIVO(?v=123)
              const esc = fname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              const re = new RegExp(`(?:https?:)?//cdn\\.shopify\\.com/[^"'\\\\)\\s]*?/${esc}(?:\\?[^"'\\\\)\\s]*)?`, "g");
              value = value.replace(re, destUrl.split("?")[0]);
            }
          }
          if (customize._originShopCDN) {
            value = value.split(customize._originShopCDN).join(destination.shop.replace(".myshopify.com", ""));
          }
          return value;
        };

        log(`📁 ${keys.length} assets do tema a copiar (incluindo imagens do tema)`);
        let copiados = 0, falhas = 0;
        for (let i = 0; i < keys.length; i++) {
          progress("theme", i + 1, keys.length);
          try {
            const ad = await restCall("GET", origin.shop, `/themes/${tOrigem.id}/assets.json?asset[key]=${encodeURIComponent(keys[i])}`, tokenOrig);
            const putBody = { asset: { key: keys[i] } };
            if (ad.asset?.value !== undefined) {
              putBody.asset.value = trocarUrls(replaceContent(ad.asset.value));
            } else if (ad.asset?.attachment) {
              // Binário (imagens, fonts do tema) — copia direto em base64
              putBody.asset.attachment = ad.asset.attachment;
            } else continue;
            await restCall("PUT", destination.shop, `/themes/${tDestino.id}/assets.json`, tokenDest, putBody);
            copiados++;
          } catch { falhas++; }
          await sleep(80);
        }
        log(`✅ Tema: ${copiados} assets copiados | ${falhas} falhas`, "success");
      }
    }

    // ==== MARKETS: CLONE EXATO DA ORIGEM (países + moeda + idiomas + URL) ====
    if (options.markets) {
      log("━━━━━━━━━━ ETAPA 9: MARKETS (clone exato da origem) ━━━━━━━━━━");

      // ── 9.1 IDIOMAS: instala e publica no destino os MESMOS idiomas da origem ──
      const locOrig = await gql(origin.shop, `query { shopLocales { locale primary published } }`, {}, tokenOrig);
      const locDest = await gql(destination.shop, `query { shopLocales { locale primary published } }`, {}, tokenDest);
      const instalados = new Set(locDest.shopLocales.map(l => l.locale));

      const idiomasOrigem = locOrig.shopLocales.filter(l => !l.primary);
      log(`📚 Origem tem ${locOrig.shopLocales.length} idiomas | Destino tem ${instalados.size}`);

      for (const l of idiomasOrigem) {
        if (!instalados.has(l.locale)) {
          try {
            await gql(destination.shop,
              `mutation($locale:String!){shopLocaleEnable(locale:$locale){userErrors{message}}}`,
              { locale: l.locale }, tokenDest);
            instalados.add(l.locale);
            log(`  ➕ Idioma instalado: ${l.locale}`);
          } catch (e) { log(`  ⚠️ Não instalou ${l.locale}: ${e.message.slice(0,60)}`); }
          await sleep(150);
        }
        if (l.published) {
          try {
            await gql(destination.shop,
              `mutation($locale:String!,$sl:ShopLocaleInput!){shopLocaleUpdate(locale:$locale,shopLocale:$sl){userErrors{message}}}`,
              { locale: l.locale, sl: { published: true } }, tokenDest);
          } catch {}
          await sleep(100);
        }
      }

      // ── 9.2 LÊ os markets da ORIGEM com toda a configuração ──
      // (webPresence: tenta o formato novo da API; se falhar, usa o antigo)
      const lerMarkets = async (shop, token) => {
        const base = `id name enabled regions(first: 250) { edges { node { ... on MarketRegionCountry { code } } } } currencySettings { baseCurrency { currencyCode } localCurrencies }`;
        let q = `query { markets(first: 100) { edges { node { ${base} webPresence { id defaultLocale alternateLocales subfolderSuffix } } } } }`;
        try {
          const d = await gql(shop, q, {}, token);
          return d.markets.edges.map(e => e.node);
        } catch {
          // Formato novo: defaultLocale/alternateLocales viram objetos
          q = `query { markets(first: 100) { edges { node { ${base} webPresence { id defaultLocale { locale } alternateLocales { locale } subfolderSuffix } } } } }`;
          const d = await gql(shop, q, {}, token);
          return d.markets.edges.map(e => {
            const n = e.node;
            if (n.webPresence) {
              n.webPresence.defaultLocale = n.webPresence.defaultLocale?.locale || n.webPresence.defaultLocale;
              n.webPresence.alternateLocales = (n.webPresence.alternateLocales || []).map(a => a.locale || a);
            }
            return n;
          });
        }
      };

      const marketsOrig = await lerMarkets(origin.shop, tokenOrig);
      const marketsDest = await lerMarkets(destination.shop, tokenDest);
      log(`🌍 Origem: ${marketsOrig.length} markets | Destino: ${marketsDest.length} markets`);

      // Índices do destino: por nome e por país (para saber o que já existe)
      const destPorNome = {};
      const paisesNoDest = new Set();
      for (const m of marketsDest) {
        destPorNome[m.name.toLowerCase()] = m;
        for (const r of m.regions.edges) if (r.node.code) paisesNoDest.add(r.node.code);
      }

      // ── 9.3 Recria cada market da origem no destino, idêntico ──
      let mkCriados = 0, mkAtualizados = 0, mkErros = 0;
      for (let i = 0; i < marketsOrig.length; i++) {
        const mo = marketsOrig[i];
        progress("markets", i + 1, marketsOrig.length);
        const paisesOrig = mo.regions.edges.map(r => r.node.code).filter(Boolean);
        if (paisesOrig.length === 0) continue;

        try {
          let marketIdDest = destPorNome[mo.name.toLowerCase()]?.id;

          if (!marketIdDest) {
            // Cria o market só com os países que ainda não estão em outro market
            const paisesLivres = paisesOrig.filter(c => !paisesNoDest.has(c));
            if (paisesLivres.length === 0) { log(`  ⏭️ ${mo.name}: países já cobertos no destino`); continue; }
            const r = await gql(destination.shop,
              `mutation marketCreate($input:MarketCreateInput!){marketCreate(input:$input){market{id}userErrors{field message}}}`,
              { input: { name: mo.name, enabled: mo.enabled !== false, regions: paisesLivres.map(c => ({ countryCode: c })) } },
              tokenDest);
            if (r.marketCreate.userErrors.length > 0) {
              log(`  ⚠️ ${mo.name}: ${r.marketCreate.userErrors[0].message.slice(0,70)}`);
              mkErros++; continue;
            }
            marketIdDest = r.marketCreate.market.id;
            paisesLivres.forEach(c => paisesNoDest.add(c));
            mkCriados++;
          } else {
            mkAtualizados++;
          }

          // Moeda: copia EXATAMENTE a config da origem
          const cs = mo.currencySettings || {};
          try {
            const inputMoeda = cs.localCurrencies
              ? { localCurrencies: true }
              : { baseCurrency: cs.baseCurrency?.currencyCode, localCurrencies: false };
            if (inputMoeda.baseCurrency || inputMoeda.localCurrencies) {
              await gql(destination.shop,
                `mutation($id:ID!,$i:MarketCurrencySettingsUpdateInput!){marketCurrencySettingsUpdate(marketId:$id,input:$i){userErrors{message}}}`,
                { id: marketIdDest, i: inputMoeda }, tokenDest);
            }
          } catch (e) { log(`  ⚠️ Moeda ${mo.name}: ${e.message.slice(0,60)}`); }

          // Idiomas + URL (subfolder): copia a webPresence da origem
          const wpo = mo.webPresence;
          if (wpo && wpo.defaultLocale) {
            const alts = (wpo.alternateLocales || []).filter(l => instalados.has(l));
            const wpInput = {
              defaultLocale: wpo.defaultLocale,
              alternateLocales: alts,
            };
            if (wpo.subfolderSuffix) wpInput.subfolderSuffix = wpo.subfolderSuffix;

            if (instalados.has(wpo.defaultLocale) || locDest.shopLocales.some(l => l.primary && l.locale === wpo.defaultLocale)) {
              try {
                // Já tem webPresence no destino? Atualiza. Senão, cria.
                const dWp = await gql(destination.shop,
                  `query($id:ID!){market(id:$id){webPresence{id}}}`, { id: marketIdDest }, tokenDest);
                const wpId = dWp.market?.webPresence?.id;
                if (wpId) {
                  const ru = await gql(destination.shop,
                    `mutation($id:ID!,$wp:MarketWebPresenceUpdateInput!){marketWebPresenceUpdate(webPresenceId:$id,webPresence:$wp){userErrors{field message}}}`,
                    { id: wpId, wp: wpInput }, tokenDest);
                  if (ru.marketWebPresenceUpdate.userErrors.length > 0)
                    log(`  ⚠️ URL ${mo.name}: ${ru.marketWebPresenceUpdate.userErrors[0].message.slice(0,70)}`);
                } else {
                  const rc = await gql(destination.shop,
                    `mutation($mid:ID!,$wp:MarketWebPresenceCreateInput!){marketWebPresenceCreate(marketId:$mid,webPresence:$wp){userErrors{field message}}}`,
                    { mid: marketIdDest, wp: wpInput }, tokenDest);
                  if (rc.marketWebPresenceCreate.userErrors.length > 0)
                    log(`  ⚠️ URL ${mo.name}: ${rc.marketWebPresenceCreate.userErrors[0].message.slice(0,70)}`);
                }
              } catch (e) { log(`  ⚠️ WebPresence ${mo.name}: ${e.message.slice(0,60)}`); }
            }
          }
        } catch (e) {
          mkErros++;
          log(`  ❌ ${mo.name}: ${e.message.slice(0,70)}`);
        }
        await sleep(200);
      }
      log(`✅ Markets: ${mkCriados} criados | ${mkAtualizados} atualizados (já existiam) | ${mkErros} erros`, "success");
      log(`💡 Confere em Settings → Markets: países, moedas, idiomas e subfolders devem estar idênticos à origem`);
    }

    // ==== FRETES POR PAÍS ====
    if (options.shipping) {
      log("━━━━━━━━━━ ETAPA 10: FRETES POR PAÍS ━━━━━━━━━━");

      const FRETES = {
        DE:{std:{name:"DHL Standard",desc:"Lieferung in 5 bis 8 Werktagen"},pri:{name:"DHL Express",desc:"Lieferung in 3 bis 7 Werktagen"}},
        FR:{std:{name:"Colissimo Standard",desc:"Livraison en 5 à 8 jours ouvrables"},pri:{name:"Chronopost Express",desc:"Livraison en 3 à 7 jours ouvrables"}},
        IT:{std:{name:"Poste Italiane Standard",desc:"Consegna in 5-8 giorni lavorativi"},pri:{name:"Poste Italiane Express",desc:"Consegna in 3-7 giorni lavorativi"}},
        ES:{std:{name:"Correos Estándar",desc:"Entrega en 5 a 8 días laborables"},pri:{name:"Correos Express",desc:"Entrega en 3 a 7 días laborables"}},
        PT:{std:{name:"CTT Standard",desc:"Entrega em 5 a 8 dias úteis"},pri:{name:"CTT Expresso",desc:"Entrega em 3 a 7 dias úteis"}},
        NL:{std:{name:"PostNL Standard",desc:"Bezorging in 5 tot 8 werkdagen"},pri:{name:"PostNL Express",desc:"Bezorging in 3 tot 7 werkdagen"}},
        BE:{std:{name:"Bpost Standard",desc:"Livraison en 5 à 8 jours ouvrables"},pri:{name:"Bpost Express",desc:"Livraison en 3 à 7 jours ouvrables"}},
        AT:{std:{name:"Österreichische Post Standard",desc:"Lieferung in 5 bis 8 Werktagen"},pri:{name:"Österreichische Post Express",desc:"Lieferung in 3 bis 7 Werktagen"}},
        IE:{std:{name:"An Post Standard",desc:"Delivery in 5 to 8 business days"},pri:{name:"An Post Express",desc:"Delivery in 3 to 7 business days"}},
        LU:{std:{name:"Post Luxembourg Standard",desc:"Livraison en 5 à 8 jours ouvrables"},pri:{name:"Post Luxembourg Express",desc:"Livraison en 3 à 7 jours ouvrables"}},
        GR:{std:{name:"ELTA Standard",desc:"Παράδοση σε 5 έως 8 εργάσιμες ημέρες"},pri:{name:"ELTA Courier",desc:"Παράδοση σε 3 έως 7 εργάσιμες ημέρες"}},
        FI:{std:{name:"Posti Standard",desc:"Toimitus 5–8 työpäivässä"},pri:{name:"Posti Express",desc:"Toimitus 3–7 työpäivässä"}},
        GB:{std:{name:"Royal Mail Tracked",desc:"Delivery in 5 to 8 business days"},pri:{name:"Royal Mail Tracked 24",desc:"Delivery in 3 to 7 business days"}},
        CH:{std:{name:"Swiss Post Economy",desc:"Lieferung in 5 bis 8 Werktagen"},pri:{name:"Swiss Post Priority",desc:"Lieferung in 3 bis 7 Werktagen"}},
        SE:{std:{name:"PostNord Standard",desc:"Leverans inom 5 till 8 arbetsdagar"},pri:{name:"PostNord Express",desc:"Leverans inom 3 till 7 arbetsdagar"}},
        NO:{std:{name:"Posten Norge Standard",desc:"Levering på 5 til 8 virkedager"},pri:{name:"Posten Norge Express",desc:"Levering på 3 til 7 virkedager"}},
        DK:{std:{name:"PostNord Standard",desc:"Levering på 5 til 8 hverdage"},pri:{name:"PostNord Express",desc:"Levering på 3 til 7 hverdage"}},
        PL:{std:{name:"Poczta Polska Standard",desc:"Dostawa w 5 do 8 dni roboczych"},pri:{name:"InPost Express",desc:"Dostawa w 3 do 7 dni roboczych"}},
        CZ:{std:{name:"Česká pošta Standard",desc:"Doručení za 5 až 8 pracovních dnů"},pri:{name:"Česká pošta Express",desc:"Doručení za 3 až 7 pracovních dnů"}},
        HU:{std:{name:"Magyar Posta Standard",desc:"Kézbesítés 5–8 munkanapon belül"},pri:{name:"Magyar Posta Express",desc:"Kézbesítés 3–7 munkanapon belül"}},
        RO:{std:{name:"Poșta Română Standard",desc:"Livrare în 5–8 zile lucrătoare"},pri:{name:"Poșta Română Express",desc:"Livrare în 3–7 zile lucrătoare"}},
        BG:{std:{name:"Български пощи Стандарт",desc:"Доставка за 5 до 8 работни дни"},pri:{name:"Български пощи Експрес",desc:"Доставка за 3 до 7 работни дни"}},
        HR:{std:{name:"Hrvatska pošta Standard",desc:"Dostava u roku od 5 do 8 radnih dana"},pri:{name:"Hrvatska pošta Express",desc:"Dostava u roku od 3 do 7 radnih dana"}},
        SK:{std:{name:"Slovenská pošta Standard",desc:"Doručenie za 5 až 8 pracovných dní"},pri:{name:"Slovenská pošta Express",desc:"Doručenie za 3 až 7 pracovných dní"}},
        US:{std:{name:"USPS Ground Advantage",desc:"Delivery in 5 to 8 business days"},pri:{name:"UPS Priority",desc:"Delivery in 3 to 7 business days"}},
        CA:{std:{name:"Canada Post Regular",desc:"Delivery in 5 to 8 business days"},pri:{name:"Canada Post Xpresspost",desc:"Delivery in 3 to 7 business days"}},
        MX:{std:{name:"Correos de México Estándar",desc:"Entrega en 5 a 8 días hábiles"},pri:{name:"Estafeta Express",desc:"Entrega en 3 a 7 días hábiles"}},
        BR:{std:{name:"Correios PAC",desc:"Entrega em 5 a 8 dias úteis"},pri:{name:"Correios SEDEX",desc:"Entrega em 3 a 7 dias úteis"}},
        AR:{std:{name:"Correo Argentino Estándar",desc:"Entrega en 5 a 8 días hábiles"},pri:{name:"Correo Argentino Express",desc:"Entrega en 3 a 7 días hábiles"}},
        CL:{std:{name:"Correos de Chile Estándar",desc:"Entrega en 5 a 8 días hábiles"},pri:{name:"Correos de Chile Express",desc:"Entrega en 3 a 7 días hábiles"}},
        CO:{std:{name:"4-72 Estándar",desc:"Entrega en 5 a 8 días hábiles"},pri:{name:"Servientrega Express",desc:"Entrega en 3 a 7 días hábiles"}},
        PE:{std:{name:"Serpost Estándar",desc:"Entrega en 5 a 8 días hábiles"},pri:{name:"Serpost Express",desc:"Entrega en 3 a 7 días hábiles"}},
        UY:{std:{name:"Correo Uruguayo Estándar",desc:"Entrega en 5 a 8 días hábiles"},pri:{name:"Correo Uruguayo Express",desc:"Entrega en 3 a 7 días hábiles"}},
        EC:{std:{name:"Correos del Ecuador Estándar",desc:"Entrega en 5 a 8 días hábiles"},pri:{name:"Correos del Ecuador Express",desc:"Entrega en 3 a 7 días hábiles"}},
        JP:{std:{name:"Japan Post Standard",desc:"5〜8営業日でお届け"},pri:{name:"Yamato Express",desc:"3〜7営業日でお届け"}},
        KR:{std:{name:"Korea Post 일반",desc:"영업일 기준 5~8일 이내 배송"},pri:{name:"Korea Post 익일특급",desc:"영업일 기준 3~7일 이내 배송"}},
        SG:{std:{name:"SingPost Standard",desc:"Delivery in 5 to 8 business days"},pri:{name:"SingPost Express",desc:"Delivery in 3 to 7 business days"}},
        HK:{std:{name:"Hongkong Post Standard",desc:"5至8個工作天送達"},pri:{name:"SF Express",desc:"3至7個工作天送達"}},
        TW:{std:{name:"中華郵政 Standard",desc:"5至8個工作天送達"},pri:{name:"中華郵政 Express",desc:"3至7個工作天送達"}},
        AU:{std:{name:"Australia Post Standard",desc:"Delivery in 5 to 8 business days"},pri:{name:"Australia Post Express",desc:"Delivery in 3 to 7 business days"}},
        NZ:{std:{name:"NZ Post Standard",desc:"Delivery in 5 to 8 business days"},pri:{name:"NZ Post Express",desc:"Delivery in 3 to 7 business days"}},
        CN:{std:{name:"China Post 普通",desc:"5至8个工作日送达"},pri:{name:"SF Express 顺丰速运",desc:"3至7个工作日送达"}},
        IN:{std:{name:"India Post Standard",desc:"Delivery in 5 to 8 business days"},pri:{name:"Blue Dart Express",desc:"Delivery in 3 to 7 business days"}},
        TH:{std:{name:"ไปรษณีย์ไทย Standard",desc:"จัดส่งภายใน 5 ถึง 8 วันทำการ"},pri:{name:"ไปรษณีย์ไทย EMS",desc:"จัดส่งภายใน 3 ถึง 7 วันทำการ"}},
        AE:{std:{name:"Emirates Post Standard",desc:"التسليم خلال 5 إلى 8 أيام عمل"},pri:{name:"Aramex Express",desc:"التسليم خلال 3 إلى 7 أيام عمل"}},
        IL:{std:{name:"דואר ישראל סטנדרט",desc:"משלוח תוך 5 עד 8 ימי עסקים"},pri:{name:"דואר ישראל אקספרס",desc:"משלוח תוך 3 עד 7 ימי עסקים"}},
        SA:{std:{name:"SPL سعودي بوست",desc:"التسليم خلال 5 إلى 8 أيام عمل"},pri:{name:"SPL Express",desc:"التسليم خلال 3 إلى 7 أيام عمل"}},
        ZA:{std:{name:"SA Post Office Standard",desc:"Delivery in 5 to 8 business days"},pri:{name:"SA Post Office Express",desc:"Delivery in 3 to 7 business days"}},
        MA:{std:{name:"Barid Al-Maghrib Standard",desc:"Livraison en 5 à 8 jours ouvrables"},pri:{name:"Barid Al-Maghrib Express",desc:"Livraison en 3 à 7 jours ouvrables"}},
        TR:{std:{name:"PTT Standart",desc:"5 ila 8 iş günü içinde teslimat"},pri:{name:"PTT Hızlı",desc:"3 ila 7 iş günü içinde teslimat"}},
      };

      const TAXA_CAMBIO = {
        EUR:1,USD:1.08,GBP:0.85,BRL:5.99,CHF:0.95,SEK:11.5,NOK:11.7,DKK:7.5,
        PLN:4.3,CZK:25,HUF:395,RON:4.97,BGN:1.95,CAD:1.5,MXN:18,ARS:1000,
        CLP:1000,COP:4500,PEN:4,UYU:43,JPY:170,KRW:1500,SGD:1.45,HKD:8.5,
        TWD:35,AUD:1.65,NZD:1.78,CNY:7.8,AED:4,ILS:4,SAR:4,ZAR:20,MAD:11,
        TRY:35,INR:90,THB:39,
      };

      // Descobre moeda da loja + delivery profile
      const shopData = await gql(destination.shop, `query{shop{currencyCode}}`, {}, tokenDest);
      const moedaLoja = shopData.shop.currencyCode;
      const taxa = TAXA_CAMBIO[moedaLoja] || 1;
      const precoStd = (4.90 * taxa).toFixed(2);
      const precoPri = (9.70 * taxa).toFixed(2);

      log(`💰 Moeda da loja: ${moedaLoja} | Standard: ${moedaLoja} ${precoStd} | Priority: ${moedaLoja} ${precoPri}`);

      // Pega delivery profile
      const profData = await gql(destination.shop, `
        query {
          deliveryProfiles(first: 10) {
            edges {
              node {
                id
                default
                profileLocationGroups {
                  locationGroup { id }
                  locationGroupZones(first: 100) {
                    edges {
                      node {
                        zone {
                          countries { code { countryCode } }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `, {}, tokenDest);
      const profile = profData.deliveryProfiles.edges.map(e=>e.node).find(p=>p.default);
      if (!profile) { log("❌ Default delivery profile não encontrado", "error"); }
      else {
        const lg = profile.profileLocationGroups[0];
        const paisesComFrete = new Set();
        for (const ze of lg.locationGroupZones.edges)
          for (const c of ze.node.zone.countries) if (c.code.countryCode) paisesComFrete.add(c.code.countryCode);

        const fretesPaises = Object.keys(FRETES).filter(c => !paisesComFrete.has(c));
        log(`🚚 ${paisesComFrete.size} países já têm frete | ${fretesPaises.length} a criar`);

        let shCriados = 0;
        for (let i = 0; i < fretesPaises.length; i++) {
          const code = fretesPaises[i];
          const frete = FRETES[code];
          progress("shipping", i + 1, fretesPaises.length);
          try {
            await gql(destination.shop, `mutation deliveryProfileUpdate($id:ID!,$profile:DeliveryProfileInput!){deliveryProfileUpdate(id:$id,profile:$profile){profile{id}userErrors{field message}}}`, {
              id: profile.id,
              profile: { locationGroupsToUpdate: [{ id: lg.locationGroup.id, zonesToCreate: [{
                name: code,
                countries: [{ code, includeAllProvinces: true }],
                methodDefinitionsToCreate: [
                  { name: frete.std.name, description: frete.std.desc, active: true, rateDefinition: { price: { amount: precoStd, currencyCode: moedaLoja } } },
                  { name: frete.pri.name, description: frete.pri.desc, active: true, rateDefinition: { price: { amount: precoPri, currencyCode: moedaLoja } } },
                ],
              }]}]}
            }, tokenDest);
            shCriados++;
          } catch {}
          await sleep(100);
        }
        log(`✅ Fretes: ${shCriados} países criados | Standard €4.90 | Priority €9.70`, "success");
      }
    }

    // ==== DESCONTOS ====
    if (options.discounts) {
      log("━━━━━━━━━━ ETAPA 11: DESCONTOS ━━━━━━━━━━");

      // Busca descontos da origem via GraphQL
      const queryDesc = `
        query {
          codeDiscountNodes(first: 100) {
            edges {
              node {
                id
                codeDiscount {
                  ... on DiscountCodeBasic {
                    title
                    status
                    codes(first: 10) { edges { node { code } } }
                    customerGets {
                      value {
                        ... on DiscountPercentage { percentage }
                        ... on DiscountAmount { amount { amount currencyCode } }
                      }
                    }
                    minimumRequirement {
                      ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
                      ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } }
                    }
                    usageLimit
                    startsAt
                    endsAt
                  }
                  ... on DiscountCodeFreeShipping {
                    title
                    status
                    codes(first: 10) { edges { node { code } } }
                    usageLimit
                    startsAt
                    endsAt
                  }
                  ... on DiscountCodeBxgy {
                    title
                    status
                    codes(first: 10) { edges { node { code } } }
                    usageLimit
                    startsAt
                    endsAt
                  }
                }
              }
            }
          }
        }
      `;

      try {
        const dataDesc = await gql(origin.shop, queryDesc, {}, tokenOrig);
        const descontos = dataDesc.codeDiscountNodes?.edges || [];
        log(`🏷️ ${descontos.length} descontos encontrados na origem`);

        let criados = 0, falha = 0;
        for (const edge of descontos) {
          const d = edge.node.codeDiscount;
          if (!d?.title) continue;

          const codes = (d.codes?.edges || []).map(e => e.node.code);
          if (codes.length === 0) continue;

          progress("discounts", ++criados, descontos.length);

          try {
            // Monta o desconto baseado no tipo
            const isPercentage = d.customerGets?.value?.percentage !== undefined;
            const percentage = d.customerGets?.value?.percentage;
            const amount = d.customerGets?.value?.amount?.amount;

            let mutation, variables;

            if (isPercentage && percentage !== undefined) {
              // Desconto percentual
              mutation = `
                mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
                  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
                    codeDiscountNode { id }
                    userErrors { field message code }
                  }
                }
              `;
              variables = {
                basicCodeDiscount: {
                  title: d.title,
                  code: codes[0],
                  startsAt: d.startsAt || new Date().toISOString(),
                  endsAt: d.endsAt || null,
                  usageLimit: d.usageLimit || null,
                  customerGets: {
                    value: { percentage: percentage },
                    items: { all: true },
                  },
                  appliesOncePerCustomer: false,
                },
              };
            } else if (amount) {
              // Desconto em valor fixo
              mutation = `
                mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
                  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
                    codeDiscountNode { id }
                    userErrors { field message code }
                  }
                }
              `;
              variables = {
                basicCodeDiscount: {
                  title: d.title,
                  code: codes[0],
                  startsAt: d.startsAt || new Date().toISOString(),
                  endsAt: d.endsAt || null,
                  usageLimit: d.usageLimit || null,
                  customerGets: {
                    value: { discountAmount: { amount, appliesOnEachItem: false } },
                    items: { all: true },
                  },
                  appliesOncePerCustomer: false,
                },
              };
            } else {
              // Frete grátis
              mutation = `
                mutation discountCodeFreeShippingCreate($freeShippingCodeDiscount: DiscountCodeFreeShippingInput!) {
                  discountCodeFreeShippingCreate(freeShippingCodeDiscount: $freeShippingCodeDiscount) {
                    codeDiscountNode { id }
                    userErrors { field message code }
                  }
                }
              `;
              variables = {
                freeShippingCodeDiscount: {
                  title: d.title,
                  code: codes[0],
                  startsAt: d.startsAt || new Date().toISOString(),
                  endsAt: d.endsAt || null,
                  usageLimit: d.usageLimit || null,
                  destination: { all: true },
                },
              };
            }

            const r = await gql(destination.shop, mutation, variables, tokenDest);
            const erros = Object.values(r)[0]?.userErrors || [];
            if (erros.length > 0 && !erros[0].message.includes("taken")) {
              throw new Error(erros[0].message);
            }

            // Cria códigos extras se houver mais de 1
            for (const code of codes.slice(1)) {
              const nodeId = Object.values(r)[0]?.codeDiscountNode?.id;
              if (!nodeId) continue;
              try {
                await gql(destination.shop, `
                  mutation discountRedeemCodeBulkAdd($discountId: ID!, $codes: [DiscountRedeemCodeInput!]!) {
                    discountRedeemCodeBulkAdd(discountId: $discountId, codes: $codes) {
                      userErrors { message }
                    }
                  }
                `, { discountId: nodeId, codes: [{ code }] }, tokenDest);
              } catch {}
            }

          } catch (err) {
            if (!err.message?.includes("taken")) falha++;
          }
          await sleep(300);
        }
        log(`✅ Descontos: ${criados - falha} copiados | ${falha} erros`, "success");
      } catch (err) {
        log(`⚠️ Sem permissão para descontos ou erro: ${err.message.slice(0, 80)}`, "error");
      }
    }

    // ==== ETAPA 12: CHECKLIST DO QUE FALTA CONFIGURAR ====
    // Compara origem × destino no que a API deixa LER, e monta a lista
    // do que a Shopify obriga a fazer manualmente (pagamentos, domínio, etc.)
    try {
      log("━━━━━━━━━━ ETAPA 12: CHECKLIST FINAL ━━━━━━━━━━");
      const handle = destination.shop.replace(".myshopify.com", "");
      const adm = (p) => `https://admin.shopify.com/store/${handle}${p}`;

      let sOr = {}, sDe = {}, metaOrig = "";
      try { sOr = (await restCall("GET", origin.shop, "/shop.json", tokenOrig)).shop || {}; } catch {}
      try { sDe = (await restCall("GET", destination.shop, "/shop.json", tokenDest)).shop || {}; } catch {}
      try { metaOrig = (await gql(origin.shop, `query { shop { description } }`, {}, tokenOrig)).shop?.description || ""; } catch {}

      const temDominio = sDe.domain && !sDe.domain.includes(".myshopify.com");

      const items = [
        {
          id: "pagamentos", titulo: "Pagamentos", url: adm("/settings/payments"), auto: false,
          desc: "Ativar Shopify Payments ou outro gateway. A Shopify NUNCA deixa clonar isso via API (proteção contra fraude).",
        },
        {
          id: "dominio", titulo: "Domínio personalizado", url: adm("/settings/domains"), auto: temDominio,
          desc: temDominio
            ? `Já conectado: ${sDe.domain} ✓`
            : `Conectar o domínio próprio da loja (hoje está em ${sDe.domain || destination.shop}).`,
        },
        {
          id: "preferencias", titulo: "Preferências da loja virtual", url: adm("/online_store/preferences"), auto: false,
          desc: `Título da home, meta description, imagem social e senha da loja. A API não escreve aqui. Meta description da origem para copiar: "${(metaOrig || "(vazia)").slice(0, 200)}"`,
        },
        {
          id: "moeda", titulo: "Moeda principal da loja", url: adm("/settings/general"),
          auto: !!(sOr.currency && sDe.currency && sOr.currency === sDe.currency),
          desc: sOr.currency === sDe.currency
            ? `As duas lojas usam ${sDe.currency} ✓`
            : `Origem usa ${sOr.currency || "?"} e destino usa ${sDe.currency || "?"} — ajustar em Settings → General → Store currency (só dá pra mudar antes da primeira venda).`,
        },
        {
          id: "idioma", titulo: "Idioma principal da loja", url: adm("/settings/languages"),
          auto: !!(sOr.primary_locale && sDe.primary_locale && sOr.primary_locale === sDe.primary_locale),
          desc: sOr.primary_locale === sDe.primary_locale
            ? `As duas lojas usam "${sDe.primary_locale}" como idioma principal ✓`
            : `Origem: "${sOr.primary_locale || "?"}" | Destino: "${sDe.primary_locale || "?"}" — o idioma PRINCIPAL só muda pelo admin.`,
        },
        {
          id: "checkout", titulo: "Checkout", url: adm("/settings/checkout"), auto: false,
          desc: "Conferir campos do cliente, e-mail x telefone, dicas de gorjeta e configurações de conta — a API não clona essa tela.",
        },
        {
          id: "impostos", titulo: "Impostos e taxas", url: adm("/settings/taxes"), auto: false,
          desc: "Conferir se a cobrança de impostos (IVA na Europa) está configurada igual à origem.",
        },
        {
          id: "email", titulo: "E-mail do remetente", url: adm("/settings/notifications"),
          auto: !!(customize?.destEmail && sDe.email && sDe.email.toLowerCase() === customize.destEmail.toLowerCase()),
          desc: `Verificar o e-mail que aparece pros clientes (sender email). Destino hoje: ${sDe.email || "?"}.`,
        },
        {
          id: "apps", titulo: "Apps de terceiros", url: adm("/settings/apps"), auto: false,
          desc: "Reinstalar e configurar apps (Judge.me, upsell, etc.) — cada app guarda os dados no servidor dele, fora da Shopify.",
        },
        {
          id: "pixel", titulo: "Meta Pixel / rastreamento", url: adm("/settings/customer_events"), auto: false,
          desc: "Reconectar o Pixel do Meta e outros rastreamentos na loja nova (cada loja precisa do seu).",
        },
        {
          id: "envio-config", titulo: "Revisar fretes e Markets", url: adm("/settings/shipping"), auto: false,
          desc: "O clone copiou tudo, mas vale abrir Settings → Shipping e Settings → Markets e bater o olho comparando com a origem.",
        },
        {
          id: "teste", titulo: "Pedido de teste", url: `https://${sDe.domain || destination.shop}`, auto: false,
          desc: "Abrir a loja, navegar como cliente e simular uma compra até o checkout pra garantir que está tudo funcionando.",
        },
      ];

      const pendentes = items.filter(i => !i.auto).length;
      log(`📋 Checklist gerado: ${pendentes} itens pendentes de ${items.length}`);
      send("checklist", { items, destShop: destination.shop });
    } catch (e) {
      log(`⚠️ Não consegui gerar o checklist: ${e.message.slice(0, 80)}`);
    }

    send("done", { msg: "🎉 Clonagem completa!" });
  } catch (err) {
    send("error", { msg: `💥 Erro fatal: ${err.message}` });
  }
};

// ============================================================
//  SISTEMA DE JOBS — o clone roda em background no servidor.
//  Se a internet do navegador cair, ele reconecta e recebe
//  tudo que perdeu (os eventos ficam guardados na memória).
// ============================================================
const jobs = {};

function criarJob() {
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  jobs[id] = { events: [], finished: false, createdAt: Date.now() };
  return id;
}

// Limpa jobs com mais de 2 horas (pra memória não crescer pra sempre)
setInterval(() => {
  const agora = Date.now();
  for (const [id, j] of Object.entries(jobs)) {
    if (agora - j.createdAt > 2 * 60 * 60 * 1000) delete jobs[id];
  }
}, 10 * 60 * 1000);

// Inicia o clone: devolve o jobId na hora e roda o clone em background
app.post("/api/clone-start", (req, res) => {
  const jobId = criarJob();
  const send = (type, data) => {
    const j = jobs[jobId];
    if (!j) return;
    j.events.push({ type, ...data });
    if (type === "done" || type === "error") j.finished = true;
  };
  res.json({ jobId });
  runClone(req.body, send).catch((err) => send("error", { msg: `💥 ${err.message}` }));
});

// Stream de status: manda os eventos guardados + os novos, com keepalive
app.get("/api/clone-status/:id", async (req, res) => {
  const job = jobs[req.params.id];
  if (!job) { res.status(404).json({ error: "Job não encontrado" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let i = 0;
  let vivo = true;
  req.on("close", () => { vivo = false; });
  const keepalive = setInterval(() => { try { res.write(":keepalive\n\n"); } catch {} }, 15000);

  while (vivo) {
    while (i < job.events.length) {
      res.write(`data: ${JSON.stringify(job.events[i++])}\n\n`);
    }
    if (job.finished && i >= job.events.length) break;
    await sleep(400);
  }
  clearInterval(keepalive);
  res.end();
});

// Rota antiga /api/clone (compatibilidade): stream direto na mesma conexão
app.post("/api/clone", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const send = (type, data) => { try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {} };
  await runClone(req.body, send).catch((err) => send("error", { msg: `💥 ${err.message}` }));
  res.end();
});

// ============================================================
//  API: REVIEWS GENERATOR (SSE)
//  Gera 100 reviews realistas com quebra de objeção
//  Importa via Judge.me API
// ============================================================

const REVIEW_TIPOS = [
  { tipo: "entrega_rapida",      rating: 5, peso: 14 },
  { tipo: "entrega_normal",      rating: 5, peso: 12 },
  { tipo: "entrega_demorada_ok", rating: 4, peso: 8  },
  { tipo: "qualidade",           rating: 5, peso: 14 },
  { tipo: "pagamento_seguro",    rating: 5, peso: 10 },
  { tipo: "rastreio",            rating: 5, peso: 10 },
  { tipo: "problema_resolvido",  rating: 4, peso: 8  },
  { tipo: "recompra",            rating: 5, peso: 8  },
  { tipo: "presente",            rating: 5, peso: 8  },
  { tipo: "preco_valor",         rating: 5, peso: 8  },
];

const REVIEW_NOMES = ["Luca M.","Sofia B.","Marco T.","Emma S.","Thomas K.","Laura F.","David R.","Anna W.","Pierre L.","Elena G.","James H.","Maria C.","Oliver P.","Charlotte D.","Felix N.","Isabella R.","Lucas V.","Hannah M.","Matteo A.","Zoe B.","Andreas K.","Giulia F.","Noah S.","Amelie D.","Finn H.","Sara T.","Max L.","Chloe P.","Rafael A.","Mia W.","Jan K.","Nina P.","Tom B.","Lea S.","Paul R.","Eva M.","Leon H.","Julia W.","Erik N.","Clara D."];
const REVIEW_PAISES = ["Germany","France","Italy","Spain","Netherlands","Belgium","Portugal","Austria","Sweden","Poland","Denmark","Greece","Finland","Czech Republic","Romania","Ireland","Croatia","Hungary"];

const REVIEW_TITULOS = {
  entrega_rapida:["Super fast delivery!","Arrived quicker than expected!","Lightning fast shipping!","Delivered in record time!","Amazingly fast!","Faster than Amazon!"],
  entrega_normal:["Great tracking experience","Arrived as expected","Tracking was perfect","Smooth delivery","No issues at all","Exactly on time"],
  entrega_demorada_ok:["Worth the wait!","A bit slow but worth it","Patient but very satisfied","Delayed but great product","Good things take time"],
  qualidade:["Incredible quality!","Exceeded my expectations","Better than retail!","Absolutely love it!","Outstanding quality","Premium feel"],
  pagamento_seguro:["100% safe to order","Totally trustworthy shop","Secure payment, no worries","Had doubts, but perfect","Safe and reliable"],
  rastreio:["Love the tracking updates!","Real-time tracking is great","Always knew where it was","Tracking was flawless","Perfect transparency"],
  problema_resolvido:["Great customer service!","Issue solved super fast","They really care","Small problem, great fix","Support is amazing"],
  recompra:["My 3rd order already!","Coming back again!","Loyal customer for a reason","Always my first choice","Never disappoints"],
  presente:["Perfect gift!","They absolutely loved it","Best gift idea!","Made someone very happy","Great for gifting"],
  preco_valor:["Best price online!","Saved so much money!","Way cheaper than retail","Incredible value","Unbeatable price"],
};

function reviewFallback(tipo, produto, pais) {
  const F = {
    entrega_rapida:[
      `Ordered on Monday and it arrived Thursday — only 3 business days to ${pais}! The ${produto} is exactly as described, great quality. Packaging was secure and professional. Couldn't be happier!`,
      `Honestly shocked by how fast it arrived. Ordered and 4 days later it was at my door in ${pais}. The ${produto} looks even better in person. Will definitely order again!`,
      `5-day delivery to ${pais} which is fantastic. Tracking was spot on. ${produto} is top quality, exactly what I wanted. Already recommended this shop to my friends.`,
    ],
    entrega_normal:[
      `Got the tracking code right after ordering which was reassuring. Could follow every step. Arrived in about a week to ${pais}. The ${produto} is great quality for the price!`,
      `The tracking updates kept me informed the whole time. Arrived exactly when predicted. ${produto} was well packaged and is excellent quality. Trustworthy store!`,
      `Received my tracking number within 24 hours. Delivery to ${pais} took 7 days, perfectly reasonable. Very happy with the ${produto}, would buy again.`,
    ],
    entrega_demorada_ok:[
      `Took about 9 days to arrive in ${pais}, a bit longer than expected, but the ${produto} is incredible quality. Totally worth the wait. Tracking worked great throughout.`,
      `Delivery was around 10 days, not super fast but acceptable for international shipping. The ${produto} is fantastic — perfect quality and exactly as pictured. Happy overall!`,
      `Had to wait about 8 days but I wasn't stressed because the tracking kept me updated. ${produto} arrived in perfect condition. Great value. 4 stars just for the slight wait.`,
    ],
    qualidade:[
      `Walked past the same ${produto} in a store here in ${pais} for nearly double the price. The quality here is identical if not better. Incredible value. Got compliments already!`,
      `The material and build quality of the ${produto} is outstanding. Much better than expected for this price. This is now my go-to shop. Absolute bargain!`,
      `Genuinely impressed by the quality of the ${produto}. Looks and feels premium. I was hesitant but so glad I ordered. Fast becoming my favourite store in ${pais}.`,
    ],
    pagamento_seguro:[
      `I was nervous about ordering from a new shop but the payment was completely secure. Got confirmation immediately. The ${produto} arrived perfectly. 100% trustworthy!`,
      `Usually cautious about online payments, but I was pleasantly surprised. Everything was smooth and secure. ${produto} arrived quickly and is great quality. Will shop again!`,
      `Had my reservations but decided to try. Payment was secure, got a confirmation email straight away, and the ${produto} arrived in perfect condition. Totally legit!`,
    ],
    rastreio:[
      `The real-time tracking was the best part. I always knew exactly where my ${produto} was. Arrived right on schedule in ${pais}. Product is fantastic too!`,
      `Loved getting tracking updates at every stage. No anxiety waiting for the ${produto}. Arrived in perfect condition. Great service all around!`,
      `The tracking code worked perfectly from dispatch to my door in ${pais}. Made it stress-free. The ${produto} is amazing quality. Highly recommend!`,
    ],
    problema_resolvido:[
      `Received the ${produto} with a tiny packaging defect. Contacted support and they responded within hours. Replacement sent immediately, arrived in 2 days. Exceptional service!`,
      `Had a small sizing issue with my ${produto}. Reached out and they fixed it within 48 hours. The replacement is perfect. This service makes me a loyal customer!`,
      `Wrong item sent initially but support sorted it out so quickly I was impressed. Got the correct ${produto} in no time. They really care. 5 stars for the resolution!`,
    ],
    recompra:[
      `This is my third order and they never disappoint. The ${produto} is as good as everything else I've bought. Fast shipping to ${pais} every time. Loyal for life!`,
      `Already on my second order and planning a third. The ${produto} quality is consistently excellent. My go-to shop now. Highly recommend!`,
      `Came back because my first order was so good. The ${produto} didn't disappoint. Fast shipping to ${pais}, perfect product. Earned my trust completely.`,
    ],
    presente:[
      `Bought the ${produto} as a birthday gift and the recipient was thrilled. Beautiful packaging, arrived on time in ${pais}, great quality. Will order gifts here again!`,
      `Got this as a Christmas gift and it was a huge hit. The ${produto} arrived in perfect condition with lovely packaging. Fast delivery, great price. Perfect gift!`,
      `Ordered the ${produto} as an anniversary gift. Arrived quickly, beautifully packaged, and my partner loved it. Great value and quality. The perfect present!`,
    ],
    preco_valor:[
      `Saw the exact same ${produto} in a shop in ${pais} for almost twice the price. Found this store online and ordered immediately. Same quality, half the price. Never buying retail again!`,
      `The price-to-quality ratio for the ${produto} is unbelievable. I've spent more at high street stores for much worse. My secret shopping spot now!`,
      `Compared prices everywhere and this store had the best deal by far. The ${produto} is premium quality and arrived fast. Saved a lot and got a better product. 10/10!`,
    ],
  };
  const lista = F[tipo] || [`Great ${produto}! Very happy. Fast delivery to ${pais}. Excellent quality!`];
  return lista[Math.floor(Math.random() * lista.length)];
}

async function gerarReviewClaude(prompt, claudeKey) {
  if (!claudeKey) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": claudeKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch { return null; }
}

function reviewPrompt(tipo, produto, pais) {
  const base = `Write a realistic, natural-sounding product review in English for "${produto}" from a customer in ${pais}. Casual real-person tone, 60-100 words, vary the wording. `;
  const extras = {
    entrega_rapida: "Mention fast delivery (3-5 days), excitement when it arrived, great quality.",
    entrega_normal: "Mention delivery in about a week, tracking code worked great, product exceeded expectations.",
    entrega_demorada_ok: "Mention delivery took 8-10 days (longer but worth it), tracking helped, great product. This is a 4-star review.",
    qualidade: "Mention incredible quality for the price, compares to expensive retail, many compliments.",
    pagamento_seguro: "Mention being skeptical at first, payment was secure, confirmation immediate, now recommends to friends.",
    rastreio: "Mention loving the tracking code, real-time updates at every stage, stress-free.",
    problema_resolvido: "Mention a small issue (wrong size/minor defect) resolved by support within 2 days. This is a 4-star review that became positive.",
    recompra: "Mention this is their 2nd or 3rd order, loyal customer, quality and price keep them coming back.",
    presente: "Mention buying as a gift, recipient loved it, beautiful packaging, great value.",
    preco_valor: "Mention seeing it cheaper here than physical stores, same quality, saved money.",
  };
  return base + (extras[tipo] || "");
}

app.post("/api/reviews", async (req, res) => {
  const { shop, clientId, clientSecret, judgemeToken, claudeKey, perProduct, productLimit } = req.body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  try {
    const token = await getToken(shop, clientId, clientSecret);
    send("log", { msg: "✅ Autenticado na loja" });

    // Lista produtos
    const produtos = [];
    let url = `https://${shop}/admin/api/2024-10/products.json?limit=250&fields=id,title,handle`;
    while (url) {
      const r = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
      if (!r.ok) break;
      const data = await r.json();
      (data.products || []).forEach(p => produtos.push(p));
      const link = r.headers.get("link") || "";
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    const alvos = productLimit > 0 ? produtos.slice(0, productLimit) : produtos;
    send("log", { msg: `📦 ${produtos.length} produtos | gerando reviews para ${alvos.length}` });

    const totalPorProduto = perProduct || 30;
    let totalOk = 0, totalFail = 0;
    const totalGeral = alvos.length * totalPorProduto;
    let contador = 0;

    for (const produto of alvos) {
      send("log", { msg: `\n📝 ${produto.title.slice(0, 50)}` });

      // Monta distribuição por peso
      const fila = [];
      for (const t of REVIEW_TIPOS) {
        const qtd = Math.round((t.peso / 100) * totalPorProduto);
        for (let i = 0; i < qtd; i++) fila.push(t);
      }

      let idx = 0;
      for (const t of fila) {
        const nome = REVIEW_NOMES[idx % REVIEW_NOMES.length];
        const pais = REVIEW_PAISES[idx % REVIEW_PAISES.length];
        idx++;

        // Gera texto
        let body = claudeKey ? await gerarReviewClaude(reviewPrompt(t.tipo, produto.title, pais), claudeKey) : null;
        if (!body) body = reviewFallback(t.tipo, produto.title, pais);
        if (claudeKey) await sleep(700);

        const titulos = REVIEW_TITULOS[t.tipo] || ["Great product!"];
        const titulo = titulos[Math.floor(Math.random() * titulos.length)];

        // Data aleatória últimos 6 meses
        const data = new Date();
        data.setDate(data.getDate() - Math.floor(Math.random() * 180));

        // Importa via Judge.me
        let sucesso = false;
        if (judgemeToken) {
          try {
            const jr = await fetch("https://judge.me/api/v1/reviews", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                api_token: judgemeToken, shop_domain: shop, platform: "shopify",
                id: produto.id, email: `${nome.toLowerCase().replace(/[^a-z]/g,"")}${idx}@gmail.com`,
                name: nome, rating: t.rating, title: titulo, body, created_at: data.toISOString(),
              }),
            });
            sucesso = jr.ok;
          } catch {}
        }

        if (sucesso) totalOk++; else totalFail++;
        contador++;
        send("progress", { step: "Reviews", current: contador, total: totalGeral });
        await sleep(250);
      }
    }

    send("log", { msg: `\n✅ ${totalOk} reviews importadas | ❌ ${totalFail} erros`, status: "success" });
    if (!judgemeToken) send("log", { msg: "⚠️ Sem Judge.me token — configura na aba pra importar de verdade", status: "error" });
    send("done", { msg: "🎉 Reviews completas!" });
  } catch (err) {
    send("error", { msg: `💥 ${err.message}` });
  }
  res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🔄 Shopify Store Cloner rodando na porta ${PORT}\n`);
});
