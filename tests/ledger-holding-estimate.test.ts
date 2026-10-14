import assert from 'node:assert/strict';
import test from 'node:test';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountPosition,AppState,ExchangeId,MarketSnapshot,Position} from '../src/shared/types.js';
import {ledgerAccountProjection} from '../web/src/ledger-account-projection.js';
import {ledgerBreakEvenLabel,ledgerHoldingEstimate} from '../web/src/ledger-holding-estimate.js';
import {ledgerPositionMetrics} from '../web/src/ledger-position-metrics.js';

const now=1_000_000;
const row=(side:'long'|'short',base='ARK'):AccountPosition=>({base,symbol:`${base}/USDT:USDT`,side,quantity:100,markPrice:1,
  liquidationPrice:0,leverage:2,entryPrice:side==='long'?.997:.999,unrealizedPnlUsd:side==='long'?.3:-.1,realizedPnlUsd:0,fundingUsd:.2,feesUsd:.05});
const state=():AppState=>({timestamp:now,config:{...structuredClone(defaultConfig),mode:'live',dataSource:'public',entryPolicy:'aligned'},
  running:true,autoEnabled:false,killSwitch:false,liveUnlocked:false,opportunities:[],exchanges:[],logs:[],equity:[],
  totals:{fundingUsd:0,feesUsd:0,spreadPnlUsd:0,netPnlUsd:0,grossExposureUsd:0,availableBalanceUsd:0,openPositions:0},
  risk:{status:'healthy',reasons:[]},positions:[],snapshots:[],livePortfolio:{timestamp:now,pollIntervalMs:5000,maxAgeMs:15000,exchanges:
    (['gate','bitget'] as ExchangeId[]).map((exchange,index)=>({exchange,credentialsConfigured:true,status:'ready',requestedAt:now-100,
      receivedAt:now-50,positions:[{...row(index?'short':'long'),takerFeeRate:index?.0006:.0005,
        takerFeeAt:now-1000,takerFeeSource:'exchange'}]}))}} as AppState);
const snapshot=(exchange:ExchangeId,patch:Partial<MarketSnapshot>={}):MarketSnapshot=>({exchange,base:'ARK',symbol:'ARK/USDT:USDT',
  timestamp:now,observedAt:now,markPrice:1,indexPrice:1,fundingRate:exchange==='gate'?-.001:0,
  nextFundingTime:now+3600000,intervalHours:1,fundingHistory:[],bids:[{price:.999,quantity:1000}],asks:[{price:1.001,quantity:1000}],
  openInterestUsd:1000,volume24hUsd:1000,quantityStep:1,minQuantity:1,minNotional:1,contractSize:1,source:'public',...patch});
