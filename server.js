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
  const { origin, destination, options } = req.body;

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
      for (let i = 0; i < produtos.length; i++) {
        const p = produtos[i];
        progress("products", i + 1, produtos.length);
        origIdToHandle[p.id] = p.handle;

        if (handlesDest.has(p.handle)) {
          productIdMap[p.id] = handlesDest.get(p.handle);
          handleToDestId[p.handle] = handlesDest.get(p.handle);
          pulados++;
          continue;
        }

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
              title: p.title, body_html: p.body_html,
              vendor: p.vendor, product_type: p.product_type,
              handle: p.handle, tags: p.tags,
              status: p.status || "active", published: true,
              options: opts, variants, images,
            },
          });
          productIdMap[p.id] = data.product.id;
          handleToDestId[p.handle] = data.product.id;
          criados++;
          if (criados % 10 === 0) log(`✅ ${criados} produtos criados...`);
        } catch (err) {
          log(`❌ ${p.title.slice(0, 40)}: ${err.message.slice(0, 60)}`, "error");
          falha++;
        }
        await sleep(500);
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
          const body = { smart_collection: { title: c.title, handle: c.handle, body_html: c.body_html, rules: c.rules, disjunctive: c.disjunctive, sort_order: c.sort_order, published: true } };
          if (c.image?.src) body.smart_collection.image = { src: c.image.src };
          const data = await restCall("POST", destination.shop, "/smart_collections.json", tokenDest, body);
          collectionIdMap[c.id] = data.smart_collection.id;
          criados++;
        } catch {}
        await sleep(400);
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
            const body = { custom_collection: { title: c.title, handle: c.handle, body_html: c.body_html, sort_order: c.sort_order || "manual", published: true } };
            if (c.image?.src) body.custom_collection.image = { src: c.image.src };
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
            await sleep(150);
          }
        } catch {}
        await sleep(300);
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
            page: { title: p.title, handle: p.handle, body_html: p.body_html, published: true },
          });
          criados++;
        } catch {}
        await sleep(300);
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
      const dataP = await gql(origin.shop, `query { shop { shopPolicies { type body } } }`, {}, tokenOrig);
      for (const pol of dataP.shop.shopPolicies || []) {
        if (!pol.body?.trim()) continue;
        try {
          await gql(destination.shop, `mutation shopPolicyUpdate($shopPolicy:ShopPolicyInput!){shopPolicyUpdate(shopPolicy:$shopPolicy){shopPolicy{type}userErrors{message}}}`,
            { shopPolicy: { type: pol.type, body: pol.body } }, tokenDest);
        } catch {}
      }
      log("✅ Políticas copiadas", "success");
    }

    // ==== ARQUIVOS (banners, ícones) ====
    if (options.files) {
      log("━━━━━━━━━━ ETAPA 7: ARQUIVOS (banners, ícones) ━━━━━━━━━━");
      const arquivos = [];
      let cursor = null;
      while (true) {
        const after = cursor ? `, after: "${cursor}"` : "";
        const q = `query { files(first: 50${after}) { edges { cursor node { ... on MediaImage { id alt image { url } fileStatus } ... on GenericFile { id url alt fileStatus } } } pageInfo { hasNextPage endCursor } } }`;
        const data = await gql(origin.shop, q, {}, tokenOrig);
        for (const e of data.files.edges) {
          const n = e.node;
          const url = n?.image?.url || n?.url;
          if (url && n.fileStatus === "READY") arquivos.push({ url, alt: n.alt || "" });
        }
        if (!data.files.pageInfo.hasNextPage) break;
        cursor = data.files.pageInfo.endCursor;
      }
      log(`📁 ${arquivos.length} arquivos encontrados`);

      let uploaded = 0;
      for (let i = 0; i < arquivos.length; i++) {
        progress("files", i + 1, arquivos.length);
        try {
          await gql(destination.shop, `mutation fileCreate($files:[FileCreateInput!]!){fileCreate(files:$files){files{id}userErrors{message}}}`,
            { files: [{ originalSource: arquivos[i].url, alt: arquivos[i].alt, contentType: "IMAGE" }] }, tokenDest);
          uploaded++;
        } catch {}
        await sleep(500);
      }
      log(`✅ Arquivos: ${uploaded} enviados`, "success");
      await sleep(5000);
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
            if (ad.asset?.value !== undefined) putBody.asset.value = ad.asset.value;
            else if (ad.asset?.attachment) putBody.asset.attachment = ad.asset.attachment;
            else continue;
            await restCall("PUT", destination.shop, `/themes/${tDestino.id}/assets.json`, tokenDest, putBody);
            copiados++;
          } catch {}
          await sleep(300);
        }
        log(`✅ Tema: ${copiados} assets copiados`, "success");
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
