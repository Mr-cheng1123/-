import {EXCHANGES,type ExchangeId,type JournalOrder} from './types.js';
import {conflictingNativeOrderReceipts,hasBoundedOrderQuantity,hasOrderReceiptIdentity,isTerminalOrderReceipt,orderQuantityTolerance} from './order-receipt-validity.js';

export interface MakerCloseComparisonInput {
  timestamp:number;longOppositePrice:number;shortOppositePrice:number;
  /** Caller supplies actual native account Taker rates captured at submission, never local references. */
  longTakerFeeRate:number;shortTakerFeeRate:number;makerLeg:'long'|'short';originalOneLegNotionalUsd:number;
  peer?:{exchange:ExchangeId;symbol:string};
  /** User-confirmed rebate policy frozen for this submission, in percentage points. Never an actual cash receipt. */
  feeRebatePct?:{maker:number;peer:number};
}
export interface MakerCloseComparisonRecord {
  version:1;benchmark:'submission-opposite-1';timestamp:number|null;makerLeg:'long'|'short';
  longOppositePrice:number|null;shortOppositePrice:number|null;longTakerFeeRate:number|null;shortTakerFeeRate:number|null;
  originalOneLegNotionalUsd:number|null;peer?:{exchange:ExchangeId;symbol:string};
  updatedAt:number|null;status:'pending'|'paired'|'zero-fill';pairedComplete:boolean;quantitiesMatched:boolean;
  /** The full cash uses each leg's actual quantity, never prorates it down to this smaller matched quantity. */
  pairedQuantity:number|null;makerQuantity:number|null;peerQuantity:number|null;
  peerOrderCount:number;peerConfirmedOrderCount:number;peerPendingOrderCount:number;
  peerKnownQuantity:number|null;peerKnownCashUsd:number|null;peerKnownFeeUsd:number|null;
  makerActualCashUsd:number|null;makerActualFeeUsd:number|null;peerActualCashUsd:number|null;peerActualFeeUsd:number|null;
  makerBenchmarkCashUsd:number|null;makerBenchmarkFeeUsd:number|null;peerBenchmarkCashUsd:number|null;peerBenchmarkFeeUsd:number|null;
  makerPriceSavingUsd:number|null;makerFeeSavingUsd:number|null;makerTotalSavingUsd:number|null;
  peerPriceSavingUsd:number|null;peerFeeSavingUsd:number|null;peerTotalSavingUsd:number|null;
  /** Buy cash minus sell cash plus fees. A negative closing cost remains negative. */
  benchmarkPairCostUsd:number|null;actualPairCostUsd:number|null;pairTotalSavingUsd:number|null;pairTotalSavingBps:number|null;
  /** Absent on old batches. Recomputations use this original policy, never the current application config. */
  feeRebatePct?:{maker:number|null;peer:number|null};
  estimatedMakerRebateUsd?:number|null;estimatedPeerRebateUsd?:number|null;
  estimatedBenchmarkFeeRebateUsd?:number|null;estimatedActualFeeRebateUsd?:number|null;
  estimatedPairCostAfterRebateUsd?:number|null;estimatedBenchmarkPairCostAfterRebateUsd?:number|null;
  estimatedPairSavingAfterRebateUsd?:number|null;estimatedPairSavingAfterRebateBps?:number|null;
}
export interface MakerCloseComparisonRow extends MakerCloseComparisonRecord {
  batchId:string|null;positionId:string|null;base:string|null;makerExchange:ExchangeId|null;peerExchange:ExchangeId|null;
}
export interface MakerCloseComparisonReport {
  benchmark:'submission-opposite-1';label:string;
  counts:{total:number;confirmedPaired:number;pending:number;zeroFill:number;rebateEstimatedPaired?:number;rebateUnknownPaired?:number};
  totals:{pairedQuantity:number|null;makerPriceSavingUsd:number|null;makerFeeSavingUsd:number|null;makerTotalSavingUsd:number|null;
    peerPriceSavingUsd:number|null;peerFeeSavingUsd:number|null;pairTotalSavingUsd:number|null;
    benchmarkPairCostUsd:number|null;actualPairCostUsd:number|null;
    estimatedMakerRebateUsd?:number|null;estimatedPeerRebateUsd?:number|null;
    estimatedBenchmarkFeeRebateUsd?:number|null;estimatedActualFeeRebateUsd?:number|null;
    estimatedPairCostAfterRebateUsd?:number|null;estimatedBenchmarkPairCostAfterRebateUsd?:number|null;estimatedPairSavingAfterRebateUsd?:number|null};
  rows:MakerCloseComparisonRow[];
}
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const amount=(value:unknown):number|null=>finite(value)?value:null;
const positive=(value:unknown):number|null=>finite(value)&&value>0?value:null;
const rate=(value:unknown):number|null=>finite(value)&&value>=0&&value<=1?value:null;
const same=(a:number,b:number)=>Math.abs(a-b)<=Math.max(orderQuantityTolerance(a),orderQuantityTolerance(b));
function sum(values:readonly (number|null)[]):number|null {
  if(!values.every(finite))return null;
  // Compensation prevents many tiny peer fills from creating a false quantity mismatch or lost cash.
  let total=0,correction=0;
  for(const value of values as number[]){const adjusted=value-correction,next=total+adjusted;correction=(next-total)-adjusted;total=next;}
  return amount(total);
}
const product=(a:number|null,b:number|null)=>a!==null&&b!==null?amount(a*b):null;
const difference=(a:number|null,b:number|null)=>a!==null&&b!==null?amount(a-b):null;
const safeString=(value:unknown):string|null=>typeof value==='string'&&/^[A-Za-z0-9_./:-]{1,160}$/.test(value)?value:null;
const venue=(value:unknown):ExchangeId|null=>(EXCHANGES as readonly unknown[]).includes(value)?value as ExchangeId:null;
const rebatePercentage=(value:unknown):number|null=>finite(value)&&value>=0&&value<=100?value:null;
function rebatePolicy(value:unknown):{maker:number|null;peer:number|null} {
  const input=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
  return {maker:rebatePercentage(input.maker),peer:rebatePercentage(input.peer)};
}
const projectedRebate=(fee:number|null,percentage:number|null):number|null=>fee!==null&&percentage!==null?
  amount(Math.max(0,fee)*percentage/100):null;
