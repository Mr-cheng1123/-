import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Engine} from '../src/core/engine.js';
import {Store} from '../src/core/store.js';
import {flatAccountEvidence} from '../src/core/account-closure.js';
import {verifyObservedLedger} from '../src/core/observed-ledger-integrity.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountOpenOrder,AccountPosition,ExchangeAdapter,ExchangeId,JournalOrder,LivePortfolio,Position} from '../src/shared/types.js';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'account-closure-')),now=Date.now();
  const config={...defaultConfig,mode:'live' as const,exchanges:['gate','bybit'] as ExchangeId[],symbols:['GTLB'],orderNotionalUsd:100};
  const p:Position={id:'old-record',base:'GTLB',mode:'live',status:'attention',holdMode:'adaptive',openedAt:now-300000,plannedExitAt:now-240000,
    closeRequestedAt:now-100000,long:{exchange:'gate',symbol:'GTLB/USDT:USDT',side:'long',quantity:2.1,entryPrice:46.85,markPrice:48,feesUsd:.05,liquidationDistancePct:48},
    short:{exchange:'bybit',symbol:'GTLB/USDT:USDT',side:'short',quantity:0,entryPrice:0,markPrice:48,feesUsd:0,liquidationDistancePct:null},
    fundingUsd:.22,feesUsd:.05,transferCostUsd:0,spreadPnlUsd:2.415,realizedSpreadPnlUsd:.1,netPnlUsd:2.585,deltaUsd:100.8,fundingEvents:['original'],riskReasons:['订单待核对']};
  const order:JournalOrder={positionId:p.id,exchange:'bybit',createdAt:now-299000,
    request:{clientOrderId:'original-unknown',base:'GTLB',symbol:p.short.symbol,side:'sell',quantity:2.1,limitPrice:46.63,reduceOnly:false},
    result:{id:'',clientOrderId:'original-unknown',status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:now-299000},error:'original unknown'};
  const store=new Store(join(directory,'state.json'),config);store.data.positions=[p];store.data.orders=[order];
  const open=new Map<ExchangeId,AccountOpenOrder[]>([['gate',[]],['bybit',[]]]),actual=new Map<ExchangeId,AccountPosition[]>([['gate',[]],['bybit',[]]]);
  let writes=0,reads=0;
  const write=async()=>{writes++;throw new Error('A read-only observer must not call execution');};
  const adapters=config.exchanges.map(id=>({id,fetchSnapshots:async()=>[],fetchAccount:async()=>({freeUsd:1000,equityUsd:1000,positions:actual.get(id)!}),
    fetchOpenOrders:async()=>{reads++;return open.get(id)!;},prepareTrading:write,placeOrder:write,cancelOrder:write,reconcileOrder:write,
    fetchFundingPayments:async()=>[],close:async()=>{}} as ExchangeAdapter));
  const engine=new Engine(store,false,{adapterFactory:()=>adapters,liveEnvironment:{GATE_API_KEY:'fixture',GATE_API_SECRET:'fixture',BYBIT_API_KEY:'fixture',BYBIT_API_SECRET:'fixture'}});
  const portfolio=(at=Date.now()-10):LivePortfolio=>({timestamp:Date.now(),pollIntervalMs:5000,maxAgeMs:15000,
    exchanges:config.exchanges.map(exchange=>({exchange,credentialsConfigured:true,status:'ready',requestedAt:at,receivedAt:at+1,positions:[],freeUsd:1000,equityUsd:1000}))});
  return {engine,store,p,order,actual,open,portfolio,reads:()=>reads,writes:()=>writes,cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}

