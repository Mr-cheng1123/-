import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {defaultConfig,validateConfig} from '../src/shared/config.js';
import type {AppConfig,ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest,Position} from '../src/shared/types.js';
import {SpreadHistory} from '../src/core/spread-history.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import {Execution} from '../src/core/execution.js';
import {Engine} from '../src/core/engine.js';
import {SelectedPublicBookError} from '../src/core/selected-public-book-error.js';
import {Store} from '../src/core/store.js';
import {runBacktest} from '../src/core/backtest.js';
import {assessProfitExit,bothExitProfitsPass} from '../src/core/profit-exit.js';
import {evaluateHoldingDecision,confirmHoldingDecision} from '../src/core/holding-decision.js';

const settings=(extra:Partial<AppConfig>={}):AppConfig=>({...defaultConfig,mode:'live',feeOnly:true,dualAdvantageEnabled:true,
  exchanges:['gate','bybit'],symbols:['BTC'],orderNotionalUsd:100,holdMode:'once',...extra});
function quote(exchange:ExchangeId,at:number,change:Partial<MarketSnapshot>={}):MarketSnapshot{
  return {exchange,base:'BTC',symbol:'BTC/USDT:USDT',timestamp:at,markPrice:100,indexPrice:100,
    takerFeeRate:exchange==='gate'?.0005:.00055,takerFeeAt:change.observedAt??at,takerFeeSource:'exchange',
    fundingRate:exchange==='bybit'?.006:0,nextFundingTime:at+300000,intervalHours:8,fundingHistory:[],
    bids:[{price:exchange==='gate'?99.98:100.5,quantity:100}],asks:[{price:exchange==='gate'?100:100.52,quantity:100}],
    openInterestUsd:1e7,volume24hUsd:1e8,quantityStep:.001,minQuantity:.001,minNotional:5,contractSize:1,source:'public',...change};
}
function seeded(now:number,c=settings(),exitSpread=.14){
  const h=new SpreadHistory();
  for(let i=12;i>=1;i--){const at=now-i*15000;
    h.observe([quote('gate',at),quote('bybit',at,{bids:[{price:100.1,quantity:100}],asks:[{price:99.98+exitSpread,quantity:100}]})],c,at);
  }return h;
}
const opportunities=(now:number,c=settings(),h=seeded(now,c),quotes=[quote('gate',now),quote('bybit',now)])=>calculateOpportunities(quotes,c,now,h);
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);

test('production enables joint entry and validates independent timing/history settings',()=>{
  assert.equal(defaultConfig.dualAdvantageEnabled,true);
  assert.equal(validateConfig(defaultConfig).dualAdvantageEnabled,true);
  assert.throws(()=>validateConfig({...defaultConfig,spreadMinSpanSec:1800}),/回看区间/);
});
test('only both advantages pass: funding, executable spread, four fees counted once',()=>{
  const now=Date.now(),[o]=opportunities(now);
  assert.equal(o.eligible,true);assert.equal(o.spreadAdvantage?.status,'ready');
  near(o.spreadAdvantage!.entrySpreadBps,50);near(o.spreadAdvantage!.expectedExitSpreadBps!,14);
  near(o.spreadAdvantage!.expectedSpreadPnlUsd!,.36);
  near(o.feesUsd,.210275);near(o.combinedExpectedNetUsd!,.6+.36-.210275);
});
test('funding alone does not qualify when entry spread is below typical exit spread',()=>{
  const now=Date.now(),c=settings(),[o]=opportunities(now,c,seeded(now,c),[quote('gate',now),quote('bybit',now,{bids:[{price:100.1,quantity:100}]})]);
  assert.ok(o.fundingAfterFeesUsd!>0);assert.equal(o.eligible,false);assert.ok(o.reasons.some(r=>r.includes('价差没有优势')));
});
test('a positive spread can carry modest funding that does not cover four fees by itself',()=>{
  const now=Date.now(),c=settings({minCombinedNetUsd:0}),[o]=opportunities(now,c,seeded(now,c),[quote('gate',now),quote('bybit',now,{fundingRate:.001})]);
  assert.ok(o.spreadAdvantage!.expectedSpreadPnlUsd!>0);assert.ok(o.expectedFundingUsd>0);assert.ok(o.combinedExpectedNetUsd!>0);
  assert.equal(o.eligible,true,o.reasons.join('；'));
});
test('positive opening spread is insufficient when the historic exit spread is larger',()=>{
  const now=Date.now(),[o]=opportunities(now,settings(),seeded(now,settings(),.7));
  assert.ok(o.spreadAdvantage!.entrySpreadBps>0);assert.ok(o.spreadAdvantage!.expectedSpreadPnlUsd!<0);assert.equal(o.eligible,false);
});
test('uses full target-quantity depth, not favorable top-of-book quotes',()=>{
  const now=Date.now(),c=settings(),[o]=opportunities(now,c,seeded(now,c),[
    quote('gate',now,{asks:[{price:100,quantity:.1},{price:100.2,quantity:99}]}),
    quote('bybit',now,{bids:[{price:100.3,quantity:.1},{price:99.8,quantity:99}]})]);
  assert.ok(o.spreadAdvantage!.entrySpreadBps<0);assert.equal(o.eligible,false);
});
test('entry does not depend on a window, a confirmation lead or matching settlement clocks',()=>{
  const now=Date.now();
  for(const delta of [5*3600000,10000]){
    const [o]=opportunities(now,settings(),seeded(now),[quote('gate',now,{nextFundingTime:now+delta}),quote('bybit',now,{nextFundingTime:now+delta})]);
    assert.equal(o.eligible,true,o.reasons.join('；'));
  }
  const [skew]=opportunities(now,settings(),seeded(now),[quote('gate',now),quote('bybit',now,{nextFundingTime:now+600000})]);
  assert.equal(skew.eligible,true,skew.reasons.join('；'));
});
test('no zero exit assumption: missing history leaves combined forecast unknown',()=>{
  const now=Date.now(),[o]=opportunities(now,settings(),new SpreadHistory());
  assert.equal(o.eligible,false);assert.equal(o.combinedExpectedNetUsd,null);assert.equal(o.spreadAdvantage!.expectedExitSpreadBps,null);
});
test('cached or one-sided observations cannot manufacture sample count or duration',()=>{
  const now=Date.now(),c=settings(),h=new SpreadHistory(),old=now-200000;
  for(let i=0;i<12;i++)h.observe([quote('gate',old),quote('bybit',old+i*15000)],{...c,maxSnapshotAgeMs:300000},old+i*15000);
  const s=h.assess(quote('gate',now),quote('bybit',now),1,c,now);
  assert.equal(s.samples,1);assert.equal(s.status,'warming');assert.equal(s.observedSpanSec,0);
});

