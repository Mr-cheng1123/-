import test from 'node:test';
import assert from 'node:assert/strict';
import {BybitPrivate} from '../src/adapters/bybit-private.js';
import {exchangeClientId,unknownOrder} from '../src/adapters/normalization.js';
import {ExchangeNetworkError} from '../src/adapters/network.js';
import {OrderNotSubmittedError} from '../src/adapters/order-rejection.js';
import type {OrderRequest,OrderResult} from '../src/shared/types.js';

const symbol='LAOPU/USDT:USDT';
const request:OrderRequest={clientOrderId:'offline-laopu-original',base:'LAOPU',symbol,side:'buy',quantity:.6,limitPrice:41.84,reduceOnly:false};
function fixture(){
  let reads=0,creates=0,raw:any,readError:unknown,createResponse:any;
  const ok=(result:any)=>({retCode:0,retMsg:'OK',result});
  const market={id:'LAOPUUSDT',symbol,base:'LAOPU',quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,contractSize:1};
  const client:any={apiKey:'offline-api-key-value',secret:'offline-secret-value',password:'offline-passphrase-value',markets:{[symbol]:market},market:()=>market,
    amountToPrecision:(_s:string,n:number)=>String(n),priceToPrecision:(_s:string,n:number)=>String(n),
    privateGetV5AccountInfo:async()=>ok({unifiedMarginStatus:5,marginMode:'REGULAR_MARGIN'}),
    privateGetV5AccountWalletBalance:async()=>ok({list:[{accountType:'UNIFIED',totalEquity:'500',totalAvailableBalance:'500',coin:[{
      coin:'USDT',walletBalance:'500',equity:'500',usdValue:'500',locked:'0',bonus:'0',totalPositionIM:'0',totalOrderIM:'0',borrowAmount:'0',spotBorrow:'0',accruedInterest:'0'}]}]}),
    privateGetV5PositionList:async()=>ok({list:[{symbol:market.id,positionIdx:0,leverage:'2',size:'0',side:''}]}),
    privatePostV5PositionSetLeverage:async()=>{throw new Error('No fixture leverage change is needed');},
    privatePostV5OrderCreate:async()=>{creates++;if(createResponse)return createResponse;throw new Error('bybit {"retCode":110126,"retMsg":"Native order validation detail","result":{}}');},
    privateGetV5OrderRealtime:async(params:any)=>{if(params.openOnly===0)return ok({list:[]});reads++;if(readError)throw readError;return ok({list:raw?[raw]:[]});},
    privateGetV5OrderHistory:async()=>{reads++;if(readError)throw readError;return ok({list:raw?[raw]:[]});},
    privatePostV5OrderCancel:async()=>{throw new Error('Diagnostic observations cannot cancel orders');},
  };
  const adapter=new BybitPrivate(client);
  return {adapter,client,reads:()=>reads,creates:()=>creates,setReadError:(e:unknown)=>{readError=e;},setCreateResponse:(r:any)=>{createResponse=r;},
    setRaw:(r:any)=>{raw=r;}};
}
function view(result:OrderResult):any{return result;}

const agreementMessage='You must sign the required agreement before trading this contract.';

