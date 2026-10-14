import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/shared/config.js';
import type { AppState, Opportunity, Position } from '../src/shared/types.js';
import type { FundingCandidateView, FundingOpportunitiesResponse } from '../src/shared/funding-opportunities.js';
import { candidateCanSubmit, candidateReadyToStart, candidateReadyWithIoc20, candidateExecutionIsFresh, candidateOccupiedReason, sortCandidateRows, summarizeCandidateReadiness, type CandidateReadinessContext } from '../web/src/candidate-readiness.js';
import {synchronizeCandidateAuthorization} from '../web/src/candidate-authorization.js';

const NOW=1_800_000_000_000;
function candidate(base:string,funding=.1):FundingCandidateView {
  const execution={id:`${base}-gate-bitget`,base,longExchange:'gate',shortExchange:'bitget',entryPolicy:'aligned',eligible:true,reasons:[],checks:[
    {group:'funding',label:'预计资金费为正',pass:true,reason:'预计资金费不为正'},
    {group:'execution',label:'实际 IOC 开仓价格优势达标',pass:true,reason:'开仓价格不具有优势'},
    {group:'account',label:'两腿保证金可用',pass:null,reason:'提交前检查保证金'},
  ],expectedFundingUsd:funding,feesUsd:.21,feesSource:'exchange',entryLimitPriceEdgeBps:30,longObservedAt:NOW-100,shortObservedAt:NOW-50,
    spreadAdvantage:{status:'ready',estimateMethod:'current-book',expectedSpreadPnlUsd:-.03}} as unknown as Opportunity;
  return {id:execution.id,base,longExchange:'gate',shortExchange:'bitget',longRate:0,shortRate:.001,longIntervalHours:8,shortIntervalHours:8,
    normalized8hBps:10,aprPct:109.5,notionalUsd:100,nextFundingTime:NOW+3_600_000,exitTime:NOW+3_610_000,
    longFundingCount:1,shortFundingCount:1,grossFundingUsd:funding,feesUsd:.21,afterFeesUsd:funding-.21,expectedNetUsd:funding-.21,
    slippageBudgetUsd:0,transferCostUsd:0,fundingHaircutUsd:0,basisReserveUsd:0,candidateEligible:true,reasons:[],updatedAt:NOW-200,
    verification:'verified',execution,executionObservedAt:NOW-100};
}
function context(rows:FundingCandidateView[]):CandidateReadinessContext {
  const state={config:{...structuredClone(defaultConfig),mode:'live',entryPolicy:'aligned',minEntryIocEdgeBps:0},killSwitch:false,positions:[],liveUnlocked:true,
    liveReadiness:{unlocked:true,ready:true,reasons:[],excludedCoins:[],exchanges:(['gate','bitget','binance'] as const).map(exchange=>({exchange,supported:true,credentialsConfigured:exchange!=='binance',executionAuthorized:exchange!=='binance'}))}} as unknown as AppState;
  const data={source:'exchanges',status:'ready',receivedAt:NOW,maxAgeMs:120_000,computedAt:NOW,coinCount:rows.length,pairCount:rows.length,verificationLimit:6,rows} as FundingOpportunitiesResponse;
  return {state,data,now:NOW,synchronized:true};
}
const bases=(rows:FundingCandidateView[])=>rows.map(row=>row.base);
const sorted=(rows:FundingCandidateView[],ctx=context(rows),direction:'asc'|'desc'='desc',prioritize=true)=>sortCandidateRows(rows,'grossFundingUsd',direction,ctx,prioritize);

test('same-response readiness counts distinguish absent, stale, failed and pending evidence without granting submission',t=>{
  t.mock.method(Date,'now',()=>{throw new Error('summary must use the supplied common clock');});
  const ready=candidate('READY'),missing=candidate('MISSING'),stale=candidate('STALE'),failed=candidate('FAILED'),pending=candidate('PENDING'),sync=candidate('SYNC');
  delete missing.execution;missing.verification='pending';stale.execution!.longObservedAt=NOW-30_001;
  failed.execution!.checks![0].pass=false;pending.execution!.checks![0].pass=null;sync.verification='pending';
  const rows=[ready,missing,stale,failed,pending,sync],ctx=context(rows),before=structuredClone(ctx);
  const summary=summarizeCandidateReadiness(ctx);
  assert.equal(summary.total,6);assert.equal(summary.executionMissing,1);assert.equal(summary.executionStale,1);assert.equal(summary.executionCurrent,4);
  assert.equal(summary.marketChecksFailed,1);assert.equal(summary.marketChecksPending,1);
  assert.deepEqual([...summary.prepared].map(row=>row.base),['READY','SYNC']);assert.deepEqual([...summary.submittable].map(row=>row.base),['READY']);
  assert.equal(summary.computedAt,NOW);assert.equal(summary.evaluatedAt,NOW);assert.equal(summary.observationUnavailable,false);
  assert.deepEqual(ctx,before,'explanation does not rewrite observations or grant eligibility');
});