test('the responsive profile becomes ready after six real paired observations without manufacturing history',()=>{
  const now=Date.now(),c=settings(),h=new SpreadHistory(),eventTime=now-3600000;
  assert.equal(c.spreadMinSamples,6);assert.equal(c.spreadMinSpanSec,60);
  for(let i=6;i>=1;i--){
    const observedAt=now-i*15000;
    h.observe([quote('gate',eventTime,{observedAt}),quote('bybit',eventTime,{observedAt,
      bids:[{price:100.1,quantity:100}],asks:[{price:100.12,quantity:100}]})],c,observedAt);
  }
  const quotes=[quote('gate',eventTime,{observedAt:now,nextFundingTime:now+300000}),quote('bybit',eventTime,{observedAt:now,nextFundingTime:now+300000})];
  const o=calculateOpportunities(quotes,c,now,h)[0];
  assert.equal(o.spreadAdvantage!.samples,6);assert.equal(o.spreadAdvantage!.observedSpanSec,75);
  assert.equal(o.spreadAdvantage!.status,'ready');assert.equal(o.eligible,true);
  assert.equal(h.serialize().filter(row=>row.longExchange==='gate').length,6);
});

test('a sixth current observation remains excluded until the next independently read paired quote',()=>{
  const start=Date.now()-120000,c=settings(),h=new SpreadHistory();
  for(let index=0;index<6;index++){
    const at=start+index*15000;
    h.observe([quote('gate',at),quote('bybit',at)],c,at);
  }
  const currentAt=start+75000;
  const current=calculateOpportunities([quote('gate',currentAt),quote('bybit',currentAt)],c,currentAt,h)[0];
  assert.equal(current.spreadAdvantage!.samples,5);assert.equal(current.spreadAdvantage!.status,'warming');
  assert.equal(current.eligible,false);assert.equal(current.reasons.length,0);
  const nextAt=start+80000;
  assert.equal(h.assess(quote('gate',nextAt),quote('bybit',nextAt),1,c,nextAt).status,'ready');
});
test('current spread jump is excluded from its own historical baseline',()=>{
  const now=Date.now(),c=settings(),h=seeded(now,c),quotes=[quote('gate',now),quote('bybit',now,{asks:[{price:103,quantity:100}]})];
  h.observe(quotes,c,now);const s=h.assess(quotes[0],quotes[1],1,c,now);
  assert.equal(s.samples,12);near(s.expectedExitSpreadBps!,14);
});
test('baseline is a median; one extreme observation does not dominate it',()=>{
  const now=Date.now(),c=settings(),rows=seeded(now,c).serialize();
  rows.find(r=>r.longExchange==='gate')!.exitSpreadBps=1000;
  const s=new SpreadHistory(rows).assess(quote('gate',now),quote('bybit',now),1,c,now);
  near(s.expectedExitSpreadBps!,14);
});
test('restored history retains route/direction, amount, source and symbol identity',()=>{
  const now=Date.now(),c=settings(),h=new SpreadHistory(seeded(now,c).serialize());
  assert.equal(h.assess(quote('gate',now),quote('bybit',now),1,c,now).status,'ready');
  assert.equal(h.assess(quote('gate',now),quote('bybit',now),2,{...c,orderNotionalUsd:200},now).samples,0);
  assert.equal(h.assess(quote('gate',now,{source:'demo'}),quote('bybit',now,{source:'demo'}),1,c,now).samples,0);
  assert.equal(h.assess(quote('gate',now,{symbol:'OTHER/USDT:USDT'}),quote('bybit',now),1,c,now).samples,0);
});
test('expired or interrupted historical observations cannot authorize entry',()=>{
  const now=Date.now(),c=settings(),h=seeded(now,c),later=now+45000;
  const s=h.assess(quote('gate',later),quote('bybit',later),1,c,later);
  assert.equal(s.status,'warming');assert.ok(s.reason?.includes('过期'));
  assert.equal(h.assess(quote('gate',now+1900000),quote('bybit',now+1900000),1,c,now+1900000).samples,0);
});
test('joint strategy keeps equal base quantity even if notional hedge was selected',()=>{
  const now=Date.now(),c=settings({hedgeMode:'notional'}),[o]=opportunities(now,c,seeded(now,c),[quote('gate',now,{markPrice:99}),quote('bybit',now,{markPrice:101})]);
  assert.equal(o.longQuantity,o.shortQuantity);assert.equal(o.deltaUsd,0);
});
test('a predicted funding reversal does not block entry when the current funding is still positive',()=>{
  const now=Date.now(),[o]=opportunities(now,settings(),seeded(now),[quote('gate',now),quote('bybit',now,{predictedFundingRate:-.001})]);
  assert.equal(o.eligible,true,o.reasons.join('；'));
});
test('funding/mark-only backtest cannot silently pretend to validate the joint strategy',()=>{
  assert.throws(()=>runBacktest([],settings()),/历史双腿深度盘口/);
});

