import test,{type TestContext} from 'node:test';
import { ReadyHistory } from './ready-history.js';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Engine} from '../src/core/engine.js';
import {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountState,ExchangeAdapter,ExchangeId,FundingPayment,MarketSnapshot,OrderRequest,Position} from '../src/shared/types.js';

const exchanges:ExchangeId[]=['gate','bybit'];
function quote(exchange:ExchangeId,base:string):MarketSnapshot{
  const now=Date.now();return {exchange,base,symbol:`${base}/USDT:USDT`,timestamp:now,markPrice:100,indexPrice:100,
    fundingRate:exchange==='bybit'?.006:0,nextFundingTime:now+600000,intervalHours:8,fundingHistory:[],
    bids:[{price:100,quantity:100}],asks:[{price:100,quantity:100}],openInterestUsd:1e8,volume24hUsd:1e8,
    quantityStep:.001,minQuantity:.001,minNotional:5,contractSize:1,source:'public',
    takerFeeRate:exchange==='bybit'?.00055:.0005,takerFeeAt:now,takerFeeSource:'exchange'};
}
function fixture(t:TestContext){
  const directory=mkdtempSync(path.join(tmpdir(),'funding-read-isolation-'));
  const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,feeOnly:true,dualAdvantageEnabled:false,
    exchanges,symbols:['BTC','ETH'],orderNotionalUsd:100};
  const store=new Store(path.join(directory,'state.json'),config);
  const accounts=new Map<ExchangeId,AccountState>(exchanges.map(x=>[x,{freeUsd:1000,equityUsd:1000,positions:[]}]));
  const orders:Array<{exchange:ExchangeId;request:OrderRequest}>=[];
  const adapters=exchanges.map(exchange=>({id:exchange,fetchSnapshots:async bases=>bases.map(base=>quote(exchange,base)),fetchAccount:async()=>accounts.get(exchange)!,
    fetchFundingPayments:async()=>[],inspectTrading:async()=>{},prepareTrading:async()=>{},validateOrder:async()=>{},
    placeOrder:async request=>{orders.push({exchange,request});return {id:request.clientOrderId,clientOrderId:request.clientOrderId,status:'filled',filledQuantity:request.quantity,
      averagePrice:request.limitPrice,feeUsd:request.quantity*request.limitPrice*config.takerFees[exchange],timestamp:Date.now()};},
    reconcileOrder:async()=>{throw new Error('Unexpected OFFLINE reconciliation');},cancelOrder:async()=>{throw new Error('Unexpected OFFLINE cancellation');},close:async()=>{},
  }) as ExchangeAdapter);
  const engine=new Engine(store,true,{adapterFactory:()=>adapters,privateReadDeadlineMs:10,spreadHistory:new ReadyHistory(),liveEnvironment:{ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',
    GATE_API_KEY:'OFFLINE-READ-ONLY',GATE_API_SECRET:'OFFLINE-READ-ONLY',BYBIT_API_KEY:'OFFLINE-READ-ONLY',BYBIT_API_SECRET:'OFFLINE-READ-ONLY'}});
  t.after(async()=>{await engine.stop();const target=path.resolve(directory);assert.ok(target.startsWith(path.resolve(tmpdir())+path.sep));rmSync(target,{recursive:true,force:true});});
  const addPosition=()=>{
    const now=Date.now(),p:Position={id:'OFFLINE-CONFIRMED',base:'BTC',mode:'live',status:'open',openedAt:now-1000,plannedExitAt:now+300000,holdMode:'once',
      long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long',quantity:1,entryPrice:100,markPrice:100,feesUsd:0,liquidationDistancePct:null},
      short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short',quantity:1,entryPrice:100,markPrice:100,feesUsd:0,liquidationDistancePct:null},
      fundingUsd:0,feesUsd:0,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
    store.data.positions.push(p);
    for(const [exchange,account] of accounts){const leg=p.long.exchange===exchange?p.long:p.short;account.positions=[{base:p.base,symbol:leg.symbol,side:leg.side,quantity:leg.quantity,markPrice:100,liquidationPrice:0,leverage:2}];}
    return p;
  };
  return {store,engine,adapters,accounts,orders,addPosition};
}
const internal=(engine:Engine)=>engine as unknown as {refreshAdapter:(a:ExchangeAdapter,bases:string[],includeAccount?:boolean)=>Promise<boolean>;accrueLiveFunding:()=>Promise<void>};
async function within<T>(promise:Promise<T>,ms=500):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('OFFLINE read blocked the engine queue')),ms);})]);}
  finally{if(timer)clearTimeout(timer);}
}

