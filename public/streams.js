// Read both operation protocols, including split UTF-8 and final unterminated lines.
async function readOperationStream(response, format, onEvent) {
  if (!response?.ok || !response.body) throw new Error(`Não foi possível iniciar: HTTP ${response?.status || 'sem resposta'}`);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', completed = false;
  function consume(line) {
    line = line.trim();
    if (!line || (format === 'sse' && !line.startsWith('data:'))) return;
    const event = JSON.parse(format === 'sse' ? line.slice(5).trim() : line);
    if (event.type === 'error') throw new Error(event.message || event.msg || 'Falha na operação.');
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
