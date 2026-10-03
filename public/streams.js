// Read both operation protocols, including split UTF-8 and final unterminated lines.
async function readOperationStream(response, format, onEvent) {
  if (!response?.ok || !response.body) throw new Error(`Não foi possível iniciar: HTTP ${response?.status || 'sem resposta'}`);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', completed = false;
  function consume(line) {
    line = line.trim();
    if (!line || (format === 'sse' && !line.startsWith('data:'))) return;
    const event = JSON.parse(format === 'sse' ? line.slice(5).trim() : line);
    if (event.type === 'error') throw Object.assign(new Error(event.message || event.msg || 'Falha na operação.'),{retryable:false});
    onEvent(event);
    if (event.type === 'done') completed = true;
  }
  try {
    while (!completed) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) consume(line);
      if (done) { if (buffer) consume(buffer); break; }
    }
    if (!completed) throw new Error('Conexão interrompida. Confira a loja antes de repetir: algumas alterações podem ter sido gravadas.');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// Rotate connections before the hosting timeout; reconnect to the same server cursor.
async function runImportBatches(payload, onEvent, {request=fetch, wait=ms=>new Promise(r=>setTimeout(r,ms)), now=Date.now}={}) {
  let importId=null, failures=0, busySince=null;
  for(;;) {
    let more=false;
    try {
      const response=await request('/api/store-import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(importId?{importId}:payload)});
      if(response.status===409 && importId) {
        busySince??=now();
        if(now()-busySince>600000)throw Object.assign(new Error('A etapa está demorando mais que o esperado. Aguarde antes de iniciar outra importação.'),{retryable:false});
        await wait(3000);continue;
      }
      if(!response.ok) {
        let detail;try{detail=await response.json();}catch{}
        throw Object.assign(new Error(detail?.error||`Não foi possível importar: HTTP ${response.status}`),{retryable:false});
      }
      busySince=null;
      await readOperationStream(response,'ndjson',event=>{
        if(event.importId)importId=event.importId;
        if(event.type==='done')more=event.continue===true;
        onEvent(event);
      });
      failures=0;
      if(!more)return;
    } catch(error) {
      if(error.retryable===false || !importId || ++failures>3)throw error;
      onEvent({log:'🔄 Conexão interrompida. Retomando a mesma importação sem repetir os itens processados...'});
      await wait(2000*failures);
    }
  }
}
