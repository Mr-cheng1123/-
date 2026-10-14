import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeId,MarketSnapshot,Position} from '../src/shared/types.js';
import {assessProfitExit,assessBestOppositeProfitExit,assessAlignedExit,alignedExitProfitsPass,bothExitProfitsPass,profitExitPolicy} from '../src/core/profit-exit.js';
import {evaluateHoldingDecision} from '../src/core/holding-decision.js';
import {exitProfitThresholdUsd,profitExitNotionalUsd,freezeProfitExitNotional} from '../src/core/exit-profit-threshold.js';

const now=1_700_000_000_000;
const quote=(exchange:ExchangeId,extra:Partial<MarketSnapshot>={}):MarketSnapshot=>({exchange,base:'BTC',symbol:'BTC/USDT:USDT',timestamp:now,
  markPrice:100,indexPrice:100,fundingRate:exchange==='binance'?0:.002,nextFundingTime:now+60_000,intervalHours:8,
  fundingHistory:[],bids:[{price:100.2,quantity:20}],asks:[{price:100.4,quantity:20}],openInterestUsd:1e9,volume24hUsd:1e9,
  quantityStep:.001,minQuantity:.001,minNotional:1,contractSize:1,source:'public',...extra});
const position=():Position=>({id:'profit',base:'BTC',mode:'paper',status:'open',openedAt:now-100_000,plannedExitAt:now-20_000,holdMode:'adaptive',
  long:{exchange:'binance',symbol:'BTC/USDT:USDT',side:'long',quantity:1,entryPrice:100,markPrice:100,feesUsd:.05,liquidationDistancePct:null},
  short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short',quantity:1,entryPrice:100.5,markPrice:100,feesUsd:.05,lastFundingAt:now-30_000,liquidationDistancePct:null},
  profitExitPolicy:{firstFundingTime:now-30_000,earliestExitAt:now-20_000,minSpreadNetUsd:0,minCombinedNetUsd:.05,fundingChecks:[{exchange:'bybit',timestamp:now-30_000}]},
  fundingUsd:.4,feesUsd:.1,transferCostUsd:.02,spreadPnlUsd:0,realizedSpreadPnlUsd:.05,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]});
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);

test('profit exit uses actual receipts and opening fees plus two executable closing fees exactly once',()=>{
  const p=position(),result=assessProfitExit(p,quote('binance'),quote('bybit'),defaultConfig,now)!;
  near(result.spreadPnlUsd,.35);near(result.totalFeesUsd,.1+100.2*.0005+100.4*.00055);
  near(result.netPnlUsd,p.fundingUsd+.35-result.totalFeesUsd-.02);
  assert.equal(bothExitProfitsPass(p,result),true);
});

test('an obsolete independent spread threshold cannot block a positive combined realized exit',()=>{
  const p=position();p.fundingUsd=.01;
  for(const oldThreshold of [NaN,Infinity,999]){
    p.profitExitPolicy!.minSpreadNetUsd=oldThreshold;
    const result=assessProfitExit(p,quote('binance'),quote('bybit'),defaultConfig,now)!;
    assert.ok(result.fundingAfterFeesUsd<0,'funding need not cover every fee independently');
    assert.ok(result.netPnlUsd>p.profitExitPolicy!.minCombinedNetUsd);
    assert.equal(bothExitProfitsPass(p,result),true);
  }
});

test('unknown funding receipts or invalid actual costs cannot claim a profitable exit',()=>{
  const p=position();p.short.lastFundingAt=undefined;
  assert.equal(assessProfitExit(p,quote('binance'),quote('bybit'),defaultConfig,now),undefined);
  p.short.lastFundingAt=now-30_000;
  for(const invalid of [NaN,Infinity]){
    p.feesUsd=invalid;
    assert.equal(assessProfitExit(p,quote('binance'),quote('bybit'),defaultConfig,now),undefined);
  }
  p.feesUsd=-.1;
  assert.ok(assessProfitExit(p,quote('binance'),quote('bybit'),defaultConfig,now),'actual rebates are valid recorded cash flow');
  assert.equal(bothExitProfitsPass({...position(),profitExitPolicy:undefined},{spreadPnlUsd:1,totalFeesUsd:0,fundingAfterFeesUsd:1,spreadAfterFeesUsd:1,netPnlUsd:1}),false);
});

