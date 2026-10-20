import {randomUUID} from 'node:crypto';

// Small HTTP batches share one import session. Credentials never leave the server.
export class ImportSessions {
  constructor({now=Date.now, ttl=24*60*60*1000, max=30}={}) { this.jobs=new Map();this.now=now;this.ttl=ttl;this.max=max; }
  acquire(owner, body) {
    for(const [id,job] of this.jobs) if(!job.busy && this.now()-job.touched>this.ttl)this.jobs.delete(id);
    let job;
    const requestId=typeof body.importRequestId==='string' && /^[a-zA-Z0-9_-]{16,100}$/.test(body.importRequestId) ? body.importRequestId : null;
    const previous=requestId && [...this.jobs.values()].find(j=>j.owner===owner && j.requestId===requestId);
    if(body.importId || previous) {
      job=body.importId?this.jobs.get(body.importId):previous;
      if(!job || job.owner!==owner)throw Object.assign(new Error('Sessão de importação expirou. Inicie novamente com “Pular duplicados” marcado.'),{status:410});
      if(job.busy)throw Object.assign(new Error('A etapa anterior ainda está terminando.'),{status:409,code:'IMPORT_BUSY',importId:job.id,retryable:true});
    } else {
      if([...this.jobs.values()].some(j=>j.busy && j.body.destination?.shop && j.body.destination.shop===body.destination?.shop))
        throw Object.assign(new Error('Já existe uma importação em andamento nesta loja. Aguarde a etapa atual terminar.'),{status:409});
      if(this.jobs.size>=this.max){const finished=[...this.jobs.values()].find(j=>j.finished&&!j.busy);if(finished)this.jobs.delete(finished.id);}
      if(this.jobs.size>=this.max)throw Object.assign(new Error('Há muitas importações abertas. Tente novamente em alguns minutos.'),{status:503});
      job={id:randomUUID(),owner,requestId,body:structuredClone(body),cursor:{},completed:{},cache:{},finished:false};
      this.jobs.set(job.id,job);
    }
    job.busy=true;job.touched=this.now();return job;
  }
  release(job) { job.busy=false;job.touched=this.now(); }
}
export class ImportBatch {
  constructor({now=Date.now,maxItems=100,maxMs=240000}={}) {this.now=now;this.started=now();this.maxItems=maxItems;this.maxMs=maxMs;this.items=0;}
  stop() {this.stopped=true;}
  exhausted() {return this.stopped || this.items>=this.maxItems || this.now()-this.started>=this.maxMs;}
  complete() {this.items++;}
}

// Commit the cursor only after every request in the wave finishes. Reconnection
// waits for the session lock, so it never submits an in-flight product twice.
export async function runImportItems(job,phase,items,batch,process,{concurrency=5}={}) {
  for(let start=job.cursor[phase]||0;start<items.length;) {
    if(batch.exhausted())throw new Error('IMPORT_CONTINUE');
    const end=Math.min(start+concurrency,items.length,start+batch.maxItems-batch.items);
    const results=await Promise.allSettled(items.slice(start,end).map((item,offset)=>process(item,start+offset)));
    const failure=results.find(result=>result.status==='rejected');
    if(failure)throw failure.reason;
    job.cursor[phase]=end;
    batch.items+=end-start;start=end;
  }
}

// Only temporary transport, throttling and upstream availability errors retry.
export function isTemporaryImportError(error) {
  if(error?.retryable===false)return false;
  if(error?.retryable===true)return true;
  if(/^(408|425|429|5\d\d):|HTTP (408|425|429|5\d\d)\b/i.test(error?.message||''))return true;
  if(['TimeoutError'].includes(error?.name))return true;
  return /network(?: error)?|fetch failed|failed to fetch|load failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_|socket (?:hang up|closed)|rate limit|limite de chamadas|throttled/i.test([error?.message,error?.cause?.code].join(' '));
}
