import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PublicFundingMonitor,PUBLIC_VERIFICATION_BATCH_SIZE,PUBLIC_FUNDING_PRIORITY_COINS,PUBLIC_VERIFICATION_TIMING_LIMIT} from '../src/core/public-funding-monitor.js';
import {Engine} from '../src/core/engine.js';
import {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import type {FundingCandidate} from '../src/shared/funding-opportunities.js';
import type {AppConfig,ExchangeAdapter,ExchangeId,MarketSnapshot} from '../src/shared/types.js';

const START=1_700_000_000_000;
const venueIds:ExchangeId[]=['gate','bybit','bitget'];
function candidate(base:string,rank:number,exchange:ExchangeId='bybit'):FundingCandidate {
  return {id:`${base}-gate-${exchange}`,base,longExchange:'gate',shortExchange:exchange,longRate:0,shortRate:.001,
    longIntervalHours:8,shortIntervalHours:8,normalized8hBps:10,aprPct:10,notionalUsd:100,nextFundingTime:START+3_600_000,exitTime:START+3_610_000,
    longFundingCount:1,shortFundingCount:1,grossFundingUsd:10-rank*.1,feesUsd:.22,afterFeesUsd:9.78-rank*.1,
    slippageBudgetUsd:0,transferCostUsd:0,fundingHaircutUsd:0,basisReserveUsd:0,expectedNetUsd:9.78-rank*.1,candidateEligible:true,reasons:[],updatedAt:START};
}
function quote(exchange:ExchangeId,base:string,at:number):MarketSnapshot {
  const price=exchange==='gate'?100:101;
  return {exchange,base,symbol:`${base}/USDT:USDT`,timestamp:at,observedAt:at,markPrice:price,indexPrice:price,
    fundingRate:exchange==='gate'?0:.001,nextFundingTime:at+3_600_000,intervalHours:8,fundingHistory:[],
    bids:[{price:price-.01,quantity:100}],asks:[{price:price+.01,quantity:100}],openInterestUsd:1e8,volume24hUsd:1e8,
    quantityStep:.01,minQuantity:.01,minNotional:1,contractSize:1,source:'public'};
}
function fixture(extra:{slow?:ExchangeId;reject?:ExchangeId;protectedBases?:string[]}={}){
  let at=START,config:AppConfig={...defaultConfig,entryPolicy:'aligned',dataSource:'public',mode:'live',exchanges:venueIds},financialCalls=0,closeCalls=0;
  const candidates=Array.from({length:24},(_,rank)=>candidate(`COIN${String(rank).padStart(2,'0')}`,rank));
  const quotes:MarketSnapshot[]=[],reads:{exchange:ExchangeId;bases:string[]}[]=[],factoryConfigs:AppConfig[]=[],protectedBases=new Set(extra.protectedBases??[]);
  let settleSlow:(quotes:MarketSnapshot[])=>void=()=>{};
  const factory=(next:AppConfig)=>{factoryConfigs.push(next);return next.exchanges.map(id=>({id,
    fetchSnapshots:async(bases:string[])=>{
      reads.push({exchange:id,bases:[...bases]});
      if(id===extra.slow)return new Promise<MarketSnapshot[]>(resolve=>{settleSlow=resolve;});
      if(id===extra.reject)throw new Error('Public data unavailable');
      return bases.map(base=>quote(id,base,at));
    },close:async()=>{closeCalls++;},fetchAccount:async()=>{financialCalls++;throw new Error('private');},
    prepareTrading:async()=>{financialCalls++;},placeOrder:async()=>{financialCalls++;throw new Error('order');},
    cancelOrder:async()=>{financialCalls++;},reconcileOrder:async()=>{financialCalls++;throw new Error('cancel');},fetchFundingPayments:async()=>{financialCalls++;return [];},
  } as ExchangeAdapter));};
  const monitor=new PublicFundingMonitor({config:()=>config,candidates:()=>candidates,snapshots:()=>quotes,protectedBases:()=>protectedBases,
    prefer:()=>true,adapters:factory,deadlineMs:20,publish:async(rows)=>{quotes.push(...rows);}});
  return {monitor,candidates,quotes,reads,factoryConfigs,protectedBases,factory,financialCalls:()=>financialCalls,closeCalls:()=>closeCalls,
    setTime:(now:number)=>{at=now;},config:()=>config,replaceConfig:()=>{config={...config,orderNotionalUsd:200};},settleSlow:(rows:MarketSnapshot[])=>settleSlow(rows)};
}

test('automatic public batching verifies eight new coins without private reads or financial writes',async t=>{
  const f=fixture();t.mock.method(Date,'now',()=>START);
  await f.monitor.runOnce();
  assert.equal(f.factoryConfigs[0].mode,'paper');assert.equal(f.factoryConfigs[0].autoEnabled,false);
  assert.equal(f.reads.length,2,'one per venue, not one per opportunity pair');
  assert.ok(f.reads.every(read=>read.bases.length===PUBLIC_VERIFICATION_BATCH_SIZE));
  assert.equal(f.financialCalls(),0);
  const status=f.monitor.status();assert.equal(status.checkedCoins,8);assert.equal(status.freshCoins,8);assert.equal(status.pendingCoins,16);assert.equal(status.failedCoins,0);
  await f.monitor.runOnce();assert.equal(f.monitor.status().checkedCoins,16,'recently checked coins must not monopolize subsequent batches');
  await f.monitor.runOnce();assert.equal(f.monitor.status().pendingCoins,0);
  await f.monitor.stop();
});

test('live funding and dual discovery rank known funding while all contract fees remain unknown',async t=>{
  t.mock.method(Date,'now',()=>START);
  for(const policy of ['funding','dual'] as const){
    const f=fixture();f.config().entryPolicy=policy;f.candidates.reverse();
    for(const candidate of f.candidates){candidate.feesUsd=NaN;candidate.afterFeesUsd=NaN;candidate.expectedNetUsd=NaN;}
    try{
      await f.monitor.runOnce();
      assert.deepEqual(f.reads[0].bases,['COIN00','COIN01','COIN02','COIN03','COIN04','COIN05','COIN06','COIN07']);
      assert.equal(f.monitor.status().checkedCoins,8);assert.equal(f.financialCalls(),0);
      assert(f.candidates.every(candidate=>Number.isNaN(candidate.feesUsd)&&Number.isNaN(candidate.afterFeesUsd)));
    }finally{await f.monitor.stop();}
  }
});

test('each coin reads all public venues once, including routes without trading authorization',async t=>{
  const f=fixture();t.mock.method(Date,'now',()=>START);
  for(const c of [...f.candidates])f.candidates.push({...c,id:`${c.base}-gate-bitget`,shortExchange:'bitget'});
  await f.monitor.runOnce();assert.equal(f.reads.length,3);assert.equal(f.quotes.length,24);
  assert.ok(f.reads.every(read=>new Set(read.bases).size===8));assert.equal(f.financialCalls(),0);
  await f.monitor.stop();
});

test('foreground-held and manually watched coins are not duplicated by discovery',async t=>{
  const f=fixture({protectedBases:['COIN00','COIN01','COIN02']});t.mock.method(Date,'now',()=>START);
  await f.monitor.runOnce();assert.ok(f.reads.every(read=>read.bases.every(base=>!f.protectedBases.has(base))));
  f.quotes.push(quote('gate','COIN00',START),quote('bybit','COIN00',START));
  assert.equal(f.monitor.status().checkedCoins,9);assert.equal(f.monitor.status().freshCoins,9);
  f.quotes.length=0;assert.equal(f.monitor.status().checkedCoins,9,'cumulative attempt count survives cache expiry');
  await f.monitor.stop();
});

test('a failed public venue is isolated and retried after backoff without erasing reference candidates',async t=>{
  const f=fixture({reject:'gate'});let now=START;t.mock.method(Date,'now',()=>now);
  await f.monitor.runOnce();assert.equal(f.monitor.status().checkedCoins,8);assert.equal(f.monitor.status().freshCoins,0);assert.equal(f.monitor.status().failedCoins,8);
  await f.monitor.runOnce();assert.equal(f.monitor.status().checkedCoins,16);
  assert.equal(f.candidates.length,24);
  now=START+30_001;f.setTime(now);await f.monitor.runOnce();assert.ok(f.reads.at(-1)?.bases.includes('COIN00'),'failed high-priority routes return after their backoff');
  await f.monitor.stop();
});

test('deadline releases scanning but cannot publish the late result or duplicate a stuck venue',async t=>{
  const f=fixture({slow:'gate'});t.mock.method(Date,'now',()=>START);
  await f.monitor.runOnce();assert.equal(f.monitor.status().failedCoins,8);
  const calls=f.reads.filter(read=>read.exchange==='gate').length;await f.monitor.runOnce();
  assert.equal(f.reads.filter(read=>read.exchange==='gate').length,calls);
  const diagnostics=f.monitor.status().diagnostics!;
  assert.equal(diagnostics.recentBatches[0].reads.find(read=>read.exchange==='gate')?.outcome,'deadline');
  assert.equal(diagnostics.recentBatches[1].reads.find(read=>read.exchange==='gate')?.outcome,'already-in-flight');
  assert.ok(diagnostics.recentBatches.every(batch=>batch.routes.every(route=>route.pairedAt===undefined&&route.missingExchanges.includes('gate'))));
  f.settleSlow([quote('gate','COIN00',START)]);await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(f.quotes.some(q=>q.exchange==='gate'),false,'late raw responses never publish');
  assert.deepEqual(f.monitor.status().diagnostics!.recentBatches,diagnostics.recentBatches,'late raw replies cannot rewrite diagnostic history');
  await f.monitor.stop();
});

test('public timing separates process queue age, per-venue reads, paired books and publication without extra calls',async t=>{
  let now=START; t.mock.method(Date,'now',()=>now);
  const f=fixture(),resolvers=new Map<ExchangeId,(quotes:MarketSnapshot[])=>void>();
  f.candidates.push(candidate('COIN01',1,'bitget'));
  const monitor=new PublicFundingMonitor({config:f.config,candidates:()=>f.candidates,snapshots:()=>[],protectedBases:()=>new Set(),prefer:()=>true,
    adapters:config=>config.exchanges.map(id=>({id,close:async()=>{},fetchSnapshots:async()=>new Promise<MarketSnapshot[]>(resolve=>resolvers.set(id,resolve))}) as unknown as ExchangeAdapter),
    deadlineMs:500,publish:async()=>{now+=40;}});
  const work=monitor.runOnce();await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(monitor.status().diagnostics!.currentBatch!.reads.length,3);
  now+=10;resolvers.get('gate')!(Array.from({length:8},(_,i)=>quote('gate',`COIN0${i}`,now)));
  await new Promise<void>(resolve=>setImmediate(resolve));
  now+=20;resolvers.get('bybit')!(Array.from({length:8},(_,i)=>quote('bybit',`COIN0${i}`,now)));
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(monitor.status().diagnostics!.currentBatch!.publishStartedAt,undefined,'the original complete-batch publication barrier remains');
  now+=70;resolvers.get('bitget')!([quote('bitget','COIN01',now)]);await work;
  const diagnostics=monitor.status().diagnostics!,batch=diagnostics.recentBatches[0];
  assert.equal(batch.routes[0].queuedAt,START);assert.equal(batch.routes[0].pairedAt,START+30);
  assert.equal(batch.publishStartedAt,START+100);assert.equal(batch.publishedAt,START+140);
  assert.equal(diagnostics.queueWaitP95Ms,0);assert.equal(diagnostics.readP95Ms,100);assert.equal(diagnostics.publishP95Ms,40);
  assert.equal(batch.routes[0].selectionReason,'funding-priority');assert.ok(batch.routes.slice(6).every(route=>route.selectionReason==='fair-rotation'));
  assert.equal(diagnostics.queuedCoins,16);assert.equal(diagnostics.oldestQueuedAt,START);
  batch.routes[0].missingExchanges.push('gate');
  assert.deepEqual(monitor.status().diagnostics!.recentBatches[0].routes[0].missingExchanges,[],'callers cannot mutate stored evidence');
  await monitor.stop();
});

test('a publication failure is recorded without claiming a published or successful attempt',async t=>{
  const f=fixture();t.mock.method(Date,'now',()=>START);
  const failure=new Error('publication failed'),monitor=new PublicFundingMonitor({config:f.config,candidates:()=>f.candidates,snapshots:()=>[],
    protectedBases:()=>new Set(),prefer:()=>true,adapters:f.factory,deadlineMs:20,publish:async()=>{throw failure;}});
  await assert.rejects(monitor.runOnce(),error=>error===failure);
  const status=monitor.status(),last=status.diagnostics!.recentBatches[0];
  assert.equal(last.outcome,'publish-failed');assert.equal(last.publishedAt,undefined);assert.equal(status.checkedCoins,0);
  assert.equal(status.diagnostics!.publishP95Ms,undefined);assert.equal(status.diagnostics!.currentBatch,undefined);assert.equal(f.financialCalls(),0);
  await monitor.stop();
});

test('public diagnostic history is bounded while queue wait retains the first locally due observation',async t=>{
  const f=fixture();let now=START;t.mock.method(Date,'now',()=>now);
  await f.monitor.runOnce();now+=100;f.setTime(now);await f.monitor.runOnce();
  const second=f.monitor.status().diagnostics!.recentBatches[1];
  assert.ok(second.routes.every(route=>route.queuedAt===START&&route.selectedAt===START+100));
  for(let i=0;i<PUBLIC_VERIFICATION_TIMING_LIMIT+2;i++){now+=120_001;f.setTime(now);await f.monitor.runOnce();}
  const diagnostics=f.monitor.status().diagnostics!;
  assert.equal(diagnostics.sampleCount,PUBLIC_VERIFICATION_TIMING_LIMIT);assert.equal(diagnostics.recentBatches.length,2,'list payload sends only the newest two detailed batches');
  assert.equal(diagnostics.totalBatches,PUBLIC_VERIFICATION_TIMING_LIMIT+4);assert.equal(f.financialCalls(),0);
  await f.monitor.stop();
});

test('a changed configuration or stop discards the complete previous-generation batch',async t=>{
  const f=fixture({slow:'gate'});t.mock.method(Date,'now',()=>START);
  const read=f.monitor.runOnce();await new Promise<void>(resolve=>setImmediate(resolve));f.replaceConfig();
  f.settleSlow([quote('gate','COIN00',START)]);await read;assert.equal(f.quotes.length,0);
  assert.equal(f.monitor.status().diagnostics!.recentBatches[0].outcome,'discarded');
  assert.equal(f.monitor.status().checkedCoins,0);await f.monitor.stop();
  const g=fixture({slow:'gate'}),other=g.monitor.runOnce();await new Promise<void>(resolve=>setImmediate(resolve));await g.monitor.stop();
  g.settleSlow([quote('gate','COIN00',START)]);await other;assert.equal(g.quotes.length,0);
});

test('authorized routes receive six priority places while two discovery places remain fair',async t=>{
  const f=fixture();let now=START;t.mock.method(Date,'now',()=>now);
  const selected:string[][]=[];
  const monitor=new PublicFundingMonitor({config:f.config,candidates:()=>f.candidates,snapshots:()=>[],protectedBases:()=>new Set(),
    prefer:c=>Number(c.base.slice(4))>=18,adapters:f.factory,deadlineMs:20,
    publish:async rows=>{selected.push([...new Set(rows.map(q=>q.base))]);}});
  await monitor.runOnce();assert.deepEqual(selected[0].slice(0,6),['COIN18','COIN19','COIN20','COIN21','COIN22','COIN23']);
  assert.deepEqual(selected[0].slice(6),['COIN00','COIN01']);
  now+=120_001;f.setTime(now);await monitor.runOnce();
  assert.deepEqual(selected[1].slice(6),['COIN02','COIN03'],'fair slots select untouched public coins even when preferred routes become due again');
  await monitor.stop();
});

test('ready routes outside the foreground core refresh within the quote budget while new coins keep being discovered',async t=>{
  const f=fixture();let now=START;t.mock.method(Date,'now',()=>now);let ready=new Set<string>();
  const monitor=new PublicFundingMonitor({config:f.config,candidates:()=>f.candidates,snapshots:()=>f.quotes,protectedBases:()=>new Set(),readyBases:()=>ready,
    prefer:()=>true,adapters:f.factory,deadlineMs:20,publish:async rows=>{f.quotes.push(...rows);}});
  await monitor.runOnce();ready=new Set(['COIN00']);
  now+=15_001;f.setTime(now);await monitor.runOnce();
  const batch=f.reads.at(-1)!.bases;assert.equal(batch[0],'COIN00');
  assert.ok(batch.some(base=>Number(base.slice(4))>=8),'ready renewal must preserve discovery capacity');
  assert.equal(monitor.status().failedCoins,0);await monitor.stop();
});

test('connected high-funding coins renew before metadata expiry without requiring a ready entry',async t=>{
  const f=fixture();let now=START;t.mock.method(Date,'now',()=>now);
  f.config().maxSnapshotAgeMs=30_000;
  // The funding route still merits fresh books while its settlement timing is blocked.
  f.candidates[0].candidateEligible=false;
  await f.monitor.runOnce();
  assert.ok(f.reads[0].bases.includes('COIN00'));
  now+=15_001;f.setTime(now);await f.monitor.runOnce();
  const renewed=f.reads.at(-1)!.bases;
  assert.ok(renewed.includes('COIN00'),'high funding renews within the 30s metadata limit even without readyBases');
  assert.ok(renewed.some(base=>Number(base.slice(4))>=8),'two fair discovery slots keep scanning new coins');
  assert.equal(f.financialCalls(),0);await f.monitor.stop();
});

test('priority coins rank by positive 8h advantage while an actionable route remains first',async t=>{
  const f=fixture();t.mock.method(Date,'now',()=>START);
  f.candidates[0].normalized8hBps=20;
  f.candidates[10].normalized8hBps=200;f.candidates[10].grossFundingUsd=.5;f.candidates[10].afterFeesUsd=.28;
  const monitor=new PublicFundingMonitor({config:f.config,candidates:()=>f.candidates,snapshots:()=>f.quotes,
    protectedBases:()=>new Set(),readyBases:()=>new Set(['COIN20']),prefer:()=>true,adapters:f.factory,deadlineMs:20,
    publish:async rows=>{f.quotes.push(...rows);}});
  await monitor.runOnce();
  assert.equal(f.reads[0].bases[0],'COIN20','ready routes retain first priority');
  assert.equal(f.reads[0].bases[1],'COIN10','higher normalized 8h funding outranks larger gross totals within priority');
  assert.equal(f.reads[0].bases[2],'COIN00');
  assert.equal(f.financialCalls(),0);await monitor.stop();
});

test('only eight connected positive-funding bases get the faster renewal cadence',async t=>{
  const f=fixture();let now=START;t.mock.method(Date,'now',()=>now);
  for(let i=0;i<4;i++){f.candidates[i].normalized8hBps=1000;f.candidates[i].grossFundingUsd=100;}
  const monitor=new PublicFundingMonitor({config:f.config,candidates:()=>f.candidates,snapshots:()=>f.quotes,
    protectedBases:()=>new Set(),prefer:c=>Number(c.base.slice(4))>=4,adapters:f.factory,deadlineMs:20,
    publish:async rows=>{f.quotes.push(...rows);}});
  for(let i=0;i<3;i++)await monitor.runOnce();
  assert.equal(monitor.status().pendingCoins,0);
  f.reads.length=0;
  now+=15_001;f.setTime(now);await monitor.runOnce();
  const fast=f.reads[0].bases;
  assert.equal(fast.length,PUBLIC_FUNDING_PRIORITY_COINS);
  assert.deepEqual(new Set(fast),new Set(Array.from({length:8},(_,i)=>`COIN${String(i+4).padStart(2,'0')}`)));
  assert.ok(fast.every(base=>Number(base.slice(4))>=4),'unconnected high rates do not enter the fast priority set');
  assert.equal(f.financialCalls(),0);await monitor.stop();
});

test('failure of a selected funding leg cannot be masked by two other venues for that coin',async t=>{
  const f=fixture({reject:'bybit'});let now=START;t.mock.method(Date,'now',()=>now);
  for(const c of [...f.candidates])f.candidates.push({...c,id:`${c.base}-gate-bitget`,shortExchange:'bitget',grossFundingUsd:c.grossFundingUsd-.01});
  const monitor=new PublicFundingMonitor({config:f.config,candidates:()=>f.candidates,snapshots:()=>f.quotes,
    protectedBases:()=>new Set(),prefer:()=>true,adapters:f.factory,deadlineMs:20,publish:async rows=>{f.quotes.push(...rows);}});
  await monitor.runOnce();
  assert.equal(new Set(f.quotes.filter(q=>q.base==='COIN00').map(q=>q.exchange)).size,2,'other two venue quotes exist');
  const attempts=(monitor as unknown as {attempts:Map<string,{at:number;failed:boolean}>}).attempts;
  assert.equal(attempts.get('COIN00')?.failed,true,'the selected gate/bybit route is missing its bybit leg');
  now+=15_001;f.setTime(now);await monitor.runOnce();
  assert.ok(!f.reads.at(-1)!.bases.includes('COIN00'),'a failed priority route keeps the existing 30s failure backoff');
  now=START+30_001;f.setTime(now);await monitor.runOnce();
  assert.ok(f.reads.at(-1)!.bases.includes('COIN00'));
  assert.equal(f.financialCalls(),0);await monitor.stop();
});

test('verified positive fee net outranks larger negative fee net and a legacy ready base',async t=>{
  const f=fixture();t.mock.method(Date,'now',()=>START);
  for(const c of f.candidates){c.afterFeesUsd=-1;c.expectedNetUsd=-1;}
  const positive=f.candidates[20];positive.grossFundingUsd=.1;positive.afterFeesUsd=.08;positive.expectedNetUsd=.08;positive.normalized8hBps=1;
  let priorityCalls=0;
  const monitor=new PublicFundingMonitor({config:f.config,candidates:()=>f.candidates,snapshots:()=>f.quotes,protectedBases:()=>new Set(),
    readyBases:()=>new Set(['COIN00']),prefer:()=>true,adapters:f.factory,deadlineMs:20,
    verificationPriorities:(candidates,now)=>{priorityCalls++;assert.equal(candidates,f.candidates);assert.equal(now,START);return new Map([[positive.id,3]]);},
    publish:async rows=>{f.quotes.push(...rows);}});
  try{
    await monitor.runOnce();
    assert.equal(priorityCalls,1,'verification evidence is evaluated once for the complete batch');
    assert.deepEqual(f.reads[0].bases.slice(0,2),['COIN20','COIN00']);
    assert.equal(f.reads[0].bases.length,PUBLIC_VERIFICATION_BATCH_SIZE);assert.equal(f.financialCalls(),0);
  }finally{await monitor.stop();}
});

test('IOC ready priority precedes positive fee net, ordinary ready and legacy ready bases',async t=>{
  const f=fixture();t.mock.method(Date,'now',()=>START);
  const net=f.candidates[20],ioc=f.candidates[21],ready=f.candidates[22],secondNet=f.candidates[23];
  net.normalized8hBps=50;secondNet.normalized8hBps=20;ioc.normalized8hBps=1;ready.normalized8hBps=100;
  const priorities=new Map([[net.id,3],[ioc.id,4],[ready.id,2],[secondNet.id,3]]);
  const monitor=new PublicFundingMonitor({config:f.config,candidates:()=>f.candidates,snapshots:()=>f.quotes,protectedBases:()=>new Set(),
    readyBases:()=>new Set(['COIN00','COIN22']),verificationPriorities:()=>priorities,prefer:()=>true,adapters:f.factory,deadlineMs:20,
    publish:async rows=>{f.quotes.push(...rows);}});
  try{
    await monitor.runOnce();
    assert.deepEqual(f.reads[0].bases.slice(0,5),['COIN21','COIN20','COIN23','COIN22','COIN00']);
    assert.equal(f.financialCalls(),0);
  }finally{await monitor.stop();}
});

test('unpreferred or foreground protected routes cannot use verification tiers to take priority places',async t=>{
  const f=fixture({protectedBases:['COIN01']});let now=START;t.mock.method(Date,'now',()=>now);
  const priorities=new Map([[f.candidates[0].id,4],[f.candidates[1].id,4],[f.candidates[20].id,3]]);
  const monitor=new PublicFundingMonitor({config:f.config,candidates:()=>f.candidates,snapshots:()=>f.quotes,protectedBases:()=>f.protectedBases,
    verificationPriorities:()=>priorities,prefer:c=>Number(c.base.slice(4))>=18,adapters:f.factory,deadlineMs:20,
    publish:async rows=>{f.quotes.push(...rows);}});
  try{
    await monitor.runOnce();
    assert.deepEqual(f.reads[0].bases.slice(0,6),['COIN20','COIN18','COIN19','COIN21','COIN22','COIN23']);
    assert.ok(f.reads.every(read=>!read.bases.includes('COIN01')));
    await monitor.runOnce();await monitor.runOnce();
    f.reads.length=0;now+=15_001;f.setTime(now);await monitor.runOnce();
    assert.ok(f.reads[0].bases.includes('COIN20'));assert.ok(!f.reads[0].bases.includes('COIN00'),'unpreferred IOC evidence does not grant faster renewal');
    assert.equal(f.financialCalls(),0);
  }finally{await monitor.stop();}
});

test('blocked positive fee net renews within 15 seconds and changing priorities reuse public clients',async t=>{
  const f=fixture();let now=START;t.mock.method(Date,'now',()=>now);f.config().maxSnapshotAgeMs=30_000;
  const blocked=f.candidates[20],next=f.candidates[21];
  for(const c of [blocked,next]){c.candidateEligible=false;c.grossFundingUsd=.01;c.afterFeesUsd=.005;c.expectedNetUsd=.005;c.normalized8hBps=0;}
  let priorities=new Map([[blocked.id,3]]);
  const monitor=new PublicFundingMonitor({config:f.config,candidates:()=>f.candidates,snapshots:()=>f.quotes,protectedBases:()=>new Set(),
    verificationPriorities:()=>priorities,prefer:()=>true,adapters:f.factory,deadlineMs:20,publish:async rows=>{f.quotes.push(...rows);}});
  try{
    await monitor.runOnce();assert.equal(f.reads[0].bases[0],'COIN20');
    now+=15_001;f.setTime(now);await monitor.runOnce();
    assert.equal(f.reads.at(-1)!.bases[0],'COIN20','positive fee net stays current while eligibility is blocked');
    assert.ok(f.reads.at(-1)!.bases.some(base=>Number(base.slice(4))>=8&&base!=='COIN20'),'renewal keeps discovery slots');
    priorities=new Map([[next.id,4]]);now+=15_001;f.setTime(now);await monitor.runOnce();
    assert.equal(f.reads.at(-1)!.bases[0],'COIN21');
    assert.equal(f.factoryConfigs.length,1,'changing focus coins does not construct new public clients');
    assert.equal(f.closeCalls(),0,'changing focus coins does not close the existing public clients');
    assert.equal(f.financialCalls(),0);
  }finally{await monitor.stop();}
});

test('more than eight verified priority coins keep fair slots and only eight get fast renewal',async t=>{
  const f=fixture();let now=START;t.mock.method(Date,'now',()=>now);
  const priorities=new Map(f.candidates.map(c=>[c.id,3] as const));
  const monitor=new PublicFundingMonitor({config:f.config,candidates:()=>f.candidates,snapshots:()=>f.quotes,protectedBases:()=>new Set(),
    verificationPriorities:()=>priorities,prefer:()=>true,adapters:f.factory,deadlineMs:20,publish:async rows=>{f.quotes.push(...rows);}});
  try{
    await monitor.runOnce();
    now+=15_001;f.setTime(now);await monitor.runOnce();
    assert.deepEqual(f.reads.at(-1)!.bases.slice(6),['COIN08','COIN09'],'two fair places reach untouched coins ahead of previously read priority coins');
    await monitor.runOnce();await monitor.runOnce();
    assert.equal(monitor.status().pendingCoins,0);
    f.reads.length=0;now+=15_001;f.setTime(now);await monitor.runOnce();
    assert.deepEqual(new Set(f.reads[0].bases),new Set(Array.from({length:PUBLIC_FUNDING_PRIORITY_COINS},(_,i)=>`COIN${String(i).padStart(2,'0')}`)));
    const calls=f.reads.length;await monitor.runOnce();assert.equal(f.reads.length,calls,'additional verified coins retain the discovery cadence');
    assert.equal(f.financialCalls(),0);
  }finally{await monitor.stop();}
});

test('verification priority selects the actual route legs and preserves their 30 second failure backoff',async t=>{
  const f=fixture({reject:'bybit'});let now=START;t.mock.method(Date,'now',()=>now);
  const selected=f.candidates[20];selected.candidateEligible=false;selected.grossFundingUsd=.01;selected.normalized8hBps=0;
  for(const c of [...f.candidates])f.candidates.push({...c,id:`${c.base}-gate-bitget`,shortExchange:'bitget',grossFundingUsd:100});
  const monitor=new PublicFundingMonitor({config:f.config,candidates:()=>f.candidates,snapshots:()=>f.quotes,protectedBases:()=>new Set(),
    readyBases:()=>new Set(['COIN20']),verificationPriorities:()=>new Map([[selected.id,4]]),prefer:()=>true,adapters:f.factory,deadlineMs:20,
    publish:async rows=>{f.quotes.push(...rows);}});
  try{
    await monitor.runOnce();assert.equal(f.reads[0].bases[0],'COIN20');
    assert.ok(f.reads.every(read=>new Set(read.bases).size===read.bases.length),'each venue reads each selected coin once');
    assert.deepEqual(new Set(f.quotes.filter(q=>q.base==='COIN20').map(q=>q.exchange)),new Set(['gate','bitget']));
    const attempts=(monitor as unknown as {attempts:Map<string,{at:number;failed:boolean}>}).attempts;
    assert.equal(attempts.get('COIN20')?.failed,true,'two other quotes do not mask the missing selected bybit leg');
    now+=15_001;f.setTime(now);await monitor.runOnce();
    assert.ok(!f.reads.at(-1)!.bases.includes('COIN20'),'ready IOC verification still respects a failed selected leg');
    now=START+30_001;f.setTime(now);await monitor.runOnce();assert.equal(f.reads.at(-1)!.bases[0],'COIN20');
    assert.equal(f.factoryConfigs.length,1);assert.equal(f.financialCalls(),0);
  }finally{await monitor.stop();}
});

test('stuck background HTTP reads do not occupy the engine tick or execute orders',async()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'funding-public-monitor-'));
  const config:AppConfig={...defaultConfig,mode:'paper',dataSource:'public',entryPolicy:'aligned',exchanges:['gate','bybit'],symbols:['BTC']};
  const store=new Store(path.join(directory,'state.json'),config);let backgroundGateResolve:(rows:MarketSnapshot[])=>void=()=>{},privateCalls=0;
  const adapters=(next:AppConfig)=>next.exchanges.map(id=>({id,fetchSnapshots:async bases=>bases.map(base=>quote(id,base,Date.now())),
    fetchAccount:async()=>{privateCalls++;throw new Error('No private reads');},prepareTrading:async()=>{privateCalls++;},
    placeOrder:async()=>{privateCalls++;throw new Error('No orders');},cancelOrder:async()=>{privateCalls++;},reconcileOrder:async()=>{privateCalls++;throw new Error('No orders');},
    fetchFundingPayments:async()=>{privateCalls++;return [];},close:async()=>{}} as ExchangeAdapter));
  const stats=()=>{const now=Date.now();return {source:'exchanges' as const,range:'current' as const,status:'ready' as const,receivedAt:now,lastAttemptAt:now,nextRefreshAt:now+20_000,maxAgeMs:120_000,sourceUrl:'https://example.test',marginScope:'USDT' as const,
    rows:Array.from({length:24},(_,i)=>({base:`COIN${i}`,cells:Object.fromEntries(config.exchanges.map(exchange=>[exchange,{exchange,rate:exchange==='gate'?0:.001,intervalHours:8,nextFundingTime:now+3600_000,updatedAt:now,available:true}]))}))};};
  const engine=new Engine(store,false,{adapterFactory:adapters,fundingStatistics:stats,publicSnapshotDeadlineMs:80,
    publicMonitoringAdapterFactory:next=>adapters(next).map(a=>a.id==='gate'?{...a,fetchSnapshots:async()=>new Promise<MarketSnapshot[]>(resolve=>{backgroundGateResolve=resolve;})}:a)});
  try{
    const monitor=(engine as unknown as {publicFundingMonitor():PublicFundingMonitor}).publicFundingMonitor();
    const scan=monitor.runOnce();await new Promise<void>(resolve=>setImmediate(resolve));
    await engine.tick();assert.equal(monitor.status().running,true,'foreground tick must complete while the independent background read is unresolved');
    assert.ok(engine.snapshots.length>=12);assert.equal(privateCalls,0);
    backgroundGateResolve([]);await scan;
    assert.equal(engine.autoEnabled,false);assert.equal(engine.store.data.orders.length,0);
  }finally{await engine.stop();rmSync(directory,{recursive:true,force:true});}
});
