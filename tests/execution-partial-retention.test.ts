import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Execution} from '../src/core/execution.js';
import {Store} from '../src/core/store.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest,OrderResult,Position} from '../src/shared/types.js';

// Replay the CT incident with in-memory exchange responses only. No transport or credentials exist.
function fixture(options:{longFill?:number;shortFill?:number;shortMinimum?:number;longStep?:number;shortStep?:number;reduce?:'filled'|'partial'|'cancelled'|'unknown';rejectReduction?:boolean;
  supplementFills?:number[];longFills?:number[];longExchange?:'gate'|'bitget';shortRepairPrice?:number;unverifiedPrice?:boolean;unknownSupplement?:boolean;unknownLong?:boolean;unknownLongAttempt?:number;afterCancelPrice?:number}={}){
  const tempRoot=path.resolve(tmpdir()),dir=mkdtempSync(path.join(tempRoot,'ct-retention-mock-'));
  const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,entryPolicy:'aligned' as const,
    minEntryIocEdgeBps:0,dualAdvantageEnabled:false,orderNotionalUsd:100,maxOrderRetries:1,maxEntryBatches:1};
  const store=new Store(path.join(dir,'state.json'),config),quotes=new Map<ExchangeId,MarketSnapshot>();
  // Both legs in this execution fixture share one actual settlement boundary.
  // Capturing separately can invent a first payment 1 ms before its receipt.
  const observedAt=Date.now();
  const longExchange=options.longExchange??'gate';
  for(const exchange of [longExchange,'bybit'] as const)quotes.set(exchange,{exchange,base:'CT',symbol:'CT/USDT:USDT',timestamp:observedAt,
    markPrice:.507,indexPrice:.508,fundingRate:exchange===longExchange?.0001:.0003,nextFundingTime:observedAt+300_000,intervalHours:8,
    fundingHistory:[],bids:[{price:exchange===longExchange?.5052:.508,quantity:1000}],asks:[{price:exchange===longExchange?.5068:.5083,quantity:1000}],
    openInterestUsd:1e6,volume24hUsd:1e6,quantityStep:exchange===longExchange?(options.longStep??10):(options.shortStep??1),minQuantity:exchange===longExchange?(options.longStep??10):(options.shortMinimum??1),
    minNotional:1,contractSize:exchange==='gate'?10:1,source:'public',
    takerFeeRate:config.takerFees[exchange],takerFeeAt:observedAt,takerFeeSource:'exchange'});
  const p:Position={id:'ct-offline',base:'CT',mode:'live',status:'opening',entryPolicy:'aligned',holdMode:'adaptive',
    long:{exchange:longExchange,symbol:'CT/USDT:USDT',side:'long',quantity:0,entryPrice:0,markPrice:.507,feesUsd:0,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'CT/USDT:USDT',side:'short',quantity:0,entryPrice:0,markPrice:.507,feesUsd:0,liquidationDistancePct:null},
    openedAt:observedAt,plannedExitAt:observedAt+300_000,fundingUsd:0,feesUsd:0,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,
    netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  store.data.positions.push(p);
  const sent:Array<{exchange:ExchangeId;request:OrderRequest}>=[],halts:string[]=[];
  let shortEntries=0,longEntries=0,reduceCount=0;
  const adapters=new Map<ExchangeId,ExchangeAdapter>();
  for(const exchange of [longExchange,'bybit'] as const)adapters.set(exchange,{
    validateOrder:async(request:OrderRequest)=>{if(request.reduceOnly&&options.rejectReduction)throw new Error('minimum reduction cost');},
    placeOrder:async(request:OrderRequest):Promise<OrderResult>=>{
      assert.ok(store.data.orders.some(order=>order.request.clientOrderId===request.clientOrderId));
      sent.push({exchange,request});
      if(!request.reduceOnly&&exchange===longExchange)longEntries++;
      if(!request.reduceOnly&&exchange===longExchange&&(options.unknownLong||options.unknownLongAttempt===longEntries))
        return {id:request.clientOrderId,clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()};
      let quantity=request.quantity,status:OrderResult['status']='filled';
      if(!request.reduceOnly){
        quantity=exchange===longExchange?(options.longFills?.[longEntries-1]??options.longFill??request.quantity):++shortEntries===1?(options.shortFill??106):(options.supplementFills?.[shortEntries-2]??0);
        if(quantity>request.quantity)quantity=request.quantity;
        status=quantity===request.quantity?'filled':quantity>0?'partial':'cancelled';
        if(exchange==='bybit'&&shortEntries>1&&options.unknownSupplement)status='unknown';
      }else{
        reduceCount++;
        const reduction=options.reduce??'filled';
        if(reduction==='cancelled'||reduction==='unknown'){quantity=0;status=reduction;}
        else if(reduction==='partial'&&exchange==='gate'&&reduceCount===1){quantity=request.quantity-10;status='partial';}
      }
      return {id:request.clientOrderId,clientOrderId:request.clientOrderId,status,filledQuantity:quantity,averagePrice:quantity?request.limitPrice:0,
        ...(status==='cancelled'&&exchange==='bybit'?{rejectionCode:'EC_NoImmediateQtyToFill',rejectionReason:'no immediate quantity to fill'}:{}),
        ...(options.unverifiedPrice&&!request.reduceOnly&&quantity>0?{averagePriceVerified:false}:{}),
        feeUsd:quantity*request.limitPrice*config.takerFees[exchange],timestamp:Date.now()};
    },
    reconcileOrder:async(request:OrderRequest)=>({id:request.clientOrderId,clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,
      averagePrice:0,feeUsd:0,timestamp:Date.now()} as OrderResult),
  } as unknown as ExchangeAdapter);
  const execution=new Execution(store,{config:()=>store.data.config,snapshot:exchange=>quotes.get(exchange as ExchangeId),
    adapter:exchange=>adapters.get(exchange as ExchangeId)!,liveUnlocked:()=>true,halt:reason=>{halts.push(reason);},
    refreshSnapshots:async(_base,exchanges)=>{
      for(const exchange of exchanges)quotes.get(exchange as ExchangeId)!.timestamp=Date.now();
      const price=shortEntries>1?options.afterCancelPrice??options.shortRepairPrice:shortEntries===1?options.shortRepairPrice:undefined;
      if(price!==undefined){quotes.get('bybit')!.bids=[{price,quantity:1000}];quotes.get('bybit')!.asks=[{price:price+.0003,quantity:1000}];}
    }});
  const validate=async(phase:'initial'|'supplement'|'batch'='initial')=>{const opportunity=calculateOpportunities([...quotes.values()],config)[0];if(phase==='initial')assert.equal(opportunity.eligible,true,opportunity.reasons.join('；'));return opportunity;};
  return {store,p,sent,halts,quotes,adapters,execution,validate,cleanup:()=>{
    const resolved=path.resolve(dir),relative=path.relative(tempRoot,resolved);
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(resolved).startsWith('ct-retention-mock-'));
    rmSync(resolved,{recursive:true,force:true});
  }};
}