function engineFixture(extra:Partial<AppConfig>={}){
  const now=Date.now(),c=settings(extra),dir=mkdtempSync(path.join(tmpdir(),'joint-entry-offline-'));
  const store=new Store(path.join(dir,'state.json'),c);store.data.spreadObservations=seeded(now,c).serialize();
  const quotes=new Map<ExchangeId,MarketSnapshot>([['gate',quote('gate',now)],['bybit',quote('bybit',now)]]);
  const requests:Array<{exchange:ExchangeId;request:OrderRequest}>=[];
  let refresh:(exchange:ExchangeId)=>void=()=>{},validate:(exchange:ExchangeId)=>void=()=>{},balance=1000;
  const adapters=c.exchanges.map(exchange=>({id:exchange,fetchSnapshots:async()=>{refresh(exchange);return [quotes.get(exchange)!];},
    fetchAccount:async()=>({freeUsd:balance,equityUsd:balance,positions:[]}),inspectTrading:async()=>{},prepareTrading:async()=>{},
    validateOrder:async()=>{validate(exchange);},placeOrder:async(request:OrderRequest)=>{requests.push({exchange,request});return {
      id:'MOCK-'+exchange+'-'+requests.length,clientOrderId:request.clientOrderId,status:'filled' as const,filledQuantity:request.quantity,
      averagePrice:request.limitPrice,feeUsd:request.quantity*request.limitPrice*c.takerFees[exchange],timestamp:Date.now()};},
    reconcileOrder:async()=>{throw new Error('Unexpected mock reconciliation');},cancelOrder:async()=>{throw new Error('Unexpected mock cancel');},
    fetchFundingPayments:async()=>[],close:async()=>{}} as ExchangeAdapter));
  const engine=new Engine(store,true,{adapterFactory:()=>adapters,liveEnvironment:{ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',
    GATE_API_KEY:'OFFLINE-ONLY',GATE_API_SECRET:'OFFLINE-ONLY',BYBIT_API_KEY:'OFFLINE-ONLY',BYBIT_API_SECRET:'OFFLINE-ONLY'}});
  engine.snapshots=[...quotes.values()];engine.health.forEach(h=>{h.status='online';h.lastSuccess=now;});
  return {store,engine,quotes,requests,setRefresh:(fn:typeof refresh)=>{refresh=fn;},setValidate:(fn:typeof validate)=>{validate=fn;},setBalance:(value:number)=>{balance=value;}};
}
test('real engine path: final refresh reversal sends zero mock orders and creates no journal intents',async()=>{
  const f=engineFixture(),o=f.engine.currentOpportunities()[0];assert.equal(o.eligible,true);
  f.setRefresh(exchange=>{f.quotes.get(exchange)!.timestamp=Date.now();if(exchange==='bybit')f.quotes.get(exchange)!.fundingRate=-.006;});
  await assert.rejects(f.engine.open(o.id),/下单前复核/);assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);
});
test('real engine path: both quantities are recalculated from the final reference price',async()=>{
  const f=engineFixture(),id=f.engine.currentOpportunities()[0].id;
  f.setRefresh(exchange=>{const q=f.quotes.get(exchange)!;q.timestamp=Date.now();q.indexPrice=q.markPrice=200;
    q.bids=[{price:exchange==='gate'?199.98:201,quantity:100}];q.asks=[{price:exchange==='gate'?200:201.02,quantity:100}];});
  const p=await f.engine.open(id);assert.equal(p.status,'open');assert.equal(f.requests.length,2);
  assert.ok(f.requests.every(r=>r.request.quantity===.5));assert.equal(p.long.quantity,p.short.quantity);
});
test('real engine path: final executable notional exceeding available margin rejects both legs',async()=>{
  const f=engineFixture(),id=f.engine.currentOpportunities()[0].id;f.setBalance(50.2);
  f.setRefresh(exchange=>{const q=f.quotes.get(exchange)!;q.timestamp=Date.now();q.markPrice=105;
    q.bids=[{price:exchange==='gate'?104.98:105.5,quantity:100}];q.asks=[{price:exchange==='gate'?105:105.52,quantity:100}];});
  await assert.rejects(f.engine.open(id),/余额不足/);assert.equal(f.store.data.positions.length,0);assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);
});
test('joint execution cannot bypass the final entry validator',async()=>{
  const f=engineFixture(),p={id:'NO-VALIDATOR',base:'BTC',mode:'live',status:'opening',long:{exchange:'gate',symbol:'BTC/USDT:USDT'},
    short:{exchange:'bybit',symbol:'BTC/USDT:USDT'}} as Position;
  const execution=new Execution(f.store,{config:()=>f.store.data.config,snapshot:x=>f.quotes.get(x as ExchangeId),adapter:()=>{throw new Error('must not request adapter');},liveUnlocked:()=>true,halt:()=>{}});
  await assert.rejects(execution.open(p,1,1),/缺少最终收益复核/);assert.equal(f.store.data.orders.length,0);
});
test('mock complete cycle records actual funding, four fees and spread PnL once',async()=>{
  const f=engineFixture(),p=await f.engine.open(f.engine.currentOpportunities()[0].id);
  assert.equal(p.status,'open');p.fundingUsd=.6;
  f.setRefresh(exchange=>{const q=f.quotes.get(exchange)!;q.timestamp=Date.now();q.markPrice=q.indexPrice=101;
    q.bids=[{price:exchange==='gate'?101:101.12,quantity:100}];q.asks=[{price:exchange==='gate'?101.02:101.14,quantity:100}];});
  await f.engine.close(p.id);assert.equal(p.status,'closed');assert.equal(f.requests.length,4);
  near(p.realizedSpreadPnlUsd,.36);near(p.netPnlUsd,.6+.36-p.feesUsd);assert.equal(p.long.quantity,0);assert.equal(p.short.quantity,0);
});

