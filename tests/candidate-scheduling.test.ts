import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/core/engine.js';
import {defaultConfig} from '../src/shared/config.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import type {AppConfig,ExchangeId,MarketSnapshot,SpreadAdvantage} from '../src/shared/types.js';
import type {FundingCandidate} from '../src/shared/funding-opportunities.js';

const start=1_700_000_000_000;
function quote(exchange:ExchangeId,base:string,at:number):MarketSnapshot{
  return {exchange,base,symbol:`${base}/USDT:USDT`,timestamp:at,markPrice:100,indexPrice:100,fundingRate:exchange==='bybit'?.006:0,
    nextFundingTime:at+600000,intervalHours:8,fundingHistory:[],bids:[{price:exchange==='gate'?99.98:100.5,quantity:100}],
    asks:[{price:exchange==='gate'?100:100.52,quantity:100}],openInterestUsd:1e8,volume24hUsd:1e8,quantityStep:.001,minQuantity:.001,minNotional:5,contractSize:1,source:'public'};
}
// `fast` shortens the watch window (minimum allowed history settings); the default reproduces a 12-sample / 120-second history.
function fixture(fast=false){
  const config:AppConfig={...defaultConfig,mode:'paper',exchanges:['gate','bybit'],symbols:['BTC'],orderNotionalUsd:100,
    ...(fast?{spreadMinSamples:3,spreadMinSpanSec:30,spreadSampleIntervalSec:5}:{spreadMinSamples:12,spreadMinSpanSec:120,spreadSampleIntervalSec:15})};
  const candidates=['AAA','BBB','CCC','DDD','EEE','FFF','GGG','HHH'].map((base,i)=>({id:`${base}-gate-bybit`,base,longExchange:'gate',shortExchange:'bybit',candidateEligible:true,afterFeesUsd:1-i*.1,expectedNetUsd:1-i*.1} as FundingCandidate));
  const actionable=new Set<string>();
  const history={assess:(long:MarketSnapshot):SpreadAdvantage=>({status:actionable.has(long.base)?'ready':'warming',samples:12,requiredSamples:12,observedSpanSec:180,requiredSpanSec:120,
    longEntryPrice:100,shortEntryPrice:100.5,entrySpreadBps:50,expectedExitSpreadBps:actionable.has(long.base)?14:null,spreadAdvantageBps:actionable.has(long.base)?36:null,
    expectedSpreadPnlUsd:actionable.has(long.base)?.36:null})};
  const engine={config,options:{},adapters:config.exchanges.map(id=>({id})),usesFundingStatistics:()=>true,coinExclusions:()=>[],activePositions:()=>[],fundingCandidates:()=>candidates,
    paperFeeOnly:()=>true,fundingWatch:new Map<string,{candidate:FundingCandidate;expiresAt:number;selectedAt:number;manual:boolean}>(),fundingChecked:new Map<string,number>(),snapshots:[] as MarketSnapshot[],spreadHistory:history};
  Object.setPrototypeOf(engine,Engine.prototype);
  const schedule=(at:number)=>{
    engine.snapshots=candidates.flatMap(c=>[quote('gate',c.base,at),quote('bybit',c.base,at)]);
    return (Engine.prototype as unknown as {detailedPlan(now:number):Map<ExchangeId,string[]>}).detailedPlan.call(engine,at);
  };
  return {engine,candidates,actionable,schedule};
}

test('seven held coins keep their actual legs without consuming the six new funding watches',()=>{
  const f=fixture(true),held=Array.from({length:7},(_,i)=>({exchange:'gate' as const,base:`HELD${i}`,symbol:`HELD${i}/USDT:USDT`}));
  for(const position of held)f.candidates.push({...f.candidates[0],id:`${position.base}-gate-bybit`,base:position.base});
  Object.assign(f.engine,{actualPositionMarkets:()=>held,coinExclusions:()=>held.map(position=>({base:position.base,exchanges:['gate']}))});
  const plan=f.schedule(start);
  assert.equal(f.engine.fundingWatch.size,6,'existing exposure has its own observation budget');
  for(const position of held){
    assert.ok(plan.get('gate')!.includes(position.base),'actual held legs remain protected');
    assert.ok(!plan.get('bybit')!.includes(position.base),'occupied coins do not expand to an unheld venue');
  }
  assert.equal(plan.get('bybit')!.length,6);
  assert.equal(plan.get('gate')!.length,13);
  assert.ok(f.engine.fundingWatch.has('AAA'),'the highest new funding opportunity is observed');
});

