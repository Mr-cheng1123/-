import type {JournalOrder,Position} from '../shared/types.js';
import type {PerformanceRow} from '../shared/performance-types.js';
import type {CompensationAlternative,CompensationComparisonEvidence,ExecutionFillEvidence,ExecutionPrediction,
  ExecutionStatisticsOrder,ExecutionStatisticsRow,ExecutionStatisticsSummary,OrderExecutionEvidence,PositionExecutionEvidence} from '../shared/execution-statistics.js';
import {summarizeExecutionStatisticsRows} from '../shared/execution-statistics.js';
import {performanceSummary} from './performance-summary.js';
import {conflictingNativeOrderReceipts,isTerminalOrderReceipt} from '../shared/order-receipt-validity.js';

export {summarizeExecutionStatisticsRows} from '../shared/execution-statistics.js';
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const positive=(value:unknown):value is number=>finite(value)&&value>0;
const nonnegative=(value:unknown):value is number=>finite(value)&&value>=0;
const nullable=(value:unknown):number|null=>finite(value)?value:null;
const equal=(left:number,right:number)=>Math.abs(left-right)<=Math.max(1e-10,Math.max(Math.abs(left),Math.abs(right))*1e-8);
const safeId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,120}$/.test(value);
const roles=new Set(['entry','hedge','entry-tail','exit','exit-tail']);

