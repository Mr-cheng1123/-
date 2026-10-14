import test from 'node:test';
import assert from 'node:assert/strict';
import ccxt from 'ccxt';
import { BitgetUta } from '../src/adapters/bitget-uta.js';
import { exchangeClientId, unknownOrder } from '../src/adapters/normalization.js';
import type { OrderRequest } from '../src/shared/types.js';
import {attachBitgetFillFixture} from './bitget-fill-fixture.js';

const market={id:'BTCUSDT',symbol:'BTC/USDT:USDT',base:'BTC',quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,
  contractSize:1,precision:{amount:.001,price:.1},limits:{amount:{min:.001},cost:{min:5}}};
const request:OrderRequest={clientOrderId:'uta-fixture-only',base:'BTC',symbol:market.symbol,side:'buy',quantity:.1,limitPrice:60000.07,reduceOnly:true};
const response=(data:any)=>({code:'00000',data});
const settings=()=>({accountMode:'unified',accountLevel:'basic',holdMode:'one_way_mode',assetMode:'multi_assets',deltaSwitch:'no',
  symbolConfigList:[{category:'USDT-FUTURES',symbol:'BTCUSDT',marginMode:'crossed',leverage:'2'}]});
const assets=()=>({accountEquity:'500',effEquity:'320',imr:'20',assets:[{coin:'USDT',equity:'500',available:'321.125',balance:'321.125',debt:'0'}]});
const position=()=>({category:'USDT-FUTURES',symbol:'BTCUSDT',marginCoin:'USDT',holdMode:'one_way_mode',posSide:'long',marginMode:'crossed',
  total:'.12',leverage:'2',markPrice:'60000',liquidationPrice:'30000'});
test('Bitget UTA live metrics retain exchange values and signed lifetime funding/fees via GET only',async()=>{
  const s=setup({privateUtaGetV3PositionCurrentPosition:async()=>response({list:[{...position(),avgPrice:'59900',unrealisedPnl:'12',totalFunding:'-.12',openFeeTotal:'-.03',closeFeeTotal:'0'}]})});
  const p=(await s.adapter.fetchAccount()).positions[0];assert.equal(p.entryPrice,59900);assert.equal(p.unrealizedPnlUsd,12);
  assert.equal(p.fundingUsd,-.12);assert.equal(p.feesUsd,.03);assert.ok(s.calls.every(c=>!['place','cancel','leverage'].includes(c.method)));
});
const order=(changes:any={})=>({category:'USDT-FUTURES',symbol:'BTCUSDT',orderId:'uta-order-1',clientOid:exchangeClientId('bitget',request.clientOrderId),
  qty:'.1',cumExecQty:'.04',price:'60000',avgPrice:'60000',side:'buy',orderType:'limit',timeInForce:'ioc',reduceOnly:'YES',holdMode:'one_way_mode',
  marginMode:'crossed',orderStatus:'cancelled',updatedTime:String(Date.now()),feeDetail:[{feeCoin:'USDT',fee:'1.2'}],...changes});
function setup(overrides:Record<string,any>={}){
  const calls:{method:string;params:any}[]=[];
  let leverage='2';
  const method=(name:string,fn:(p:any)=>any)=>async(params:any)=>{calls.push({method:name,params});return response(fn(params));};
  const client:any={markets:{[market.symbol]:market,'BTC/USDT':{...market,symbol:'BTC/USDT',swap:false,linear:false}},market:()=>market,
    amountToPrecision:(_s:string,n:number)=>(Math.floor(n*1000)/1000).toFixed(3),priceToPrecision:(_s:string,n:number)=>(Math.round(n*10)/10).toFixed(1),
    privateUtaGetV3AccountSettings:method('settings',()=>({...settings(),symbolConfigList:[{...settings().symbolConfigList[0],leverage}]})),
    privateUtaGetV3AccountAssets:method('assets',assets),privateUtaGetV3PositionCurrentPosition:method('positions',()=>({list:[]})),
    privateUtaGetV3TradeUnfilledOrders:method('open-orders',()=>({list:[],cursor:''})),
    privateUtaGetV3AccountPreSetLeverage:method('preview',()=>({estMaxOpen:'1000',requiredMargin:'0',marginChange:'0',estMaxBorrowable:'0'})),
    privateUtaPostV3AccountSetLeverage:method('leverage',p=>{leverage=p.leverage;return 'success';}),
    privateUtaPostV3TradePlaceOrder:method('place',()=>({clientOid:exchangeClientId('bitget',request.clientOrderId),orderId:null})),
    privateUtaGetV3TradeOrderInfo:method('order-info',()=>order()),privateUtaPostV3TradeCancelOrder:method('cancel',()=>({orderId:'uta-order-1'})),
    privateUtaGetV3AccountFinancialRecords:method('financial-records',()=>({list:[],cursor:''})),...overrides};
  attachBitgetFillFixture(client,p=>calls.push({method:'fills',params:p}));
  return {client,calls,adapter:new BitgetUta(client)};
}

test('UTA overview uses v3 USDT available, separate margin cap and total account equity without duplicating spot funds',async()=>{
  const s=setup(),overview=await s.adapter.fetchAccountOverview();
  assert.deepEqual(overview,{freeUsd:300,equityUsd:500,positionCount:0,balanceScope:'unified_usdt',accountType:'unified',accountMode:'basic',
    positionMode:'one_way_mode',executionSupported:true,usdtAvailableUsd:321.125,marginAvailableUsd:300});
  assert.deepEqual(s.calls.map(c=>c.method),['settings','assets','positions']);
  assert.deepEqual(s.calls.at(-1)?.params,{category:'USDT-FUTURES'});
  assert.equal(overview.spotAvailableUsd,undefined);assert.equal(overview.isolatedAvailableUsd,undefined);
});