test('GET-only terminal order reports repair missing fills exactly once while execution remains locked',async()=>{
  const f=fixture();try{
    let inspected=0;
    f.engine.adapter('bybit').inspectOrder=async request=>{inspected++;return {id:'confirmed-trade',clientOrderId:request.clientOrderId,status:'filled',filledQuantity:2.1,averagePrice:46.63,feeUsd:.06,timestamp:f.order.createdAt+1};};
    const data=f.portfolio();
    data.exchanges[0].positions=[{base:'GTLB',symbol:f.p.long.symbol,side:'long',quantity:2.1,markPrice:48,liquidationPrice:0,leverage:2}];
    data.exchanges[1].positions=[{base:'GTLB',symbol:f.p.short.symbol,side:'short',quantity:2.1,markPrice:48,liquidationPrice:0,leverage:2}];
    await f.engine.observeAccountClosures(data);
    assert.equal(f.order.result!.status,'filled');assert.equal(f.p.short.quantity,2.1);assert.equal(f.p.short.entryPrice,46.63);
    assert.equal(f.p.short.feesUsd,.06);assert.equal(f.p.feesUsd,.11);assert.equal(f.p.status,'attention');
    assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);assert.equal(f.writes(),0);
    await f.engine.observeAccountClosures(data);assert.equal(inspected,1);assert.equal(f.p.short.quantity,2.1);assert.equal(f.p.feesUsd,.11);
  }finally{f.cleanup();}
});

test('maintenance integrity permits only confirmed pending-order corrections, rejecting new intents and unrelated cash changes',()=>{
  const f=fixture();try{
    const before=structuredClone(f.store.data);
    f.engine.execution.applyObservedOrder(f.order,{id:'verified',clientOrderId:f.order.request.clientOrderId,status:'filled',filledQuantity:2.1,averagePrice:46.63,feeUsd:.06,timestamp:f.order.createdAt+1});
    assert.deepEqual(verifyObservedLedger(before,f.store.data),{recordsPreserved:true,orderIntentsPreserved:true,observedOrdersResolved:1});
    const extra=structuredClone(f.store.data);extra.orders.push(structuredClone(extra.orders[0]));assert.equal(verifyObservedLedger(before,extra).recordsPreserved,false);
    const changed=structuredClone(f.store.data);changed.orders[0].request.quantity=4;assert.equal(verifyObservedLedger(before,changed).recordsPreserved,false);
    const cash=structuredClone(f.store.data);cash.positions[0].fundingUsd+=1;assert.equal(verifyObservedLedger(before,cash).recordsPreserved,false);
    const fee=structuredClone(f.store.data);fee.positions[0].feesUsd+=1;assert.equal(verifyObservedLedger(before,fee).recordsPreserved,false);
  }finally{f.cleanup();}
});

test('a confirmed zero-fill IOC is recorded as cancelled without pretending the filled opposite leg is flat',async()=>{
  const f=fixture();try{
    f.engine.adapter('bybit').inspectOrder=async request=>({id:'ioc-cancel',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:f.order.createdAt+1});
    const data=f.portfolio();data.exchanges[0].positions=[{base:'GTLB',symbol:f.p.long.symbol,side:'long',quantity:2.1,markPrice:48,liquidationPrice:0,leverage:2}];
    await f.engine.observeAccountClosures(data);
    assert.equal(f.order.result!.status,'cancelled');assert.equal(f.p.long.quantity,2.1);assert.equal(f.p.short.quantity,0);
    assert.equal(f.p.accountClosure,undefined);assert.equal(f.writes(),0);assert.equal(f.engine.state().unconfirmedOrders!.length,0);
  }finally{f.cleanup();}
});

test('account positions alone never turn an unknown order into a fill, and late GET results cannot apply after deadline',async()=>{
  const f=fixture();try{
    let finish:((value:any)=>void)|undefined;
    (f.engine as any).options.privateReadDeadlineMs=1;
    f.engine.adapter('bybit').inspectOrder=async()=>new Promise(resolve=>{finish=resolve;});
    const data=f.portfolio();data.exchanges[1].positions=[{base:'GTLB',symbol:f.p.short.symbol,side:'short',quantity:2.1,markPrice:48,liquidationPrice:0,leverage:2}];
    await f.engine.observeAccountClosures(data);assert.equal(f.p.short.quantity,0);assert.equal(f.order.result!.status,'unknown');
    finish!({id:'late',clientOrderId:f.order.request.clientOrderId,status:'filled',filledQuantity:2.1,averagePrice:46.63,feeUsd:.06,timestamp:f.order.createdAt+1});
    await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.p.short.quantity,0);assert.equal(f.order.result!.status,'unknown');assert.equal(f.writes(),0);
  }finally{f.cleanup();}
});