const near=(actual:number|undefined,expected:number)=>assert.ok(actual!==undefined&&Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

test('all fresh actual holdings project without adopting an archived journal or mutating state',()=>{
  const s=state(),baseBefore=structuredClone(s);s.livePortfolio!.exchanges[0].positions.push(row('long','XAU'));
  const before=structuredClone(s),records=ledgerAccountProjection(s,now);
  assert.deepEqual(records.map(record=>[record.position.base,record.origin,record.paired]),[['ARK','account',true],['XAU','account',false]]);
  assert.deepEqual(s,before);assert.equal(records[0].position.status,'attention');assert.ok(records[0].position.id.startsWith('account-display:'));
  const old={...records[0].position,id:'archived-ark',status:'closed',accountClosure:{confirmedAt:now-5000,reason:'old cycle',historicalOrdersPending:false}} as Position;
  s.positions=[old];assert.equal(ledgerAccountProjection(s,now).filter(record=>record.origin==='account').length,2);
  assert.deepEqual(old.accountClosure,{confirmedAt:now-5000,reason:'old cycle',historicalOrdersPending:false});assert.equal(baseBefore.positions.length,0);
});

test('a current exact local strategy pair is not duplicated as an external pair',()=>{
  const s=state(),projected=ledgerAccountProjection(s,now)[0].position;s.positions=[{...projected,id:'managed-ark',status:'attention'}];
  const records=ledgerAccountProjection(s,now);assert.equal(records.length,1);assert.equal(records[0].origin,'strategy');
  s.livePortfolio!.exchanges[0].status='error';assert.equal(ledgerAccountProjection(s,now).filter(record=>record.origin==='account').length,0,
    'Stale or missing account data must not fabricate holdings.');
});

test('opposite holdings on one venue stay separate singles without re-reading each other as a pair',()=>{
  const s=state();s.livePortfolio!.exchanges[0].positions=[row('long'),row('short')];s.livePortfolio!.exchanges[1].positions=[];
  const records=ledgerAccountProjection(s,now);assert.equal(records.length,2);assert.equal(records.filter(record=>record.paired).length,0);
  const metrics=records.map(record=>ledgerPositionMetrics(record.position,s.livePortfolio,now));
  assert.deepEqual(metrics.map(value=>value.holding),['single','single']);
  assert.equal(metrics.reduce((sum,value)=>sum+(value.long.quantity??0)+(value.short.quantity??0),0),200);
  near(metrics.reduce((sum,value)=>sum+(value.feesUsd??0),0),.1);
});

test('a known new native opening cycle is displayed once, while the original active record becomes history-only',()=>{
  const s=state(),p={...ledgerAccountProjection(s,now)[0].position,id:'old-cycle',openedAt:1000};s.positions=[p];
  for(const account of s.livePortfolio!.exchanges)account.positions[0].positionOpenedAt=now-1000;
  const before=structuredClone(s),records=ledgerAccountProjection(s,now);
  assert.equal(records.length,2);assert.equal(records[0].historyOnly,true);assert.equal(records[1].origin,'account');
  assert.deepEqual(s,before,'View history classification must not close or rewrite a saved position.');
});

test('attention and external pairs forecast each clock across matching future settlement windows',()=>{
  const s=state();s.snapshots=[snapshot('gate'),snapshot('bitget',{fundingRate:.002,intervalHours:8,nextFundingTime:now+8*3600000})];
  const p=ledgerAccountProjection(s,now)[0].position,m=ledgerPositionMetrics(p,s.livePortfolio,now),estimate=ledgerHoldingEstimate(p,m,s,now);
  assert.equal(p.status,'attention');assert.equal(estimate.nextFundingTime,now+3600000);assert.equal(estimate.targetFundingTime,now+8*3600000);
  assert.equal(estimate.longFundingCount,8);assert.equal(estimate.shortFundingCount,1);near(estimate.fundingUsd,1);
  assert.equal(estimate.legs.length,2);assert.equal(estimate.legs[0].rate,-.001);assert.equal(estimate.legs[1].intervalHours,8);
  assert.equal(estimate.nextReviewAt,now+s.config.pollIntervalMs);
});

test('asynchronous funding displays the nearest debit separately from the later complete-cycle credit',()=>{
  const s=state();s.snapshots=[snapshot('gate',{fundingRate:-.010993,intervalHours:8,nextFundingTime:now+2*3600000}),
    snapshot('bitget',{fundingRate:-.000859,intervalHours:1,nextFundingTime:now+3600000})];
  const before=structuredClone(s),p=ledgerAccountProjection(s,now)[0].position;
  const estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
  assert.equal(estimate.nextFundingTime,now+3600000);near(estimate.nextFundingUsd,-.0859);
  assert.equal(estimate.targetFundingTime,now+2*3600000);near(estimate.fundingUsd,.9275);
  assert.equal(estimate.longFundingCount,1);assert.equal(estimate.shortFundingCount,2);
  assert.equal(estimate.asynchronous,true);assert.equal(estimate.firstPositiveFundingTime,now+2*3600000);
  near(estimate.maxFundingDrawdownUsd,.0859);assert.equal(estimate.fundingEvents?.length,2);
  const [first,last]=estimate.fundingEvents!;
  near(first.longUsd,0);near(first.shortUsd,-.0859);near(first.netUsd,-.0859);near(first.cumulativeUsd,-.0859);
  near(last.longUsd,1.0993);near(last.shortUsd,-.0859);near(last.netUsd,1.0134);near(last.cumulativeUsd,.9275);
  assert.equal(first.projected,false);assert.equal(last.projected,true);
  assert.deepEqual(s,before,'Forecasts must not become account cash, orders or position changes.');
});

test('the full funding-cycle cutoff excludes events occurring only during a long exit delay',()=>{
  const s=state();s.config.exitDelaySec=600;s.snapshots=[snapshot('gate',{fundingRate:-.001,intervalHours:8,nextFundingTime:now+2*3600000-300000}),
    snapshot('bitget',{fundingRate:-.0001,intervalHours:1,nextFundingTime:now+3600000})];
  const p=ledgerAccountProjection(s,now)[0].position,estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
  assert.equal(estimate.targetFundingTime,now+2*3600000-300000);assert.equal(estimate.shortFundingCount,1);
  assert.deepEqual(estimate.fundingEvents?.map(event=>event.time),[now+3600000,now+2*3600000-300000]);near(estimate.fundingUsd,.09);
});

test('simultaneous settlements combine both legs once in the next-event forecast',()=>{
  const s=state();s.snapshots=[snapshot('gate'),snapshot('bitget',{fundingRate:.002})];
  const p=ledgerAccountProjection(s,now)[0].position,estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
  assert.equal(estimate.asynchronous,false);assert.equal(estimate.fundingEvents?.length,1);
  near(estimate.nextFundingUsd,.3);near(estimate.fundingUsd,.3);
  assert.equal(estimate.longFundingCount,1);assert.equal(estimate.shortFundingCount,1);
});

test('receiving a later credit does not claim cumulative funding recovered a larger prior debit',()=>{
  const s=state();s.snapshots=[snapshot('gate',{fundingRate:-.01,intervalHours:8,nextFundingTime:now+2*3600000}),
    snapshot('bitget',{fundingRate:-.1,intervalHours:8,nextFundingTime:now+3600000})];
  const p=ledgerAccountProjection(s,now)[0].position,estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
  near(estimate.nextFundingUsd,-10);near(estimate.fundingUsd,-9);assert.equal(estimate.firstPositiveFundingTime,undefined);
  near(estimate.maxFundingDrawdownUsd,10);
});

test('fresh funding metadata survives a two-second-old websocket book without claiming executable closing prices',()=>{
  const s=state();s.snapshots=[snapshot('gate',{bookTransport:'websocket',timestamp:now-2001,observedAt:now-2001,fundingObservedAt:now-100}),
    snapshot('bitget',{bookTransport:'websocket',timestamp:now-2001,observedAt:now-2001,fundingObservedAt:now-100})];
  const p=ledgerAccountProjection(s,now)[0].position,m=ledgerPositionMetrics(p,s.livePortfolio,now);
  const estimate=ledgerHoldingEstimate(p,m,s,now);
  near(estimate.nextFundingUsd,.1);near(estimate.fundingUsd,.1);assert.equal(estimate.legs[0].rate,-.001);
  assert.equal(estimate.legs[0].observedAt,now-100);assert.equal(estimate.legs[0].nextFundingTime,now+3600000);
  assert.equal(estimate.basis,'unknown');assert.equal(estimate.closeNetPnlUsd,undefined);
  assert.equal(estimate.breakEven,'unknown');assert.equal(ledgerBreakEvenLabel(estimate),'回本待核验');
  assert.equal(estimate.closeBookObservedAt,undefined);assert.equal(estimate.closeBookExpiresAt,undefined);
  assert.ok(estimate.markNetAfterCloseFeeUsd!==undefined);assert.match(estimate.exitReason!,/盘口未完整同步/);
});

test('expired, future and missing funding forecasts do not remove a fresh closing valuation',()=>{
  for(const fundingObservedAt of [now-30001,now+5001,undefined]){
    const s=state();s.snapshots=[snapshot('gate',{bookTransport:'websocket',fundingObservedAt}),
      snapshot('bitget',{bookTransport:'websocket',fundingObservedAt:now})];
    const p=ledgerAccountProjection(s,now)[0].position,estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
    assert.equal(estimate.fundingUsd,undefined);assert.equal(estimate.nextFundingUsd,undefined);
    assert.equal(estimate.legs[0].rate,undefined);assert.equal(estimate.legs[0].nextFundingTime,undefined);
    assert.match(estimate.fundingReason!,/最新费率/);
    assert.equal(estimate.basis,'book');near(estimate.closeNetPnlUsd,.18999);
    assert.equal(estimate.breakEven,'recovered');assert.equal(estimate.closeBookObservedAt,now);
    assert.equal(estimate.closeBookExpiresAt,now+2001);
  }
});

test('break even includes native cash, already paid fees, executable book costs and estimated closing fees once',()=>{
  const s=state();s.config.takerFees.gate=.0005;s.config.takerFees.bitget=.0006;s.snapshots=[snapshot('gate'),snapshot('bitget')];
  const p=ledgerAccountProjection(s,now)[0].position,m=ledgerPositionMetrics(p,s.livePortfolio,now),estimate=ledgerHoldingEstimate(p,m,s,now);
  near(m.netPnlUsd,.5);near(estimate.markNetAfterCloseFeeUsd,.39);near(estimate.closingFeesUsd,.11001);
  near(estimate.closeNetPnlUsd,.18999);assert.equal(estimate.basis,'book');assert.equal(estimate.breakEven,'recovered');
  assert.equal(estimate.closeBookObservedAt,now);assert.equal(estimate.closeBookExpiresAt,now+s.config.maxSnapshotAgeMs+1);
  assert.equal(estimate.closingFeeSource,'exchange');assert.equal(ledgerBreakEvenLabel(estimate),'预计已回本（分批估算）');
  assert.equal(estimate.closePricing,'best-opposite');assert.equal(estimate.closeBatch?.kind,'paired');
  assert.equal(estimate.closeBatch?.longQuantity,100);assert.equal(estimate.closeBatch?.shortQuantity,100);
  assert.equal(p.fundingUsd,0,'A display-only forecast must not manufacture journal cash.');
});

test('native or conservative local Bybit contract fees prevent a false break even from a lower configured fee',()=>{
  const s=state();s.livePortfolio!.exchanges[1].exchange='bybit';s.config.takerFees.gate=.0005;s.config.takerFees.bybit=.00055;
  for(const account of s.livePortfolio!.exchanges){account.positions=[row(account.exchange==='gate'?'long':'short','DGAI')];
    const r=account.positions[0];r.entryPrice=1;r.unrealizedPnlUsd=0;r.fundingUsd=account.exchange==='gate'?.225:0;}
  s.snapshots=[snapshot('gate',{base:'DGAI',symbol:'DGAI/USDT:USDT',bids:[{price:1,quantity:1000}],asks:[{price:1,quantity:1000}]}),
    snapshot('bybit',{base:'DGAI',symbol:'DGAI/USDT:USDT',bids:[{price:1,quantity:1000}],asks:[{price:1,quantity:1000}]})];
  const p=ledgerAccountProjection(s,now)[0].position;
  let estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
  near(estimate.closeNetPnlUsd,-.035);near(estimate.closingFeesUsd,.16);
  assert.equal(estimate.closingFeeSource,'reference');assert.equal(ledgerBreakEvenLabel(estimate),'参考尚未回本（本地费率）');
  assert.ok(estimate.legs.every(leg=>leg.takerFeeSource==='reference'&&leg.takerFeeAt===undefined));
  for(const account of s.livePortfolio!.exchanges)Object.assign(account.positions[0],{
    takerFeeRate:account.exchange==='gate'?.0005:.0011,takerFeeAt:now-1000,takerFeeSource:'exchange'});
  estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
  near(estimate.closingFeesUsd,.16);near(estimate.closeNetPnlUsd,-.035);
  assert.equal(estimate.closingFeeSource,'exchange');assert.equal(estimate.breakEven,'not_recovered');
  assert.equal(ledgerBreakEvenLabel(estimate),'尚未回本');
  s.livePortfolio!.exchanges[1].positions[0].takerFeeAt=now-120001;
  estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
  near(estimate.closeNetPnlUsd,-.035);near(estimate.closingFeesUsd,.16);assert.equal(estimate.closingFeeSource,'reference');
  assert.equal(ledgerBreakEvenLabel(estimate),'参考尚未回本（本地费率）','Expired native fee metadata falls back only as a labelled estimate.');
  assert.equal(estimate.legs[0].takerFeeSource,'exchange');assert.equal(estimate.legs[1].takerFeeSource,'reference');
  assert.equal(estimate.legs[1].takerFeeAt,undefined);
  assert.ok(estimate.fundingUsd!==undefined,'Reference fees do not hide an independently observable funding forecast.');
});

test('fresh native fees take priority over saved account references; expired reads keep the original reference time',()=>{
  const s=state();s.snapshots=[snapshot('gate'),snapshot('bitget')];
  const savedAt=now-500_000;
  for(const account of s.livePortfolio!.exchanges)account.positions[0].feeReference={source:'account-reference',
    takerRate:account.exchange==='gate'?.0003:.0004,observedAt:savedAt};
  const before=structuredClone(s),p=ledgerAccountProjection(s,now)[0].position;
  let estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
  assert.equal(estimate.closingFeeSource,'exchange');near(estimate.closingFeesUsd,.11001);
  for(const account of s.livePortfolio!.exchanges)account.positions[0].takerFeeAt=now-120001;
  estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
  assert.equal(estimate.closingFeeSource,'reference');near(estimate.closingFeesUsd,.07001);
  assert.equal(estimate.legs[0].takerFeeRate,.0003);assert.equal(estimate.legs[1].takerFeeRate,.0004);
  assert.ok(estimate.legs.every(leg=>leg.takerFeeSource==='reference'&&leg.takerFeeReferenceSource==='account-reference'&&
    leg.takerFeeReferenceAt===savedAt&&leg.takerFeeAt===undefined));
  for(const account of s.livePortfolio!.exchanges)account.positions[0].takerFeeAt=before.livePortfolio!.exchanges.find(item=>item.exchange===account.exchange)!.positions[0].takerFeeAt;
  assert.deepEqual(s,before,'Read-only estimates do not refresh or rewrite saved account references.');
});

for(const field of ['realizedPnlUsd','fundingUsd','feesUsd'] as const)
  test(`reference closing fees cannot replace missing actual ${field} with zero`,()=>{
    const s=state();s.snapshots=[snapshot('gate'),snapshot('bitget')];
    for(const account of s.livePortfolio!.exchanges){delete account.positions[0].takerFeeRate;delete account.positions[0].takerFeeAt;}
    delete s.livePortfolio!.exchanges[0].positions[0][field];
    const before=structuredClone(s),p=ledgerAccountProjection(s,now)[0].position;
    const estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
    assert.equal(estimate.closingFeeSource,'reference');assert.ok(Number.isFinite(estimate.closingFeesUsd));
    assert.equal(estimate.closeNetPnlUsd,undefined);assert.equal(estimate.closeBreakdown,undefined);assert.equal(estimate.breakEven,'unknown');
    assert.deepEqual(s,before);
  });

test('positive marking gains can still be not recovered after executable close costs',()=>{
  const s=state();for(const account of s.livePortfolio!.exchanges){const r=account.positions[0];r.fundingUsd=0;r.unrealizedPnlUsd=.1;
    r.entryPrice=r.side==='long'?.999:1.001;}
  s.snapshots=[snapshot('gate'),snapshot('bitget')];
  const p=ledgerAccountProjection(s,now)[0].position,m=ledgerPositionMetrics(p,s.livePortfolio,now),estimate=ledgerHoldingEstimate(p,m,s,now);
  assert.ok(m.netPnlUsd!>0);assert.ok(estimate.closeNetPnlUsd!<0);assert.equal(estimate.breakEven,'not_recovered');
});

test('missing cash or books keeps executable profit and recovery unknown; mark references never replace them',()=>{
  const s=state();s.snapshots=[snapshot('gate'),snapshot('bitget')];delete s.livePortfolio!.exchanges[0].positions[0].realizedPnlUsd;
  const p=ledgerAccountProjection(s,now)[0].position;let estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
  assert.equal(estimate.closeNetPnlUsd,undefined);assert.equal(estimate.breakEven,'unknown');assert.match(estimate.exitReason!,/未完整返回/);
  assert.equal(estimate.markNetAfterCloseFeeUsd,undefined);assert.equal(ledgerBreakEvenLabel(estimate),'回本待核验');
  assert.equal(estimate.basis,'book','The observed complete book remains distinct from missing account cash.');
  s.livePortfolio!.exchanges[0].positions[0].realizedPnlUsd=0;s.snapshots[0].bids=[];
  estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
  assert.equal(estimate.basis,'unknown');assert.equal(estimate.closeNetPnlUsd,undefined);assert.ok(estimate.markNetAfterCloseFeeUsd!==undefined);
  assert.equal(estimate.breakEven,'unknown');assert.equal(ledgerBreakEvenLabel(estimate),'回本待核验');
  assert.equal(estimate.closeBookObservedAt,undefined);assert.equal(estimate.closeBookExpiresAt,undefined);
  s.snapshots[0].observedAt=now-s.config.maxSnapshotAgeMs-1;
  estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
  assert.equal(estimate.fundingUsd,undefined);assert.equal(estimate.nextFundingUsd,undefined);assert.equal(estimate.fundingEvents,undefined);
  assert.equal(estimate.legs[0].rate,undefined);assert.match(estimate.fundingReason!,/最新费率/);
});

test('a missing account mark does not prevent a verified native-entry book valuation',()=>{
  const s=state();s.snapshots=[snapshot('gate'),snapshot('bitget')];s.livePortfolio!.exchanges[0].positions[0].markPrice=NaN;
  const p=ledgerAccountProjection(s,now)[0].position,estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
  assert.equal(estimate.closingFeeSource,'exchange');near(estimate.closeNetPnlUsd,.18999);
  assert.equal(estimate.markNetAfterCloseFeeUsd,undefined);assert.equal(estimate.breakEven,'recovered');
  assert.equal(estimate.basis,'book');assert.equal(estimate.exitReason,undefined);
});

test('a positive mark reference never changes a negative executable close into recovered after book expiry',()=>{
  const s=state();for(const account of s.livePortfolio!.exchanges){const r=account.positions[0];r.fundingUsd=0;r.unrealizedPnlUsd=.15;
    r.entryPrice=r.side==='long'?.9985:1.0015;}
  s.snapshots=[snapshot('gate',{bookTransport:'websocket',fundingObservedAt:now}),snapshot('bitget',{bookTransport:'websocket',fundingObservedAt:now})];
  const p=ledgerAccountProjection(s,now)[0].position;
  let estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
  near(estimate.markNetAfterCloseFeeUsd,.09);near(estimate.closeNetPnlUsd,-.11001);
  assert.equal(estimate.breakEven,'not_recovered');assert.equal(ledgerBreakEvenLabel(estimate),'尚未回本');
  estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now+2001),s,now+2001);
  near(estimate.markNetAfterCloseFeeUsd,.09);assert.equal(estimate.closeNetPnlUsd,undefined);
  assert.equal(estimate.basis,'unknown');assert.equal(estimate.breakEven,'unknown');
  assert.equal(ledgerBreakEvenLabel(estimate),'回本待核验');
});

