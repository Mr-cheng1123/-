import type {ExchangeId,FundingPayment,JournalOrder,Position,PositionLeg} from '../shared/types.js';
import {isPositionActive,isCurrentUnconfirmedOrder} from '../shared/ledger-lifecycle.js';
import {conflictingNativeOrderReceipts,isTerminalOrderReceipt,orderQuantityTolerance} from '../shared/order-receipt-validity.js';
import {coinBase} from './coin-exclusions.js';

export interface FundingOwner {position:Position;leg:PositionLeg;
  /** Ownership bounds only; neither endpoint proves an unknown order's execution quantity. */
  quantityRange?:{minimum:number;maximum:number;unknownClientOrderIds:string[]}}

/** A flat-account proof ends this cycle even if its historical order quantities remain non-zero. */
export function fundingWindowEnd(position:Position):number|undefined {
  const ends=[position.closedAt,position.accountClosure?.confirmedAt].filter((value):value is number=>value!==undefined);
  if(!ends.length)return;
  if(ends.some(value=>!Number.isFinite(value)||value<position.openedAt))return NaN;
  return Math.min(...ends);
}

/** Recent closed/archived cycles stay readable for delayed invoices, without querying every old cycle forever. */
export function fundingRecordsForRead(positions:readonly Position[],now=Date.now()):Position[] {
  return positions.filter(position=>position.mode==='live'&&(isPositionActive(position)||(fundingWindowEnd(position)??0)>=now-24*3_600_000));
}

/** A receipt belongs to a confirmed quantity held at settlement, rather than any same-ticker record.
 * Pending/late cumulative execution reports cannot prove the quantity at an earlier settlement.
 * Returning undefined leaves the receipt unconsumed so a later complete GET observation can retry it. */
function settlementQuantity(position:Position,leg:PositionLeg,orders:readonly JournalOrder[],timestamp:number,conflicts:Set<JournalOrder>):number|undefined {
  const history=orders.filter(order=>order.positionId===position.id&&order.exchange===leg.exchange&&order.request.symbol===leg.symbol);
  if(!history.length)return !position.accountClosure&&Number.isFinite(leg.quantity)&&leg.quantity>0?leg.quantity:undefined;
  let quantity=0;
  if(history.some(order=>!Number.isFinite(order.createdAt)||order.createdAt<=0))return;
  for(const order of history.slice().sort((a,b)=>a.createdAt-b.createdAt)){
    if(order.createdAt>timestamp)continue;
    const result=order.result;
    const expectedSide=leg.side==='long'?(order.request.reduceOnly?'sell':'buy'):(order.request.reduceOnly?'buy':'sell');
    if(conflicts.has(order)||order.request.base!==position.base||order.request.side!==expectedSide||
      !isTerminalOrderReceipt(order.request,result)||!Number.isFinite(result!.timestamp)||result!.timestamp<=0)
      return;
    if(result!.filledQuantity===0)continue;
    if(result!.timestamp>timestamp)return;
    quantity+=result!.filledQuantity*(order.request.reduceOnly?-1:1);
    if(quantity<-orderQuantityTolerance(order.request.quantity))return;
  }
  return Number.isFinite(quantity)&&quantity>1e-12?quantity:undefined;
}

/** A native invoice with authorized quantity uncertainty needs one possible lifecycle. */
function hasUniqueFundingWindow(positions:readonly Position[],position:Position,leg:PositionLeg,payment:FundingPayment):boolean {
  if(positions.filter(other=>other.id===position.id).length!==1)return false;
  let candidates=0;
  for(const other of positions){
    if(other.mode!=='live'||other.base!==payment.base)continue;
    const matching=[other.long,other.short].filter(candidate=>candidate.exchange===leg.exchange&&candidate.symbol===payment.symbol&&
      (payment.side===undefined||candidate.side===payment.side));
    if(!matching.length)continue;
    const end=fundingWindowEnd(other);
    if(!Number.isFinite(other.openedAt)||other.openedAt<=0||end!==undefined&&!Number.isFinite(end))return false;
    if(other.openedAt>=payment.timestamp||end!==undefined&&end<payment.timestamp)continue;
    candidates+=matching.length;
  }
  return candidates===1;
}

