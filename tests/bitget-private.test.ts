import test from 'node:test';
import assert from 'node:assert/strict';
import { CcxtAdapter } from '../src/adapters/ccxt.js';
import { BitgetClassic } from '../src/adapters/bitget-classic.js';
import { exchangeClientId } from '../src/adapters/normalization.js';
import { defaultConfig } from './legacy-config.js';
import type { OrderRequest, OrderResult } from '../src/shared/types.js';
import ccxt from 'ccxt';

const market={id:'BTCUSDT',symbol:'BTC/USDT:USDT',base:'BTC',quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,
  contractSize:1,precision:{amount:.001,price:.1},limits:{amount:{min:.001},cost:{min:5}}};
const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const};
const request:OrderRequest={clientOrderId:'bitget-test-request',base:'BTC',symbol:market.symbol,side:'buy',quantity:.1,limitPrice:60000.07,reduceOnly:true};
function assertNotSubmitted(result:OrderResult){
  assert.equal(result.status,'cancelled');assert.equal(result.id,'');assert.equal(result.filledQuantity,0);assert.equal(result.feeUsd,0);
  assert.equal(result.rejectionCode,'PRE_SUBMISSION_CHECK_FAILED');
  assert.deepEqual(result.confirmation,{stage:'pre-submit',reason:'pre-submit-failed'});
}
const response=(data:any)=>({code:'00000',data});
const account=()=>({marginCoin:'USDT',assetMode:'single',available:'1000',isolatedMaxAvailable:'900',accountEquity:'1100',
  posMode:'one_way_mode',marginMode:'isolated',isolatedLongLever:'2',isolatedShortLever:'2'});
const rawPosition=()=>({symbol:market.id,marginCoin:'USDT',total:'.12',holdSide:'short',posMode:'one_way_mode',marginMode:'isolated',markPrice:'60000',leverage:'2',liquidationPrice:'90000'});
const order=(changes:any={})=>({symbol:market.id,orderId:'order-1',clientOid:exchangeClientId('bitget',request.clientOrderId),size:'.1',baseVolume:'.04',price:'60000',priceAvg:'60000',orderType:'limit',force:'ioc',fee:'-1.2',state:'canceled',side:'buy',marginCoin:'USDT',posMode:'one_way_mode',marginMode:'isolated',reduceOnly:'YES',uTime:String(Date.now()),...changes});
function setup(overrides:Record<string,any>={}){
  const calls:{method:string;params:any}[]=[];
  const method=(name:string,result:()=>any)=>async(params:any)=>{calls.push({method:name,params});return response(result());};
  const client={apiKey:'test-only',secret:'test-only',password:'test-only',precisionMode:4,
    privateUtaGetV3AccountSettings:async()=>response({accountMode:'hybrid'}),
    markets:{[market.symbol]:market},loadMarkets:async()=>({[market.symbol]:market}),market:()=>market,
    amountToPrecision:(_s:string,n:number)=>(Math.floor((Number(n)+1e-12)*1000)/1000).toFixed(3),priceToPrecision:(_s:string,n:number)=>(Math.round(n*10)/10).toFixed(1),
    privateMixGetV2MixAccountAccounts:method('accounts',()=>[account()]),
    privateMixGetV2MixPositionAllPosition:method('positions',()=>[rawPosition()]),
    privateSpotGetV2SpotAccountAssets:method('spot-assets',()=>[{coin:'USDT',available:'321.125',frozen:'0'}]),
    privateMixGetV2MixAccountAccount:method('mode',account),
    privateMixGetV2MixPositionSinglePosition:method('single-position',()=>[]),
    privateMixGetV2MixOrderOrdersPending:method('pending-orders',()=>({entrustedList:[]})),
    privateMixPostV2MixAccountSetLeverage:method('leverage',()=>({})),
    privateMixPostV2MixOrderPlaceOrder:method('place',()=>({orderId:null})),
    privateMixGetV2MixOrderDetail:method('detail',order),
    privateMixPostV2MixOrderCancelOrder:method('cancel',()=>({orderId:'order-1'})),
    ...overrides};
  return {client,calls,adapter:new CcxtAdapter('bitget',config,client)};
}

