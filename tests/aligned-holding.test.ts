import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../src/shared/config.js';
import type {AppConfig,ExchangeId,MarketSnapshot,Position} from '../src/shared/types.js';
import {evaluateHoldingDecision,confirmHoldingDecision} from '../src/core/holding-decision.js';
import {assessAlignedExit,assessProfitExit,alignedExitProfitsPass,profitExitPolicy} from '../src/core/profit-exit.js';
import {exitProfitThresholdUsd,profitExitNotionalUsd} from '../src/core/exit-profit-threshold.js';

const now=1_790_921_600_000;
const config:AppConfig={...defaultConfig,entryPolicy:'dual',exitWeakFundingBps:2,minExitProfitUsd:.10,
  minCombinedNetUsd:.04,takerFees:{...defaultConfig.takerFees,gate:.0005,bitget:.0006}};
function quote(exchange:ExchangeId,changes:Partial<MarketSnapshot>={}):MarketSnapshot{return {exchange,base:'BTC',symbol:'BTC/USDT:USDT',
  timestamp:now,observedAt:now,indexPrice:100,markPrice:exchange==='gate'?100:101,fundingRate:exchange==='gate'?0:.0005,
  nextFundingTime:now+60_000,intervalHours:8,fundingHistory:[],bids:[{price:exchange==='gate'?99.9:101,quantity:5}],
  asks:[{price:exchange==='gate'?100:101.1,quantity:5}],quantityStep:.001,minQuantity:.001,minNotional:1,
  contractSize:1,openInterestUsd:0,volume24hUsd:0,source:'public',
  takerFeeRate:exchange==='gate'?.0005:.0006,takerFeeAt:now,takerFeeSource:'exchange',...changes};}
function position():Position{return {id:'aligned-offline',base:'BTC',mode:'live',status:'open',entryPolicy:'aligned',holdMode:'adaptive',
  long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long',quantity:1,entryPrice:100,markPrice:100,feesUsd:.05,liquidationDistancePct:null,
    fundingObservedAt:now,fundingObservedSince:now-8*3_600_000},
  short:{exchange:'bitget',symbol:'BTC/USDT:USDT',side:'short',quantity:1,entryPrice:101,markPrice:101,feesUsd:.06,liquidationDistancePct:null,lastFundingAt:now-20_000},
  openedAt:now-8*3_600_000,plannedExitAt:now-10_000,feesUsd:.11,fundingUsd:0,transferCostUsd:0,
  spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[],
  profitExitPolicy:{firstFundingTime:now-20_000,earliestExitAt:now-10_000,minSpreadNetUsd:0,minCombinedNetUsd:.04,
    fundingChecks:[{exchange:'bitget',timestamp:now-20_000}]}};}
const evaluate=(p=position(),long=quote('gate'),short=quote('bitget'))=>evaluateHoldingDecision(p,long,short,config,now);
const profitableQuotes=()=>[quote('gate',{bids:[{price:100.8,quantity:5}],asks:[{price:101,quantity:5}]}),quote('bitget',{fundingRate:0})] as const;

test('an already held async hedge is not liquidated by the new-entry wait or its next single negative payment',()=>{
  const p=position(),long=quote('gate',{fundingRate:-.010993,nextFundingTime:now+2*3_600_000,intervalHours:8}),
    short=quote('bitget',{fundingRate:-.000859,nextFundingTime:now+3_600_000,intervalHours:1,markPrice:100});
  p.openedAt=now-1_000;p.plannedExitAt=long.nextFundingTime+config.exitDelaySec*1000;
  p.profitExitPolicy=profitExitPolicy(long,short,{...config,entryPolicy:'aligned'});
  p.fundingUsd=-.12;
  const result=evaluate(p,long,short);
  assert.equal(result.action,'hold');assert.equal(result.exitSignal,undefined);
  assert.equal(result.fundingSchedule!.entryReady,false,'new-entry scheduling is advisory for an existing hedge');
  assert.ok(Math.abs(result.fundingSchedule!.nextEventUsd+.0859)<1e-10);
  assert.ok(Math.abs(result.expectedFundingUsd-.9275)<1e-10);
  assert.equal(p.fundingUsd,-.12,'forecast income never replaces an actual already-paid receipt');
  assert.match(result.reason,/双方本轮/);assert.match(result.reason,/最近单次预计先付/);assert.match(result.reason,/非确定收益/);
});

