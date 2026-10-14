import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../src/shared/config.js';
import {exitProfitThresholdUsd,exitNetProfitBps,profitExitNotionalUsd,freezeProfitExitNotional} from '../src/core/exit-profit-threshold.js';
import type {AppConfig,JournalOrder,Position} from '../src/shared/types.js';

const config:AppConfig={...defaultConfig,minExitProfitBps:10};
function position(quantity=1,longEntry=100,shortEntry=100):Position {
  return {id:'offline-original-position',base:'BTC',mode:'live',status:'open',entryPolicy:'aligned',holdMode:'adaptive',
    long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long',quantity,entryPrice:longEntry,markPrice:100,feesUsd:.02,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short',quantity,entryPrice:shortEntry,markPrice:100,feesUsd:.02,liquidationDistancePct:null},
    openedAt:1_000,plannedExitAt:2_000,fundingUsd:0,feesUsd:.04,transferCostUsd:0,realizedSpreadPnlUsd:0,
    spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
}
function closeOrder(leg:'long'|'short',quantity:number,changes:Partial<JournalOrder>={}):JournalOrder {
  const p=position(),slot=p[leg],clientOrderId=`offline-close-${leg}`;
  return {positionId:p.id,exchange:slot.exchange,createdAt:1_500,
    request:{clientOrderId,base:p.base,symbol:slot.symbol,side:leg==='long'?'sell':'buy',quantity,limitPrice:100,reduceOnly:true},
    result:{id:`offline-native-${leg}`,clientOrderId,status:'partial',filledQuantity:quantity,averagePrice:100,feeUsd:.001,timestamp:1_501},...changes};
}
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);

test('ten bps of the original single-leg notional maps 50, 100 and 200 USD to .05, .10 and .20 USD',()=>{
  for(const [notional,threshold] of [[50,.05],[100,.1],[200,.2]]){
    const p=position();p.profitExitNotionalUsd=notional;assert.equal(exitProfitThresholdUsd(p,config),threshold);
    assert.equal(exitNetProfitBps(p,threshold),10);assert.equal(exitNetProfitBps(p,-threshold),-10);
  }
});

test('opening basis is the average of actual two-leg opening values, independent of mark and leverage',()=>{
  const p=position(2,90,110);p.long.markPrice=1;p.short.markPrice=10_000;
  assert.equal(profitExitNotionalUsd(p),200);assert.equal(freezeProfitExitNotional(p,[]),true);
  assert.equal(p.profitExitNotionalUsd,200);assert.equal(exitProfitThresholdUsd(p,{...config,leverage:20}),.2);
});

test('freezing the original notional before reduction keeps the threshold after quantities halve or close',()=>{
  const p=position();assert.equal(freezeProfitExitNotional(p,[]),true);
  p.long.quantity=p.short.quantity=.5;assert.equal(freezeProfitExitNotional(p,[closeOrder('long',.5),closeOrder('short',.5)]),false);
  assert.equal(p.profitExitNotionalUsd,100);assert.equal(exitProfitThresholdUsd(p,config),.1);
  p.long.quantity=p.short.quantity=0;p.status='closed';assert.equal(exitProfitThresholdUsd(p,config),.1);
  assert.equal(exitNetProfitBps(p,.15),15);
});

test('historical remaining quantities plus their own confirmed reducing receipts reconstruct original notional once',()=>{
  const p=position(.4,90,110),orders=[closeOrder('long',.2),closeOrder('long',.4),closeOrder('short',.6)],before=structuredClone(orders);
  assert.equal(freezeProfitExitNotional(p,orders),true);assert.equal(p.profitExitNotionalUsd,100);assert.equal(exitProfitThresholdUsd(p,config),.1);
  p.long.quantity=p.short.quantity=.2;assert.equal(freezeProfitExitNotional(p,orders),false);assert.equal(p.profitExitNotionalUsd,100);
  assert.deepEqual(orders,before,'recovery never changes original requests or receipt cash');
});

test('a fully closed historical position can recover its basis from confirmed closing quantities',()=>{
  const p=position(0,90,110);p.status='closed';
  assert.equal(freezeProfitExitNotional(p,[closeOrder('long',1),closeOrder('short',1)]),true);
  assert.equal(profitExitNotionalUsd(p),100);assert.equal(exitProfitThresholdUsd(p,config),.1);
});

test('opening fills, foreign identities, wrong contracts or sides, entry-tail and unknown unbooked fills do not inflate the recovered basis',()=>{
  const unrelated=closeOrder('long',10,{positionId:'another-position'}),opening=closeOrder('long',10),wrongSymbol=closeOrder('long',10),
    wrongSide=closeOrder('long',10),wrongExchange=closeOrder('long',10,{exchange:'binance'}),wrongClient=closeOrder('long',10),
    unknown=closeOrder('long',10),entryTail=closeOrder('long',10,{executionEvidence:{version:1,method:'ioc',role:'entry-tail',batchId:'offline-entry-tail'}}),
    noReceipt=closeOrder('long',10,{result:undefined});
  opening.request.reduceOnly=false;wrongSymbol.request.symbol='ETH/USDT:USDT';wrongSide.request.side='buy';
  wrongClient.result!.clientOrderId='unrelated-client';unknown.result!.status='unknown';
  const p=position(.5);assert.equal(freezeProfitExitNotional(p,[closeOrder('long',.5),closeOrder('short',.5),
    unrelated,opening,wrongSymbol,wrongSide,wrongExchange,wrongClient,unknown,entryTail,noReceipt]),true);
  assert.equal(p.profitExitNotionalUsd,100);
});

