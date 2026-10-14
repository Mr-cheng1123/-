import type {AppConfig,JournalOrder,Position} from '../shared/types.js';
import type {PerformanceAmounts,PerformanceCategory,PerformanceRow,PerformanceSummary} from '../shared/performance-types.js';
import {summarizePerformanceRows} from '../shared/performance-aggregation.js';
import {conflictingNativeOrderReceipts,isTerminalOrderReceipt} from '../shared/order-receipt-validity.js';
import {estimateFeeRebateUsd} from '../shared/fee-rebates.js';
import {applyPerformanceException} from '../shared/performance-exceptions.js';

export {summarizePerformanceRows} from '../shared/performance-aggregation.js';
export type {PerformanceAmounts,PerformanceBucket,PerformanceCategory,PerformanceRow,PerformanceSummary} from '../shared/performance-types.js';

const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const positive=(value:unknown):value is number=>finite(value)&&value>0;
const nonnegative=(value:unknown):value is number=>finite(value)&&value>=0;
const nullable=(value:unknown):number|null=>finite(value)?value:null;
const tolerance=(quantity:number)=>Math.max(1e-10,Math.abs(quantity)*1e-8);
const equal=(a:number,b:number)=>Math.abs(a-b)<=Math.max(tolerance(a),tolerance(b));
const flat=(quantity:number)=>Math.abs(quantity)<=1e-10;

interface JournalEvidence {
  quantitiesKnown:boolean;pricesKnown:boolean;feesKnown:boolean;
  longQuantity:number;shortQuantity:number;everMatched:boolean;anyFill:boolean;
  feesUsd:number;cashUsd:number;estimatedFeeRebateUsd:number;
}

/** Each journal record holds one order's latest cumulative receipt: it is counted exactly once. */
function journalEvidence(position:Position,orders:JournalOrder[],conflicts:Set<JournalOrder>,config:Pick<AppConfig,'feeRebatePct'>):JournalEvidence {
  const evidence:JournalEvidence={quantitiesKnown:true,pricesKnown:true,feesKnown:true,
    longQuantity:0,shortQuantity:0,everMatched:false,anyFill:false,feesUsd:0,cashUsd:0,estimatedFeeRebateUsd:0};
  const receipts=new Set<string>();
  for(const order of orders.slice().sort((a,b)=>a.createdAt-b.createdAt)){
    const request=order.request,result=order.result;
    const legs=[position.long,position.short].filter(leg=>leg.exchange===order.exchange&&leg.symbol===request.symbol&&
      request.side===(leg.side==='long'?(request.reduceOnly?'sell':'buy'):(request.reduceOnly?'buy':'sell')));
    const receiptKey=`${order.exchange}:${request.clientOrderId}`;
    const identity=legs.length===1&&request.base===position.base&&positive(request.quantity)&&
      typeof request.clientOrderId==='string'&&request.clientOrderId.length>0&&!!result&&
      !conflicts.has(order)&&!receipts.has(receiptKey);
    receipts.add(receiptKey);
    const terminal=identity&&isTerminalOrderReceipt(request,result);
    if(!terminal){evidence.quantitiesKnown=false;evidence.pricesKnown=false;evidence.feesKnown=false;continue;}
    const quantity=result!.filledQuantity,leg=legs[0];
    if(finite(result!.feeUsd)){
      evidence.feesUsd+=result!.feeUsd;
      evidence.estimatedFeeRebateUsd+=estimateFeeRebateUsd(order.exchange,result!.feeUsd,config);
    }
    else evidence.feesKnown=false;
    if(quantity<=0)continue;
    evidence.anyFill=true;
    if(positive(result!.averagePrice)&&result!.averagePriceVerified!==false)
      evidence.cashUsd+=(request.side==='sell'?1:-1)*quantity*result!.averagePrice;
    else evidence.pricesKnown=false;
    const field=leg.side==='long'?'longQuantity':'shortQuantity';
    if(request.reduceOnly){
      if(!position.manualCloseAccountRecord&&quantity>evidence[field]+tolerance(evidence[field]))evidence.quantitiesKnown=false;
      evidence[field]-=quantity;
    }else evidence[field]+=quantity;
    if(flat(evidence[field]))evidence[field]=0;
    // Mere overlapping portions (e.g. 190 / 106 CT) never establish completed entry.
    if(evidence.longQuantity>1e-10&&evidence.shortQuantity>1e-10&&equal(evidence.longQuantity,evidence.shortQuantity))evidence.everMatched=true;
  }
  if(!finite(evidence.feesUsd))evidence.feesKnown=false;
  if(!finite(evidence.cashUsd))evidence.pricesKnown=false;
  return evidence;
}