test('UTA strict account preserves base-coin units, filters duplicate spot IDs and caps the cross margin budget',async()=>{
  const s=setup({privateUtaGetV3PositionCurrentPosition:async()=>response({list:[position()]})});
  assert.deepEqual(await s.adapter.fetchAccount(),{freeUsd:300,equityUsd:500,positions:[{base:'BTC',symbol:market.symbol,side:'long',quantity:.12,markPrice:60000,leverage:2,liquidationPrice:30000,liquidationStatus:'price',marginMode:'crossed'}]});
  const low=setup({privateUtaGetV3AccountAssets:async()=>response({...assets(),effEquity:'10',imr:'20'})});
  assert.equal((await low.adapter.fetchAccount()).freeUsd,0);
});

test('Bitget UTA current holding preserves native precision, lifecycle and explicit zero liquidation semantics',async()=>{
  const native={...position(),total:'4330',avgPrice:'0.023133926097',markPrice:'0.0233',liquidationPrice:'0',
    unrealisedPnl:'0.71909999',totalFunding:'-0.04659997',openFeeTotal:'-0.06010194',closeFeeTotal:'0',curRealisedPnl:'0',
    createdTime:'1790878381299',updatedTime:'1790913601703'};
  const s=setup({privateUtaGetV3PositionCurrentPosition:async()=>response({list:[native]})});
  const p=(await s.adapter.fetchAccount()).positions[0];
  assert.equal(p.quantity,4330);assert.equal(p.entryPrice,.023133926097);assert.equal(p.unrealizedPnlUsd,.71909999);
  assert.equal(p.fundingUsd,-.04659997);assert.equal(p.feesUsd,.06010194);assert.equal(p.realizedPnlUsd,0);
  assert.equal(p.liquidationPrice,0);assert.equal(p.liquidationStatus,'not_liquidatable');assert.ok(p.liquidationReason);
  assert.equal(p.positionOpenedAt,1790878381299);assert.equal(p.positionUpdatedAt,1790913601703);
  assert.equal(p.marginMode,'crossed');assert.ok(s.calls.every(c=>!['place','cancel','leverage'].includes(c.method)));
  delete (native as any).totalFunding;delete (native as any).openFeeTotal;delete (native as any).curRealisedPnl;
  const missing=(await s.adapter.fetchAccount()).positions[0];
  assert.equal(missing.fundingUsd,undefined);assert.equal(missing.feesUsd,undefined);assert.equal(missing.realizedPnlUsd,undefined);
});

test('UTA explicit null current-position list is empty while missing or malformed lists still fail',async()=>{
  const s=setup({privateUtaGetV3PositionCurrentPosition:async()=>response({list:null})});
  const overview=await s.adapter.fetchAccountOverview();
  assert.equal(overview.positionCount,0);assert.equal(overview.freeUsd,300);assert.equal(overview.executionSupported,true);
  assert.deepEqual((await s.adapter.fetchAccount()).positions,[]);
  assert.ok(!s.calls.some(c=>['leverage','place','cancel'].includes(c.method)));
  for(const data of [{},{list:undefined},{list:{}},{list:''},{list:0},null]){
    const invalid=setup({privateUtaGetV3PositionCurrentPosition:async()=>response(data)});
    await assert.rejects(invalid.adapter.fetchAccountOverview(),/UTA/);
    await assert.rejects(invalid.adapter.fetchAccount(),/UTA/);
  }
});

test('UTA explicit empty funding list and cursor are supported without relaxing open-order or malformed ledger lists',async()=>{
  const s=setup({privateUtaGetV3PositionCurrentPosition:async()=>response({list:null}),
    privateUtaGetV3TradeUnfilledOrders:async()=>response({list:null}),
    privateUtaGetV3AccountFinancialRecords:async()=>response({list:null,cursor:''})});
  await assert.rejects(s.adapter.prepare(market.symbol,2),/invalid UTA list/);
  for(const cursor of ['',null]){
    s.client.privateUtaGetV3AccountFinancialRecords=async()=>response({list:null,cursor});
    assert.deepEqual(await s.adapter.fetchFundingPayments(now-1,now+1),[]);
  }
  for(const data of [{},{list:undefined,cursor:''},{list:{},cursor:''},{list:null},{list:null,cursor:undefined},{list:null,cursor:'next'}]){
    s.client.privateUtaGetV3AccountFinancialRecords=async()=>response(data);
    await assert.rejects(s.adapter.fetchFundingPayments(now-1,now+1),/invalid UTA list/);
  }
  assert.ok(!s.calls.some(c=>['leverage','place','cancel'].includes(c.method)));
});

test('UTA advanced, unknown holding modes and debt remain readable but cannot authorize execution',async()=>{
  const cases=[
    {privateUtaGetV3AccountSettings:async()=>response({...settings(),accountLevel:'advanced'})},
    {privateUtaGetV3AccountSettings:async()=>response({...settings(),holdMode:'unknown'})},
    {privateUtaGetV3AccountSettings:async()=>response({...settings(),accountLevel:'delta'})},
    {privateUtaGetV3AccountSettings:async()=>response({...settings(),deltaSwitch:'yes'})},
    {privateUtaGetV3AccountAssets:async()=>response({...assets(),assets:[...assets().assets,{coin:'BGB',equity:'-1',available:'0',debt:'0'}]})},
    {privateUtaGetV3AccountAssets:async()=>response({...assets(),assets:[{...assets().assets[0],debt:'1'}]})},
  ];
  for(const data of cases){
    const s=setup(data),overview=await s.adapter.fetchAccountOverview();
    assert.equal(overview.executionSupported,false);assert.ok(overview.warnings?.length);assert.equal(overview.equityUsd,500);
    await assert.rejects(s.adapter.fetchAccount());await assert.rejects(s.adapter.prepare(market.symbol,2));
    await assert.rejects(s.adapter.place(request,.1,60000));assert.ok(!s.calls.some(c=>['leverage','place'].includes(c.method)));
  }
});