test('Bybit an exact native agreement refusal is a known zero and the same original ID never resubmits',async()=>{
  for(const shape of ['native-response','ccxt-error','api-error','marked-native-error'] as const){
    const f=fixture();await f.adapter.prepare(symbol,2);let posts=0;
    f.client.privatePostV5OrderCreate=async()=>{
      posts++;
      if(shape==='native-response')return {retCode:110126,retMsg:agreementMessage,result:{}};
      if(shape==='ccxt-error')throw new Error(`bybit ${JSON.stringify({retCode:110126,retMsg:agreementMessage,result:{}})}`);
      if(shape==='api-error')throw new ExchangeNetworkError('API_ERROR',0,'110126','bybit',agreementMessage);
      throw Object.assign(new Error('bybit: invalid V5 response'),{apiCode:'110126',apiMessage:agreementMessage});
    };
    let refusal:unknown;
    await assert.rejects(f.adapter.place(request,.6,41.84),error=>{
      refusal=error;assert.ok(error instanceof OrderNotSubmittedError);assert.equal(error.rejectionCode,'110126');
      assert.match(error.rejectionReason,/签署.*协议/);return true;
    });
    const result=await f.adapter.reconcile(request);
    assert.equal(result.status,'cancelled');assert.equal(result.id,'');assert.equal(result.rejectionCode,'110126');
    assert.equal(result.filledQuantity,0);assert.equal(result.averagePrice,0);assert.equal(result.feeUsd,0);
    assert.equal(f.reads(),0,'a known native refusal does not need speculative original-ID queries');
    await assert.rejects(f.adapter.place(request,.6,41.84),error=>error===refusal);
    assert.equal(posts,1,'the rejected original ID is retained, not resubmitted');
  }
});

test('Bybit timeout, network and processing failures carrying the agreement text remain unknown',async()=>{
  for(const kind of ['TIMEOUT','NETWORK_ERROR','ACCESS_DENIED','RequestTimeout','ExchangeNotAvailable','ETIMEDOUT','processing'] as const){
    const f=fixture();await f.adapter.prepare(symbol,2);let posts=0;
    const error=kind==='RequestTimeout'||kind==='ExchangeNotAvailable'
      ?Object.assign(new Error(`bybit ${JSON.stringify({retCode:110126,retMsg:agreementMessage})}`),{name:kind})
      :kind==='ETIMEDOUT'?Object.assign(new Error(`bybit ${JSON.stringify({retCode:110126,retMsg:agreementMessage})}`),{code:'ETIMEDOUT'})
      :kind==='processing'?{code:'PROCESSING',apiCode:'110126',apiMessage:agreementMessage}
      :Object.assign(new ExchangeNetworkError(kind,0,'110126','bybit'),{apiMessage:agreementMessage});
    f.client.privatePostV5OrderCreate=async()=>{posts++;throw error;};
    await assert.rejects(f.adapter.place(request,.6,41.84),actual=>actual===error&&!(actual instanceof OrderNotSubmittedError));
    const result=await f.adapter.reconcile(request);
    assert.equal(result.status,'unknown');assert.equal(result.rejectionCode,undefined);assert.equal(result.filledQuantity,0);
    await f.adapter.place(request,.6,41.84);assert.equal(posts,1,'an unresolved original is not resent');
  }
});

test('Bybit code 110126 without the exact native refusal message does not prove an order was rejected',async()=>{
  for(const message of [undefined,'Required trading agreement wording','Other native validation failure',`${agreementMessage} Processing may continue.`]){
    const f=fixture();await f.adapter.prepare(symbol,2);
    f.setCreateResponse({retCode:110126,...(message===undefined?{}:{retMsg:message}),result:{}});
    await assert.rejects(f.adapter.place(request,.6,41.84),error=>!(error instanceof OrderNotSubmittedError));
    const result=await f.adapter.reconcile(request);assert.equal(result.status,'unknown');assert.equal(result.rejectionCode,undefined);
    assert.equal(result.originalConfirmation?.apiCode,'110126');assert.equal(f.creates(),1);
  }
});

test('Bybit agreement diagnostics on a historical unknown original or GET failure never authorize zero fill',async()=>{
  const f=fixture(),prior={...unknownOrder(request),originalConfirmation:{stage:'create' as const,reason:'request-failed' as const,
    apiCode:'110126',apiMessage:agreementMessage,observedAt:1791524202000}};
  const observed=await f.adapter.reconcile(request,prior);
  assert.equal(observed.status,'unknown');assert.equal(observed.rejectionCode,undefined);assert.deepEqual(observed.originalConfirmation,prior.originalConfirmation);
  f.setReadError(new ExchangeNetworkError('API_ERROR',0,'110126','bybit',agreementMessage));
  const failed=await f.adapter.inspectOrder(request,observed);
  assert.equal(failed.status,'unknown');assert.equal(failed.rejectionCode,undefined);assert.equal(failed.confirmation?.stage,'order-read');
  assert.equal(failed.confirmation?.apiMessage,agreementMessage);assert.equal(f.creates(),0);
});

