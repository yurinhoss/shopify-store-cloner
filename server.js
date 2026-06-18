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
app.post("/api/clone", async (req, res) => {
  const { origin, destination, options, customize } = req.body;

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

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

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
      const arquivos = [];
      let cursor = null;
      while (true) {
        const after = cursor ? `, after: "${cursor}"` : "";
        const q = `query { files(first: 50${after}) { edges { cursor node { ... on MediaImage { id alt image { url originalSrc } fileStatus } ... on GenericFile { id url alt fileStatus } } } pageInfo { hasNextPage endCursor } } }`;
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
      log(`📁 ${arquivos.length} arquivos encontrados`);

      // Mapa URL origem → URL destino (para substituir no tema depois)
      const urlMap = {};
      let uploaded = 0;
      for (let i = 0; i < arquivos.length; i++) {
        const arq = arquivos[i];
        progress("files", i + 1, arquivos.length);
        try {
          // Baixa como base64 pra garantir o upload mesmo de CDN protegido
          const b64 = await downloadBase64(arq.url);
          if (b64) {
            const ext = arq.filename.split(".").pop().toLowerCase();
            const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : ext === "svg" ? "image/svg+xml" : "image/jpeg";
            const r = await gql(destination.shop,
              `mutation fileCreate($files:[FileCreateInput!]!){fileCreate(files:$files){files{...on MediaImage{image{url}}}userErrors{message}}}`,
              { files: [{ originalSource: `data:${mime};base64,${b64}`, contentType: "IMAGE", filename: arq.filename }] },
              tokenDest);
            const novaUrl = r.fileCreate?.files?.[0]?.image?.url;
            if (novaUrl) urlMap[arq.url] = novaUrl;
            uploaded++;
          } else {
            // Fallback: passa URL diretamente
            await gql(destination.shop, `mutation fileCreate($files:[FileCreateInput!]!){fileCreate(files:$files){files{id}userErrors{message}}}`,
              { files: [{ originalSource: arq.url, alt: arq.alt, contentType: "IMAGE" }] }, tokenDest);
            uploaded++;
          }
        } catch {}
        await sleep(200);
      }
      log(`✅ Arquivos: ${uploaded} enviados | ${Object.keys(urlMap).length} URLs mapeadas`, "success");
      await sleep(3000); // aguarda Shopify processar

      // Guarda urlMap no contexto para usar no tema
      if (Object.keys(urlMap).length > 0) {
        log(`🔄 URLs de CDN mapeadas para substituição no tema`);
        // Armazena no objeto customize para reutilizar no tema
        customize._urlMap = urlMap;
        customize._originShopCDN = origin.shop.replace(".myshopify.com", "");
      }
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
        const keys = (assetsOrig.assets || []).map((a) => a.key).filter((k) =>
          k.startsWith("config/") || k.startsWith("templates/") || k.startsWith("sections/") ||
          k.startsWith("snippets/") || k.startsWith("layout/") || k.startsWith("locales/") ||
          (k.startsWith("assets/") && (k.endsWith(".css") || k.endsWith(".js") || k.endsWith(".json") || k.endsWith(".svg")))
        );

        log(`📁 ${keys.length} assets do tema a copiar`);
        let copiados = 0;
        for (let i = 0; i < keys.length; i++) {
          progress("theme", i + 1, keys.length);
          try {
            const ad = await restCall("GET", origin.shop, `/themes/${tOrigem.id}/assets.json?asset[key]=${encodeURIComponent(keys[i])}`, tokenOrig);
            const putBody = { asset: { key: keys[i] } };
            if (ad.asset?.value !== undefined) {
              let value = replaceContent(ad.asset.value);
              // Substitui URLs do CDN da origem pelas novas URLs do destino
              if (customize._urlMap) {
                for (const [origUrl, destUrl] of Object.entries(customize._urlMap)) {
                  value = value.split(origUrl).join(destUrl);
                  // Também tenta sem parâmetros de query
                  const origBase = origUrl.split("?")[0];
                  const destBase = destUrl.split("?")[0];
                  if (origBase !== origUrl) value = value.split(origBase).join(destBase);
                }
              }
              // Substitui referências ao shop da origem (shopify CDN genérico)
              if (customize._originShopCDN) {
                value = value.split(customize._originShopCDN).join(destination.shop.replace(".myshopify.com", ""));
              }
              putBody.asset.value = value;
            } else if (ad.asset?.attachment) {
              putBody.asset.attachment = ad.asset.attachment;
            } else continue;
            await restCall("PUT", destination.shop, `/themes/${tDestino.id}/assets.json`, tokenDest, putBody);
            copiados++;
          } catch {}
          await sleep(80);
        }
        log(`✅ Tema: ${copiados} assets copiados`, "success");
      }
    }

    // ==== MARKETS GLOBAIS ====
    if (options.markets) {
      log("━━━━━━━━━━ ETAPA 9: MARKETS GLOBAIS ━━━━━━━━━━");

      // Mapa país → idioma primário + moeda
      // Idiomas disponíveis: de, es, fr, cs, da, el, fi, hu, it, ja, nl, no, pl, pt-PT, ro, sv, tr, bg, sk, hr
      const MARKET_MAP = {
        // Europeus — EUR
        "DE": { name:"Germany",         lang:"de",    currency:"EUR" },
        "AT": { name:"Austria",          lang:"de",    currency:"EUR" },
        "FR": { name:"France",           lang:"fr",    currency:"EUR" },
        "BE": { name:"Belgium",          lang:"fr",    currency:"EUR" },
        "LU": { name:"Luxembourg",       lang:"fr",    currency:"EUR" },
        "IT": { name:"Italy",            lang:"it",    currency:"EUR" },
        "ES": { name:"Spain",            lang:"es",    currency:"EUR" },
        "PT": { name:"Portugal",         lang:"pt-PT", currency:"EUR" },
        "NL": { name:"Netherlands",      lang:"nl",    currency:"EUR" },
        "GR": { name:"Greece",           lang:"el",    currency:"EUR" },
        "FI": { name:"Finland",          lang:"fi",    currency:"EUR" },
        "IE": { name:"Ireland",          lang:"en",    currency:"EUR" },
        "SK": { name:"Slovakia",         lang:"sk",    currency:"EUR" },
        "HR": { name:"Croatia",          lang:"hr",    currency:"EUR" },
        "CY": { name:"Cyprus",           lang:"el",    currency:"EUR" },
        "EE": { name:"Estonia",          lang:null,    currency:"EUR" },
        "LV": { name:"Latvia",           lang:null,    currency:"EUR" },
        "LT": { name:"Lithuania",        lang:null,    currency:"EUR" },
        "SI": { name:"Slovenia",         lang:null,    currency:"EUR" },
        "MT": { name:"Malta",            lang:"en",    currency:"EUR" },
        // Europeus — moeda própria
        "GB": { name:"United Kingdom",   lang:"en",    currency:"GBP" },
        "CH": { name:"Switzerland",      lang:"de",    currency:"CHF" },
        "SE": { name:"Sweden",           lang:"sv",    currency:"SEK" },
        "NO": { name:"Norway",           lang:"no",    currency:"NOK" },
        "DK": { name:"Denmark",          lang:"da",    currency:"DKK" },
        "PL": { name:"Poland",           lang:"pl",    currency:"PLN" },
        "CZ": { name:"Czech Republic",   lang:"cs",    currency:"CZK" },
        "HU": { name:"Hungary",          lang:"hu",    currency:"HUF" },
        "RO": { name:"Romania",          lang:"ro",    currency:"RON" },
        "BG": { name:"Bulgaria",         lang:"bg",    currency:"BGN" },
        "TR": { name:"Turkey",           lang:"tr",    currency:"TRY" },
        // Américas
        "US": { name:"United States",    lang:"en",    currency:"USD" },
        "CA": { name:"Canada",           lang:"en",    currency:"CAD" },
        "MX": { name:"Mexico",           lang:"es",    currency:"MXN" },
        "BR": { name:"Brazil",           lang:null,    currency:"BRL" },
        "AR": { name:"Argentina",        lang:"es",    currency:"ARS" },
        "CL": { name:"Chile",            lang:"es",    currency:"CLP" },
        "CO": { name:"Colombia",         lang:"es",    currency:"COP" },
        "PE": { name:"Peru",             lang:"es",    currency:"PEN" },
        "UY": { name:"Uruguay",          lang:"es",    currency:"UYU" },
        "EC": { name:"Ecuador",          lang:"es",    currency:"USD" },
        // Ásia / Pacífico
        "JP": { name:"Japan",            lang:"ja",    currency:"JPY" },
        "KR": { name:"South Korea",      lang:null,    currency:"KRW" },
        "SG": { name:"Singapore",        lang:"en",    currency:"SGD" },
        "HK": { name:"Hong Kong",        lang:null,    currency:"HKD" },
        "TW": { name:"Taiwan",           lang:null,    currency:"TWD" },
        "AU": { name:"Australia",        lang:"en",    currency:"AUD" },
        "NZ": { name:"New Zealand",      lang:"en",    currency:"NZD" },
        "CN": { name:"China",            lang:null,    currency:"CNY" },
        "IN": { name:"India",            lang:"en",    currency:"INR" },
        "TH": { name:"Thailand",         lang:null,    currency:"THB" },
        // Médio Oriente / África
        "AE": { name:"UAE",              lang:null,    currency:"AED" },
        "SA": { name:"Saudi Arabia",     lang:null,    currency:"SAR" },
        "IL": { name:"Israel",           lang:null,    currency:"ILS" },
        "ZA": { name:"South Africa",     lang:"en",    currency:"ZAR" },
        "MA": { name:"Morocco",          lang:"fr",    currency:"MAD" },
        // Europa extra
        "AL": { name:"Albania",          lang:null,    currency:"ALL" },
        "BA": { name:"Bosnia",           lang:null,    currency:"BAM" },
        "RS": { name:"Serbia",           lang:null,    currency:"RSD" },
        "MK": { name:"North Macedonia",  lang:null,    currency:"MKD" },
        "IS": { name:"Iceland",          lang:null,    currency:"ISK" },
        "ME": { name:"Montenegro",       lang:null,    currency:"EUR" },
        "XK": { name:"Kosovo",           lang:null,    currency:"EUR" },
        "MD": { name:"Moldova",          lang:"ro",    currency:"MDL" },
        // Médio Oriente extra
        "EG": { name:"Egypt",            lang:null,    currency:"EGP" },
        "QA": { name:"Qatar",            lang:null,    currency:"QAR" },
        "KW": { name:"Kuwait",           lang:null,    currency:"KWD" },
        // África extra
        "NG": { name:"Nigeria",          lang:"en",    currency:"NGN" },
        "KE": { name:"Kenya",            lang:"en",    currency:"KES" },
        "GH": { name:"Ghana",            lang:"en",    currency:"GHS" },
        "TZ": { name:"Tanzania",         lang:"en",    currency:"TZS" },
        // Ásia extra
        "PH": { name:"Philippines",      lang:"en",    currency:"PHP" },
        "MY": { name:"Malaysia",         lang:"en",    currency:"MYR" },
        "ID": { name:"Indonesia",        lang:null,    currency:"IDR" },
        "VN": { name:"Vietnam",          lang:null,    currency:"VND" },
        "PK": { name:"Pakistan",         lang:"en",    currency:"PKR" },
        "BD": { name:"Bangladesh",       lang:"en",    currency:"BDT" },
        // América Latina extra
        "GT": { name:"Guatemala",        lang:"es",    currency:"GTQ" },
        "DO": { name:"Dominican Rep.",   lang:"es",    currency:"DOP" },
        "BO": { name:"Bolivia",          lang:"es",    currency:"BOB" },
        "PY": { name:"Paraguay",         lang:"es",    currency:"PYG" },
        "VE": { name:"Venezuela",        lang:"es",    currency:"USD" },
        "CR": { name:"Costa Rica",       lang:"es",    currency:"CRC" },
        "PA": { name:"Panama",           lang:"es",    currency:"USD" },
      };

      // Lista países já em markets
      const existingCountries = new Set();
      try {
        const mData = await gql(destination.shop, `
          query { markets(first: 100) { edges { node { name regions(first: 100) { edges { node { ... on MarketRegionCountry { code } } } } } } } }
        `, {}, tokenDest);
        for (const e of mData.markets.edges) {
          const regionCount = e.node.regions.edges.length;
          if (regionCount > 10) { log(`⏭️ Ignorando market "${e.node.name}" (${regionCount} países — catch-all)`); continue; }
          for (const r of e.node.regions.edges) if (r.node.code) existingCountries.add(r.node.code);
        }
      } catch {}

      const paisesParaCriar = Object.entries(MARKET_MAP).filter(([code]) => !existingCountries.has(code));
      log(`🌍 ${existingCountries.size} países já cobertos | ${paisesParaCriar.length} a criar`);

      let mkCriados = 0;
      for (let i = 0; i < paisesParaCriar.length; i++) {
        const [code, cfg] = paisesParaCriar[i];
        progress("markets", i + 1, paisesParaCriar.length);
        try {
          // Cria market
          const r = await gql(destination.shop,
            `mutation marketCreate($input:MarketCreateInput!){marketCreate(input:$input){market{id}userErrors{field message}}}`,
            { input: { name: cfg.name, enabled: true, regions: [{ countryCode: code }] } }, tokenDest);

          if (r.marketCreate.userErrors.length > 0) continue;
          const marketId = r.marketCreate.market.id;
          mkCriados++;

          // Define idioma primário + inglês como secundário
          const locales = [];
          if (cfg.lang && cfg.lang !== "en") locales.push({ locale: cfg.lang, published: true });
          locales.push({ locale: "en", published: true }); // inglês sempre como secundário

          if (locales.length > 0) {
            try {
              await gql(destination.shop,
                `mutation marketLocalesAdd($marketId:ID!,$locales:[MarketLocaleInput!]!){marketLocalesAdd(marketId:$marketId,locales:$locales){marketLocales{locale}userErrors{message}}}`,
                { marketId, locales }, tokenDest);
            } catch {}
          }

          // Define moeda local
          try {
            await gql(destination.shop,
              `mutation($id:ID!,$i:MarketCurrencySettingsUpdateInput!){marketCurrencySettingsUpdate(marketId:$id,input:$i){userErrors{message}}}`,
              { id: marketId, i: { localCurrencies: true } }, tokenDest);
          } catch {}

        } catch {}
        await sleep(120);
      }
      log(`✅ Markets: ${mkCriados} criados | idioma + moeda configurados`, "success");
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

    send("done", { msg: "🎉 Clonagem completa!" });
  } catch (err) {
    send("error", { msg: `💥 Erro fatal: ${err.message}` });
  }
  res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🔄 Shopify Store Cloner rodando na porta ${PORT}\n`);
});