const rebateFields=['estimatedMakerRebateUsd','estimatedPeerRebateUsd','estimatedBenchmarkFeeRebateUsd','estimatedActualFeeRebateUsd',
  'estimatedPairCostAfterRebateUsd','estimatedBenchmarkPairCostAfterRebateUsd','estimatedPairSavingAfterRebateUsd','estimatedPairSavingAfterRebateBps'] as const;
function initialRebateProjection(policy:unknown) {
  return {feeRebatePct:rebatePolicy(policy),estimatedMakerRebateUsd:null,estimatedPeerRebateUsd:null,
    estimatedBenchmarkFeeRebateUsd:null,estimatedActualFeeRebateUsd:null,estimatedPairCostAfterRebateUsd:null,
    estimatedBenchmarkPairCostAfterRebateUsd:null,estimatedPairSavingAfterRebateUsd:null,estimatedPairSavingAfterRebateBps:null};
}

/** Capture the static counterfactual before submission. Unknown inputs remain null, including unknown rates. */
export function createMakerCloseComparison(input:MakerCloseComparisonInput):MakerCloseComparisonRecord {
  return {version:1,benchmark:'submission-opposite-1',timestamp:positive(input.timestamp),makerLeg:input.makerLeg,
    longOppositePrice:positive(input.longOppositePrice),shortOppositePrice:positive(input.shortOppositePrice),
    longTakerFeeRate:rate(input.longTakerFeeRate),shortTakerFeeRate:rate(input.shortTakerFeeRate),
    originalOneLegNotionalUsd:positive(input.originalOneLegNotionalUsd),
    ...(input.peer&&venue(input.peer.exchange)&&safeString(input.peer.symbol)?{peer:{exchange:input.peer.exchange,symbol:input.peer.symbol}}:{}),
    ...(input.feeRebatePct!==undefined?initialRebateProjection(input.feeRebatePct):{}),
    updatedAt:null,status:'pending',pairedComplete:false,quantitiesMatched:false,pairedQuantity:null,
    makerQuantity:null,peerQuantity:null,peerOrderCount:0,peerConfirmedOrderCount:0,peerPendingOrderCount:0,
    peerKnownQuantity:null,peerKnownCashUsd:null,peerKnownFeeUsd:null,
    makerActualCashUsd:null,makerActualFeeUsd:null,peerActualCashUsd:null,peerActualFeeUsd:null,
    makerBenchmarkCashUsd:null,makerBenchmarkFeeUsd:null,peerBenchmarkCashUsd:null,peerBenchmarkFeeUsd:null,
    makerPriceSavingUsd:null,makerFeeSavingUsd:null,makerTotalSavingUsd:null,
    peerPriceSavingUsd:null,peerFeeSavingUsd:null,peerTotalSavingUsd:null,
    benchmarkPairCostUsd:null,actualPairCostUsd:null,pairTotalSavingUsd:null,pairTotalSavingBps:null};
}