test('UTA overview reports each specific execution restriction and keeps read-only balances available',async()=>{
  const cases:[Record<string,any>,RegExp][]=[
    [{privateUtaGetV3AccountSettings:async()=>response({...settings(),accountLevel:'advanced'})},/高级统一账户/],
    [{privateUtaGetV3AccountSettings:async()=>response({...settings(),accountLevel:'delta'})},/Delta 统一账户/],
    [{privateUtaGetV3AccountSettings:async()=>response({...settings(),accountLevel:undefined})},/无法确认.*保证金模式/],
    [{privateUtaGetV3AccountSettings:async()=>response({...settings(),deltaSwitch:'yes'})},/启用 Delta 模式/],
    [{privateUtaGetV3AccountSettings:async()=>response({...settings(),holdMode:undefined})},/无法确认统一账户的持仓模式/],
    [{privateUtaGetV3AccountAssets:async()=>response({...assets(),assets:[{...assets().assets[0],debt:'1'}]})},/存在非零负债/],
    [{privateUtaGetV3AccountAssets:async()=>response({...assets(),assets:[{...assets().assets[0],debt:undefined}]})},/负债字段缺失或无法确认/],
    [{privateUtaGetV3AccountAssets:async()=>response({...assets(),assets:[...assets().assets,{coin:'BGB',equity:undefined,debt:'0'}]})},/无法确认.*资产权益/],
  ];
  for(const [overrides,reason] of cases){
    const s=setup(overrides),overview=await s.adapter.fetchAccountOverview();
    assert.equal(overview.executionSupported,false);assert.equal(overview.freeUsd,300);assert.equal(overview.equityUsd,500);
    assert.ok(overview.warnings?.some(w=>reason.test(w)),String(reason));
    await assert.rejects(s.adapter.fetchAccount());
  }
  const combined=setup({
    privateUtaGetV3AccountSettings:async()=>response({...settings(),holdMode:'hedge_mode',symbolConfigList:[]}),
    privateUtaGetV3AccountAssets:async()=>response({...assets(),assets:[...assets().assets,{coin:'BGB',equity:'.01',debt:'0'}]}),
    privateUtaGetV3PositionCurrentPosition:async()=>response({list:null}),
  });
  const overview=await combined.adapter.fetchAccountOverview();
  assert.equal(overview.positionCount,0);assert.equal(overview.freeUsd,300);assert.equal(overview.executionSupported,true);
  assert.equal(overview.warnings,undefined);
  assert.deepEqual(await combined.adapter.fetchAccount(),{freeUsd:300,equityUsd:500,positions:[]});
  await assert.rejects(combined.adapter.place(request,.1,60000),/must be explicitly configured/);
  assert.ok(!combined.calls.some(c=>['leverage','place','cancel'].includes(c.method)));
});

test('UTA does not invent balances or downgrade malformed/unified-transition responses to Classic',async()=>{
  for(const change of [{accountEquity:undefined},{effEquity:null},{imr:''},{assets:[{...assets().assets[0],available:undefined}]},
    {assets:[{...assets().assets[0],equity:' '}]},{assets:[...assets().assets,...assets().assets]},{assets:undefined}]){
    await assert.rejects(setup({privateUtaGetV3AccountAssets:async()=>response({...assets(),...change})}).adapter.fetchAccountOverview(),/UTA/);
  }
  for(const accountMode of ['hybrid','upgrading','switching','unknown']){
    const s=setup({privateUtaGetV3AccountSettings:async()=>response({...settings(),accountMode})});
    await assert.rejects(s.adapter.fetchAccountOverview(),/unified account/);await assert.rejects(s.adapter.prepare(market.symbol,2));
  }
  const denied=setup({privateUtaGetV3AccountSettings:async()=>({code:'40014',msg:'sensitive error text',data:null})});
  await assert.rejects(denied.adapter.fetchAccountOverview(),e=>e instanceof Error&&!e.message.includes('sensitive'));
  const absent=await setup({privateUtaGetV3AccountAssets:async()=>response({...assets(),assets:[]})}).adapter.fetchAccountOverview();
  assert.equal(absent.usdtAvailableUsd,0);assert.equal(absent.freeUsd,0);
});

test('UTA account reading enforces valid quantities and reports incompatible held positions in overview',async()=>{
  const hedge=setup({privateUtaGetV3PositionCurrentPosition:async()=>response({list:[{...position(),holdMode:'hedge_mode'}]})});
  const overview=await hedge.adapter.fetchAccountOverview();assert.equal(overview.positionCount,1);assert.equal(overview.executionSupported,false);
  await assert.rejects(hedge.adapter.fetchAccount(),/position mode/);
  for(const change of [{total:undefined},{total:'-.1'},{markPrice:undefined},{liquidationPrice:''}]){
    const s=setup({privateUtaGetV3PositionCurrentPosition:async()=>response({list:[{...position(),...change}]})});await assert.rejects(s.adapter.fetchAccount());
  }
});

