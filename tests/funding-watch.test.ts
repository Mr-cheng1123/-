import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/core/engine.js';
import {SpreadHistory} from '../src/core/spread-history.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import {calculateFundingCandidates,type FundingCandidate} from '../src/shared/funding-opportunities.js';
import {defaultConfig} from '../src/shared/config.js';
import type {FundingStatsDataset} from '../src/shared/funding-statistics.js';
import type {AppConfig,ExchangeId,MarketSnapshot,Position} from '../src/shared/types.js';

const START=1_700_000_000_000;
const EXCHANGES:ExchangeId[]=['binance','bybit','okx','gate','bitget'];
const BASES=['AAA','BBB','CCC','DDD','EEE','FFF','GGG','HHH'];
interface Watch {candidate:FundingCandidate;expiresAt:number;selectedAt:number;manual:boolean}

function quote(exchange:ExchangeId,base:string,at:number):MarketSnapshot {
  const rank=EXCHANGES.indexOf(exchange),price=100+rank*.1;
  return {exchange,base,symbol:`${base}/USDT:USDT`,timestamp:at,observedAt:at,
    markPrice:price,indexPrice:100,fundingRate:rank*.001,nextFundingTime:START+3_600_000,intervalHours:8,
    fundingHistory:[],bids:[{price:price-.01,quantity:100}],asks:[{price:price+.01,quantity:100}],
    openInterestUsd:1e8,volume24hUsd:1e8,quantityStep:.001,minQuantity:.001,minNotional:5,contractSize:1,source:'public'};
}

/** A public-data scheduler fixture: no adapter transport, account preparation or order executor is constructed. */
function fixture() {
  const config:AppConfig={...defaultConfig,mode:'paper',exchanges:[...EXCHANGES],symbols:['BTC'],orderNotionalUsd:100,
    spreadMinSamples:12,spreadMinSpanSec:120,spreadSampleIntervalSec:15,pollIntervalMs:5000};
  let at=START;
  const history=new SpreadHistory(),active:Position[]=[],excluded:{base:string}[]=[],refreshes:{exchange:ExchangeId;includeAccount:boolean}[]=[];
  const dataset=():FundingStatsDataset=>({source:'exchanges',range:'current',status:'ready',receivedAt:at,lastAttemptAt:at,
    nextRefreshAt:at+20_000,maxAgeMs:120_000,sourceUrl:'https://example.test',marginScope:'USDT',
    rows:BASES.map(base=>({base,cells:Object.fromEntries(EXCHANGES.map((exchange,rank)=>[exchange,
      {exchange,rate:rank*.001,intervalHours:8,nextFundingTime:START+3_600_000,updatedAt:at,timestampKind:'received',available:true}]))}))});
  const engine={config,options:{},adapters:EXCHANGES.map(id=>({id})),liveUnlocked:false,
    liveEnvironment:{exchanges:EXCHANGES.map(exchange=>({exchange,supported:true,credentialsConfigured:false}))},
    usesFundingStatistics:()=>true,paperFeeOnly:()=>true,hasLiveAccess:(_exchange:ExchangeId)=>true,
    coinExclusions:()=>excluded,activePositions:()=>active,
    fundingCandidates:(now=at)=>calculateFundingCandidates(dataset(),config,now),
    fundingWatch:new Map<string,Watch>(),fundingChecked:new Map<string,number>(),
    snapshots:[] as MarketSnapshot[],spreadHistory:history,verifyFailures:new Map<string,{message:string;at:number}>(),
    health:EXCHANGES.map(exchange=>({exchange,status:'online'})),
    exclusive:<T>(fn:()=>Promise<T>)=>fn(),adapter:(id:ExchangeId)=>({id}),
    snapshot:(id:ExchangeId,base:string)=>engine.snapshots.find(s=>s.exchange===id&&s.base===base),
    refreshAdapter:async(adapter:{id:ExchangeId},bases:string[],includeAccount=true)=>{
      refreshes.push({exchange:adapter.id,includeAccount});
      engine.snapshots=engine.snapshots.filter(s=>s.exchange!==adapter.id||!bases.includes(s.base))
        .concat(bases.map(base=>quote(adapter.id,base,at)));
      return true;
    },
    recordSpreadObservations:(now:number)=>history.observe(engine.snapshots,config,now),
    pruneSnapshots:()=>{},
    detailedOpportunities:(now:number)=>calculateOpportunities(engine.snapshots,config,now,history),
  };
  Object.setPrototypeOf(engine,Engine.prototype);
  const plan=(now:number)=>{
    at=now;
    return (Engine.prototype as unknown as {detailedPlan(now:number):Map<ExchangeId,string[]>}).detailedPlan.call(engine,now);
  };
  const sample=(now:number)=>{
    const scheduled=plan(now);
    engine.snapshots=[...scheduled].flatMap(([exchange,bases])=>bases.map(base=>quote(exchange,base,now)));
    history.observe(engine.snapshots,config,now);
    return scheduled;
  };
  return {engine,config,active,excluded,refreshes,history,plan,sample,setTime:(now:number)=>{at=now;}};
}