test('closing book age uses transport-specific limits and reports the earliest actual expiry',()=>{
  const s=state();s.snapshots=[snapshot('gate',{timestamp:now-1000,observedAt:now-1000,bookTransport:'rest'}),
    snapshot('bitget',{timestamp:now-200,observedAt:now-200,bookTransport:'websocket',fundingObservedAt:now})];
  const p=ledgerAccountProjection(s,now)[0].position;
  const value=(at:number)=>ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,at),s,at);
  const current=value(now);assert.equal(current.basis,'book');
  assert.equal(current.closeBookObservedAt,now-1000);assert.equal(current.closeBookExpiresAt,now+1801);
  assert.equal(value(now+1800).basis,'book');assert.equal(value(now+1801).basis,'unknown');
  assert.equal(value(now+1801).breakEven,'unknown');
});

test('unsorted valid levels use opponent top prices for the conditional total and a legal first batch; fees are charged once',()=>{
  const s=state();s.snapshots=[snapshot('gate',{bids:[{price:.998,quantity:75},{price:.999,quantity:25},{price:NaN,quantity:10}],
    asks:[{price:1.003,quantity:1000},{price:1.001,quantity:1000},{price:0,quantity:10}]}),
    snapshot('bitget',{bids:[{price:.998,quantity:1000},{price:.999,quantity:1000}],
      asks:[{price:1.003,quantity:50},{price:1.001,quantity:50},{price:1,quantity:0}]})];
  const before=structuredClone(s),p=ledgerAccountProjection(s,now)[0].position,m=ledgerPositionMetrics(p,s.livePortfolio,now);
  const estimate=ledgerHoldingEstimate(p,m,s,now);
  near(m.netPnlUsd,.5);near(estimate.closingFeesUsd,.11001);near(estimate.closeNetPnlUsd,.18999);
  assert.equal(estimate.basis,'book');assert.equal(estimate.breakEven,'recovered');
  assert.deepEqual(estimate.closeBatch,{kind:'paired',longQuantity:25,shortQuantity:25,longTotalQuantity:100,shortTotalQuantity:100,
    longEntryPrice:.997,shortEntryPrice:.999,longLimitPrice:.999,shortLimitPrice:1.001,longTopQuantity:25,shortTopQuantity:50,
    longTakerFeeRate:.0005,shortTakerFeeRate:.0006});
  assert.deepEqual(s,before,'Sorting books for a valuation must not mutate shared snapshots or account cash.');
});