interface Cash {quantity:number|null;cash:number|null;fee:number|null;terminal:boolean}
const unknownCash=():Cash=>({quantity:null,cash:null,fee:null,terminal:false});
/** A known lower bound in an unresolved peer IOC is not a confirmed/booked execution sample. */
function bookedCash(order:JournalOrder,maker:boolean,conflicted:boolean):Cash {
  const r=order.result,evidence=order.executionEvidence;
  if(conflicted||!r||!hasOrderReceiptIdentity(order.request,r)||!hasBoundedOrderQuantity(order.request,r)||
    !positive(r.timestamp)||!order.request.reduceOnly||evidence?.method!==(maker?'maker':'ioc'))return unknownCash();
  const nativeTerminal=isTerminalOrderReceipt(order.request,r),zero=nativeTerminal&&r.filledQuantity===0;
  if(maker?!order.makerReduction?.bookedExecution&&!zero:!nativeTerminal)return unknownCash();
  if(!maker&&!finite(evidence.bookedFeeUsd)&&!zero)return unknownCash();
  const quantity=r.filledQuantity;
  const cash=quantity===0?0:r.averagePriceVerified!==false&&positive(r.averagePrice)?amount(quantity*r.averagePrice):null;
  const fee=finite(r.feeUsd)&&finite(evidence.bookedFeeUsd)&&same(r.feeUsd,evidence.bookedFeeUsd)?r.feeUsd:
    zero&&r.feeUsd===0&&evidence.bookedFeeUsd===undefined?0:null;
  return {quantity,cash,fee,terminal:nativeTerminal&&(!maker||order.makerReduction?.activity==='terminal')};
}

