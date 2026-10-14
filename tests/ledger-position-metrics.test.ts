import test from 'node:test';
import assert from 'node:assert/strict';
import {ledgerPositionMetrics,liquidationObservationLabel} from '../web/src/ledger-position-metrics.js';
import type {AccountPosition,LivePortfolio,Position} from '../src/shared/types.js';

const now=100000;
const position=():Position=>({id:'observed-soon',base:'SOON',mode:'live',status:'attention',openedAt:1000,plannedExitAt:200000,holdMode:'adaptive',entryPolicy:'aligned',
  long:{exchange:'bitget',symbol:'SOON/USDT:USDT',side:'long',quantity:234,entryPrice:.4251,markPrice:.42,feesUsd:.05,liquidationDistancePct:48},
  short:{exchange:'bybit',symbol:'SOON/USDT:USDT',side:'short',quantity:234,entryPrice:.4262,markPrice:.43,feesUsd:.06,liquidationDistancePct:472},
  fundingUsd:999,feesUsd:888,transferCostUsd:0,spreadPnlUsd:777,realizedSpreadPnlUsd:666,netPnlUsd:555,deltaUsd:444,fundingEvents:[],riskReasons:['管理暂停']});
const row=(side:'long'|'short'):AccountPosition=>({base:'SOON',symbol:'SOON/USDT:USDT',side,quantity:234,markPrice:side==='long'?.4265:.4276,
  liquidationPrice:side==='long'?0:2.3744748,liquidationStatus:side==='long'?'not_liquidatable':'price',
  liquidationReason:side==='long'?'全仓账户无单仓强平价':undefined,leverage:2,entryPrice:side==='long'?.425133333334:.4262,
  unrealizedPnlUsd:side==='long'?.31979999:-.3276,realizedPnlUsd:0,fundingUsd:0,feesUsd:side==='long'?.05968872:.05485194});
const portfolio=():LivePortfolio=>({timestamp:now,pollIntervalMs:5000,maxAgeMs:15000,exchanges:['bitget','bybit'].map((exchange,index)=>({
  exchange:exchange as 'bitget'|'bybit',credentialsConfigured:true,status:'ready',requestedAt:now-100,receivedAt:now-50,positions:[row(index?'short':'long')]}))});
const near=(actual:number|undefined,expected:number)=>assert.ok(actual!==undefined&&Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);

test('current PnL uses exact fresh exchange values without public quotes or rounded journal prices',()=>{
  const p=position(),before=structuredClone(p),data=portfolio(),metrics=ledgerPositionMetrics(p,data,now);
  assert.equal(metrics.holding,'paired');assert.equal(metrics.source,'account');
  near(metrics.unrealizedPnlUsd,-.00780001);near(metrics.fundingUsd,0);near(metrics.feesUsd,.11454066);
  near(metrics.netPnlUsd,-.12234067);assert.equal(metrics.deltaUsd,0);assert.equal(metrics.deltaQuantity,0);
  assert.deepEqual(p,before,'Displaying a live metric must not rewrite or resume the attention record.');
});
test('pure realized price PnL is included once while old journal cash stays separate',()=>{
  const p=position(),data=portfolio();data.exchanges[0].positions[0].realizedPnlUsd=.35;
  data.exchanges[1].positions[0].realizedPnlUsd=-.1;data.exchanges[1].positions[0].fundingUsd=.2;
  const metrics=ledgerPositionMetrics(p,data,now);near(metrics.realizedPnlUsd,.25);near(metrics.netPnlUsd,.32765933);
  assert.equal(p.realizedSpreadPnlUsd,666);assert.equal(p.fundingUsd,999);
});
test('missing realized component is an explicit subtotal; missing funding or fees never fabricates zero',()=>{
  const data=portfolio();delete data.exchanges[0].positions[0].realizedPnlUsd;
  const metrics=ledgerPositionMetrics(position(),data,now);assert.equal(metrics.netPnlUsd,undefined);near(metrics.observedSubtotalUsd,-.12234067);
  delete data.exchanges[0].positions[0].fundingUsd;
  const incomplete=ledgerPositionMetrics(position(),data,now);assert.equal(incomplete.fundingUsd,undefined);assert.equal(incomplete.observedSubtotalUsd,undefined);
  near(incomplete.unrealizedPnlUsd,-.00780001);near(incomplete.feesUsd,.11454066);
});