test('the CT fixture is synchronous while a genuine one-millisecond first-payment gap remains blocked',t=>{
  const now=1_700_000_000_000;t.mock.method(Date,'now',()=>now);const f=fixture();try{
    const long=f.quotes.get('gate')!,short=f.quotes.get('bybit')!;
    assert.equal(long.nextFundingTime,short.nextFundingTime);assert.equal(long.timestamp,short.timestamp);
    const synchronized=calculateOpportunities([...f.quotes.values()],f.store.data.config,now)[0];
    assert.equal(synchronized.eligible,true,synchronized.reasons.join('；'));assert.equal(synchronized.fundingSchedule?.asynchronous,false);
    short.nextFundingTime=long.nextFundingTime+1;
    const different=calculateOpportunities([...f.quotes.values()],f.store.data.config,now)[0];
    assert.equal(different.eligible,false);assert.equal(different.fundingSchedule?.asynchronous,true);
    assert.ok(different.fundingSchedule!.preReceiptPaymentsUsd>0);assert.match(different.reasons.join('；'),/先付后收/);
    assert.equal(f.sent.length,0,'the timing diagnosis never submits an order');
  }finally{f.cleanup();}
});

test('CT: Bybit fills 106 first, Gate buys only the 100-lot hedge, and the 6-coin short dust is reduced',async()=>{
  const f=fixture();try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);assert.equal(f.p.deltaUsd,0);
    assert.deepEqual(f.sent.map(({exchange,request})=>[exchange,request.side,request.quantity,request.reduceOnly]),[
      ['bybit','sell',190,false],['gate','buy',100,false],['bybit','buy',6,true],
    ]);
    assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.p.closedAt,undefined);assert.equal(f.halts.length,0);
    assert.equal(f.p.long.entryPrice,.5068);assert.equal(f.p.short.entryPrice,.508);
    assert.ok(Math.abs(f.p.realizedSpreadPnlUsd-(-.0018))<1e-12,'only the 6-coin Bybit reduction books realized price loss');
    assert.ok(Math.abs(f.p.feesUsd-.05663379)<1e-9,'106-coin short, 100-coin long and 6-coin reduction fees are booked once');
    assert.equal(f.store.data.orders.filter(order=>order.request.reduceOnly).reduce((sum,order)=>sum+(order.result?.filledQuantity??0),0),6);
  }finally{f.cleanup();}
});

