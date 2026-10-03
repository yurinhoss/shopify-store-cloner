import {randomUUID} from 'node:crypto';

// Small HTTP batches share one import session. Credentials never leave the server.
export class ImportSessions {
  constructor({now=Date.now, ttl=2*60*60*1000, max=30}={}) { this.jobs=new Map();this.now=now;this.ttl=ttl;this.max=max; }
  acquire(owner, body) {
    for(const [id,job] of this.jobs) if(!job.busy && this.now()-job.touched>this.ttl)this.jobs.delete(id);
    let job;
    if(body.importId) {
      job=this.jobs.get(body.importId);
      if(!job || job.owner!==owner)throw Object.assign(new Error('Sessão de importação expirou. Inicie novamente com “Pular duplicados” marcado.'),{status:410});
      if(job.busy)throw Object.assign(new Error('A etapa anterior ainda está terminando.'),{status:409});
    } else {
      if([...this.jobs.values()].some(j=>j.busy && j.body.destination?.shop && j.body.destination.shop===body.destination?.shop))
        throw Object.assign(new Error('Já existe uma importação em andamento nesta loja. Aguarde a etapa atual terminar.'),{status:409});
      if(this.jobs.size>=this.max){const finished=[...this.jobs.values()].find(j=>j.finished&&!j.busy);if(finished)this.jobs.delete(finished.id);}
      if(this.jobs.size>=this.max)throw Object.assign(new Error('Há muitas importações abertas. Tente novamente em alguns minutos.'),{status:503});
      job={id:randomUUID(),owner,body:structuredClone(body),cursor:{},completed:{},cache:{},finished:false};
      this.jobs.set(job.id,job);
    }
    job.busy=true;job.touched=this.now();return job;
  }
  release(job) { job.busy=false;job.touched=this.now(); }
}
export class ImportBatch {
  constructor({now=Date.now,maxItems=100,maxMs=240000}={}) {this.now=now;this.started=now();this.maxItems=maxItems;this.maxMs=maxMs;this.items=0;}
  exhausted() {return this.items>=this.maxItems || this.now()-this.started>=this.maxMs;}
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
