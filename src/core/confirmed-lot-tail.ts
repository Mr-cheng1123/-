import type {AppConfig,JournalOrder,MarketSnapshot,Position} from '../shared/types.js';
import {usesCurrentExitStrategy} from '../shared/current-exit-strategy.js';
import {isPositionActive,isUnconfirmedJournalOrder} from '../shared/ledger-lifecycle.js';
import {conflictingNativeOrderReceipts,isTerminalOrderReceipt} from '../shared/order-receipt-validity.js';
import {nativeMakerFeeRate} from '../shared/trading-fees.js';
import {projectPositionFeeRebate} from '../shared/position-fee-rebates.js';
import {commonStep,floorQuantity,isLegalQuantity,isQuantityOnStep,quantityAdd,quantitySubtract} from './order-quantity.js';
import {bestCloseOppositeLevel} from './close-batch.js';
import {bestOppositeLevel} from './entry-batch.js';
import {quoteIsFresh} from './market-validity.js';
import {assessConfirmedLotTailProfitExit,alignedExitProfitsPass,type AlignedExitAssessment,type ConfirmedLotTailProfitExitAssessment} from './profit-exit.js';
import {assessConfirmedLotTailFundingExit} from './confirmed-lot-tail-funding.js';

export interface ConfirmedLotTailInput {
  position:Position;parent:JournalOrder;orders:readonly JournalOrder[];
  long:MarketSnapshot|undefined;short:MarketSnapshot|undefined;config:AppConfig;now?:number;
  /** Reference costs nominate only; real execution always keeps this true. */
  requireNativeFees?:boolean;
  fundingExitQualified?:(assessment:AlignedExitAssessment,long:MarketSnapshot,short:MarketSnapshot,now:number)=>boolean;
}
export interface ConfirmedLotTailPlan {
  status:'blocked'|'waiting'|'augment-maker'|'reduce-peer'|'matched';reason:string;
  originalParentClientId?:string;makerLeg?:'long'|'short';peerLeg?:'long'|'short';parentClientIds?:string[];
  confirmedBudget?:number;augmentationQuantity?:number;peerReductionQuantity?:number;targetQuantity?:number;
  makerLimitPrice?:number;peerLimitPrice?:number;proof?:string;profit?:ConfirmedLotTailProfitExitAssessment;
  exitSignal?:'profit'|'funding-loss';funding?:AlignedExitAssessment;
}
const same=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Number.EPSILON*Math.max(1,Math.abs(a),Math.abs(b))*8;