test('local service or list unavailability suppresses submission while preserving labelled response evidence',()=>{
  const rows=[candidate('READY')],ctx=context(rows);
  for(const change of [{unavailable:true},{synchronized:false}]){
    const summary=summarizeCandidateReadiness({...ctx,...change});
    assert.equal(summary.observationUnavailable,true);assert.equal(summary.executionCurrent,1);assert.equal(summary.marketChecksFailed,0);
    assert.equal(summary.prepared.size,0);assert.equal(summary.submittable.size,0);
  }
  ctx.now=NOW+30_001;const expired=summarizeCandidateReadiness(ctx);
  assert.equal(expired.executionCurrent,0);assert.equal(expired.executionStale,1);assert.equal(expired.prepared.size,0);
});

test('pending orders remain per-coin and do not change evidence or readiness for other coins',()=>{
  const rows=[candidate('ONE'),candidate('TWO')],ctx=context(rows);ctx.pendingBases=new Set(['ONE']);
  const summary=summarizeCandidateReadiness(ctx);
  assert.equal(summary.executionCurrent,2);assert.equal(summary.marketChecksFailed,0);
  assert.deepEqual([...summary.prepared].map(row=>row.base),['TWO']);assert.deepEqual([...summary.submittable].map(row=>row.base),['TWO']);
  assert.equal(summarizeCandidateReadiness({...ctx,data:null}).total,0);
});

test('default readiness priority keeps high positive funding with pending, unavailable or occupied conditions below submit-ready rows',()=>{
  const ready=candidate('READY'),pending=candidate('PENDING',10),unconfigured=candidate('UNCONFIGURED',9),held=candidate('HELD',8),stale=candidate('STALE',7),ioc=candidate('IOC',6),failed=candidate('MODE',5);
  delete pending.execution;pending.verification='pending';unconfigured.longExchange='binance';unconfigured.execution!.longExchange='binance';
  stale.execution!.longObservedAt=NOW-30_001;ioc.execution!.entryLimitPriceEdgeBps=-1;
  failed.execution!.checks!.push({group:'execution',label:'合约模式和杠杆参数已确认',pass:false,reason:'Bitget 合约模式、杠杆参数未取得'});
  const rows=[pending,held,ioc,ready,unconfigured,failed,stale],ctx=context(rows);ctx.state.positions=[{id:'held',base:'HELD',status:'open'} as Position];
  assert.equal(candidateCanSubmit(ready,ctx),true);assert.deepEqual(bases(sorted(rows,ctx)),['READY','PENDING','UNCONFIGURED','HELD','STALE','IOC','MODE']);
  for(const row of [pending,held,ioc,unconfigured,failed,stale])assert.equal(candidateCanSubmit(row,ctx),false,row.base);
  assert.equal(sorted(rows,ctx).length,rows.length);
});

test('columns sort within readiness groups in either direction and the explicit toggle restores full-market financial sorting',()=>{
  const rows=[candidate('LOW',.1),candidate('HIGH',.4),candidate('BLOCKED',10)],ctx=context(rows);
  rows[2].execution!.eligible=false;
  assert.deepEqual(bases(sorted(rows,ctx)),['HIGH','LOW','BLOCKED']);
  assert.deepEqual(bases(sorted(rows,ctx,'asc')),['LOW','HIGH','BLOCKED']);
  assert.deepEqual(bases(sorted(rows,ctx,'desc',false)),['BLOCKED','HIGH','LOW']);
  assert.deepEqual(bases(rows),['LOW','HIGH','BLOCKED']);
});