test('CT: a zero Bybit fill never submits Gate and pays no unwind',async()=>{
  const f=fixture({shortFill:0});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'closed');assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);
    assert.equal(f.sent.length,3);assert.ok(f.sent.every(({exchange,request})=>exchange==='bybit'&&request.side==='sell'&&request.quantity===190&&!request.reduceOnly));
    assert.equal(f.p.feesUsd,0);assert.equal(f.p.realizedSpreadPnlUsd,0);
    assert.match(f.p.closeReason??'',/bybit 卖出未成交，gate 未提交本批多腿/);
    assert.equal(f.p.closeRequestedAt,undefined);
  }finally{f.cleanup();}
});

test('a 106-coin short on a 10-coin long lot is hedged at 100 and the 6-coin dust is reduced',async()=>{
  const f=fixture({longFill:106,shortFill:106});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
    assert.equal(f.sent.find(x=>x.exchange==='gate')!.request.quantity,100);
    assert.equal(f.p.closeRequestedAt,undefined);
  }finally{f.cleanup();}
});

test('the long order is capped at the filled short, so a larger mock fill cannot open excess',async()=>{
  const f=fixture({longFill:186,shortFill:106});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
    assert.deepEqual(f.sent.filter(x=>x.request.reduceOnly).map(x=>[x.exchange,x.request.quantity]),[['bybit',6]]);
  }finally{f.cleanup();}
});

test('a minimum reduction of 10 skips CT dust of 6 and selects the next reachable hedge, 90/90',async()=>{
  const f=fixture({shortMinimum:10});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,90);
    assert.deepEqual(f.sent.filter(x=>x.request.reduceOnly).map(x=>[x.exchange,x.request.quantity]),[['gate',10],['bybit',16]]);
  }finally{f.cleanup();}
});

test('minimum-cost rejection leaves the existing pair visible without any entire-pair close request',async()=>{
  const f=fixture({rejectReduction:true});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'attention');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,106);
    assert.equal(f.sent.filter(x=>x.request.reduceOnly).length,0);assert.equal(f.p.closeRequestedAt,undefined);
    assert.equal(f.halts.length,1);assert.match(f.p.riskReasons.join('；'),/对冲.*保留|保留.*对冲/);
  }finally{f.cleanup();}
});

test('known partial excess reduction is retried with a fresh quote without closing matched holdings',async()=>{
  const f=fixture({reduce:'partial'});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
    assert.deepEqual(f.sent.filter(x=>x.request.reduceOnly).map(x=>[x.exchange,x.request.quantity]),[['bybit',6]]);
    assert.equal(f.p.closeRequestedAt,undefined);
  }finally{f.cleanup();}
});