test('manual public lookup uses genuinely fresh pushed books without another REST or account read',async t=>{
  t.mock.method(Date,'now',()=>START);
  const f=fixture(),rows=EXCHANGES.map(exchange=>({...quote(exchange,'AAA',START),bookTransport:'websocket' as const,fundingObservedAt:START}));
  Object.assign(f.engine,{adapter:(exchange:ExchangeId)=>({id:exchange,getExecutionSnapshot:()=>rows.find(row=>row.exchange===exchange)}),unavailableSnapshots:new Set<string>()});
  const candidate=f.engine.fundingCandidates().find(candidate=>candidate.base==='AAA')!;
  const found=await (Engine.prototype as unknown as {verifyFundingCandidate(id:string):Promise<unknown>}).verifyFundingCandidate.call(f.engine,candidate.id);
  assert.ok(found);
  assert.equal(f.refreshes.length,0,'fresh pushed two-leg books do not wait for a redundant public request');
  assert.equal(f.engine.liveUnlocked,false,'looking up a price does not grant execution permission');
});

test('manual public lookup refreshes old funding metadata even if the pushed book itself is new',async t=>{
  t.mock.method(Date,'now',()=>START);
  const f=fixture(),rows=EXCHANGES.map(exchange=>({...quote(exchange,'AAA',START),bookTransport:'websocket' as const,fundingObservedAt:START-30_001}));
  Object.assign(f.engine,{adapter:(exchange:ExchangeId)=>({id:exchange,getExecutionSnapshot:()=>rows.find(row=>row.exchange===exchange)}),unavailableSnapshots:new Set<string>()});
  const candidate=f.engine.fundingCandidates().find(candidate=>candidate.base==='AAA')!;
  await (Engine.prototype as unknown as {verifyFundingCandidate(id:string):Promise<unknown>}).verifyFundingCandidate.call(f.engine,candidate.id);
  assert.equal(f.refreshes.length,2);
  assert.ok(f.refreshes.every(read=>read.includeAccount===false),'only the two actual public legs are refreshed');
});

test('six watched coins cover all valid venues and sixty independent cross-exchange pairs',()=>{
  const f=fixture();
  f.sample(START);f.sample(START+5000);const scheduled=f.sample(START+10_000);
  assert.equal(f.engine.fundingWatch.size,6);
  for(const exchange of EXCHANGES)assert.equal(scheduled.get(exchange)!.length,6,`${exchange} must quote every watched coin`);
  assert.equal(f.engine.snapshots.length,30);
  const opportunities=calculateOpportunities(f.engine.snapshots,f.config,START+10_001,f.history);
  assert.equal(opportunities.length,60);
  for(const base of f.engine.fundingWatch.keys())assert.equal(opportunities.filter(o=>o.base===base).length,10);
});

