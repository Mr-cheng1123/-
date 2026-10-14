import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {planScopedFullCloseBatch,planScopedFullReduction} from '../src/core/close-batch.js';
import {quantitySubtract,quantitySubtractOnStep} from '../src/core/order-quantity.js';
import {executeScopedManualClose,manualCloseLegKey} from '../src/core/scoped-manual-close.js';
import {Execution} from '../src/core/execution.js';
import {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountPosition,ExchangeAdapter,ExchangeId,JournalOrder,MarketSnapshot,OrderRequest,Position} from '../src/shared/types.js';

function book(exchange:ExchangeId='gate',step=.1,minimum=.1,capacity=.1):MarketSnapshot {
  const now=Date.now();
  return {exchange,base:'LOTTAIL',symbol:'LOTTAIL/USDT:USDT',source:'public',timestamp:now,observedAt:now,
    markPrice:43.2,indexPrice:43.2,fundingRate:0,nextFundingTime:now+3600000,intervalHours:8,fundingHistory:[],
    bids:[{price:43.1,quantity:capacity}],asks:[{price:43.2,quantity:capacity}],quantityStep:step,minQuantity:minimum,
    minNotional:5,contractSize:step,openInterestUsd:1e6,volume24hUsd:1e6};
}

test('a fresh .1 native slot can finish a reused ledger .1000000000000001 holding with exactly one .1 lot',()=>{
  const quote=book(),before=structuredClone(quote);
  assert.deepEqual(planScopedFullReduction(quote,'short',.1000000000000001,.1),{quantity:.1,limitPrice:43.2});
  assert.deepEqual(quote,before);
});

test('a full one-slot exit returns the canonical lot quantity rather than a floating extra fraction',()=>{
  assert.deepEqual(planScopedFullReduction(book('gate',.1,.1,.6000000000000001),'short',.6000000000000001),
    {quantity:.6,limitPrice:43.2});
});

test('scoped paired final lots recognise machine rounding without changing the legal request quantity',()=>{
  const plan=planScopedFullCloseBatch(book(),book('bybit'),.1000000000000001,.1);
  assert.equal(plan.status,'paired');
  if(plan.status==='paired')assert.equal(plan.plan.quantity,.1);
});

test('a real off-grid tail and insufficient visible capacity still stop the scoped planner',()=>{
  for(const holding of [.100001,.10000001,.15])assert.equal(planScopedFullReduction(book(),'short',holding,.1),undefined);
  assert.equal(planScopedFullReduction(book('gate',.1,.1,.09),'short',.1000000000000001,.1),undefined);
  assert.equal(planScopedFullReduction(book(),'short',1e-16,1e-16),undefined);
});

test('different minimum lots still preserve both legal remainders and never split for temporary capacity',()=>{
  const gate=book('gate',10,10,70),bybit=book('bybit',1,10,65);
  const plan=planScopedFullCloseBatch(gate,bybit,70,65);
  assert.equal(plan.status,'paired');if(plan.status==='paired')assert.equal(plan.plan.quantity,50);
  assert.deepEqual(planScopedFullCloseBatch({...gate,asks:[{price:43.2,quantity:1}],bids:[{price:43.1,quantity:1}]},bybit,70,65),
    {status:'wait',reason:'capacity'});
});

test('a genuinely tiny legal native lot remains a positive order quantity',()=>{
  assert.deepEqual(planScopedFullReduction(book('gate',1e-16,1e-16,1e-16),'short',1e-16),
    {quantity:1e-16,limitPrice:43.2});
});

test('six confirmed .1 lots subtract to zero without altering exact cash arithmetic',()=>{
  let quantity=.6000000000000001;
  for(const expected of [.5,.4,.3,.2,.1,0]){
    quantity=quantitySubtractOnStep(quantity,.1,.1);assert.equal(quantity,expected);
  }
  assert.equal(quantitySubtract(.1000000000000001,.1),1e-16);
  assert.equal(quantitySubtractOnStep(.1000000000000001,.1,.1),0);
});

test('step-aware subtraction cannot erase real off-grid positive quantities or over-subtraction',()=>{
  for(const [a,b,step] of [[1e-16,0,.1],[2e-16,1e-16,.1],[.100001,.1,.1],[.1,.09999999,.1],
    [.1,.100001,.1],[.1,.2,.1],[.1000000000000001,.1,NaN],[.1000000000000001,.1,0]]){
    assert.equal(quantitySubtractOnStep(a,b,step),quantitySubtract(a,b));
  }
  assert.equal(quantitySubtractOnStep(2e-16,1e-16,1e-16),1e-16);
});