test('unknown excess-reduction order freezes this asset and never triggers a fresh supplement or a full close',async()=>{
  const f=fixture({reduce:'unknown'});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'attention');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,106);
    assert.equal(f.sent.length,3);assert.equal(f.p.closeRequestedAt,undefined);
    assert.equal(f.store.data.orders.filter(order=>order.result?.status==='unknown').length,1);
  }finally{f.cleanup();}
});

test('incompatible fill residues remove only executable excess and preserve opposite fills for reconciliation',async()=>{
  const f=fixture({shortFill:106.5});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'attention');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100.5);
    assert.deepEqual(f.sent.filter(x=>x.request.reduceOnly).map(x=>[x.exchange,x.request.quantity]),[['bybit',6]]);
    assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.halts.length,1);
  }finally{f.cleanup();}
});

test('smaller decimal order increments retain a neutral partial hedge with machine-rounding tolerance',async()=>{
  const f=fixture({longFill:106.2,shortFill:106.18,longStep:.02,shortStep:.01});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'open');assert.ok(Math.abs(f.p.long.quantity-106.18)<1e-12);assert.ok(Math.abs(f.p.short.quantity-106.18)<1e-12);
    assert.deepEqual(f.sent.filter(x=>x.request.reduceOnly).map(x=>[x.exchange,x.request.quantity]),[]);
    assert.equal(f.p.closeRequestedAt,undefined);
  }finally{f.cleanup();}
});

test('the final manual lease hook is synchronous and can reject before either durable order intent',async()=>{
  const f=fixture();try{
    let called=0;
    await assert.rejects(f.execution.open(f.p,190,190,f.validate,()=>{called++;throw new Error('manual entry expired');}),/manual entry expired/);
    assert.equal(called,1);assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,0);
  }finally{f.cleanup();}
});

test('entry progress notifications cannot interrupt protection of confirmed partial fills',async()=>{
  const f=fixture();try{
    const phases:string[]=[];let commits=0;
    await f.execution.open(f.p,190,190,f.validate,()=>{commits++;assert.equal(f.store.data.orders.length,0);},phase=>{phases.push(phase);throw new Error('UI observer unavailable');});
    assert.equal(commits,1);assert.deepEqual(phases,['reconciling']);assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
  }finally{f.cleanup();}
});

test('the unfilled 84 coins are not chased after the short fill is already hedged',async()=>{
  const f=fixture({supplementFills:[0,84],afterCancelPrice:.5075});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
    assert.equal(f.sent.filter(x=>x.exchange==='bybit'&&!x.request.reduceOnly).length,1);
    assert.equal(f.p.closeRequestedAt,undefined);
  }finally{f.cleanup();}
});

test('unfavorable missing-leg price cannot consume the profit of the old matched units',async()=>{
  const f=fixture({shortRepairPrice:.5065});try{
    const proposedOverall=(106*.508+84*.5065)/190;
    assert.ok(proposedOverall>.5068,'overall weighted basis would still pass the old supplement rule');
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.sent.filter(x=>!x.request.reduceOnly).length,2,'the fresh 84-coin sell below the actual long fill must not be submitted');
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
  }finally{f.cleanup();}
});

test('a cancelled repair retries only while its refreshed price still has an advantage',async()=>{
  const f=fixture({afterCancelPrice:.5065});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.sent.filter(x=>!x.request.reduceOnly).length,2,'the unfilled remainder is not sold again at a worse bid');
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
  }finally{f.cleanup();}
});

test('when the venue allows the exact excess reduction, keep all 106 matched coins',async()=>{
  const f=fixture({longFill:190,longStep:1,shortRepairPrice:.5065});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,106);assert.equal(f.p.short.quantity,106);
    assert.deepEqual(f.sent.filter(x=>x.request.reduceOnly).map(x=>[x.exchange,x.request.quantity]),[]);
    assert.equal(f.sent.filter(x=>!x.request.reduceOnly).length,2);assert.equal(f.p.closeRequestedAt,undefined);
  }finally{f.cleanup();}
});

