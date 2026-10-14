/** Local, persisted observations of one requested operation. These records never authorize orders. */
export type TradingOperationKind='entry'|'close'|'manual-close'|'profit-exit'|'funding-exit'|'emergency-close';
export type TradingOperationProtocol='ioc'|'maker-ioc'|'maker'|'mixed'|'unknown';
export type TradingOperationState='running'|'complete'|'partial'|'cancelled'|'failed'|'unknown';
export interface TradingOperationQuantities {long:number|null;short:number|null}
export interface TradingOperationStages {
  /** All clocks are local observations, not cross-exchange execution timestamps. Preserve the first event. */
  signalObservedAt?:number;preparationStartedAt?:number;preparationCompletedAt?:number;submittedAt?:number;
  acknowledgedAt?:number;firstFillObservedAt?:number;
  /** Final target paired/confirmed and subsequent account reconciliation, not the first partial batch. */
  pairedAt?:number;accountConfirmedAt?:number;
}
/** unknown is currently unresolved requests. submitted counts local adapter calls, not proven HTTP submissions. */
export interface TradingOperationAttempts {
  preflightNotSent:number;zeroFill:number;unknown:number;submitted:number;
  /** In-flight local adapter calls or positively identified working Maker orders; never completion evidence. */
  pending?:number;
}
export interface TradingOperationIntervention {
  kind:'user-retry'|'takeover'|'recovery'|'maintenance';evidenceId:string;requiredAt:number;resolvedAt?:number;
}
export interface TradingOperationExposure {
  /** Observed fill coverage is required. Missing history cannot become zero exposure. */
  complete:boolean;maxNotionalUsd:number|null;notionalTimeUsdMs:number|null;observedMs:number|null;
}
export interface TradingOperation {
  version:1;id:string;positionId:string;base:string;mode:'live'|'paper';origin:'automatic'|'manual';
  kind:TradingOperationKind;protocol:TradingOperationProtocol;state:TradingOperationState;
  startedAt:number;updatedAt:number;endedAt?:number;
  target:TradingOperationQuantities;confirmed:TradingOperationQuantities;remaining:TradingOperationQuantities;
  stages:TradingOperationStages;attempts:TradingOperationAttempts;
  /** Bounded, locally selected reason. Do not persist exception bodies, native responses or credentials here. */
  waitReason?:{code:string;text:string};
  /** Informational wait budget only; an expired window does not prove an order failed or completed. */
  windowEndsAt?:number;configDigest?:string;runtimeVersion?:string;
  intervention?:TradingOperationIntervention;exposure?:TradingOperationExposure;
  /** Complete realized cash attributable to this operation only. Never copy a whole-position total to every operation. */
  netPnlUsd?:number|null;
}
export interface TradingOperationSample {
  mean:number|null;max:number|null;p50:number|null;p95:number|null;knownCount:number;unknownCount:number;
}
export interface TradingOperationCounts {
  total:number;complete:number;running:number;partial:number;cancelled:number;failed:number;unknown:number;
  automatic:number;manual:number;intervention:number;invalid:number;duplicateIds:number;
}
export interface TradingOperationSummary {
  timestamp:number;counts:TradingOperationCounts;completionRatePct:number|null;interventionRatePct:number|null;
  /** Optional tracker coverage. Absent on pure aggregations and legacy responses. */
  diagnosticError?:string;coverageLimited?:boolean;retainedFrom?:number;
  timing:{totalMs:TradingOperationSample;preparationMs:TradingOperationSample;signalToSubmitMs:TradingOperationSample;
    submitToAckMs:TradingOperationSample;ackToFirstFillMs:TradingOperationSample;firstFillToPairedMs:TradingOperationSample;
    accountConfirmationMs:TradingOperationSample};
  /** Unfinished operations only. Report alongside completed duration to avoid survivor bias. */
  pendingAgeMs:TradingOperationSample;
  exposure:{maxNotionalUsd:TradingOperationSample;notionalTimeUsdMs:TradingOperationSample;observedMs:TradingOperationSample};
  amounts:{netPnlUsd:number|null;knownNetPnlUsd:number;knownCount:number;unknownCount:number};
  rows:TradingOperation[];
}
export type TradingOperationsSummary=TradingOperationSummary;

