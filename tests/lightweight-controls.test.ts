import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../src/shared/config.js';
import type {AppConfig,ExchangeId,MarketSnapshot} from '../src/shared/types.js';
import {applyEntryAvailability,type EntryAvailability} from '../src/core/entry-availability.js';
import {quoteIsFresh} from '../src/core/market-validity.js';
import {SpreadHistory} from '../src/core/spread-history.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import {ReadyHistory} from './ready-history.js';

const config:AppConfig={...defaultConfig,mode:'live',orderNotionalUsd:100,exchanges:['gate','bitget'],symbols:['BTC'],holdMode:'once'};
const now=1_790_800_000_000;
function quote(exchange:ExchangeId,at:number,change:Partial<MarketSnapshot>={}):MarketSnapshot {
  return {exchange,base:'BTC',symbol:'BTC/USDT:USDT',timestamp:at,observedAt:at,markPrice:100,indexPrice:100,
    fundingRate:exchange==='bitget'?.001:0,nextFundingTime:now+3600000,intervalHours:8,fundingHistory:[],
    bids:[{price:exchange==='gate'?99.98:100.5,quantity:10}],asks:[{price:exchange==='gate'?100:100.52,quantity:10}],
    openInterestUsd:0,volume24hUsd:0,quantityStep:.001,minQuantity:.001,minNotional:5,contractSize:1,source:'public',
    takerFeeRate:exchange==='bitget'?.0006:.0005,takerFeeAt:change.observedAt??at,takerFeeSource:'exchange',...change};
}
const ready=():EntryAvailability=>({stopped:false,authorized:true,balances:[{exchange:'gate',availableUsd:100,requiredUsd:51},{exchange:'bitget',availableUsd:100,requiredUsd:51}],
  coinReasons:[],cooldownUntil:0,candidateCurrent:true,marketAvailable:true});
const opportunity=()=>calculateOpportunities([quote('gate',now),quote('bitget',now)],config,now,new ReadyHistory())[0];

test('execution check list, reasons and eligibility are one decision without mutating the strategy result',()=>{
  const original=opportunity();assert.equal(original.eligible,true);
  const blocked=applyEntryAvailability(original,{...ready(),coinReasons:['BTC 已有待核对订单']},now);
  assert.equal(blocked.eligible,false);assert.equal(original.eligible,true);
  assert.deepEqual(blocked.reasons,blocked.checks!.filter(check=>check.pass===false).map(check=>check.reason));
  assert.equal(applyEntryAvailability(opportunity(),ready(),now).eligible,true);
});

test('only the affected pair loses entry capability, and unknown balance stays subject to submission-time read',()=>{
  const unavailable=applyEntryAvailability(opportunity(),{...ready(),balances:[{exchange:'gate',availableUsd:0,requiredUsd:51}]},now);
  assert.match(unavailable.reasons.join('；'),/gate 合约可用余额不足/);
  assert.equal(applyEntryAvailability(opportunity(),ready(),now).eligible,true);
  const unread=applyEntryAvailability(opportunity(),{...ready(),balances:[{exchange:'gate',requiredUsd:51}]},now);
  assert.equal(unread.checks!.find(check=>check.label==='两腿保证金可用')!.pass,null);
  assert.equal(unread.eligible,true);
});

test('valid account permission cannot promote a pending spread baseline into an executable opportunity',()=>{
  const pending=calculateOpportunities([quote('gate',now),quote('bitget',now)],config,now,new SpreadHistory())[0];
  assert.equal(pending.eligible,false);
  assert.equal(pending.reasons.length,0);
  const checked=applyEntryAvailability(pending,ready(),now);
  assert.equal(checked.eligible,false);
  assert.equal(checked.checks!.find(check=>check.label==='价差历史样本充足')!.pass,null);
  assert.equal(checked.checks!.find(check=>check.label==='两腿交易账户已授权')!.pass,true);
});

test('manual stop and retry cooldown appear in the same entry checklist and cooldown expires',()=>{
  const stopped=applyEntryAvailability(opportunity(),{...ready(),stopped:true,cooldownUntil:now+10000},now);
  assert.equal(stopped.eligible,false);assert.equal(stopped.checks!.filter(check=>check.pass===false).length,2);
  assert.equal(applyEntryAvailability(opportunity(),{...ready(),cooldownUntil:now-1},now).eligible,true);
});

test('fresh REST observations of a static book qualify, expired observations and future exchange times do not',()=>{
  const oldEvent=now-3600000;
  assert.equal(quoteIsFresh(quote('gate',oldEvent,{observedAt:now}),config,now),true);
  assert.equal(quoteIsFresh(quote('gate',oldEvent,{observedAt:now-31000}),config,now),false);
  assert.equal(quoteIsFresh(quote('gate',now+6000,{observedAt:now}),config,now),false);
  assert.equal(quoteIsFresh(quote('gate',oldEvent,{observedAt:undefined}),config,now),false);
});

test('re-reading static books builds independent historical samples without using the current observation itself',()=>{
  const history=new SpreadHistory(),oldEvent=now-3600000;
  for(let index=8;index>=1;index--){
    const at=now-index*15000;
    history.observe([quote('gate',oldEvent,{observedAt:at}),quote('bitget',oldEvent,{observedAt:at,bids:[{price:100.1,quantity:10}],asks:[{price:100.12,quantity:10}]})],config,at);
  }
  const current=[quote('gate',oldEvent,{observedAt:now}),quote('bitget',oldEvent,{observedAt:now})];
  const before=history.assess(current[0],current[1],1,config,now);
  assert.equal(before.status,'ready');assert.equal(before.samples,8);
  history.observe(current,config,now);
  assert.equal(history.assess(current[0],current[1],1,config,now).samples,8);
  const result=calculateOpportunities(current,config,now,history)[0];
  assert.equal(result.eligible,true,result.reasons.join('；'));
});