test('UTA hedge accounts preserve separate long and short quantities and reject duplicate side records',async()=>{
  const both=[{...position(),holdMode:'hedge_mode'},{...position(),holdMode:'hedge_mode',posSide:'short',total:'.07'}];
  const s=setup({privateUtaGetV3AccountSettings:async()=>response({...settings(),holdMode:'hedge_mode'}),
    privateUtaGetV3PositionCurrentPosition:async()=>response({list:both})});
  const account=await s.adapter.fetchAccount();
  assert.deepEqual(account.positions.map(p=>[p.side,p.quantity]),[['long',.12],['short',.07]]);
  const overview=await s.adapter.fetchAccountOverview();assert.equal(overview.positionCount,2);assert.equal(overview.executionSupported,true);
  s.client.privateUtaGetV3PositionCurrentPosition=async()=>response({list:[both[0],both[0]]});
  await assert.rejects(s.adapter.fetchAccount(),/duplicate UTA position/);
  s.client.privateUtaGetV3PositionCurrentPosition=async()=>response({list:[position()]});
  await assert.rejects(s.adapter.fetchAccount(),/position mode/);
});

test('UTA basic non-USDT assets do not increase the USDT trading budget and cannot hide debt or negative equity',async()=>{
  const extra={coin:'BGB',equity:'12',available:'12',debt:'0'};
  const s=setup({privateUtaGetV3AccountAssets:async()=>response({...assets(),accountEquity:'1500',effEquity:'1200',
    assets:[...assets().assets,extra,{coin:'USDC',equity:'900',available:'900',debt:'0'}]})});
  assert.equal((await s.adapter.fetchAccount()).freeUsd,321.125);
  assert.equal((await s.adapter.fetchAccountOverview()).executionSupported,true);
  for(const changed of [{debt:'1'},{debt:undefined},{equity:'-1'},{equity:undefined}]){
    s.client.privateUtaGetV3AccountAssets=async()=>response({...assets(),assets:[...assets().assets,{...extra,...changed}]});
    await assert.rejects(s.adapter.fetchAccount());
    assert.equal((await s.adapter.fetchAccountOverview()).executionSupported,false);
  }
  s.client.privateUtaGetV3AccountAssets=async()=>response({...assets(),assets:[{...assets().assets[0],available:'-1'}]});
  assert.equal((await s.adapter.fetchAccount()).freeUsd,0);
});

test('UTA prepare uses the verified cross margin setting and confirms leverage without switching account mode',async()=>{
  const s=setup();await s.adapter.prepare(market.symbol,3);
  assert.deepEqual(s.calls.filter(c=>c.method==='leverage').map(c=>c.params),[{category:'USDT-FUTURES',symbol:'BTCUSDT',leverage:'3',marginMode:'crossed'}]);
  assert.equal(s.calls.filter(c=>c.method==='settings').length,2);
  for(const overrides of [
    {privateUtaGetV3PositionCurrentPosition:async()=>response({list:[position()]})},
    {privateUtaGetV3TradeUnfilledOrders:async()=>response({list:[{orderId:'external'}]})},
    {privateUtaGetV3AccountSettings:async()=>response({...settings(),symbolConfigList:undefined})},
  ]){
    const s=setup(overrides);await assert.rejects(s.adapter.prepare(market.symbol,3));assert.ok(!s.calls.some(c=>c.method==='leverage'));
  }
  const stale=setup({privateUtaPostV3AccountSetLeverage:async()=>response('success')});
  await assert.rejects(stale.adapter.prepare(market.symbol,3),/could not be verified/);
});

test('UTA persisted crossed common leverage remains valid when optional side leverages are null',async()=>{
  // Recorded GET shape from a basic UTA hedge account: the null side fields are not
  // missing common leverage and must not cause an unnecessary initialization or write.
  const s=setup({privateUtaGetV3AccountSettings:async()=>response({...settings(),holdMode:'hedge_mode',symbolConfigList:[
    {category:'USDT-FUTURES',symbol:'BTCUSDT',marginMode:'crossed',leverage:'2',longLeverage:null,shortLeverage:null}]})});
  const adapter=new BitgetUta(s.client,'isolated');
  await adapter.inspectTrading(market.symbol,2);
  assert.deepEqual(await adapter.assertTradingMode(market.symbol),{
    marginMode:'crossed',holdMode:'hedge_mode',accountLevel:'basic',longLeverage:2,shortLeverage:2});
  await adapter.prepare(market.symbol,2);
  assert.ok(!s.calls.some(c=>['preview','leverage','place','cancel'].includes(c.method)));
  await new BitgetUta(s.client,'isolated').place({...request,reduceOnly:false},.1,60000);
  const payload=s.calls.find(c=>c.method==='place')!.params;
  assert.equal(payload.marginMode,'crossed');assert.equal(payload.posSide,'long');
  assert.equal(payload.reduceOnly,undefined);
});

test('UTA null optional side fields do not hide missing common leverage or conflicting cross leverage',async()=>{
  for(const change of [
    {leverage:null},{leverage:undefined},{leverage:''},{leverage:'0'},{leverage:'Infinity'},
    {longLeverage:'3',shortLeverage:null},{longLeverage:'invalid',shortLeverage:null},
  ]){
    const s=setup({privateUtaGetV3AccountSettings:async()=>response({...settings(),holdMode:'hedge_mode',symbolConfigList:[
      {category:'USDT-FUTURES',symbol:'BTCUSDT',marginMode:'crossed',leverage:'2',longLeverage:null,shortLeverage:null,...change}]})});
    await assert.rejects(new BitgetUta(s.client,'crossed').inspectTrading(market.symbol,2),/explicitly configured/);
    assert.ok(!s.calls.some(c=>['preview','leverage','place','cancel'].includes(c.method)));
  }
});