test('Bitget Classic Maker partial is cancelled and exact native post_only is required on final detail',async()=>{
  let sent:any,cancelled=false,creates=0,cancels=0;
  const s=setup({privateMixPostV2MixOrderPlaceOrder:async(p:any)=>{creates++;sent=p;return response({orderId:'order-1'});},
    privateMixPostV2MixOrderCancelOrder:async(p:any)=>{assert.equal(p.orderId,'order-1');cancelled=true;cancels++;return response({orderId:'order-1'});},
    privateMixGetV2MixOrderDetail:async()=>response(order({...sent,baseVolume:'.04',fee:'-.0002',state:cancelled?'canceled':'partially_filled',uTime:String(Date.now())}))});
  const maker={...request,clientOrderId:'offline-classic-maker',reduceOnly:false,postOnly:true};
  await s.adapter.prepareTrading(market.symbol,2);
  const value=await s.adapter.placeOrder(maker);assert.equal(value.status,'partial');assert.equal(value.filledQuantity,.04);assert.equal(value.feeUsd,.0002);
  assert.equal(sent.force,'post_only');assert.equal(creates,1);assert.equal(cancels,1);
  assert.deepEqual(await s.adapter.placeOrder(maker),value);assert.equal(creates,1);
  s.client.privateMixGetV2MixOrderDetail=async()=>response(order({...sent,force:'ioc',baseVolume:'.04',fee:'-.0002'}));
  assert.equal((await s.adapter.inspectOrder(maker,'order-1')).status,'unknown');await s.adapter.close();
});

test('Bitget Classic exact-ID lookup never accepts or cancels a response for another native order',async()=>{
  for(const state of ['canceled','live']){
    const s=setup({privateMixGetV2MixOrderDetail:async()=>response(order({orderId:'another-native-order',state}))});
    try{
      const observed=await s.adapter.inspectOrder(request,'expected-native-order');
      assert.equal(observed.status,'unknown');assert.equal(observed.filledQuantity,0);
      const reconciled=await s.adapter.reconcileOrder(request,'expected-native-order');
      assert.equal(reconciled.status,'unknown');assert.equal(reconciled.filledQuantity,0);
      assert.ok(!s.calls.some(call=>call.method==='cancel'),'an unrelated native ID must never be cancelled');
    }finally{await s.adapter.close();}
  }
});

test('Bitget classic account uses isolated available balance and base-coin position units without any writes',async()=>{
  const s=setup(),result=await s.adapter.fetchAccount();
  assert.equal(result.freeUsd,900);assert.equal(result.equityUsd,1100);
  assert.deepEqual(result.positions,[{base:'BTC',symbol:market.symbol,side:'short',quantity:.12,markPrice:60000,leverage:2,liquidationPrice:90000,liquidationStatus:'price',marginMode:'isolated'}]);
  assert.deepEqual(s.calls.map(x=>x.method),['accounts','positions']);
  assert.ok(s.calls.every(x=>x.params.productType==='USDT-FUTURES'));assert.equal(s.calls[1].params.marginCoin,'USDT');
});
test('Bitget Classic distinguishes lifetime funding from positive deducted transaction fees and missing cash fields',async()=>{
  const raw={...rawPosition(),totalFee:'-.12345678',deductedFee:'.031',cTime:'1790878381299',uTime:'1790913601703'};
  const s=setup({privateMixGetV2MixPositionAllPosition:async()=>response([raw])});
  const p=(await s.adapter.fetchAccount()).positions[0];
  assert.equal(p.fundingUsd,-.12345678);assert.equal(p.feesUsd,.031);
  assert.equal(p.positionOpenedAt,1790878381299);assert.equal(p.positionUpdatedAt,1790913601703);
  raw.totalFee='';assert.equal((await s.adapter.fetchAccount()).positions[0].fundingUsd,0);
  delete (raw as any).totalFee;delete (raw as any).deductedFee;
  const missing=(await s.adapter.fetchAccount()).positions[0];
  assert.equal(missing.fundingUsd,undefined);assert.equal(missing.feesUsd,undefined);
  assert.ok(s.calls.every(c=>['accounts','positions'].includes(c.method)));
});