test('an explicitly unverified filled price prevents exposure-expanding supplementation',async()=>{
  const f=fixture({unverifiedPrice:true,supplementFills:[84]});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.sent.filter(x=>!x.request.reduceOnly).length,1,'an unverified short fill cannot approve the previously unsent long');
    assert.equal(f.sent.filter(x=>x.exchange==='gate').length,0);
    assert.equal(f.p.status,'attention');assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,106);
    assert.equal(f.sent.filter(x=>x.request.reduceOnly).length,0,'uncertain original cash cannot authorize a speculative rollback');
    const journal=f.store.data.orders[0];assert.equal(journal.result!.status,'unknown');
    assert.equal(journal.result!.averagePriceVerified,false);assert.equal(journal.result!.id,journal.request.clientOrderId);
    const actual={...journal.result!,status:'partial' as const,averagePriceVerified:true,timestamp:Date.now()};
    assert.equal(f.execution.applyObservedOrder(journal,actual),true);
    assert.equal(f.p.short.quantity,106);assert.equal(f.sent.length,1,'read-only cash recovery never starts an automatic supplement');
  }finally{f.cleanup();}
});

test('an unknown long order freezes the filled short and does not reduce it or send another long',async()=>{
  const f=fixture({unknownLong:true});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'attention');assert.equal(f.sent.length,2);assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,106);
    assert.equal(f.sent.filter(x=>x.request.reduceOnly).length,0);assert.equal(f.p.closeRequestedAt,undefined);
  }finally{f.cleanup();}
});

test('zero retry configuration still disables supplements, and cache alone cannot repeat a cancelled IOC',async()=>{
  for(const disabled of ['config','transport'] as const){
    const f=fixture();try{
      if(disabled==='config')f.store.data.config.maxOrderRetries=0;
      else f.execution.context.refreshSnapshots=undefined;
      await f.execution.open(f.p,190,190,f.validate);
      assert.equal(f.sent.filter(x=>!x.request.reduceOnly).length,2);
      assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
    }finally{f.cleanup();}
  }
});

test('16:26 CT replay: archived zero-fill sells never trigger a Bitget buy or a losing third retry',async()=>{
  const f=fixture({longExchange:'bitget',longStep:1,shortFill:0,supplementFills:[0,0]});try{
    for(const quote of f.quotes.values()){quote.markPrice=.624;quote.indexPrice=.624;}
    f.quotes.get('bitget')!.asks=[{price:.62391,quantity:1000}];
    f.quotes.get('bitget')!.bids=[{price:.6232,quantity:1000}];
    f.quotes.get('bybit')!.bids=[{price:.6255,quantity:1000}];
    f.quotes.get('bybit')!.asks=[{price:.6256,quantity:1000}];
    const refresh=f.execution.context.refreshSnapshots!;
    f.execution.context.refreshSnapshots=async(base,exchanges)=>{
      await refresh(base,exchanges);
      const attempts=f.sent.filter(order=>order.exchange==='bybit').length;
      const price=attempts>=2?.6238:attempts===1?.6249:.6255;
      f.quotes.get('bybit')!.bids=[{price,quantity:1000}];
      f.quotes.get('bybit')!.asks=[{price:price+.0001,quantity:1000}];
    };
    await f.execution.open(f.p,160,160,f.validate);
    assert.equal(f.p.status,'closed');
    // The third archived sell (.6238) would no longer beat today's .62391 buy bound,
    // so the revised executor correctly stops even before sending that losing retry.
    assert.deepEqual(f.sent.map(order=>[order.exchange,order.request.side,order.request.quantity,order.request.limitPrice]),[
      ['bybit','sell',160,.6255],['bybit','sell',160,.6249],
    ]);
    assert.equal(f.store.data.orders.every(order=>order.result?.rejectionCode==='EC_NoImmediateQtyToFill'),true);
    assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);
    assert.equal(f.p.feesUsd,0);assert.equal(f.p.realizedSpreadPnlUsd,0);assert.equal(f.p.netPnlUsd,0);
  }finally{f.cleanup();}
});