function positionEvidence(position:Position):PositionExecutionEvidence|undefined {
  const evidence=position.executionEvidence;
  return evidence?.version===1&&['ioc','maker-ioc'].includes(evidence.method)&&
    ['single-cycle','price-100','manual','legacy'].includes(evidence.entryPath)?evidence:undefined;
}
function orderEvidence(order:JournalOrder):OrderExecutionEvidence|undefined {
  const evidence=order.executionEvidence;
  return evidence?.version===1&&['ioc','maker'].includes(evidence.method)&&roles.has(evidence.role)&&safeId(evidence.batchId)?evidence:undefined;
}
function terminal(position:Position,order:JournalOrder):boolean {
  const request=order?.request,result=order?.result;if(!request||!result)return false;
  const legs=[position?.long,position?.short].filter(leg=>leg&&leg.exchange===order.exchange&&leg.symbol===request.symbol&&
    request.side===(leg.side==='long'?(request.reduceOnly?'sell':'buy'):(request.reduceOnly?'buy':'sell')));
  return legs.length===1&&request.base===position.base&&positive(request.quantity)&&safeId(request.clientOrderId)&&
    isTerminalOrderReceipt(request,result);
}
/** Duplicate execution events may be repeated, but conflicting or incomplete fills are not evidence. */
function identifiedFills(order:JournalOrder,quantity:number,now:number):ExecutionFillEvidence[]|undefined {
  const evidence=orderEvidence(order);if(!evidence?.fills?.length)return quantity===0?[]:undefined;
  const unique=new Map<string,ExecutionFillEvidence>();
  for(const fill of evidence.fills){
    if(!fill||!safeId(fill.execId)||!positive(fill.quantity)||!positive(fill.price)||!finite(fill.feeUsd)||
      !['maker','taker'].includes(fill.liquidity)||fill.feeCurrency!=='USDT'||!positive(fill.observedAt)||fill.observedAt>now||
      fill.observedAt<order.createdAt)return;
    const prior=unique.get(fill.execId);
    if(prior){if(prior.quantity!==fill.quantity||prior.price!==fill.price||prior.feeUsd!==fill.feeUsd||prior.liquidity!==fill.liquidity)return;}
    else unique.set(fill.execId,fill);
  }
  const fills=[...unique.values()],filled=fills.reduce((sum,fill)=>sum+fill.quantity,0);
  if(!equal(filled,quantity))return;
  const result=order.result!;
  if(quantity>0&&(!positive(result.averagePrice)||result.averagePriceVerified===false||
    !equal(fills.reduce((sum,fill)=>sum+fill.quantity*fill.price,0)/quantity,result.averagePrice)||
    !finite(result.feeUsd)||!equal(fills.reduce((sum,fill)=>sum+fill.feeUsd,0),result.feeUsd)))return;
  return fills;
}
function makerSaving(order:JournalOrder,valid:boolean,now:number):number|null {
  const evidence=orderEvidence(order),postOnly=(order.request as JournalOrder['request']&{postOnly?:boolean})?.postOnly===true;
  if(evidence?.method!=='maker'&&!postOnly)return 0;
  if(!evidence)return null;
  const result=order.result;if(!valid||!result||!finite(result.feeUsd))return null;
  if(result.filledQuantity===0)return 0;
  if(!positive(result.averagePrice)||result.averagePriceVerified===false||!nonnegative(evidence.nativeTakerFeeRate)||
    !positive(evidence.feeObservedAt)||evidence.feeObservedAt>order.createdAt)return null;
  const fills=identifiedFills(order,result.filledQuantity,now);
  // Dedicated adapters validate native PostOnly before returning terminal receipts. This proves maker
  // liquidity without manufacturing per-fill IDs or using it to invent an exposure clock.
  if(evidence.fills?.length&&(!fills||fills.some(fill=>fill.liquidity!=='maker')))return null;
  if(!postOnly&&(!fills||fills.some(fill=>fill.liquidity!=='maker')))return null;
  return nullable(result.filledQuantity*result.averagePrice*evidence.nativeTakerFeeRate-result.feeUsd);
}
function orderRow(position:Position,order:JournalOrder,index:number,now:number,conflicts:Set<JournalOrder>):ExecutionStatisticsOrder {
  const request=order?.request,result=order?.result,evidence=orderEvidence(order),valid=!conflicts.has(order)&&terminal(position,order);
  const quantity=valid?result!.filledQuantity:null;
  const averagePrice=valid&&positive(result!.averagePrice)&&result!.averagePriceVerified!==false?result!.averagePrice:null;
  const reference=positive(evidence?.referencePrice)&&positive(evidence?.referenceObservedAt)&&
    evidence!.referenceObservedAt!<=order.createdAt?evidence!.referencePrice!:null;
  const slippage=quantity===0?0:quantity!==null&&averagePrice!==null&&reference!==null?
    nullable(quantity*(request.side==='buy'?averagePrice-reference:reference-averagePrice)):null;
  const confirmedAt=positive(order.execution?.confirmedAt)&&order.execution!.confirmedAt!>=order.createdAt&&
    order.execution!.confirmedAt!<=now?order.execution!.confirmedAt!:null;
  return {key:`${order.exchange}:${request?.clientOrderId??`missing:${index}`}`,clientOrderId:request?.clientOrderId??'',
    nativeOrderId:typeof result?.id==='string'&&result.id.length?result.id:null,exchange:order.exchange,symbol:request?.symbol??'',
    side:request?.side==='sell'?'sell':'buy',reduceOnly:request?.reduceOnly===true,createdAt:positive(order.createdAt)?order.createdAt:0,
    status:result&&['filled','partial','cancelled','unknown'].includes(result.status)?result.status:'unknown',
    requestQuantity:nullable(request?.quantity),filledQuantity:quantity,limitPrice:nullable(request?.limitPrice),averagePrice,
    feeUsd:valid?nullable(result!.feeUsd):null,method:evidence?.method??(request?.postOnly?'maker':'ioc'),role:evidence?.role??null,batchId:evidence?.batchId??null,
    confirmedAt,confirmationMs:confirmedAt===null?null:confirmedAt-order.createdAt,
    submittedAt:positive(evidence?.submittedAt)&&evidence!.submittedAt!>=order.createdAt&&evidence!.submittedAt!<=now?evidence!.submittedAt!:null,
    bookObservedAt:positive(order.execution?.bookObservedAt)?order.execution!.bookObservedAt:null,
    quoteAgeMs:nonnegative(order.execution?.quoteAgeMs)?order.execution!.quoteAgeMs:null,
    referencePrice:reference,referenceObservedAt:reference!==null?evidence!.referenceObservedAt!:null,slippageUsd:slippage,
    slippageBps:slippage!==null&&positive(quantity)&&reference!==null?nullable(slippage/(quantity*reference)*10000):null,
    makerFeeSavingUsd:makerSaving(order,valid,now),
    ...(safeId(result?.rejectionCode)?{rejectionCode:result!.rejectionCode}:{}),};
}
function prediction(value:ExecutionPrediction|undefined):ExecutionPrediction|null {
  if(!value)return null;const copy:ExecutionPrediction={};
  for(const key of ['fundingUsd','singleCycleNetUsd','rawOppositeEdgeBps','makerFeeSavingUsd'] as const)
    if(finite(value[key]))copy[key]=value[key];
  return Object.keys(copy).length?copy:null;
}
function alternative(value:CompensationAlternative|undefined):CompensationAlternative|undefined {
  if(!value||!positive(value.quantity)||!positive(value.limitPrice)||!finite(value.pricePnlUsd)||!finite(value.feesUsd)||!finite(value.costUsd))return;
  const copy:CompensationAlternative={quantity:value.quantity,limitPrice:value.limitPrice,pricePnlUsd:value.pricePnlUsd,feesUsd:value.feesUsd,costUsd:value.costUsd};
  if(finite(value.predictedFundingUsd))copy.predictedFundingUsd=value.predictedFundingUsd;
  if(value.basis==='current-book-at-cycle-end'||value.basis==='immediate-rollback')copy.basis=value.basis;
  if(positive(value.longClosePrice))copy.longClosePrice=value.longClosePrice;
  if(positive(value.shortClosePrice))copy.shortClosePrice=value.shortClosePrice;
  return copy;
}
function comparisons(value:CompensationComparisonEvidence[]|undefined):CompensationComparisonEvidence[]{
  if(!Array.isArray(value))return [];
  return value.filter(row=>row&&positive(row.observedAt)&&safeId(row.batchId)&&['long','short'].includes(row.unmatchedSide)&&
    positive(row.unmatchedQuantity)&&['hedge','rollback','wait'].includes(row.decision)).map(row=>({observedAt:row.observedAt,
      batchId:row.batchId,unmatchedSide:row.unmatchedSide,unmatchedQuantity:row.unmatchedQuantity,
      ...(alternative(row.hedge)?{hedge:alternative(row.hedge)}:{}),...(alternative(row.rollback)?{rollback:alternative(row.rollback)}:{}),decision:row.decision,
      ...(positive(row.projectionUntil)?{projectionUntil:row.projectionUntil}:{}),
      ...(positive(row.longBookObservedAt)?{longBookObservedAt:row.longBookObservedAt}:{}),
      ...(positive(row.shortBookObservedAt)?{shortBookObservedAt:row.shortBookObservedAt}:{}),
      ...(nonnegative(row.longTakerFeeRate)?{longTakerFeeRate:row.longTakerFeeRate}:{}),
      ...(nonnegative(row.shortTakerFeeRate)?{shortTakerFeeRate:row.shortTakerFeeRate}:{}),
      ...(row.constraint&&['retry-budget','explicit-rejection','no-supported-hedge','no-fresh-refresh','validation-failed'].includes(row.constraint)?{constraint:row.constraint}:{}),
      ...(row.outcome&&['hedged','rollback','unresolved'].includes(row.outcome)?{outcome:row.outcome}:{}),
      ...(nonnegative(row.hedgeFilledQuantity)?{hedgeFilledQuantity:row.hedgeFilledQuantity}:{}),
      ...(nonnegative(row.reducedLongQuantity)?{reducedLongQuantity:row.reducedLongQuantity}:{}),
      ...(nonnegative(row.reducedShortQuantity)?{reducedShortQuantity:row.reducedShortQuantity}:{})}));
}
function sum(values:Array<number|null>):number|null {return values.every(finite)?nullable(values.reduce<number>((total,value)=>total+value!,0)):null;}

