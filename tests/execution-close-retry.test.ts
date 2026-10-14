import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store.js';
import { Execution, UncertainOrderError } from '../src/core/execution.js';
import { defaultConfig } from './legacy-config.js';
import type { ExchangeAdapter, ExchangeId, MarketSnapshot, OrderRequest, OrderResult, Position } from '../src/shared/types.js';

function setup(){
  const root=path.resolve(tmpdir()),dir=mkdtempSync(path.join(root,'funding-close-mock-'));
  const store=new Store(path.join(dir,'state.json'),{...defaultConfig,mode:'live',dataSource:'public',feeOnly:true,maxOrderRetries:1});
  const quotes=new Map<ExchangeId,MarketSnapshot>();
  for(const exchange of ['gate','bybit'] as const)quotes.set(exchange,{exchange,base:'ARK',symbol:'ARK/USDT:USDT',timestamp:Date.now(),
    markPrice:.317,indexPrice:.317,fundingRate:.001,nextFundingTime:Date.now()+60_000,intervalHours:8,fundingHistory:[],
    bids:[{price:.3178,quantity:1000}],asks:[{price:.31648,quantity:1000}],openInterestUsd:1e7,volume24hUsd:1e8,
    quantityStep:1,minQuantity:1,minNotional:5,contractSize:1,source:'public',
    takerFeeRate:store.data.config.takerFees[exchange],takerFeeAt:Date.now(),takerFeeSource:'exchange'});
  const p:Position={id:'ark-close-mocked',base:'ARK',mode:'live',status:'open',feeOnly:true,
    long:{exchange:'gate',symbol:'ARK/USDT:USDT',side:'long',quantity:317,entryPrice:.318,markPrice:.317,feesUsd:0,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'ARK/USDT:USDT',side:'short',quantity:317,entryPrice:.318,markPrice:.317,feesUsd:0,liquidationDistancePct:null},
    openedAt:Date.now(),plannedExitAt:Date.now()+60_000,holdMode:'once',fundingUsd:0,feesUsd:0,transferCostUsd:0,
    spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  store.data.positions.push(p);
  const requests:Array<{exchange:ExchangeId;request:OrderRequest}>=[],refreshes:string[][]=[];
  let halted=false;
  const result=(request:OrderRequest,filled=request.quantity,status:OrderResult['status']='filled'):OrderResult=>({
    id:request.clientOrderId,clientOrderId:request.clientOrderId,status,filledQuantity:filled,
    averagePrice:filled?request.limitPrice:0,feeUsd:filled*.0005*request.limitPrice,timestamp:Date.now()});
  const adapters=new Map<ExchangeId,ExchangeAdapter>();
  for(const exchange of ['gate','bybit'] as const)adapters.set(exchange,{
    validateOrder:async()=>{},
    placeOrder:async(request:OrderRequest)=>{requests.push({exchange,request});return result(request);},
    reconcileOrder:async()=>{throw new Error('unexpected reconciliation');},
  } as unknown as ExchangeAdapter);
  const execution=new Execution(store,{config:()=>store.data.config,snapshot:exchange=>quotes.get(exchange as ExchangeId),
    adapter:exchange=>adapters.get(exchange as ExchangeId)!,liveUnlocked:()=>true,
    refreshSnapshots:async(_base,exchanges)=>{refreshes.push(exchanges);for(const exchange of exchanges)quotes.get(exchange as ExchangeId)!.timestamp=Date.now();},
    halt:()=>{halted=true;store.data.killSwitch=true;}});
  return {store,p,quotes,requests,refreshes,adapters,execution,result,halted:()=>halted,cleanup:()=>{
    const resolved=path.resolve(dir),relative=path.relative(root,resolved);
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(resolved).startsWith('funding-close-mock-'));
    rmSync(resolved,{recursive:true,force:true});
  }};
}

