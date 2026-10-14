import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {Execution} from '../src/core/execution.js';
import {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest,OrderResult,Position} from '../src/shared/types.js';

const venues=['gate','bitget'] as const;
type Venue=typeof venues[number];
type RecordedRequest={exchange:Venue;request:OrderRequest};
function clock(){
  const original=Date.now;let value=1_000_000;
  Date.now=()=>value;
  return {advance:(ms:number)=>{value+=ms;},restore:()=>{Date.now=original;}};
}
function book(exchange:Venue,capacity:number):MarketSnapshot{
  const now=Date.now();
  return {exchange,base:'CLOSERECOVERY',symbol:'CLOSERECOVERY/USDT:USDT',source:'public',timestamp:now,observedAt:now,
    bookTransport:'websocket',fundingObservedAt:now,markPrice:1,indexPrice:1,fundingRate:0,nextFundingTime:now+3600000,
    intervalHours:8,fundingHistory:[],bids:[{price:exchange==='gate'?1:.99,quantity:capacity}],
    asks:[{price:exchange==='gate'?1.01:1,quantity:capacity}],quantityStep:1,minQuantity:1,minNotional:5,
    contractSize:1,openInterestUsd:1e6,volume24hUsd:1e6,takerFeeRate:.0005,takerFeeAt:now,takerFeeSource:'exchange'};
}
function fixture(options:{quantity?:number;capacity?:number;scoped?:boolean;manualOnly?:boolean}={}){
  const time=clock(),root=path.resolve('D:/codex/tmp');mkdirSync(root,{recursive:true});
  const directory=mkdtempSync(path.join(root,'scoped-close-book-recovery-'));
  const quantity=options.quantity??100,config={...structuredClone(defaultConfig),mode:'live' as const,dataSource:'public' as const,
    exchanges:[...venues] as ExchangeId[],maxSnapshotAgeMs:30000,maxQuoteSkewMs:3000,maxOrderRetries:2};
  const store=new Store(path.join(directory,'state.json'),config),quotes=new Map<Venue,MarketSnapshot>(venues.map(exchange=>[exchange,book(exchange,options.capacity??quantity)]));
  const position:Position={id:'scoped-quote-recovery',base:'CLOSERECOVERY',mode:'live',status:'open',manualCloseOnly:options.manualOnly??true,
    long:{exchange:'gate',symbol:'CLOSERECOVERY/USDT:USDT',side:'long',quantity,entryPrice:1,markPrice:1,feesUsd:0,liquidationDistancePct:null},
    short:{exchange:'bitget',symbol:'CLOSERECOVERY/USDT:USDT',side:'short',quantity,entryPrice:1,markPrice:1,feesUsd:0,liquidationDistancePct:null},
    openedAt:Date.now()-60000,plannedExitAt:0,holdMode:'continuous',fundingUsd:.1,feesUsd:0,transferCostUsd:.02,
    realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:.08,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  store.data.positions.push(position);
  const sent:RecordedRequest[]=[],validated:RecordedRequest[]=[],publicCalls:string[][]=[],fullRefreshes:string[][]=[];
  const remaining=new Map<Venue,number>(venues.map(exchange=>[exchange,quantity]));
  const counters={fees:0,account:0,reads:0};
  let validate:((exchange:Venue,request:OrderRequest)=>Promise<void>|void)|undefined;
  let submit:((exchange:Venue,request:OrderRequest)=>Promise<OrderResult>|OrderResult)|undefined;
  let publicRefresh:(()=>Promise<void>|void)|undefined;
  let fullRefresh:(()=>Promise<void>|void)|undefined;
  const refresh=(exchanges:readonly string[])=>{
    for(const exchange of exchanges){const quote=quotes.get(exchange as Venue)!;quotes.set(exchange as Venue,
      {...quote,timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now(),takerFeeAt:Date.now()});}
  };
  const receipt=(request:OrderRequest,filled=request.quantity,status:OrderResult['status']='filled'):OrderResult=>({
    id:`native-${request.clientOrderId}`,clientOrderId:request.clientOrderId,status,filledQuantity:filled,
    averagePrice:filled?request.limitPrice:0,feeUsd:filled*request.limitPrice*.0005,timestamp:Date.now()});
  const adapters=new Map<Venue,ExchangeAdapter>();
  for(const exchange of venues)adapters.set(exchange,{
    id:exchange,getExecutionSnapshot:()=>quotes.get(exchange),
    validateOrder:async request=>{
      assert(request.reduceOnly);assert(request.quantity>0&&request.quantity<=remaining.get(exchange)!);
      validated.push({exchange,request:structuredClone(request)});await validate?.(exchange,request);
    },
    placeOrder:async request=>{
      assert(request.reduceOnly);assert(request.quantity>0&&request.quantity<=remaining.get(exchange)!);
      sent.push({exchange,request:structuredClone(request)});
      const result=submit?await submit(exchange,request):receipt(request);
      if(result.status!=='unknown')remaining.set(exchange,remaining.get(exchange)!-result.filledQuantity);
      return result;
    },
    fetchTradingFee:async()=>{counters.fees++;throw new Error('Public quote recovery cannot read native fees');},
    fetchAccount:async()=>{counters.account++;throw new Error('Public quote recovery cannot read accounts');},
    reconcileOrder:async request=>{counters.reads++;return receipt(request,0,'unknown');},
    fetchSnapshots:async()=>{throw new Error('Execution must use its scoped public refresher');},
    prepareTrading:async()=>{throw new Error('A selected reduction must not change trading settings');},
    cancelOrder:async()=>{throw new Error('Recovery must not cancel or replace another order');},
    fetchFundingPayments:async()=>{throw new Error('Quote recovery cannot poll a funding ledger');},close:async()=>{},
  } as ExchangeAdapter);
  const execution=new Execution(store,{config:()=>config,snapshot:exchange=>quotes.get(exchange as Venue),
    adapter:exchange=>{assert(venues.includes(exchange as Venue));return adapters.get(exchange as Venue)!;},
    scopedFullClose:options.scoped??true,closeOrderStartIndex:0,liveUnlocked:()=>true,allowEntry:()=>false,
    prepareReduction:(leg,requested)=>({quantity:Math.min(requested,remaining.get(leg.exchange as Venue)!)}),
    refreshSnapshots:async(_base,exchanges)=>{fullRefreshes.push([...exchanges]);await fullRefresh?.();refresh(exchanges);},
    refreshReductionSnapshots:async(base,exchanges)=>{
      assert.equal(base,position.base);assert(exchanges.every(exchange=>venues.includes(exchange as Venue)));
      publicCalls.push([...exchanges]);refresh(exchanges);await publicRefresh?.();
    },halt:()=>{},});
  return {time,store,position,quotes,sent,validated,publicCalls,fullRefreshes,remaining,counters,receipt,execution,
    onValidate:(callback:typeof validate)=>{validate=callback;},onSubmit:(callback:typeof submit)=>{submit=callback;},
    onPublicRefresh:(callback:typeof publicRefresh)=>{publicRefresh=callback;},
    onFullRefresh:(callback:typeof fullRefresh)=>{fullRefresh=callback;},
    close:()=>execution.close(position,'Explicit frozen native scope',undefined,{pricing:'best-opposite',requireProfit:false}),
    cleanup:()=>{
      time.restore();const relative=path.relative(root,path.resolve(directory));
      assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));rmSync(directory,{recursive:true,force:true});
    }};
}

