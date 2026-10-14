import type {AppConfig,ExchangeAdapter,ExchangeId,MarketSnapshot} from '../shared/types.js';
import type {FundingCandidate,FundingAutoVerification,FundingVerificationBatchTiming,FundingVerificationReadTiming,FundingVerificationDiagnostics,FundingVerificationRouteTiming} from '../shared/funding-opportunities.js';
import {quoteIsFresh} from './market-validity.js';
import {isFeeOnly} from '../shared/strategy-profile.js';
import {compareFundingVerificationPriority} from './funding-verification-priority.js';

export const PUBLIC_VERIFICATION_BATCH_SIZE=8;
export const PUBLIC_FUNDING_PRIORITY_COINS=8;
export const PUBLIC_VERIFICATION_TIMING_LIMIT=32;
interface Attempt {at:number;failed:boolean}
export interface PublicFundingMonitorOptions {
  config:()=>AppConfig;candidates:()=>FundingCandidate[];snapshots:()=>MarketSnapshot[];
  protectedBases:()=>ReadonlySet<string>;prefer:(candidate:FundingCandidate)=>boolean;
  readyBases?:()=>ReadonlySet<string>;
  verificationPriorities?:(candidates:readonly FundingCandidate[],now:number)=>ReadonlyMap<string,number>;
  adapters:(publicConfig:AppConfig)=>ExchangeAdapter[];
  publish:(quotes:MarketSnapshot[],config:AppConfig)=>Promise<void>;
  deadlineMs?:number;delayMs?:number;
}

/** Public reads have their own uncredentialed clients and never occupy the order/
 * position queue. A failed venue has one in-flight batch until it really settles. */