function calculate(journal:JournalOrder,orders:readonly JournalOrder[],basis:MakerCloseComparisonRecord):MakerCloseComparisonRecord {
  const unique=[...new Set(orders)],conflicts=conflictingNativeOrderReceipts(unique),isLong=basis.makerLeg==='long';
  const validMaker=journal.request.reduceOnly&&journal.request.postOnly===true&&journal.request.side===(isLong?'sell':'buy')&&
    journal.makerReduction?.makerLeg===basis.makerLeg;
  const maker=validMaker?bookedCash(journal,true,conflicts.has(journal)):unknownCash();
  const rawRecoveredIds=journal.makerReduction?.recoveredPeers?.clientOrderIds;
  const recoveredIds=Array.isArray(rawRecoveredIds)?rawRecoveredIds:[];
  const recoveryComplete=(rawRecoveredIds===undefined||Array.isArray(rawRecoveredIds))&&new Set(recoveredIds).size===recoveredIds.length&&recoveredIds.every(id=>
    typeof id==='string'&&unique.filter(order=>order.request.clientOrderId===id).length===1);
  const linked=unique.filter(order=>order!==journal&&order.positionId===journal.positionId&&
    (order.executionEvidence?.makerCloseParentClientId===journal.request.clientOrderId||recoveredIds.includes(order.request.clientOrderId)));
  const identities=new Set(linked.map(order=>`${order.exchange}\n${order.request.symbol}`));
  const expected=basis.peer??(identities.size===1&&linked[0]?{exchange:linked[0].exchange,symbol:journal.request.symbol}:undefined);
  const peers=linked.map(order=>{
    const recovered=recoveredIds.includes(order.request.clientOrderId);
    const recoveryValid=!recovered||Number.isFinite(journal.makerReduction?.recoveredPeers?.verifiedAt)&&
      unique.filter(candidate=>candidate.request.clientOrderId===order.request.clientOrderId).length===1&&order.createdAt>=journal.createdAt&&
      ['exit','exit-tail'].includes(order.executionEvidence?.role??'')&&
      (!order.executionEvidence?.makerCloseParentClientId||order.executionEvidence.makerCloseParentClientId===journal.request.clientOrderId)&&
      !unique.some(other=>other!==journal&&(other.makerReduction?.recoveredPeers?.clientOrderIds.includes(order.request.clientOrderId)||
        other.request.clientOrderId===order.executionEvidence?.makerCloseParentClientId));
    const identity=expected&&order.exchange===expected.exchange&&order.exchange!==journal.exchange&&
      order.request.symbol===expected.symbol&&order.request.base===journal.request.base&&order.request.side===(isLong?'buy':'sell')&&
      order.request.reduceOnly&&order.request.postOnly!==true;
    return identity&&recoveryValid?bookedCash(order,false,conflicts.has(order)):unknownCash();
  });
  if(!recoveryComplete)peers.push(unknownCash());
  const peerQuantity=sum(peers.map(peer=>peer.quantity)),peerCash=sum(peers.map(peer=>peer.cash)),peerFee=sum(peers.map(peer=>peer.fee));
  const makerPrice=positive(isLong?basis.longOppositePrice:basis.shortOppositePrice),peerPrice=positive(isLong?basis.shortOppositePrice:basis.longOppositePrice);
  const makerRate=rate(isLong?basis.longTakerFeeRate:basis.shortTakerFeeRate),peerRate=rate(isLong?basis.shortTakerFeeRate:basis.longTakerFeeRate);
  const makerBenchmarkCash=product(maker.quantity,makerPrice),peerBenchmarkCash=product(peerQuantity,peerPrice),
    makerBenchmarkFee=product(makerBenchmarkCash,makerRate),peerBenchmarkFee=product(peerBenchmarkCash,peerRate);
  const makerPriceSaving=isLong?difference(maker.cash,makerBenchmarkCash):difference(makerBenchmarkCash,maker.cash),
    peerPriceSaving=isLong?difference(peerBenchmarkCash,peerCash):difference(peerCash,peerBenchmarkCash);
  const makerFeeSaving=difference(makerBenchmarkFee,maker.fee),peerFeeSaving=difference(peerBenchmarkFee,peerFee);
  const makerTotal=sum([makerPriceSaving,makerFeeSaving]),peerTotal=sum([peerPriceSaving,peerFeeSaving]),pairTotal=sum([makerTotal,peerTotal]);
  const benchmarkPairCost=sum([isLong?difference(peerBenchmarkCash,makerBenchmarkCash):difference(makerBenchmarkCash,peerBenchmarkCash),makerBenchmarkFee,peerBenchmarkFee]),
    actualPairCost=sum([isLong?difference(peerCash,maker.cash):difference(maker.cash,peerCash),maker.fee,peerFee]);
  const quantitiesMatched=maker.quantity!==null&&peerQuantity!==null&&same(maker.quantity,peerQuantity);
  const pairedComplete=maker.terminal&&maker.quantity!==null&&maker.quantity>0&&quantitiesMatched&&
    peers.every(peer=>peer.terminal)&&pairTotal!==null&&benchmarkPairCost!==null&&actualPairCost!==null;
  const zeroFill=maker.terminal&&maker.quantity===0&&peerQuantity===0&&peers.every(peer=>peer.terminal)&&maker.cash!==null&&maker.fee!==null&&peerCash!==null&&peerFee!==null;
  const observations=[basis.timestamp,journal.makerReduction?.lastObservedAt,journal.result?.timestamp,...linked.map(order=>order.result?.timestamp)].filter(finite);
  const denominator=positive(basis.originalOneLegNotionalUsd);
  let rebateProjection:Partial<MakerCloseComparisonRecord>={};
  if(basis.feeRebatePct!==undefined){
    const policy=rebatePolicy(basis.feeRebatePct);
    const estimatedMakerRebateUsd=projectedRebate(maker.fee,policy.maker),
      estimatedPeerRebateUsd=sum(peers.map(peer=>projectedRebate(peer.fee,policy.peer))),
      estimatedBenchmarkFeeRebateUsd=sum([projectedRebate(makerBenchmarkFee,policy.maker),projectedRebate(peerBenchmarkFee,policy.peer)]),
      estimatedActualFeeRebateUsd=sum([estimatedMakerRebateUsd,estimatedPeerRebateUsd]);
    const estimatedPairCostAfterRebateUsd=difference(actualPairCost,estimatedActualFeeRebateUsd),
      estimatedBenchmarkPairCostAfterRebateUsd=difference(benchmarkPairCost,estimatedBenchmarkFeeRebateUsd),
      estimatedPairSavingAfterRebateUsd=difference(estimatedBenchmarkPairCostAfterRebateUsd,estimatedPairCostAfterRebateUsd);
    rebateProjection={feeRebatePct:policy,estimatedMakerRebateUsd,estimatedPeerRebateUsd,estimatedBenchmarkFeeRebateUsd,
      estimatedActualFeeRebateUsd,estimatedPairCostAfterRebateUsd,estimatedBenchmarkPairCostAfterRebateUsd,estimatedPairSavingAfterRebateUsd,
      estimatedPairSavingAfterRebateBps:estimatedPairSavingAfterRebateUsd!==null&&denominator!==null?
        amount(estimatedPairSavingAfterRebateUsd/denominator*10_000):null};
  }
  return {...basis,updatedAt:observations.length?amount(Math.max(...observations)):null,status:pairedComplete?'paired':zeroFill?'zero-fill':'pending',
    pairedComplete,quantitiesMatched,pairedQuantity:maker.quantity!==null&&peerQuantity!==null?Math.min(maker.quantity,peerQuantity):null,
    makerQuantity:maker.quantity,peerQuantity,peerOrderCount:peers.length,
    peerConfirmedOrderCount:peers.filter(peer=>peer.terminal&&peer.quantity!==null&&peer.cash!==null&&peer.fee!==null).length,
    peerPendingOrderCount:peers.filter(peer=>!peer.terminal||peer.quantity===null||peer.cash===null||peer.fee===null).length,
    peerKnownQuantity:sum(peers.map(peer=>peer.quantity).filter(finite)),peerKnownCashUsd:sum(peers.map(peer=>peer.cash).filter(finite)),
    peerKnownFeeUsd:sum(peers.map(peer=>peer.fee).filter(finite)),
    makerActualCashUsd:maker.cash,makerActualFeeUsd:maker.fee,peerActualCashUsd:peerCash,peerActualFeeUsd:peerFee,
    makerBenchmarkCashUsd:makerBenchmarkCash,makerBenchmarkFeeUsd:makerBenchmarkFee,peerBenchmarkCashUsd:peerBenchmarkCash,peerBenchmarkFeeUsd:peerBenchmarkFee,
    makerPriceSavingUsd:makerPriceSaving,makerFeeSavingUsd:makerFeeSaving,makerTotalSavingUsd:makerTotal,
    peerPriceSavingUsd:peerPriceSaving,peerFeeSavingUsd:peerFeeSaving,peerTotalSavingUsd:peerTotal,
    benchmarkPairCostUsd:benchmarkPairCost,actualPairCostUsd:actualPairCost,pairTotalSavingUsd:pairTotal,
    pairTotalSavingBps:pairTotal!==null&&denominator!==null?amount(pairTotal/denominator*10_000):null,...rebateProjection};
}

