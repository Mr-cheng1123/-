import test, { type TestContext } from 'node:test';
import { ReadyHistory } from './ready-history.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Socket } from 'node:net';
import { CcxtAdapter } from '../src/adapters/ccxt.js';
import { Engine, safeMessage } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { defaultConfig } from './legacy-config.js';
import type { AppConfig, ExchangeId } from '../src/shared/types.js';
import type { FundingStatsDataset } from '../src/shared/funding-statistics.js';
import {attachBitgetFillFixture} from './bitget-fill-fixture.js';

const START=Date.UTC(2026,8,30,0,0,0),SYMBOL='BTC/USDT:USDT',PRICE=100;
const VENUES=['gate','bitget'] as const;
type Venue=typeof VENUES[number];
type Call={venue:Venue;method:string;params:any};
const ENV=Object.freeze({GATE_API_KEY:'fixture-gate',GATE_API_SECRET:'fixture-gate-secret',
  BITGET_API_KEY:'fixture-bitget',BITGET_API_SECRET:'fixture-bitget-secret',BITGET_PASSPHRASE:'fixture-passphrase'});

/** The prices, balances and settlements below are synthetic fixtures, never live account data. */
function setup(t:TestContext,options:{partialGate?:boolean;unknownGate?:boolean;parameterError?:boolean;bitgetCancel?:'once'|'always'}={}){
  let networkAttempts=0;
  const forbidden=()=>{networkAttempts++;throw new Error('Network is forbidden in the Gate/Bitget fixture flow');};
  t.mock.method(globalThis,'fetch',forbidden);
  t.mock.method(Socket.prototype,'connect',forbidden);
  t.mock.timers.enable({apis:['Date'],now:START});
  const directory=mkdtempSync(path.join(tmpdir(),'funding-gate-bitget-flow-'));
  const statePath=path.join(directory,'state.json'),calls:Call[]=[],settlement=START+60_000;
  const config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',exchanges:[...VENUES],symbols:['BTC'],
    feeOnly:true,paperFeeOnly:false,orderNotionalUsd:100,leverage:2,holdMode:'once',exitDelaySec:10,autoEnabled:false,bitgetNewSymbolMarginMode:'crossed',
    takerFees:{...defaultConfig.takerFees,gate:.0005,bitget:.0006},maxOrderRetries:2};
  const markets=Object.fromEntries(VENUES.map(venue=>[venue,{id:venue==='gate'?'BTC_USDT':'BTCUSDT',symbol:SYMBOL,base:'BTC',
    quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,contractSize:venue==='gate'?.001:1,
    precision:{amount:venue==='gate'?1:.001,price:.01},limits:{amount:{min:venue==='gate'?1:.001},cost:{min:1}}}])) as Record<Venue,any>;
  const quantity:Record<Venue,Record<'long'|'short',number>>={gate:{long:0,short:0},bitget:{long:0,short:0}};
  const gateOrders=new Map<string,any>(),bitgetOrders=new Map<string,any>();
  const gateLeverage:Record<string,string>={dual_long:'10',dual_short:'10'},bitgetLeverage=new Map<string,string>();
  let gateVisible=!options.unknownGate,gateFirst=true;
  const engines:Engine[]=[];
  const nextFunding=()=>Date.now()<settlement?settlement:settlement+8*3_600_000;
  const rate=(venue:Venue)=>venue==='gate'?.001:.01;
  const dataset=():FundingStatsDataset=>({source:'exchanges',range:'current',status:'ready',receivedAt:Date.now(),lastAttemptAt:Date.now(),
    nextRefreshAt:Date.now()+20000,maxAgeMs:120000,sourceUrl:'',marginScope:'local synthetic fixtures',rows:[{base:'BTC',cells:
      Object.fromEntries(VENUES.map(exchange=>[exchange,{exchange,rate:rate(exchange),intervalHours:8,nextFundingTime:nextFunding(),
        updatedAt:Date.now(),timestampKind:'received',available:true}]))}]});
  function client(venue:Venue):any{
    const market=markets[venue];
    const method=(name:string,fn:(p:any)=>any)=>async(p:any={})=>{calls.push({venue,method:name,params:structuredClone(p)});return fn(p);};
    const uta=(name:string,fn:(p:any)=>any)=>method(name,p=>({code:'00000',data:fn(p)}));
    const common={apiKey:`fixture-${venue}`,secret:'fixture-secret',password:'fixture-password',precisionMode:4,
      markets:{[SYMBOL]:market},loadMarkets:async()=>({[SYMBOL]:market}),market:()=>market,
      amountToPrecision:(_symbol:string,n:number)=>venue==='gate'?String(Math.floor(n)):(Math.round(n*1000)/1000).toFixed(3),
      priceToPrecision:(_symbol:string,n:number)=>(Math.round(n*100)/100).toFixed(2),
      fetch:forbidden,close:async()=>{},
      fetchTicker:method('ticker',()=>({timestamp:Date.now(),markPrice:PRICE,indexPrice:PRICE,quoteVolume:1e8,info:{holdingAmount:'1000000'}})),
      fetchOrderBook:method('book',()=>({timestamp:Date.now(),bids:[[PRICE,100/market.contractSize]],asks:[[PRICE,100/market.contractSize]]})),
      fetchFundingRate:method('funding-rate',()=>({timestamp:Date.now(),markPrice:PRICE,indexPrice:PRICE,fundingRate:rate(venue),interval:'8h',
        fundingTimestamp:nextFunding(),info:{position_size:'10000000',funding_interval:28800,fundingRateInterval:'8'}})),
      fetchFundingRateHistory:method('funding-history',()=>Array.from({length:8},(_,i)=>({timestamp:START-(8-i)*8*3_600_000,fundingRate:rate(venue)}))),
    };
    if(venue==='gate')return {...common,
      privateFuturesGetSettleFee:method('fee-rate',p=>{assert.equal(p.settle,'usdt');assert.equal(p.contract,market.id);
        return {[market.id]:{taker_fee:String(config.takerFees.gate)}};}),
      privateUnifiedGetAccounts:method('unified-account',()=>({mode:'single_currency',unified_account_total_equity:'500'})),
      privateFuturesGetSettleAccounts:method('account',()=>({currency:'USDT',available:'500',total:'500',unrealised_pnl:'0',position_mode:'dual_plus',
        in_dual_mode:true,enable_credit:true,enable_dual_plus:true,margin_mode:3,margin_mode_name:'single_currency'})),
      privateFuturesGetSettlePositions:method('positions',()=>Object.entries(quantity.gate).filter(([,q])=>q>0).map(([side,q])=>({
        contract:market.id,size:String(q/market.contractSize*(side==='long'?1:-1)),mode:`dual_${side}`,pid:side==='long'?'91001':'91002',
        pos_margin_mode:'cross',lever:gateLeverage[`dual_${side}`],leverage:'0',mark_price:String(PRICE),liq_price:side==='long'?'50':'150'}))),
      privateFuturesGetSettleGetLeverageContract:method('leverage-read',p=>({Lever:gateLeverage[p.dual_side]})),
      privateFuturesGetSettleOrders:method('pending',p=>p.status==='open'||!gateVisible?[]:[...gateOrders.values()]),
      privateFuturesGetSettlePriceOrders:method('pending-conditional',()=>[]),
      privateFuturesPostSettlePositionsContractSetLeverage:method('leverage-write',p=>{assert.equal(p.dual_side,undefined);gateLeverage.dual_long=p.leverage;gateLeverage.dual_short=p.leverage;return{};}),
      privateFuturesPostSettleOrders:method('place',p=>{
        const id=String(10000+gateOrders.size),size=Number(p.size),side=p.reduce_only?(size<0?'long':'short'):(size>0?'long':'short');
        const filledContracts=Math.abs(size)*(gateFirst&&options.partialGate&&!p.reduce_only?.6:1);
        const filled=filledContracts*market.contractSize;
        quantity.gate[side]=Math.max(0,quantity.gate[side]+filled*(p.reduce_only?-1:1));
        const raw={...p,id,status:'finished',finish_as:'ioc',left:String(Math.sign(size)*(Math.abs(size)-filledContracts)),
          fill_price:p.price,is_reduce_only:p.reduce_only,is_close:false,create_time_ms:Date.now(),finish_time_ms:Date.now()};
        delete raw.pid;gateOrders.set(id,raw);gateFirst=false;
        if(!gateVisible)throw new Error('fixture lost acknowledgement');return{id};
      }),
      privateFuturesGetSettleOrdersOrderId:method('order-info',p=>{
        if(!gateVisible)throw new Error('fixture order temporarily unqueryable');
        const order=gateOrders.get(p.order_id)??[...gateOrders.values()].find(o=>o.text===p.order_id);
        if(!order)throw new Error('fixture order missing');return order;
      }),
      privateFuturesGetSettleMyTrades:method('trades',p=>{
        const o=gateOrders.get(p.order),filled=Number(o.size)-Number(o.left);
        return[{id:`${o.id}1`,order_id:o.id,contract:market.id,size:String(filled),price:o.price,fee:String(Math.abs(filled)*market.contractSize*PRICE*config.takerFees.gate),point_fee:'0'}];
      }),
      privateFuturesDeleteSettleOrdersOrderId:method('cancel',p=>gateOrders.get(p.order_id)),
      privateFuturesGetSettleAccountBook:method('funding-ledger',()=>Date.now()>=settlement?[{id:'81001',contract:market.id,time:settlement/1000,change:'-0.1'}]:[]),
    };
    const utaClient={...common,
      privateUtaGetV3AccountFeeRate:uta('fee-rate',p=>{assert.equal(p.category,'USDT-FUTURES');assert.equal(p.symbol,market.id);
        return {takerFeeRate:String(config.takerFees.bitget)};}),
      privateUtaGetV3AccountSettings:uta('settings',()=>({accountMode:'unified',accountLevel:'basic',holdMode:'hedge_mode',assetMode:'multi_assets',deltaSwitch:'no',
        symbolConfigList:bitgetLeverage.size===2?[{category:'USDT-FUTURES',symbol:market.id,marginMode:'crossed',
          longLeverage:bitgetLeverage.get('long'),shortLeverage:bitgetLeverage.get('short')}]:[]})),
      privateUtaGetV3AccountAssets:uta('assets',()=>({accountEquity:'600',effEquity:'550',imr:'0',assets:[
        {coin:'USDT',equity:'500',available:'500',debt:'0'},{coin:'BGB',equity:'1',available:'1',debt:'0'}]})),
      privateUtaGetV3PositionCurrentPosition:uta('positions',()=>({list:Object.entries(quantity.bitget).filter(([,q])=>q>0).map(([side,q])=>({
        category:'USDT-FUTURES',symbol:market.id,marginCoin:'USDT',holdMode:'hedge_mode',posSide:side,marginMode:'crossed',
        total:String(q),leverage:bitgetLeverage.get(side),markPrice:String(PRICE),liquidationPrice:side==='long'?'50':'150'}))})),
      privateUtaGetV3TradeUnfilledOrders:uta('pending',()=>({list:[],cursor:''})),
      privateUtaGetV3AccountPreSetLeverage:uta('leverage-preview',p=>{
        assert.deepEqual(p,{category:'USDT-FUTURES',symbol:market.id,marginMode:'cross',leverage:'2'});
        assert.equal(bitgetLeverage.size,0,'configured contracts must retain their existing mode without a new-symbol preview');
        assert.equal(quantity.bitget.long+quantity.bitget.short,0);
        if(options.parameterError)throw new Error('bitget {"code":"25200","msg":"private-canary validation failure"}');
        return{estMaxOpen:'1000',requiredMargin:'0',marginChange:'0',estMaxBorrowable:'0'};
      }),
      privateUtaPostV3AccountSetLeverage:uta('leverage-write',p=>{
        assert.equal(p.marginMode,'crossed');assert.equal(p.posSide,undefined);
        bitgetLeverage.set('long',p.leverage);bitgetLeverage.set('short',p.leverage);return 'success';
      }),
      privateUtaPostV3TradePlaceOrder:uta('place',p=>{
        const orderId=String(20000+bitgetOrders.size),side=p.posSide as 'long'|'short',open=(p.side==='buy')===(side==='long');
        const cancelled=open&&(options.bitgetCancel==='always'||options.bitgetCancel==='once'&&bitgetOrders.size===0),filled=cancelled?0:Number(p.qty);
        quantity.bitget[side]=Math.max(0,quantity.bitget[side]+filled*(open?1:-1));
        bitgetOrders.set(orderId,{...p,orderId,holdMode:'hedge_mode',tradeSide:`${open?'open':'close'}_${p.posSide}`,reduceOnly:'NO',orderStatus:cancelled?'cancelled':'filled',
          cumExecQty:String(filled),avgPrice:cancelled?'0':p.price,updatedTime:String(Date.now()),
          feeDetail:cancelled?[{feeCoin:'',fee:''}]:[{feeCoin:'USDT',fee:String(filled*PRICE*config.takerFees.bitget)}],cancelReason:cancelled?'ioc_not_full_cancel':''});
        return{orderId,clientOid:p.clientOid};
      }),
      privateUtaGetV3TradeOrderInfo:uta('order-info',p=>{
        const order=bitgetOrders.get(p.orderId)??[...bitgetOrders.values()].find(o=>o.clientOid===p.clientOid);
        if(!order)throw new Error('fixture order missing');return order;
      }),
      privateUtaPostV3TradeCancelOrder:uta('cancel',()=>({})),
      privateUtaGetV3AccountFinancialRecords:uta('funding-ledger',()=>({list:Date.now()>=settlement?[{id:'82001',category:'USDT-FUTURES',
        type:'FIXED_SETTLE_FEE_USER_IN',coin:'USDT',symbol:market.id,amount:'1',fee:'0',positionAmount:'1',ts:String(settlement)}]:[],cursor:''})),
    };
    attachBitgetFillFixture(utaClient,p=>calls.push({venue,method:'fills',params:p}));
    return utaClient;
  }
  function makeEngine(){
    const store=new Store(statePath,structuredClone(config));
    // Prevent construction of any real CCXT client; inject actual adapters before the first operation.
    const savedConfig=store.data.config;store.data.config={...savedConfig,exchanges:[]};
    const engine=new Engine(store,false,{liveEnvironment:ENV,fundingStatistics:dataset,spreadHistory:new ReadyHistory()});
    store.data.config=savedConfig;
    engine.adapters=VENUES.map(venue=>new CcxtAdapter(venue,store.data.config,client(venue)));
    engine.health=VENUES.map(exchange=>({exchange,status:'connecting',latencyMs:0,lastSuccess:0}));
    engines.push(engine);return engine;
  }
  const engine=makeEngine();
  t.after(async()=>{
    for(const current of engines)await current.stop();
    assert.equal(networkAttempts,0,'no real HTTP or socket attempt may occur');
    assert(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep));
    rmSync(directory,{recursive:true,force:true});
  });
  return {engine,calls,config,settlement,quantity,makeEngine,
    moveTime:(time:number)=>t.mock.timers.setTime(time),revealGate:()=>{gateVisible=true;},
    count:(method:string,venue?:ExchangeId)=>calls.filter(c=>c.method===method&&(!venue||c.venue===venue)).length};
}

