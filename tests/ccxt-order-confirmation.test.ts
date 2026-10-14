import test from 'node:test';
import assert from 'node:assert/strict';
import ccxt from 'ccxt';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {defaultConfig} from '../src/shared/config.js';
import {exchangeClientId} from '../src/adapters/normalization.js';
import type {ExchangeId,OrderRequest} from '../src/shared/types.js';

const market={id:'CTUSDT',symbol:'CT/USDT:USDT',base:'CT',quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,
  contractSize:1,precision:{amount:1,price:.01},limits:{amount:{min:1},cost:{min:1}}};
const request:OrderRequest={clientOrderId:'offline-confirmation',base:'CT',symbol:market.symbol,side:'buy',quantity:10,limitPrice:11,reduceOnly:true};
function fixture(id:ExchangeId='binance'){
  let creates=0,cancels=0,reads=0;
  const raw=(changes:any={})=>({id:'native-created',clientOrderId:exchangeClientId(id,request.clientOrderId),symbol:market.symbol,
    type:'limit',side:'buy',amount:10,status:'canceled',filled:4,average:10,fee:{currency:'USDT',cost:.02},timestamp:Date.now(),...changes});
  const client:any={apiKey:'synthetic-key',secret:'synthetic-secret',password:'synthetic-passphrase',precisionMode:4,has:{fetchMyTrades:false},
    markets:{[market.symbol]:market},loadMarkets:async()=>({[market.symbol]:market}),market:()=>market,
    fetchPositions:async()=>[{symbol:market.symbol,contracts:10,side:'short',info:{mgnMode:'isolated',posSide:'net'}}],
    amountToPrecision:(_symbol:string,value:number)=>String(value),priceToPrecision:(_symbol:string,value:number)=>value.toFixed(2),
    createOrder:async()=>{creates++;return raw();},fetchOrder:async()=>{reads++;return raw();},cancelOrder:async()=>{cancels++;}};
  const adapter=new CcxtAdapter(id,{...defaultConfig,mode:'live',dataSource:'public'},client);
  return {adapter,client,raw,creates:()=>creates,cancels:()=>cancels,reads:()=>reads};
}

test('legal decimal reductions retain their contract count without accepting off-step quantities',async()=>{
  const f=fixture(),fractional={...market,contractSize:.1};const converted:string[]=[];
  f.client.market=()=>fractional;f.client.markets={[market.symbol]:fractional};
  f.client.amountToPrecision=(_symbol:string,value:number|string)=>{
    const result=ccxt.decimalToPrecision(value,ccxt.TRUNCATE,1,ccxt.TICK_SIZE);
    converted.push(result);return result;
  };
  try{
    for(const quantity of [.6,.7,.6000000000000001]){
      const req={...request,quantity};await f.adapter.validateOrder(req);
      assert.equal(req.quantity,quantity,'the original quantity remains unchanged');
    }
    assert.deepEqual(converted,['6','7','6']);
    for(const quantity of [.65,.59])await assert.rejects(f.adapter.validateOrder({...request,quantity}),/lot size/);
    assert.equal(f.creates(),0);assert.equal(f.reads(),0);
  }finally{await f.adapter.close();}
});

test('Binance/OKX incomplete or impossible cumulative fills remain unknown and duplicate calls never resend',async()=>{
  for(const id of ['binance','okx'] as const)for(const filled of [undefined,null,'',false,NaN,Infinity,-1,11]){
    const f=fixture(id);try{
      const create=f.client.createOrder;
      f.client.createOrder=async()=>{await create();return f.raw({filled});};f.client.fetchOrder=async()=>f.raw({filled});
      const first=await f.adapter.placeOrder(request),second=await f.adapter.placeOrder(request);
      assert.equal(first.status,'unknown');assert.equal(second.status,'unknown');assert.equal(first.filledQuantity,0);
      assert.equal(f.creates(),1,'one original creation request is retained without resubmission');
    }finally{await f.adapter.close();}
  }
});

test('pre-submit metadata and preparation failures prove no send only for a new client ID',async()=>{
  for(const kind of ['metadata','preparation','credentials'] as const){
    const f=fixture();try{
      const req=kind==='preparation'?{...request,reduceOnly:false}:request;
      if(kind==='metadata')f.client.loadMarkets=async()=>{throw Object.assign(new Error('private-preflight-canary'),{apiCode:'-2010'});};
      if(kind==='credentials')f.client.apiKey=undefined;
      const result=await f.adapter.placeOrder(req);
      assert.equal(result.status,'cancelled');assert.equal(result.rejectionCode,'PRE_SUBMISSION_CHECK_FAILED');
      assert.equal(result.filledQuantity,0);assert.equal(result.id,'');assert.equal(f.creates(),0);assert.equal(f.reads(),0);
      assert.deepEqual(result.confirmation,{stage:'pre-submit',reason:'pre-submit-failed',...(kind==='metadata'?{apiCode:'-2010'}:{})});
      assert.ok(!JSON.stringify(result).includes('private-preflight-canary'));
      assert.deepEqual(await f.adapter.placeOrder(req),result);assert.equal(f.creates(),0);
    }finally{await f.adapter.close();}
  }
});

test('a concurrent original submission wins over another same-ID metadata failure',async()=>{
  const f=fixture();let rejectFirst!:(error:Error)=>void,loads=0;
  try{
    f.client.loadMarkets=async()=>{if(++loads===1)return new Promise((_,reject)=>{rejectFirst=reject;});return f.client.markets;};
    const first=f.adapter.placeOrder(request);await Promise.resolve();
    const submitted=await f.adapter.placeOrder(request);assert.equal(submitted.status,'partial');assert.equal(f.creates(),1);
    rejectFirst(new Error('private-concurrent-canary'));
    assert.deepEqual(await first,submitted);assert.equal(f.creates(),1);
  }finally{await f.adapter.close();}
});