test('scoped stale validation refreshes only public quotes and preserves both original conservative limits and IDs',async()=>{
  const f=fixture();try{
    f.onValidate(exchange=>{if(exchange==='bitget'&&f.validated.length===2)f.time.advance(2101);});
    f.onPublicRefresh(()=>{
      assert.equal(f.store.data.orders.length,0);assert.equal(f.validated.length,2);
      f.quotes.get('gate')!.bids[0].price=1.005;f.quotes.get('bitget')!.asks[0].price=.995;
    });
    await f.close();assert.equal(f.position.status,'closed',f.position.riskReasons.join(';'));
    assert.equal(f.publicCalls.length,1);assert.equal(f.fullRefreshes.length,1);assert.equal(f.validated.length,2);assert.equal(f.sent.length,2);
    assert.deepEqual(f.sent.map(value=>value.request.clientOrderId),f.validated.map(value=>value.request.clientOrderId));
    assert.deepEqual(f.sent.map(value=>value.request.limitPrice),[1,1]);
    assert.deepEqual(f.counters,{fees:0,account:0,reads:0});
  }finally{f.cleanup();}
});

test('a moved BBO discards the unsubmitted pair and revalidates fresh smaller legal batches without adding journals',async()=>{
  const f=fixture();try{
    let originalIds:string[]=[];
    f.onValidate(exchange=>{if(exchange==='bitget'&&f.validated.length===2){originalIds=f.validated.map(value=>value.request.clientOrderId);f.time.advance(2101);}});
    f.onPublicRefresh(()=>{
      assert.equal(f.store.data.orders.length,0);
      f.quotes.get('gate')!.bids=[{price:.98,quantity:50}];f.quotes.get('bitget')!.asks=[{price:1.02,quantity:50}];
    });
    await f.close();assert.equal(f.position.status,'closed',f.position.riskReasons.join(';'));
    assert.equal(f.sent.length,4);assert.equal(f.fullRefreshes.length,2);assert(f.sent.every(value=>value.request.quantity===50));
    assert(f.sent.every(value=>!originalIds.includes(value.request.clientOrderId)));
    assert.deepEqual(f.sent.map(value=>value.request.limitPrice),[.98,1.02,.98,1.02]);
    assert(f.sent.every(value=>f.validated.some(validation=>validation.request.clientOrderId===value.request.clientOrderId)));
    assert.equal(f.store.data.orders.length,4);assert.equal(new Set(f.sent.map(value=>value.request.clientOrderId)).size,4);
    assert.deepEqual(f.counters,{fees:0,account:0,reads:0});
  }finally{f.cleanup();}
});

