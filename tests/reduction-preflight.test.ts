import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {GatePrivate} from '../src/adapters/gate-private.js';
import {BybitPrivate} from '../src/adapters/bybit-private.js';
import {OrderNotSubmittedError} from '../src/adapters/order-rejection.js';
import {Execution} from '../src/core/execution.js';
import {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeId,MarketSnapshot,OrderRequest,Position} from '../src/shared/types.js';

const symbol='ONE/USDT:USDT',config={...structuredClone(defaultConfig),mode:'live' as const,dataSource:'public' as const,maxOrderRetries:0};
const req=(side:'buy'|'sell'='sell',quantity=100):OrderRequest=>({base:'ONE',symbol,side,quantity,
  limitPrice:1,clientOrderId:'offline-reduction-preflight',reduceOnly:true});
type Call={method:'GET'|'POST';name:string;params:unknown};
const gateRow=(changes:Record<string,unknown>={})=>({contract:'ONE_USDT',size:'10',mode:'dual_long',pos_margin_mode:'cross',
  pid:'1',lever:'2',leverage:'0',mark_price:'1',liq_price:'.5',entry_price:'1',unrealised_pnl:'0',
  pnl_fund:'0',pnl_fee:'0',pnl_pnl:'0',open_time:'1790927498',update_time:'1790934900',...changes});
const bybitRow=(positionIdx=0,side='Buy',size='100')=>({symbol:'ONEUSDT',positionIdx,side,size,leverage:'20'});
function market(exchange:'gate'|'bybit'){
  return {id:exchange==='gate'?'ONE_USDT':'ONEUSDT',symbol,base:'ONE',quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,
    contractSize:exchange==='gate'?10:1,precision:{amount:1,price:.000001},limits:{amount:{min:1,max:10000},cost:{min:1000000}}};
}
function gateFixture(raw:Record<string,unknown>[]=[gateRow()]){
  const calls:Call[]=[],m=market('gate'),account={currency:'USDT',available:'400',total:'500',unrealised_pnl:'0',position_mode:'dual_plus',margin_mode:0};
  const client:any={apiKey:'offline-only',secret:'offline-only',precisionMode:4,markets:{[symbol]:m},market:()=>m,
    loadMarkets:async()=>({[symbol]:m}),amountToPrecision:(_s:string,n:number)=>String(n),priceToPrecision:(_s:string,n:number)=>String(n),
    privateFuturesGetSettleAccounts:async(params:unknown)=>{calls.push({method:'GET',name:'account',params});return account;},
    privateFuturesGetSettlePositions:async(params:unknown)=>{calls.push({method:'GET',name:'positions',params});return raw;},
    privateFuturesPostSettleOrders:async(params:unknown)=>{calls.push({method:'POST',name:'create',params});return {id:'1001'};},close:async()=>{}};
  return {raw,account,client,calls,adapter:new CcxtAdapter('gate',config,client),native:new GatePrivate(client)};
}
function bybitFixture(raw:Record<string,unknown>[]=[bybitRow()]){
  const calls:Call[]=[],m=market('bybit'),account={unifiedMarginStatus:5,marginMode:'REGULAR_MARGIN'};
  const client:any={apiKey:'offline-only',secret:'offline-only',precisionMode:4,markets:{[symbol]:m},market:()=>m,
    loadMarkets:async()=>({[symbol]:m}),amountToPrecision:(_s:string,n:number)=>String(n),priceToPrecision:(_s:string,n:number)=>String(n),
    privateGetV5AccountInfo:async(params:unknown)=>{calls.push({method:'GET',name:'account',params});return {retCode:0,result:account};},
    privateGetV5PositionList:async(params:unknown)=>{calls.push({method:'GET',name:'positions',params});return {retCode:0,result:{list:raw,nextPageCursor:''}};},
    privatePostV5OrderCreate:async(params:unknown)=>{calls.push({method:'POST',name:'create',params});return {retCode:0,result:{orderId:'1001'}};},close:async()=>{}};
  return {raw,account,client,calls,adapter:new CcxtAdapter('bybit',config,client),native:new BybitPrivate(client)};
}
function assertReadsOnly(calls:Call[]){assert.ok(calls.length>0);assert.ok(calls.every(call=>call.method==='GET'));}