test('profit exit sorts closing depth without changing snapshots and rejects insufficient depth',()=>{
  const long=quote('binance',{bids:[{price:90,quantity:20},{price:100.2,quantity:20}]}),
    short=quote('bybit',{asks:[{price:110,quantity:20},{price:100.4,quantity:20}]});
  const p=position(),result=assessProfitExit(p,long,short,defaultConfig,now)!;
  near(result.spreadPnlUsd,.35);assert.equal(bothExitProfitsPass(p,result),true);
  assert.equal(long.bids[0].price,90);assert.equal(short.asks[0].price,110);
  short.asks=[{price:100.4,quantity:.1}];
  assert.equal(assessProfitExit(p,long,short,defaultConfig,now),undefined);
});

test('worst permitted closing prices are assessed separately from a profitable weighted book',()=>{
  const p=position(),long=quote('binance'),short=quote('bybit');
  assert.equal(bothExitProfitsPass(p,assessProfitExit(p,long,short,defaultConfig,now)),true);
  const limited=assessProfitExit(p,long,short,defaultConfig,now,true,{longPrice:99,shortPrice:101})!;
  assert.equal(bothExitProfitsPass(p,limited),false);
});

test('profit evaluation uses fresh REST observations when the exchange event timestamp stays unchanged',()=>{
  const p=position(),long=quote('binance',{timestamp:now-3600_000,observedAt:now}),
    short=quote('bybit',{timestamp:now-3600_000,observedAt:now});
  assert.equal(bothExitProfitsPass(p,assessProfitExit(p,long,short,defaultConfig,now)),true);
  short.observedAt=now-defaultConfig.maxSnapshotAgeMs-1;
  assert.equal(assessProfitExit(p,long,short,defaultConfig,now),undefined);
});

test('bankable actual profit does not require a valid forecast for another funding cycle',()=>{
  const p=position(),long=quote('binance',{fundingRate:NaN,nextFundingTime:NaN,intervalHours:NaN,markPrice:NaN}),short=quote('bybit');
  const decision=evaluateHoldingDecision(p,long,short,defaultConfig,now);
  assert.equal(decision.action,'close');assert.equal(decision.exitSignal,'profit');
  p.short.lastFundingAt=undefined;
  assert.equal(evaluateHoldingDecision(p,long,short,defaultConfig,now).action,'wait');
});

test('best-opposite exit can value a legal first-level batch without claiming complete closing depth',()=>{
  const p=position(),long=quote('binance',{quantityStep:.01,minQuantity:.01,minNotional:10_000,bids:[{price:100.2,quantity:.13}]}),
    short=quote('bybit',{quantityStep:.02,minQuantity:.04,minNotional:10_000,asks:[{price:100.4,quantity:.07}]});
  const before=structuredClone({p,long,short});
  assert.equal(assessProfitExit(p,long,short,defaultConfig,now),undefined,'legacy complete-depth valuation is retained');
  const result=assessBestOppositeProfitExit(p,long,short,defaultConfig,now)!;
  assert.equal(result.pricing,'best-opposite');assert.equal(result.valuation,'same-price-full-position-estimate');
  near(result.batch.quantity,.06);assert.equal(result.batch.longLimitPrice,100.2);assert.equal(result.batch.shortLimitPrice,100.4);
  near(result.spreadPnlUsd,.35);near(result.closingFeesUsd,100.2*.0005+100.4*.00055);
  near(result.netPnlUsd,p.fundingUsd+.35-p.feesUsd-result.closingFeesUsd-p.transferCostUsd);
  assert.deepEqual({p,long,short},before,'read-only valuation must not change real fills, cash or quotes');
});

test('ordinary profit capture uses the shared first-price plan instead of bad deeper prices',()=>{
  const p=position(),long=quote('binance',{bids:[{price:90,quantity:20},{price:100.2,quantity:.1}]}),
    short=quote('bybit',{asks:[{price:110,quantity:20},{price:100.4,quantity:.1}]});
  assert.equal(bothExitProfitsPass(p,assessProfitExit(p,long,short,defaultConfig,now)),false);
  const result=assessBestOppositeProfitExit(p,long,short,defaultConfig,now)!;
  assert.equal(bothExitProfitsPass(p,result),true);near(result.batch.quantity,.1);
  const decision=evaluateHoldingDecision(p,long,short,defaultConfig,now);
  assert.equal(decision.action,'close');assert.equal(decision.exitSignal,'profit');near(decision.exitProfit!.netPnlUsd,result.netPnlUsd);
  assert.equal('batch' in decision.exitProfit!,false,'old persisted money shape does not acquire an execution receipt');
});