async function authorizeAndVerify(f:ReturnType<typeof setup>){
  await f.engine.tick();
  assert.equal(f.engine.liveUnlocked,false);assert.equal(f.count('place'),0);
  const preflight=await f.engine.tradingPreflight();
  assert.equal(preflight.canStart,true);assert.equal(preflight.executionUnlocked,false);
  assert.deepEqual(preflight.accounts.map(a=>a.status),['ready','ready']);
  assert.equal(f.count('leverage-write'),0);assert.equal(f.count('place'),0);
  // This invokes only the in-memory Engine; there is no HTTP server or real exchange client.
  await f.engine.startLive('START_LIVE_TRADING');assert.equal(f.engine.liveUnlocked,true);
  await f.engine.control('pause');assert.equal(f.engine.autoEnabled,false);
  // Supply actual native GET fixture observations; live economics must not invent account fees from config.
  for(const adapter of f.engine.adapters)assert.equal((await adapter.fetchTradingFee!(SYMBOL))?.takerFeeSource,'exchange');
  const candidate=await f.engine.verifyFundingCandidate('BTC-gate-bitget');
  assert(candidate?.eligible,JSON.stringify(candidate?.reasons));
  assert.equal(candidate.notionalUsd,100);assert.equal(candidate.longQuantity,1);assert.equal(candidate.shortQuantity,1);
  assert(Math.abs(candidate.expectedNetUsd-.88)<1e-10,String(candidate.expectedNetUsd));
  assert.equal(f.count('leverage-write'),0);assert.equal(f.count('place'),0);
  return candidate;
}