test('ordinary Gate reductions preflight the unique actual slot in native contracts without preparation, settings or registration',async()=>{
  for(const margin of ['cross','isolated']){
    const f=gateFixture([gateRow({pos_margin_mode:margin}),gateRow({size:'-10',mode:'dual_short',pid:'2'})]),request=req(),before=structuredClone([request,f.raw]);
    try{
      await f.adapter.validateOrder(request);assertReadsOnly(f.calls);
      assert.equal((f.adapter as any).submitted.size,0);assert.deepEqual([request,f.raw],before);
      assert.deepEqual(f.calls.find(call=>call.name==='positions')!.params,{settle:'usdt',holding:true});
    }finally{await f.adapter.close();}
  }
});

test('ordinary Gate preflight refuses ambiguous same-side slots, wrong native side and insufficient contracts before any write',async()=>{
  const cases=[
    [gateRow({size:'5'}),gateRow({size:'5',pid:'2',pos_margin_mode:'isolated'})],
    [gateRow({size:'5'}),gateRow({size:'5',pid:'2'})],
    [gateRow({size:'-10',mode:'dual_short'})],
    [gateRow({size:'1'})],
    [gateRow({size:'-10',mode:'dual_long'})]
  ];
  for(const raw of cases){const f=gateFixture(raw);try{
    await assert.rejects(f.adapter.validateOrder(req('sell',20)),/unavailable or ambiguous|holding mode mismatch/);
    assertReadsOnly(f.calls);assert.equal((f.adapter as any).submitted.size,0);
  }finally{await f.adapter.close();}}
});

test('Gate explicit native selector still validates its exact PID, margin, cycle and own quantity through the same GET preflight',async()=>{
  const f=gateFixture([gateRow({size:'5'}),gateRow({size:'5',pid:'2',pos_margin_mode:'isolated'})]);
  const request:OrderRequest={...req('sell',40),closePosition:{side:'long',marginMode:'isolated',positionId:'2',positionOpenedAt:1790927498000}};
  try{
    await f.adapter.validateOrder(request);
    for(const changes of [{positionId:'1'},{marginMode:'crossed' as const},{positionOpenedAt:1790927499000},{side:'short' as const}]){
      await assert.rejects(f.adapter.validateOrder({...request,closePosition:{...request.closePosition!,...changes}}));
    }
    await assert.rejects(f.adapter.validateOrder({...request,quantity:60}),/unavailable or ambiguous/);
    assertReadsOnly(f.calls);assert.equal((f.adapter as any).submitted.size,0);
  }finally{await f.adapter.close();}
});

test('Bybit reductions verify one-way or hedge positionIdx, actual held side and quantity using GETs only',async()=>{
  for(const [rows,side] of [
    [[bybitRow(0,'Buy')],'sell'],[[bybitRow(0,'Sell')],'buy'],
    [[bybitRow(1,'Buy'),bybitRow(2,'Sell')],'sell'],[[bybitRow(1,'Buy'),bybitRow(2,'Sell')],'buy']
  ] as const){const f=bybitFixture([...rows]),request=req(side),before=structuredClone([request,f.raw]);try{
    await f.adapter.validateOrder(request);assertReadsOnly(f.calls);assert.equal((f.adapter as any).submitted.size,0);
    assert.deepEqual([request,f.raw],before);
    assert.deepEqual(f.calls.find(call=>call.name==='positions')!.params,{category:'linear',symbol:'ONEUSDT',limit:200});
  }finally{await f.adapter.close();}}
});

test('Bybit preflight rejects missing, opposite, insufficient, invalid or duplicate native slots before any write',async()=>{
  for(const raw of [[],[bybitRow(0,'Sell')],[bybitRow(0,'Buy','99')],
    [bybitRow(1,'Sell'),bybitRow(2,'Buy')],[bybitRow(1,'Buy'),bybitRow(1,'Buy')],
    [bybitRow(0,'Buy','NaN')],[bybitRow(0,'Buy','-1')]]){
    const f=bybitFixture(raw);try{
      await assert.rejects(f.adapter.validateOrder(req()));assertReadsOnly(f.calls);assert.equal((f.adapter as any).submitted.size,0);
    }finally{await f.adapter.close();}
  }
});

test('a failed GET preflight does not reserve the client ID; a later valid native reduction can use that same ID',async()=>{
  const gate=gateFixture([gateRow({size:'1'})]),bybit=bybitFixture([bybitRow(0,'Buy','1')]),request=req();
  try{
    await assert.rejects(gate.adapter.validateOrder(request));await assert.rejects(bybit.adapter.validateOrder(request));
    assertReadsOnly(gate.calls);assertReadsOnly(bybit.calls);
    gate.raw[0].size='10';bybit.raw[0].size='100';
    assert.equal(await gate.native.place(request,10,1),'1001');assert.equal(await bybit.native.place(request,100,1),'1001');
    assert.equal(gate.calls.filter(call=>call.method==='POST').length,1);assert.equal(bybit.calls.filter(call=>call.method==='POST').length,1);
  }finally{await Promise.all([gate.adapter.close(),bybit.adapter.close()]);}
});