test('a supplied common batch must be exact, legal and within current top quantity on both legs',()=>{
  const p=position(),long=quote('binance',{quantityStep:.01,minQuantity:.01,bids:[{price:100.2,quantity:.13}]}),
    short=quote('bybit',{quantityStep:.02,minQuantity:.04,asks:[{price:100.4,quantity:.07}]});
  for(const size of [.04,.06])near(assessBestOppositeProfitExit(p,long,short,defaultConfig,now,size)!.batch.quantity,size);
  for(const size of [NaN,Infinity,0,-.04,.02,.03,.07,.08,2])
    assert.equal(assessBestOppositeProfitExit(p,long,short,defaultConfig,now,size),undefined,`invalid batch ${size}`);
  const empty=quote('binance',{bids:[]});assert.equal(assessBestOppositeProfitExit(p,empty,short,defaultConfig,now),undefined);
});

test('best-price final gates value the submitted conservative bounds after a favorable network-time book update',()=>{
  const p=position(),long=quote('binance',{bids:[{price:100.2,quantity:.1}]}),
    short=quote('bybit',{asks:[{price:100.4,quantity:.1}]}),limits={longPrice:99,shortPrice:101};
  assert.equal(bothExitProfitsPass(p,assessBestOppositeProfitExit(p,long,short,defaultConfig,now,.1)),true);
  const bounded=assessBestOppositeProfitExit(p,long,short,defaultConfig,now,.1,limits)!;
  assert.equal(bothExitProfitsPass(p,bounded),false,'improved current prices cannot approve losing original IOC bounds');
  assert.equal(bounded.batch.longLimitPrice,limits.longPrice);assert.equal(bounded.batch.shortLimitPrice,limits.shortPrice);
  near(bounded.spreadPnlUsd,p.realizedSpreadPnlUsd+99-p.long.entryPrice+p.short.entryPrice-101);
  near(bounded.closingFeesUsd,99*.0005+101*.00055);
  assert.equal(assessProfitExit(p,long,short,defaultConfig,now,true,limits),undefined,'best-price bounds do not require whole-position depth');
  p.entryPolicy='aligned';short.fundingRate=0;
  assert.equal(assessAlignedExit(p,long,short,defaultConfig,now,false,undefined,{pricing:'best-opposite',batchQuantity:.1})!.passes,true);
  assert.equal(assessAlignedExit(p,long,short,defaultConfig,now,false,limits,{pricing:'best-opposite',batchQuantity:.1})!.passes,false,
    'explicit best-price options pass the actual submitted bounds through the aligned carry gate');
});

test('submitted best-price bounds must be finite positive and currently executable in the reduction direction',()=>{
  const p=position(),long=quote('binance'),short=quote('bybit');
  for(const limits of [{longPrice:NaN,shortPrice:101},{longPrice:99,shortPrice:Infinity},{longPrice:0,shortPrice:101},
    {longPrice:99,shortPrice:-1},{longPrice:100.21,shortPrice:100.4},{longPrice:100.2,shortPrice:100.39}])
    assert.equal(assessBestOppositeProfitExit(p,long,short,defaultConfig,now,.1,limits),undefined,JSON.stringify(limits));
  const same=assessBestOppositeProfitExit(p,long,short,defaultConfig,now,.1,{longPrice:100.2,shortPrice:100.4})!;
  near(same.netPnlUsd,assessBestOppositeProfitExit(p,long,short,defaultConfig,now,.1)!.netPnlUsd);
});

test('best-price valuation keeps the receipt, timing, native-fee and quote evidence checks',()=>{
  const p=position();p.mode='live';
  const native=(exchange:ExchangeId)=>quote(exchange,{observedAt:now,takerFeeRate:exchange==='binance'?.0005:.00055,takerFeeSource:'exchange',takerFeeAt:now});
  assert.ok(assessBestOppositeProfitExit(p,native('binance'),native('bybit'),defaultConfig,now));
  assert.equal(assessBestOppositeProfitExit(p,quote('binance'),native('bybit'),defaultConfig,now),undefined);
  assert.equal(assessBestOppositeProfitExit(p,native('binance'),native('bybit'),defaultConfig,now-defaultConfig.maxSnapshotAgeMs-1),undefined);
  for(const change of [
    {symbol:'OTHER/USDT:USDT'}, {observedAt:now-defaultConfig.maxSnapshotAgeMs-1},
    {observedAt:now-defaultConfig.maxQuoteSkewMs-1}, {source:'demo' as const},
    {takerFeeAt:now-120_001}, {bids:[{price:101,quantity:20}]},
  ])assert.equal(assessBestOppositeProfitExit(p,native('binance'),{...native('bybit'),...change},defaultConfig,now),undefined,JSON.stringify(change));
  p.short.lastFundingAt=undefined;
  assert.equal(assessBestOppositeProfitExit(p,native('binance'),native('bybit'),defaultConfig,now),undefined);
  p.short.lastFundingAt=now-30_000;p.short.quantity=1.1;
  assert.equal(assessBestOppositeProfitExit(p,native('binance'),native('bybit'),defaultConfig,now),undefined);
});