test('spread that loses after fees on its own can still enter when the combined net clears the threshold',()=>{
  const now=Date.now(),c=settings(),[o]=opportunities(now,c,seeded(now,c),[quote('gate',now),quote('bybit',now,{bids:[{price:100.3,quantity:100}],asks:[{price:100.32,quantity:100}]})]);
  near(o.spreadAdvantage!.expectedSpreadPnlUsd!,.16);assert.ok(o.fundingAfterFeesUsd!>0);assert.ok(o.combinedExpectedNetUsd!>0);
  assert.ok(o.spreadAfterFeesUsd!<0);assert.equal(o.eligible,true,o.reasons.join('；'));
});
test('the entry decision uses the full-size spread, not a separate worst-limit gate',()=>{
  const now=Date.now(),c=settings(),[o]=opportunities(now,c,seeded(now,c),[quote('gate',now),quote('bybit',now,{
    bids:[{price:100.7,quantity:.9},{price:100.2,quantity:.1}],asks:[{price:100.72,quantity:100}]})]);
  assert.ok(o.spreadAfterFeesUsd!>0);assert.equal(o.eligible,true,o.reasons.join('；'));
});
test('a retired per-spread dollar threshold does not block a combined entry',()=>{
  const now=Date.now(),c=settings({minSpreadNetUsd:.2}),[o]=opportunities(now,c,seeded(now,c));
  assert.ok(o.spreadAfterFeesUsd!>0&&o.spreadAfterFeesUsd!<.2);assert.equal(o.eligible,true,o.reasons.join('；'));
  assert.equal(validateConfig({...defaultConfig,minSpreadNetUsd:-1}).minSpreadNetUsd,0);
  assert.equal(validateConfig({...defaultConfig,minSpreadNetUsd:undefined}).minSpreadNetUsd,0);
});
test('in-place book change during parameter checks creates zero entry intents',async()=>{
  const f=engineFixture(),id=f.engine.currentOpportunities()[0].id;
  f.setValidate(exchange=>{if(exchange==='bybit'){const q=f.quotes.get(exchange)!;q.bids=[{price:100.6,quantity:100}];q.asks=[{price:100.62,quantity:100}];}});
  const p=await f.engine.open(id);assert.equal(p.status,'closed');assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);
});