test('UTA empty known settings permits approved crossed preview while an unreadable list cannot initialize',async()=>{
  const empty=setup({privateUtaGetV3AccountSettings:async()=>response({...settings(),holdMode:'hedge_mode',symbolConfigList:[]})});
  await new BitgetUta(empty.client,'crossed').inspectTrading(market.symbol,2);
  assert.equal(empty.calls.find(c=>c.method==='preview')?.params.marginMode,'cross');
  assert.ok(!empty.calls.some(c=>['leverage','place','cancel'].includes(c.method)));
  for(const symbolConfigList of [undefined,null,{},'']){
    const s=setup({privateUtaGetV3AccountSettings:async()=>response({...settings(),symbolConfigList})});
    await assert.rejects(new BitgetUta(s.client,'crossed').inspectTrading(market.symbol,2),/configuration unavailable/);
    assert.ok(!s.calls.some(c=>['preview','leverage','place','cancel'].includes(c.method)));
  }
});

test('UTA first use initializes isolated hedge leverage only without exposure and verifies both sides across adapter instances',async()=>{
  const configured:Record<string,string>={};
  const s=setup({
    privateUtaGetV3AccountSettings:async()=>response({...settings(),holdMode:'hedge_mode',symbolConfigList:Object.entries(configured).map(([posSide,leverage])=>
      ({category:'USDT-FUTURES',symbol:'BTCUSDT',marginMode:'isolated',posSide,leverage}))}),
    privateUtaPostV3AccountSetLeverage:async(p:any)=>{s.calls.push({method:'leverage',params:p});configured[p.posSide]=p.leverage;return response('success');},
  });
  await s.adapter.prepare(market.symbol,2);
  assert.deepEqual(s.calls.filter(c=>c.method==='leverage').map(c=>c.params),['long','short'].map(posSide=>
    ({category:'USDT-FUTURES',symbol:'BTCUSDT',marginMode:'isolated',leverage:'2',posSide})));
  const fresh=new BitgetUta(s.client);await fresh.place(request,.1,60000);
  assert.equal(s.calls.find(c=>c.method==='place')?.params.posSide,'short');
  assert.equal(s.calls.find(c=>c.method==='place')?.params.marginMode,'isolated');
  assert.ok(s.calls.findIndex(c=>c.method==='positions')<s.calls.findIndex(c=>c.method==='leverage'));
  assert.ok(s.calls.findIndex(c=>c.method==='open-orders')<s.calls.findIndex(c=>c.method==='leverage'));
  assert.deepEqual(s.calls.find(c=>c.method==='preview')?.params,{category:'USDT-FUTURES',symbol:'BTCUSDT',marginMode:'isolated',leverage:'2'});
  for(const overrides of [
    {privateUtaGetV3PositionCurrentPosition:async()=>response({list:[{...position(),holdMode:'hedge_mode'}]})},
    {privateUtaGetV3TradeUnfilledOrders:async()=>response({list:[{orderId:'existing'}]})},
  ]){
    const blocked=setup({privateUtaGetV3AccountSettings:async()=>response({...settings(),holdMode:'hedge_mode',symbolConfigList:[]}),...overrides});
    await assert.rejects(blocked.adapter.prepare(market.symbol,2),/existing UTA position or pending order/);
    assert.ok(!blocked.calls.some(c=>c.method==='leverage'));
  }
});

test('UTA new crossed preference previews cross, initializes once and reads persisted crossed settings',async()=>{
  let row:any;
  const s=setup({privateUtaGetV3AccountSettings:async()=>response({...settings(),holdMode:'hedge_mode',symbolConfigList:row?[row]:[]}),
    privateUtaPostV3AccountSetLeverage:async(p:any)=>{s.calls.push({method:'leverage',params:p});row={...p};return response('success');}});
  const adapter=new BitgetUta(s.client,'crossed');
  await adapter.inspectTrading(market.symbol,2);
  assert.equal(s.calls.some(c=>c.method==='leverage'),false);
  await adapter.prepare(market.symbol,2);
  assert.deepEqual(s.calls.filter(c=>c.method==='preview').map(c=>c.params),Array(2).fill({category:'USDT-FUTURES',symbol:'BTCUSDT',marginMode:'cross',leverage:'2'}));
  assert.deepEqual(s.calls.filter(c=>c.method==='leverage').map(c=>c.params),[{category:'USDT-FUTURES',symbol:'BTCUSDT',marginMode:'crossed',leverage:'2'}]);
  await new BitgetUta(s.client,'isolated').place(request,.1,60000);
  assert.equal(s.calls.find(c=>c.method==='place')?.params.marginMode,'crossed');
  await adapter.prepare(market.symbol,2);
  assert.equal(s.calls.filter(c=>c.method==='leverage').length,1);
  assert.equal(s.calls.filter(c=>c.method==='preview').length,2);
});

test('UTA new symbol preview rejection or malformed estimate prevents writes and cannot substitute for settings readback',async()=>{
  for(const preview of [async()=>{throw Object.assign(new Error('offline validation'),{apiCode:'25200'});},
    ...[{},null,{requiredMargin:''},{requiredMargin:'-1'},{requiredMargin:'Infinity'}].map(data=>async()=>response(data))]){
    const s=setup({privateUtaGetV3AccountSettings:async()=>response({...settings(),symbolConfigList:[]}),privateUtaGetV3AccountPreSetLeverage:preview});
    const adapter=new BitgetUta(s.client,'crossed');
    await assert.rejects(adapter.inspectTrading(market.symbol,2));await assert.rejects(adapter.prepare(market.symbol,2));
    assert.ok(!s.calls.some(c=>['leverage','place'].includes(c.method)));
  }
  const s=setup({privateUtaGetV3AccountSettings:async()=>response({...settings(),symbolConfigList:[]})});
  await assert.rejects(new BitgetUta(s.client,'crossed').prepare(market.symbol,2),/explicitly configured/);
  assert.equal(s.calls.filter(c=>c.method==='leverage').length,1);
});