test('after a confirmed partial close only remaining quantities add future fees; past realized cash is not counted twice',()=>{
  const p=position(),long=quote('binance'),short=quote('bybit'),before=assessBestOppositeProfitExit(p,long,short,defaultConfig,now)!;
  const closed=.5,paidCloseFees=closed*(100.2*.0005+100.4*.00055);
  p.realizedSpreadPnlUsd+=closed*(100.2-p.long.entryPrice)+closed*(p.short.entryPrice-100.4);
  p.feesUsd+=paidCloseFees;p.long.quantity-=closed;p.short.quantity-=closed;
  const next=assessBestOppositeProfitExit(p,long,short,defaultConfig,now,.5)!;
  near(next.spreadPnlUsd,before.spreadPnlUsd);near(next.netPnlUsd,before.netPnlUsd);
  near(next.closingFeesUsd,before.closingFeesUsd-paidCloseFees);near(next.totalFeesUsd,before.totalFeesUsd);
});

test('best-opposite valuation retains the existing cumulative cash policy without a new independent batch-profit gate',()=>{
  const p=position();p.realizedSpreadPnlUsd=2;p.long.entryPrice=101;p.short.entryPrice=100;
  const result=assessBestOppositeProfitExit(p,quote('binance'),quote('bybit'),defaultConfig,now,.1)!;
  assert.ok((100.2-p.long.entryPrice)+(p.short.entryPrice-100.4)<0,'remaining prices alone may be unfavorable');
  assert.ok(result.netPnlUsd>p.profitExitPolicy!.minCombinedNetUsd,'previously realized legitimate cash remains part of the whole strategy');
  assert.equal(bothExitProfitsPass(p,result),true);
});

test('aligned ordinary exits estimate the whole position at best prices and take eligible profit with positive carry',()=>{
  const p=position();p.entryPolicy='aligned';
  const long=quote('binance',{bids:[{price:100.2,quantity:.13}]}),short=quote('bybit',{fundingRate:0,asks:[{price:100.4,quantity:.07}]});
  const ready=assessAlignedExit(p,long,short,defaultConfig,now)!;
  assert.equal(ready.passes,true);assert.match(ready.reason,/对手价1条件估算/);assert.match(ready.reason,/不保证全仓同价成交/);
  assert.equal(evaluateHoldingDecision(p,long,short,defaultConfig,now).action,'close');
  assert.equal(assessAlignedExit(p,long,short,defaultConfig,now,false,undefined,{pricing:'best-opposite',batchQuantity:.071})!.passes,false);
  assert.equal(assessAlignedExit(p,long,short,defaultConfig,now,true,{longPrice:100.2,shortPrice:100.4})!.profit,undefined,
    'explicit old complete-depth limit checks keep legacy semantics');
  short.fundingRate=.000001;
  assert.equal(assessAlignedExit(p,long,short,defaultConfig,now)!.passes,true);
  const captured=evaluateHoldingDecision(p,long,short,defaultConfig,now);assert.equal(captured.action,'close');assert.equal(captured.exitSignal,'profit');
});

test('aligned exits use strict bps against original one-leg opening notional, retaining frozen legacy gates',()=>{
  const p=position();p.entryPolicy='aligned';p.profitExitPolicy!.minCombinedNetUsd=999;
  const profit=assessBestOppositeProfitExit(p,quote('binance'),quote('bybit'),defaultConfig,now)!;
  assert.equal(bothExitProfitsPass(p,profit),false);
  const threshold=exitProfitThresholdUsd(p,defaultConfig);
  near(profitExitNotionalUsd(p)!,100.25);near(threshold,.10025);
  for(const netPnlUsd of [-1,0,threshold-.000001,threshold,NaN,Infinity])assert.equal(alignedExitProfitsPass(p,{...profit,netPnlUsd},defaultConfig),false);
  assert.equal(alignedExitProfitsPass(p,{...profit,netPnlUsd:threshold+.000001},defaultConfig),true);
  for(const minExitProfitBps of [-1,NaN,Infinity])assert.equal(alignedExitProfitsPass(p,profit,{...defaultConfig,minExitProfitBps}),false);
  for(const minExitProfitUsd of [0,999,NaN])assert.equal(alignedExitProfitsPass(p,profit,{...defaultConfig,minExitProfitUsd}),true,
    'the compatible legacy USD field does not determine aligned profitability');
  assert.equal(alignedExitProfitsPass(p,{...profit,netPnlUsd:threshold},{...defaultConfig,minExitProfitBps:undefined}),false,'absent legacy bps uses runtime 10');
  assert.equal(alignedExitProfitsPass({...p,entryPolicy:'dual'},profit,defaultConfig),false);
});