function amounts(position:Position,evidence:JournalEvidence,closed:boolean):PerformanceAmounts {
  const fundingUsd=nullable(position.fundingUsd),feesUsd=evidence.feesKnown?nullable(evidence.feesUsd):null,
    transferCostUsd=nullable(position.transferCostUsd);
  let spreadPnlUsd:number|null=null;
  if(evidence.quantitiesKnown&&evidence.pricesKnown){
    if(closed)spreadPnlUsd=nullable(evidence.cashUsd);
    else if(nonnegative(position.long.quantity)&&nonnegative(position.short.quantity)&&
      equal(position.long.quantity,evidence.longQuantity)&&equal(position.short.quantity,evidence.shortQuantity)&&
      (flat(evidence.longQuantity)||positive(position.long.markPrice))&&(flat(evidence.shortQuantity)||positive(position.short.markPrice)))
      spreadPnlUsd=nullable(evidence.cashUsd+(flat(evidence.longQuantity)?0:evidence.longQuantity*position.long.markPrice)-
        (flat(evidence.shortQuantity)?0:evidence.shortQuantity*position.short.markPrice));
  }
  const netPnlUsd=[fundingUsd,feesUsd,spreadPnlUsd,transferCostUsd].every(value=>value!==null)?
    nullable(fundingUsd!+spreadPnlUsd!-feesUsd!-transferCostUsd!):null;
  const estimatedFeeRebateUsd=evidence.feesKnown?nullable(evidence.estimatedFeeRebateUsd):null;
  const estimatedNetPnlAfterRebateUsd=netPnlUsd===null||estimatedFeeRebateUsd===null?null:
    nullable(netPnlUsd+estimatedFeeRebateUsd);
  return {fundingUsd,feesUsd,spreadPnlUsd,transferCostUsd,netPnlUsd,estimatedFeeRebateUsd,estimatedNetPnlAfterRebateUsd};
}