test('an active Maker cumulative receipt contributes to recovery only when actual execution was already booked',()=>{
  const p=position(.6),maker=closeOrder('long',.4);
  maker.result!.status='unknown';maker.makerReduction={activity:'active',makerLeg:'long',deadlineAt:6_000,bookedExecution:true};
  assert.equal(freezeProfitExitNotional(p,[maker,closeOrder('short',.4)]),true);assert.equal(p.profitExitNotionalUsd,100);
  const unknown=position(.6),unbooked=structuredClone(maker);delete unbooked.makerReduction!.bookedExecution;
  assert.equal(freezeProfitExitNotional(unknown,[unbooked]),true);assert.equal(unknown.profitExitNotionalUsd,60);
});

test('invalid receipt quantities are skipped and do not become actual original opening quantity',()=>{
  const orders=[0,-1,NaN,Infinity].map(quantity=>closeOrder('long',quantity));
  const p=position();assert.equal(freezeProfitExitNotional(p,orders),true);assert.equal(p.profitExitNotionalUsd,100);
});

test('over-request and missing native receipt identities cannot enlarge the recovered original basis',()=>{
  const overflow=closeOrder('long',1),missingNative=closeOrder('short',1);
  overflow.result!.filledQuantity=2;missingNative.result!.id='';
  const p=position();assert.equal(freezeProfitExitNotional(p,[overflow,missingNative]),true);
  assert.equal(p.profitExitNotionalUsd,100);assert.equal(exitProfitThresholdUsd(p,config),.1);
});

test('new-order size and legacy fixed-dollar settings cannot change an existing position threshold',()=>{
  const p=position();freezeProfitExitNotional(p,[]);
  for(const orderNotionalUsd of [50,100,1_000_000]){
    assert.equal(exitProfitThresholdUsd(p,{...config,orderNotionalUsd,minExitProfitUsd:999,leverage:20}),.1);
  }
  const olderConfig={...config,minExitProfitBps:undefined,minExitProfitUsd:500};assert.equal(exitProfitThresholdUsd(p,olderConfig),.1);
  assert.equal(exitProfitThresholdUsd(p,{...config,minExitProfitBps:25}),.25);
});

test('unknown fee, funding or current mark never turns an opening-notional profit threshold into zero',()=>{
  const p=position();p.profitExitNotionalUsd=100;p.feesUsd=p.fundingUsd=p.realizedSpreadPnlUsd=NaN;
  p.long.markPrice=p.short.markPrice=NaN;assert.equal(exitProfitThresholdUsd(p,config),.1);
  delete p.profitExitNotionalUsd;assert.equal(profitExitNotionalUsd(p),100);assert.equal(exitProfitThresholdUsd(p,config),.1);
});

test('bad frozen basis or missing actual opening prices retain an unknown threshold instead of using configured notional',()=>{
  for(const value of [0,-1,NaN,Infinity]){
    const p=position();p.profitExitNotionalUsd=value;assert.equal(profitExitNotionalUsd(p),undefined);
    assert.ok(Number.isNaN(exitProfitThresholdUsd(p,config)));assert.equal(exitNetProfitBps(p,.1),undefined);
    assert.equal(freezeProfitExitNotional(p,[]),false,'an invalid recorded basis is not silently replaced');
  }
  for(const value of [0,-1,NaN,Infinity]){
    const p=position();p.long.entryPrice=value;assert.equal(profitExitNotionalUsd(p),undefined);
    assert.equal(freezeProfitExitNotional(p,[]),false);assert.ok(Number.isNaN(exitProfitThresholdUsd(p,config)));
  }
});

test('finite opening inputs that overflow their notional remain unknown and cannot report zero profit bps',()=>{
  const p=position(1e308,1e308,1e308);assert.equal(profitExitNotionalUsd(p),undefined);
  assert.equal(freezeProfitExitNotional(p,[]),false);assert.ok(Number.isNaN(exitProfitThresholdUsd(p,config)));
  assert.equal(exitNetProfitBps(p,.1),undefined);
});

test('manual imports and incomplete opening sessions cannot acquire a frozen full opening basis',()=>{
  const manual=position();manual.manualCloseOnly=true;const opening=position();opening.status='opening';
  for(const p of [manual,opening]){assert.equal(freezeProfitExitNotional(p,[closeOrder('long',1)]),false);assert.equal(p.profitExitNotionalUsd,undefined);}
});

test('nonfinite or negative bps retain an invalid threshold while explicit zero bps remains zero',()=>{
  for(const bps of [-1,NaN,Infinity])assert.ok(Number.isNaN(exitProfitThresholdUsd(position(),{...config,minExitProfitBps:bps})));
  assert.equal(exitProfitThresholdUsd(position(),{...config,minExitProfitBps:0}),0);
  assert.equal(exitNetProfitBps(position(),NaN),undefined);assert.equal(exitNetProfitBps(position(),Infinity),undefined);
  near(exitNetProfitBps(position(),.12345)!,12.345);
});