test('aligned engine watches a positive fee-net reference before larger gross funding despite a closed entry window',()=>{
  const f=fixture(true);f.engine.config.entryPolicy='aligned';
  for(const candidate of f.candidates)Object.assign(candidate,{grossFundingUsd:.4,feesUsd:.6,afterFeesUsd:-.2,expectedNetUsd:-.2,normalized8hBps:40});
  const target=f.candidates.find(candidate=>candidate.base==='HHH')!;
  Object.assign(target,{grossFundingUsd:.3,feesUsd:.2,afterFeesUsd:.1,expectedNetUsd:.1,candidateEligible:false,normalized8hBps:30});
  const plan=f.schedule(start);
  assert.equal(f.engine.fundingWatch.size,6);
  assert.equal([...f.engine.fundingWatch.keys()][0],'HHH');
  assert.ok(plan.get('gate')!.includes('HHH')&&plan.get('bybit')!.includes('HHH'));
  assert.equal(target.candidateEligible,false,'the scheduler only requests public books');
});

test('bounded verification eventually inspects lower-ranked candidates',()=>{
  const f=fixture(true),seen=new Set<string>();
  for(let sec=0;sec<=240;sec+=5)for(const base of f.schedule(start+sec*1000).get('gate')!)seen.add(base);
  assert.ok(f.candidates.every(c=>seen.has(c.base)));assert.equal(seen.size,8);
});

test('joint candidate watches last long enough for distinct historical observations before rotating',()=>{
  const f=fixture(),seen=new Set<string>();
  for(let sec=0;sec<=195;sec+=5)for(const base of f.schedule(start+sec*1000).get('gate')!)seen.add(base);
  assert.deepEqual([...seen],['AAA','BBB','CCC','DDD','EEE','FFF']);
  assert.ok(f.engine.fundingWatch.get('AAA')!.expiresAt>=start+180000);
  for(let sec=200;sec<=420;sec+=5)for(const base of f.schedule(start+sec*1000).get('gate')!)seen.add(base);
  assert.ok(f.candidates.every(c=>seen.has(c.base)));assert.ok(f.engine.fundingWatch.size<=6);
});

test('multiple venue routes for top coins cannot starve previously unobserved coins',()=>{
  const f=fixture(true);f.engine.config.exchanges.push('bitget');f.engine.adapters.push({id:'bitget'});
  for(const c of [...f.candidates])f.candidates.push({...c,id:`${c.base}-gate-bitget`,shortExchange:'bitget',afterFeesUsd:c.afterFeesUsd-.001,expectedNetUsd:c.expectedNetUsd-.001});
  const seen=new Set<string>();
  for(let sec=0;sec<=120;sec+=5)for(const bases of f.schedule(start+sec*1000).values())for(const base of bases)seen.add(base);
  assert.ok(f.candidates.every(c=>seen.has(c.base)),'unseen bases must precede alternate routes for already observed coins');
});

test('four ready coins remain available while two slots discover new coins',()=>{
  const f=fixture(),seen=new Set<string>();for(const c of f.candidates)f.actionable.add(c.base);
  for(let sec=0;sec<=430;sec+=5){const bases=f.schedule(start+sec*1000).get('gate')!;for(const base of bases)seen.add(base);
    if(sec>=400)for(const base of ['AAA','BBB','CCC','DDD'])assert.ok(bases.includes(base));assert.ok(bases.length<=6);
  }
  assert.ok(f.candidates.every(c=>seen.has(c.base)));
});

test('an eligible arrival replaces automatic watches that are no longer eligible',()=>{
  const f=fixture();f.candidates.forEach(c=>c.candidateEligible=false);f.schedule(start);
  f.candidates[4].candidateEligible=true;
  assert.ok(f.schedule(start+5000).get('gate')!.includes('EEE'));
});

test('open interest and volume play no part in the entry rule',()=>{
  const f=fixture(),quotes=[quote('gate','BTC',start),quote('bybit','BTC',start)].map(q=>({...q,openInterestUsd:NaN,volume24hUsd:NaN}));
  const [o]=calculateOpportunities(quotes,f.engine.config,start,{assess:long=>f.engine.spreadHistory.assess(long)});
  assert.ok(o.checks!.every(check=>!/持仓量|成交额/.test(check.label)));assert.ok(!o.reasons.some(reason=>/持仓量|成交额/.test(reason)));
});