function performanceRow(position:Position,orders:JournalOrder[],conflicts:Set<JournalOrder>,config:Pick<AppConfig,'feeRebatePct'>):PerformanceRow {
  const evidence=journalEvidence(position,orders,conflicts,config);
  const journalFlat=evidence.quantitiesKnown&&flat(evidence.longQuantity)&&flat(evidence.shortQuantity);
  const closed=(position.status==='closed'||!!position.accountClosure)&&journalFlat;
  let category:PerformanceCategory,reason:string;
  if(position.manualCloseAccountRecord){category='external';reason='独立账户减仓，缺少完整开仓历史，不归入策略生命周期';}
  else if(!nonnegative(position.long.quantity)||!nonnegative(position.short.quantity)){
    category='pending';reason='本地持仓数量无效，等待核对原生仓位和成交记录';}
  else if(!evidence.quantitiesKnown){category='pending';reason='订单身份、最终成交或剩余数量尚未完整确认';}
  else if(position.accountClosure&&!journalFlat){category='pending';reason='账户已空仓，但缺少完整平仓成交与费用记录';}
  else if(position.status==='closed'&&!journalFlat){category='pending';reason='平仓状态与确认成交流水不一致，等待核对';}
  else if(!orders.length&&(!flat(position.long.quantity)||!flat(position.short.quantity))){category='pending';reason='缺少原生开仓成交流水，不能确认策略结果';}
  else if(!evidence.anyFill){
    if(closed&&orders.length>0&&flat(position.long.quantity)&&flat(position.short.quantity)&&
      evidence.feesKnown&&evidence.pricesKnown&&position.fundingUsd===0&&position.realizedSpreadPnlUsd===0&&
      finite(position.transferCostUsd)&&(evidence.feesUsd!==0||position.transferCostUsd!==0)){
      category='abnormal';reason='未产生成交，原生终态已确认手续费或返佣，按异常执行现金统计';
    }else if(flat(position.long.quantity)&&flat(position.short.quantity)&&
      [position.fundingUsd,position.feesUsd,position.transferCostUsd,position.realizedSpreadPnlUsd,position.spreadPnlUsd,position.netPnlUsd]
      .every(value=>finite(value)&&flat(value))&&
      (!orders.length||evidence.feesKnown&&flat(evidence.feesUsd))){category='no_fill';reason='本次未确认任何成交，不计入交易收益和胜率';}
    else {category='pending';reason='未确认成交，但存在费用或现金记录，等待核对';}
  }else if(!closed&&(!equal(position.long.quantity,evidence.longQuantity)||!equal(position.short.quantity,evidence.shortQuantity))){
    category='pending';reason='本地剩余数量与确认成交流水不一致，等待核对';}
  else if(evidence.everMatched){category='normal';reason=closed?'双腿入场成功，开平成交已完整确认':'双腿入场成功，费用和后续损益按该笔策略统计';}
  else if(position.status==='opening'||position.status==='closing'){category='pending';reason='双腿仍在执行，尚未确认完整入场或撤回结果';}
  else {category='abnormal';reason=closed?'未形成匹配双腿，已确认撤回的执行损益':'未形成匹配双腿，异常执行或单腿敞口需单独核对';}

  let money=amounts(position,evidence,closed);
  if(category==='external')money={fundingUsd:null,feesUsd:evidence.feesKnown?nullable(evidence.feesUsd):null,
    spreadPnlUsd:evidence.quantitiesKnown&&evidence.pricesKnown?nullable(position.realizedSpreadPnlUsd):null,
    transferCostUsd:nullable(position.transferCostUsd),netPnlUsd:null,
    estimatedFeeRebateUsd:money.estimatedFeeRebateUsd,estimatedNetPnlAfterRebateUsd:null};
  if(category==='pending')money={...money,spreadPnlUsd:null,netPnlUsd:null,estimatedNetPnlAfterRebateUsd:null};
  // Recovered management flags and positive/negative PnL never alter the entry classification.
  const closedAt=position.closedAt??position.accountClosure?.confirmedAt;
  return applyPerformanceException({id:position.id,base:position.base,category,reason,closed,openedAt:position.openedAt,
    ...(positive(closedAt)?{closedAt}:{}),...money},position);
}

/** Read-only accounting projection. It cannot grant permission, submit a trade or mutate the ledger. */
export function performanceSummary(positions:Position[],orders:JournalOrder[],now=Date.now(),config:Pick<AppConfig,'feeRebatePct'>={}):PerformanceSummary {
  const grouped=new Map<string,JournalOrder[]>(),conflicts=conflictingNativeOrderReceipts(orders);
  for(const order of orders){if(!order||typeof order.positionId!=='string')continue;
    const rows=grouped.get(order.positionId)??[];rows.push(order);grouped.set(order.positionId,rows);}
  const rows=positions.map((position,index):PerformanceRow=>{
    try{return performanceRow(position,grouped.get(position.id)??[],conflicts,config);}
    catch{return {id:typeof position?.id==='string'?position.id:`incomplete-record-${index}`,
      base:typeof position?.base==='string'?position.base:'未知',category:'pending',reason:'旧记录缺少完整字段，等待账户与原生订单核对',
      closed:false,openedAt:positive(position?.openedAt)?position.openedAt:0,
      fundingUsd:nullable(position?.fundingUsd),feesUsd:null,spreadPnlUsd:null,
      transferCostUsd:nullable(position?.transferCostUsd),netPnlUsd:null,
      estimatedFeeRebateUsd:null,estimatedNetPnlAfterRebateUsd:null};}
  });
  return summarizePerformanceRows(rows,now);
}
