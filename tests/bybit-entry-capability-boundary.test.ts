import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {OrderNotSubmittedError} from '../src/adapters/order-rejection.js';
import {Execution} from '../src/core/execution.js';
import {Store} from '../src/core/store.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest,Position} from '../src/shared/types.js';

// All private methods below are deterministic mocks. No exchange transport or real credentials.
const symbol='LAOPU/USDT:USDT',base='LAOPU';
const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,marginMode:'crossed' as const,
  entryPolicy:'aligned' as const,maxEntryBatches:1,maxOrderRetries:0,orderNotionalUsd:100,dualAdvantageEnabled:false};
const request=(clientOrderId='capability-open'):OrderRequest=>({clientOrderId,base,symbol,side:'buy',quantity:.6,limitPrice:41.84,reduceOnly:false});

function fixture(info:Record<string,unknown>={symbolType:'stock',marketRegion:'HK',underlyingTicker:'6181HK'}){
  const calls:Array<{method:'GET'|'POST';name:string;params:any}>=[],orders=new Map<string,any>();
  const m={id:'LAOPUUSDT',symbol,base,quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,contractSize:1,
    precision:{amount:.01,price:.01},limits:{amount:{min:.01,max:10000},cost:{min:5}},info};
  const holding={side:'',size:0};
  const ok=(result:any)=>({retCode:0,retMsg:'OK',result,time:Date.now()});
  const read=(name:string,params:any,result:any)=>{calls.push({method:'GET',name,params});return ok(result);};
  const client:any={apiKey:'offline-only',secret:'offline-only',precisionMode:4,has:{fetchMyTrades:false},markets:{[symbol]:m},
    loadMarkets:async()=>({[symbol]:m}),market:()=>m,amountToPrecision:(_s:string,n:number)=>String(n),priceToPrecision:(_s:string,n:number)=>String(n),
    privateGetV5AccountInfo:async(params:any)=>read('account',params,{unifiedMarginStatus:5,marginMode:'REGULAR_MARGIN'}),
    privateGetV5AccountWalletBalance:async(params:any)=>read('wallet',params,{list:[{accountType:'UNIFIED',totalEquity:'1000',totalAvailableBalance:'1000',
      coin:[{coin:'USDT',walletBalance:'1000',equity:'1000',usdValue:'1000',totalPositionIM:'0',totalOrderIM:'0',locked:'0',bonus:'0',borrowAmount:'0',spotBorrow:'0',accruedInterest:'0'}]}]}),
    privateGetV5PositionList:async(params:any)=>read('positions',params,{category:'linear',nextPageCursor:'',list:[
      {symbol:m.id,positionIdx:0,side:holding.side,size:String(holding.size),leverage:'2'}]}),
    privateGetV5OrderRealtime:async(params:any)=>read('realtime',params,{category:'linear',nextPageCursor:'',list:params.openOnly===0?[]:
      [...orders.values()].filter(row=>row.orderId===params.orderId||row.orderLinkId===params.orderLinkId)}),
    privateGetV5OrderHistory:async(params:any)=>read('history',params,{category:'linear',nextPageCursor:'',list:
      [...orders.values()].filter(row=>row.orderId===params.orderId||row.orderLinkId===params.orderLinkId)}),
    privatePostV5OrderCreate:async(params:any)=>{
      calls.push({method:'POST',name:'create',params});const orderId=`mock-${orders.size+1}`;
      const quantity=Number(params.qty);holding.side=params.reduceOnly?'':params.side;
      holding.size=params.reduceOnly?Math.max(0,holding.size-quantity):holding.size+quantity;
      orders.set(orderId,{...params,orderId,orderStatus:'Filled',cumExecQty:params.qty,avgPrice:params.price,
        cumFeeDetail:{USDT:'.01'},extraFees:'',updatedTime:String(Date.now())});
      return ok({orderId,orderLinkId:params.orderLinkId});
    },
    privateGetV5AccountInstrumentsInfo:async(params:any)=>{calls.push({method:'GET',name:'account-instruments',params});throw new Error('Unexpected new private instrument GET');},
    privateGetV5UserQueryApi:async(params:any)=>{calls.push({method:'GET',name:'key-permissions',params});throw new Error('Unexpected new API permissions GET');},
    privatePostV5UserAgreement:async(params:any)=>{calls.push({method:'POST',name:'agreement',params});throw new Error('Unexpected agreement POST');},close:async()=>{}};
  return {calls,m,holding,adapter:new CcxtAdapter('bybit',config,client)};
}

