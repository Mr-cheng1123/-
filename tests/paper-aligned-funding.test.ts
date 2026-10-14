import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeId,MarketSnapshot,Position} from '../src/shared/types.js';
import {Engine} from '../src/core/engine.js';
import type {Store} from '../src/core/store.js';
import {evaluateHoldingDecision} from '../src/core/holding-decision.js';

const opened=1_790_921_600_000,first=opened+60_000,interval=3_600_000;
function fixture(){
  const config={...defaultConfig,mode:'paper' as const,entryPolicy:'aligned' as const,holdMode:'adaptive' as const,
    symbols:['BTC'],exchanges:['gate','bybit'] as ExchangeId[],minExitProfitUsd:.10,exitWeakFundingBps:2};
  const p:Position={id:'paper-two-cycles',base:'BTC',mode:'paper',status:'open',entryPolicy:'aligned',holdMode:'adaptive',
    long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long',quantity:1,entryPrice:100,markPrice:100,feesUsd:.05,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short',quantity:1,entryPrice:101,markPrice:101,feesUsd:.055,liquidationDistancePct:null},
    openedAt:opened,plannedExitAt:first+10_000,feesUsd:.105,fundingUsd:0,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,
    netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[],profitExitPolicy:{firstFundingTime:first,earliestExitAt:first+10_000,
      minSpreadNetUsd:0,minCombinedNetUsd:0,fundingChecks:[{exchange:'gate',timestamp:first},{exchange:'bybit',timestamp:first}]}};
  const store={data:{version:1,config,positions:[p],orders:[],logs:[],equity:[],killSwitch:false,fundingSeen:[]},save(){},log(){}} as unknown as Store;
  const engine=new Engine(store,false,{adapterFactory:()=>[]});
  const accrue=(quotes:MarketSnapshot[],at:number)=>(engine as unknown as {accruePaperFunding:(quotes:MarketSnapshot[],at:number)=>void}).accruePaperFunding(quotes,at);
  return {config,p,engine,accrue};
}
function quotes(event:number,observedAt:number,rate=.005):MarketSnapshot[]{return (['gate','bybit'] as const).map(exchange=>({
  exchange,base:'BTC',symbol:'BTC/USDT:USDT',timestamp:observedAt,observedAt,source:'public',markPrice:exchange==='gate'?100:101,indexPrice:100,
  fundingRate:exchange==='gate'?0:rate,nextFundingTime:event,intervalHours:1,fundingHistory:[],
  bids:[{price:exchange==='gate'?100.8:101,quantity:5}],asks:[{price:exchange==='gate'?101:101.1,quantity:5}],
  quantityStep:.001,minQuantity:.001,minNotional:1,contractSize:1,openInterestUsd:0,volume24hUsd:0}));}

test('contiguous simulated cycles retain cash evidence and take profit as soon as net passes despite positive carry',()=>{
  const f=fixture(),second=first+interval;
  f.accrue(quotes(first,first-1000),first+1000);
  assert.equal(f.p.fundingUsd,.505);assert.equal(f.p.long.fundingObservedSince,opened);
  const next=quotes(second,first+1000);
  next[0].bids=[{price:99.9,quantity:5}];next[0].asks=[{price:100,quantity:5}];
  const hold=evaluateHoldingDecision(f.p,next[0],next[1],f.config,first+1000);
  assert.equal(hold.action,'hold');assert.ok(hold.exitProfit!.netPnlUsd<f.config.minExitProfitUsd);
  assert.ok(hold.expectedFundingUsd>0);f.p.holdDecision=hold;
  f.accrue(quotes(second,second-1000),second+1000);
  assert.equal(f.p.fundingUsd,1.01);assert.equal(f.p.short.fundingObservedAt,second+1000);
  const weak=quotes(second+interval,second+1000,.0001);
  const positiveCarryExit=evaluateHoldingDecision(f.p,weak[0],weak[1],f.config,second+1000);
  assert.equal(positiveCarryExit.action,'close');assert.equal(positiveCarryExit.exitSignal,'profit');
  assert.ok(positiveCarryExit.expectedFundingUsd>0);assert.ok(positiveCarryExit.exitProfit!.netPnlUsd>.10);
  const expiredCarry=quotes(second+interval,second+1000,0);
  const exit=evaluateHoldingDecision(f.p,expiredCarry[0],expiredCarry[1],f.config,second+1000);
  assert.equal(exit.action,'close');assert.equal(exit.exitSignal,'profit');assert.ok(exit.exitProfit!.netPnlUsd>.10);
});

test('a missed offline simulated settlement never becomes a fabricated complete funding window',()=>{
  const f=fixture(),third=first+2*interval;
  f.accrue(quotes(first,first-1000),first+1000);
  f.accrue(quotes(third,third-1000),third+1000);
  assert.equal(f.p.fundingUsd,1.01,'only two independently observed actual simulated events are counted');
  assert.equal(f.p.short.fundingObservedAt,first+1000,'gap does not advance full coverage');
  const next=quotes(third+interval,third+1000,0);
  const decision=evaluateHoldingDecision(f.p,next[0],next[1],f.config,third+1000);
  assert.equal(decision.action,'wait');assert.equal(decision.exitSignal,undefined);assert.equal(decision.exitProfit,undefined);
});
