import type {ExecutionLatencyEvent,RealtimeStatus} from '../shared/realtime.js';

/** Volatile execution telemetry, never persisted as financial data. */
export class RealtimeLatency {
  private pending=new Map<string,{first?:number;firstConfirmed?:number;hedge?:number;hedgeConfirmed?:number}>();
  private samples:{firstLegMs:number;hedgeMs:number;matchedMs:number}[]=[];
  observe(event:ExecutionLatencyEvent):void {
    if(!Number.isFinite(event.at)||event.at<=0)return;
    const key=`${event.positionId}:${event.batch??1}`,sample=this.pending.get(key)??{};
    if(event.phase==='first-submit')sample.first??=event.at;
    if(event.phase==='first-confirmed')sample.firstConfirmed??=event.at;
    if(event.phase==='hedge-submit')sample.hedge??=event.at;
    if(event.phase==='hedge-confirmed')sample.hedgeConfirmed??=event.at;
    this.pending.set(key,sample);
    if(event.phase==='matched'){
      if(sample.first!==undefined&&sample.firstConfirmed!==undefined&&sample.hedge!==undefined&&sample.hedgeConfirmed!==undefined&&
        sample.firstConfirmed>=sample.first&&sample.hedge>=sample.firstConfirmed&&sample.hedgeConfirmed>=sample.hedge&&event.at>=sample.hedgeConfirmed){
        this.samples.push({firstLegMs:sample.firstConfirmed-sample.first,hedgeMs:sample.hedgeConfirmed-sample.hedge,matchedMs:event.at-sample.first});
        this.samples=this.samples.slice(-200);
      }
      this.pending.delete(key);
    }
    if(event.phase==='finished')for(const pending of this.pending.keys())if(pending.startsWith(`${event.positionId}:`))this.pending.delete(pending);
    if(this.pending.size>2000)this.pending.delete(this.pending.keys().next().value!);
  }
  status():RealtimeStatus['latency'] {
    if(!this.samples.length)return {samples:0};
    const last=this.samples.at(-1)!;
    const p95=(field:'hedgeMs'|'matchedMs')=>this.samples.map(sample=>sample[field]).sort((a,b)=>a-b)[Math.ceil(this.samples.length*.95)-1];
    return {samples:this.samples.length,...last,p95HedgeMs:p95('hedgeMs'),p95MatchedMs:p95('matchedMs')};
  }
}