/** Exact failed-entry costs are recoverable without quote/timing evidence. Never infer tail basis from old profitable batches. */
function rollbackCost(position:Position,raw:JournalOrder[],orders:ExecutionStatisticsOrder[],performance:PerformanceRow):number|null {
  if(performance.category==='no_fill')return 0;
  if(performance.category==='pending'||performance.category==='external')return null;
  if(performance.category==='abnormal'&&performance.closed)
    return finite(performance.feesUsd)&&finite(performance.spreadPnlUsd)?nullable(performance.feesUsd-performance.spreadPnlUsd):null;
  type Lot={quantity:number;price:number;feePerCoin:number;batchId:string|null};
  const lots:{long:Lot[];short:Lot[]}={long:[],short:[]},quantity={long:0,short:0};
  let cost=0,closing=false;
  for(let index=0;index<raw.length;index++){
    const order=raw[index],row=orders[index];if(row.filledQuantity===null||row.feeUsd===null)return null;
    const filled=row.filledQuantity;if(filled===0)continue;if(row.averagePrice===null)return null;
    const side=order.exchange===position.long.exchange&&order.request.symbol===position.long.symbol&&
      order.request.side===(order.request.reduceOnly?'sell':'buy')?'long':'short',other=side==='long'?'short':'long';
    if(!row.reduceOnly){lots[side].push({quantity:filled,price:row.averagePrice,feePerCoin:row.feeUsd/filled,batchId:row.batchId});quantity[side]+=filled;continue;}
    const explicitTail=row.role==='entry-tail',explicitExit=row.role==='exit'||row.role==='exit-tail';
    const afterClose=positive(position.closeRequestedAt)&&row.createdAt>=position.closeRequestedAt;
    if(!explicitTail&&(explicitExit||afterClose||equal(quantity.long,quantity.short)))closing=true;
    const tail=explicitTail?filled:closing?0:Math.min(filled,Math.max(0,quantity[side]-quantity[other]));
    let remaining=filled,tailRemaining=tail;
    if(tail>0){
      const selected=explicitTail&&row.batchId!==null?lots[side].filter(lot=>lot.batchId===row.batchId):lots[side];
      if(!selected.length||selected.reduce((total,lot)=>total+lot.quantity,0)<tail-1e-10)return null;
      // Unlabelled multi-batch history cannot establish which filled cost basis the compensation removed.
      if(!explicitTail&&selected.some(lot=>!equal(lot.price,selected[0].price)||!equal(lot.feePerCoin,selected[0].feePerCoin)))return null;
      for(const lot of [...selected].reverse()){
        const used=Math.min(tailRemaining,lot.quantity);if(used<=0)continue;
        const pnl=used*(row.averagePrice-lot.price)*(side==='long'?1:-1);
        cost+=used*lot.feePerCoin+used*row.feeUsd/filled-pnl;lot.quantity-=used;tailRemaining-=used;remaining-=used;
        if(tailRemaining<=1e-10)break;
      }
      if(tailRemaining>1e-10)return null;
    }
    for(const lot of lots[side]){const used=Math.min(remaining,lot.quantity);lot.quantity-=used;remaining-=used;if(remaining<=1e-10)break;}
    if(remaining>1e-10)return null;
    lots[side]=lots[side].filter(lot=>lot.quantity>1e-10);quantity[side]-=filled;
  }
  return nullable(cost);
}
function exposure(position:Position,raw:JournalOrder[],orders:ExecutionStatisticsOrder[],now:number):{total:number;longest:number}|null {
  const events:Array<{at:number;side:'long'|'short';quantity:number}>=[],seen=new Map<string,string>();
  for(let index=0;index<raw.length;index++){
    const order=raw[index],row=orders[index];if(row.filledQuantity===null)return null;
    if(row.filledQuantity===0)continue;
    const fills=identifiedFills(order,row.filledQuantity,now);if(!fills)return null;
    const side=order.exchange===position.long.exchange&&order.request.symbol===position.long.symbol&&
      order.request.side===(order.request.reduceOnly?'sell':'buy')?'long':'short';
    for(const fill of fills){const id=`${order.exchange}:${fill.execId}`;
      if(seen.has(id)&&seen.get(id)!==row.clientOrderId)return null;seen.set(id,row.clientOrderId);
      events.push({at:fill.observedAt,side,quantity:fill.quantity*(row.reduceOnly?-1:1)});}
  }
  if(!events.length)return null;
  events.sort((left,right)=>left.at-right.at);let long=0,short=0,last=events[0].at,episode=0,total=0,longest=0;
  for(let index=0;index<events.length;){
    const at=events[index].at;if(!equal(long,short)){const elapsed=at-last;episode+=elapsed;total+=elapsed;}else episode=0;
    while(index<events.length&&events[index].at===at){const event=events[index++];if(event.side==='long')long+=event.quantity;else short+=event.quantity;}
    if(long<-1e-10||short<-1e-10)return null;
    longest=Math.max(longest,episode);if(equal(long,short))episode=0;last=at;
  }
  if(!equal(long,short)){if(position.status==='closed'||position.accountClosure)return null;const elapsed=now-last;episode+=elapsed;total+=elapsed;longest=Math.max(longest,episode);}
  return {total,longest};
}
function row(position:Position,raw:JournalOrder[],performance:PerformanceRow,now:number,conflicts:Set<JournalOrder>):ExecutionStatisticsRow {
  const evidence=positionEvidence(position),ordered=raw.slice().sort((left,right)=>left.createdAt-right.createdAt);
  const orders=ordered.map((order,index)=>orderRow(position,order,index,now,conflicts));
  const duplicates=new Set<string>();for(const order of orders){const key=`${order.exchange}:${order.clientOrderId}`;
    if(duplicates.has(key)){for(const entry of orders.filter(entry=>`${entry.exchange}:${entry.clientOrderId}`===key)){
      entry.filledQuantity=null;entry.averagePrice=null;entry.feeUsd=null;entry.slippageUsd=null;entry.slippageBps=null;entry.makerFeeSavingUsd=null;}}
    duplicates.add(key);}
  const executionOwners=new Map<string,number>();
  for(let index=0;index<ordered.length;index++)for(const fill of orderEvidence(ordered[index])?.fills??[]){
    const key=`${ordered[index].exchange}:${fill.execId}`,prior=executionOwners.get(key);
    if(prior!==undefined&&prior!==index){orders[prior].makerFeeSavingUsd=null;orders[index].makerFeeSavingUsd=null;}
    else executionOwners.set(key,index);
  }
  const duplicateKeys=new Map<string,number>();for(const order of orders){const count=duplicateKeys.get(order.key)??0;duplicateKeys.set(order.key,count+1);}
  for(let index=0;index<orders.length;index++)if((duplicateKeys.get(orders[index].key)??0)>1)orders[index].key+=`:duplicate:${index}`;
  const left=orders.find(order=>!order.reduceOnly&&positive(order.filledQuantity)&&order.exchange===position.long?.exchange),
    right=orders.find(order=>!order.reduceOnly&&positive(order.filledQuantity)&&order.exchange===position.short?.exchange);
  const outbound=!!left&&!!right&&left.submittedAt!==null&&right.submittedAt!==null;
  const submission=left&&right?Math.abs((outbound?left.submittedAt!:left.createdAt)-(outbound?right.submittedAt!:right.createdAt)):null;
  const confirmation=left&&right&&left.confirmedAt!==null&&right.confirmedAt!==null?Math.abs(left.confirmedAt-right.confirmedAt):null;
  const observed=position.long&&position.short?exposure(position,ordered,orders,now):null;
  const slipped=sum(orders.map(order=>order.slippageUsd)),slippageReference=sum(orders.filter(order=>positive(order.filledQuantity))
    .map(order=>order.referencePrice!==null?order.filledQuantity!*order.referencePrice:null));
  return {id:performance.id,base:performance.base,mode:position.mode==='paper'?'paper':'live',
    method:evidence?.method??(orders.some(order=>order.method==='maker')?'maker-ioc':'ioc'),entryPath:evidence?.entryPath??'legacy',
    methodSource:evidence||orders.some(order=>order.method==='maker')?'recorded':'legacy-ioc',pathSource:evidence?'recorded':'legacy',
    status:performance.category==='normal'?'hedged':performance.category==='no_fill'?'no-fill':performance.category,
    reason:performance.reason,closed:performance.closed,closeRecorded:position.status==='closed'||!!position.accountClosure,
    openedAt:performance.openedAt,closedAt:performance.closedAt??null,longExchange:position.long?.exchange??null,shortExchange:position.short?.exchange??null,
    longQuantity:nullable(position.long?.quantity),shortQuantity:nullable(position.short?.quantity),
    amounts:{fundingUsd:performance.fundingUsd,feesUsd:performance.feesUsd,spreadPnlUsd:performance.spreadPnlUsd,transferCostUsd:performance.transferCostUsd,
      closedNetPnlUsd:performance.closed&&performance.category!=='external'?performance.netPnlUsd:null,
      rollbackCostUsd:rollbackCost(position,ordered,orders,performance),makerFeeSavingUsd:sum(orders.map(order=>order.makerFeeSavingUsd))},
    prediction:prediction(evidence?.prediction),timing:{firstLegSubmissionGapMs:submission,firstLegConfirmationGapMs:confirmation,
      unhedgedObservedMs:observed?.total??null,longestUnhedgedObservedMs:observed?.longest??null},
    timingBasis:{submission:submission===null?'unknown':outbound?'outbound':'journal-intent',confirmation:confirmation===null?'unknown':'local-confirmation',
      exposure:observed?'identified-fills':'unknown'},slippageUsd:slipped,
    slippageBps:slipped!==null&&positive(slippageReference)?nullable(slipped/slippageReference*10000):null,
    compensations:comparisons(evidence?.compensations),orders};
}