test('permission revocation and restoration immediately reorder existing rows without new market responses',()=>{
  const rows=[candidate('LOW',.1),candidate('HIGH',1)],ctx=context(rows);rows[1].longExchange='binance';rows[1].execution!.longExchange='binance';
  assert.deepEqual(bases(sorted(rows,ctx)),['LOW','HIGH']);
  const account=ctx.state.liveReadiness!.exchanges.find(item=>item.exchange==='binance')!;
  account.credentialsConfigured=true;account.executionAuthorized=true;
  assert.deepEqual(bases(sorted(rows,ctx)),['HIGH','LOW']);
  account.executionAuthorized=false;
  assert.deepEqual(bases(sorted(rows,ctx)),['LOW','HIGH']);
  account.executionAuthorized=undefined;
  assert.equal(candidateCanSubmit(rows[1],ctx),false);
});

test('held and unresolved coins remain visible and are demoted without affecting other coins on the same venues',()=>{
  const rows=[candidate('HIGH',1),candidate('LOW',.1)],ctx=context(rows);
  ctx.state.positions=[{id:'current',base:'HIGH',status:'open'} as Position];
  assert.match(candidateOccupiedReason(rows[0],ctx.state)!,/继续监测/);
  assert.deepEqual(bases(sorted(rows,ctx)),['LOW','HIGH']);
  ctx.state.positions[0].accountClosure={confirmedAt:NOW} as Position['accountClosure'];
  assert.deepEqual(bases(sorted(rows,ctx)),['HIGH','LOW']);
  ctx.pendingBases=new Set(['HIGH']);assert.deepEqual(bases(sorted(rows,ctx)),['LOW','HIGH']);
  ctx.pendingBases=undefined;ctx.state.liveReadiness!.excludedCoins=[{base:'HIGH',exchanges:['gate'],reasons:['交易所已有该币种持仓']}];
  assert.deepEqual(bases(sorted(rows,ctx)),['LOW','HIGH']);
});

test('a closed history record or an invalid closure proof cannot respectively block or erase an active coin',()=>{
  const row=candidate('TEST'),ctx=context([row]);ctx.state.positions=[{id:'closed',base:'TEST',status:'closed'} as Position];
  assert.equal(candidateCanSubmit(row,ctx),true);
  ctx.state.positions=[{id:'active',base:'TEST',status:'open',accountClosure:{confirmedAt:NaN}} as Position];assert.equal(candidateCanSubmit(row,ctx),false);
});

test('two-leg observed freshness and skew cannot be replaced by a fresh statistics timestamp',()=>{
  const high=candidate('HIGH',1),low=candidate('LOW',.1),ctx=context([high,low]);
  for(const times of [[NOW-30_001,NOW],[NOW-4000,NOW],[NOW+5001,NOW],[NaN,NOW],[undefined,NOW]]){
    [high.execution!.longObservedAt,high.execution!.shortObservedAt]=times;
    assert.equal(candidateCanSubmit(high,ctx),false,`${times}`);assert.deepEqual(bases(sorted([high,low],ctx)),['LOW','HIGH']);
  }
  high.execution!.longObservedAt=NOW;high.execution!.shortObservedAt=NOW;
  assert.equal(candidateCanSubmit(high,ctx),true);
  high.executionObservedAt=NOW-30_001;assert.equal(candidateCanSubmit(high,ctx),false);
});

test('time advances demote expired opportunities without a new API response',()=>{
  const high=candidate('HIGH',1),low=candidate('LOW',.1),ctx=context([high,low]);high.execution!.longObservedAt=NOW-29_500;
  ctx.state.config.maxQuoteSkewMs=30_000;
  assert.deepEqual(bases(sorted([high,low],ctx)),['HIGH','LOW']);
  ctx.now=NOW+501;assert.deepEqual(bases(sorted([high,low],ctx)),['LOW','HIGH']);
  high.execution!.longObservedAt=ctx.now;high.execution!.shortObservedAt=ctx.now;high.executionObservedAt=ctx.now;high.nextFundingTime=ctx.now;
  assert.equal(candidateCanSubmit(high,ctx),false);
});

test('compatible old payloads may omit both observation fields but explicit invalid observations fail',()=>{
  const row=candidate('LEGACY'),ctx=context([row]);delete row.execution!.longObservedAt;delete row.execution!.shortObservedAt;delete row.executionObservedAt;
  assert.equal(candidateExecutionIsFresh(row,ctx.state,NOW),true);assert.equal(candidateCanSubmit(row,ctx),true);
  row.executionObservedAt=NaN;assert.equal(candidateCanSubmit(row,ctx),false);
});

