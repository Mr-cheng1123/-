import test from 'node:test';
import assert from 'node:assert/strict';
import ccxt from 'ccxt';
import {BitgetClassic} from '../src/adapters/bitget-classic.js';
import {BitgetUta} from '../src/adapters/bitget-uta.js';
import {bitgetAccount,clearBitgetAccountCache} from '../src/adapters/bitget-account.js';
import {exchangeClientId} from '../src/adapters/normalization.js';
import type {OrderRequest} from '../src/shared/types.js';

const symbol='BTC/USDT:USDT';
const market:any={id:'BTCUSDT',symbol,base:'BTC',baseId:'BTC',quote:'USDT',quoteId:'USDT',settle:'USDT',settleId:'USDT',
  active:true,type:'swap',spot:false,swap:true,future:false,option:false,contract:true,linear:true,inverse:false,contractSize:1,
  precision:{amount:.001,price:.1},limits:{amount:{min:.001},cost:{min:1}}};
type Mode='crossed'|'isolated';
type Wire={path:string;method:string;params:any};

/** Installed CCXT performs signing/serialization. Fake keys, cached markets and replaced fetch prevent all network access. */
function fixture(accountMode:'hybrid'|'unified'='hybrid',initialMode:Mode='isolated'){
  const client:any=new ccxt.bitget({apiKey:'margin-fixture-key',secret:'margin-fixture-secret',password:'margin-fixture-passphrase',enableRateLimit:false});
  client.setMarkets([market]);
  const calls:Wire[]=[],state={mode:initialMode,leverage:2,longLeverage:2,shortLeverage:2,accountLevel:'basic',holdMode:'one_way_mode',
    total:'0',delegated:'0',orders:[] as any[],strategies:[] as any[],plans:[] as any[],ignoreMode:false,ignoreLeverage:false,missingConfig:false};
  const classic=()=>({marginCoin:'USDT',assetMode:'single',posMode:state.holdMode,marginMode:state.mode,
    crossedMarginLeverage:String(state.leverage),isolatedLongLever:String(state.longLeverage),isolatedShortLever:String(state.shortLeverage),
    available:'1000',crossedMaxAvailable:'700',isolatedMaxAvailable:'900',accountEquity:'1100'});
  const utaSettings=()=>({accountMode,accountLevel:state.accountLevel,holdMode:state.holdMode,deltaSwitch:'no',symbolConfigList:state.missingConfig?[]:[{
    category:'USDT-FUTURES',symbol:market.id,marginMode:state.mode,leverage:String(state.leverage),
    ...(state.mode==='isolated'?{longLeverage:String(state.longLeverage),shortLeverage:String(state.shortLeverage)}:{})}]});
  const rawPosition=()=>({symbol:market.id,category:'USDT-FUTURES',marginCoin:'USDT',total:state.total,openDelegateSize:state.delegated,
    holdSide:'long',posSide:'long',posMode:state.holdMode,holdMode:state.holdMode,marginMode:state.mode,markPrice:'60000',leverage:String(state.leverage),liquidationPrice:'0'});
  const ok=(data:any)=>({code:'00000',msg:'success',requestTime:Date.now(),data});
  client.fetch=async(url:string,method='GET',_headers:any,body?:string)=>{
    const parsed=new URL(url),path=parsed.pathname,params=body?JSON.parse(body):Object.fromEntries(parsed.searchParams);calls.push({path,method,params});
    if(path==='/api/v3/account/settings')return ok(utaSettings());
    if(path==='/api/v3/account/assets')return ok({accountEquity:'1100',effEquity:'1000',imr:'0',assets:[{coin:'USDT',equity:'1100',available:'1000',debt:'0'}]});
    if(path==='/api/v3/position/current-position')return ok({list:state.total==='0'?[]:[rawPosition()]});
    if(path==='/api/v3/trade/unfilled-orders')return ok({list:state.orders,cursor:''});
    if(path==='/api/v3/trade/unfilled-strategy-orders')return ok(state.strategies);
    if(path==='/api/v3/account/pre-set-leverage')return ok({requiredMargin:'0'});
    if(path==='/api/v3/account/set-leverage'){
      if(!state.ignoreMode)state.mode=params.marginMode;
      state.missingConfig=false;
      if(!state.ignoreLeverage){if(params.posSide==='long')state.longLeverage=Number(params.leverage);else if(params.posSide==='short')state.shortLeverage=Number(params.leverage);else state.leverage=Number(params.leverage);}
      return ok('success');
    }
    if(path==='/api/v3/trade/place-order')return ok({orderId:'synthetic-uta-order'});
    if(path==='/api/v2/mix/account/account')return ok(classic());
    if(path==='/api/v2/mix/account/accounts')return ok([classic()]);
    if(path==='/api/v2/mix/position/single-position')return ok(state.total==='0'&&state.delegated==='0'?[]:[rawPosition()]);
    if(path==='/api/v2/mix/position/all-position')return ok(state.total==='0'?[]:[rawPosition()]);
    if(path==='/api/v2/mix/order/orders-pending')return ok({entrustedList:state.orders});
    if(path==='/api/v2/mix/order/orders-plan-pending')return ok({entrustedList:state.plans,endId:''});
    if(path==='/api/v2/mix/account/set-margin-mode'){if(!state.ignoreMode)state.mode=params.marginMode;return ok({marginMode:params.marginMode});}
    if(path==='/api/v2/mix/account/set-leverage'){
      if(!state.ignoreLeverage)state.leverage=state.longLeverage=state.shortLeverage=Number(params.leverage);
      return ok({});
    }
    if(path==='/api/v2/mix/order/place-order')return ok({orderId:'synthetic-classic-order'});
    throw new Error(`Unexpected offline fixture route: ${method} ${path}`);
  };
  const request:OrderRequest={clientOrderId:'offline-margin-setting',base:'BTC',symbol,side:'buy',quantity:.1,limitPrice:60000,reduceOnly:false};
  return {client,calls,state,request};
}