test('continually moving post-validation BBO permits at most two replans and never journals an unusable request',async()=>{
  const f=fixture();try{
    f.onValidate(exchange=>{if(exchange==='bitget')f.time.advance(2101);});
    f.onPublicRefresh(()=>{
      assert.equal(f.store.data.orders.length,0);
      f.quotes.get('gate')!.bids[0].price-=.001;f.quotes.get('bitget')!.asks[0].price+=.001;
    });
    await f.close();assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,0);
    assert(f.publicCalls.length>0&&f.publicCalls.length<=3);assert(f.validated.length<=6);
    assert.equal(f.position.long.quantity,100);assert.equal(f.position.short.quantity,100);
  }finally{f.cleanup();}
});

test('permanent native validation refusal is not classified as a transient quote error',async()=>{
  const f=fixture();try{
    f.onValidate(exchange=>{if(exchange==='gate')throw new Error('Selected native slot no longer matches');});
    await f.close();assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,0);assert.equal(f.publicCalls.length,0);
    assert.equal(f.validated.filter(value=>value.exchange==='gate').length,1);assert.match(f.position.riskReasons.join(';'),/native slot/);
  }finally{f.cleanup();}
});

test('a known native rejection after submission ends the operation without public recovery or extra financial requests',async()=>{
  const f=fixture({capacity:20});try{
    f.onSubmit((_exchange,request)=>({...f.receipt(request,0,'cancelled'),rejectionCode:'ORDER_RULES_UNAVAILABLE',rejectionReason:'Confirmed native refusal'}));
    await f.close();assert.equal(f.sent.length,2);assert.equal(f.publicCalls.length,0);
    assert.equal(f.position.long.quantity,100);assert.equal(f.position.short.quantity,100);
    assert(f.store.data.orders.every(order=>order.result!.rejectionCode==='ORDER_RULES_UNAVAILABLE'));
  }finally{f.cleanup();}
});

test('a post-intent known-fill save failure cannot be recovered as a book failure even when storage succeeds later',async()=>{
  const f=fixture({capacity:20});try{
    const save=f.store.save.bind(f.store);let failed=false;
    f.store.save=()=>{if(!failed&&f.store.data.orders.some(order=>order.result?.filledQuantity)){failed=true;throw new Error('Known receipt write interrupted');}save();};
    await f.close();assert.equal(failed,true);assert.equal(f.sent.length,2);assert.equal(f.publicCalls.length,0);
    assert.equal(f.position.status,'attention');assert.equal(f.store.data.orders.length,2);
    assert.equal(f.position.long.quantity,80);assert.equal(f.position.short.quantity,80);
    await f.close();assert.equal(f.sent.length,2);assert.equal(f.publicCalls.length,0);
  }finally{f.cleanup();}
});