test('ARK close: Gate fills and Bybit cancels zero; next IOC uses a new Bybit book and only its residual',async()=>{
  const s=setup();try{
    const refresh=s.execution.context.refreshSnapshots!;
    s.execution.context.refreshSnapshots=async(base,exchanges)=>{
      await refresh(base,exchanges);
      if(s.refreshes.length===2)s.quotes.get('bybit')!.asks=[{price:.379,quantity:100},{price:.38,quantity:217},{price:1,quantity:1000}];
    };
    let bybitSubmits=0;
    s.adapters.get('bybit')!.placeOrder=async request=>{
      s.requests.push({exchange:'bybit',request});
      if(++bybitSubmits===1)return {...s.result(request,0,'cancelled'),rejectionReason:'IOC 无可立即成交数量',rejectionCode:'EC_NoImmediateQtyToFill'};
      return s.result(request);
    };
    await s.execution.close(s.p,'confirmed close request');
    assert.equal(s.p.status,'closed');assert.equal(s.p.long.quantity,0);assert.equal(s.p.short.quantity,0);
    assert.deepEqual(s.refreshes,[['gate','bybit'],['bybit']]);
    assert.equal(s.requests.filter(x=>x.exchange==='gate').length,1);
    const bybit=s.requests.filter(x=>x.exchange==='bybit').map(x=>x.request);
    assert.deepEqual(bybit.map(r=>[r.quantity,r.limitPrice]),[[317,.31648],[317,.38]]);
    assert.notEqual(bybit[0].clientOrderId,bybit[1].clientOrderId);
    assert.ok(s.requests.every(x=>x.request.reduceOnly));
    assert.ok(s.p.closeRequestedAt&&s.p.closeAttemptedAt);
    assert.ok(s.p.realizedSpreadPnlUsd<-19,'real price loss remains booked');
    assert.ok(s.p.feesUsd>0,'actual fill fees remain booked');
    assert.equal(s.halted(),false);
    assert.ok(s.store.data.logs.some(l=>l.message.includes('EC_NoImmediateQtyToFill')));
  }finally{s.cleanup();}
});

test('confirmed partial reductions are depth bounded and a later close round resumes only the residual',async()=>{
  const s=setup();try{
    s.p.long.quantity=0;
    const refresh=s.execution.context.refreshSnapshots!;
    s.execution.context.refreshSnapshots=async(base,exchanges)=>{
      await refresh(base,exchanges);
      s.quotes.get('bybit')!.asks=[{price:.32+s.refreshes.length/100,quantity:s.refreshes.length===1?100:s.refreshes.length===2?90:1000}];
    };
    s.adapters.get('bybit')!.placeOrder=async request=>{
      s.requests.push({exchange:'bybit',request});
      return s.requests.length===1?s.result(request,40,'partial'):s.result(request);
    };
    await s.execution.close(s.p,'close residual');
    assert.equal(s.p.status,'attention');assert.equal(s.p.short.quantity,187);assert.equal(s.halted(),true);
    assert.deepEqual(s.requests.map(x=>x.request.quantity),[100,90]);
    assert.ok(s.p.closeRequestedAt);
    const requestedAt=s.p.closeRequestedAt;
    await s.execution.close(s.p,'continue original close');
    assert.equal(s.p.status,'closed');assert.equal(s.p.short.quantity,0);
    assert.deepEqual(s.requests.map(x=>x.request.quantity),[100,90,187]);
    assert.equal(s.p.closeRequestedAt,requestedAt);
  }finally{s.cleanup();}
});

test('unknown partial close is never retried until the original order is terminally reconciled',async()=>{
  const s=setup();try{
    let resolved=false;
    s.adapters.get('bybit')!.placeOrder=async request=>{
      s.requests.push({exchange:'bybit',request});return s.result(request,40,'unknown');
    };
    s.adapters.get('bybit')!.reconcileOrder=async request=>s.result(request,40,resolved?'partial':'unknown');
    await s.execution.close(s.p,'close with pending IOC');
    assert.equal(s.p.long.quantity,0);assert.equal(s.p.short.quantity,277);assert.equal(s.p.status,'attention');
    assert.equal(s.requests.length,2);assert.equal(s.refreshes.length,1);
    assert.ok(s.p.closeRequestedAt);
    await assert.rejects(()=>s.execution.close(s.p,'repeat close'),UncertainOrderError);
    assert.equal(s.requests.length,2);assert.equal(s.refreshes.length,1);
    resolved=true;await s.execution.reconcilePending();
    s.adapters.get('bybit')!.placeOrder=async request=>{s.requests.push({exchange:'bybit',request});return s.result(request);};
    s.quotes.get('bybit')!.asks=[{price:.4,quantity:1000}];
    await s.execution.close(s.p,'reconciled residual');
    assert.equal(s.p.status,'closed');assert.equal(s.requests.length,3);
    assert.equal(s.requests[2].request.quantity,277);assert.equal(s.requests[2].request.limitPrice,.4);
  }finally{s.cleanup();}
});