async function profitablePosition(){
  const f=engineFixture({holdMode:'adaptive'}),p=await f.engine.open(f.engine.currentOpportunities()[0].id),now=Date.now();
  assert.equal(p.status,'open');assert.ok(p.profitExitPolicy);
  p.openedAt=now-600000;p.profitExitPolicy!.firstFundingTime=now-30000;p.profitExitPolicy!.earliestExitAt=now-20000;
  // Advancing this synthetic position into a settled cycle also advances its actual opening-fill timeline.
  for(const journal of f.store.data.orders.filter(order=>order.positionId===p.id)){
    journal.createdAt=p.openedAt+1000;if(journal.result)journal.result.timestamp=journal.createdAt;
  }
  p.profitExitPolicy!.fundingChecks=[{exchange:'bybit',timestamp:now-30000}];p.short.lastFundingAt=now-30000;p.fundingUsd=.6;
  const update=(exchange:ExchangeId)=>{const q=f.quotes.get(exchange)!;q.timestamp=Date.now();q.markPrice=q.indexPrice=101;
    q.bids=[{price:exchange==='gate'?101:101.12,quantity:100}];q.asks=[{price:exchange==='gate'?101.02:101.14,quantity:100}];};
  f.setRefresh(update);update('gate');update('bybit');
  return {...f,p,now,update};
}
const profit=(f:Awaited<ReturnType<typeof profitablePosition>>)=>assessProfitExit(f.p,f.quotes.get('gate'),f.quotes.get('bybit'),f.store.data.config,Date.now());
const internal=(engine:Engine)=>engine as unknown as {managePositions:(now:number)=>Promise<void>;continueClosing:(p:Position,reason:string,options?:{pricing?:'best-opposite'|'depth';requireProfit?:boolean})=>Promise<boolean|undefined>;accrueLiveFunding:()=>Promise<void>};

test('profit exit rechecks new common batches and preserves its gate across continuation',async()=>{
  const f=await profitablePosition();
  f.p.holdDecision=evaluateHoldingDecision(f.p,f.quotes.get('gate'),f.quotes.get('bybit'),f.store.data.config);
  f.setRefresh(exchange=>{
    f.update(exchange);const q=f.quotes.get(exchange)!;
    if(exchange==='gate')q.bids=[{price:101,quantity:.2},{price:99,quantity:100}];
    else q.asks=[{price:f.requests.filter(row=>row.request.reduceOnly).length>=2?103:101.14,quantity:.2},{price:104,quantity:100}];
  });
  await internal(f.engine).continueClosing(f.p,f.p.holdDecision.reason);
  near(f.p.long.quantity,.8);near(f.p.short.quantity,.8);
  assert.equal(f.p.closePricing,'best-opposite');assert.equal(f.p.closeProfitRequired,true);
  const firstCount=f.requests.length;assert.equal(firstCount,4);
  await internal(f.engine).continueClosing(f.p,f.p.closeReason!);
  assert.equal(f.requests.length,firstCount,'unprofitable remaining common batches are not submitted on a later turn');
  assert.equal(f.p.long.quantity,f.p.short.quantity,'no hedge imbalance is created while profit is unavailable');
  // An explicit manual close is allowed to close a losing position and replaces
  // the profit-only intent, while preserving reduce-only first-level batching.
  await f.engine.close(f.p.id);
  assert.equal(f.p.status,'closed');assert.equal(f.p.closeProfitRequired,false);
  assert.ok(f.requests.slice(firstCount).every(row=>row.request.reduceOnly));
});

test('explicit emergency closing selects depth and overrides a saved profit-only intent',async()=>{
  const f=await profitablePosition();f.p.closePricing='best-opposite';f.p.closeProfitRequired=true;
  let received:unknown;
  f.engine.execution.close=async(_position,_reason,_guard,options)=>{received=options;return true;};
  await f.engine.control('kill');
  assert.deepEqual(received,{pricing:'depth',requireProfit:false});
});

test('an improved book during native validation cannot approve a losing old closing IOC limit',async()=>{
  const f=await profitablePosition();
  f.p.holdDecision=evaluateHoldingDecision(f.p,f.quotes.get('gate'),f.quotes.get('bybit'),f.store.data.config);
  assert.equal(f.p.holdDecision.exitSignal,'profit');
  f.setRefresh(exchange=>{f.update(exchange);if(exchange==='bybit')f.quotes.get(exchange)!.asks=[{price:102,quantity:100}];});
  f.setValidate(exchange=>{if(exchange==='bybit')f.quotes.get(exchange)!.asks=[{price:101.14,quantity:100}];});
  assert.equal(await internal(f.engine).continueClosing(f.p,f.p.holdDecision.reason),false);
  assert.equal(f.requests.length,2,'only the original opening orders exist; the permitted losing close price is rejected');
  assert.equal(f.store.data.orders.length,2);assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.p.status,'open');
});