test('a crossed best book hidden behind unsorted or invalid leading levels is never executable',()=>{
  for(const leading of [{price:.9,quantity:100},{price:NaN,quantity:100}]){
    const s=state();s.snapshots=[snapshot('gate',{bids:[leading,{price:1.002,quantity:100}],
      asks:[{price:1.003,quantity:100},{price:1.001,quantity:100}]}),snapshot('bitget')];
    const p=ledgerAccountProjection(s,now)[0].position,estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
    assert.equal(estimate.basis,'unknown');assert.equal(estimate.closeNetPnlUsd,undefined);assert.equal(estimate.breakEven,'unknown');
    assert.equal(estimate.closeBookObservedAt,undefined);assert.ok(estimate.markNetAfterCloseFeeUsd!>0);
  }
});

test('both valid book sides and at least one legal shared top-price close batch are required',()=>{
  const cases=[{exchange:'gate' as const,patch:{asks:[]}},
    {exchange:'bitget' as const,patch:{bids:[{price:.999,quantity:0}]}},
    {exchange:'gate' as const,patch:{bids:[{price:.999,quantity:.5}]}},
    {exchange:'bitget' as const,patch:{asks:[{price:1.001,quantity:.5}]}}];
  for(const item of cases){
    const s=state();s.snapshots=[snapshot('gate',item.exchange==='gate'?item.patch:{}),snapshot('bitget',item.exchange==='bitget'?item.patch:{})];
    const p=ledgerAccountProjection(s,now)[0].position,estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
    assert.equal(estimate.basis,'unknown');assert.equal(estimate.closeNetPnlUsd,undefined);assert.equal(estimate.breakEven,'unknown');
    assert.equal(estimate.closeBookExpiresAt,undefined);
  }
});

