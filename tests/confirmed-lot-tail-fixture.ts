import type {AppConfig,JournalOrder,MarketSnapshot,Position} from '../src/shared/types.js';
import {defaultConfig} from '../src/shared/config.js';
import {planConfirmedLotTailRestoration} from '../src/core/confirmed-lot-tail.js';

export function lotTailFixture(){
  const now=2_000_000_000_000,symbol='SKL/USDT:USDT',config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',entryPolicy:'aligned',holdMode:'adaptive',feeRebatePct:{}};
  const p:Position={id:'ORIGINAL-SKL',base:'SKL',mode:'live',status:'attention',entryPolicy:'aligned',holdMode:'adaptive',
    openedAt:now-1000,plannedExitAt:now+1_800_000,profitExitNotionalUsd:110.1,closeRequestedAt:now-500,closeProfitRequired:true,closePricing:'best-opposite',
    long:{exchange:'gate',symbol,side:'long',quantity:3670,entryPrice:.03,markPrice:.031,feesUsd:.1,fundingObservedAt:now,fundingObservedSince:now-1000,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol,side:'short',quantity:3664,entryPrice:.03,markPrice:.03,feesUsd:.1,fundingObservedAt:now,fundingObservedSince:now-1000,liquidationDistancePct:null},
    profitExitPolicy:{firstFundingTime:now+1_800_000,earliestExitAt:now+1_800_000,minCombinedNetUsd:999,minSpreadNetUsd:0,fundingChecks:[]},
    fundingUsd:0,feesUsd:.2,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  const book=(exchange:'gate'|'bybit'):MarketSnapshot=>({exchange,base:'SKL',symbol,source:'public',timestamp:now,observedAt:now,fundingObservedAt:now,
    markPrice:.03,indexPrice:.03,fundingRate:0,nextFundingTime:now+1_800_000,intervalHours:1,fundingHistory:[],quantityStep:exchange==='gate'?10:1,
    minQuantity:exchange==='gate'?10:1,minNotional:5,contractSize:1,openInterestUsd:1e8,volume24hUsd:1e8,
    bids:[{price:exchange==='gate'?.031:.03,quantity:1000}],asks:[{price:exchange==='gate'?.03101:.03001,quantity:1000}],
    takerFeeRate:.0005,takerFeeAt:now,takerFeeSource:'exchange',makerFeeRate:.0002,makerFeeAt:now,makerFeeSource:'exchange'});
  const long=book('gate'),short=book('bybit');
  function maker(id:string,quantity:number,filled:number,original?:string):JournalOrder {
    return {positionId:p.id,exchange:'bybit',createdAt:now-400,request:{clientOrderId:id,base:p.base,symbol,side:'buy',quantity,limitPrice:.03,reduceOnly:true,postOnly:true},
      result:{id:`NATIVE-${id}`,clientOrderId:id,status:filled===quantity?'filled':filled>0?'partial':'cancelled',filledQuantity:filled,averagePrice:filled?.03:0,
        averagePriceVerified:true,feeUsd:filled*.03*.0002,timestamp:now-300},
      makerReduction:{activity:'terminal',makerLeg:'short',deadlineAt:now+5000,quantityStep:1,peerQuantityStep:10,bookedExecution:true,
        ...(original?{lotTailOriginalParentClientId:original}:{})},
      executionEvidence:{version:1,method:'maker',role:'exit',batchId:id,bookedFeeUsd:filled*.03*.0002}};
  }
  const parent=maker('ORIGINAL-PARENT',10,6),orders=[parent];
  const plan=()=>planConfirmedLotTailRestoration({position:p,parent,orders,long,short,config,now});
  const augmentation=(quantity:number,filled:number)=>{const next=maker(`NEW-PARENT-${orders.length}`,quantity,filled,parent.request.clientOrderId);orders.push(next);p.short.quantity-=filled;return next;};
  const peer=(filled=10)=>{const id=`PEER-${orders.length}`,next:JournalOrder={positionId:p.id,exchange:'gate',createdAt:now-100,
    request:{clientOrderId:id,base:p.base,symbol,side:'sell',quantity:10,limitPrice:.031,reduceOnly:true},
    result:{id:`NATIVE-${id}`,clientOrderId:id,status:filled===10?'filled':'partial',filledQuantity:filled,averagePrice:.031,averagePriceVerified:true,feeUsd:filled*.031*.0005,timestamp:now},
    executionEvidence:{version:1,method:'ioc',role:'exit-tail',batchId:id,bookedFeeUsd:filled*.031*.0005,
      makerCloseLotTailOriginalParentClientId:parent.request.clientOrderId,makerCloseLotTailParentClientIds:orders.filter(order=>order.makerReduction).map(order=>order.request.clientOrderId)}};
    orders.push(next);p.long.quantity-=filled;return next;};
  return {now,p,parent,orders,long,short,config,maker,plan,augmentation,peer};
}

