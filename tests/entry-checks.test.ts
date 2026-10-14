import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../src/shared/config.js';
import type {AppConfig,ExchangeId,MarketSnapshot} from '../src/shared/types.js';
import {SpreadHistory} from '../src/core/spread-history.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import {ReadyHistory} from './ready-history.js';

const settings=(extra:Partial<AppConfig>={}):AppConfig=>({...defaultConfig,mode:'live',exchanges:['gate','bybit'],symbols:['BTC'],orderNotionalUsd:100,holdMode:'once',...extra});
function quote(exchange:ExchangeId,at:number,change:Partial<MarketSnapshot>={}):MarketSnapshot{
  return {exchange,base:'BTC',symbol:'BTC/USDT:USDT',timestamp:at,observedAt:at,markPrice:100,indexPrice:100,
    takerFeeRate:exchange==='gate'?.0005:.00055,takerFeeAt:at,takerFeeSource:'exchange',
    fundingRate:exchange==='bybit'?.006:0,nextFundingTime:at+300000,intervalHours:8,fundingHistory:[],
    bids:[{price:exchange==='gate'?99.98:100.5,quantity:100}],asks:[{price:exchange==='gate'?100:100.52,quantity:100}],
    openInterestUsd:1e7,volume24hUsd:1e8,quantityStep:.001,minQuantity:.001,minNotional:5,contractSize:1,source:'public',...change};
}

test('the checklist and the decision come from the same checks: eligible exactly when nothing fails', () => {
  const now=Date.now(),c=settings();
  const [good]=calculateOpportunities([quote('gate',now),quote('bybit',now)],c,now,new ReadyHistory());
  assert.equal(good.eligible,true);assert.equal(good.checks!.length,9);
  assert.ok(good.checks!.every(check=>check.pass===true));
  // Every blocking reason that a check produced is exactly that check's text.
  const [bad]=calculateOpportunities([quote('gate',now),quote('bybit',now,{fundingRate:0})],c,now,new ReadyHistory());
  assert.equal(bad.eligible,false);
  const failing=bad.checks!.filter(check=>check.pass===false);
  assert.ok(failing.length>0);
  for(const check of failing)assert.ok(bad.reasons.includes(check.reason),check.reason);
});

test('missing history is "cannot judge yet", never a hidden failure of the later spread checks', () => {
  const now=Date.now(),c=settings();
  const [o]=calculateOpportunities([quote('gate',now),quote('bybit',now)],c,now,new SpreadHistory());
  const byLabel=(text:string)=>o.checks!.find(check=>check.label.includes(text))!;
  assert.equal(byLabel('历史样本').pass,null);
  assert.equal(byLabel('优于历史退出价差').pass,null);
  assert.equal(byLabel('净收益达标').pass,null);
  // Warming history is an explicit wait, but still cannot authorize a trade.
  assert.equal(o.eligible,false);
  assert.equal(o.reasons.length,0);
  assert.ok(!o.reasons.includes('价差没有优势：开仓价差不优于历史退出价差'));
});

test('checks report the current value and the requirement', () => {
  const now=Date.now(),c=settings();
  const [o]=calculateOpportunities([quote('gate',now),quote('bybit',now,{fundingRate:0})],c,now,new ReadyHistory());
  const funding=o.checks!.find(check=>check.label==='预计资金费为正')!;
  assert.equal(funding.pass,false);assert.match(funding.actual!,/\$0\.00/);assert.match(funding.required!,/> \$0\.00/);
  const fresh=o.checks!.find(check=>check.label.includes('新鲜'))!;
  assert.equal(fresh.pass,true);assert.match(fresh.required!,/30 秒/);
});
