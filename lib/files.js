const fields=`__typename ... on MediaImage { id alt fileStatus image { url } } ... on GenericFile { id alt fileStatus url }`;
export function fileName(url){try{return decodeURIComponent(new URL(url).pathname.split('/').pop());}catch{return '';}}
const urlOf=f=>f.image?.url||f.url;
export async function cloneFiles({source,target,log=()=>{},progress=()=>{},check=()=>{},wait=ms=>new Promise(r=>setTimeout(r,ms))}){
 async function list(call){const items=[];let after=null;do{check();const data=await call(`query CloneFiles($after:String){files(first:100,after:$after){nodes{${fields}} pageInfo{hasNextPage endCursor}}}`,{after});const c=data.files;if(!c?.nodes||!c.pageInfo)throw Error('Lista de arquivos incompleta.');items.push(...c.nodes);const next=c.pageInfo.hasNextPage?c.pageInfo.endCursor:null;if(c.pageInfo.hasNextPage&&(!next||next===after))throw Error('Paginação de arquivos incompleta.');after=next;}while(after);return items;}
 log('Lendo arquivos da origem e verificando os já existentes no destino…');
 const originals=(await list(source)).filter(f=>f.fileStatus==='READY'&&urlOf(f));const existing=await list(target);const index=new Map();for(const f of existing){const name=fileName(urlOf(f));if(name&&f.fileStatus==='READY')index.set(name,f);}
 const result={uploaded:0,skipped:0,failed:0,pending:0,urlMap:{}};const pending=[];
 log(`${originals.length} arquivos na origem; ${index.size} arquivos prontos no destino.`);
 for(let i=0;i<originals.length;i++){check();const f=originals[i],url=urlOf(f),filename=fileName(url);try{
  const found=index.get(filename);if(found){result.skipped++;result.urlMap[url]=urlOf(found);}else{
   const data=await target(`mutation CloneFile($files:[FileCreateInput!]!){fileCreate(files:$files){files{${fields}} userErrors{code message}}}`,{files:[{originalSource:url,filename,alt:f.alt||'',contentType:f.__typename==='GenericFile'?'FILE':'IMAGE',duplicateResolutionMode:'RAISE_ERROR'}]});
   const payload=data.fileCreate;if(!payload)throw Error('Shopify não confirmou o envio.');
   if(payload.userErrors?.length){if(payload.userErrors.every(e=>e.code==='FILENAME_ALREADY_EXISTS')){result.skipped++;log(`↪ ${filename}: já existe no destino; preservado.`);}else throw Error(payload.userErrors.map(e=>e.message).join('; '));}
   else{const created=payload.files?.[0];if(!created?.id)throw Error('Shopify não retornou ID do arquivo.');if(created.fileStatus==='FAILED')throw Error('Shopify falhou ao processar o arquivo.');if(created.fileStatus==='READY'&&urlOf(created)){result.uploaded++;result.urlMap[url]=urlOf(created);index.set(filename,created);}else pending.push({id:created.id,url,filename});}
  }
 }catch(e){result.failed++;log(`❌ ${filename}: ${e.message}`,'error');}
 progress('files',i+1,originals.length);if((i+1)%10===0||i===originals.length-1)log(`Arquivos ${i+1}/${originals.length}: ${result.uploaded} prontos, ${result.skipped} pulados, ${pending.length} processando, ${result.failed} erros.`);
 }
 for(let round=0;pending.length&&round<4;round++){check();log(`Aguardando processamento de ${pending.length} arquivos na Shopify…`);await wait(2000);for(let i=0;i<pending.length;){check();const batch=pending.slice(i,i+100);const data=await target(`query CloneFileStatus($ids:[ID!]!){nodes(ids:$ids){${fields}}}`,{ids:batch.map(f=>f.id)});const nodes=new Map((data.nodes||[]).filter(Boolean).map(f=>[f.id,f]));const keep=[];for(const p of batch){const f=nodes.get(p.id);if(f?.fileStatus==='READY'&&urlOf(f)){result.uploaded++;result.urlMap[p.url]=urlOf(f);}else if(f?.fileStatus==='FAILED'){result.failed++;log(`❌ ${p.filename}: falha no processamento pela Shopify.`,'error');}else keep.push(p);}pending.splice(i,batch.length,...keep);i+=keep.length;}}
 result.pending=pending.length;log(`Arquivos: ${result.uploaded} prontos | ${result.skipped} pulados | ${result.pending} processando | ${result.failed} erros`,result.failed?'error':'success');return result;
}