test('Bybit newly recognized agreement refusals never retroactively classify an already submitted unknown ID',async()=>{
  const f=fixture();await f.adapter.prepare(symbol,2);await assert.rejects(f.adapter.place(request,.6,41.84));
  const prior=await f.adapter.reconcile(request);assert.equal(prior.status,'unknown');
  f.setCreateResponse({retCode:110126,retMsg:agreementMessage,result:{}});
  await f.adapter.place(request,.6,41.84);
  const later=await f.adapter.reconcile(request,prior);
  assert.equal(later.status,'unknown');assert.equal(later.rejectionCode,undefined);assert.equal(f.creates(),1);
  assert.deepEqual(later.originalConfirmation,prior.originalConfirmation);
});

test('Bybit keeps the original undocumented create error separate from the latest not-found observation',async t=>{
  let now=1791524202000;t.mock.method(Date,'now',()=>now);
  const f=fixture();await f.adapter.prepare(symbol,2);
  await assert.rejects(f.adapter.place(request,.6,41.84),/110126/);
  now+=1000;const first=view(await f.adapter.reconcile(request));
  assert.equal(first.status,'unknown');assert.equal(first.rejectionCode,undefined);assert.equal(first.filledQuantity,0);
  assert.equal(first.originalConfirmation.stage,'create');assert.equal(first.originalConfirmation.apiCode,'110126');
  assert.equal(first.originalConfirmation.apiMessage,'Native order validation detail');
  assert.deepEqual(first.confirmation,{stage:'order-read',reason:'not-found',observedAt:now});assert.equal(first.orderReadAt,now);
  const original=structuredClone(first.originalConfirmation);
  now+=15000;const second=view(await f.adapter.inspectOrder(request,first));
  assert.deepEqual(second.originalConfirmation,original);assert.deepEqual(second.confirmation,{stage:'order-read',reason:'not-found',observedAt:now});
  assert.equal(second.orderReadAt,now);assert.equal(f.creates(),1);assert.equal(f.reads(),4);
  await f.adapter.place(request,.6,41.84);assert.equal(f.creates(),1,'the same original ID is never resubmitted');
});

test('Bybit latest query failure is visible without overwriting the create error or financial lower bound',async t=>{
  let now=1791524202000;t.mock.method(Date,'now',()=>now);
  const f=fixture();await f.adapter.prepare(symbol,2);await assert.rejects(f.adapter.place(request,.6,41.84));
  const initial=view(await f.adapter.reconcile(request));
  now+=15000;f.setReadError(new Error('bybit {"retCode":10005,"retMsg":"Query permission missing","result":{}}'));
  const current=view(await f.adapter.inspectOrder(request,initial));
  assert.equal(current.confirmation.stage,'order-read');assert.equal(current.confirmation.reason,'request-failed');assert.equal(current.confirmation.apiCode,'10005');
  assert.equal(current.confirmation.apiMessage,'Query permission missing');assert.equal(current.orderReadAt,now);
  assert.deepEqual(current.originalConfirmation,initial.originalConfirmation);
  assert.equal(current.filledQuantity,initial.filledQuantity);assert.equal(current.feeUsd,initial.feeUsd);assert.equal(f.creates(),1);
});

test('Bybit direct native retCode failures preserve only sanitized and bounded retMsg evidence',async()=>{
  const f=fixture();await f.adapter.prepare(symbol,2);
  f.setCreateResponse({retCode:110126,retMsg:`Validation rejected\napiKey=${f.client.apiKey}; secret=${f.client.secret}; signature=abcdef0123456789; url=https://example.invalid/private?token=opaque ${'x'.repeat(500)}`,result:{}});
  await assert.rejects(f.adapter.place(request,.6,41.84));const result=view(await f.adapter.reconcile(request));
  assert.equal(result.status,'unknown');assert.equal(result.originalConfirmation.apiCode,'110126');
  const message=result.originalConfirmation.apiMessage;assert.equal(typeof message,'string');assert.match(message,/Validation rejected/);
  assert.ok(message.length<=240);assert.ok(!/[\r\n]/.test(message));
  for(const secret of [f.client.apiKey,f.client.secret,'abcdef0123456789','opaque'])assert.ok(!message.includes(secret),secret);
  assert.ok(!message.includes('https://example.invalid'));assert.equal(f.creates(),1);
});