const kinds=new Set(['entry','close','manual-close','profit-exit','funding-exit','emergency-close']);
const protocols=new Set(['ioc','maker-ioc','maker','mixed','unknown']);
const states=new Set(['running','complete','partial','cancelled','failed','unknown']);
const interventionKinds=new Set(['user-retry','takeover','recovery','maintenance']);
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const nonnegative=(value:unknown):value is number=>finite(value)&&value>=0;
const clock=(value:unknown,now:number):value is number=>finite(value)&&value>0&&value<=now;
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const same=(a:number,b:number)=>a===0||b===0?a===b:Math.abs(a-b)<=64*Number.EPSILON*Math.max(Math.abs(a),Math.abs(b));
const quantities=(value:unknown):value is TradingOperationQuantities=>!!value&&typeof value==='object'&&
  ['long','short'].every(side=>{const item=(value as Record<string,unknown>)[side];return item===null||nonnegative(item);});

/** Nearest-rank percentiles; incomplete observations are counted, never assigned zero latency. */
export function tradingOperationSample(values:readonly (number|null)[]):TradingOperationSample {
  const known=values.filter(nonnegative).sort((a,b)=>a-b),total=known.reduce((sum,value)=>sum+value,0);
  const percentile=(p:number)=>known.length?known[Math.max(0,Math.ceil(known.length*p)-1)]:null;
  return {mean:known.length&&finite(total)?total/known.length:null,max:known.length?known[known.length-1]:null,
    p50:percentile(.5),p95:percentile(.95),knownCount:known.length,unknownCount:values.length-known.length};
}

function validShell(row:TradingOperation,now:number):boolean {
  return !!row&&row.version===1&&id(row.id)&&id(row.positionId)&&typeof row.base==='string'&&/^[A-Za-z0-9_.-]{1,40}$/.test(row.base)&&
    ['live','paper'].includes(row.mode)&&['automatic','manual'].includes(row.origin)&&kinds.has(row.kind)&&protocols.has(row.protocol)&&states.has(row.state)&&
    clock(row.startedAt,now)&&clock(row.updatedAt,now)&&row.updatedAt>=row.startedAt&&
    quantities(row.target)&&quantities(row.confirmed)&&quantities(row.remaining)&&!!row.stages&&typeof row.stages==='object'&&
    !!row.attempts&&['preflightNotSent','zeroFill','unknown','submitted'].every(key=>{
      const value=(row.attempts as unknown as Record<string,unknown>)[key];return nonnegative(value)&&Number.isSafeInteger(value);})&&
    (row.attempts.pending===undefined||nonnegative(row.attempts.pending)&&Number.isSafeInteger(row.attempts.pending));
}
function elapsed(row:TradingOperation,from:unknown,to:unknown,now:number):number|null {
  return clock(from,now)&&clock(to,now)&&from>=row.startedAt&&to>=from?to-from:null;
}
/** A status flag alone cannot manufacture successful execution or an independently verified flat account. */
export function tradingOperationCompleteEvidence(row:TradingOperation,now:number):boolean {
  if(!clock(row.endedAt,now)||row.endedAt<row.startedAt||row.endedAt>row.updatedAt||
    !clock(row.stages.accountConfirmedAt,now)||row.stages.accountConfirmedAt<row.startedAt||
    row.stages.accountConfirmedAt>row.endedAt||!clock(row.stages.pairedAt,now)||
    row.stages.pairedAt<row.startedAt||row.stages.pairedAt>row.stages.accountConfirmedAt||row.attempts.unknown>0||(row.attempts.pending??0)>0)return false;
  return ['long','short'].every(side=>{
    const key=side as keyof TradingOperationQuantities,target=row.target[key],confirmed=row.confirmed[key],remaining=row.remaining[key];
    return nonnegative(target)&&nonnegative(confirmed)&&remaining===0&&same(target,confirmed);
  })&&((row.target.long??0)>0||(row.target.short??0)>0);
}
function interventionKnown(row:TradingOperation,now:number):boolean {
  const proof=row.intervention;
  return row.origin==='automatic'&&!!proof&&interventionKinds.has(proof.kind)&&id(proof.evidenceId)&&
    clock(proof.requiredAt,now)&&proof.requiredAt>=row.startedAt;
}
function safeRow(source:TradingOperation,now:number):TradingOperation {
  const row=structuredClone(source);
  if(row.state==='complete'&&!tradingOperationCompleteEvidence(row,now)){row.state='unknown';delete row.endedAt;}
  if(['cancelled','failed'].includes(row.state)&&(!clock(row.endedAt,now)||row.endedAt<row.startedAt||row.endedAt>row.updatedAt)){
    row.state='unknown';delete row.endedAt;
  }
  return row;
}