test('large holdings whose machine precision spans a native lot are not snapped by an unbounded tolerance',()=>{
  const holding=1e12+.0004,step=.001;
  assert.equal(quantitySubtractOnStep(holding,1e12,step),quantitySubtract(holding,1e12));
});

function scopedFixture(lots=6,holding=.6000000000000001,nativeQuantity=holding){
  const directory=mkdtempSync(path.join(tmpdir(),'scoped-floating-tail-'));
  const config={...structuredClone(defaultConfig),mode:'live' as const,dataSource:'public' as const,exchanges:['gate'] as ExchangeId[]};
  const store=new Store(path.join(directory,'state.json'),config);
  const emptyLeg={exchange:'gate' as const,symbol:'LOTTAIL/USDT:USDT',quantity:0,entryPrice:0,markPrice:43.2,feesUsd:0,liquidationDistancePct:null};
  const position:Position={id:'explicit-native-only',base:'LOTTAIL',mode:'live',status:'attention',manualCloseOnly:true,
    manualCloseAccountRecord:true,long:{...emptyLeg,side:'long'},short:{...emptyLeg,side:'short',quantity:holding,entryPrice:42.36,feesUsd:.03},
    openedAt:Date.now()-60000,plannedExitAt:0,holdMode:'continuous',fundingUsd:.07,feesUsd:.03,transferCostUsd:.02,
    realizedSpreadPnlUsd:-.05,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:['old-cash'],riskReasons:[]};
  const original:Position={...structuredClone(position),id:'original-unknown-source',manualCloseOnly:undefined,
    manualCloseAccountRecord:undefined,long:{...emptyLeg,exchange:'bybit',side:'long'},short:{...position.short,quantity:.6000000000000001}};
  const unknown:JournalOrder={positionId:original.id,exchange:'bybit',createdAt:Date.now()-60000,
    request:{clientOrderId:'original-bybit-unknown',base:position.base,symbol:emptyLeg.symbol,side:'buy',quantity:.6,limitPrice:43.2,reduceOnly:false},
    result:{id:'',clientOrderId:'original-bybit-unknown',status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()-60000}};
  store.data.positions.push(original,position);store.data.orders.push(unknown);
  const frozen:AccountPosition={base:position.base,symbol:emptyLeg.symbol,side:'short',quantity:nativeQuantity,entryPrice:42.36,
    markPrice:43.2,liquidationPrice:0,leverage:2,marginMode:'crossed',positionOpenedAt:Date.now()-120000};
  let remainingLots=lots,firstRead=true,resultUnknown=false;
  const sent:OrderRequest[]=[];
  const adapter:ExchangeAdapter={id:'gate',fetchAccount:async()=>({freeUsd:1000,equityUsd:1000,positions:remainingLots?[{...frozen,quantity:Number(`${remainingLots}e-1`)}]:[]}),
    fetchClosePositions:async()=>{const quantity=firstRead?nativeQuantity:Number(`${remainingLots}e-1`);firstRead=false;return quantity?[{...frozen,quantity}]:[];},
    fetchSnapshots:async()=>[book()],fetchOpenOrders:async()=>[],fetchFundingPayments:async()=>[],close:async()=>{},
    prepareTrading:async()=>{throw new Error('Explicit reductions do not change trading settings');},
    validateOrder:async request=>{assert.equal(request.reduceOnly,true);assert.equal(request.quantity,.1);assert(remainingLots>0);},
    placeOrder:async request=>{
      assert.equal(request.reduceOnly,true);assert.equal(request.side,'buy');assert.equal(request.quantity,.1);
      assert(remainingLots>0);sent.push(structuredClone(request));
      if(!resultUnknown)remainingLots--;
      return {id:`gate-confirmed-${sent.length}`,clientOrderId:request.clientOrderId,status:resultUnknown?'unknown':'filled',
        filledQuantity:resultUnknown?0:.1,averagePrice:resultUnknown?0:request.limitPrice,feeUsd:resultUnknown?0:.1*request.limitPrice*.0005,timestamp:Date.now()};
    },cancelOrder:async()=>{throw new Error('Do not cancel another source order');},
    reconcileOrder:async request=>({id:'',clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()}),
    inspectOrder:async()=>{throw new Error('Independent selected reduction must not read the old Bybit intent');}};
  const run=()=>executeScopedManualClose({store,config,position,selected:[{exchange:'gate',position:frozen}],
    nativeSlots:new Map([[manualCloseLegKey('gate',frozen),[frozen]]]),adapter:exchange=>{assert.equal(exchange,'gate');return adapter;},
    read:async(_adapter,_key,call)=>call(),ensure:()=>{},message:error=>error instanceof Error?error.message:String(error)});
  return {store,config,adapter,position,original,unknown,sent,run,remaining:()=>remainingLots,setUnknown:()=>{resultUnknown=true;},
    cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}

test('explicit one-slot close finishes six .1 batches and preserves the original other-venue unknown and prior cash',async()=>{
  const f=scopedFixture(),before=structuredClone({original:f.original,unknown:f.unknown});
  try{
    await f.run();
    assert.equal(f.position.status,'closed',f.position.riskReasons.join(';'));
    assert.equal(f.position.short.quantity,0);assert.equal(f.sent.length,6);assert.equal(f.remaining(),0);
    assert(f.sent.every(request=>request.quantity===.1&&request.reduceOnly));
    assert.deepEqual({original:f.original,unknown:f.unknown},before);
    assert.equal(f.position.fundingUsd,.07);assert.equal(f.position.transferCostUsd,.02);assert.deepEqual(f.position.fundingEvents,['old-cash']);
    assert(Math.abs(f.position.feesUsd-(.03+6*.1*43.2*.0005))<Number.EPSILON);
    assert(Math.abs(f.position.realizedSpreadPnlUsd-(-.05+6*.1*(42.36-43.2)))<Number.EPSILON*16);
  }finally{f.cleanup();}
});

test('a fresh explicit last-lot confirmation finishes the reused .1000000000000001 ledger once',async()=>{
  const f=scopedFixture(1,.1000000000000001,.1);try{
    await f.run();assert.equal(f.sent.length,1);assert.equal(f.sent[0].quantity,.1);
    assert.equal(f.position.status,'closed',f.position.riskReasons.join(';'));assert.equal(f.position.short.quantity,0);assert.equal(f.remaining(),0);
  }finally{f.cleanup();}
});

test('an unknown new reduction retains the exposure and cannot consume the extra floating portion or start a second order',async()=>{
  const f=scopedFixture(1,.1000000000000001,.1);try{
    f.setUnknown();await f.run();assert.equal(f.sent.length,1);assert.equal(f.position.status,'attention');
    assert.equal(f.position.short.quantity,.1000000000000001);assert.equal(f.remaining(),1);assert.equal(f.position.feesUsd,.03);
    assert.equal(f.unknown.result!.status,'unknown');assert.equal(f.store.data.orders.at(-1)!.result!.status,'unknown');
  }finally{f.cleanup();}
});

test('a confirmed last lot uses its submitted .1 step even when the same quote object changes to .2 during the native call',async()=>{
  const f=scopedFixture(1,.1000000000000001,.1),quote=book(),before=structuredClone({original:f.original,unknown:f.unknown});
  const nativePlace=f.adapter.placeOrder.bind(f.adapter);
  f.adapter.placeOrder=async request=>{quote.quantityStep=.2;return nativePlace(request);};
  const execution=new Execution(f.store,{config:()=>f.config,snapshot:()=>quote,adapter:()=>f.adapter,liveUnlocked:()=>true,halt:()=>{}});
  try{
    const receipt=await execution.order(f.position,f.position.short,'buy',.1,true);
    assert.equal(receipt.status,'filled');assert.equal(receipt.filledQuantity,.1);assert.equal(quote.quantityStep,.2);
    assert.equal(f.sent.length,1);assert.equal(f.sent[0].quantity,.1);assert.equal(f.position.short.quantity,0);
    assert.equal(f.remaining(),0);assert.deepEqual({original:f.original,unknown:f.unknown},before);
    assert.equal(f.position.fundingUsd,.07);assert.equal(f.position.transferCostUsd,.02);
    assert(Math.abs(f.position.feesUsd-(.03+.1*43.2*.0005))<Number.EPSILON);
    assert(Math.abs(f.position.realizedSpreadPnlUsd-(-.05+.1*(42.36-43.2)))<Number.EPSILON*16);
  }finally{f.cleanup();}
});