/** Only reads persisted strategy and order evidence. No adapter, account, permission or financial action is involved. */
export function executionStatistics(positions:Position[],orders:JournalOrder[],now=Date.now()):ExecutionStatisticsSummary {
  const performance=performanceSummary(positions,orders,now),grouped=new Map<string,JournalOrder[]>(),conflicts=conflictingNativeOrderReceipts(orders);
  for(const order of orders){if(!order||typeof order.positionId!=='string')continue;const group=grouped.get(order.positionId)??[];group.push(order);grouped.set(order.positionId,group);}
  const rows=positions.map((position,index)=>{
    const perf=performance.rows[index];
    try{return row(position,grouped.get(position.id)??[],perf,now,conflicts);}
    catch{return {id:perf.id,base:perf.base,mode:position?.mode==='paper'?'paper':'live',method:'ioc',entryPath:'legacy',methodSource:'legacy-ioc',pathSource:'legacy',
      status:'pending',reason:'旧执行记录缺少完整字段，实际成本和时延待核对',closed:false,closeRecorded:position?.status==='closed'||!!position?.accountClosure,
      openedAt:perf.openedAt,closedAt:null,longExchange:null,shortExchange:null,longQuantity:null,shortQuantity:null,
      amounts:{fundingUsd:perf.fundingUsd,feesUsd:null,spreadPnlUsd:null,transferCostUsd:perf.transferCostUsd,closedNetPnlUsd:null,rollbackCostUsd:null,makerFeeSavingUsd:null},
      prediction:null,timing:{firstLegSubmissionGapMs:null,firstLegConfirmationGapMs:null,unhedgedObservedMs:null,longestUnhedgedObservedMs:null},
      slippageUsd:null,slippageBps:null,compensations:[],orders:[]} as ExecutionStatisticsRow;}
  });
  return summarizeExecutionStatisticsRows(rows,now);
}