test('actual receipt and executable exit profit override positive next funding to capture profit',async()=>{
  const f=await profitablePosition(),value=profit(f)!;assert.ok(bothExitProfitsPass(f.p,value));
  near(value.spreadPnlUsd,.36);near(value.netPnlUsd,.6+.36-value.totalFeesUsd);
  const decision=evaluateHoldingDecision(f.p,f.quotes.get('gate'),f.quotes.get('bybit'),f.store.data.config,Date.now());
  assert.equal(decision.action,'close');assert.equal(decision.exitSignal,'profit');assert.deepEqual(decision.exitProfit,value);
  let confirmation;
  for(let i=0;i<3;i++){
    const result=confirmHoldingDecision(decision,confirmation,f.now+i,f.now+i,3);confirmation=result.confirmation;
    assert.equal(result.decision.action,i===2?'close':'wait');
  }
  const regular=confirmHoldingDecision({...decision,exitSignal:undefined,exitProfit:undefined},confirmation,f.now+3,f.now+3,3);
  assert.equal(regular.confirmation?.count,1,'profit and carry exits use separate confirmation sequences');
});
test('predicted funding, delayed receipt or unsettled first cycle cannot claim actual profit',async()=>{
  const f=await profitablePosition();f.p.short.lastFundingAt=undefined;
  assert.equal(profit(f),undefined);assert.notEqual(evaluateHoldingDecision(f.p,f.quotes.get('gate'),f.quotes.get('bybit'),f.store.data.config).exitSignal,'profit');
  f.p.short.lastFundingAt=f.p.profitExitPolicy!.firstFundingTime-2000;assert.equal(profit(f),undefined);
  f.p.short.lastFundingAt=f.p.profitExitPolicy!.firstFundingTime;f.p.profitExitPolicy!.earliestExitAt=Date.now()+60000;assert.equal(profit(f),undefined);
});
test('every nonzero funding leg needs its own confirmed settlement receipt',async()=>{
  const f=await profitablePosition();f.p.profitExitPolicy!.fundingChecks.push({exchange:'gate',timestamp:f.p.profitExitPolicy!.firstFundingTime});
  assert.equal(profit(f),undefined);f.p.long.lastFundingAt=f.p.profitExitPolicy!.firstFundingTime;assert.ok(profit(f));
});
test('mark profit cannot substitute for losing or insufficient executable closing depth',async()=>{
  const f=await profitablePosition();assert.ok(f.p.short.entryPrice>f.p.long.entryPrice);
  const q=f.quotes.get('bybit')!;q.asks=[{price:102,quantity:100}];assert.equal(bothExitProfitsPass(f.p,profit(f)),false);
  q.asks=[{price:101.14,quantity:.1}];assert.equal(profit(f),undefined);
  q.asks=[{price:101.14,quantity:100}];q.timestamp=Date.now()-120000;assert.equal(profit(f),undefined);
});
test('negative actual funding, unmatched legs and old positions do not trigger profit capture',async()=>{
  const f=await profitablePosition();f.p.fundingUsd=-.5;assert.equal(bothExitProfitsPass(f.p,profit(f)),false);
  f.p.fundingUsd=.6;f.p.long.quantity=.5;assert.equal(profit(f),undefined);
  f.p.long.quantity=1;f.p.profitExitPolicy=undefined;assert.equal(profit(f),undefined);
  assert.equal(evaluateHoldingDecision(f.p,f.quotes.get('gate'),f.quotes.get('bybit'),f.store.data.config).action,'hold');
});
test('max holding limit and negative next carry remain exits even when profit is unavailable',async()=>{
  const f=await profitablePosition();f.p.fundingUsd=-.5;f.quotes.get('bybit')!.fundingRate=-.006;
  const carry=evaluateHoldingDecision(f.p,f.quotes.get('gate'),f.quotes.get('bybit'),f.store.data.config);assert.equal(carry.action,'close');assert.equal(carry.exitSignal,undefined);
  const hard=evaluateHoldingDecision(f.p,f.quotes.get('gate'),f.quotes.get('bybit'),{...f.store.data.config,maxHoldHours:.01});assert.equal(hard.forceClose,undefined);assert.equal(hard.action,'close');
});
test('real engine mocked cycle closes two legs after three advanced profit confirmations with fees once',async()=>{
  const f=await profitablePosition();
  for(let i=0;i<3;i++){
    const now=Date.now()+i;for(const q of f.quotes.values())q.timestamp=now;
    await internal(f.engine).managePositions(now);assert.equal(f.p.status,i<2?'open':'closed');
  }
  assert.equal(f.requests.length,4);assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);
  near(f.p.realizedSpreadPnlUsd,.36);near(f.p.netPnlUsd,.6+.36-f.p.feesUsd);
});
test('final closing refresh losing profit leaves position open with no close intents',async()=>{
  const f=await profitablePosition();f.p.holdDecision=evaluateHoldingDecision(f.p,f.quotes.get('gate'),f.quotes.get('bybit'),f.store.data.config);
  f.setRefresh(exchange=>{f.update(exchange);if(exchange==='bybit')f.quotes.get(exchange)!.asks=[{price:102,quantity:100}];});
  const result=await internal(f.engine).continueClosing(f.p,f.p.holdDecision.reason);
  assert.equal(result,false);assert.equal(f.p.status,'open');assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.requests.length,2);assert.equal(f.store.data.orders.length,2);assert.equal(f.p.holdDecision.exitProfit,undefined);
});
test('profit-taking preparation failure waits without freezing an otherwise healthy position',async()=>{
  const f=await profitablePosition();f.p.holdDecision=evaluateHoldingDecision(f.p,f.quotes.get('gate'),f.quotes.get('bybit'),f.store.data.config);
  f.setValidate(()=>{throw new Error('OFFLINE FIXTURE unavailable check');});
  assert.equal(await internal(f.engine).continueClosing(f.p,f.p.holdDecision.reason),false);
  assert.equal(f.p.status,'open');assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.requests.length,2);
});
test('permitted closing limits must profit even when weighted average closing prices pass',async()=>{
  const f=await profitablePosition();f.quotes.get('bybit')!.asks=[{price:101.1,quantity:.9},{price:101.5,quantity:.1}];
  assert.equal(bothExitProfitsPass(f.p,profit(f)),true);
  f.p.holdDecision=evaluateHoldingDecision(f.p,f.quotes.get('gate'),f.quotes.get('bybit'),f.store.data.config);
  f.setRefresh(exchange=>{f.update(exchange);if(exchange==='bybit')f.quotes.get(exchange)!.asks=[{price:101.1,quantity:.9},{price:101.5,quantity:.1}];});
  assert.equal(await internal(f.engine).continueClosing(f.p,f.p.holdDecision.reason),true);
});
test('live funding receipts set leg confirmation and deduplicate instead of reusing forecasts',async()=>{
  const f=await profitablePosition();f.p.short.lastFundingAt=undefined;f.p.fundingUsd=0;
  const adapter=f.engine.adapters.find(a=>a.id==='bybit')!;
  adapter.fetchFundingPayments=async()=>[{id:'OFFLINE-FUNDING',base:'BTC',amountUsd:.6,timestamp:f.p.profitExitPolicy!.firstFundingTime}];
  await internal(f.engine).accrueLiveFunding();assert.equal(f.p.fundingUsd,.6);assert.equal(f.p.short.lastFundingAt,f.p.profitExitPolicy!.firstFundingTime);
  await internal(f.engine).accrueLiveFunding();assert.equal(f.p.fundingUsd,.6);assert.ok(bothExitProfitsPass(f.p,profit(f)));
});
test('a zero short fill after funding flips never opens the long',async()=>{
  const f=engineFixture(),id=f.engine.currentOpportunities()[0].id;
  const adapter=f.engine.adapters.find(a=>a.id==='bybit')!;
  adapter.placeOrder=async request=>{f.requests.push({exchange:'bybit',request});const q=f.quotes.get('bybit')!;q.fundingRate=-.006;
    return {id:'OFFLINE-EMPTY',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()};};
  f.setRefresh(exchange=>{f.quotes.get(exchange)!.timestamp=Date.now();});
  const p=await f.engine.open(id);assert.equal(p.status,'closed');assert.equal(p.long.quantity,0);assert.equal(p.short.quantity,0);
  assert.equal(f.requests.filter(r=>!r.request.reduceOnly).length,1);assert.equal(f.requests.filter(r=>r.request.reduceOnly).length,0);
  assert.match(p.closeReason??'',/未提交/);
});
test('confirmed profit-taking partial fills finish residuals even if remaining profit disappears',async()=>{
  const f=await profitablePosition();f.p.holdDecision=evaluateHoldingDecision(f.p,f.quotes.get('gate'),f.quotes.get('bybit'),f.store.data.config);
  let changed=false;
  const adapter=f.engine.adapters.find(a=>a.id==='bybit')!,original=adapter.placeOrder.bind(adapter);
  adapter.placeOrder=async request=>{if(!changed&&request.reduceOnly){changed=true;f.p.fundingUsd=-.5;f.requests.push({exchange:'bybit',request});
    return {id:'OFFLINE-PARTIAL',clientOrderId:request.clientOrderId,status:'partial',filledQuantity:.5,averagePrice:request.limitPrice,feeUsd:.5*request.limitPrice*f.store.data.config.takerFees.bybit,timestamp:Date.now()};}return original(request);};
  assert.equal(await internal(f.engine).continueClosing(f.p,f.p.holdDecision.reason),true);assert.equal(f.p.status,'closed');
  assert.equal(f.requests.length,5);assert.equal(f.requests.filter(r=>r.request.reduceOnly&&r.exchange==='gate').length,1);
  assert.equal(f.requests.filter(r=>r.request.reduceOnly&&r.exchange==='bybit').length,2);assert.equal(f.p.short.quantity,0);
});