test('slow successful quote cycles preserve the watched coins long enough to build the required baseline',()=>{
  const f=fixture();
  f.sample(START);f.sample(START+5000);f.sample(START+10_000);
  const watched=[...f.engine.fundingWatch.keys()];
  // A 5s poll plus public request work produces distinct books 24s apart, rather than an ideal 15s cadence.
  for(let cycle=1;cycle<=12;cycle++){
    const now=START+10_000+cycle*24_000;
    f.sample(now);
    assert.deepEqual([...f.engine.fundingWatch.keys()],watched,`the discovery batch rotated before baseline completion at ${cycle*24}s`);
  }
  const now=START+298_001;
  const detailed=calculateOpportunities(f.engine.snapshots,f.config,now,f.history);
  assert.equal(detailed.length,60);
  assert.ok(detailed.every(o=>o.spreadAdvantage?.status==='ready'));
  assert.ok(detailed.every(o=>o.spreadAdvantage!.samples>=12));
  assert.ok(detailed.every(o=>Number.isFinite(o.combinedExpectedNetUsd)));
});

test('existing software holdings retain quote priority even when they exceed the discovery budget',()=>{
  const f=fixture();
  for(let i=0;i<8;i++)f.active.push({base:`HELD${i}`,long:{exchange:'gate'},short:{exchange:'bybit'}} as Position);
  const scheduled=f.plan(START);
  for(const exchange of ['gate','bybit'] as ExchangeId[])for(let i=0;i<8;i++)
    assert.ok(scheduled.get(exchange)!.includes(`HELD${i}`),'discovery must never evict an existing holding quote');
});

test('manual public verification uses the same six-coin budget and replaces only one automatic watch',async t=>{
  const f=fixture();
  f.sample(START);f.sample(START+5000);f.sample(START+10_000);
  assert.equal(f.engine.fundingWatch.size,6);
  const original=new Set(f.engine.fundingWatch.keys()),candidate=f.engine.fundingCandidates().find(c=>c.base==='HHH')!;
  f.setTime(START+15_000);t.mock.method(Date,'now',()=>START+15_000);
  const verified=await (Engine.prototype as unknown as {verifyFundingCandidate(id:string):Promise<unknown>})
    .verifyFundingCandidate.call(f.engine,candidate.id);
  assert.ok(verified);
  assert.equal(f.engine.fundingWatch.size,6);
  assert.equal(f.engine.fundingWatch.get('HHH')?.manual,true);
  assert.equal([...original].filter(base=>f.engine.fundingWatch.has(base)).length,5);
  assert.equal(f.refreshes.length,2);
  assert.ok(f.refreshes.every(read=>read.includeAccount===false),'manual verification is public data only');
  const scheduled=f.plan(START+20_000);
  assert.ok(EXCHANGES.every(exchange=>scheduled.get(exchange)!.includes('HHH')),'manual selection must also warm alternate venue routes');
  assert.ok([...scheduled.values()].every(bases=>bases.length<=6));
});

test('selection does not fabricate quotes for unavailable or disabled exchange routes',()=>{
  const f=fixture();
  f.config.exchanges=['gate','bybit','bitget'];
  f.engine.adapters=f.engine.adapters.filter(a=>f.config.exchanges.includes(a.id));
  f.sample(START);f.sample(START+5000);const scheduled=f.sample(START+10_000);
  assert.deepEqual([...scheduled.keys()],['bybit','gate','bitget']);
  assert.equal(f.engine.snapshots.length,18);
  const detailed=calculateOpportunities(f.engine.snapshots,f.config,START+10_001,f.history);
  assert.equal(detailed.length,18);
  assert.ok(detailed.every(o=>f.config.exchanges.includes(o.longExchange)&&f.config.exchanges.includes(o.shortExchange)));
});

test('engine scheduling gives four top-income coins priority over unchecked lower-profit coins',()=>{
  const f=fixture();
  for(const base of BASES.slice(0,5))f.engine.fundingChecked.set(`base:${base}`,START);
  const scheduled=f.plan(START);
  assert.deepEqual([...f.engine.fundingWatch.keys()],['AAA','BBB','CCC','DDD','FFF','GGG']);
  for(const exchange of EXCHANGES)assert.deepEqual(scheduled.get(exchange),['AAA','BBB','CCC','DDD','FFF','GGG']);
  assert.equal(f.engine.snapshots.length,0,'scheduling must not invent prices or place orders');
});

