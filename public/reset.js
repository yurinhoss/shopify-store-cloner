(() => {
  const steps={markets:'Markets',fretes:'Fretes',colecoes:'Coleções',paginas:'Páginas',menus:'Menus',descontos:'Descontos',arquivos:'Arquivos',produtos:'Todos os produtos'};
  const $=id=>document.getElementById(id);
  let running=false;
  const panel=document.createElement('div');
  panel.className='reset-progress';panel.hidden=true;
  panel.innerHTML='<div class="reset-progress-heading"><span class="reset-progress-icon" aria-hidden="true"></span><span class="reset-progress-title">Preparando reset</span><strong class="reset-progress-percent">…</strong></div><div class="progress-bar-bg" role="progressbar" aria-label="Progresso da etapa" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar-fill"></div></div><div class="reset-progress-detail">Conectando à loja de destino…</div>';
  $('reset-status').before(panel);
  function progress(state,title,detail,value){
    panel.hidden=false;panel.dataset.state=state;
    panel.querySelector('.reset-progress-title').textContent=title;
    panel.querySelector('.reset-progress-detail').textContent=detail;
    panel.querySelector('.reset-progress-percent').textContent=value==null?'…':value+'%';
    const track=panel.querySelector('[role="progressbar"]');
    if(value==null)track.removeAttribute('aria-valuenow');else track.setAttribute('aria-valuenow',value);
    panel.querySelector('.progress-bar-fill').style.width=(value==null?35:value)+'%';
  }
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
    progress('waiting','Preparando reset','Autenticando e verificando as etapas selecionadas…',null);
    const controls=$('tab-reset').querySelectorAll('input,button');controls.forEach(e=>e.disabled=true);
    $('reset-log-area').replaceChildren();$('reset-status').textContent='Reset em andamento. Mantenha esta página aberta.';
    try {
      const response=await fetch('/api/reset-start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({destination,etapas,confirmShop})});
      if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||`Erro HTTP ${response.status}`);}
      await readOperationStream(response,'sse',data=>{
        if(data.type==='log'){const row=document.createElement('div');row.className='log-line '+(data.status||'info');row.textContent=data.msg;$('reset-log-area').append(row);row.scrollIntoView({block:'nearest'});}
        if(data.type==='progress'){
          const key=data.step.replace('reset_',''),pct=data.total>0?Math.min(100,Math.round(data.current/data.total*100)):0;
          progress('running',steps[key]||key,`Etapa ${Math.max(1,selected.indexOf(key)+1)} de ${selected.length} · ${data.current} de ${data.total} itens`,pct);
          $('reset-status').textContent='Reset em andamento. Mantenha esta página aberta.';
        }
        if(data.type==='done'){progress(data.hasErrors?'warning':'done',data.hasErrors?'Concluído com pendências':'Reset concluído',data.hasErrors?'Confira os detalhes abaixo.':'Todas as etapas selecionadas foram processadas.',100);$('reset-status').textContent=data.msg;}
      });
    }catch(e){progress('error','Reset interrompido','Confira a mensagem abaixo antes de tentar novamente.',null);$('reset-status').textContent='Reset interrompido: '+e.message;}
    finally{running=false;controls.forEach(e=>e.disabled=false);$('reset-confirm').value='';}
  });
  updateDestination();
})();