test('UTA crossed preference preserves existing isolated settings, skips matching side and verifies fresh no-op settings',async()=>{
  let longLeverage='2',shortLeverage='3',reads=0;
  const s=setup({privateUtaGetV3AccountSettings:async()=>{reads++;return response({...settings(),holdMode:'hedge_mode',symbolConfigList:[
    {category:'USDT-FUTURES',symbol:'BTCUSDT',marginMode:'isolated',longLeverage,shortLeverage}]});},
    privateUtaGetV3AccountPreSetLeverage:async()=>{throw new Error('existing settings must not preview');},
    privateUtaPostV3AccountSetLeverage:async(p:any)=>{s.calls.push({method:'leverage',params:p});shortLeverage=p.leverage;return response('success');}});
  const adapter=new BitgetUta(s.client,'crossed');await adapter.prepare(market.symbol,2);
  assert.deepEqual(s.calls.filter(c=>c.method==='leverage').map(c=>c.params),[{category:'USDT-FUTURES',symbol:'BTCUSDT',marginMode:'isolated',leverage:'2',posSide:'short'}]);
  await adapter.prepare(market.symbol,2);assert.equal(reads,4);assert.equal(s.calls.filter(c=>c.method==='leverage').length,1);
  s.client.privateUtaGetV3AccountSettings=async()=>{reads++;return response({...settings(),holdMode:'hedge_mode',symbolConfigList:[
    {category:'USDT-FUTURES',symbol:'BTCUSDT',marginMode:'isolated',longLeverage,shortLeverage:reads%2===0?'3':'2'}]});};
  await assert.rejects(adapter.prepare(market.symbol,2),/could not be verified/);
});

test('UTA isolated account rejects a new crossed preference before preview or writes',async()=>{
  const s=setup({privateUtaGetV3AccountSettings:async()=>response({...settings(),accountLevel:'isolated',symbolConfigList:[]})});
  const adapter=new BitgetUta(s.client,'crossed');
  await assert.rejects(adapter.inspectTrading(market.symbol,2),/isolated account cannot initialize crossed/);
  await assert.rejects(adapter.prepare(market.symbol,2),/isolated account cannot initialize crossed/);
  assert.ok(!s.calls.some(c=>['preview','leverage','place'].includes(c.method)));
});

test('UTA preparation rejects missing, partial, changed-mode or mismatched leverage readback',async()=>{
  for(const after of [
    {...settings(),holdMode:'hedge_mode',symbolConfigList:[]},
    {...settings(),holdMode:'hedge_mode',symbolConfigList:[{...settings().symbolConfigList[0],marginMode:'isolated',posSide:'long'}]},
    {...settings(),holdMode:'hedge_mode',symbolConfigList:[{...settings().symbolConfigList[0],marginMode:'isolated',longLeverage:'2',shortLeverage:'3'}]},
    {...settings(),holdMode:'hedge_mode',symbolConfigList:settings().symbolConfigList},
    {...settings(),holdMode:'one_way_mode',symbolConfigList:[{...settings().symbolConfigList[0],marginMode:'isolated'}]},
  ]){
    let wrote=false;
    const s=setup({privateUtaGetV3AccountSettings:async()=>response(wrote?after:{...settings(),holdMode:'hedge_mode',symbolConfigList:[]}),
      privateUtaPostV3AccountSetLeverage:async()=>{wrote=true;return response('success');}});
    await assert.rejects(s.adapter.prepare(market.symbol,2),/explicitly configured|could not be verified/);
    assert.ok(!s.calls.some(c=>c.method==='place'));
  }
});

test('UTA hedge isolated common long/short leverage fields are checked independently without changing holding mode',async()=>{
  let longLeverage='3',shortLeverage='4';
  const s=setup({privateUtaGetV3AccountSettings:async()=>response({...settings(),holdMode:'hedge_mode',symbolConfigList:[
    {category:'USDT-FUTURES',symbol:'BTCUSDT',marginMode:'isolated',longLeverage,shortLeverage}]}),
    privateUtaPostV3AccountSetLeverage:async(p:any)=>{s.calls.push({method:'leverage',params:p});
      if(p.posSide==='long')longLeverage=p.leverage;else shortLeverage=p.leverage;return response('success');}});
  await s.adapter.prepare(market.symbol,2);
  const verified=await new BitgetUta(s.client).assertTradingMode(market.symbol);
  assert.equal(verified.longLeverage,2);assert.equal(verified.shortLeverage,2);assert.equal(verified.holdMode,'hedge_mode');
});

test('UTA isolated account requires explicit isolated symbol mode and verifies both side leverage writes',async()=>{
  let leverage='2';const s=setup({
    privateUtaGetV3AccountSettings:async()=>response({...settings(),accountLevel:'isolated',symbolConfigList:[{...settings().symbolConfigList[0],marginMode:'isolated',leverage}]}),
    privateUtaPostV3AccountSetLeverage:async(p:any)=>{s.calls.push({method:'leverage',params:p});leverage=p.leverage;return response('success');},
  });
  assert.equal((await s.adapter.fetchAccount()).freeUsd,321.125);await s.adapter.prepare(market.symbol,3);
  assert.deepEqual(s.calls.filter(c=>c.method==='leverage').map(c=>c.params.posSide),['long','short']);
  assert.ok(s.calls.filter(c=>c.method==='leverage').every(c=>c.params.marginMode==='isolated'));
  const incompatible=setup({privateUtaGetV3AccountSettings:async()=>response({...settings(),accountLevel:'isolated'})});
  await assert.rejects(incompatible.adapter.prepare(market.symbol,2),/incompatible symbol/);
});