test('actual CCXT opening validation rejects all extra product markers without native GETs or registration',async()=>{
  for(const info of [{symbolType:'stock'},{symbolType:'ETF'},{symbolType:'commodity'},{symbolType:'forex'},
    {symbolType:'future-tradfi-type',marketRegion:'HK'},{symbolType:'',underlyingTicker:'6181HK'}]){
    const f=fixture(info);try{
      await assert.rejects(f.adapter.validateOrder(request()),(error:unknown)=>
        error instanceof OrderNotSubmittedError&&error.rejectionCode==='UNVERIFIED_PRODUCT_ACCESS');
      assert.deepEqual(f.calls,[]);assert.equal((f.adapter as any).submitted.size,0);
    }finally{await f.adapter.close();}
  }
});

test('direct CCXT placement, new client IDs and same-ID retry cannot bypass unverified product access',async()=>{
  const f=fixture();try{
    await f.adapter.prepareTrading(symbol,2);f.calls.length=0;
    for(const id of ['original-id','different-id','original-id']){
      const receipt=await f.adapter.placeOrder(request(id));
      assert.equal(receipt.status,'cancelled');assert.equal(receipt.id,'');assert.equal(receipt.filledQuantity,0);
      assert.equal(receipt.rejectionCode,'UNVERIFIED_PRODUCT_ACCESS');assert.equal(receipt.confirmation?.stage,'pre-submit');
      assert.equal(receipt.confirmation?.reason,'pre-submit-failed');
      assert.deepEqual(await f.adapter.reconcileOrder(request(id)),receipt);
    }
    assert.deepEqual(f.calls,[]);assert.equal(f.holding.size,0);
  }finally{await f.adapter.close();}
});

test('ordinary crypto still uses the existing native create and receipt path without new capability requests',async()=>{
  for(const symbolType of ['','innovation']){
    const f=fixture({symbolType,marketRegion:'',underlyingTicker:''});try{
      await f.adapter.prepareTrading(symbol,2);f.calls.length=0;
      await f.adapter.validateOrder(request());assert.deepEqual([...f.calls],[]);
      const receipt=await f.adapter.placeOrder(request());
      assert.equal(receipt.status,'filled');assert.equal(receipt.filledQuantity,.6);assert.equal(f.holding.size,.6);
      assert.deepEqual(f.calls.map(call=>call.name),['account','positions','create','realtime']);
      assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
    }finally{await f.adapter.close();}
  }
});

test('actual CCXT stock reduction keeps native quantity/slot checks and executes without entry preparation',async()=>{
  const f=fixture();f.holding.side='Buy';f.holding.size=.6;
  const reduction={...request('explicit-reduction'),side:'sell' as const,reduceOnly:true};try{
    await f.adapter.validateOrder(reduction);assert(f.calls.every(call=>call.method==='GET'));f.calls.length=0;
    const receipt=await f.adapter.placeOrder(reduction);
    assert.equal(receipt.status,'filled');assert.equal(receipt.filledQuantity,.6);assert.equal(f.holding.size,0);
    assert.deepEqual(f.calls.map(call=>call.name),['account','positions','create','realtime']);
    assert.equal(f.calls.find(call=>call.name==='create')!.params.reduceOnly,true);
  }finally{await f.adapter.close();}
});

