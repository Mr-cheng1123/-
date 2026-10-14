import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHoldingDecision, confirmHoldingDecision } from '../src/core/holding-decision.js';
import { defaultConfig, validateConfig } from './legacy-config.js';
import type { ExchangeId, MarketSnapshot, Position } from '../src/shared/types.js';

const now=1_700_000_000_000;
const quote=(exchange:ExchangeId,extra:Partial<MarketSnapshot>={}):MarketSnapshot=>({exchange,base:'BTC',symbol:'BTC/USDT:USDT',timestamp:now,
  markPrice:100,indexPrice:100,fundingRate:exchange==='binance'?0:.001,nextFundingTime:now+60_000,intervalHours:8,
  fundingHistory:[0,0],bids:[{price:100,quantity:20}],asks:[{price:100,quantity:20}],openInterestUsd:1e9,volume24hUsd:1e9,
  quantityStep:.001,minQuantity:.001,minNotional:1,contractSize:1,source:'public',...extra});
const position=():Position=>({id:'p',base:'BTC',mode:'paper',status:'open',openedAt:now-1000,plannedExitAt:now+70_000,holdMode:'adaptive',
  long:{exchange:'binance',symbol:'BTC/USDT:USDT',side:'long',quantity:10,entryPrice:100,markPrice:100,feesUsd:0,liquidationDistancePct:50},
  short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short',quantity:10,entryPrice:100,markPrice:100,feesUsd:0,liquidationDistancePct:50},
  fundingUsd:0,feesUsd:0,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]});
const config={...defaultConfig,holdMode:'adaptive' as const};

test('adaptive holds only when the next funding covers the two exit fees, ignoring sunk fees',()=>{
  const p=position(),thin=evaluateHoldingDecision(p,quote('binance'),quote('bybit'),config,now);
  assert.equal(thin.action,'close');assert.equal(thin.targetFundingTime,now+60_000);
  assert.ok(Math.abs(thin.expectedFundingUsd-1)<1e-12);
  assert.ok(Math.abs(thin.incrementalCostUsd-1.05)<1e-12);
  const decision=evaluateHoldingDecision(p,quote('binance'),quote('bybit',{fundingRate:.002}),config,now);
  assert.equal(decision.action,'hold');
  assert.ok(Math.abs(decision.expectedFundingUsd-2)<1e-12);
  assert.ok(Math.abs(decision.incrementalCostUsd-1.05)<1e-12);
  assert.ok(Math.abs(decision.expectedNetUsd-.95)<1e-12);
  p.feesUsd=999;p.fundingUsd=-999;p.netPnlUsd=-999;p.long.entryPrice=110;p.short.entryPrice=90;
  assert.deepEqual(evaluateHoldingDecision(p,quote('binance'),quote('bybit',{fundingRate:.002}),config,now),decision);
});

test('adaptive recomputes from rolling future events and never re-earns the event just settled',()=>{
  const p=position(),first=evaluateHoldingDecision(p,quote('binance'),quote('bybit'),config,now);p.holdDecision=first;
  const after=now+60_001,next=now+60_000+8*3_600_000;
  const rolled=evaluateHoldingDecision(p,quote('binance',{timestamp:after,nextFundingTime:next}),quote('bybit',{timestamp:after,nextFundingTime:next,fundingRate:-.001}),config,after);
  assert.equal(rolled.action,'close');assert.equal(rolled.targetFundingTime,next);
  assert.ok(Math.abs(rolled.expectedFundingUsd+1)<1e-12);
});