test('backend eligibility, completed market data and IOC conditions must agree; only account checks may be deferred to submission',()=>{
  const row=candidate('READY'),ctx=context([row]);assert.equal(candidateCanSubmit(row,ctx),true);
  row.execution!.checks!.push({group:'market',label:'整笔数量盘口已取得',pass:null,reason:'盘口读取中'});assert.equal(candidateCanSubmit(row,ctx),false);
  row.execution!.checks!.pop();row.execution!.eligible=false;assert.equal(candidateCanSubmit(row,ctx),false);
  row.execution!.eligible=true;row.verification='pending';assert.equal(candidateCanSubmit(row,ctx),false);
});

test('a global 100U readiness estimate cannot block a pair eligible at its rounded 94U size with 49U available',()=>{
  const ready=candidate('ROUNDED',.1),blocked=candidate('TOO_LARGE',10),ctx=context([blocked,ready]);
  ctx.state.liveReadiness!.ready=false;ctx.state.liveReadiness!.reasons=['每腿100U预算估计保证金不足'];
  for(const account of ctx.state.liveReadiness!.exchanges)Object.assign(account,{freeUsd:49,requiredUsd:50.1});
  ready.notionalUsd=94;ready.execution!.notionalUsd=94;
  ready.execution!.checks!.push({group:'account',label:'两腿实际数量保证金可用',pass:true,reason:'实际保证金不足',actual:'49U可用 / 47U所需'});
  blocked.execution!.eligible=false;blocked.execution!.checks!.push({group:'account',label:'两腿实际数量保证金可用',pass:false,reason:'实际保证金不足'});
  assert.equal(candidateCanSubmit(ready,ctx),true);assert.equal(candidateCanSubmit(blocked,ctx),false);
  assert.deepEqual(bases(sorted([blocked,ready],ctx)),['ROUNDED','TOO_LARGE']);
});

test('synchronization, data errors, kill state and global account permission suppress priority and submission together',()=>{
  for(const change of [(ctx:CandidateReadinessContext)=>{ctx.synchronized=false;},(ctx:CandidateReadinessContext)=>{ctx.unavailable=true;},(ctx:CandidateReadinessContext)=>{ctx.state.killSwitch=true;},(ctx:CandidateReadinessContext)=>{ctx.state.liveUnlocked=false;},(ctx:CandidateReadinessContext)=>{ctx.state.liveReadiness!.unlocked=false;},(ctx:CandidateReadinessContext)=>{ctx.data!.status='error';}]){
    const row=candidate('READY'),ctx=context([row]);change(ctx);assert.equal(candidateCanSubmit(row,ctx),false);
  }
});

function prepareBeforeStart(row:FundingCandidateView):CandidateReadinessContext {
  const ctx=context([row]);ctx.state.liveUnlocked=false;ctx.state.liveReadiness!.unlocked=false;
  for(const account of ctx.state.liveReadiness!.exchanges)account.executionAuthorized=false;
  row.execution!.entryReady=true;row.execution!.eligible=false;row.verification='blocked';
  row.execution!.checks!.push({group:'account',label:'两腿交易账户已授权',pass:false,reason:'实盘执行锁定或该交易所账户未就绪'});
  row.execution!.checks!.push({group:'account',label:'两腿账户读取就绪',pass:true,reason:'账户读取未就绪'});
  ctx.state.livePortfolio={timestamp:NOW,pollIntervalMs:10_000,maxAgeMs:30_000,exchanges:(['gate','bitget'] as const).map(exchange=>({exchange,credentialsConfigured:true,status:'ready',requestedAt:NOW-100,receivedAt:NOW-50,positions:[],freeUsd:500,equityUsd:500}))};
  return ctx;
}

test('an explicit verified manual-ready pair is clickable without starting or authorizing automatic trading',()=>{
  const row=candidate('MANUAL'),ctx=prepareBeforeStart(row);row.verification='verified';
  const before=structuredClone(ctx.state);
  assert.equal(candidateReadyToStart(row,ctx),true);assert.equal(candidateCanSubmit(row,ctx),true);
  assert.equal(ctx.state.liveUnlocked,false);assert.deepEqual(ctx.state,before);
  row.execution!.checks!.push({group:'execution',label:'两腿合约只读检查就绪',pass:false,reason:'Bitget 合约设置待确认'});
  assert.equal(candidateCanSubmit(row,ctx),false,'Manual independence does not bypass the concrete contract check.');
});

