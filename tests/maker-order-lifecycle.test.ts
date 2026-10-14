import test from 'node:test';
import assert from 'node:assert/strict';
import {settleNativeMakerOrder,NATIVE_MAKER_WAIT_MS} from '../src/adapters/maker-order-lifecycle.js';
import {unknownOrder} from '../src/adapters/normalization.js';
import type {OrderRequest,OrderResult} from '../src/shared/types.js';

const request:OrderRequest={clientOrderId:'offline-maker-lifecycle',base:'BTC',symbol:'BTC/USDT:USDT',side:'buy',
  quantity:1,limitPrice:100,reduceOnly:false,postOnly:true};
const prior=unknownOrder(request);
function result(patch:Partial<OrderResult>={}):OrderResult{return {id:'native-maker-1',clientOrderId:request.clientOrderId,status:'unknown',
  filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:1,...patch};}
function clock(){let at=1000;return {now:()=>at,wait:async(ms:number)=>{at+=ms;},elapsed:()=>at-1000};}

test('Maker observed partial is cancelled by exact ID and only terminal verified partial reaches the hedger',async()=>{
  const calls:string[]=[];let cancelled=false;const c=clock();
  const value=await settleNativeMakerOrder(request,prior,'native-maker-1',{
    inspect:async()=>{calls.push(cancelled?'inspect-final':'inspect-open');return result({status:cancelled?'partial':'unknown',filledQuantity:.4,averagePrice:99.9,feeUsd:-.002});},
    cancel:async(id)=>{assert.equal(id,'native-maker-1');calls.push('cancel');cancelled=true;},
  },c);
  assert.equal(value.status,'partial');assert.equal(value.filledQuantity,.4);assert.equal(value.feeUsd,-.002);
  assert.deepEqual(calls,['inspect-open','cancel','inspect-final']);assert.equal(c.elapsed(),0);
});

test('Maker no-fill waits at most 350ms then confirms cancellation and never reports an active order as cancelled',async()=>{
  let cancelled=false;const c=clock();
  const value=await settleNativeMakerOrder(request,prior,'native-maker-1',{
    inspect:async()=>result({status:cancelled?'cancelled':'unknown'}),cancel:async()=>{cancelled=true;},
  },c);
  assert.equal(c.elapsed(),NATIVE_MAKER_WAIT_MS);assert.equal(value.status,'cancelled');assert.equal(value.filledQuantity,0);
  const unconfirmed=await settleNativeMakerOrder(request,prior,'native-maker-1',{
    inspect:async()=>result({filledQuantity:.2,averagePrice:100,feeUsd:.004}),cancel:async()=>{},
  },clock());
  assert.equal(unconfirmed.status,'unknown');assert.equal(unconfirmed.filledQuantity,.2);
});

test('Maker can fill while cancellation is in flight, and complete final cumulative fills are retained',async()=>{
  let cancelled=false;const value=await settleNativeMakerOrder(request,prior,'native-maker-1',{
    inspect:async()=>result({status:cancelled?'filled':'unknown',filledQuantity:cancelled?1:.2,averagePrice:100,feeUsd:cancelled?.02:.004}),
    cancel:async()=>{cancelled=true;throw new Error('offline already filled');},
  },clock());
  assert.equal(value.status,'filled');assert.equal(value.filledQuantity,1);assert.equal(value.feeUsd,.02);
});

test('unknown or mismatched cancellation readback preserves highest fill and cannot manufacture terminal Maker fees',async()=>{
  for(const final of [result({status:'partial',filledQuantity:.3,averagePrice:100,feeUsd:NaN}),
    result({status:'cancelled',filledQuantity:0}),result({id:'other-native-id',status:'filled',filledQuantity:1,averagePrice:100,feeUsd:.02})]){
    let cancelled=false;const value=await settleNativeMakerOrder(request,prior,'native-maker-1',{
      inspect:async()=>cancelled?final:result({filledQuantity:.3,averagePrice:100,feeUsd:.006}),cancel:async()=>{cancelled=true;},
    },clock());
    assert.equal(value.status,'unknown');assert.equal(value.filledQuantity,.3);assert.equal(value.id,'native-maker-1');
  }
});

test('Maker without acknowledged ID never issues cancellation and a lost inspection still cancels only the known ID',async()=>{
  let reads=0,cancels=0;
  const native={inspect:async()=>{reads++;throw new Error('offline unknown');},cancel:async(id:string)=>{assert.equal(id,'native-maker-1');cancels++;}};
  assert.equal((await settleNativeMakerOrder(request,prior,undefined,native,clock())).status,'unknown');assert.equal(reads,0);assert.equal(cancels,0);
  const value=await settleNativeMakerOrder(request,prior,'native-maker-1',native,clock());
  assert.equal(value.status,'unknown');assert.equal(cancels,1);assert.equal(reads,2);
});

test('already verified terminal Maker fill does not send an unnecessary cancellation',async()=>{
  let cancels=0;const value=await settleNativeMakerOrder(request,prior,'native-maker-1',{
    inspect:async()=>result({status:'filled',filledQuantity:1,averagePrice:100,feeUsd:.02}),cancel:async()=>{cancels++;},
  },clock());
  assert.equal(value.status,'filled');assert.equal(cancels,0);
});

test('a hung Maker inspection cannot keep an acknowledged order waiting past the observation budget',{timeout:2000},async()=>{
  let reads=0,cancels=0;const value=await settleNativeMakerOrder(request,prior,'native-maker-1',{
    inspect:()=>{reads++;return reads===1?new Promise<OrderResult>(()=>{}):Promise.resolve(result({status:'cancelled'}));},
    cancel:async(id)=>{assert.equal(id,'native-maker-1');cancels++;},
  });
  assert.equal(value.status,'cancelled');assert.equal(reads,2);assert.equal(cancels,1);
});