test('UTA IOC payload uses base quantity, verified margin mode, bounded price and stable client ID',async()=>{
  const s=setup();assert.equal(await s.adapter.place(request,.1,60000),undefined);
  assert.deepEqual(s.calls.find(c=>c.method==='place')?.params,{category:'USDT-FUTURES',symbol:'BTCUSDT',qty:'0.100',price:'60000.0',side:'buy',
    orderType:'limit',timeInForce:'ioc',marginMode:'crossed',pxAmendType:'no',clientOid:exchangeClientId('bitget',request.clientOrderId),reduceOnly:'yes'});
  await assert.rejects(s.adapter.place(request,.1,60000.07),/precision/);
  await assert.rejects(s.adapter.place(request,.11,60000),/precision/);
  assert.equal(s.calls.filter(c=>c.method==='place').length,1);
  const result=await s.adapter.reconcile(request);assert.equal(result.status,'partial');assert.equal(result.filledQuantity,.04);assert.equal(result.feeUsd,1.2);
  assert.deepEqual(s.calls.find(c=>c.method==='order-info')?.params,{clientOid:exchangeClientId('bitget',request.clientOrderId)});
  await s.adapter.place({...request,reduceOnly:false,clientOrderId:'uta-open-fixture'},.1,60000);
  assert.equal(s.calls.filter(c=>c.method==='place').at(-1)?.params.reduceOnly,'no');
  s.client.privateUtaGetV3TradeOrderInfo=async()=>response(order({reduceOnly:'yes'}));
  assert.equal((await s.adapter.reconcile(request)).status,'partial');
});

test('UTA hedge IOC maps all four open/close directions and validates returned position/trade side',async()=>{
  for(const [side,reduceOnly,posSide,tradeSide] of [
    ['buy',false,'long','open'],['sell',false,'short','open'],['sell',true,'long','close'],['buy',true,'short','close'],
  ] as const){
    const req={...request,side,reduceOnly,limitPrice:60000};
    const s=setup({privateUtaGetV3AccountSettings:async()=>response({...settings(),holdMode:'hedge_mode'}),
      privateUtaGetV3TradeOrderInfo:async()=>response(order({side,holdMode:'hedge_mode',posSide,tradeSide,reduceOnly:'NO'}))});
    await s.adapter.place(req,.1,60000);
    const params=s.calls.find(c=>c.method==='place')?.params;
    assert.equal(params.side,side);assert.equal(params.posSide,posSide);assert.equal(params.reduceOnly,undefined);assert.equal(params.tradeSide,undefined);
    const result=await new BitgetUta(s.client).reconcile(req);assert.equal(result.status,'partial');assert.equal(result.filledQuantity,.04);
    for(const changed of [{posSide:posSide==='long'?'short':'long'},{tradeSide:tradeSide==='open'?'close':'open'},{posSide:undefined},{tradeSide:undefined}]){
      s.client.privateUtaGetV3TradeOrderInfo=async()=>response(order({side,holdMode:'hedge_mode',posSide,tradeSide,reduceOnly:'NO',orderStatus:'live',...changed}));
      const prior={...unknownOrder(req),filledQuantity:.02,averagePrice:60000};
      const unknown=await s.adapter.reconcile(req,prior);assert.equal(unknown.status,'unknown');assert.equal(unknown.filledQuantity,.02);
    }
    assert.ok(!s.calls.some(c=>c.method==='cancel'));
  }
});

test('UTA anomalously live IOC cancellation requires a second terminal query and preserves observed exposure on failure',async()=>{
  let queries=0;const s=setup({privateUtaGetV3TradeOrderInfo:async()=>response(order(++queries===1?{orderStatus:'new'}:{cumExecQty:'.05',feeDetail:[{feeCoin:'USDT',fee:'1.5'}]}))});
  const result=await s.adapter.reconcile(request);assert.equal(result.status,'partial');assert.equal(result.filledQuantity,.05);assert.equal(result.feeUsd,1.5);
  assert.deepEqual(s.calls.find(c=>c.method==='cancel')?.params,{category:'USDT-FUTURES',orderId:'uta-order-1'});
  const failed=setup({privateUtaGetV3TradeOrderInfo:async()=>response(order({orderStatus:'partially_filled'})),privateUtaPostV3TradeCancelOrder:async()=>{throw new Error('timeout');}});
  const unknown=await failed.adapter.reconcile(request);assert.equal(unknown.status,'unknown');assert.equal(unknown.filledQuantity,.04);
  failed.client.privateUtaGetV3TradeOrderInfo=async()=>response(order({cumExecQty:'.01'}));
  assert.equal((await failed.adapter.reconcile(request,unknown)).filledQuantity,.04);
});