test('Bybit unrelated error text and hostile retMsg getters are not persisted as native API messages',async()=>{
  for(const kind of ['plain','other-venue','getter'] as const){
    const f=fixture();await f.adapter.prepare(symbol,2);let invoked=0;
    const error=kind==='plain'?new Error('private body contains offline-secret-value'):kind==='other-venue'
      ?new Error('okx {"retCode":110126,"retMsg":"foreign private detail","result":{}}')
      :Object.defineProperty({retCode:110126},'retMsg',{get(){invoked++;return 'do not invoke private getter';}});
    f.client.privatePostV5OrderCreate=async()=>{throw error;};await assert.rejects(f.adapter.place(request,.6,41.84));
    const result=view(await f.adapter.reconcile(request));assert.equal(result.originalConfirmation?.apiMessage,undefined);assert.equal(invoked,0);
    assert.ok(!JSON.stringify(result).includes('offline-secret-value'));assert.ok(!JSON.stringify(result).includes('foreign private detail'));
  }
});

test('Bybit native messages redact quoted credential fields and short token aliases',async()=>{
  const f=fixture();await f.adapter.prepare(symbol,2);
  f.setCreateResponse({retCode:110126,retMsg:'Native validation {"apiKey":"shortcanary","api_secret":"keycanary","accessToken":"shorttoken","passphrase":"passcanary"}',result:{}});
  await assert.rejects(f.adapter.place(request,.6,41.84));const result=view(await f.adapter.reconcile(request));
  const message=result.originalConfirmation?.apiMessage;assert.equal(typeof message,'string');assert.match(message,/Native validation/);
  for(const secret of ['shortcanary','keycanary','shorttoken','passcanary'])assert.ok(!message.includes(secret),secret);
});

test('Bybit a valid terminal original query records its read time without stale unknown diagnostics',async t=>{
  let now=1791524202000;t.mock.method(Date,'now',()=>now);
  const f=fixture();await f.adapter.prepare(symbol,2);await assert.rejects(f.adapter.place(request,.6,41.84));
  const prior=view(await f.adapter.reconcile(request));now+=15000;
  f.setRaw({orderId:'original-native-id',orderLinkId:exchangeClientId('bybit',request.clientOrderId),symbol:'LAOPUUSDT',side:'Buy',positionIdx:0,reduceOnly:false,
    orderType:'Limit',timeInForce:'IOC',qty:'.6',price:'41.84',orderStatus:'Filled',cumExecQty:'.6',avgPrice:'41.8',
    cumFeeDetail:{USDT:'.01254'},extraFees:'',updatedTime:String(now-500)});
  const result=view(await f.adapter.inspectOrder(request,prior));
  assert.equal(result.status,'filled');assert.equal(result.filledQuantity,.6);assert.equal(result.feeUsd,.01254);
  assert.equal(result.confirmation,undefined);assert.equal(result.orderReadAt,now);
  assert.deepEqual(result.originalConfirmation,prior.originalConfirmation);assert.equal(f.creates(),1);
});

test('Bybit restart-style GETs never manufacture an original create cause from a later query failure',async t=>{
  let now=1791524202000;t.mock.method(Date,'now',()=>now);
  const f=fixture();const result=view(await f.adapter.inspectOrder(request,unknownOrder(request)));
  assert.equal(result.status,'unknown');assert.equal(result.originalConfirmation,undefined);assert.equal(result.confirmation.reason,'not-found');
  assert.equal(result.orderReadAt,now);assert.equal(f.creates(),0);
});