/** Mutates only the original Maker's comparison record. Repeated cumulative observations never append samples. */
export function updateMakerCloseComparison(journal:JournalOrder,orders:readonly JournalOrder[]):void {
  const record=journal.makerCloseComparison;
  if(!record||record.version!==1||record.benchmark!=='submission-opposite-1')return;
  Object.assign(record,calculate(journal,orders,record));
}

const fields=['updatedAt',
  'pairedQuantity','makerQuantity','peerQuantity','peerKnownQuantity','peerKnownCashUsd','peerKnownFeeUsd',
  'makerActualCashUsd','makerActualFeeUsd','peerActualCashUsd','peerActualFeeUsd','makerBenchmarkCashUsd','makerBenchmarkFeeUsd',
  'peerBenchmarkCashUsd','peerBenchmarkFeeUsd','makerPriceSavingUsd','makerFeeSavingUsd','makerTotalSavingUsd',
  'peerPriceSavingUsd','peerFeeSavingUsd','peerTotalSavingUsd','benchmarkPairCostUsd','actualPairCostUsd','pairTotalSavingUsd','pairTotalSavingBps'] as const;

/** Read-only, whitelisted DTO. Only fully confirmed, paired batches contribute to the totals. */
export function makerCloseComparisonReport(orders:readonly JournalOrder[]):MakerCloseComparisonReport {
  const unique=[...new Set(orders)],rows:MakerCloseComparisonRow[]=[];
  for(const journal of unique){
    const stored=journal.makerCloseComparison;if(!stored||stored.version!==1||stored.benchmark!=='submission-opposite-1')continue;
    const record=calculate(journal,unique,stored),safe=createMakerCloseComparison({timestamp:record.timestamp??NaN,makerLeg:record.makerLeg,
      longOppositePrice:record.longOppositePrice??NaN,shortOppositePrice:record.shortOppositePrice??NaN,
      longTakerFeeRate:record.longTakerFeeRate??NaN,shortTakerFeeRate:record.shortTakerFeeRate??NaN,
      originalOneLegNotionalUsd:record.originalOneLegNotionalUsd??NaN,peer:record.peer,
      ...(record.feeRebatePct!==undefined?{feeRebatePct:{maker:record.feeRebatePct.maker??NaN,peer:record.feeRebatePct.peer??NaN}}:{})});
    for(const field of fields)safe[field]=amount(record[field]);
    if(record.feeRebatePct!==undefined)for(const field of rebateFields)safe[field]=amount(record[field]);
    Object.assign(safe,{status:record.status,pairedComplete:record.pairedComplete,quantitiesMatched:record.quantitiesMatched,
      peerOrderCount:record.peerOrderCount,peerConfirmedOrderCount:record.peerConfirmedOrderCount,peerPendingOrderCount:record.peerPendingOrderCount});
    const peerExchange=record.peer?.exchange??unique.find(order=>order.positionId===journal.positionId&&
      order.executionEvidence?.makerCloseParentClientId===journal.request.clientOrderId)?.exchange;
    rows.push({...safe,batchId:safeString(journal.executionEvidence?.batchId??journal.request.clientOrderId),
      positionId:safeString(journal.positionId),base:safeString(journal.request.base),makerExchange:venue(journal.exchange),peerExchange:venue(peerExchange)});
  }
  const paired=rows.filter(row=>row.pairedComplete),totalFields=['pairedQuantity','makerPriceSavingUsd','makerFeeSavingUsd','makerTotalSavingUsd',
    'peerPriceSavingUsd','peerFeeSavingUsd','pairTotalSavingUsd','benchmarkPairCostUsd','actualPairCostUsd'] as const;
  const totals={} as MakerCloseComparisonReport['totals'];for(const field of totalFields)totals[field]=sum(paired.map(row=>row[field]));
  const hasRebatePolicy=rows.some(row=>row.feeRebatePct!==undefined),estimatedPaired=paired.filter(row=>finite(row.estimatedPairSavingAfterRebateUsd)),
    policyPaired=paired.filter(row=>row.feeRebatePct!==undefined);
  if(hasRebatePolicy)for(const field of rebateFields.filter(field=>field!=='estimatedPairSavingAfterRebateBps'))
    totals[field]=sum(policyPaired.map(row=>amount(row[field])));
  return {benchmark:'submission-opposite-1',
    label:'提交时对手价1与当时账户 Taker 费率的静态基准，按实际成交量对比真实成交现金和已付费用；等待期间对侧价格变化计入正负节省，不保证同一时刻双 IOC 可实现相同成本。原成本与节省保留原扣费；返佣后成本和节省仅按该批提交时固定比例估算，尚未确认返佣到账，负原生费不重复返佣。汇总仅包含已确认完整配对批次，返佣后汇总只覆盖保存原返佣比例的批次，旧批次不补造比例。',
    counts:{total:rows.length,confirmedPaired:paired.length,pending:rows.filter(row=>row.status==='pending').length,zeroFill:rows.filter(row=>row.status==='zero-fill').length,
      ...(hasRebatePolicy?{rebateEstimatedPaired:estimatedPaired.length,rebateUnknownPaired:paired.length-estimatedPaired.length}:{})},totals,rows};
}