test('an unknown new close receipt cannot start public recovery or create a replacement order',async()=>{
  const f=fixture({capacity:20});try{
    f.onSubmit((exchange,request)=>f.receipt(request,exchange==='gate'?0:request.quantity,exchange==='gate'?'unknown':'filled'));
    await f.close();assert.equal(f.sent.length,2);assert.equal(f.publicCalls.length,0);assert.equal(f.position.status,'attention');
    assert.equal(f.store.data.orders.length,2);assert.equal(f.store.data.orders[0].result!.status,'unknown');
    assert.equal(f.position.long.quantity,100);assert.equal(f.position.short.quantity,80);
  }finally{f.cleanup();}
});

test('ordinary automatic close and an unconfirmed manual-only flag never acquire scoped quote recovery',async()=>{
  for(const options of [{scoped:false,manualOnly:false},{scoped:true,manualOnly:false},{scoped:false,manualOnly:true}]){
    const f=fixture(options);try{
      f.onValidate(exchange=>{if(exchange==='bitget')f.time.advance(2101);});
      await f.close();assert.equal(f.sent.length,0);assert.equal(f.publicCalls.length,0);assert.equal(f.store.data.orders.length,0);
    }finally{f.cleanup();}
  }
});

test('one confirmed peer and a second pre-intent stale check are settled before new legal batches consume only the real residual',async()=>{
  const f=fixture({capacity:20});try{
    let unusedPeerId='';
    f.onSubmit((exchange,request)=>{
      if(exchange==='gate'&&f.sent.length===1){unusedPeerId=f.validated.find(value=>value.exchange==='bitget')!.request.clientOrderId;f.time.advance(2101);}
      return f.receipt(request);
    });
    let settledBeforeNextBatch=false;
    f.onFullRefresh(()=>{
      if(f.fullRefreshes.length!==2)return;
      assert.equal(f.store.data.orders.length,1);assert.equal(f.store.data.orders[0].result!.status,'filled');
      assert.equal(f.position.long.quantity,80);assert.equal(f.position.short.quantity,100);
      settledBeforeNextBatch=true;
    });
    await f.close();assert.equal(f.position.status,'closed',f.position.riskReasons.join(';'));
    assert.equal(settledBeforeNextBatch,true);assert.equal(f.publicCalls.length,0);
    assert.equal(f.remaining.get('gate'),0);assert.equal(f.remaining.get('bitget'),0);
    assert.equal(f.sent.filter(value=>value.exchange==='gate').reduce((sum,value)=>sum+value.request.quantity,0),100);
    assert.equal(f.sent.filter(value=>value.exchange==='bitget').reduce((sum,value)=>sum+value.request.quantity,0),100);
    assert(f.sent.every(value=>value.request.clientOrderId!==unusedPeerId));
    assert.equal(new Set(f.sent.map(value=>value.request.clientOrderId)).size,f.sent.length);
    assert.equal(f.store.data.orders.length,f.sent.length);assert.equal(f.position.long.quantity,0);assert.equal(f.position.short.quantity,0);
  }finally{f.cleanup();}
});

test('recovering fresh quotes does not reset the original three zero-fill rounds',async()=>{
  const f=fixture();try{
    f.onValidate(exchange=>{if(exchange==='bitget')f.time.advance(2101);});
    f.onSubmit((_exchange,request)=>f.receipt(request,0,'cancelled'));
    await f.close();assert.equal(f.sent.length,6);assert.equal(f.publicCalls.length,3);
    assert.equal(f.position.long.quantity,100);assert.equal(f.position.short.quantity,100);
    assert.equal(new Set(f.sent.map(value=>value.request.clientOrderId)).size,6);
  }finally{f.cleanup();}
});

test('public quote recovery cannot extend the original thirty-second processing window',async()=>{
  const f=fixture();try{
    f.onValidate(exchange=>{if(exchange==='bitget')f.time.advance(2101);});
    f.onPublicRefresh(()=>{f.time.advance(30001);});
    await f.close();assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,0);assert.equal(f.publicCalls.length,1);
    assert.equal(f.position.long.quantity,100);assert.equal(f.position.short.quantity,100);
  }finally{f.cleanup();}
});