test('a failed new quote never reuses an earlier IOC price or sends either leg of that round',async()=>{
  const s=setup();try{
    s.adapters.get('bybit')!.placeOrder=async request=>{s.requests.push({exchange:'bybit',request});return s.result(request,0,'cancelled');};
    const refresh=s.execution.context.refreshSnapshots!;
    s.execution.context.refreshSnapshots=async(base,exchanges)=>{if(s.refreshes.length===1)throw new Error('fresh book unavailable');await refresh(base,exchanges);};
    await s.execution.close(s.p,'close retry');
    assert.equal(s.p.status,'attention');assert.equal(s.p.long.quantity,0);assert.equal(s.p.short.quantity,317);
    assert.equal(s.requests.length,2);assert.equal(s.refreshes.length,1);assert.ok(s.p.closeRequestedAt);
  }finally{s.cleanup();}
});

test('both entry requests must pass venue parameter validation before either leg submits',async()=>{
  const s=setup();try{
    s.p.long.quantity=0;s.p.short.quantity=0;s.p.status='opening';
    let validated=0;
    s.adapters.get('gate')!.validateOrder=async()=>{validated++;};
    s.adapters.get('bybit')!.validateOrder=async()=>{validated++;throw new Error('invalid quantity precision');};
    await assert.rejects(()=>s.execution.open(s.p,317,317),/invalid quantity precision/);
    assert.equal(validated,2);assert.equal(s.requests.length,0);assert.equal(s.store.data.orders.length,0);
    assert.equal(s.p.long.quantity,0);assert.equal(s.p.short.quantity,0);
  }finally{s.cleanup();}
});

test('both reduce-only requests validate before concurrent submission and a bad leg cannot orphan the other',async()=>{
  const s=setup();try{
    s.adapters.get('bybit')!.validateOrder=async()=>{throw new Error('invalid reduce quantity');};
    await s.execution.close(s.p,'precheck fails');
    assert.equal(s.requests.length,0);assert.equal(s.store.data.orders.length,0);
    assert.equal(s.p.long.quantity,317);assert.equal(s.p.short.quantity,317);assert.equal(s.p.status,'attention');
    assert.ok(s.p.closeRequestedAt);
  }finally{s.cleanup();}
});

test('both close legs are submitted concurrently after all validation completes',async()=>{
  const s=setup();try{
    const pending:Array<{request:OrderRequest;resolve:(r:OrderResult)=>void}>=[];
    let validated=0;
    for(const exchange of ['gate','bybit'] as const){
      s.adapters.get(exchange)!.validateOrder=async()=>{validated++;};
      s.adapters.get(exchange)!.placeOrder=async request=>{
        assert.equal(validated,2);s.requests.push({exchange,request});
        return new Promise<OrderResult>(resolve=>{pending.push({request,resolve});if(pending.length===2)for(const item of pending)item.resolve(s.result(item.request));});
      };
    }
    await s.execution.close(s.p,'concurrent close');
    assert.equal(s.requests.length,2);assert.equal(s.p.status,'closed');
  }finally{s.cleanup();}
});