test('two independent flat observations plus no open orders archive current exposure without changing financial history',async()=>{
  const f=fixture();try{
    const original=JSON.stringify({long:f.p.long,short:f.p.short,funding:f.p.fundingUsd,fees:f.p.feesUsd,events:f.p.fundingEvents,orders:f.store.data.orders});
    await f.engine.observeAccountClosures(f.portfolio(Date.now()-100));assert.equal(f.p.accountClosure,undefined);assert.equal(f.reads(),0);
    await f.engine.observeAccountClosures(f.portfolio(Date.now()-50));
    assert.equal((f.p as Position).accountClosure?.historicalOrdersPending,true);assert.equal(f.engine.activePositions().length,0);
    assert.equal(f.engine.liveReadiness().excludedCoins?.some(row=>row.base==='GTLB'),false);
    assert.equal(f.engine.state().unconfirmedOrders![0].historical,true);
    assert.equal(f.engine.totals().grossExposureUsd,0);assert.equal(f.engine.totals().spreadPnlUsd,.1);
    assert.equal(JSON.stringify({long:f.p.long,short:f.p.short,funding:f.p.fundingUsd,fees:f.p.feesUsd,events:f.p.fundingEvents,orders:f.store.data.orders}),original);
    await f.engine.execution.reconcilePending();await f.engine.execution.close(f.p,'stale UI request');
    assert.equal(f.writes(),0);assert.equal(f.order.result!.status,'unknown');
  }finally{f.cleanup();}
});

test('repeated cached empty snapshots cannot archive a record',async()=>{
  const f=fixture();try{const snapshot=f.portfolio();await f.engine.observeAccountClosures(snapshot);await f.engine.observeAccountClosures(snapshot);
    assert.equal(f.reads(),0);assert.equal(f.p.accountClosure,undefined);
  }finally{f.cleanup();}
});

test('failed, stale, pre-submission or malformed account data is never empty-position proof',()=>{
  const f=fixture();try{
    for(const mutate of [(data:LivePortfolio)=>{data.exchanges[1].status='error';},(data:LivePortfolio)=>{data.exchanges[0].requestedAt=Date.now()-16000;},
      (data:LivePortfolio)=>{data.exchanges[0].requestedAt=f.order.createdAt-1;},(data:LivePortfolio)=>{data.exchanges[0].positions=[{base:'GTLB',symbol:'GTLB/USDT:USDT',side:'long',quantity:NaN,markPrice:1,liquidationPrice:0,leverage:2}];}]){
      const data=f.portfolio();mutate(data);assert.equal(flatAccountEvidence(f.p,[f.order],data),undefined);
    }
  }finally{f.cleanup();}
});

test('a working or conditional close-all order prevents backend archival without sending cancellation',async()=>{
  const f=fixture();try{
    f.open.set('gate',[{id:'close-all',base:'GTLB',symbol:f.p.long.symbol,side:'sell',quantity:0,remainingQuantity:0,kind:'conditional',reduceOnly:true}]);
    await f.engine.observeAccountClosures(f.portfolio(Date.now()-100));await f.engine.observeAccountClosures(f.portfolio(Date.now()-50));
    assert.equal(f.p.accountClosure,undefined);assert.equal(f.writes(),0);
  }finally{f.cleanup();}
});