test('positive carry holds without charging sunk costs or the same closing fee each cycle',()=>{
  const p=position(),result=evaluate(p);
  assert.equal(result.action,'hold');assert.equal(result.expectedFundingUsd,.0505);assert.equal(result.incrementalCostUsd,0);
  assert.equal(result.expectedNetUsd,.0505);assert.match(result.reason,/继续持有/);
  p.feesUsd=1_000;p.fundingUsd=-100;p.long.entryPrice=110;p.short.entryPrice=90;
  assert.equal(evaluate(p).action,'hold','past loss is not charged again as marginal future carry');
});

test('missing closing depth waits instead of claiming executable profit or submitting an exit',()=>{
  const result=evaluate(position(),quote('gate',{bids:[]}),quote('bitget',{asks:[],fundingRate:0}));
  assert.equal(result.action,'wait');assert.equal(result.exitSignal,undefined);assert.equal(result.exitProfit,undefined);
});

test('strong positive carry does not postpone an executable profit above the configured threshold',()=>{
  const p=position();p.fundingUsd=.5;const [long,short]=profitableQuotes();short.fundingRate=.0005;
  const result=evaluate(p,long,short);assert.equal(result.action,'close');assert.equal(result.exitSignal,'profit');
  assert.ok(result.exitProfit!.netPnlUsd>exitProfitThresholdUsd(p,config));assert.match(result.reason,/开始盈利退出/);
  assert.ok(result.expectedFundingUsd>0,'future positive carry is advisory after actual profit passes');
});

test('zero or negative carry can take executable profit without waiting for adverse funding confirmation',()=>{
  for(const fundingRate of [0,-.0005]){
    const [long,short]=profitableQuotes();short.fundingRate=fundingRate;
    const raw=evaluate(position(),long,short);assert.equal(raw.action,'close');assert.equal(raw.exitSignal,'profit');
    assert.ok(raw.exitProfit!.netPnlUsd>exitProfitThresholdUsd(position(),config));
    const value=assessAlignedExit(position(),long,short,config,now)!;
    assert.ok(value.profit!.spreadAfterClosingFeesUsd>0);assert.equal(value.passes,true);
  }
});

test('zero or weak negative carry cannot justify paying the controlled exit cost allowance',()=>{
  for(const fundingRate of [0,-.0005]){
    const raw=evaluate(position(),quote('gate'),quote('bitget',{fundingRate}));
    assert.equal(raw.action,'wait');assert.equal(raw.exitSignal,undefined);assert.match(raw.reason,/受控退出条件|直接亏损平仓/);
    if(fundingRate<0)assert.ok(raw.fundingLossExit!.expectedSavingsUsd<raw.fundingLossExit!.minimumSavingsUsd);
    assert.equal(confirmHoldingDecision(raw,undefined,now,now,1).confirmation,undefined);
  }
});

test('BTR actual two-leg fills and fees do not exit at a loss solely because the next funding turns negative',()=>{
  const p=position();p.base='BTR';p.long.symbol=p.short.symbol='BTR/USDT:USDT';p.long.quantity=p.short.quantity=1990;
  p.long.entryPrice=.05028040201005;p.short.entryPrice=.05034;p.feesUsd=.16023419;p.fundingUsd=.06583015;
  const long=quote('gate',{base:'BTR',symbol:p.long.symbol,markPrice:.04981,quantityStep:1,bids:[{price:.04981,quantity:3000}],asks:[{price:.04982,quantity:3000}]}),
    short=quote('bitget',{base:'BTR',symbol:p.short.symbol,markPrice:.04988,quantityStep:1,fundingRate:-.00043,takerFeeRate:.0011,bids:[{price:.04987,quantity:3000}],asks:[{price:.04988,quantity:3000}]});
  const raw=evaluateHoldingDecision(p,long,short,{...config,takerFees:{...config.takerFees,bitget:.0011}},now);
  assert.equal(raw.action,'wait');assert.equal(raw.exitSignal,undefined);
  assert.ok(raw.exitProfit!.netPnlUsd<-.26);assert.ok(raw.expectedFundingUsd<0);
});