test('a cancelled short is retried before any long order',async()=>{
  const f=engineFixture(),id=f.engine.currentOpportunities()[0].id;
  const adapter=f.engine.adapters.find(a=>a.id==='bybit')!,original=adapter.placeOrder.bind(adapter);
  let first=true;
  adapter.placeOrder=async request=>{
    if(first&&!request.reduceOnly){first=false;f.requests.push({exchange:'bybit',request});
      const long=f.quotes.get('gate')!,short=f.quotes.get('bybit')!;
      long.asks=[{price:99,quantity:100}];long.bids=[{price:98.98,quantity:100}];
      short.bids=[{price:99.5,quantity:100}];short.asks=[{price:99.52,quantity:100}];
      return {id:'OFFLINE-EMPTY',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()};
    }return original(request);
  };
  f.setRefresh(exchange=>{f.quotes.get(exchange)!.timestamp=Date.now();});
  const p=await f.engine.open(id);
  assert.equal(p.status,'open');assert.equal(p.long.quantity,p.short.quantity);assert.ok(p.short.quantity>0);
  const opens=f.requests.filter(r=>!r.request.reduceOnly);
  assert.equal(opens[0].exchange,'bybit');assert.ok(opens.filter(r=>r.exchange==='gate').length>=1);
  assert.ok(opens.findIndex(r=>r.exchange==='gate')>0,'the long is sent only after a short fill');
});