test('a thin first level prices the conditional whole holding while explicitly exposing only the shared first batch',()=>{
  const s=state();s.snapshots=[snapshot('gate',{bids:[{price:.999,quantity:3},{price:.8,quantity:97}]}),
    snapshot('bitget',{asks:[{price:1.001,quantity:2},{price:1.3,quantity:98}]})];
  const p=ledgerAccountProjection(s,now)[0].position,m=ledgerPositionMetrics(p,s.livePortfolio,now),estimate=ledgerHoldingEstimate(p,m,s,now);
  near(estimate.closeNetPnlUsd,.18999);near(estimate.closingFeesUsd,.11001);
  assert.equal(estimate.closePricing,'best-opposite');assert.equal(estimate.closeBatch?.longQuantity,2);assert.equal(estimate.closeBatch?.shortQuantity,2);
  assert.equal(estimate.closeBatch?.longTotalQuantity,100);assert.equal(estimate.closeBatch?.shortTotalQuantity,100);
  assert.equal(estimate.closeBatch?.longTopQuantity,3);assert.equal(estimate.closeBatch?.shortTopQuantity,2);
  assert.equal(estimate.closeBatch?.longLimitPrice,.999);assert.equal(estimate.closeBatch?.shortLimitPrice,1.001);
});

test('a partial top-price batch is sufficient without treating an opening minimum notional as a close constraint',()=>{
  const s=state();s.snapshots=[snapshot('gate',{minNotional:100,bids:[{price:.999,quantity:99}]}),
    snapshot('bitget',{minNotional:100,asks:[{price:1.001,quantity:99}]})];
  const p=ledgerAccountProjection(s,now)[0].position,estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
  assert.equal(estimate.basis,'book');near(estimate.closeNetPnlUsd,.18999);
  assert.equal(estimate.closeBatch?.longQuantity,99);assert.equal(estimate.closeBatch?.longTotalQuantity,100);
});