test('a confirmed short gets two bounded fresh long retries before any unwind',async()=>{
  const f=fixture({longFills:[0,0,100]});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
    assert.deepEqual(f.sent.map(order=>[order.exchange,order.request.quantity,order.request.reduceOnly]),[
      ['bybit',190,false],['gate',100,false],['gate',100,false],['gate',100,false],['bybit',6,true],
    ]);
    assert.ok(f.sent.filter(order=>order.exchange==='gate').every(order=>order.request.limitPrice===.5068));
    assert.equal(f.p.closeRequestedAt,undefined);
    assert.equal(new Set(f.sent.map(order=>order.request.clientOrderId)).size,5);
  }finally{f.cleanup();}
});

test('a partial long retries only its missing quantity and retains all 106 when its lot permits',async()=>{
  const f=fixture({longStep:1,longFills:[40,66]});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,106);assert.equal(f.p.short.quantity,106);
    assert.deepEqual(f.sent.map(order=>[order.exchange,order.request.quantity,order.request.reduceOnly]),[
      ['bybit',196,false],['gate',106,false],['gate',66,false],
    ]);
    assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.p.deltaUsd,0);
  }finally{f.cleanup();}
});

test('a cancelled long is not chased once its fresh IOC would lose the actual short fill advantage',async()=>{
  const f=fixture({longFills:[0,0,100]});try{
    const refresh=f.execution.context.refreshSnapshots!;
    f.execution.context.refreshSnapshots=async(base,exchanges)=>{
      await refresh(base,exchanges);
      if(f.sent.filter(order=>order.exchange==='gate'&&!order.request.reduceOnly).length>=2)
        f.quotes.get('gate')!.asks=[{price:.5081,quantity:1000}];
    };
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'closed');assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);
    assert.deepEqual(f.sent.map(order=>[order.exchange,order.request.quantity,order.request.reduceOnly]),[
      ['bybit',190,false],['gate',100,false],['gate',100,false],['bybit',106,true],
    ]);
  }finally{f.cleanup();}
});

test('unknown status on a long retry freezes that coin without another buy or a speculative unwind',async()=>{
  const f=fixture({longFills:[0],unknownLongAttempt:2});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'attention');assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,106);
    assert.equal(f.sent.length,3);assert.ok(f.sent.every(order=>!order.request.reduceOnly));
    assert.equal(f.p.closeRequestedAt,undefined);
    assert.equal(f.store.data.orders.filter(order=>order.result?.status==='unknown').length,1);
  }finally{f.cleanup();}
});

test('three confirmed zero long fills unwind only the known short without a fourth buy',async()=>{
  const f=fixture({longFills:[0,0,0]});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'closed');assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);
    assert.deepEqual(f.sent.map(order=>[order.exchange,order.request.quantity,order.request.reduceOnly]),[
      ['bybit',190,false],['gate',100,false],['gate',100,false],['gate',100,false],['bybit',106,true],
    ]);
    assert.equal(f.store.data.orders.filter(order=>order.result?.filledQuantity).length,2,'only short open and short reduction traded');
    assert.ok(f.p.feesUsd>0,'protecting a filled short can still incur the two actual fees');
    assert.match(f.p.closeReason??'',/本批补多次数已到/);
  }finally{f.cleanup();}
});

test('a known zero long is never repeated against a cached book when no refresh transport exists',async()=>{
  const f=fixture({longFills:[0,100]});try{
    f.execution.context.refreshSnapshots=undefined;
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'closed');assert.equal(f.p.short.quantity,0);
    assert.equal(f.sent.filter(order=>order.exchange==='gate').length,1);
    assert.deepEqual(f.sent.filter(order=>order.request.reduceOnly).map(order=>[order.exchange,order.request.quantity]),[['bybit',106]]);
  }finally{f.cleanup();}
});

