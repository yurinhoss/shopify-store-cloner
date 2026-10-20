// Read both operation protocols, including split UTF-8 and final unterminated lines.
async function readOperationStream(response, format, onEvent, {signal,idleMs=0}={}) {
  if (!response?.ok || !response.body) throw new Error(`Não foi possível iniciar: HTTP ${response?.status || 'sem resposta'}`);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', completed = false;
  function consume(line) {
    line = line.trim();
    if (!line || (format === 'sse' && !line.startsWith('data:'))) return;
    const event = JSON.parse(format === 'sse' ? line.slice(5).trim() : line);
    if (event.type === 'error') throw Object.assign(new Error(event.message || event.msg || 'Falha na operação.'),{retryable:event.retryable===true});
    onEvent(event);
    if (event.type === 'done') completed = true;
  }
  try {
    while (!completed) {
      const { done, value } = await new Promise((resolve,reject)=>{
        let timer;
        const abort=()=>finish(reject,importAbortError());
        function finish(fn,value){if(timer)clearTimeout(timer);signal?.removeEventListener('abort',abort);fn(value);}
        if(signal?.aborted)return abort();
        signal?.addEventListener('abort',abort,{once:true});
        if(idleMs)timer=setTimeout(()=>finish(reject,new Error('Conexão sem resposta. Reconectando...')),idleMs);
        reader.read().then(value=>finish(resolve,value),error=>finish(reject,error));
      });
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) consume(line);
      if (done) { if (buffer) consume(buffer); break; }
    }
    if (!completed) throw new Error('Conexão interrompida. Confira a loja antes de repetir: algumas alterações podem ter sido gravadas.');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// A stable request ID also recovers the first request if its checkpoint was lost.
function importAbortError(){return Object.assign(new Error('Importação pausada.'),{name:'AbortError'});}
function importRetryWait(ms,signal){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(importAbortError());
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(importAbortError());};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
    signal?.addEventListener('abort',abort,{once:true});
  });
}
async function runImportBatches(payload, onEvent, {request=fetch, wait=importRetryWait, signal, idleMs=60000}={}) {
  const initial={...payload,importRequestId:payload.importRequestId || globalThis.crypto?.randomUUID?.() || Date.now().toString(36)+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)};
  let importId=null, failures=0;
  for(;;) {
    if(signal?.aborted)throw importAbortError();
    let more=false;
    try {
      const response=await request('/api/store-import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(importId?{importId}:initial),signal});
      if(!response.ok) {
        let detail;try{detail=await response.json();}catch{}
        if(detail?.importId)importId=detail.importId;
        const temporary=[408,425,429,500,502,503,504].includes(response.status) || (response.status===409 && (importId || detail?.code==='IMPORT_BUSY'));
        const retryAfter=Number(response.headers.get('Retry-After'));
        throw Object.assign(new Error(detail?.error||`Não foi possível importar: HTTP ${response.status}`),{retryable:temporary,retryAfter:Number.isFinite(retryAfter)?Math.min(300000,Math.max(0,retryAfter*1000)):0});
      }
      await readOperationStream(response,'ndjson',event=>{
        if(event.importId)importId=event.importId;
        if(event.type==='done')more=event.continue===true;
        onEvent(event);
      },{signal,idleMs});
      failures=0;
      if(!more)return;
    } catch(error) {
      if(signal?.aborted || error.name==='AbortError')throw importAbortError();
      if(error.retryable===false)throw error;
      failures++;
      const delay=Math.max(error.retryAfter||0,Math.min(30000,2000*2**Math.min(failures-1,4)));
      onEvent({type:'reconnecting',attempt:failures,delay,log:`🔄 Conexão interrompida. Nova tentativa automática em ${Math.ceil(delay/1000)}s (tentativa ${failures}). O progresso está preservado.`});
      await wait(delay,signal);
    }
  }
}