test('UTA missing fills stay unknown; unsupported fees preserve known quantity; unrelated orders never cancel',async()=>{
  for(const changes of [{clientOid:'other',orderStatus:'live'},{symbol:'ETHUSDT',orderStatus:'live'},{holdMode:'hedge_mode'},{qty:'.2'},{reduceOnly:'NO'}]){
    const s=setup({privateUtaGetV3TradeOrderInfo:async()=>response(order(changes))});
    assert.equal((await s.adapter.reconcile(request)).status,'unknown');assert.ok(!s.calls.some(c=>c.method==='cancel'));
  }
  for(const feeDetail of [undefined,[],[{feeCoin:'BGB',fee:'1.2'}],[{feeCoin:'USDT',fee:null}]]){
    const s=setup({privateUtaGetV3TradeOrderInfo:async()=>response(order({feeDetail}))}),result=await s.adapter.reconcile(request);
    assert.equal(result.status,'unknown');assert.equal(result.filledQuantity,.04);
  }
  const absent=setup({privateUtaGetV3TradeOrderInfo:async()=>{throw new Error('unknown');}});
  const prior={...unknownOrder(request),filledQuantity:.02,averagePrice:60000,feeUsd:.6};
  assert.deepEqual(await absent.adapter.reconcile(request,prior),{...prior,averagePriceVerified:false});assert.equal(absent.calls.length,0);
});

// Keep the invoice fixtures inside the exchange's actual ninety-day history window.
const now=Date.now()-32*86400000;
const bill=(id:string,type='CONTRACT_MAIN_SETTLE_FEE_USER_IN',amount='1')=>({id,category:'USDT-FUTURES',coin:'USDT',symbol:'BTCUSDT',type,amount,fee:'0',ts:String(now)});
test('UTA funding reads both cross and isolated funding types with signed receipts/payments',async()=>{
  const s=setup({privateUtaGetV3AccountFinancialRecords:async()=>response({list:[bill('1'),bill('2','CONTRACT_MAIN_SETTLE_FEE_USER_OUT','-.4'),
    bill('3','MARGIN_SETTLE_FEE_USER_IN','.3'),bill('4','MARGIN_SETTLE_FEE_USER_OUT','-.2'),bill('5','TRANSFER_IN','20'),{...bill('6'),coin:'USDC'},
    bill('7','FIXED_SETTLE_FEE_USER_IN','.7'),bill('8','FIXED_SETTLE_FEE_USER_OUT','-.8')],cursor:''})});
  assert.deepEqual((await s.adapter.fetchFundingPayments(now-1,now+1)).map(p=>[p.id,p.base,p.amountUsd]),[
    ['bitget:uta:1','BTC',1],['bitget:uta:2','BTC',-.4],['bitget:uta:3','BTC',.3],['bitget:uta:4','BTC',-.2],
    ['bitget:uta:7','BTC',.7],['bitget:uta:8','BTC',-.8]]);
});

test('UTA funding fixed windows paginate cursors, preserve overlap once and split 30-day bounds',async()=>{
  const calls:any[]=[];const s=setup({privateUtaGetV3AccountFinancialRecords:async(p:any)=>{
    calls.push(p);return response(calls.length===1?{list:[bill('1')],cursor:'older'}:calls.length===2?{list:[bill('1'),bill('2')],cursor:''}:{list:[],cursor:''});
  }});
  const rows=await s.adapter.fetchFundingPayments(now-1,now+31*86400000);assert.equal(rows.length,2);assert.equal(calls.length,3);
  assert.equal(calls[1].cursor,'older');assert.equal(calls[0].endTime,calls[1].endTime);
  assert.equal(Number(calls[2].startTime),Number(calls[0].endTime)+1);assert.ok(calls.every(c=>c.category==='USDT-FUTURES'&&c.coin==='USDT'&&c.limit==='100'));
});

test('UTA funding rejects malformed/conflicting/ambiguous invoices and non-advancing pagination',async()=>{
  for(const changed of [{amount:undefined},{type:'CONTRACT_MAIN_SETTLE_FEE_USER_OUT',amount:'1'},{symbol:'UNKNOWNUSDT'},
    {fee:'-.1'},{type:'MARGIN_SETTLE_FEE_USER_IN',amount:'0',positionAmount:'2'},
    {type:'FIXED_SETTLE_FEE_USER_IN',amount:'0',positionAmount:'2'},
    {type:'FIXED_SETTLE_FEE_USER_OUT',amount:'0',positionAmount:'-2'}]){
    const s=setup({privateUtaGetV3AccountFinancialRecords:async()=>response({list:[{...bill('1'),...changed}],cursor:''})});
    await assert.rejects(s.adapter.fetchFundingPayments(now-1,now+1));
  }
  const duplicate=setup({privateUtaGetV3AccountFinancialRecords:async()=>response({list:[bill('1'),bill('1','CONTRACT_MAIN_SETTLE_FEE_USER_IN','2')],cursor:''})});
  await assert.rejects(duplicate.adapter.fetchFundingPayments(now-1,now+1),/conflicting/);
  const cycle=setup({privateUtaGetV3AccountFinancialRecords:async()=>response({list:[bill('1')],cursor:'same'})});
  await assert.rejects(cycle.adapter.fetchFundingPayments(now-1,now+1),/cursor/);
  const wide=setup();await assert.rejects(wide.adapter.fetchFundingPayments(now-91*86400000,now),/90 days/);assert.equal(wide.calls.length,0);
});

test('installed CCXT provides every raw v3 endpoint required by UTA without performing network requests',()=>{
  const client=new ccxt.bitget();
  for(const name of ['privateUtaGetV3AccountSettings','privateUtaGetV3AccountAssets','privateUtaGetV3PositionCurrentPosition',
    'privateUtaGetV3TradeUnfilledOrders','privateUtaPostV3AccountSetLeverage','privateUtaPostV3TradePlaceOrder',
    'privateUtaGetV3TradeOrderInfo','privateUtaGetV3TradeFills','privateUtaPostV3TradeCancelOrder','privateUtaGetV3AccountFinancialRecords'])assert.equal(typeof(client as any)[name],'function',name);
});