test('a funding reversal after the short fill prevents sending the still-unsent long',async()=>{
  const f=fixture();try{
    const refresh=f.execution.context.refreshSnapshots!;
    f.execution.context.refreshSnapshots=async(base,exchanges)=>{
      await refresh(base,exchanges);
      if(f.p.short.quantity>0)f.quotes.get('bybit')!.fundingRate=-.0003;
    };
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'closed');assert.equal(f.sent.filter(order=>order.exchange==='gate').length,0);
    assert.deepEqual(f.sent.map(order=>[order.exchange,order.request.quantity,order.request.reduceOnly]),[['bybit',190,false],['bybit',106,true]]);
  }finally{f.cleanup();}
});

test('a book change during long parameter validation cannot submit an obsolete long IOC',async()=>{
  const f=fixture();try{
    f.adapters.get('gate')!.validateOrder=async request=>{
      if(!request.reduceOnly&&f.p.short.quantity>0)f.quotes.get('gate')!.asks=[{price:.509,quantity:1000}];
    };
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'closed');assert.equal(f.sent.filter(order=>order.exchange==='gate').length,0);
    assert.equal(f.sent.filter(order=>order.request.reduceOnly).length,1);
  }finally{f.cleanup();}
});

test('a local save exception after an unknown short retry cannot be labelled as a cancelled zero fill',async()=>{
  const f=fixture({shortFill:0,unknownSupplement:true});try{
    const save=f.store.save.bind(f.store);let failed=false;
    f.store.save=()=>{
      if(!failed&&f.store.data.orders.at(-1)?.result?.status==='unknown'){failed=true;throw new Error('injected local save failure');}
      save();
    };
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(failed,true);assert.equal(f.p.status,'attention');assert.equal(f.p.closedAt,undefined);
    assert.equal(f.sent.length,2);assert.ok(f.sent.every(order=>order.exchange==='bybit'&&!order.request.reduceOnly));
    assert.equal(f.store.data.orders.at(-1)?.result?.status,'unknown');assert.equal(f.halts.length,1);
  }finally{f.cleanup();}
});

test('a local save exception after an unknown long retry cannot trigger another buy or an unwind',async()=>{
  const f=fixture({longFills:[0],unknownLongAttempt:2});try{
    const save=f.store.save.bind(f.store);let failed=false;
    f.store.save=()=>{
      if(!failed&&f.store.data.orders.at(-1)?.result?.status==='unknown'){failed=true;throw new Error('injected local save failure');}
      save();
    };
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(failed,true);assert.equal(f.p.status,'attention');assert.equal(f.p.short.quantity,106);
    assert.equal(f.p.long.quantity,0);assert.equal(f.sent.length,3);assert.ok(f.sent.every(order=>!order.request.reduceOnly));
    assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.halts.length,1);
  }finally{f.cleanup();}
});

test('an unknown trim lower bound that makes both legs equal cannot be classified as open after a save exception',async()=>{
  const f=fixture();try{
    const adapter=f.adapters.get('bybit')!,place=adapter.placeOrder.bind(adapter);
    adapter.placeOrder=async request=>{
      const result=await place(request);
      return request.reduceOnly?{...result,status:'unknown'}:result;
    };
    adapter.reconcileOrder=async request=>({id:request.clientOrderId,clientOrderId:request.clientOrderId,status:'unknown',
      filledQuantity:request.quantity,averagePrice:request.limitPrice,feeUsd:request.quantity*request.limitPrice*f.store.data.config.takerFees.bybit,timestamp:Date.now()});
    const save=f.store.save.bind(f.store);let failed=false;
    f.store.save=()=>{
      if(!failed&&f.store.data.orders.at(-1)?.result?.status==='unknown'){failed=true;throw new Error('injected trim save failure');}
      save();
    };
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(failed,true);assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
    assert.equal(f.p.status,'attention');assert.equal(f.sent.length,3);assert.equal(f.p.closeRequestedAt,undefined);
    assert.equal(f.store.data.orders.at(-1)?.result?.status,'unknown');assert.equal(f.halts.length,1);
  }finally{f.cleanup();}
});