test('a cancelled short is retried on the improved book before the long is sent',async()=>{
  const f=engineFixture(),id=f.engine.currentOpportunities()[0].id;
  const adapter=f.engine.adapters.find(a=>a.id==='bybit')!,original=adapter.placeOrder.bind(adapter);let first=true;
  adapter.placeOrder=async request=>{
    if(first&&!request.reduceOnly){first=false;f.requests.push({exchange:'bybit',request});
      f.quotes.get('gate')!.asks=[{price:100.1,quantity:100}];f.quotes.get('gate')!.bids=[{price:100.08,quantity:100}];
      f.quotes.get('bybit')!.bids=[{price:100.6,quantity:100}];f.quotes.get('bybit')!.asks=[{price:100.62,quantity:100}];
      return {id:'OFFLINE-EMPTY',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()};
    }return original(request);
  };
  f.setRefresh(exchange=>{f.quotes.get(exchange)!.timestamp=Date.now();});
  const p=await f.engine.open(id);assert.equal(p.status,'open');near(p.short.entryPrice,100.6);near(p.long.entryPrice,100.1);
  assert.equal(p.long.quantity,p.short.quantity);
  const opens=f.requests.filter(r=>!r.request.reduceOnly);
  assert.equal(opens[0].exchange,'bybit');assert.ok(opens.findIndex(r=>r.exchange==='gate')>0);
});

test('a short that never fills does not pay the long opening fee',async()=>{
  const f=engineFixture(),id=f.engine.currentOpportunities()[0].id;
  const long=f.engine.adapters.find(a=>a.id==='gate')!,original=long.placeOrder.bind(long);
  long.placeOrder=async request=>({...await original(request),feeUsd:request.reduceOnly?.05:1});
  const short=f.engine.adapters.find(a=>a.id==='bybit')!;
  short.placeOrder=async request=>{f.requests.push({exchange:'bybit',request});return {id:`OFFLINE-EMPTY-${request.clientOrderId}`,clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()};};
  f.setRefresh(exchange=>{f.quotes.get(exchange)!.timestamp=Date.now();});
  const p=await f.engine.open(id);assert.equal(p.status,'closed');assert.equal(p.long.quantity,0);assert.equal(p.short.quantity,0);
  assert.equal(f.requests.filter(r=>r.exchange==='bybit').length,2);assert.equal(f.requests.filter(r=>r.exchange==='gate').length,0);
  assert.equal(p.feesUsd,0);
  assert.equal(new Set(f.store.data.orders.map(order=>order.request.clientOrderId)).size,2);
  assert.equal(new Set(f.store.data.orders.map(order=>order.result!.id)).size,2,'each actual IOC retry represents a separate native order');
});

test('independent account preflight reads both exchanges before awaiting either result',async()=>{
  const f=engineFixture(),id=f.engine.currentOpportunities()[0].id;let released=false,entered=0;
  const release:Array<()=>void>=[];
  for(const a of f.engine.adapters)a.fetchAccount=async()=>{entered++;if(!released)await new Promise<void>(resolve=>release.push(resolve));return {freeUsd:1000,equityUsd:1000,positions:[]};};
  const opening=f.engine.open(id);
  await new Promise<void>(resolve=>setImmediate(resolve));const concurrent=entered;
  released=true;for(const resolve of release)resolve();
  const p=await opening;assert.equal(concurrent,2);assert.equal(p.status,'open');assert.equal(f.requests.length,2);
});

test('slow private preparation refreshes both public books before rejecting an old cache',async t=>{
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);
  // Make quotes stale while the click remains within its 30-second submission deadline.
  // Advancing beyond that deadline tests click expiry instead of required book refresh.
  const f=engineFixture({maxSnapshotAgeMs:5000,spreadSampleIntervalSec:60,spreadMinSamples:3}),id=f.engine.currentOpportunities()[0].id;
  f.engine.adapters[0].prepareTrading=async()=>{clock+=10000;};
  f.setRefresh(exchange=>{f.quotes.get(exchange)!.timestamp=Date.now();});
  const p=await f.engine.open(id);assert.equal(p.status,'open');assert.equal(f.requests.length,2);
  assert.ok(f.engine.snapshots.every(s=>s.timestamp===clock));
});

test('private preparation beyond the manual click deadline never submits either leg',async t=>{
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);
  const f=engineFixture({spreadSampleIntervalSec:60,spreadMinSamples:3}),id=f.engine.currentOpportunities()[0].id;
  f.engine.adapters[0].prepareTrading=async()=>{clock+=31000;};
  f.setRefresh(exchange=>{f.quotes.get(exchange)!.timestamp=Date.now();});
  await assert.rejects(f.engine.open(id),/本次开仓已过期/);
  assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);assert.equal(f.store.data.positions.length,0);
});

test('a required public refresh failure after private preparation submits neither leg',async()=>{
  const f=engineFixture(),id=f.engine.currentOpportunities()[0].id;
  f.setRefresh(exchange=>{if(exchange==='bybit')throw new Error('OFFLINE essential book unavailable');f.quotes.get(exchange)!.timestamp=Date.now();});
  await assert.rejects(f.engine.open(id),error=>error instanceof SelectedPublicBookError&&error.exchange==='bybit'&&error.reason==='missing');
  assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);
});
