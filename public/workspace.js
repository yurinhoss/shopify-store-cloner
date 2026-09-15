(() => {
  const pages = {
    clone:['Clonar loja','Prepare sua próxima loja.','Conecte origem e destino, escolha o conteúdo e acompanhe cada etapa da clonagem.','M8 3H3v13h5M8 8h13v13H8z'],
    storeimport:['Importar por URL','Traga seu catálogo para cá.','Importe produtos e conteúdo de uma URL pública para a loja de destino conectada.','M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5'],
    markets:['Markets','Sua loja em novos mercados.','Selecione os países e revise moedas e idiomas disponíveis nesta loja antes de aplicar.','M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18'],
    shipping:['Fretes','Entregas prontas para vender.','Configure os países, revise os valores convertidos e aplique os fretes no destino.','M3 5h11v12H3zM14 9h4l3 4v4h-7M6 17v3m12-3v3'],
    scopes:['Permissões API','Conecte com as permissões certas.','Consulte os acessos necessários para os aplicativos das suas lojas Shopify.','M12 3 4 6v6c0 4 8 9 8 9s8-5 8-9V6zM9 12l2 2 4-4'],
    reset:['Resetar loja','Reset indisponível nesta versão.','O servidor atual não possui as rotas necessárias para executar exclusões.','M5 7h14M9 7V4h6v3M7 7l1 14h8l1-14']
  };
  const nav=document.querySelector('.tabs');
  for(const [id, data] of Object.entries(pages)) {
    const button=document.querySelector(`[data-tab="${id}"]`);
    button.replaceChildren();
    const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('fill','none');icon.setAttribute('stroke','currentColor');icon.setAttribute('stroke-width','1.6');icon.setAttribute('stroke-linecap','round');icon.setAttribute('stroke-linejoin','round');icon.setAttribute('aria-hidden','true');
    const path=document.createElementNS(icon.namespaceURI,'path');path.setAttribute('d',data[3]);icon.append(path);button.append(icon,document.createTextNode(data[0]));nav.append(button);
    button.setAttribute('aria-controls',`tab-${id}`);
  }
  document.addEventListener('tabchange',e=>{
    const data=pages[e.detail];if(!data)return;
    document.getElementById('page-title').textContent=data[0];document.getElementById('section-title').textContent=data[1];document.getElementById('section-description').textContent=data[2];
    for(const b of nav.querySelectorAll('button'))b.setAttribute('aria-current',b.dataset.tab===e.detail?'page':'false');
  });
  const reset=document.getElementById('tab-reset');
  reset.replaceChildren();const notice=document.createElement('p');notice.className='unavailable';notice.textContent='A opção antiga chamava /api/reset-start e /api/clone-status, mas essas rotas não existem. Nenhuma exclusão será iniciada por esta tela. Para excluir conteúdo, use o administrador da loja Shopify.';reset.append(notice);
  for(const prefix of ['orig','dest'])for(const suffix of ['shop','id','secret'])document.getElementById(`${prefix}-${suffix}`).addEventListener('input',()=>{const key=prefix==='orig'?'origin':'dest';document.getElementById(`dot-${key}`).className='status-dot';document.getElementById(`info-${key}`).textContent='Credenciais alteradas. Teste a conexão novamente.';});
  switchTab('clone');
})();