test('a position that appears during the final account reread prevents archival',async()=>{
  const f=fixture();try{
    f.actual.set('bybit',[{base:'GTLB',symbol:f.p.short.symbol,side:'short',quantity:2.1,markPrice:48,liquidationPrice:0,leverage:2}]);
    await f.engine.observeAccountClosures(f.portfolio(Date.now()-100));await f.engine.observeAccountClosures(f.portfolio(Date.now()-50));
    assert.equal(f.p.accountClosure,undefined);assert.equal(f.writes(),0);
  }finally{f.cleanup();}
});

test('a shutdown during the final GET cannot archive a position from an abandoned observation',async()=>{
  const f=fixture();try{
    await f.engine.observeAccountClosures(f.portfolio(Date.now()-100));
    let release!:(value:{freeUsd:number;equityUsd:number;positions:AccountPosition[]})=>void,started!:()=>void;
    const began=new Promise<void>(resolve=>{started=resolve;});
    const held=new Promise<{freeUsd:number;equityUsd:number;positions:AccountPosition[]}>(resolve=>{release=resolve;});
    f.engine.adapter('gate').fetchAccount=async()=>{started();return held;};
    const observation=f.engine.observeAccountClosures(f.portfolio(Date.now()-50));await began;
    const stopping=f.engine.stop();release({freeUsd:1000,equityUsd:1000,positions:[]});
    await Promise.all([observation,stopping]);
    assert.equal(f.p.accountClosure,undefined);assert.equal(f.engine.activePositions().length,1);assert.equal(f.writes(),0);
  }finally{f.cleanup();}
});

test('the final account proof cannot become fresh again after waiting for the other venue',async t=>{
  const f=fixture();try{
    let now=Date.now();t.mock.method(Date,'now',()=>now);
    await f.engine.observeAccountClosures(f.portfolio(now-100));
    f.engine.adapter('bybit').fetchAccount=async()=>{await new Promise<void>(resolve=>setImmediate(resolve));now+=f.engine.config.maxSnapshotAgeMs+1;return {freeUsd:1000,equityUsd:1000,positions:[]};};
    await f.engine.observeAccountClosures(f.portfolio(now-50));
    assert.equal(f.p.accountClosure,undefined);assert.equal(f.engine.activePositions().length,1);assert.equal(f.writes(),0);
  }finally{f.cleanup();}
});

test('missing complete open-order support preserves the audit record and blocks no financial endpoint',async()=>{
  const f=fixture();try{
    f.engine.adapter('bybit').fetchOpenOrders=undefined;
    await f.engine.observeAccountClosures(f.portfolio(Date.now()-100));await f.engine.observeAccountClosures(f.portfolio(Date.now()-50));
    assert.equal(f.p.accountClosure,undefined);assert.equal(f.engine.activePositions().length,1);assert.equal(f.writes(),0);
  }finally{f.cleanup();}
});

test('later account funding cannot be attributed to an archived record with an unknown external close time',async()=>{
  const f=fixture();try{
    f.p.accountClosure={confirmedAt:Date.now(),reason:'账户已空仓',historicalOrdersPending:true};
    let fundingReads=0;
    for(const adapter of f.engine.adapters)adapter.fetchFundingPayments=async()=>{fundingReads++;return [{id:'later-account-cashflow',base:'GTLB',timestamp:f.p.accountClosure!.confirmedAt+1,amountUsd:100}];};
    (f.engine as unknown as {sessionLivePermission:boolean}).sessionLivePermission=true;
    assert.equal(f.engine.liveUnlocked,true);
    await (f.engine as unknown as {accrueLiveFunding:()=>Promise<void>}).accrueLiveFunding();
    assert.equal(fundingReads,f.engine.adapters.length,'recent archives permit late-invoice GETs');
    assert.equal(f.p.fundingUsd,.22);assert.deepEqual(f.p.fundingEvents,['original']);
    assert.deepEqual(f.store.data.fundingSeen,[]);assert.equal(f.writes(),0);
  }finally{f.cleanup();}
});