test('100U Gate dual_plus + Bitget hedge round trip verifies both legs, repairs a partial fill, books one funding and closes flat',async t=>{
  const f=setup(t,{partialGate:true}),candidate=await authorizeAndVerify(f);
  const opened=await f.engine.open(candidate.id);
  assert.equal(opened.status,'open');assert.equal(opened.long.quantity,1);assert.equal(opened.short.quantity,1);
  assert.equal(opened.deltaUsd,0);assert.equal(f.count('place','gate'),2);assert.equal(f.count('place','bitget'),1);
  assert(Math.abs(opened.feesUsd-.11)<1e-10);
  const firstWrite=f.calls.findIndex(c=>c.method==='leverage-write');
  assert(VENUES.every(venue=>f.calls.slice(0,firstWrite).some(c=>c.venue===venue&&c.method==='pending')));
  assert(f.calls.slice(0,firstWrite).some(c=>c.venue==='bitget'&&c.method==='leverage-preview'));
  const gateEntries=f.calls.filter(c=>c.venue==='gate'&&c.method==='place');
  assert.deepEqual(gateEntries.map(c=>Number(c.params.size)),[1000,400]);
  assert(gateEntries.every(c=>c.params.pos_margin_mode==='cross'&&!c.params.reduce_only&&!Object.hasOwn(c.params,'auto_size')));
  const bitgetEntry=f.calls.find(c=>c.venue==='bitget'&&c.method==='place')!;
  assert.equal(bitgetEntry.params.side,'sell');assert.equal(bitgetEntry.params.posSide,'short');
  assert.equal(bitgetEntry.params.marginMode,'crossed');assert.equal(f.count('leverage-write','bitget'),1);
  assert.equal(bitgetEntry.params.reduceOnly,undefined);
  f.moveTime(START+20_000);await f.engine.tick();assert.equal(opened.status,'open');assert.equal(opened.fundingUsd,0);
  f.moveTime(f.settlement+1000);await f.engine.tick();
  assert.equal(opened.status,'open');assert.equal(opened.fundingEvents.length,2);
  assert(Math.abs(opened.fundingUsd-.9)<1e-10);
  f.moveTime(f.settlement+20_000);await f.engine.tick();
  assert.equal(opened.status,'closed');assert.equal(opened.long.quantity,0);assert.equal(opened.short.quantity,0);assert.equal(opened.deltaUsd,0);
  assert.equal(f.engine.store.data.fundingSeen.length,2);assert.equal(opened.fundingEvents.length,2);
  assert(Math.abs(opened.feesUsd-.22)<1e-10);assert(Math.abs(opened.netPnlUsd-.68)<1e-10);assert.equal(opened.spreadPnlUsd,0);
  assert.equal(f.count('place'),5);assert.equal(f.engine.store.data.orders.length,5);
  assert.deepEqual(f.quantity,{gate:{long:0,short:0},bitget:{long:0,short:0}});
  const closes=f.calls.filter(c=>c.method==='place').slice(-2);
  assert(closes.some(c=>c.venue==='gate'&&c.params.reduce_only===true&&Number(c.params.size)===-1000&&c.params.pid==='91001'));
  assert(closes.some(c=>c.venue==='bitget'&&c.params.side==='buy'&&c.params.posSide==='short'));
  assert.equal(f.engine.store.data.killSwitch,false);assert.equal(f.engine.autoEnabled,false);
});