test('account failure blocks entry without discarding healthy books or preventing confirmed reduce-only exits',async t=>{
  const f=fixture(t),p=f.addPosition();
  f.adapters[0].fetchAccount=async()=>{throw new Error('OFFLINE account unavailable');};
  await within(f.engine.tick());
  const health=f.engine.health.find(h=>h.exchange==='gate')!;
  assert.equal(health.status,'online');assert.equal(health.accountStatus,'error');assert.equal(f.engine.accounts.has('gate'),false);
  assert.ok(f.engine.snapshot('gate','BTC'));assert.ok(f.engine.snapshot('gate','ETH'));
  // A failed account read does not block the book or the entry decision; the order path re-reads both accounts before sending.
  const entry=f.engine.currentOpportunities().find(o=>o.base==='ETH')!;
  assert.ok(entry);assert.ok(!entry.reasons.includes('交易所连接异常'));assert.equal(f.orders.length,0);assert.equal(p.status,'open');
  await f.engine.close(p.id);assert.equal(p.status,'closed');assert.equal(p.long.quantity,0);assert.equal(p.short.quantity,0);
  assert.equal(f.orders.length,2);assert.ok(f.orders.every(o=>o.request.reduceOnly));assert.equal(health.accountStatus,'error');
});

test('pending account and funding reads release the queue, remain single-flight and ignore late completion',async t=>{
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);
  const f=fixture(t),p=f.addPosition();let accountCalls=0,fundingCalls=0;
  let resolveAccount:((account:AccountState)=>void)|undefined,resolveFunding:((entries:FundingPayment[])=>void)|undefined;
  f.adapters[0].fetchAccount=()=>{accountCalls++;return new Promise(resolve=>{resolveAccount=resolve;});};
  f.adapters[0].fetchFundingPayments=()=>{fundingCalls++;return new Promise(resolve=>{resolveFunding=resolve;});};
  try{
    const tick=f.engine.tick(),queued=f.engine.exclusive(async()=>'queue released');
    const [,result]=await within(Promise.all([tick,queued]));assert.equal(result,'queue released');
    assert.equal(accountCalls,1);assert.equal(fundingCalls,1);assert.equal(p.fundingUsd,0);assert.equal(f.orders.length,0);
    await within(f.engine.tick());await within(f.engine.exclusive(()=>internal(f.engine).accrueLiveFunding()));
    assert.equal(accountCalls,1);assert.equal(fundingCalls,1,'a still-pending read must not be repeated');
    resolveAccount!({freeUsd:777,equityUsd:777,positions:[]});
    resolveFunding!([{id:'OFFLINE-LATE-INVOICE',base:'BTC',timestamp:p.openedAt+500,amountUsd:2}]);
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(f.engine.accounts.has('gate'),false);assert.equal(f.engine.health.find(h=>h.exchange==='gate')!.accountStatus,'error');
    assert.equal(p.fundingUsd,0);assert.equal(p.long.lastFundingAt,undefined);assert.deepEqual(f.store.data.fundingSeen,[]);assert.equal(f.orders.length,0);
    f.adapters[0].fetchAccount=async()=>{accountCalls++;return f.accounts.get('gate')!;};
    f.adapters[0].fetchFundingPayments=async()=>{fundingCalls++;return [{id:'OFFLINE-FRESH-INVOICE',base:'BTC',timestamp:p.openedAt+500,amountUsd:.5}];};
    await within(f.engine.exclusive(()=>internal(f.engine).accrueLiveFunding()));
    assert.equal(fundingCalls,1,'late completion must not bypass the funding read backoff');assert.equal(p.fundingUsd,0);
    clock+=15_001;
    await within(f.engine.tick());
    assert.equal(accountCalls,2);assert.equal(fundingCalls,2);assert.equal(f.engine.accounts.get('gate')!.freeUsd,1000);
    assert.equal(f.engine.health.find(h=>h.exchange==='gate')!.accountStatus,'ready');assert.equal(p.fundingUsd,.5);
    assert.deepEqual(f.store.data.fundingSeen,['gate:OFFLINE-FRESH-INVOICE']);assert.equal(f.orders.length,0);
  }finally{resolveAccount?.(f.accounts.get('gate')!);resolveFunding?.([]);}
});

