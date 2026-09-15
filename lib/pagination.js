export async function paginateShopify(shop, path, token, key, version, {request=fetch, wait=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  const items=[], origin=`https://${shop}`;
  let url=`${origin}/admin/api/${version}${path}`;
  while(url) {
    if(new URL(url).origin!==origin)throw new Error('Link de paginação fora da loja Shopify.');
    let page;
    for(let attempt=0;attempt<5;attempt++) {
      const res=await request(url,{headers:{'X-Shopify-Access-Token':token},signal:AbortSignal.timeout(45000)});
      if(res.status===429){if(attempt<4)await wait(2000*(attempt+1));continue;}
      if(!res.ok)throw new Error(`Erro Shopify ${res.status} ao carregar ${key}.`);
      const data=await res.json();
      if(!Array.isArray(data[key]))throw new Error(`Resposta inválida ao carregar ${key}.`);
      page=data[key];
      const next=(res.headers.get('link')||'').match(/<([^>]+)>;\s*rel="next"/);
      url=next?next[1]:null;
      break;
    }
    if(!page)throw new Error('Limite de chamadas persistente ao paginar a Shopify. Tente novamente mais tarde.');
    items.push(...page);
  }
  return items;
}