test('unknown Gate acknowledgement freezes the pair; restart restores by original ID and closes without duplicate submission',async t=>{
  const f=setup(t,{unknownGate:true}),candidate=await authorizeAndVerify(f);
  const opened=await f.engine.open(candidate.id);
  assert.equal(opened.status,'attention');assert.equal(f.engine.store.data.killSwitch,false);
  assert.equal(f.count('place'),2);assert.equal(f.engine.store.data.orders.filter(o=>o.result?.status==='unknown').length,1);
  const originalIds=f.engine.store.data.orders.map(o=>o.request.clientOrderId);
  await f.engine.stop();
  const restored=f.makeEngine();assert.equal(restored.liveUnlocked,false);assert.equal(restored.autoEnabled,false);
  await restored.tick();
  const readiness=await restored.tradingPreflight();assert.equal(readiness.canStart,true);assert.equal(readiness.canRecover,true);
  assert(readiness.excludedCoins?.some(item=>item.base===opened.base));
  await restored.recoverLive('RESTORE_LIVE_MANAGEMENT');assert.equal(restored.autoEnabled,false);assert.equal(f.count('place'),2);
  f.revealGate();await restored.control('reconcile');
  const position=restored.activePositions()[0];assert.equal(position.long.quantity,1);assert.equal(position.short.quantity,1);
  // No persisted global stop after a restart, so a fully reconciled pair is managed again without a separate "resume".
  assert.equal(position.status,'open');assert(Math.abs(position.feesUsd-.11)<1e-10);
  await restored.control('reconcile');assert(Math.abs(position.feesUsd-.11)<1e-10);
  assert.deepEqual(restored.store.data.orders.map(o=>o.request.clientOrderId),originalIds);assert.equal(f.count('place'),2);
  await restored.control('resume');assert.equal(position.status,'open');assert.equal(restored.autoEnabled,false);
  await restored.close(position.id);assert.equal(position.status,'closed');assert.equal(f.count('place'),4);
  assert.deepEqual(f.quantity,{gate:{long:0,short:0},bitget:{long:0,short:0}});
  assert.equal(restored.store.data.orders.some(o=>!o.result||o.result.status==='unknown'),false);
});