test('small positive carry does not postpone profit capture and the configured threshold stays strict',()=>{
  const p=position(),[long,short]=profitableQuotes(),value=assessAlignedExit(p,long,short,config,now)!;
  const minExitProfitBps=value.profit!.netPnlUsd/profitExitNotionalUsd(p)!*10_000,atThresholdConfig={...config,minExitProfitBps};
  const threshold=exitProfitThresholdUsd(p,atThresholdConfig);
  assert.equal(alignedExitProfitsPass(p,{...value.profit!,netPnlUsd:threshold},atThresholdConfig),false,'exact computed threshold is insufficient');
  assert.equal(assessAlignedExit(p,long,short,atThresholdConfig,now)!.passes,false);
  for(const fundingRate of [.000001,.0001]){
    short.fundingRate=fundingRate;
    const result=evaluate(p,long,short);
    assert.ok(result.exitProfit!.netPnlUsd>exitProfitThresholdUsd(p,config));
    assert.equal(result.action,'close');assert.equal(result.exitSignal,'profit');
    assert.equal(assessAlignedExit(p,long,short,{...config,exitWeakFundingBps:999},now)!.passes,true);
    const atThreshold=evaluateHoldingDecision(p,long,short,atThresholdConfig,now);
    assert.equal(atThreshold.action,'hold');assert.equal(atThreshold.exitSignal,undefined,'equal to the threshold is insufficient');
  }
});

test('banked funding can recover a price loss and exit when carry is no longer positive',()=>{
  const p=position();p.fundingUsd=1;
  const result=evaluate(p,quote('gate'),quote('bitget',{fundingRate:0}));
  assert.equal(result.action,'close');assert.equal(result.exitSignal,'profit');
  assert.ok(result.exitProfit!.netPnlUsd>exitProfitThresholdUsd(p,config));
  assert.ok(assessAlignedExit(p,quote('gate'),quote('bitget',{fundingRate:0}),config,now)!.profit!.spreadAfterClosingFeesUsd<0);
  assert.match(result.reason,/累计资金费与价格损益合计/);
});

test('positive carry continues even when the closing profit cannot yet be observed',()=>{
  const p=position();p.short.lastFundingAt=undefined;
  const result=evaluate(p,quote('gate',{bids:[]}),quote('bitget',{fundingRate:.000001,asks:[]}));
  assert.equal(result.action,'hold');assert.ok(result.expectedFundingUsd>0);
  assert.equal(result.exitProfit,undefined);assert.equal(result.exitSignal,undefined);
  assert.match(result.reason,/尚待核验/);
});

test('price profit may exit before the first funding event without treating forecast funding as a receipt',()=>{
  const p=position(),[long,short]=profitableQuotes();p.openedAt=now-1000;p.plannedExitAt=now+70_000;p.short.lastFundingAt=undefined;
  p.profitExitPolicy=profitExitPolicy(long,short,{...config,entryPolicy:'aligned'});
  assert.equal(p.profitExitPolicy.fundingChecks.length,2,'zero-rate leg also retains its initial settlement clock');
  const raw=evaluate(p,long,short);assert.equal(raw.action,'close');assert.equal(raw.exitSignal,'profit');
  assert.ok(now<p.profitExitPolicy.earliestExitAt);assert.equal(p.fundingUsd,0);
  assert.equal(raw.exitProfit!.netPnlUsd,raw.exitProfit!.spreadPnlUsd-raw.exitProfit!.totalFeesUsd);
});