for(const desired of ['crossed','isolated'] as const){
  const initial:Mode=desired==='crossed'?'isolated':'crossed';
  test(`Classic explicit ${desired}: inspection is GET only; empty contract changes margin and leverage with fresh native readback`,async()=>{
    const f=fixture('hybrid',initial),account=await bitgetAccount(f.client,'isolated',desired);
    assert.ok(account instanceof BitgetClassic);
    await account.inspectTrading(symbol,3);assert.ok(f.calls.every(c=>c.method==='GET'));assert.equal(f.state.mode,initial);
    await account.prepare(symbol,3);
    const writes=f.calls.filter(c=>c.method==='POST');
    assert.deepEqual(writes.map(c=>c.path),['/api/v2/mix/account/set-margin-mode','/api/v2/mix/account/set-leverage']);
    assert.deepEqual(writes[0].params,{symbol:'BTCUSDT',productType:'USDT-FUTURES',marginCoin:'USDT',marginMode:desired});
    assert.deepEqual(writes[1].params,{symbol:'BTCUSDT',productType:'USDT-FUTURES',marginCoin:'USDT',leverage:'3'});
    assert.equal(f.calls.at(-1)?.method,'GET');assert.equal(f.state.mode,desired);
    await (await bitgetAccount(f.client,'isolated',desired)).place(f.request,.1,60000);
    const order=f.calls.at(-1)!;assert.equal(order.path,'/api/v2/mix/order/place-order');assert.equal(order.params.marginMode,desired);
    assert.equal(order.params.reduceOnly,'NO');assert.equal(order.params.force,'ioc');
  });
  test(`UTA explicit ${desired}: same leverage still prepares requested margin scope and checks persisted settings`,async()=>{
    const f=fixture('unified',initial),account=await bitgetAccount(f.client,'isolated',desired);assert.ok(account instanceof BitgetUta);
    await account.inspectTrading(symbol,2);assert.ok(f.calls.every(c=>c.method==='GET'));assert.equal(f.state.mode,initial);
    await account.prepare(symbol,2);assert.equal(f.state.mode,desired);
    const writes=f.calls.filter(c=>c.path==='/api/v3/account/set-leverage');
    assert.equal(writes.length,desired==='crossed'?1:2);assert.ok(writes.every(c=>c.params.marginMode===desired&&c.params.leverage==='2'));
    if(desired==='isolated')assert.deepEqual(writes.map(c=>c.params.posSide),['long','short']);else assert.equal(writes[0].params.posSide,undefined);
    assert.ok(f.calls.filter(c=>c.path==='/api/v3/account/pre-set-leverage').every(c=>c.params.marginMode===(desired==='crossed'?'cross':'isolated')));
    await (await bitgetAccount(f.client,'isolated',desired)).place(f.request,.1,60000);
    assert.equal(f.calls.at(-1)?.params.marginMode,desired);
    assert.ok(!f.calls.some(c=>/adjust-account-mode|set-hold-mode/.test(c.path)));
  });
}

test('Classic margin transitions refuse held, delegated, regular or conditional orders before any write',async()=>{
  for(const risk of ['held','delegated','orders','plans']){
    const f=fixture();if(risk==='held')f.state.total='.1';else if(risk==='delegated')f.state.delegated='.1';else f.state[risk as 'orders'|'plans']=[{orderId:'external'}];
    const account=new BitgetClassic(f.client,5000,'isolated','crossed');
    await assert.rejects(account.inspectTrading(symbol,3),/existing position or pending order/);
    await assert.rejects(account.prepare(symbol,3),/existing position or pending order/);assert.ok(f.calls.every(c=>c.method==='GET'));
  }
});

test('UTA explicit margin transitions refuse positions, regular and same-contract strategy orders before preview/writes',async()=>{
  for(const risk of ['held','orders','strategies']){
    const f=fixture('unified');if(risk==='held')f.state.total='.1';else f.state[risk as 'orders'|'strategies']=[{category:'USDT-FUTURES',symbol:market.id,orderId:'external'}];
    const account=new BitgetUta(f.client,'isolated','crossed');
    await assert.rejects(account.prepare(symbol,3),/existing UTA position or pending order/);
    assert.ok(f.calls.every(c=>c.method==='GET'));assert.ok(!f.calls.some(c=>c.path.endsWith('/pre-set-leverage')));
  }
});