function isAuthorizedUnknownReduction(position:Position,leg:PositionLeg,order:JournalOrder,orders:readonly JournalOrder[],
  authorized:ReadonlySet<JournalOrder>,conflicts:Set<JournalOrder>):boolean {
  const result=order.result,request=order.request,evidence=order.executionEvidence;
  if(!authorized.has(order)||orders.filter(other=>other.request.clientOrderId===request.clientOrderId).length!==1||
    order.positionId!==position.id||order.exchange!==leg.exchange||request.base!==position.base||request.symbol!==leg.symbol||
    request.reduceOnly!==true||request.postOnly===true||request.closePosition!==undefined||
    request.side!==(leg.side==='long'?'sell':'buy')||!request.clientOrderId?.trim()||
    !Number.isFinite(request.quantity)||request.quantity<=0||!Number.isFinite(request.limitPrice)||request.limitPrice<=0||
    order.createdAt<position.openedAt||order.makerReduction||evidence?.method!=='ioc'||evidence.role!=='exit-tail'||
    !evidence.makerCloseParentClientId||evidence.bookedFeeUsd!==0||result?.status!=='unknown'||result.id!==''||
    result.clientOrderId!==request.clientOrderId||result.filledQuantity!==0||result.averagePrice!==0||result.feeUsd!==0||
    !Number.isFinite(result.timestamp)||result.timestamp<=0)return false;
  const parents=orders.filter(parent=>parent.request.clientOrderId===evidence.makerCloseParentClientId),parent=parents[0];
  const peer=position[leg.side==='long'?'short':'long'];
  return parents.length===1&&!conflicts.has(parent)&&parent.positionId===position.id&&parent.exchange===peer.exchange&&
    parent.request.base===position.base&&parent.request.symbol===peer.symbol&&parent.request.side===(peer.side==='long'?'sell':'buy')&&
    Number.isFinite(parent.createdAt)&&parent.createdAt>=position.openedAt&&parent.createdAt<=order.createdAt&&
    parent.request.reduceOnly===true&&parent.request.postOnly===true&&parent.request.closePosition===undefined&&
    parent.makerReduction?.makerLeg===peer.side&&parent.makerReduction.activity==='terminal'&&parent.makerReduction.bookedExecution===true&&
    parent.executionEvidence?.method==='maker'&&parent.executionEvidence.role==='exit'&&
    !!parent.result?.id&&parent.result.id!==parent.request.clientOrderId&&parent.result.averagePriceVerified===true&&
    parent.result.filledQuantity>0&&Number.isFinite(parent.result.averagePrice)&&parent.result.averagePrice>0&&
    Number.isFinite(parent.result.timestamp)&&parent.result.timestamp>0&&
    Number.isFinite(parent.result.feeUsd)&&parent.executionEvidence.bookedFeeUsd===parent.result.feeUsd&&
    isTerminalOrderReceipt(parent.request,parent.result);
}

/** Actual invoice cash can belong to one continuously held cycle without asserting an exact settlement quantity.
 * Only the caller's currently authorized original unknown reductions may widen the quantity interval. */
function boundedSettlementOwnership(positions:readonly Position[],position:Position,leg:PositionLeg,orders:readonly JournalOrder[],
  payment:FundingPayment,conflicts:Set<JournalOrder>,authorized:ReadonlySet<JournalOrder>):FundingOwner['quantityRange']|undefined {
  if(payment.symbol!==leg.symbol||!isPositionActive(position)||position.closedAt!==undefined||
    position.accountClosure||position.manualCloseOnly||position.manualCloseAccountRecord||
    !hasUniqueFundingWindow(positions,position,leg,payment))return;
  const currentPositions=[...positions];
  if(orders.some(order=>{
    if(!isCurrentUnconfirmedOrder(order,currentPositions))return false;
    const base=coinBase(order.request?.base)??coinBase(positions.find(other=>other.id===order.positionId)?.base);
    if(order.positionId!==position.id&&base&&base!==coinBase(position.base)&&
      ![position.long,position.short].some(candidate=>candidate.exchange===order.exchange&&candidate.symbol===order.request?.symbol))return false;
    const originalLeg=[position.long,position.short].find(candidate=>candidate.exchange===order.exchange&&candidate.symbol===order.request?.symbol);
    return !originalLeg||!isAuthorizedUnknownReduction(position,originalLeg,order,orders,authorized,conflicts);
  }))return;
  const history=orders.filter(order=>order.positionId===position.id&&order.exchange===leg.exchange&&order.request.symbol===leg.symbol);
  if(!history.length||history.some(order=>!Number.isFinite(order.createdAt)||order.createdAt<position.openedAt))return;
  const relevantHistory=history.filter(order=>order.createdAt<=payment.timestamp);
  const firstReductionAt=Math.min(...relevantHistory.filter(order=>order.request.reduceOnly&&
    (order.result?.status==='unknown'||(order.result?.filledQuantity??0)>0)).map(order=>order.createdAt));
  // A native order timestamp may be its creation clock. Only a retained local full confirmation can
  // establish the latest opening time; conservatively reject additions completed after reduction began.
  if(relevantHistory.some(order=>!order.request.reduceOnly&&(order.result?.filledQuantity??0)>0&&
    (!Number.isFinite(order.execution?.confirmedAt)||order.execution!.confirmedAt!<order.createdAt||
      Math.max(order.result!.timestamp,order.execution!.confirmedAt!)>=firstReductionAt)))return;
  let minimum=0,maximum=0,held=false;
  const unknownClientOrderIds:string[]=[];
  for(const order of history.slice().sort((a,b)=>a.createdAt-b.createdAt)){
    if(order.createdAt>payment.timestamp)continue;
    const result=order.result,expectedSide=leg.side==='long'?(order.request.reduceOnly?'sell':'buy'):(order.request.reduceOnly?'buy':'sell');
    if(conflicts.has(order)||order.request.base!==position.base||order.request.side!==expectedSide)return;
    if(result?.status==='unknown'){
      if(!isAuthorizedUnknownReduction(position,leg,order,orders,authorized,conflicts))return;
      minimum-=order.request.quantity;unknownClientOrderIds.push(order.request.clientOrderId);
    }else{
      if(!isTerminalOrderReceipt(order.request,result)||!Number.isFinite(result!.timestamp)||result!.timestamp<=0)return;
      if(result!.filledQuantity===0)continue;
      if(result!.timestamp>payment.timestamp)return;
      const delta=result!.filledQuantity*(order.request.reduceOnly?-1:1);minimum+=delta;maximum+=delta;
    }
    // Once exposure exists, a possible flat/reopened cycle cannot own this invoice through these bounds.
    if(!Number.isFinite(minimum)||!Number.isFinite(maximum)||minimum<=1e-12||maximum<minimum)return;
    held=true;
  }
  if(!held||!unknownClientOrderIds.length)return;
  // The native funding quantity may corroborate this continuously held cycle. It never
  // establishes an unknown reduction's fill, fee, price, or exact settlement exposure.
  if(payment.quantity!==undefined&&(payment.quantity<minimum-Math.max(1e-8,minimum*1e-8)||
    payment.quantity>maximum+Math.max(1e-8,maximum*1e-8)))return;
  return {minimum,maximum,unknownClientOrderIds};
}