/** Pure plans never grant account/venue permission. Every real create needs fresh scope and native guards again. */
export function planConfirmedLotTailRestoration(input:ConfirmedLotTailInput):ConfirmedLotTailPlan {
  const {position:p,parent,orders,long,short,config:c}=input,now=input.now??Date.now();
  const reject=(reason:string):ConfirmedLotTailPlan=>({status:'blocked',reason});
  if(!usesCurrentExitStrategy(p,c)||c.mode!=='live'||p.mode!=='live'||!isPositionActive(p)||
    !orders.includes(parent)||!parent.makerReduction||parent.makerReduction.lotTailOriginalParentClientId||parent.positionId!==p.id||!parent.result?.id||
    !parent.request.reduceOnly||parent.request.postOnly!==true||parent.executionEvidence?.method!=='maker'||
    parent.executionEvidence.role!=='exit'||parent.makerReduction.activity!=='terminal'||parent.makerReduction.bookedExecution!==true)
    return reject('原 Maker 缺少所选正常策略的完整终态与入账关联');
  const makerLeg=parent.makerReduction.makerLeg,peerLeg:'long'|'short'=makerLeg==='long'?'short':'long',maker=p[makerLeg],peer=p[peerLeg],
    makerBook=makerLeg==='long'?long:short,peerBook=peerLeg==='long'?long:short,originalId=parent.request.clientOrderId;
  if(!makerBook||!peerBook||
    makerBook.exchange!==maker.exchange||peerBook.exchange!==peer.exchange||makerBook.symbol!==maker.symbol||peerBook.symbol!==peer.symbol||
    makerBook.base!==p.base||peerBook.base!==p.base||parent.exchange!==maker.exchange||parent.request.symbol!==maker.symbol||
    ![makerBook,peerBook].every(book=>Number.isFinite(book.quantityStep)&&book.quantityStep>0)||
    makerBook.quantityStep>=peerBook.quantityStep||!same(parent.makerReduction.quantityStep??NaN,makerBook.quantityStep)||
    !same(parent.makerReduction.peerQuantityStep??NaN,peerBook.quantityStep)||
    !isQuantityOnStep(maker.quantity,makerBook.quantityStep)||!isQuantityOnStep(peer.quantity,peerBook.quantityStep))
    return reject('原细腿、粗腿身份或冻结步长与真实余量不一致');
  if(![p.feesUsd,p.fundingUsd,p.realizedSpreadPnlUsd,p.transferCostUsd,p.long.feesUsd,p.short.feesUsd].every(Number.isFinite)||
    ![p.long,p.short].every(leg=>Number.isFinite(leg.entryPrice)&&leg.entryPrice>0&&Number.isFinite(leg.quantity)&&leg.quantity>=0)||
    p.long.side!=='long'||p.short.side!=='short')return reject('原双腿现金或数量字段未完整核验');
  const augmentations=orders.filter(order=>order.makerReduction?.lotTailOriginalParentClientId===originalId),parents=[parent,...augmentations],
    parentIds=parents.map(order=>order.request.clientOrderId),recovered=parent.makerReduction.recoveredPeers?.clientOrderIds??[];
  if(new Set(parentIds).size!==parents.length||parentIds.some(id=>orders.filter(order=>order.request.clientOrderId===id).length!==1)||
    recovered.some(id=>orders.filter(order=>order.request.clientOrderId===id).length!==1))return reject('原 ID 或关联恢复 ID 重复或缺失');
  const peers=orders.filter(order=>order.positionId===p.id&&(recovered.includes(order.request.clientOrderId)||
    parentIds.includes(order.executionEvidence?.makerCloseParentClientId??'')||order.executionEvidence?.makerCloseLotTailOriginalParentClientId===originalId));
  if(peers.some(order=>parents.includes(order)))return reject('Maker 原单不能冒充对侧消费记录');
  if(augmentations.some(order=>!same(order.makerReduction?.quantityStep??NaN,makerBook.quantityStep)||
    !same(order.makerReduction?.peerQuantityStep??NaN,peerBook.quantityStep))||peers.some(order=>{
      const evidence=order.executionEvidence;if(evidence?.makerCloseLotTailOriginalParentClientId!==originalId)return false;
      const ids=evidence.makerCloseLotTailParentClientIds;
      return !ids?.length||new Set(ids).size!==ids.length||ids.length!==parentIds.length||ids.some(id=>!parentIds.includes(id))||
        parents.some(parent=>parent.createdAt>order.createdAt);
    }))return reject('新增细腿冻结步长或粗腿原预算关联不完整');
  const involved=[...parents,...peers],conflicts=conflictingNativeOrderReceipts(orders);
  if(involved.some(order=>conflicts.has(order)))return reject('同一原生订单存在重复归属');
  if(orders.some(order=>order.positionId===p.id&&isUnconfirmedJournalOrder(order)))return {status:'waiting',reason:'原或新增订单仍活动／未知，先按原 ID 确认现金终态'};
  const validCash=(order:JournalOrder,side:'long'|'short',method:'maker'|'ioc')=>{
    const leg=p[side],book=side==='long'?long:short,result=order.result;
    return !!book&&order.positionId===p.id&&order.exchange===leg.exchange&&order.request.base===p.base&&order.request.symbol===leg.symbol&&
      order.request.reduceOnly&&order.request.side===(side==='long'?'sell':'buy')&&(method==='maker'?order.request.postOnly===true:order.request.postOnly!==true)&&
      order.executionEvidence?.method===method&&['exit','exit-tail'].includes(order.executionEvidence.role)&&
      Number.isFinite(order.createdAt)&&order.createdAt<=now&&order.createdAt>=parent.createdAt&&
      !!result&&isTerminalOrderReceipt(order.request,result)&&Number.isFinite(result.timestamp)&&result.timestamp<=now+5000&&
      result.averagePriceVerified!==false&&Number.isFinite(result.feeUsd)&&same(order.executionEvidence.bookedFeeUsd??NaN,result.feeUsd)&&
      (result.filledQuantity===0?result.averagePrice===0&&result.feeUsd===0:result.averagePrice>0)&&
      isQuantityOnStep(result.filledQuantity,book.quantityStep)&&
      (method!=='maker'||order.makerReduction?.makerLeg===makerLeg&&order.makerReduction.activity==='terminal'&&order.makerReduction.bookedExecution===true);
  };
  if(parents.some(order=>!validCash(order,makerLeg,'maker'))||peers.some(order=>!validCash(order,peerLeg,'ioc')))
    return reject('确认数量、完整实际费用或原腿身份尚未入账核验');
  const total=(values:number[])=>values.reduce((sum,value)=>quantityAdd(sum,value),0),augmented=total(augmentations.map(order=>order.result!.filledQuantity)),
    originalUsed=total(peers.filter(order=>!order.executionEvidence?.makerCloseLotTailOriginalParentClientId).map(order=>order.result!.filledQuantity)),
    restorationUsed=total(peers.filter(order=>order.executionEvidence?.makerCloseLotTailOriginalParentClientId===originalId).map(order=>order.result!.filledQuantity)),
    originalBudget=quantitySubtract(parent.result.filledQuantity,originalUsed),budget=quantitySubtract(quantityAdd(originalBudget,augmented),restorationUsed),
    difference=quantitySubtract(peer.quantity,maker.quantity);
  if(!Number.isFinite(budget)||budget<0||!same(difference,budget))return reject('真实尾差与原加新增累计确认现金预算不一致');
  const proof=JSON.stringify({id:p.id,base:p.base,mode:p.mode,quantities:[p.long.quantity,p.short.quantity],
    cash:[p.feesUsd,p.fundingUsd,p.realizedSpreadPnlUsd,p.transferCostUsd,p.profitExitNotionalUsd],policy:p.profitExitPolicy,
    legs:[p.long,p.short].map(leg=>[leg.exchange,leg.symbol,leg.side,leg.entryPrice,leg.feesUsd]),
    journals:involved.map(order=>({exchange:order.exchange,request:order.request,result:order.result,evidence:order.executionEvidence,maker:order.makerReduction}))});
  const common={originalParentClientId:originalId,makerLeg,peerLeg,parentClientIds:parentIds,confirmedBudget:budget,proof};
  if(!quoteIsFresh(makerBook,c,now)||!quoteIsFresh(peerBook,c,now))
    return {...common,status:'waiting',reason:'等待所选双腿完整新鲜执行盘口，原身份、冻结步长与确认现金预算保持'};
  if(same(difference,0))return {...common,status:'matched',reason:'真实累计确认减仓已恢复等量余仓',targetQuantity:maker.quantity};
  const startMaker=quantityAdd(maker.quantity,augmented),startPeer=quantityAdd(peer.quantity,restorationUsed),
    step=commonStep(makerBook.quantityStep,peerBook.quantityStep),target=floorQuantity(startMaker,step),
    totalAugmentation=quantitySubtract(startMaker,target),additional=quantitySubtract(totalAugmentation,augmented),reduction=quantitySubtract(peer.quantity,target);
  // The scoped account protocol binds two positive native position rows. A zero
  // target requires a distinct absence/identity protocol and cannot grant new risk here.
  if(!Number.isFinite(target)||target<=0||originalBudget<=0||!same(quantitySubtract(startPeer,startMaker),originalBudget)||
    !Number.isFinite(additional)||additional<0||totalAugmentation>=step||
    target>0&&(!isLegalQuantity(target,makerBook.quantityStep,makerBook.minQuantity)||!isLegalQuantity(target,peerBook.quantityStep,peerBook.minQuantity)))
    return reject('无法在保留真实原预算下求得最小合法共同余量');
  const peerTop=bestCloseOppositeLevel(peerBook,peer.side);
  if(same(additional,0)){
    if(!isLegalQuantity(reduction,peerBook.quantityStep,peerBook.minQuantity)||!same(reduction,budget)||!peerTop||peerTop.quantity<reduction)
      return {...common,status:'waiting',reason:'确认预算已就绪，等待粗腿合法首档容量',targetQuantity:target};
    return {...common,status:'reduce-peer',reason:'仅消费原与新增 Maker 已确认现金预算',peerReductionQuantity:reduction,peerLimitPrice:peerTop.price,targetQuantity:target};
  }
  if(!isLegalQuantity(additional,makerBook.quantityStep,makerBook.minQuantity)||!isLegalQuantity(reduction,peerBook.quantityStep,peerBook.minQuantity))
    return reject('最小追加减仓不足原生合法量，未扩大到额外一轮');
  const requireNativeFees=input.requireNativeFees??true,
    rebate=projectPositionFeeRebate(p,orders,c),economic={...p,estimatedFeeRebateUsd:rebate??null},
    profit=assessConfirmedLotTailProfitExit(economic,long,short,c,now,requireNativeFees),
    notionalReady=Number.isFinite(p.profitExitNotionalUsd)&&p.profitExitNotionalUsd!>0,
    profitPass=notionalReady&&alignedExitProfitsPass(p,profit,c),
    funding=profitPass?undefined:assessConfirmedLotTailFundingExit(economic,long,short,c,now,
      makerLeg==='long'?additional:reduction,makerLeg==='short'?additional:reduction,requireNativeFees),
    fundingQualified=funding?input.fundingExitQualified?.(funding,long!,short!,now)===true:false,
    fundingPass=notionalReady&&funding?.passes===true&&funding.exitSignal==='funding-loss'&&fundingQualified,
    passive=bestOppositeLevel(makerBook,maker.side==='long'?'buy':'sell');
  if(!profitPass&&!fundingPass||requireNativeFees&&nativeMakerFeeRate(makerBook,now)===undefined||!passive)
    return {...common,status:'waiting',reason:funding
      ?`${funding.reason}；${fundingQualified?'仍须实际费用和合法 Maker 盘口核验':'仍须独立资金费持续劣势确认'}`
      :'新的最小共同减仓尚未通过真实双腿对手价净利、实际费用与固定本金门槛，资金费劣势亦须独立确认',targetQuantity:target,funding};
  const exitSignal=profitPass?'profit':'funding-loss';
  return {...common,status:'augment-maker',reason:`按当前${profitPass?'盈利':'已持续确认的受控资金费退出'}信号只追加达到粗腿下一合法量所需的最小细腿 Maker`,
    augmentationQuantity:additional,makerLimitPrice:passive.price,peerReductionQuantity:reduction,targetQuantity:target,profit,funding,exitSignal};
}