test('a single coin refresh failure preserves another fresh coin and the independent account cache',async t=>{
  const f=fixture(t);await within(f.engine.tick());
  assert.equal(f.engine.currentOpportunities().find(o=>o.base==='BTC')!.eligible,true);
  const cachedAccount=f.engine.accounts.get('gate'),previous=f.engine.snapshot('gate','BTC');
  const fetch=f.adapters[0].fetchSnapshots;
  f.adapters[0].fetchSnapshots=async bases=>{if(bases.includes('ETH'))throw new Error('OFFLINE only ETH unavailable');return fetch(bases);};
  for(let i=0;i<3;i++)assert.equal(await within(f.engine.exclusive(()=>internal(f.engine).refreshAdapter(f.adapters[0],['ETH']))),false);
  const health=f.engine.health.find(h=>h.exchange==='gate')!;
  assert.equal(health.status,'degraded');assert.equal(health.accountStatus,'ready');assert.equal(f.engine.accounts.get('gate'),cachedAccount);
  assert.equal(f.engine.snapshot('gate','BTC'),previous);assert.equal(f.store.data.killSwitch,false);
  const opportunities=f.engine.currentOpportunities(),btc=opportunities.find(o=>o.base==='BTC')!,eth=opportunities.find(o=>o.base==='ETH')!;
  assert.equal(btc.eligible,true);assert.equal(eth.eligible,false);assert.ok(eth.reasons.includes('该币种详细行情核验失败'));
  assert.ok(!btc.reasons.includes('交易所连接异常'));assert.equal(f.orders.length,0);
});