test('an existing unknown original cannot become a no-send refusal when metadata later fails',async()=>{
  const f=fixture();try{
    const create=f.client.createOrder;
    f.client.createOrder=async()=>({...await create(),id:'original-ack',filled:undefined});
    f.client.fetchOrder=async()=>f.raw({id:'original-ack',filled:undefined});
    const original=await f.adapter.placeOrder(request);assert.equal(original.status,'unknown');assert.equal(original.id,'original-ack');
    f.client.loadMarkets=async()=>{throw new Error('private-retry-canary');};
    const retained=await f.adapter.placeOrder(request);
    assert.equal(retained.status,'unknown');assert.equal(retained.id,'original-ack');assert.equal(retained.rejectionCode,undefined);
    assert.ok(original.confirmation,'the original unknown result retains its safe diagnostic');
    assert.deepEqual(retained.confirmation,{stage:'order-read',reason:'request-failed'},'latest failed read is distinct from the initial receipt diagnostic');
    assert.deepEqual(original.confirmation,{stage:'receipt',reason:'request-failed'},'the previously returned original diagnostic is not mutated');
    assert.ok(!JSON.stringify(retained).includes('private-retry-canary'));
    assert.equal(f.creates(),1);
  }finally{await f.adapter.close();}
});

test('an explicit generic zero-fill terminal cancellation remains a valid zero-fee receipt',async()=>{
  const f=fixture();try{
    f.client.createOrder=async()=>f.raw({filled:0,average:undefined,fee:undefined});
    const result=await f.adapter.placeOrder(request);assert.equal(result.status,'cancelled');assert.equal(result.filledQuantity,0);assert.equal(result.feeUsd,0);
  }finally{await f.adapter.close();}
});

test('a generic create ACK without execution fields keeps its exact native ID for the follow-up GET',async()=>{
  const f=fixture();let followed=false;try{
    f.client.createOrder=async()=>({id:'native-created'});
    f.client.fetchOrder=async(id:string)=>{assert.equal(id,'native-created');followed=true;return f.raw();};
    const result=await f.adapter.placeOrder(request);
    assert.equal(followed,true);assert.equal(result.status,'partial');assert.equal(result.id,'native-created');assert.equal(result.filledQuantity,4);
  }finally{await f.adapter.close();}
});

test('generic original-ID REST confirmation rejects another native ID or contradictory order facts without cancellation',async()=>{
  const mutations=[{id:'another-native-order'},{clientOrderId:'another-client-id'},{symbol:'OTHER/USDT:USDT'},
    {side:'sell'},{type:'market'},{amount:11},{amount:'malformed'},{average:12}];
  for(const id of ['binance','okx'] as const)for(const changed of mutations){
    const f=fixture(id);try{
      f.client.fetchOrder=async()=>f.raw(changed);
      const result=await f.adapter.reconcileOrder(request,'native-created');
      assert.equal(result.status,'unknown');assert.equal(result.filledQuantity,0);assert.equal(f.cancels(),0);
    }finally{await f.adapter.close();}
  }
});

test('generic cancellation readback cannot regress the confirmed quantity or change the native order ID',async()=>{
  for(const changed of [{filled:2},{id:'another-native-order'}]){
    const f=fixture();let read=0;try{
      f.client.fetchOrder=async()=>++read===1?f.raw({status:'open'}):f.raw(changed);
      const result=await f.adapter.reconcileOrder(request,'native-created');
      assert.equal(f.cancels(),1);assert.equal(result.status,'unknown');assert.equal(result.id,'native-created');assert.equal(result.filledQuantity,4);
      assert.equal(result.feeUsd,.02,'the already observed cash fee is retained without confirming the contradictory readback');
    }finally{await f.adapter.close();}
  }
});

test('generic fee fallback deduplicates identified fills and requires exact coverage with every cash fee known',async()=>{
  const trade=(id:string,amount:number,fee:number|null=.01)=>({id,order:'native-created',symbol:market.symbol,side:'buy',amount,price:10,
    ...(fee===null?{}:{fee:{currency:'USDT',cost:fee}})});
  const one=trade('fill-one',2),two=trade('fill-two',2);
  const cases=[
    {rows:[one,two],expected:.02},
    {rows:[one,two,one],expected:.02},
    {rows:[one,trade('fill-two',2,null)],expected:null},
    {rows:[one,two,trade('extra-fill',1)],expected:null},
    {rows:[one,{...two,id:undefined}],expected:null},
    {rows:[one,{...two,side:'sell'}],expected:null},
    {rows:[one,two,{...one,fee:{currency:'USDT',cost:.05}}],expected:null},
  ];
  for(const sample of cases){const f=fixture();try{
    f.client.has.fetchMyTrades=true;f.client.fetchMyTrades=async()=>sample.rows;
    f.client.createOrder=async()=>f.raw({fee:undefined});f.client.fetchOrder=async()=>f.raw({fee:undefined});
    const result=await f.adapter.placeOrder(request);
    assert.equal(result.status,sample.expected===null?'unknown':'partial');
    if(sample.expected!==null)assert.equal(result.feeUsd,sample.expected);
    else assert.equal(Number.isFinite(result.feeUsd),false);
  }finally{await f.adapter.close();}}
});