test('manual public monitoring remains scheduled without venue trading authorization',async t=>{
  const f=fixture();f.config.mode='live';f.engine.liveUnlocked=true;
  f.engine.hasLiveAccess=exchange=>['bybit','gate','bitget'].includes(exchange);
  f.sample(START);
  assert.equal(f.plan(START+5000).get('binance')?.length,6,'public monitoring quotes every valid venue for watched coins, independently of credentials');
  const candidate=f.engine.fundingCandidates().find(c=>c.base==='HHH'&&c.longExchange==='binance'&&c.shortExchange==='bybit')!;
  f.setTime(START+15_000);t.mock.method(Date,'now',()=>START+15_000);
  const verified=await (Engine.prototype as unknown as {verifyFundingCandidate(id:string):Promise<unknown>})
    .verifyFundingCandidate.call(f.engine,candidate.id);
  assert.ok(verified);
  assert.equal(f.refreshes.length,2);
  assert.ok(f.refreshes.every(read=>read.includeAccount===false),'public monitoring must not inspect or prepare private trading');
  const scheduled=f.plan(START+20_000);
  assert.ok(scheduled.get('binance')?.includes('HHH'),'the next automatic quote cycle must keep warming the manually requested public route');
  assert.equal(f.engine.fundingWatch.get('HHH')?.manual,true);
});

test('a real held coin keeps its actual venue legs under observation while new-entry slots use other coins',()=>{
  const f=fixture();f.excluded.push({base:'AAA'});
  f.active.push({base:'AAA',long:{exchange:'gate'},short:{exchange:'bybit'}} as Position);
  const scheduled=f.plan(START);
  for(const exchange of ['gate','bybit'])assert.ok(scheduled.get(exchange as ExchangeId)?.includes('AAA'),`${exchange} must keep observing its actual held leg`);
  for(const exchange of ['binance','okx','bitget'])assert.ok(!scheduled.get(exchange as ExchangeId)?.includes('AAA'),'an occupied coin does not expand to every other venue');
  assert.equal(f.engine.fundingWatch.has('AAA'),false,'the observed held coin must not consume a new-entry watch');
  assert.ok(f.engine.fundingWatch.size>0,'one occupied coin cannot stop observing other opportunities');
});

test('aligned discovery rotates after two quote cycles without waiting for configured historical samples',()=>{
  const f=fixture();f.config.entryPolicy='aligned';f.config.spreadMinSamples=240;f.config.spreadMinSpanSec=3600;
  f.sample(START);
  assert.deepEqual([...f.engine.fundingWatch.keys()],['AAA','BBB','CCC','DDD','EEE','FFF']);
  f.sample(START+30_001);
  assert.deepEqual([...f.engine.fundingWatch.keys()],['AAA','BBB','CCC','DDD','GGG','HHH']);
  assert.equal(f.engine.snapshots.length,30);
});

test('aligned manual public lookup keeps at least three minutes even though automatic discovery rotates in thirty seconds',async t=>{
  const f=fixture();f.config.entryPolicy='aligned';f.config.spreadMinSamples=6;f.config.spreadMinSpanSec=60;
  f.sample(START);f.setTime(START+5000);t.mock.method(Date,'now',()=>START+5000);
  const candidate=f.engine.fundingCandidates().find(c=>c.base==='HHH')!;
  await (Engine.prototype as unknown as {verifyFundingCandidate(id:string):Promise<unknown>}).verifyFundingCandidate.call(f.engine,candidate.id);
  assert.ok(f.engine.fundingWatch.get('HHH')!.expiresAt>=START+5000+180_000);
  f.plan(START+40_000);
  assert.equal(f.engine.fundingWatch.get('HHH')?.manual,true);
  assert.ok(EXCHANGES.every(exchange=>f.plan(START+45_000).get(exchange)?.includes('HHH')));
});