test('per-leg bill status and original cash time reach the strategy view without changing amounts',()=>{
  const p=position(),data=portfolio();
  Object.assign(data.exchanges[1].positions[0],{cashFlowStatus:'incomplete',cashFlowReason:'账单无法完整归属当前持仓周期',cashFlowAt:now-30_000});
  const before=structuredClone(data),metrics=ledgerPositionMetrics(p,data,now);
  assert.equal(metrics.short.cashFlowStatus,'incomplete');assert.equal(metrics.short.cashFlowReason,'账单无法完整归属当前持仓周期');
  assert.equal(metrics.short.cashFlowAt,now-30_000);assert.equal(metrics.long.cashFlowStatus,undefined);
  near(metrics.netPnlUsd,-.12234067);assert.deepEqual(data,before);
});

test('a split leg keeps incomplete bill evidence and earliest complete cash observation',()=>{
  const data=portfolio(),first={...data.exchanges[1].positions[0],quantity:100,cashFlowStatus:'ready' as const,cashFlowAt:now-1000};
  const second={...first,quantity:134,cashFlowStatus:'error' as const,cashFlowReason:'账单请求失败，后台会自动重试',cashFlowAt:now-2000};
  data.exchanges[1].positions=[first,second];
  const metrics=ledgerPositionMetrics(position(),data,now);
  assert.equal(metrics.short.cashFlowStatus,'error');assert.equal(metrics.short.cashFlowAt,now-2000);
  assert.equal(metrics.short.fundingUsd,0);near(metrics.short.feesUsd,.10970388);
  delete data.exchanges[1].positions[1].fundingUsd;
  const missing=ledgerPositionMetrics(position(),data,now);assert.equal(missing.short.fundingUsd,undefined);assert.equal(missing.fundingUsd,undefined);
});
test('actual single leg remains displayable without pretending the missing leg has a liquidation distance',()=>{
  const data=portfolio();data.exchanges[1].positions=[];
  const metrics=ledgerPositionMetrics(position(),data,now);assert.equal(metrics.holding,'single');assert.equal(metrics.short.quantity,0);
  near(metrics.deltaUsd,234*.4265);assert.equal(metrics.netPnlUsd,undefined,'A previously traded now-flat leg has unverified closed-cycle cash.');
  assert.equal(liquidationObservationLabel(metrics.short),'无仓位');
  assert.equal(liquidationObservationLabel(metrics.long),'全仓账户无单仓强平价');
});

test('an absent leg with no confirmed opening history can report true zero cash without hiding a closed-leg loss',()=>{
  const data=portfolio();data.exchanges[1].positions=[];const p=position();
  const closed=ledgerPositionMetrics(p,data,now);assert.equal(closed.short.realizedPnlUsd,undefined);assert.equal(closed.short.feesUsd,undefined);
  p.short.quantity=0;p.short.entryPrice=0;p.short.feesUsd=0;
  const neverOpened=ledgerPositionMetrics(p,data,now);assert.equal(neverOpened.short.realizedPnlUsd,0);assert.equal(neverOpened.short.fundingUsd,0);
  near(neverOpened.netPnlUsd,.26011127);
});
test('directional delta depends on coin imbalance, not the cross-exchange mark price difference',()=>{
  const data=portfolio();data.exchanges[1].positions[0].quantity=230;
  const metrics=ledgerPositionMetrics(position(),data,now);assert.equal(metrics.holding,'imbalanced');assert.equal(metrics.deltaQuantity,4);
  near(metrics.deltaUsd,4*(.4265+.4276)/2);assert.equal(metrics.ledgerQuantitiesMatch,false);
});
test('stale, failed or pre-submission account reads cannot produce complete current metrics',()=>{
  for(const change of [(data:LivePortfolio)=>{data.exchanges[1].requestedAt=now-15001;},
    (data:LivePortfolio)=>{data.exchanges[1].status='error';},(data:LivePortfolio)=>{data.exchanges[1].requestedAt=999;}]){
    const data=portfolio();change(data);const metrics=ledgerPositionMetrics(position(),data,now);
    assert.equal(metrics.holding,'unknown');assert.equal(metrics.unrealizedPnlUsd,undefined);assert.equal(metrics.netPnlUsd,undefined);
    assert.equal(metrics.deltaUsd,undefined);assert.equal(liquidationObservationLabel(metrics.short),'待读取');
  }
});
test('a different contract with the same ticker never lends quantity, cash or PnL to a ledger leg',()=>{
  const data=portfolio();data.exchanges[0].positions[0].symbol='SOON/USDC:USDC';
  const metrics=ledgerPositionMetrics(position(),data,now);assert.equal(metrics.long.quantity,0);assert.equal(metrics.holding,'single');
  near(metrics.unrealizedPnlUsd,-.3276);near(metrics.short.feesUsd,.05485194);assert.equal(metrics.feesUsd,undefined,
    'The unmatched original contract cannot borrow current fee cash from a different settlement currency.');
});
test('archived flat records do not revive from a later same-coin current holding or invent final PnL',()=>{
  const p=position();p.accountClosure={confirmedAt:now-5000,reason:'账户已空仓',historicalOrdersPending:true};
  const metrics=ledgerPositionMetrics(p,portfolio(),now);assert.equal(metrics.holding,'flat');assert.equal(metrics.netPnlUsd,undefined);
  assert.equal(metrics.long.quantity,undefined);assert.equal(metrics.short.quantity,undefined);
  p.status='closed';assert.equal(ledgerPositionMetrics(p,portfolio(),now).netPnlUsd,p.netPnlUsd);
});
test('explicit later opening cycle remains separate from historical strategy cash',()=>{
  const data=portfolio();data.exchanges[0].positions[0].positionOpenedAt=90000;
  const metrics=ledgerPositionMetrics(position(),data,now);assert.equal(metrics.cycleMismatch,true);
  near(metrics.fundingUsd,0);near(metrics.netPnlUsd,-.12234067);
});
test('zero liquidation price explains unavailable venue evidence instead of calculating a fake percentage',()=>{
  const data=portfolio(),long=data.exchanges[0].positions[0];delete long.liquidationStatus;delete long.liquidationReason;
  assert.equal(liquidationObservationLabel(ledgerPositionMetrics(position(),data,now).long),'交易所未返回强平价');
  const metrics=ledgerPositionMetrics(position(),portfolio(),now);assert.match(liquidationObservationLabel(metrics.short),/^455\.30%$/);
});