/** Pure aggregation of locally recorded operations. No adapter calls, backfilled history, or execution permissions. */
export function summarizeTradingOperations(operations:readonly TradingOperation[],now=Date.now()):TradingOperationSummary {
  const observedAt=finite(now)&&now>0?now:Date.now(),unique=new Map<string,TradingOperation>();
  let invalid=0,duplicateIds=0;
  for(const source of operations){
    if(!validShell(source,observedAt)){invalid++;continue;}
    const prior=unique.get(source.id);
    if(prior){duplicateIds++;if(JSON.stringify(prior)!==JSON.stringify(source)){
      const conflict=structuredClone(prior);conflict.state='unknown';delete conflict.endedAt;
      conflict.waitReason={code:'duplicate-operation-evidence',text:'同一操作存在不同记录，等待核对'};unique.set(source.id,conflict);
    }continue;}
    unique.set(source.id,structuredClone(source));
  }
  const rows=[...unique.values()].map(row=>safeRow(row,observedAt)).sort((a,b)=>a.startedAt-b.startedAt||a.id.localeCompare(b.id));
  const counts:TradingOperationCounts={total:rows.length+invalid,complete:0,running:0,partial:0,cancelled:0,failed:0,unknown:invalid,
    automatic:0,manual:0,intervention:0,invalid,duplicateIds};
  for(const row of rows){counts[row.state]++;counts[row.origin]++;if(interventionKnown(row,observedAt))counts.intervention++;}
  const durations=(get:(row:TradingOperation)=>number|null)=>tradingOperationSample([...rows.map(get),...Array<number|null>(invalid).fill(null)]);
  const stage=(from:keyof TradingOperationStages,to:keyof TradingOperationStages)=>durations(row=>elapsed(row,row.stages[from],row.stages[to],observedAt));
  const pending=rows.filter(row=>['running','partial','unknown'].includes(row.state)&&!row.endedAt);
  const exposure=(key:'maxNotionalUsd'|'notionalTimeUsdMs'|'observedMs')=>durations(row=>row.exposure?.complete&&nonnegative(row.exposure[key])?row.exposure[key]:null);
  const completed=rows.filter(row=>row.state==='complete'),knownAmounts=completed.map(row=>row.netPnlUsd).filter(finite);
  const knownNetPnlUsd=knownAmounts.reduce((sum,value)=>sum+value,0),unknownAmounts=completed.length-knownAmounts.length;
  return {timestamp:observedAt,counts,completionRatePct:counts.total?100*counts.complete/counts.total:null,
    interventionRatePct:counts.automatic?100*counts.intervention/counts.automatic:null,
    timing:{totalMs:durations(row=>row.state==='complete'?elapsed(row,row.startedAt,row.endedAt,observedAt):null),
      preparationMs:stage('preparationStartedAt','preparationCompletedAt'),signalToSubmitMs:stage('signalObservedAt','submittedAt'),
      submitToAckMs:stage('submittedAt','acknowledgedAt'),ackToFirstFillMs:stage('acknowledgedAt','firstFillObservedAt'),
      firstFillToPairedMs:stage('firstFillObservedAt','pairedAt'),accountConfirmationMs:stage('pairedAt','accountConfirmedAt')},
    pendingAgeMs:tradingOperationSample([...pending.map(row=>observedAt-row.startedAt),...Array<number|null>(invalid).fill(null)]),
    exposure:{maxNotionalUsd:exposure('maxNotionalUsd'),notionalTimeUsdMs:exposure('notionalTimeUsdMs'),observedMs:exposure('observedMs')},
    amounts:{netPnlUsd:completed.length&&!unknownAmounts&&finite(knownNetPnlUsd)?knownNetPnlUsd:null,
      knownNetPnlUsd:finite(knownNetPnlUsd)?knownNetPnlUsd:0,knownCount:knownAmounts.length,unknownCount:unknownAmounts},rows};
}