test('scoped reconciliation queries only the requested position and never submits new orders',async()=>{
  const s=setup();try{
    const other:Position={...s.p,id:'other-position',long:{...s.p.long},short:{...s.p.short}};
    s.store.data.positions.push(other);
    for(const p of [s.p,other]){
      const request:OrderRequest={clientOrderId:`pending-${p.id}`,base:p.base,symbol:p.short.symbol,side:'buy',quantity:317,limitPrice:.32,reduceOnly:true};
      s.store.data.orders.push({positionId:p.id,exchange:'bybit',request,result:s.result(request,0,'unknown'),createdAt:Date.now()});
    }
    const queried:string[]=[];
    s.adapters.get('bybit')!.reconcileOrder=async request=>{queried.push(request.clientOrderId);return s.result(request,0,'cancelled');};
    await s.execution.reconcilePending(s.p.id);
    assert.deepEqual(queried,[`pending-${s.p.id}`]);
    assert.equal(s.store.data.orders[0].result!.status,'cancelled');assert.equal(s.store.data.orders[1].result!.status,'unknown');
    assert.equal(s.requests.length,0);
    await s.execution.reconcilePending();assert.deepEqual(queried,[`pending-${s.p.id}`,`pending-${other.id}`]);
    assert.equal(s.requests.length,0);
  }finally{s.cleanup();}
});

test('an execution context without a quote transport cannot repeat a cancelled close against its cache',async()=>{
  const s=setup();try{
    s.execution.context.refreshSnapshots=undefined;s.p.long.quantity=0;
    s.adapters.get('bybit')!.placeOrder=async request=>{s.requests.push({exchange:'bybit',request});return s.result(request,0,'cancelled');};
    await s.execution.close(s.p,'close without quote transport');
    assert.equal(s.requests.length,1);assert.equal(s.p.short.quantity,317);assert.equal(s.p.status,'attention');
  }finally{s.cleanup();}
});

test('an unknown close with a full fill lower bound stays unresolved even when local quantities reach zero',async()=>{
  for(const saveFault of [false,true]){
    const s=setup();try{
      s.adapters.get('bybit')!.placeOrder=async request=>{s.requests.push({exchange:'bybit',request});return s.result(request,request.quantity,'unknown');};
      s.adapters.get('bybit')!.reconcileOrder=async request=>s.result(request,request.quantity,'unknown');
      const save=s.store.save.bind(s.store);let failed=false;
      s.store.save=()=>{
        if(saveFault&&!failed&&s.store.data.orders.some(order=>order.result?.status==='unknown')){failed=true;throw new Error('injected full close save failure');}
        save();
      };
      await s.execution.close(s.p,'unknown full lower bound');
      assert.equal(s.p.long.quantity,0);assert.equal(s.p.short.quantity,0);
      assert.equal(s.p.status,'attention');assert.equal(s.p.closedAt,undefined);
      assert.equal(s.requests.length,2);assert.equal(s.refreshes.length,1);
      assert.equal(s.store.data.orders.filter(order=>order.result?.status==='unknown').length,1);
      assert.equal(failed,saveFault);assert.equal(s.halted(),true);
      await assert.rejects(()=>s.execution.close(s.p,'do not misclassify unknown as flat'),UncertainOrderError);
      assert.equal(s.requests.length,2);
    }finally{s.cleanup();}
  }
});

test('a save failure after an unknown partial close cannot submit the apparent residual under a new order id',async()=>{
  const s=setup();try{
    s.adapters.get('bybit')!.placeOrder=async request=>{s.requests.push({exchange:'bybit',request});return s.result(request,40,'unknown');};
    s.adapters.get('bybit')!.reconcileOrder=async request=>s.result(request,40,'unknown');
    const save=s.store.save.bind(s.store);let failed=false;
    s.store.save=()=>{
      if(!failed&&s.store.data.orders.some(order=>order.result?.status==='unknown')){failed=true;throw new Error('injected partial close save failure');}
      save();
    };
    await s.execution.close(s.p,'unknown partial save failure');
    assert.equal(failed,true);assert.equal(s.p.long.quantity,0);assert.equal(s.p.short.quantity,277);
    assert.equal(s.p.status,'attention');assert.equal(s.requests.length,2);assert.equal(s.refreshes.length,1);
    assert.equal(s.store.data.orders.filter(order=>order.result?.status==='unknown').length,1);
    assert.equal(s.p.closedAt,undefined);
  }finally{s.cleanup();}
});