test('funding with delayed ownership remains unknown and is retried after a terminal GET confirms the old fill',async t=>{
  const f=fixture(t),p=f.addPosition(),request:OrderRequest={base:p.base,symbol:p.long.symbol,clientOrderId:'OFFLINE-DELAYED-FILL',
    side:'buy',reduceOnly:false,quantity:1,limitPrice:100};
  const createdAt=p.openedAt+100;
  const journal={positionId:p.id,exchange:'gate' as const,request,createdAt,
    result:{id:'OFFLINE-ORDER',clientOrderId:request.clientOrderId,status:'unknown' as 'unknown'|'filled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:createdAt}};
  f.store.data.orders.push(journal);
  f.adapters[0].fetchFundingPayments=async()=>[{id:'OFFLINE-OWNER-PENDING',base:p.base,symbol:p.long.symbol,side:'long',quantity:1,timestamp:p.openedAt+500,amountUsd:.5}];
  p.long.fundingObservedAt=Date.now();p.long.fundingObservedSince=p.openedAt;
  await internal(f.engine).accrueLiveFunding();
  assert.equal(p.fundingUsd,0);assert.equal(p.long.fundingObservedAt,undefined);assert.equal(p.long.fundingObservedSince,undefined);
  assert.deepEqual(f.store.data.fundingSeen,[]);assert.equal(f.orders.length,0);assert.equal(p.status,'open');
  journal.result={...journal.result,status:'filled',filledQuantity:1,averagePrice:100};
  await internal(f.engine).accrueLiveFunding();await internal(f.engine).accrueLiveFunding();
  assert.equal(p.fundingUsd,.5);assert.equal(p.long.fundingUsd,.5);assert.ok(p.long.fundingObservedAt!>0);
  assert.deepEqual(f.store.data.fundingSeen,['gate:OFFLINE-OWNER-PENDING']);assert.equal(f.orders.length,0);
});

test('GET funding catches a delayed archived-cycle invoice without taking receipts from the subsequent same-coin position',async t=>{
  const f=fixture(t),old=f.addPosition();old.status='attention';
  old.accountClosure={confirmedAt:old.openedAt+800,reason:'read-only independent flat proof',historicalOrdersPending:false};
  const request:OrderRequest={base:old.base,symbol:old.long.symbol,clientOrderId:'OFFLINE-ARCHIVED-FILL',side:'buy',reduceOnly:false,quantity:1,limitPrice:100};
  f.store.data.orders.push({positionId:old.id,exchange:'gate',request,createdAt:old.openedAt+100,
    result:{id:'OFFLINE-ARCHIVED-ORDER',clientOrderId:request.clientOrderId,status:'filled',filledQuantity:1,averagePrice:100,feeUsd:0,timestamp:old.openedAt+100}});
  const next=structuredClone(old);next.id='OFFLINE-NEXT-CYCLE';next.openedAt=old.accountClosure.confirmedAt+10;next.status='open';delete next.accountClosure;
  f.store.data.positions.push(next);
  f.adapters[0].fetchFundingPayments=async()=>[
    {id:'OFFLINE-OLD-LATE-FUND',base:old.base,symbol:old.long.symbol,side:'long',quantity:1,timestamp:old.openedAt+500,amountUsd:.2},
    {id:'OFFLINE-NEW-CYCLE-FUND',base:next.base,symbol:next.long.symbol,side:'long',quantity:1,timestamp:next.openedAt+20,amountUsd:.3}];
  await internal(f.engine).accrueLiveFunding();await internal(f.engine).accrueLiveFunding();
  assert.equal(old.fundingUsd,.2);assert.equal(next.fundingUsd,.3);assert.equal(old.status,'attention');assert.ok(old.accountClosure);
  assert.equal(f.store.data.fundingSeen.length,2);assert.equal(f.orders.length,0);
});

test('queued account proofs keep their original read time and cannot become fresh just by being applied later',async t=>{
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);
  const f=fixture(t),api=f.engine as unknown as {
    readTradingAccount:(adapter:ExchangeAdapter)=>Promise<AccountState>;
    cacheAccount:(exchange:ExchangeId,account:AccountState)=>boolean;
  };
  const started=clock;
  f.adapters[0].fetchAccount=async()=>{clock+=5;return structuredClone(f.accounts.get('gate')!);};
  const account=await api.readTradingAccount(f.adapters[0]);
  clock+=100;
  assert.equal(api.cacheAccount('gate',account),true);
  assert.equal(f.engine.health.find(row=>row.exchange==='gate')!.accountUpdatedAt,started);
  clock=started+f.engine.config.maxSnapshotAgeMs+1;
  assert.equal(api.cacheAccount('gate',account),false);
  assert.equal(f.engine.accounts.has('gate'),false);assert.equal(f.orders.length,0);
});

test('an older completed account read cannot overwrite a newer accepted holding and balance',async t=>{
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);
  const f=fixture(t),api=f.engine as unknown as {
    readTradingAccount:(adapter:ExchangeAdapter)=>Promise<AccountState>;
    cacheAccount:(exchange:ExchangeId,account:AccountState)=>boolean;
  };
  f.adapters[0].fetchAccount=async()=>({freeUsd:111,equityUsd:111,positions:[]});
  const older=await api.readTradingAccount(f.adapters[0]);clock+=100;
  f.adapters[0].fetchAccount=async()=>({freeUsd:222,equityUsd:222,positions:[]});
  const newer=await api.readTradingAccount(f.adapters[0]);
  assert.equal(api.cacheAccount('gate',newer),true);
  assert.equal(api.cacheAccount('gate',older),false);
  assert.equal(f.engine.accounts.get('gate')!.freeUsd,222);
  assert.equal(f.engine.health.find(row=>row.exchange==='gate')!.balanceUsd,222);assert.equal(f.orders.length,0);
});