test('Bitget new-symbol preview rejects 25200 before either leg prepares leverage or records any order intent',async t=>{
  const f=setup(t,{parameterError:true}),candidate=await authorizeAndVerify(f);
  await assert.rejects(f.engine.open(candidate.id),(error:unknown)=>{
    assert.match(safeMessage(error),/Bitget.*合约检查.*25200/);assert.match(safeMessage(error),/参数校验/);
    assert.doesNotMatch(safeMessage(error),/private-canary/);return true;
  });
  assert.equal(f.count('leverage-write'),0);assert.equal(f.count('place'),0);
  assert.equal(f.engine.store.data.orders.length,0);assert.equal(f.engine.store.data.positions.length,0);
  assert.deepEqual(f.quantity,{gate:{long:0,short:0},bitget:{long:0,short:0}});
});

test('ONE zero-fill IOC response replay: engine confirms cancellation and repairs the missing leg without unknown-order freeze',async t=>{
  const f=setup(t,{bitgetCancel:'once'}),candidate=await authorizeAndVerify(f);
  const p=await f.engine.open(candidate.id);
  assert.equal(p.status,'open');assert.equal(p.long.quantity,1);assert.equal(p.short.quantity,1);
  assert.equal(f.count('place','gate'),1);assert.equal(f.count('place','bitget'),2);
  const orders=f.engine.store.data.orders;assert.equal(orders.filter(o=>o.result?.status==='unknown').length,0);
  assert.equal(orders.find(o=>o.exchange==='bitget')?.result?.status,'cancelled');
  assert.equal(orders.find(o=>o.exchange==='bitget')?.result?.filledQuantity,0);
  assert.equal(new Set(orders.map(o=>o.request.clientOrderId)).size,orders.length);
  assert.deepEqual(f.quantity,{gate:{long:1,short:0},bitget:{long:0,short:1}});
});

test('ONE zero-fill IOC response replay: persistent short cancellation never opens or unwinds the long',async t=>{
  const f=setup(t,{bitgetCancel:'always'}),candidate=await authorizeAndVerify(f);
  const p=await f.engine.open(candidate.id);
  assert.equal(p.status,'closed');assert.equal(p.long.quantity,0);assert.equal(p.short.quantity,0);
  assert.equal(f.engine.store.data.orders.some(o=>o.result?.status==='unknown'),false);
  assert.deepEqual(f.quantity,{gate:{long:0,short:0},bitget:{long:0,short:0}});
  assert.equal(f.calls.filter(c=>c.venue==='gate'&&c.method==='place').length,0);
  assert.ok(f.calls.filter(c=>c.venue==='bitget'&&c.method==='place').length>=1);
  assert.match(p.closeReason??'',/未提交/);
});