test('aligned threshold keeps frozen opening principal after partial closes and changing target order size',()=>{
  const p=position();p.entryPolicy='aligned';assert.equal(freezeProfitExitNotional(p,[]),true);
  const original=profitExitNotionalUsd(p)!,threshold=exitProfitThresholdUsd(p,defaultConfig);
  p.long.quantity=p.short.quantity=.25;p.long.markPrice=150;p.short.markPrice=50;
  near(profitExitNotionalUsd(p)!,original);near(exitProfitThresholdUsd(p,{...defaultConfig,orderNotionalUsd:10_000}),threshold);
  const profit=assessBestOppositeProfitExit(p,quote('binance'),quote('bybit'),defaultConfig,now)!;
  assert.equal(alignedExitProfitsPass(p,{...profit,netPnlUsd:threshold},defaultConfig),false);
  assert.equal(alignedExitProfitsPass(p,{...profit,netPnlUsd:threshold+.000001},defaultConfig),true);
});

test('aligned spread gains can be banked before the first funding receipt and settlement delay',()=>{
  const p=position();p.entryPolicy='aligned';p.fundingUsd=0;p.realizedSpreadPnlUsd=0;p.short.lastFundingAt=undefined;
  p.short.entryPrice=100.6;
  const long=quote('binance'),short=quote('bybit',{fundingRate:.002});
  p.profitExitPolicy=profitExitPolicy(long,short,{...defaultConfig,entryPolicy:'aligned'});
  const decision=evaluateHoldingDecision(p,long,short,defaultConfig,now);
  assert.ok(p.profitExitPolicy.earliestExitAt>now);
  assert.equal(decision.action,'close');assert.equal(decision.exitSignal,'profit');
  assert.ok(decision.exitProfit!.netPnlUsd>exitProfitThresholdUsd(p,defaultConfig));
  assert.equal(decision.expectedFundingUsd,.2,'future funding remains a forecast and is excluded from captured cash');
});

test('a bankable aligned profit does not wait for a future funding forecast or rolled clock',()=>{
  for(const changes of [{fundingRate:NaN},{nextFundingTime:NaN},{intervalHours:NaN},{markPrice:NaN},{nextFundingTime:now}]){
    const p=position();p.entryPolicy='aligned';
    // The due first event has a confirmed receipt; later forecast fields do not prove or disprove this cash.
    p.long.lastFundingAt=now-30_000;
    const decision=evaluateHoldingDecision(p,quote('binance',changes),quote('bybit'),defaultConfig,now);
    assert.equal(decision.action,'close',JSON.stringify(changes));assert.equal(decision.exitSignal,'profit');
  }
});

test('unrecorded due funding, negative accrued funding, and unknown costs still block aligned profit capture',()=>{
  const p=position();p.entryPolicy='aligned';const long=quote('binance'),short=quote('bybit');
  assert.equal(evaluateHoldingDecision(p,long,short,defaultConfig,now).action,'close');
  p.short.lastFundingAt=undefined;
  assert.notEqual(evaluateHoldingDecision(p,long,short,defaultConfig,now).action,'close');
  p.short.lastFundingAt=now-30_000;p.fundingUsd=-10;
  assert.equal(evaluateHoldingDecision(p,long,short,defaultConfig,now).action,'hold');
  p.fundingUsd=.4;p.feesUsd=NaN;
  assert.notEqual(evaluateHoldingDecision(p,long,short,defaultConfig,now).action,'close');
});

test('aligned profit can include actual funding without an extra independent spread threshold',()=>{
  const p=position();p.entryPolicy='aligned';p.long.entryPrice=101;p.short.entryPrice=100;
  const long=quote('binance'),short=quote('bybit');
  p.fundingUsd=3;
  const decision=evaluateHoldingDecision(p,long,short,defaultConfig,now);
  assert.ok(decision.exitProfit!.spreadAfterFeesUsd<0);
  assert.ok(decision.exitProfit!.netPnlUsd>exitProfitThresholdUsd(p,defaultConfig));
  assert.equal(decision.action,'close');assert.equal(decision.exitSignal,'profit');
});