test('Bitget position market lookup distinguishes spot and linear perpetuals sharing the native symbol',async()=>{
  const spot={...market,symbol:'BTC/USDT',swap:false,linear:false,settle:undefined,contractSize:undefined};
  const s=setup({markets:{[market.symbol]:market,[spot.symbol]:spot}});
  const result=await s.adapter.fetchAccount();
  assert.equal(result.positions.length,1);assert.equal(result.positions[0].symbol,market.symbol);assert.equal(result.positions[0].quantity,.12);
});
test('Bitget account rejects UTA-shaped balances, multi-asset margin and incomplete risk data',async()=>{
  for(const data of [{assets:[account()]},[{...account(),assetMode:'union'}],[{...account(),isolatedMaxAvailable:undefined}]]){
    const s=setup({privateMixGetV2MixAccountAccounts:async()=>response(data)});await assert.rejects(s.adapter.fetchAccount(),/classic|multi-assets|incomplete/);
  }
  for(const changed of [{total:undefined},{posMode:'hedge_mode'},{marginMode:'unknown'},{markPrice:undefined},{holdSide:'net'}]){
    const s=setup({privateMixGetV2MixPositionAllPosition:async()=>response([{...rawPosition(),...changed}])});
    await assert.rejects(s.adapter.fetchAccount(),/position|risk data/);
  }
});
test('Bitget paper mode and missing passphrase reject private calls before dispatch',async()=>{
  for(const variant of ['paper','password']){
    const s=setup(variant==='password'?{password:''}:{}),adapter=variant==='paper'?new CcxtAdapter('bitget',{...config,mode:'paper'},s.client):s.adapter;
    s.client.privateUtaGetV3AccountSettings=async()=>{s.calls.push({method:'settings',params:{}});throw new Error('unexpected private settings');};
    await assert.rejects(adapter.fetchAccount(),/disabled|credentials/);assertNotSubmitted(await adapter.placeOrder(request));
    assert.equal(s.calls.length,0);
  }
});
test('Bitget prepare never changes account modes and rejects external positions or pending orders before leverage writes',async()=>{
  for(const changed of [{posMode:'hedge_mode'},{marginMode:'crossed'},{assetMode:'union'}]){
    const s=setup({privateMixGetV2MixAccountAccount:async()=>response({...account(),...changed})});
    await assert.rejects(s.adapter.prepareTrading(market.symbol,2),/one-way|isolated|multi-assets/);assert.equal(s.calls.length,0);
  }
  for(const variant of ['position','pending']){
    const s=setup(variant==='position'?{privateMixGetV2MixPositionSinglePosition:async()=>response([rawPosition()])}:{privateMixGetV2MixOrderOrdersPending:async()=>response({entrustedList:[{orderId:'external'}]})});
    await assert.rejects(s.adapter.prepareTrading(market.symbol,2),/existing position or pending order/);
    assert.ok(!s.calls.some(x=>x.method==='leverage'));
  }
});
test('Bitget isolated one-way prepare sets and verifies both leverages before enabling entries',async()=>{
  const s=setup({privateMixGetV2MixOrderDetail:async()=>response(order({reduceOnly:'NO'}))});
  assertNotSubmitted(await s.adapter.placeOrder({...request,clientOrderId:request.clientOrderId+'-unprepared',reduceOnly:false}));
  assert.equal(s.calls.length,0,'unprepared entry cannot dispatch any private request');
  await s.adapter.prepareTrading(market.symbol,2);
  const leverage=s.calls.find(x=>x.method==='leverage')!;assert.deepEqual(leverage.params,{symbol:'BTCUSDT',productType:'USDT-FUTURES',marginCoin:'USDT',leverage:'2'});
  await s.adapter.placeOrder({...request,reduceOnly:false});
  assert.equal(s.calls.find(x=>x.method==='place')?.params.reduceOnly,'NO');
  let reads=0;const failed=setup({privateMixGetV2MixAccountAccount:async()=>response({...account(),isolatedShortLever:++reads===1?'2':'3'})});
  await assert.rejects(failed.adapter.prepareTrading(market.symbol,2),/verify requested leverage/);
  const calls=failed.calls.length;
  assertNotSubmitted(await failed.adapter.placeOrder({...request,reduceOnly:false}));
  assert.equal(failed.calls.length,calls,'failed preparation cannot dispatch another private request');
});
test('Bitget IOC sends bounded classic payload and queries missing ACK IDs by stable client ID',async()=>{
  const s=setup(),result=await s.adapter.placeOrder(request);
  assert.equal(result.status,'partial');assert.equal(result.filledQuantity,.04);assert.equal(result.averagePrice,60000);assert.equal(result.feeUsd,1.2);
  const sent=s.calls.find(x=>x.method==='place')!.params;
  assert.equal(sent.force,'ioc');assert.equal(sent.reduceOnly,'YES');assert.equal(sent.side,'buy');assert.equal(sent.marginMode,'isolated');assert.equal(sent.productType,'USDT-FUTURES');
  assert.equal(Number(sent.size),.1);assert.ok(Number(sent.price)<=request.limitPrice);assert.equal(sent.tradeSide,undefined);assert.equal(sent.clientOid,exchangeClientId('bitget',request.clientOrderId));
  assert.equal(s.calls.find(x=>x.method==='detail')?.params.clientOid,sent.clientOid);
  assert.deepEqual(await s.adapter.placeOrder(request),result);assert.equal(s.calls.filter(x=>x.method==='place').length,1);
  await assert.rejects(s.adapter.placeOrder({...request,quantity:.2}),/different order details/);
});
test('Bitget cancels an anomalously open IOC and confirms terminal cumulative fills',async()=>{
  let queries=0;const s=setup({privateMixGetV2MixOrderDetail:async()=>{queries++;return response(order(queries===1?{state:'partially_filled'}:{state:'canceled',baseVolume:'.05',fee:'-1.5'}));}});
  const result=await s.adapter.placeOrder(request);
  assert.equal(result.status,'partial');assert.equal(result.filledQuantity,.05);assert.equal(result.feeUsd,1.5);assert.equal(queries,2);
  assert.deepEqual(s.calls.find(x=>x.method==='cancel')?.params,{symbol:'BTCUSDT',productType:'USDT-FUTURES',marginCoin:'USDT',orderId:'order-1'});
});

