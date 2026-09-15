(() => {
  const steps={markets:'Markets',fretes:'Fretes',colecoes:'Coleções',paginas:'Páginas',menus:'Menus',descontos:'Descontos',arquivos:'Arquivos',produtos:'Todos os produtos'};
  const $=id=>document.getElementById(id);
  let running=false;
  function updateDestination(){ $('reset-shop-label').textContent=getStoreData('dest').shop||'Preencha a loja de destino'; }
  document.addEventListener('tabchange',updateDestination);
  for(const id of ['dest-shop','dest-id','dest-secret'])$(id).addEventListener('input',()=>{$('reset-confirm').value='';updateDestination();});
  window.addEventListener('beforeunload',e=>{if(running){e.preventDefault();e.returnValue='';}});
  $('btn-reset').addEventListener('click',async()=>{
    if(running)return;
    const destination=getStoreData('dest');
    if(!destination.shop||!destination.clientId||!destination.clientSecret){alert('Preencha as credenciais da loja de destino em Clonar loja.');switchTab('clone');return;}
    const etapas=Object.fromEntries(Object.keys(steps).map(k=>[k,$('rst-'+k).checked]));
    const selected=Object.keys(steps).filter(k=>etapas[k]);
    if(!selected.length){alert('Selecione pelo menos uma etapa.');return;}
    const confirmShop=$('reset-confirm').value.trim();
    if(confirmShop!==destination.shop){alert('Digite o domínio exato da loja de destino.');$('reset-confirm').focus();return;}
    if(!confirm(`Apagar de ${destination.shop}:\n\n${selected.map(k=>'• '+steps[k]).join('\n')}\n\nEsta ação não pode ser desfeita. Confirmar exclusão?`))return;
    running=true;
    const controls=$('tab-reset').querySelectorAll('input,button');controls.forEach(e=>e.disabled=true);
    $('reset-log-area').replaceChildren();$('reset-status').textContent='Reset em andamento. Mantenha esta página aberta.';
    try {
      const response=await fetch('/api/reset-start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({destination,etapas,confirmShop})});
      if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||`Erro HTTP ${response.status}`);}
      await readOperationStream(response,'sse',data=>{
        if(data.type==='log'){const row=document.createElement('div');row.className='log-line '+(data.status||'info');row.textContent=data.msg;$('reset-log-area').append(row);row.scrollIntoView({block:'nearest'});}
        if(data.type==='progress')$('reset-status').textContent=`${data.step.replace('reset_','')}: ${data.current}/${data.total}`;
        if(data.type==='done')$('reset-status').textContent=data.msg;
      });
    }catch(e){$('reset-status').textContent='Reset interrompido: '+e.message;}
    finally{running=false;controls.forEach(e=>e.disabled=false);$('reset-confirm').value='';}
  });
  updateDestination();
})();