test('unupdated settlement clocks wait locally even beyond the old grace period and holding-time cap',()=>{
  const p=position(),event=now+60_000,after=event+1000;
  const delayed=(at:number)=>[quote('binance',{timestamp:at,nextFundingTime:event}),quote('bybit',{timestamp:at,nextFundingTime:event})] as const;
  assert.equal(evaluateHoldingDecision(p,...delayed(after),config,after).action,'wait');
  const expired=event+60_000;assert.equal(evaluateHoldingDecision(p,...delayed(expired),config,expired).action,'wait');
  const later=event+3600_000;assert.equal(evaluateHoldingDecision(p,...delayed(later),config,later).action,'wait');
  const capped={...config,maxHoldHours:(after-p.openedAt)/3_600_000};
  const hard=evaluateHoldingDecision(p,...delayed(after),capped,after);assert.equal(hard.action,'wait');
});

test('missing or insufficient fresh closing depth waits without fabricating a profitable exit',()=>{
  const p=position();
  for(const bad of [undefined,quote('binance',{timestamp:now-120_000}),quote('binance',{bids:[{price:100,quantity:1}]}),quote('binance',{nextFundingTime:NaN})]){
    assert.equal(evaluateHoldingDecision(p,bad,quote('bybit'),config,now).action,'wait',JSON.stringify(bad?.bids??bad?.timestamp??bad?.nextFundingTime));
  }
  const limited=evaluateHoldingDecision(p,quote('binance'),quote('bybit'),{...config,maxHoldHours:.001},now);
  assert.ok(!/最长/.test(limited.reason));
});

test('stale settlement clocks and pre-settlement quotes never force a close or bypass confirmation',()=>{
  const p=position(),event=now+60_000,at=event+60_000,c={...config,maxSnapshotAgeMs:120_000};
  const quotes=[quote('binance',{timestamp:event+1,nextFundingTime:event}),quote('bybit',{timestamp:event+1,nextFundingTime:event})] as const;
  const expired=evaluateHoldingDecision(p,...quotes,c,at);
  assert.equal(expired.forceClose,undefined);
  const pending={action:'close' as const,count:1,longAt:event+1,shortAt:event+1,targetFundingTime:expired.targetFundingTime};
  const result=confirmHoldingDecision(expired,pending,event+1,event+1,20);
  assert.equal(result.decision.action,'wait');assert.equal(result.confirmation,undefined);
  assert.equal('forceClose' in result.decision,false,'internal override is omitted from the persisted/displayed decision');
  const preSettlement=[quote('binance',{timestamp:event-1,nextFundingTime:event+8*3_600_000}),quote('bybit',{timestamp:event-1,nextFundingTime:event+8*3_600_000})] as const;
  const oldQuote=evaluateHoldingDecision(p,...preSettlement,c,at);
  assert.equal(oldQuote.forceClose,undefined);assert.match(oldQuote.reason,/结算后的双腿新报价/);
  assert.equal(confirmHoldingDecision(oldQuote,undefined,event-1,event-1,20).decision.action,'wait');
  const beyond=evaluateHoldingDecision(p,quote('binance'),quote('bybit'),{...config,maxHoldHours:.001},now);
  assert.equal(beyond.forceClose,undefined);
});

test('continuation prices closing fees from sorted executable depth instead of mark prices',()=>{
  const long=quote('binance',{bids:[{price:90,quantity:20},{price:110,quantity:20}]}),
    short=quote('bybit',{asks:[{price:120,quantity:20},{price:80,quantity:20}]});
  const result=evaluateHoldingDecision(position(),long,short,config,now);
  assert.equal(result.action,'hold');assert.ok(Math.abs(result.incrementalCostUsd-.99)<1e-12);
  assert.ok(Math.abs(result.expectedNetUsd-.01)<1e-12);
  assert.equal(long.bids[0].price,90,'evaluation must not mutate the original order book');
  assert.equal(short.asks[0].price,120);
});

test('invalid fee data and wrong contract identity wait only for this holding',()=>{
  const p=position();
  assert.equal(evaluateHoldingDecision(p,quote('binance',{symbol:'OTHER/USDT:USDT'}),quote('bybit'),config,now).action,'wait');
  for(const fee of [NaN,Infinity,-.0005]){
    assert.equal(evaluateHoldingDecision(p,quote('binance'),quote('bybit'),{...config,takerFees:{...config.takerFees,binance:fee}},now).action,'wait');
  }
  assert.equal(evaluateHoldingDecision(p,quote('binance'),quote('bybit',{fundingRate:.002}),config,now).action,'hold');
});