test('Bitget classic background order inspection preserves partial fills and never cancels a live IOC',async()=>{
  const s=setup({privateMixGetV2MixOrderDetail:async()=>response(order({state:'partially_filled'}))});
  const result=await s.adapter.inspectOrder(request);
  assert.equal(result.status,'unknown');assert.equal(result.filledQuantity,.04);assert.equal(result.averagePrice,60000);
  assert.ok(!s.calls.some(x=>['cancel','place'].includes(x.method)));
});
test('Bitget preserves confirmed partial exposure when cancel confirmation fails',async()=>{
  const s=setup({privateMixGetV2MixOrderDetail:async()=>response(order({state:'partially_filled'})),privateMixPostV2MixOrderCancelOrder:async()=>{throw new Error('timeout');}});
  const result=await s.adapter.placeOrder(request);
  assert.equal(result.status,'unknown');assert.equal(result.filledQuantity,.04);assert.equal(result.feeUsd,1.2);
  s.client.privateMixGetV2MixOrderDetail=async()=>response(order({baseVolume:'.01'}));
  const next=await s.adapter.reconcileOrder(request);assert.equal(next.status,'unknown');assert.equal(next.filledQuantity,.04);
  assert.equal(s.calls.filter(x=>x.method==='place').length,1);
});
test('Bitget unknown timed-out orders and concurrent client-ID duplicates never resend',async()=>{
  let sends=0;const s=setup({privateMixPostV2MixOrderPlaceOrder:async()=>{sends++;throw new Error('network timeout');},privateMixGetV2MixOrderDetail:async()=>{throw new Error('not found yet');}});
  const results=await Promise.all([s.adapter.placeOrder(request),s.adapter.placeOrder(request)]);
  assert.ok(results.every(x=>x.status==='unknown'));await s.adapter.placeOrder(request);assert.equal(sends,1);
});
test('Bitget rejects wrong client identities and unsupported discounted fees without cancelling unrelated orders',async()=>{
  for(const changes of [{clientOid:'unrelated-order',state:'live'},{symbol:'ETHUSDT',state:'live'},
    {feeDetail:[{feeCoin:'BGB',totalFee:'-.01'}]},{fee:undefined},{baseVolume:'.2'}]){
    const s=setup({privateMixGetV2MixOrderDetail:async()=>response(order(changes))});
    assert.equal((await s.adapter.placeOrder(request)).status,'unknown');assert.ok(!s.calls.some(x=>x.method==='cancel'));
  }
});
test('Bitget private cancel uses the classic endpoint and mode changes block new submissions',async()=>{
  const s=setup();await s.adapter.cancelOrder(market.symbol,'explicit-order');assert.equal(s.calls.at(-1)?.params.orderId,'explicit-order');
  s.client.privateMixGetV2MixAccountAccount=async()=>response({...account(),posMode:'hedge_mode'});
  const result=await s.adapter.placeOrder(request);
  assert.equal(result.status,'cancelled');assert.equal(result.filledQuantity,0);assert.equal(result.id,'');
  assert.equal(result.rejectionCode,'PRE_SUBMISSION_CHECK_FAILED');
  assert.equal(result.rejectionReason,'委托发送前检查失败，本次未发送创建订单请求');
  // This client ID is conclusively rejected before send; repeated calls or reconciliation cannot create an order.
  s.client.privateMixGetV2MixAccountAccount=async()=>response(account());
  assert.deepEqual(await s.adapter.placeOrder(request),result);assert.deepEqual(await s.adapter.reconcileOrder(request),result);
  assert.ok(!s.calls.some(x=>x.method==='place'));
});