test('the first shared top-price batch respects both native quantity grids without rounding the displayed total holdings',()=>{
  const s=state();s.snapshots=[snapshot('gate',{quantityStep:3,minQuantity:3,bids:[{price:.999,quantity:23}]}),
    snapshot('bitget',{quantityStep:2,minQuantity:2,asks:[{price:1.001,quantity:21}]})];
  const p=ledgerAccountProjection(s,now)[0].position,estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
  assert.equal(estimate.basis,'book');assert.equal(estimate.closeBatch?.longQuantity,18);assert.equal(estimate.closeBatch?.shortQuantity,18);
  assert.equal(estimate.closeBatch?.longTotalQuantity,100);assert.equal(estimate.closeBatch?.shortTotalQuantity,100);
  near(estimate.closeNetPnlUsd,.18999);
});

test('an imbalanced pair first reduces only its legal excess while valuing both actual holdings',()=>{
  const s=state();s.livePortfolio!.exchanges[0].positions[0].quantity=120;
  s.livePortfolio!.exchanges[0].positions[0].unrealizedPnlUsd=.36;
  s.snapshots=[snapshot('gate',{bids:[{price:.999,quantity:12}]}),snapshot('bitget',{asks:[{price:1.001,quantity:10}]})];
  const p=ledgerAccountProjection(s,now)[0].position,m=ledgerPositionMetrics(p,s.livePortfolio,now),estimate=ledgerHoldingEstimate(p,m,s,now);
  assert.equal(m.holding,'imbalanced');assert.equal(estimate.closeBatch?.kind,'excess-long');
  assert.equal(estimate.closeBatch?.longQuantity,12);assert.equal(estimate.closeBatch?.shortQuantity,0);
  assert.equal(estimate.closeBatch?.longTotalQuantity,120);assert.equal(estimate.closeBatch?.shortTotalQuantity,100);
  near(estimate.closeNetPnlUsd,m.netPnlUsd!-.12-.1-(120*.999*.0005+100*1.001*.0006));
});

test('single actual holdings show their own legal first batch and full conditional quantity without inventing another leg',()=>{
  const s=state();s.livePortfolio!.exchanges[0].positions=[];
  s.snapshots=[snapshot('bitget',{asks:[{price:1.001,quantity:17}]})];
  const p=ledgerAccountProjection(s,now)[0].position,m=ledgerPositionMetrics(p,s.livePortfolio,now),estimate=ledgerHoldingEstimate(p,m,s,now);
  assert.equal(m.holding,'single');assert.equal(estimate.closeBatch?.kind,'single-short');
  assert.equal(estimate.closeBatch?.longQuantity,0);assert.equal(estimate.closeBatch?.shortQuantity,17);
  assert.equal(estimate.closeBatch?.longTotalQuantity,0);assert.equal(estimate.closeBatch?.shortTotalQuantity,100);
  assert.equal(estimate.closeBatch?.longLimitPrice,undefined);near(estimate.closeNetPnlUsd,m.netPnlUsd!-.1-100*1.001*.0006);
});