test('metadata changing after successful validation is refused again at the actual CCXT place boundary',async()=>{
  const f=fixture({symbolType:'',marketRegion:'',underlyingTicker:''});try{
    await f.adapter.prepareTrading(symbol,2);f.calls.length=0;
    await f.adapter.validateOrder(request());f.m.info.symbolType='stock';
    const receipt=await f.adapter.placeOrder(request());
    assert.equal(receipt.rejectionCode,'UNVERIFIED_PRODUCT_ACCESS');assert.deepEqual(f.calls,[]);
  }finally{await f.adapter.close();}
});

test('Execution with actual CCXT Bybit preflight sends neither leg when Bybit product access is unverified',async()=>{
  const root=path.resolve(tmpdir()),dir=mkdtempSync(path.join(root,'bybit-capability-'));
  const f=fixture();let gatePlacements=0;
  try{
    await f.adapter.prepareTrading(symbol,2);f.calls.length=0;
    const store=new Store(path.join(dir,'state.json'),config),quotes=new Map<ExchangeId,MarketSnapshot>();
    for(const exchange of ['bybit','gate'] as const)quotes.set(exchange,{exchange,base,symbol,markPrice:1,indexPrice:1,
      timestamp:Date.now(),observedAt:Date.now(),fundingRate:exchange==='bybit'?0:.01,nextFundingTime:Date.now()+300000,
      intervalHours:8,fundingHistory:[],bids:[{price:exchange==='bybit'?.999:1.02,quantity:1000}],
      asks:[{price:exchange==='bybit'?1:1.021,quantity:1000}],quantityStep:.01,minQuantity:.01,minNotional:5,
      contractSize:1,openInterestUsd:1e6,volume24hUsd:1e6,source:'public',takerFeeRate:config.takerFees[exchange],
      takerFeeAt:Date.now(),takerFeeSource:'exchange'});
    const p:Position={id:'preflight-no-first-leg',base,mode:'live',status:'opening',entryPolicy:'aligned',holdMode:'adaptive',
      long:{exchange:'bybit',symbol,side:'long',quantity:0,entryPrice:0,markPrice:1,feesUsd:0,liquidationDistancePct:null},
      short:{exchange:'gate',symbol,side:'short',quantity:0,entryPrice:0,markPrice:1,feesUsd:0,liquidationDistancePct:null},
      openedAt:Date.now(),plannedExitAt:Date.now()+300000,fundingUsd:0,feesUsd:0,transferCostUsd:0,spreadPnlUsd:0,
      realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
    store.data.positions.push(p);
    const gate={id:'gate',validateOrder:async()=>{},placeOrder:async()=>{gatePlacements++;throw new Error('Unexpected first Gate create');}} as unknown as ExchangeAdapter;
    const execution=new Execution(store,{config:()=>store.data.config,snapshot:exchange=>quotes.get(exchange as ExchangeId),
      adapter:exchange=>exchange==='bybit'?f.adapter:gate,liveUnlocked:()=>true,halt:()=>{},
      refreshSnapshots:async()=>{for(const quote of quotes.values()){quote.timestamp=Date.now();quote.observedAt=Date.now();quote.takerFeeAt=Date.now();}}});
    const validate=async()=>{const opportunity=calculateOpportunities([...quotes.values()],store.data.config)[0];
      assert.equal(opportunity.eligible,true,opportunity.reasons.join(';'));return {...opportunity,longQuantity:100,shortQuantity:100};};
    await assert.rejects(execution.open(p,100,100,validate),(error:unknown)=>
      error instanceof OrderNotSubmittedError&&error.rejectionCode==='UNVERIFIED_PRODUCT_ACCESS');
    assert.equal(gatePlacements,0);assert.deepEqual(f.calls,[]);assert.equal(store.data.orders.length,0);
    assert.equal(p.long.quantity,0);assert.equal(p.short.quantity,0);
  }finally{
    await f.adapter.close();const resolved=path.resolve(dir),relative=path.relative(root,resolved);
    assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(resolved).startsWith('bybit-capability-'));
    rmSync(resolved,{recursive:true,force:true});
  }
});
