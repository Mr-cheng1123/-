import test from 'node:test';
import assert from 'node:assert/strict';
import {observeLedgerPosition,portfolioPositionSummary} from '../web/src/position-observation.js';
import type {AccountPosition,LivePortfolio,Position} from '../src/shared/types.js';

const now=100000;
const position=():Position=>({id:'old-ark',base:'ARK',mode:'live',status:'attention',openedAt:1000,plannedExitAt:50000,holdMode:'adaptive',
  long:{exchange:'gate',symbol:'ARK/USDT:USDT',side:'long',quantity:0,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:48},
  short:{exchange:'bybit',symbol:'ARK/USDT:USDT',side:'short',quantity:317,entryPrice:1,markPrice:1,feesUsd:.1,liquidationDistancePct:472},
  fundingUsd:.22,feesUsd:.15,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:.07,deltaUsd:317,fundingEvents:['old'],riskReasons:['订单待核对']});
const portfolio=():LivePortfolio=>({timestamp:now,pollIntervalMs:5000,maxAgeMs:15000,exchanges:['gate','bybit'].map(exchange=>({exchange:exchange as 'gate'|'bybit',credentialsConfigured:true,status:'ready',requestedAt:now-100,receivedAt:now-50,positions:[],freeUsd:100}))});
const row=(base='ARK',side:'long'|'short'='short'):AccountPosition=>({base,symbol:`${base}/USDT:USDT`,side,quantity:3,markPrice:1,liquidationPrice:0,leverage:2,unrealizedPnlUsd:0});

test('fresh empty accounts classify old attention records as historical without rewriting confirmed fills',()=>{
  const p=position(),before=structuredClone(p),observation=observeLedgerPosition(p,portfolio(),now);
  assert.equal(observation.status,'account_flat');assert.equal(observation.shortQuantity,0);assert.deepEqual(p,before);
});
test('an unrelated manual holding does not resurrect a stale strategy coin',()=>{
  const data=portfolio();data.exchanges[0].positions=[row('XAU','long')];
  assert.equal(observeLedgerPosition(position(),data,now).status,'account_flat');
  assert.equal(portfolioPositionSummary(data,now).count,1);
});
test('any live holding of the same base, including opposite direction or symbol alias, stays current',()=>{
  const data=portfolio();data.exchanges[1].positions=[{...row('ARK','long'),symbol:'ARKUSDT'}];
  assert.equal(observeLedgerPosition(position(),data,now).status,'present');
  assert.equal(observeLedgerPosition(position(),data,now).shortQuantity,0);
});
test('a missing, failed, expired or future account observation cannot prove an old position is flat',()=>{
  assert.equal(observeLedgerPosition(position(),undefined,now).status,'unverified');
  for(const mutate of [(data:LivePortfolio)=>data.exchanges.pop(),(data:LivePortfolio)=>{data.exchanges[1].status='error';},
    (data:LivePortfolio)=>{data.exchanges[1].requestedAt=now-15001;},(data:LivePortfolio)=>{data.exchanges[1].requestedAt=now+1;}]){
    const data=portfolio();mutate(data);assert.equal(observeLedgerPosition(position(),data,now).status,'unverified');
  }
});
test('a snapshot collected before the last submission does not classify the position as flat',()=>{
  const p=position();p.closeAttemptedAt=now-10;
  assert.equal(observeLedgerPosition(p,portfolio(),now).status,'unverified');
});
test('read-only archival evidence persists through an account disconnect and exposes no fake current quantity',()=>{
  const p=position();p.accountClosure={confirmedAt:now-1000,reason:'账户已空仓',historicalOrdersPending:true};
  const data=portfolio();data.exchanges[1].status='error';
  const observation=observeLedgerPosition(p,data,now);assert.equal(observation.status,'account_flat');assert.equal(observation.shortQuantity,undefined);
  assert.equal(observeLedgerPosition(p,undefined,now).status,'account_flat');assert.equal(p.short.quantity,317);
});
test('a newly observed real holding never revives an archived execution record',()=>{
  const p=position();p.accountClosure={confirmedAt:now-1000,reason:'账户已空仓',historicalOrdersPending:true};
  const data=portfolio();data.exchanges[0].status='error';data.exchanges[1].positions=[row()];
  const observation=observeLedgerPosition(p,data,now);assert.equal(observation.status,'account_flat');assert.equal(observation.shortQuantity,undefined);assert.equal(observation.longQuantity,undefined);
});
test('paper and genuinely closed records retain their journal semantics',()=>{
  const p=position();p.mode='paper';assert.equal(observeLedgerPosition(p,portfolio(),now).status,'ledger');
  p.mode='live';p.status='closed';assert.equal(observeLedgerPosition(p,portfolio(),now).status,'ledger');
});
test('live counts and exposure come from fresh exchange positions, never ledger quantities',()=>{
  const data=portfolio();data.exchanges[0].positions=[row('XAU','long')];
  assert.deepEqual(portfolioPositionSummary(data,now),{complete:true,count:1,exposureUsd:3,unrealizedPnlUsd:0,availableUsd:200});
  data.exchanges[1].status='stale';assert.equal(portfolioPositionSummary(data,now).count,null);
});
test('missing exchange metrics remain unknown, not a fabricated zero',()=>{
  const data=portfolio();data.exchanges[0].positions=[row()];delete data.exchanges[0].positions[0].unrealizedPnlUsd;delete data.exchanges[1].freeUsd;
  assert.equal(portfolioPositionSummary(data,now).unrealizedPnlUsd,undefined);assert.equal(portfolioPositionSummary(data,now).availableUsd,undefined);
});