test('a first excess below the native reduction minimum stays unknown instead of reducing the paired quantity arbitrarily',()=>{
  const s=state();s.livePortfolio!.exchanges[0].positions[0].quantity=106;
  s.snapshots=[snapshot('gate',{quantityStep:10,minQuantity:10}),snapshot('bitget')];
  const p=ledgerAccountProjection(s,now)[0].position,estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
  assert.equal(estimate.basis,'unknown');assert.equal(estimate.closeNetPnlUsd,undefined);assert.equal(estimate.closeBatch,undefined);
  assert.match(estimate.exitReason!,/合法平仓批次/);
});

test('stale or too-far future books and excessive two-leg skew cannot publish executable profit',()=>{
  for(const patch of [{timestamp:now+5001},{observedAt:now+5001},{timestamp:NaN},
    {observedAt:now-30001},{timestamp:now-3001,observedAt:now-3001}]){
    const s=state();s.snapshots=[snapshot('gate',patch),snapshot('bitget')];
    const p=ledgerAccountProjection(s,now)[0].position,estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
    assert.equal(estimate.basis,'unknown');assert.equal(estimate.closeNetPnlUsd,undefined);assert.equal(estimate.breakEven,'unknown');
  }
});

test('book close net uses native entry prices even when exchange UPL changes or disagrees with the reported mark',()=>{
  for(const unrealized of [-1000,0,1000,undefined]){
    const s=state();s.snapshots=[snapshot('gate'),snapshot('bitget')];
    for(const account of s.livePortfolio!.exchanges)account.positions[0].unrealizedPnlUsd=unrealized;
    const p=ledgerAccountProjection(s,now)[0].position;
    // A saved fill belongs to the original journal and cannot replace the fresh native entry.
    p.long.entryPrice=10;p.short.entryPrice=.1;p.netPnlUsd=9999;
    const before=structuredClone(s),metrics=ledgerPositionMetrics(p,s.livePortfolio,now);
    const estimate=ledgerHoldingEstimate(p,metrics,s,now);
    near(estimate.closeNetPnlUsd,.18999);near(estimate.closingFeesUsd,.11001);
    assert.equal(estimate.breakEven,'recovered');assert.equal(estimate.basis,'book');
    if(unrealized===undefined){assert.equal(metrics.unrealizedPnlUsd,undefined);assert.equal(metrics.netPnlUsd,undefined);}
    else near(metrics.unrealizedPnlUsd,unrealized*2);
    assert.deepEqual(s,before,'Valuing native entries must not replace exchange UPL or rewrite saved fills.');
  }
});

test('complete native entry and cash permit closing estimates without any account mark or UPL',()=>{
  const s=state();s.snapshots=[snapshot('gate'),snapshot('bitget')];
  for(const account of s.livePortfolio!.exchanges){account.positions[0].markPrice=NaN;delete account.positions[0].unrealizedPnlUsd;}
  const p=ledgerAccountProjection(s,now)[0].position,metrics=ledgerPositionMetrics(p,s.livePortfolio,now);
  assert.equal(metrics.netPnlUsd,undefined);assert.equal(metrics.long.markPrice,undefined);assert.equal(metrics.short.markPrice,undefined);
  const estimate=ledgerHoldingEstimate(p,metrics,s,now);
  near(estimate.closeNetPnlUsd,.18999);near(estimate.closingFeesUsd,.11001);
  assert.equal(estimate.markNetAfterCloseFeeUsd,undefined);assert.equal(estimate.basis,'book');assert.equal(estimate.breakEven,'recovered');
});

test('an absent or invalid native entry never borrows a saved journal entry to claim closing profit',()=>{
  for(const entry of [undefined,NaN,Infinity,0,-1]){
    const s=state();s.snapshots=[snapshot('gate'),snapshot('bitget')];
    const p=ledgerAccountProjection(s,now)[0].position;p.long.entryPrice=.0001;
    s.livePortfolio!.exchanges[0].positions[0].entryPrice=entry;
    const estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
    assert.equal(estimate.closeNetPnlUsd,undefined);assert.equal(estimate.breakEven,'unknown');
    assert.match(estimate.exitReason!,/开仓.*价|成本/);
  }
});

test('weighted native entries value every actual row while mixed cash remains account sourced',()=>{
  const s=state();s.snapshots=[snapshot('gate'),snapshot('bitget')];
  const p=ledgerAccountProjection(s,now)[0].position;delete p.long.accountPositionKey;
  const original=s.livePortfolio!.exchanges[0].positions[0];
  s.livePortfolio!.exchanges[0].positions=[
    {...original,quantity:40,entryPrice:.995,unrealizedPnlUsd:.2,fundingUsd:.08,feesUsd:.02},
    {...original,quantity:60,entryPrice:.998,unrealizedPnlUsd:.12,fundingUsd:.12,feesUsd:.03}];
  const metrics=ledgerPositionMetrics(p,s.livePortfolio,now),estimate=ledgerHoldingEstimate(p,metrics,s,now);
  near(metrics.long.entryPrice,.9968);near(metrics.long.quantity,100);near(metrics.fundingUsd,.4);near(metrics.feesUsd,.1);
  near(estimate.closeNetPnlUsd,.20999);near(estimate.closingFeesUsd,.11001);
  assert.equal(estimate.closeBatch?.longTotalQuantity,100);assert.equal(estimate.closeBatch?.longQuantity,100);
  delete s.livePortfolio!.exchanges[0].positions[1].entryPrice;
  const incomplete=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
  assert.equal(incomplete.closeNetPnlUsd,undefined);assert.equal(incomplete.breakEven,'unknown');
});