test('observed native entries remain precise and independent of saved execution entries',()=>{
  const p=position(),data=portfolio(),before=structuredClone(p),metrics=ledgerPositionMetrics(p,data,now);
  near(metrics.long.entryPrice,.425133333334);near(metrics.short.entryPrice,.4262);
  assert.notEqual(metrics.long.entryPrice,p.long.entryPrice);assert.deepEqual(p,before);
});

test('multiple native rows average their entry price by actual coin quantity without selecting a convenient row',()=>{
  const p=position(),data=portfolio(),original=data.exchanges[0].positions[0];
  data.exchanges[0].positions=[{...original,quantity:84,entryPrice:.42,unrealizedPnlUsd:84*(.4265-.42),feesUsd:.02},
    {...original,quantity:150,entryPrice:.43,unrealizedPnlUsd:150*(.4265-.43),feesUsd:.03968872}];
  const before=structuredClone(data),metrics=ledgerPositionMetrics(p,data,now);
  near(metrics.long.quantity,234);near(metrics.long.entryPrice,(84*.42+150*.43)/234);
  near(metrics.long.unrealizedPnlUsd,84*(.4265-.42)+150*(.4265-.43));
  near(metrics.long.feesUsd,.05968872);assert.deepEqual(data,before);
});

test('one missing or invalid native row entry leaves aggregate cost unknown instead of using the saved ledger',()=>{
  for(const entry of [undefined,NaN,Infinity,0,-1]){
    const p=position(),data=portfolio(),original=data.exchanges[0].positions[0];
    data.exchanges[0].positions=[{...original,quantity:100,entryPrice:.42},{...original,quantity:134,entryPrice:entry}];
    const metrics=ledgerPositionMetrics(p,data,now);
    near(metrics.long.quantity,234);assert.equal(metrics.long.entryPrice,undefined);
    assert.equal(metrics.short.entryPrice,.4262);assert.ok(Number.isFinite(metrics.fundingUsd));
  }
});

test('missing or inconsistent native UPL is retained as an observation without hiding valid native entry or cash',()=>{
  for(const pnl of [undefined,12345,-12345]){
    const data=portfolio();data.exchanges[0].positions[0].unrealizedPnlUsd=pnl;
    const metrics=ledgerPositionMetrics(position(),data,now);
    assert.equal(metrics.long.unrealizedPnlUsd,pnl);near(metrics.long.entryPrice,.425133333334);
    near(metrics.realizedPnlUsd,0);near(metrics.fundingUsd,0);near(metrics.feesUsd,.11454066);
    if(pnl===undefined){assert.equal(metrics.unrealizedPnlUsd,undefined);assert.equal(metrics.netPnlUsd,undefined);}
    else near(metrics.unrealizedPnlUsd,pnl-.3276);
  }
});

test('missing native marks leave precise entry costs and current-cycle cash available',()=>{
  const data=portfolio();data.exchanges[0].positions[0].markPrice=NaN;
  const metrics=ledgerPositionMetrics(position(),data,now);
  assert.equal(metrics.long.markPrice,undefined);near(metrics.long.entryPrice,.425133333334);
  near(metrics.feesUsd,.11454066);near(metrics.realizedPnlUsd,0);near(metrics.fundingUsd,0);
});