test('installed CCXT exposes every classic v2 endpoint used by the adapter without unified-account probing',()=>{
  const client=new ccxt.bitget();
  for(const name of ['privateMixGetV2MixAccountAccounts','privateMixGetV2MixPositionAllPosition','privateMixGetV2MixAccountAccount',
    'privateMixGetV2MixPositionSinglePosition','privateMixGetV2MixOrderOrdersPending','privateMixPostV2MixAccountSetLeverage',
    'privateMixPostV2MixOrderPlaceOrder','privateMixGetV2MixOrderDetail','privateMixPostV2MixOrderCancelOrder','privateMixGetV2MixAccountBill',
    'privateSpotGetV2SpotAccountAssets'])
    assert.equal(typeof (client as any)[name],'function',name);
});

test('Bitget overview separates spot funds from zero futures balance and only issues the three read requests',async()=>{
  const s=setup({
    loadMarkets:async()=>{throw new Error('overview must not fetch markets or unified-account settings');},
    privateMixGetV2MixAccountAccounts:async(params:any)=>{s.calls.push({method:'accounts',params});return response([{...account(),available:'0',accountEquity:'0',isolatedMaxAvailable:'0'}]);},
    privateMixGetV2MixPositionAllPosition:async(params:any)=>{s.calls.push({method:'positions',params});return response([]);},
  });
  assert.deepEqual(await s.adapter.fetchAccountOverview(),{freeUsd:0,equityUsd:0,positionCount:0,balanceScope:'usdt_futures',
    isolatedAvailableUsd:0,spotAvailableUsd:321.125,spotStatus:'available'});
  assert.deepEqual(s.calls.map(c=>c.method),['accounts','positions','spot-assets']);
  assert.deepEqual(s.calls.at(-1)?.params,{coin:'USDT'});
});

test('Bitget overview preserves exchange available and isolated limits as separate fields; strict budget stays conservative',async()=>{
  const s=setup();
  const overview=await s.adapter.fetchAccountOverview(),strict=await s.adapter.fetchAccount();
  assert.equal(overview.freeUsd,1000);assert.equal(overview.isolatedAvailableUsd,900);assert.equal(overview.equityUsd,1100);
  assert.equal(overview.positionCount,1);assert.equal(strict.freeUsd,900);
});

test('Bitget missing or malformed overview fields are never silently displayed as zero',async()=>{
  for(const value of [undefined,null,'',' ',false,'invalid']){
    for(const field of ['available','accountEquity']){
      const s=setup({privateMixGetV2MixAccountAccounts:async()=>response([{...account(),[field]:value}])});
      await assert.rejects(s.adapter.fetchAccountOverview(),/incomplete USDT futures balance/);
    }
    const isolated=setup({privateMixGetV2MixAccountAccounts:async()=>response([{...account(),isolatedMaxAvailable:value}])});
    const overview=await isolated.adapter.fetchAccountOverview();
    assert.equal(overview.freeUsd,1000);assert.equal(overview.isolatedAvailableUsd,undefined);
    assert.ok(overview.warnings?.some(w=>w.includes('逐仓可开仓余额暂不可读取')));
    const spot=setup({privateSpotGetV2SpotAccountAssets:async()=>response([{coin:'USDT',available:value}])});
    const missingSpot=await spot.adapter.fetchAccountOverview();
    assert.equal(missingSpot.spotStatus,'unavailable');assert.equal(missingSpot.spotAvailableUsd,undefined);
  }
  const quantity=setup({privateMixGetV2MixPositionAllPosition:async()=>response([{...rawPosition(),total:undefined}])});
  await assert.rejects(quantity.adapter.fetchAccountOverview(),/invalid overview position quantity/);
});