export function findFundingOwner(positions:readonly Position[],orders:readonly JournalOrder[],exchange:ExchangeId,payment:FundingPayment,
  authorizedUnknownReductions?:ReadonlySet<JournalOrder>):FundingOwner|undefined {
  if(typeof payment.id!=='string'||!payment.id.trim()||typeof payment.base!=='string'||!payment.base||
    !Number.isFinite(payment.timestamp)||payment.timestamp<=0||!Number.isFinite(payment.amountUsd)||
    payment.quantity!==undefined&&!(Number.isFinite(payment.quantity)&&payment.quantity>0))return;
  const matches:FundingOwner[]=[],conflicts=conflictingNativeOrderReceipts(orders);
  // Reject the whole invoice when the authorized unknown cycle has another possible owner.
  // A failed bounded candidate must never hand its cash to the remaining exact-quantity candidate.
  if(authorizedUnknownReductions)for(const position of positions){
    const end=fundingWindowEnd(position);
    if(position.mode!=='live'||position.base!==payment.base||position.openedAt>=payment.timestamp||
      end!==undefined&&Number.isFinite(end)&&end<payment.timestamp)continue;
    for(const leg of [position.long,position.short]){
      if(leg.exchange!==exchange||payment.symbol!==undefined&&payment.symbol!==leg.symbol||payment.side!==undefined&&payment.side!==leg.side)continue;
      if([...authorizedUnknownReductions].some(order=>order.positionId===position.id&&order.exchange===leg.exchange&&order.request.symbol===leg.symbol)&&
        !hasUniqueFundingWindow(positions,position,leg,payment))return;
    }
  }
  for(const position of positions){
    const end=fundingWindowEnd(position);
    if(position.mode!=='live'||position.base!==payment.base||!Number.isFinite(position.openedAt)||position.openedAt<=0||position.openedAt>=payment.timestamp||
      end!==undefined&&(!Number.isFinite(end)||end<payment.timestamp))continue;
    if(authorizedUnknownReductions&&[...authorizedUnknownReductions].some(order=>{
      if(order.positionId!==position.id)return false;
      const selectedLeg=[position.long,position.short].find(candidate=>candidate.exchange===order.exchange&&candidate.symbol===order.request.symbol);
      return !selectedLeg||!orders.includes(order)||!isAuthorizedUnknownReduction(position,selectedLeg,order,orders,authorizedUnknownReductions,conflicts);
    }))continue;
    for(const leg of [position.long,position.short]){
      if(leg.exchange!==exchange||payment.symbol!==undefined&&payment.symbol!==leg.symbol||payment.side!==undefined&&payment.side!==leg.side)continue;
      const quantity=settlementQuantity(position,leg,orders,payment.timestamp,conflicts);
      if(quantity===undefined){
        const quantityRange=authorizedUnknownReductions&&boundedSettlementOwnership(positions,position,leg,orders,payment,conflicts,authorizedUnknownReductions);
        if(quantityRange)matches.push({position,leg,quantityRange});
        continue;
      }
      if(payment.quantity!==undefined&&Math.abs(quantity-payment.quantity)>Math.max(1e-8,quantity*1e-8))continue;
      matches.push({position,leg});
    }
  }
  return matches.length===1?matches[0]:undefined;
}
