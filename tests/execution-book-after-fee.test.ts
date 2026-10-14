import assert from 'node:assert/strict';
import test from 'node:test';
import {fixture,completeKnownTail,NOW} from './native-exit-read-fixture.js';
import type {OrderRequest,OrderResult} from '../src/shared/types.js';

for(const recovery of ['public','cached','stale','permission','metadata'] as const)
test(`selected IOC book after a slow required fee read: ${recovery}`,async t=>{
  const f=fixture(t);completeKnownTail(f);f.store.data.orders.splice(f.store.data.orders.indexOf(f.unknown),1);
  f.store.data.config.profitExitExecutionMode='ioc';f.p.status='open';
  f.p.profitExitPolicy={firstFundingTime:NOW+3_600_000,earliestExitAt:NOW+3_610_000,minSpreadNetUsd:0,minCombinedNetUsd:0,fundingChecks:[]};
  const originalOrders=structuredClone(f.store.data.orders),posts:OrderRequest[]=[];
  let allCaptured!:()=>void,captured=0,feeReads=0,publicReads=0;
  const publicCaptured=new Promise<void>(resolve=>{allCaptured=resolve;});
  for(const adapter of f.adapters){
    f.quotes.get(adapter.id)!.bookTransport='websocket';let localReads=0;
    adapter.fetchExecutionSnapshots=async()=>{
      publicReads++;localReads++;
      if(localReads>1&&recovery==='public')Object.assign(f.quotes.get(adapter.id)!,{observedAt:Date.now(),timestamp:Date.now()});
      if(localReads>1&&recovery==='permission')f.internal.sessionLivePermission=false;
      const quote=structuredClone(f.quotes.get(adapter.id)!);
      if(recovery==='metadata')quote.fundingObservedAt=NOW-120_000;
      if(++captured===2)allCaptured();return [quote];
    };
    adapter.fetchTradingFee=async()=>{
      feeReads++;await publicCaptured;await new Promise<void>(resolve=>setImmediate(resolve));t.mock.timers.setTime(NOW+2501);
      if(recovery==='cached')Object.assign(f.quotes.get(adapter.id)!,{observedAt:Date.now(),timestamp:Date.now()});
      return {takerFeeRate:.0005,takerFeeSource:'exchange',takerFeeAt:Date.now()};
    };
    adapter.validateOrder=async()=>{};
    adapter.placeOrder=async(request,canSubmit)=>{
      assert.equal(canSubmit?.(),true);posts.push(structuredClone(request));
      f.nativeAccounts.get(adapter.id)!.positions[0].quantity-=request.quantity;
      return {id:`memory-${request.clientOrderId}`,clientOrderId:request.clientOrderId,status:'filled',filledQuantity:request.quantity,
        averagePrice:request.limitPrice,averagePriceVerified:true,feeUsd:request.quantity*request.limitPrice*.0005,timestamp:Date.now()} satisfies OrderResult;
    };
  }
  assert.equal(f.engine.execution.dispatchIocProfitClose(f.p,'memory after fee action',()=>true),true);
  await f.engine.execution.waitIocProfitClose(f.p);
  await new Promise<void>(resolve=>setImmediate(resolve));
  const recovered=recovery==='public'||recovery==='cached';
  assert.equal(feeReads,2,'a public retry cannot renew private fees');
  if(recovery==='permission')assert.ok(publicReads>=3&&publicReads<=4,'revoked authority may stop the other selected leg before retry');
  else assert.equal(publicReads,recovery==='cached'||recovery==='metadata'?2:4);
  if(recovered){
    assert.equal(posts.length,2);assert.equal(f.p.status,'closed');assert.ok(f.reads.length>=4);
    assert.equal(new Set(posts.map(p=>p.clientOrderId)).size,2);
    assert.deepEqual(f.store.data.orders.slice(0,originalOrders.length),originalOrders);
  }else{
    assert.equal(posts.length,0);assert.deepEqual(f.store.data.orders,originalOrders);
    assert.equal(f.p.long.quantity,95);assert.equal(f.p.short.quantity,95);assert.equal(f.reads.length,0);
  }
  assert.equal(f.store.data.killSwitch,false);
});