test('manual submission works for a server-prepared pair outside an already unlocked session scope',()=>{
  const row=candidate('MANUAL'),ctx=prepareBeforeStart(row);
  ctx.state.liveUnlocked=true;ctx.state.liveReadiness!.unlocked=true;
  ctx.state.liveReadiness!.exchanges.find(account=>account.exchange==='bitget')!.executionAuthorized=true;
  const before=structuredClone(ctx.state),synchronized=synchronizeCandidateAuthorization(row,ctx.state);
  assert.equal(synchronized.execution!.eligible,false);assert.equal(synchronized.verification,'verified');
  assert.equal(candidateReadyToStart(synchronized,ctx),true);assert.equal(candidateCanSubmit(synchronized,ctx),true);
  assert.deepEqual(ctx.state,before,'Rendering and enabling the acknowledged manual click must leave the session scope untouched.');
});

test('manual readiness outside the session scope still rejects unknown, failed, stale or occupied accounts',()=>{
  for(const change of [
    (ctx:CandidateReadinessContext)=>{delete ctx.state.livePortfolio;},
    (ctx:CandidateReadinessContext)=>{ctx.state.liveReadiness!.exchanges=ctx.state.liveReadiness!.exchanges.filter(account=>account.exchange!=='gate');},
    (ctx:CandidateReadinessContext)=>{ctx.state.liveReadiness!.exchanges[0].credentialsConfigured=false;},
    (ctx:CandidateReadinessContext)=>{ctx.state.liveReadiness!.exchanges[0].supported=false;},
    (ctx:CandidateReadinessContext)=>{ctx.state.livePortfolio!.exchanges[0].status='error';},
    (ctx:CandidateReadinessContext)=>{ctx.state.livePortfolio!.exchanges[0].receivedAt=NOW-30_001;},
    (ctx:CandidateReadinessContext)=>{ctx.state.livePortfolio!.exchanges[0].positions=[{base:'MANUAL',quantity:1} as never];},
  ]){
    const row=candidate('MANUAL'),ctx=prepareBeforeStart(row);
    ctx.state.liveUnlocked=true;ctx.state.liveReadiness!.unlocked=true;
    ctx.state.liveReadiness!.exchanges.find(account=>account.exchange==='bitget')!.executionAuthorized=true;change(ctx);
    const synchronized=synchronizeCandidateAuthorization(row,ctx.state);
    assert.equal(candidateReadyToStart(synchronized,ctx),false);assert.equal(candidateCanSubmit(synchronized,ctx),false);
  }
});

test('read-only ready pairs rank before start and retain the same readiness after starting without granting submission',()=>{
  const ready=candidate('READY',.1),high=candidate('BLOCKED',10),ctx=prepareBeforeStart(ready);
  ctx.data!.rows.push(high);high.execution!.entryReady=false;
  const before=structuredClone(ctx.state);
  assert.equal(candidateReadyToStart(ready,ctx),true);assert.equal(candidateCanSubmit(ready,ctx),false);
  assert.deepEqual(bases(sorted([high,ready],ctx)),['READY','BLOCKED']);assert.deepEqual(ctx.state,before);
  ctx.state.liveUnlocked=true;ctx.state.liveReadiness!.unlocked=true;
  for(const account of ctx.state.liveReadiness!.exchanges)account.executionAuthorized=true;
  assert.equal(candidateReadyToStart(ready,ctx),true);assert.equal(candidateCanSubmit(ready,ctx),false,'fresh server permission reply still required');
  ready.execution!.eligible=true;ready.verification='verified';ready.execution!.checks!.find(check=>check.label==='两腿交易账户已授权')!.pass=true;
  assert.equal(candidateCanSubmit(ready,ctx),true);assert.deepEqual(bases(sorted([high,ready],ctx)),['READY','BLOCKED']);
});

test('prestart readiness requires actual fresh configured account data and never treats credentials alone as proof',()=>{
  for(const change of [(ctx:CandidateReadinessContext)=>{delete ctx.state.livePortfolio;},(ctx:CandidateReadinessContext)=>{ctx.state.livePortfolio!.exchanges[0].status='error';},(ctx:CandidateReadinessContext)=>{ctx.state.livePortfolio!.exchanges[0].receivedAt=NOW-30_001;},(ctx:CandidateReadinessContext)=>{ctx.state.livePortfolio!.exchanges[0].freeUsd=NaN;},(ctx:CandidateReadinessContext)=>{ctx.state.liveReadiness!.exchanges[0].credentialsConfigured=false;},(ctx:CandidateReadinessContext)=>{ctx.state.livePortfolio!.exchanges[0].positions=[{base:'READY',quantity:1} as never];}]){
    const row=candidate('READY'),ctx=prepareBeforeStart(row);change(ctx);
    assert.equal(candidateReadyToStart(row,ctx),false);assert.equal(candidateCanSubmit(row,ctx),false);
  }
});