test('due unconfirmed first funding is unknown; a complete ledger read after grace can prove no payment',()=>{
  const p=position(),[long,short]=profitableQuotes();p.short.lastFundingAt=undefined;
  assert.equal(evaluate(p,long,short).action,'wait');assert.equal(evaluate(p,long,short).exitProfit,undefined);
  p.short.fundingObservedSince=p.openedAt;p.short.fundingObservedAt=now;
  assert.equal(assessProfitExit(p,long,short,config,now),undefined,'20 seconds since event does not yet prove absent payment');
  p.profitExitPolicy!.fundingChecks[0].timestamp=now-60_000;
  assert.equal(evaluate(p,long,short).action,'close');
});

test('later cycles cannot reuse the first receipt and need a complete observation window for each leg',()=>{
  const p=position(),[long,short]=profitableQuotes(),first=now-8*3_600_000-60_000,latest=now-60_000;
  p.openedAt=first-1000;p.plannedExitAt=first+10_000;p.profitExitPolicy!.fundingChecks=[{exchange:'bitget',timestamp:first}];
  p.profitExitPolicy!.firstFundingTime=first;p.short.lastFundingAt=first;
  long.nextFundingTime=short.nextFundingTime=latest+8*3_600_000;
  assert.equal(evaluate(p,long,short).action,'wait');
  p.short.fundingObservedSince=p.openedAt;p.short.fundingObservedAt=now;
  assert.equal(evaluate(p,long,short).action,'wait','other leg also has an elapsed settlement');
  p.long.fundingObservedSince=p.openedAt+1;p.long.fundingObservedAt=now;
  assert.equal(evaluate(p,long,short).action,'wait','later query start cannot prove full accrued total');
  p.long.fundingObservedSince=p.openedAt;
  assert.equal(evaluate(p,long,short).action,'close');
});

test('aligned profit exit still must pass final worst IOC limits while returning positive carry cannot cancel it',()=>{
  const p=position(),[long,short]=profitableQuotes();
  assert.equal(assessAlignedExit(p,long,short,config,now)!.passes,true);
  assert.equal(assessAlignedExit(p,long,short,config,now,true,{longPrice:99,shortPrice:102})!.passes,false);
  short.fundingRate=.0005;
  assert.equal(assessAlignedExit(p,long,short,config,now)!.passes,true,'strong carry returning does not cancel bankable profit');
});

test('aligned counts actual independent settlements and waits on stale, mismatched or invalid evidence',()=>{
  const hourly=quote('gate',{fundingRate:.0001,intervalHours:1,nextFundingTime:now+60_000});
  const result=evaluate(position(),hourly,quote('bitget',{nextFundingTime:now+8*3_600_000}));
  assert.equal(result.action,'wait');assert.ok(result.expectedFundingUsd<0,'the eight long-side payments are counted');
  for(const change of [{nextFundingTime:now-1},{fundingRate:NaN},{symbol:'OTHER/USDT:USDT'},
    {observedAt:now-config.maxSnapshotAgeMs-1},{observedAt:now-config.maxQuoteSkewMs-1},{source:'demo' as const}])
    assert.equal(evaluate(position(),quote('gate',change)).action,'wait',JSON.stringify(change));
});

test('an observed crossed book cannot manufacture aligned exit or carry evidence',()=>{
  const p=position();p.fundingUsd=1;
  const result=evaluate(p,quote('gate',{bids:[{price:110,quantity:5}]}));
  assert.equal(result.action,'wait');assert.equal(result.exitSignal,undefined);assert.match(result.reason,/倒挂/);
});

test('holding follows the stored model and old positions without a model keep the legacy exit-fee gate',()=>{
  const p=position();assert.equal(evaluate(p).action,'hold');
  p.entryPolicy=undefined;
  assert.equal(evaluateHoldingDecision(p,quote('gate'),quote('bitget'),{...config,entryPolicy:'aligned'},now).action,'close');
});