test('Classic successful margin ACK cannot authorize leverage/order when native mode readback is unchanged',async()=>{
  const f=fixture();f.state.ignoreMode=true;const account=new BitgetClassic(f.client,5000,'isolated','crossed');
  await assert.rejects(account.prepare(symbol,3),/margin mode change could not be verified/);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.ok(!f.calls.some(c=>c.path.endsWith('/set-leverage')));
  await assert.rejects(account.place(f.request,.1,60000),/opening margin mode changed/);assert.ok(!f.calls.some(c=>c.path.endsWith('/place-order')));
});

test('UTA successful leverage ACK cannot authorize entry if persisted margin differs from explicit target',async()=>{
  const f=fixture('unified');f.state.ignoreMode=true;const account=new BitgetUta(f.client,'isolated','crossed');
  await assert.rejects(account.prepare(symbol,3),/could not be verified/);
  await assert.rejects(account.place(f.request,.1,60000),/opening margin mode changed/);assert.ok(!f.calls.some(c=>c.path.endsWith('/place-order')));
});

for(const accountMode of ['hybrid','unified'] as const){
  test(`${accountMode}: explicit entry preference leaves native margin untouched for reduce-only closure`,async()=>{
    for(const actual of ['crossed','isolated'] as const){
      const f=fixture(accountMode,actual),opposite:Mode=actual==='crossed'?'isolated':'crossed';
      const account=await bitgetAccount(f.client,'isolated',opposite);
      await account.place({...f.request,side:'sell',reduceOnly:true},.1,60000);
      assert.equal(f.calls.at(-1)?.params.marginMode,actual);
      assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.equal(f.state.mode,actual);
    }
  });
}

test('Classic cross budgets use native crossedMaxAvailable and cross position reads retain actual margin mode',async()=>{
  const f=fixture('hybrid','crossed');f.state.total='.1';
  const result=await new BitgetClassic(f.client,5000,'isolated','crossed').fetchAccount();
  assert.equal(result.freeUsd,700);assert.equal(result.positions[0]?.marginMode,'crossed');assert.equal(result.positions[0]?.quantity,.1);
  assert.ok(f.calls.every(c=>c.method==='GET'));
});

test('explicit UTA cross selection never switches an isolated account level',async()=>{
  const f=fixture('unified');f.state.accountLevel='isolated';
  await assert.rejects(new BitgetUta(f.client,'isolated','crossed').prepare(symbol,2),/isolated account cannot initialize crossed/);
  assert.ok(f.calls.every(c=>c.method==='GET'));
});

test('legacy factory preserves persisted UTA crossed mode and Classic isolated requirements',async()=>{
  const u=fixture('unified','crossed');await (await bitgetAccount(u.client,'isolated')).prepare(symbol,2);
  assert.ok(u.calls.every(c=>c.method==='GET'));assert.equal(u.state.mode,'crossed');
  const c=fixture('hybrid','crossed');await assert.rejects((await bitgetAccount(c.client)).prepare(symbol,2),/configure isolated/);
  assert.ok(c.calls.every(x=>x.method==='GET'));
});

test('native mode proofs are scoped by explicit desired margin preference and do not contaminate legacy wrappers',async()=>{
  const f=fixture('unified','crossed');await new BitgetUta(f.client,'isolated','crossed').assertTradingMode(symbol);
  const before=f.calls.length;await new BitgetUta(f.client,'isolated').assertTradingMode(symbol);assert.ok(f.calls.length>before);
  clearBitgetAccountCache(f.client);
});

test('Classic and UTA opening order observations reject a native margin scope different from the explicit target',async()=>{
  for(const accountMode of ['hybrid','unified'] as const){
    const f=fixture(accountMode,'crossed'),account=await bitgetAccount(f.client,'isolated','crossed');
    const id='synthetic-observed-order',common={orderId:id,symbol:'BTCUSDT',clientOid:exchangeClientId('bitget',f.request.clientOrderId),side:'buy',marginMode:'isolated'};
    const raw=accountMode==='hybrid'?{...common,marginCoin:'USDT',size:'.1',baseVolume:'0',fee:'0',priceAvg:'0',uTime:String(Date.now()),
      state:'canceled',posMode:'one_way_mode',reduceOnly:'NO'}:{...common,category:'USDT-FUTURES',qty:'.1',cumExecQty:'0',avgPrice:'0',
      orderType:'limit',timeInForce:'ioc',orderStatus:'cancelled',holdMode:'one_way_mode',reduceOnly:'NO',updatedTime:String(Date.now()),feeDetail:[]};
    f.client.fetch=async(url:string,method='GET')=>{assert.equal(method,'GET');assert.ok(new URL(url).pathname.endsWith(accountMode==='hybrid'?'/detail':'/order-info'));return {code:'00000',data:raw};};
    const observed=await account.inspectOrder(f.request,undefined,id);
    assert.equal(observed.status,'unknown');assert.equal(observed.filledQuantity,0);
  }
});