test('prestart readiness keeps pending coins, incomplete market checks and a zero IOC edge blocked',()=>{
  for(const change of [(ctx:CandidateReadinessContext,row:FundingCandidateView)=>{ctx.pendingBases=new Set([row.base]);},(_ctx:CandidateReadinessContext,row:FundingCandidateView)=>{row.execution!.entryLimitPriceEdgeBps=0;},(_ctx:CandidateReadinessContext,row:FundingCandidateView)=>{row.execution!.checks!.push({group:'market',label:'盘口已取得',pass:null,reason:'等待盘口'});}]){
    const row=candidate('READY'),ctx=prepareBeforeStart(row);change(ctx,row);assert.equal(candidateReadyToStart(row,ctx),false);
  }
});

test('ordinary readiness includes 5, 19 and 20 bps while the extra IOC >20 partition excludes them before and after start',()=>{
  for(const edge of [5,19,20]){
    const row=candidate(`EDGE${edge}`),ctx=prepareBeforeStart(row);row.execution!.entryLimitPriceEdgeBps=edge;
    assert.equal(candidateReadyToStart(row,ctx),true,`${edge} bps prepared before start`);
    assert.equal(candidateReadyWithIoc20(row,ctx),false);assert.equal(candidateCanSubmit(row,ctx),false);
    ctx.state.liveUnlocked=true;ctx.state.liveReadiness!.unlocked=true;
    for(const account of ctx.state.liveReadiness!.exchanges)account.executionAuthorized=true;
    row.execution!.eligible=true;row.verification='verified';row.execution!.checks!.find(check=>check.label==='两腿交易账户已授权')!.pass=true;
    assert.equal(candidateCanSubmit(row,ctx),true,`${edge} bps can submit with real permission`);
    assert.equal(candidateReadyWithIoc20(row,ctx),false);
  }
});

test('the separate IOC >20 partition uses actual limit edge and complete readiness, including floating-point boundary noise',()=>{
  const row=candidate('READY'),ctx=prepareBeforeStart(row);ctx.state.config.minEntryIocEdgeBps=0;
  for(const edge of [undefined,null,NaN,Infinity,-30,0,19.99,20,20+1e-10]){
    row.execution!.entryLimitPriceEdgeBps=edge;assert.equal(candidateReadyWithIoc20(row,ctx),false,`${edge}`);
  }
  row.execution!.entryLimitPriceEdgeBps=20.01;assert.equal(candidateReadyWithIoc20(row,ctx),true);assert.equal(candidateCanSubmit(row,ctx),false);
  row.execution!.entryPriceEdgeBps=500;row.execution!.entryLimitPriceEdgeBps=19;assert.equal(candidateReadyWithIoc20(row,ctx),false,'VWAP edge cannot replace actual IOC limit edge');
  row.execution!.entryLimitPriceEdgeBps=100;row.execution!.entryReady=false;assert.equal(candidateReadyWithIoc20(row,ctx),false,'edge alone does not prove a pair ready');
  row.execution!.entryReady=true;ctx.pendingBases=new Set([row.base]);assert.equal(candidateReadyWithIoc20(row,ctx),false);
});

test('aligned net sorting includes known statistical references while only verified entries receive readiness priority',()=>{
  const pending=candidate('REFERENCE',1),ready=candidate('READY',.4),missing=candidate('UNKNOWN',10);
  delete pending.execution;pending.verification='pending';pending.feesSource='reference';
  delete missing.execution;missing.verification='pending';
  const rows=[missing,ready,pending],ctx=context(rows),before=structuredClone(rows);
  assert.deepEqual(bases(sortCandidateRows(rows,'expectedNetUsd','desc',ctx,false)),['REFERENCE','READY','UNKNOWN']);
  assert.deepEqual(bases(sortCandidateRows(rows,'expectedNetUsd','asc',ctx,false)),['READY','REFERENCE','UNKNOWN']);
  assert.deepEqual(bases(sortCandidateRows(rows,'expectedNetUsd','desc',ctx,true)),['READY','REFERENCE','UNKNOWN']);
  assert.equal(candidateCanSubmit(pending,ctx),false);assert.equal(candidateReadyToStart(pending,ctx),false);
  assert.deepEqual(rows,before);
});