test('native place rechecks a slot that changed after successful preflight and refuses before POST',async()=>{
  const gate=gateFixture(),bybit=bybitFixture(),request=req();try{
    await gate.adapter.validateOrder(request);await bybit.adapter.validateOrder(request);
    gate.raw.push(gateRow({pid:'2',pos_margin_mode:'isolated'}));bybit.raw[0].size='99';
    await assert.rejects(gate.native.place(request,10,1),OrderNotSubmittedError);
    await assert.rejects(bybit.native.place(request,100,1),OrderNotSubmittedError);
    assertReadsOnly(gate.calls);assertReadsOnly(bybit.calls);
  }finally{await Promise.all([gate.adapter.close(),bybit.adapter.close()]);}
});

function closeBook(exchange:'gate'|'bybit'):MarketSnapshot{
  const now=Date.now();return {exchange,base:'ONE',symbol,source:'public',timestamp:now,observedAt:now,
    markPrice:1,indexPrice:1,fundingRate:0,nextFundingTime:now+3600000,intervalHours:1,fundingHistory:[],
    bids:[{price:1,quantity:200}],asks:[{price:1,quantity:200}],quantityStep:exchange==='gate'?10:1,
    minQuantity:exchange==='gate'?10:1,minNotional:1000000,contractSize:exchange==='gate'?10:1,
    openInterestUsd:1000000,volume24hUsd:1000000,takerFeeRate:.0005,takerFeeAt:now,takerFeeSource:'exchange'};
}
test('a known Gate or Bybit reduction refusal stops both shared legs before order journals or place calls in best and depth close',async()=>{
  for(const pricing of ['best-opposite','depth'] as const)for(const invalid of ['gate','bybit'] as const){
    const tempRoot=path.resolve(tmpdir()),dir=mkdtempSync(path.join(tempRoot,'funding-reduction-preflight-'));
    const gate=gateFixture(invalid==='gate'?[gateRow({size:'5'}),gateRow({size:'5',pid:'2',pos_margin_mode:'isolated'})]:undefined),
      bybit=bybitFixture([bybitRow(0,'Sell',invalid==='bybit'?'99':'100')]);
    const store=new Store(path.join(dir,'state.json'),config),leg=(side:'long'|'short')=>({exchange:side==='long'?'gate' as const:'bybit' as const,
      symbol,side,quantity:100,entryPrice:1,markPrice:1,feesUsd:0,liquidationDistancePct:null});
    const p:Position={id:'offline-preflight-close',base:'ONE',mode:'live',status:'open',long:leg('long'),short:leg('short'),
      openedAt:Date.now()-60000,plannedExitAt:0,holdMode:'adaptive',fundingUsd:0,feesUsd:0,transferCostUsd:0,
      realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
    store.data.positions.push(p);let placeCalls=0;
    gate.adapter.placeOrder=bybit.adapter.placeOrder=async()=>{placeCalls++;throw new Error('A known preflight refusal must prevent both place calls');};
    const snapshots=new Map<ExchangeId,MarketSnapshot>([['gate',closeBook('gate')],['bybit',closeBook('bybit')]]);
    const execution=new Execution(store,{config:()=>config,snapshot:exchange=>snapshots.get(exchange as ExchangeId),
      adapter:exchange=>exchange==='gate'?gate.adapter:bybit.adapter,liveUnlocked:()=>true,halt:()=>{},
      refreshSnapshots:async()=>{for(const snapshot of snapshots.values()){snapshot.timestamp=Date.now();snapshot.observedAt=Date.now();snapshot.takerFeeAt=Date.now();}}});
    try{
      await execution.close(p,'offline manual close',undefined,{pricing,requireProfit:false});
      assert.equal(placeCalls,0);assert.equal(store.data.orders.length,0);assert.equal(p.long.quantity,100);assert.equal(p.short.quantity,100);
      assertReadsOnly(gate.calls);assertReadsOnly(bybit.calls);
    }finally{
      await Promise.all([gate.adapter.close(),bybit.adapter.close()]);
      const resolved=path.resolve(dir),relative=path.relative(tempRoot,resolved);
      assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(resolved).startsWith('funding-reduction-preflight-'));
      rmSync(resolved,{recursive:true,force:true});
    }
  }
});