test('a freshly fetched static book is valid after settlement even if its last exchange event is old',()=>{
  const p=position(),event=now+60_000,after=event+120_000,next=event+8*3600_000;
  p.holdDecision={action:'hold',reason:'prior carry',expectedFundingUsd:2,incrementalCostUsd:1.05,expectedNetUsd:.95,nextReviewAt:event,targetFundingTime:event};
  const long=quote('binance',{timestamp:now-3600_000,observedAt:after,nextFundingTime:next}),
    short=quote('bybit',{timestamp:now-3600_000,observedAt:after,nextFundingTime:next,fundingRate:.002});
  assert.equal(evaluateHoldingDecision(p,long,short,config,after).action,'hold');
});

test('invalid timestamps cannot confirm an exit and invalid old counters do not stall a fresh sequence',()=>{
  const raw=evaluateHoldingDecision(position(),quote('binance'),quote('bybit'),config,now);
  assert.equal(raw.action,'close');
  for(const timestamp of [NaN,Infinity,0])assert.equal(confirmHoldingDecision(raw,undefined,timestamp,now,1).decision.action,'wait');
  const damaged={action:'close' as const,count:NaN,longAt:NaN,shortAt:now,targetFundingTime:raw.targetFundingTime};
  const result=confirmHoldingDecision(raw,damaged,now,now,2);
  assert.equal(result.confirmation?.count,1);assert.equal(result.decision.action,'wait');
  const legacy=confirmHoldingDecision({...raw,forceClose:true},undefined,now,now,2);
  assert.equal(legacy.decision.action,'wait','an old override cannot bypass economic confirmation');
});

test('confirmation requires both fresh timestamps to advance and resets for new direction or target',()=>{
  const raw=evaluateHoldingDecision(position(),quote('binance'),quote('bybit',{fundingRate:.002}),config,now);
  let result=confirmHoldingDecision(raw,undefined,now,now,3);assert.equal(result.decision.action,'wait');
  result=confirmHoldingDecision(raw,result.confirmation,now,now,3);assert.equal(result.confirmation!.count,1);
  result=confirmHoldingDecision(raw,result.confirmation,now+1,now,3);assert.equal(result.confirmation!.count,1);
  result=confirmHoldingDecision(raw,result.confirmation,now+1,now+1,3);assert.equal(result.confirmation!.count,2);
  result=confirmHoldingDecision(raw,result.confirmation,now+2,now+2,3);assert.equal(result.decision.action,'hold');
  result=confirmHoldingDecision({...raw,action:'close'},result.confirmation,now+3,now+3,3);assert.equal(result.decision.action,'wait');assert.equal(result.confirmation!.count,1);
  result=confirmHoldingDecision({...raw,targetFundingTime:raw.targetFundingTime+3_600_000},result.confirmation,now+4,now+4,3);assert.equal(result.confirmation!.count,1);
  assert.equal(confirmHoldingDecision({...raw,action:'wait'},result.confirmation,now+4,now+4,3).confirmation,undefined);
});

test('older configurations get explicit adaptive engineering defaults',()=>{
  const {adaptiveMinNetUsd,adaptiveConfirmations,adaptiveSettlementGraceSec,...legacy}=defaultConfig;
  const parsed=validateConfig({...legacy,holdMode:'adaptive'});
  assert.equal(parsed.adaptiveMinNetUsd,.05);assert.equal(parsed.adaptiveConfirmations,3);assert.equal(parsed.adaptiveSettlementGraceSec,60);
  assert.throws(()=>validateConfig({...parsed,adaptiveConfirmations:0}));
});