export class PublicFundingMonitor {
  private clients:ExchangeAdapter[]=[];private clientConfig?:AppConfig;
  private pending=new Map<ExchangeAdapter,Promise<MarketSnapshot[]>>();
  private readControllers=new Map<ExchangeAdapter,AbortController>();
  private attempts=new Map<string,Attempt>();private active:string[]=[];
  private running=false;private stopped=true;private timer?:ReturnType<typeof setTimeout>;
  private generation=0;private lastBatchAt=0;private nextBatchAt=0;
  private queueObserved=new Map<string,{id:string;at:number}>();
  private timingSequence=0;private timings:FundingVerificationBatchTiming[]=[];private currentTiming?:FundingVerificationBatchTiming;
  private selectionReasons=new Map<string,FundingVerificationRouteTiming['selectionReason']>();
  constructor(private readonly options:PublicFundingMonitorOptions){}
  start(){if(!this.stopped)return;this.stopped=false;this.schedule(0);}
  private schedule(delay=this.options.delayMs??1000){
    if(this.stopped)return;
    this.nextBatchAt=Date.now()+delay;
    this.timer=setTimeout(()=>{void this.runOnce().catch(()=>{}).finally(()=>this.schedule());},delay);
    this.timer.unref?.();
  }
  async stop(){
    this.stopped=true;this.generation++;this.nextBatchAt=0;
    if(this.timer)clearTimeout(this.timer);
    for(const controller of this.readControllers.values())controller.abort();
    const clients=this.clients;this.clients=[];this.clientConfig=undefined;
    await Promise.allSettled(clients.map(client=>client.close()));
  }
  private ensureClients(config:AppConfig){
    if(this.clientConfig===config)return;
    const old=this.clients;this.generation++;
    for(const client of old)this.readControllers.get(client)?.abort();
    // Paper config prevents the default adapters from loading API credentials or
    // accepting financial writes. Only fetchSnapshots and close are called here.
    this.clients=this.options.adapters({...config,mode:'paper',paperFeeOnly:isFeeOnly(config),autoEnabled:false});this.clientConfig=config;
    void Promise.allSettled(old.map(client=>client.close()));
  }
  private batch(candidates:FundingCandidate[],config:AppConfig,now:number):FundingCandidate[]{
    const protectedBases=this.options.protectedBases(),readyBases=this.options.readyBases?.()??new Set<string>(),best=new Map<string,FundingCandidate>();
    const observedPriorities=this.options.verificationPriorities?.(candidates,now);
    const verificationPriorities=observedPriorities?new Map(candidates.filter(candidate=>!protectedBases.has(candidate.base)&&this.options.prefer(candidate))
      .map(candidate=>[candidate.id,observedPriorities.get(candidate.id)??0] as const)):undefined;
    const verificationOrder=(a:FundingCandidate,b:FundingCandidate)=>verificationPriorities?compareFundingVerificationPriority(a,b,verificationPriorities):0;
    // A promising funding route needs continuing metadata even before its price,
    // timing or account checks make it executable. Keep this bounded to eight
    // connected coins; the rest retain the original discovery/backoff cadence.
    const priorityOrder=(a:FundingCandidate,b:FundingCandidate)=>b.normalized8hBps-a.normalized8hBps||b.grossFundingUsd-a.grossFundingUsd||a.id.localeCompare(b.id);
    const priority=new Map<string,FundingCandidate>();
    for(const candidate of candidates.filter(candidate=>!protectedBases.has(candidate.base)&&this.options.prefer(candidate)&&
      ((verificationPriorities?.get(candidate.id)??0)>0||Number.isFinite(candidate.grossFundingUsd)&&candidate.grossFundingUsd>0&&
        Number.isFinite(candidate.normalized8hBps)&&candidate.normalized8hBps>0)).sort((a,b)=>verificationOrder(a,b)||priorityOrder(a,b))){
      if(!priority.has(candidate.base))priority.set(candidate.base,candidate);
      if(priority.size>=PUBLIC_FUNDING_PRIORITY_COINS)break;
    }
    // Public statistics do not know the account's exact contract fee; live discovery ranks observable funding only.
    const score=(c:FundingCandidate)=>config.mode==='live'||config.entryPolicy==='aligned'?c.grossFundingUsd:c.afterFeesUsd;
    const rank=(a:FundingCandidate,b:FundingCandidate)=>verificationOrder(a,b)||Number(readyBases.has(b.base))-Number(readyBases.has(a.base))||
      (readyBases.has(a.base)&&readyBases.has(b.base)?(this.attempts.get(a.base)?.at??0)-(this.attempts.get(b.base)?.at??0):0)||
      Number(priority.has(b.base))-Number(priority.has(a.base))||Number(this.options.prefer(b))-Number(this.options.prefer(a))||
      (priority.has(a.base)&&priority.has(b.base)?priorityOrder(a,b):0)||
      Number(b.candidateEligible)-Number(a.candidateEligible)||score(b)-score(a)||a.id.localeCompare(b.id);
    for(const candidate of [...candidates].sort(rank))if(!protectedBases.has(candidate.base)&&!best.has(candidate.base))best.set(candidate.base,candidate);
    // Coins which failed or lacked a price advantage are revisited automatically,
    // but do not monopolize the scan while thousands of pairs remain unchecked.
    const due=[...best.values()].filter(candidate=>{
      const attempt=this.attempts.get(candidate.base);
      const fastRefreshMs=Math.max(1000,Math.min(15_000,config.maxSnapshotAgeMs/2));
      const refreshMs=priority.has(candidate.base)?attempt?.failed?30_000:fastRefreshMs:
        readyBases.has(candidate.base)?fastRefreshMs:attempt?.failed?30_000:120_000;
      return !attempt||now-attempt.at>=refreshMs;
    });
    // Queue age starts when this process first observes a due route. It is not
    // the historical funding timestamp or proof that the route was executable.
    const dueBases=new Set(due.map(candidate=>candidate.base));
    for(const base of this.queueObserved.keys())if(!dueBases.has(base))this.queueObserved.delete(base);
    for(const candidate of due)if(this.queueObserved.get(candidate.base)?.id!==candidate.id){
      if(this.queueObserved.size>=4096)this.queueObserved.delete(this.queueObserved.keys().next().value!);
      this.queueObserved.set(candidate.base,{id:candidate.id,at:now});
    }
    const selected=[...due].sort(rank).slice(0,PUBLIC_VERIFICATION_BATCH_SIZE-2),seen=new Set(selected.map(c=>c.base));
    this.selectionReasons.clear();
    for(const candidate of selected){
      const tier=verificationPriorities?.get(candidate.id)??0;
      this.selectionReasons.set(candidate.base,tier===4?'ioc-ready':tier===3?'positive-fee-net':tier===2||readyBases.has(candidate.base)?'ready':priority.has(candidate.base)?'funding-priority':'discovery');
    }
    const fair=[...due].filter(candidate=>!seen.has(candidate.base)).sort((a,b)=>(this.attempts.get(a.base)?.at??0)-(this.attempts.get(b.base)?.at??0)||rank(a,b));
    for(const candidate of fair.slice(0,2)){selected.push(candidate);seen.add(candidate.base);this.selectionReasons.set(candidate.base,'fair-rotation');}
    return selected;
  }
  private async read(client:ExchangeAdapter,bases:string[],config:AppConfig,timing:FundingVerificationReadTiming):Promise<MarketSnapshot[]>{
    if(this.pending.has(client)){timing.outcome='already-in-flight';timing.finishedAt=Date.now();return [];}
    const deadline=Math.max(1,Math.min(this.options.deadlineMs??10_000,config.maxSnapshotAgeMs/2));
    const controller=new AbortController(),context={deadlineAt:Date.now()+deadline,signal:controller.signal};
    const raw=Promise.resolve().then(()=>client.fetchSnapshots(bases,context));this.pending.set(client,raw);this.readControllers.set(client,controller);
    const clear=()=>{if(this.pending.get(client)===raw){this.pending.delete(client);this.readControllers.delete(client);}};void raw.then(clear,clear);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const quotes=await Promise.race([raw,new Promise<MarketSnapshot[]>((_,reject)=>{timer=setTimeout(()=>{timing.outcome='deadline';controller.abort();reject(new Error('Public monitoring deadline'));},deadline);})]);
      timing.outcome='returned';return quotes;
    }catch(error){if(timing.outcome!=='deadline')timing.outcome='failed';throw error;}
    finally{if(timer)clearTimeout(timer);timing.finishedAt=Date.now();}
  }
  /** Exposed for deterministic local tests; production uses the background timer. */
  async runOnce(){
    if(this.running)return;
    const config=this.options.config();if(config.dataSource!=='public')return;
    const candidates=this.options.candidates(),batch=this.batch(candidates,config,Date.now());
    if(!batch.length)return;
    this.ensureClients(config);const generation=this.generation;
    const bases=new Set(batch.map(candidate=>candidate.base)),plan=new Map<ExchangeId,string[]>(),venues=new Map<string,Set<ExchangeId>>();
    // One set of actual books covers every venue pairing for a coin; do not fetch
    // the same coin twice for each of its ten possible exchange combinations.
    for(const candidate of candidates)if(bases.has(candidate.base)){const exchanges=venues.get(candidate.base)??new Set<ExchangeId>();
      exchanges.add(candidate.longExchange);exchanges.add(candidate.shortExchange);venues.set(candidate.base,exchanges);}
    for(const candidate of batch)for(const exchange of venues.get(candidate.base)??[]){const wanted=plan.get(exchange)??[];wanted.push(candidate.base);plan.set(exchange,wanted);}
    const selectedAt=Date.now(),timing:FundingVerificationBatchTiming={sequence:++this.timingSequence,selectedAt,outcome:'reading',reads:[],
      routes:batch.map(candidate=>({id:candidate.id,base:candidate.base,longExchange:candidate.longExchange,shortExchange:candidate.shortExchange,
        queuedAt:this.queueObserved.get(candidate.base)?.at??selectedAt,selectedAt,selectionReason:this.selectionReasons.get(candidate.base)??'discovery',missingExchanges:[candidate.longExchange,candidate.shortExchange]}))};
    this.currentTiming=timing;this.running=true;this.active=[...bases];
    try{
      const results=await Promise.allSettled(this.clients.map(client=>{
        const requested=plan.get(client.id)??[];if(!requested.length)return Promise.resolve([]);
        const readTiming:FundingVerificationReadTiming={exchange:client.id,startedAt:Date.now(),outcome:'reading'};timing.reads.push(readTiming);
        return this.read(client,requested,config,readTiming);
      }));
      if(generation!==this.generation||this.options.config()!==config){timing.outcome='discarded';return;}
      const now=Date.now(),quotes=results.flatMap((result,index)=>result.status==='fulfilled'?
        result.value.filter(quote=>quote.exchange===this.clients[index]?.id&&plan.get(quote.exchange)?.includes(quote.base)&&quoteIsFresh(quote,config,now)):[]);
      for(const route of timing.routes){
        route.missingExchanges=[route.longExchange,route.shortExchange].filter(exchange=>!quotes.some(quote=>quote.base===route.base&&quote.exchange===exchange));
        if(!route.missingExchanges.length)route.pairedAt=Math.max(...timing.reads.filter(read=>read.exchange===route.longExchange||read.exchange===route.shortExchange).map(read=>read.finishedAt!));
      }
      timing.publishStartedAt=Date.now();
      try{await this.options.publish(quotes,config);}catch(error){timing.outcome='publish-failed';throw error;}
      if(generation!==this.generation||this.options.config()!==config){timing.outcome='discarded';return;}
      timing.publishedAt=Date.now();timing.outcome='published';
      for(const candidate of batch){
        const observed=new Set(quotes.filter(quote=>quote.base===candidate.base).map(quote=>quote.exchange));
        this.attempts.set(candidate.base,{at:now,failed:!observed.has(candidate.longExchange)||!observed.has(candidate.shortExchange)});
        this.queueObserved.delete(candidate.base);
      }
      this.lastBatchAt=now;
      const current=new Set(candidates.map(candidate=>candidate.base));for(const base of this.attempts.keys())if(!current.has(base))this.attempts.delete(base);
    }finally{
      timing.finishedAt=Date.now();this.timings.push(timing);if(this.timings.length>PUBLIC_VERIFICATION_TIMING_LIMIT)this.timings.shift();
      if(this.currentTiming===timing)this.currentTiming=undefined;
      this.running=false;this.active=[];
    }
  }
  private diagnostics():FundingVerificationDiagnostics {
    const duration=(from:number,to:number|undefined)=>to!==undefined&&Number.isFinite(to-from)&&to>=from?[to-from]:[];
    const p95=(values:number[])=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]:undefined;
    const queued=[...this.queueObserved].filter(([base])=>!this.active.includes(base));
    return {sampleLimit:PUBLIC_VERIFICATION_TIMING_LIMIT,sampleCount:this.timings.length,totalBatches:this.timingSequence,
      queuedCoins:queued.length,...(queued.length?{oldestQueuedAt:Math.min(...queued.map(([,observation])=>observation.at))}:{}),
      queueWaitP95Ms:p95(this.timings.flatMap(batch=>batch.routes.flatMap(route=>duration(route.queuedAt,route.selectedAt)))),
      readP95Ms:p95(this.timings.flatMap(batch=>batch.reads.filter(read=>read.outcome!=='already-in-flight').flatMap(read=>duration(read.startedAt,read.finishedAt)))),
      publishP95Ms:p95(this.timings.filter(batch=>batch.outcome==='published').flatMap(batch=>batch.publishStartedAt===undefined?[]:duration(batch.publishStartedAt,batch.publishedAt))),
      ...(this.currentTiming?{currentBatch:structuredClone(this.currentTiming)}:{}),recentBatches:structuredClone(this.timings.slice(-2))};
  }
  status(candidates=this.options.candidates(),now=Date.now()):FundingAutoVerification {
    const bases=new Set(candidates.map(candidate=>candidate.base)),checked=new Set([...this.attempts.keys()].filter(base=>bases.has(base))),freshVenues=new Map<string,Set<ExchangeId>>();
    for(const quote of this.options.snapshots())if(bases.has(quote.base)){
      checked.add(quote.base);
      // Foreground watches and manual requests are actual public attempts too.
      // Retain their observation after the short-lived quote cache rotates out.
      if(!this.attempts.has(quote.base))this.attempts.set(quote.base,{at:quote.observedAt??quote.timestamp,failed:false});
      if(quoteIsFresh(quote,this.options.config(),now)){const venues=freshVenues.get(quote.base)??new Set<ExchangeId>();venues.add(quote.exchange);freshVenues.set(quote.base,venues);}
    }
    const fresh=new Set(candidates.filter(candidate=>freshVenues.get(candidate.base)?.has(candidate.longExchange)&&freshVenues.get(candidate.base)?.has(candidate.shortExchange)).map(candidate=>candidate.base));
    return {enabled:true,running:this.running,batchSize:PUBLIC_VERIFICATION_BATCH_SIZE,totalCoins:bases.size,checkedCoins:checked.size,
      freshCoins:fresh.size,pendingCoins:bases.size-checked.size,failedCoins:[...this.attempts].filter(([base,attempt])=>bases.has(base)&&attempt.failed&&!fresh.has(base)).length,
      activeCoins:[...this.active],lastBatchAt:this.lastBatchAt,nextBatchAt:this.nextBatchAt,diagnostics:this.diagnostics()};
  }
}