test('closing net subtracts verified paid cash costs and remaining closing fees exactly once',()=>{
  const s=state();s.snapshots=[snapshot('gate'),snapshot('bitget')];
  const p=ledgerAccountProjection(s,now)[0].position;p.transferCostUsd=.025;
  s.livePortfolio!.exchanges[0].positions[0].realizedPnlUsd=.03;
  s.livePortfolio!.exchanges[1].positions[0].realizedPnlUsd=-.01;
  const estimate=ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now);
  near(estimate.closeNetPnlUsd,.18499);near(estimate.closingFeesUsd,.11001);
  near(estimate.closeBreakdown?.pricePnlUsd,0);near(estimate.closeBreakdown?.realizedPnlUsd,.02);
  near(estimate.closeBreakdown?.fundingUsd,.4);near(estimate.closeBreakdown?.paidFeesUsd,.1);
  near(estimate.closeBreakdown?.closingFeesUsd,.11001);near(estimate.closeBreakdown?.transferCostUsd,.025);
  // The two imminent funding rates are forecasts only; changing them cannot change accrued closing cash.
  s.snapshots[0].fundingRate=-.9;s.snapshots[1].fundingRate=.9;
  near(ledgerHoldingEstimate(p,ledgerPositionMetrics(p,s.livePortfolio,now),s,now).closeNetPnlUsd,.18499);
});

test('a later native opening cycle cannot price an old strategy record with current account cash',()=>{
  const s=state();s.snapshots=[snapshot('gate'),snapshot('bitget')];
  const projected=ledgerAccountProjection(s,now)[0].position;
  const p={...projected,id:'old-strategy-cycle',openedAt:1000};
  for(const account of s.livePortfolio!.exchanges)account.positions[0].positionOpenedAt=now-1000;
  const metrics=ledgerPositionMetrics(p,s.livePortfolio,now);assert.equal(metrics.cycleMismatch,true);
  const blocked=ledgerHoldingEstimate(p,metrics,s,now);
  assert.equal(blocked.closeNetPnlUsd,undefined);assert.equal(blocked.breakEven,'unknown');
  const external={...p,id:'account-display:current-pair'};
  near(ledgerHoldingEstimate(external,ledgerPositionMetrics(external,s.livePortfolio,now),s,now).closeNetPnlUsd,.18999);
});

test('SIREN screenshot is explained by native entries and opponent prices without forcing mark UPL into closing cash',()=>{
  const s=state();s.livePortfolio!.exchanges[0].exchange='bitget';s.livePortfolio!.exchanges[1].exchange='bybit';
  s.livePortfolio!.exchanges[0].positions=[{...row('long','SIREN'),quantity:4380,entryPrice:.02284,markPrice:.02281,
    unrealizedPnlUsd:-.1314,fundingUsd:0,feesUsd:.06002352,takerFeeRate:.0006,takerFeeAt:now,takerFeeSource:'exchange'}];
  s.livePortfolio!.exchanges[1].positions=[{...row('short','SIREN'),quantity:4380,entryPrice:.02289,markPrice:.023,
    unrealizedPnlUsd:-.4818,fundingUsd:0,feesUsd:.11028403,takerFeeRate:.0011,takerFeeAt:now,takerFeeSource:'exchange'}];
  s.snapshots=[snapshot('bitget',{base:'SIREN',symbol:'SIREN/USDT:USDT',quantityStep:10,
    bids:[{price:.0228,quantity:7620}],asks:[{price:.02281,quantity:9000}]}),
    snapshot('bybit',{base:'SIREN',symbol:'SIREN/USDT:USDT',quantityStep:10,
    bids:[{price:.02281,quantity:5000}],asks:[{price:.02282,quantity:3340}]})];
  const p=ledgerAccountProjection(s,now)[0].position,metrics=ledgerPositionMetrics(p,s.livePortfolio,now);
  const estimate=ledgerHoldingEstimate(p,metrics,s,now),grossPrice=4380*(.0228-.02284)+4380*(.02289-.02282);
  near(metrics.unrealizedPnlUsd,-.6132);near(grossPrice,.1314);near(metrics.feesUsd,.17030755);
  near(estimate.closingFeesUsd,.16986516);near(estimate.closeNetPnlUsd,-.20877271);
  near(estimate.closeBreakdown?.pricePnlUsd,.1314);near(estimate.closeBreakdown?.realizedPnlUsd,0);
  near(estimate.closeBreakdown?.fundingUsd,0);near(estimate.closeBreakdown?.paidFeesUsd,.17030755);
  near(estimate.closeBreakdown?.closingFeesUsd,.16986516);near(estimate.closeBreakdown?.transferCostUsd,0);
  assert.equal(estimate.closeBatch?.longQuantity,3340);assert.equal(estimate.closeBatch?.shortQuantity,3340);
  assert.equal(estimate.closeBatch?.longTotalQuantity,4380);assert.equal(estimate.closeBatch?.shortTotalQuantity,4380);
  assert.equal(estimate.breakEven,'not_recovered');
});