test('Bitget spot permission failure preserves futures values with fixed warnings and empty spot assets mean confirmed zero',async()=>{
  const s=setup({privateSpotGetV2SpotAccountAssets:async()=>{throw new Error('sensitive upstream request details must never be displayed');}});
  const result=await s.adapter.fetchAccountOverview();
  assert.equal(result.freeUsd,1000);assert.equal(result.equityUsd,1100);assert.equal(result.positionCount,1);
  assert.equal(result.spotAvailableUsd,undefined);assert.equal(result.spotStatus,'unavailable');
  assert.deepEqual(result.warnings,['现货 USDT 余额暂不可读取；合约余额仍有效']);
  const empty=await setup({privateSpotGetV2SpotAccountAssets:async()=>response([])}).adapter.fetchAccountOverview();
  assert.equal(empty.spotAvailableUsd,0);assert.equal(empty.spotStatus,'available');
  for(const malformed of [{},[{coin:'USDC',available:'10'}],[{coin:'USDT',available:'1'},{coin:'USDT',available:'2'}]]){
    const result=await setup({privateSpotGetV2SpotAccountAssets:async()=>response(malformed)}).adapter.fetchAccountOverview();
    assert.equal(result.spotStatus,'unavailable');assert.equal(result.spotAvailableUsd,undefined);
  }
});

test('Bitget hedge positions and Classic union accounts remain readable while strict trading checks still reject them',async()=>{
  for(const changed of [{posMode:'hedge_mode'}]){
    const s=setup({privateMixGetV2MixPositionAllPosition:async()=>response([{...rawPosition(),...changed}])});
    const overview=await s.adapter.fetchAccountOverview();
    assert.equal(overview.freeUsd,1000);assert.equal(overview.positionCount,1);
    assert.ok(overview.warnings?.some(w=>w.includes('单向 USDT')));
    await assert.rejects(s.adapter.fetchAccount(),/single-direction verified/);
    assert.ok(s.calls.every(c=>['accounts','spot-assets'].includes(c.method)));
  }
  const union=setup({privateMixGetV2MixAccountAccounts:async()=>response([{...account(),assetMode:'union'}])});
  const overview=await union.adapter.fetchAccountOverview();
  assert.equal(overview.freeUsd,1000);assert.equal(overview.equityUsd,1100);
  assert.ok(overview.warnings?.some(w=>w.includes('Classic')&&w.includes('多资产保证金')));
  await assert.rejects(union.adapter.fetchAccount(),/single-asset/);
});

test('Bitget overview dispatches no reads in paper mode or with missing passphrase',async()=>{
  for(const variant of ['paper','password']){
    const s=setup(variant==='password'?{password:''}:{});
    const adapter=variant==='paper'?new CcxtAdapter('bitget',{...config,mode:'paper'},s.client):s.adapter;
    await assert.rejects(adapter.fetchAccountOverview(),/disabled|credentials/);assert.equal(s.calls.length,0);
  }
});

test('Bitget never-resolving optional spot request cannot block a valid futures overview', {timeout:1000},async()=>{
  const s=setup({privateSpotGetV2SpotAccountAssets:()=>new Promise(()=>{})});
  const overview=await new BitgetClassic(s.client,10).fetchAccountOverview();
  assert.equal(overview.freeUsd,1000);assert.equal(overview.equityUsd,1100);assert.equal(overview.positionCount,1);
  assert.equal(overview.spotStatus,'unavailable');assert.equal(overview.spotAvailableUsd,undefined);
  assert.deepEqual(overview.warnings,['现货 USDT 余额暂不可读取；合约余额仍有效']);
});

test('Bitget late spot success or failure cannot overwrite a completed overview or escape as an unhandled rejection', {timeout:1000},async()=>{
  for(const outcome of ['resolve','reject'] as const){
    let resolve!:(value:any)=>void,reject!:(reason:any)=>void;
    const s=setup({privateSpotGetV2SpotAccountAssets:()=>new Promise((res,rej)=>{resolve=res;reject=rej;})});
    const overview=await new BitgetClassic(s.client,10).fetchAccountOverview(),before=structuredClone(overview);
    if(outcome==='resolve')resolve(response([{coin:'USDT',available:'654.5'}]));
    else reject(new Error('late simulated spot failure'));
    await new Promise<void>(done=>setImmediate(done));
    assert.deepEqual(overview,before);assert.equal(overview.spotStatus,'unavailable');
  }
});
