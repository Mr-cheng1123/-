import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import ccxt from 'ccxt';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {defaultConfig} from './legacy-config.js';
import {inspectLiveStart} from '../src/core/live-start.js';
import {EXCHANGES,type OrderRequest} from '../src/shared/types.js';

const market={id:'BTC_USDT',symbol:'BTC/USDT:USDT',base:'BTC',quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,
  contractSize:.001,precision:{amount:1,price:.1},limits:{amount:{min:1},cost:{min:1}}};
const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,orderNotionalUsd:100,leverage:2};

/** Injected endpoint fixtures only; no exchange client or network is used. */
function fixture(){
  const calls:{name:string;params:any}[]=[],orders=new Map<string,any>(),leverages:Record<string,string>={dual_long:'10',dual_short:'10'};
  let positions:any[]=[],timeout=false;
  const method=(name:string,fn:(p:any)=>any)=>async(p:any)=>{calls.push({name,params:p});return fn(p);};
  const client:any={apiKey:'fixture',secret:'fixture',precisionMode:4,markets:{[market.symbol]:market},
    loadMarkets:async()=>({[market.symbol]:market}),market:()=>market,
    amountToPrecision:(_s:string,n:number)=>String(n),priceToPrecision:(_s:string,n:number)=>String(n),
    privateFuturesGetSettleAccounts:method('account',()=>({currency:'USDT',available:'400',total:'400',unrealised_pnl:'0',
      position_mode:'dual_plus',in_dual_mode:true,enable_credit:true,margin_mode:3,margin_mode_name:'single_currency'})),
    privateFuturesGetSettlePositions:method('positions',()=>positions),
    privateUnifiedGetAccounts:method('unified-account',()=>({mode:'single_currency',unified_account_total_equity:'400'})),
    privateFuturesGetSettleGetLeverageContract:method('leverage-read',p=>({Lever:leverages[p.dual_side]})),
    privateFuturesGetSettleOrders:method('orders',p=>p.status==='open'?[]:[...orders.values()]),
    privateFuturesGetSettlePriceOrders:method('conditional-orders',()=>[]),
    privateFuturesPostSettlePositionsContractSetLeverage:method('leverage-write',p=>{assert.equal(p.dual_side,undefined);leverages.dual_long=p.leverage;leverages.dual_short=p.leverage;return{};}),
    privateFuturesPostSettleOrders:method('place',p=>{
      const id=String(1000+orders.size),raw={...p,id,status:'finished',left:'0',fill_price:p.price,
        is_reduce_only:p.reduce_only,is_close:false,finish_time:1700000000};
      delete raw.pid; // Gate documents pid as write-only.
      orders.set(id,raw);if(timeout)throw new Error('fixture lost acknowledgement');return{id};
    }),
    privateFuturesGetSettleOrdersOrderId:method('order',p=>orders.get(p.order_id)??[...orders.values()].find(o=>o.text===p.order_id)),
    privateFuturesGetSettleMyTrades:method('trades',p=>{const o=orders.get(p.order);return[{id:'123',order_id:o.id,
      contract:market.id,size:o.size,price:o.price,fee:'0.05',point_fee:'0'}];}),
    privateFuturesDeleteSettleOrdersOrderId:method('cancel',()=>({})),
  };
  return {adapter:new CcxtAdapter('gate',config,client),calls,leverages,
    positions:(value:any[])=>{positions=value;},timeout:()=>{timeout=true;}};
}

test('Gate dual_plus startup and concrete-symbol inspection read actual mode without private writes',async()=>{
  const f=fixture();
  const readiness=await inspectLiveStart(config,{permissionGranted:false,exchanges:EXCHANGES.map(exchange=>({exchange,supported:true,credentialsConfigured:['gate','bitget'].includes(exchange)}))},
    {executionUnlocked:false,blockedReasons:[],adapter:exchange=>exchange==='gate'?f.adapter:{fetchAccount:async()=>({freeUsd:400,equityUsd:400,positions:[]})}});
  assert.equal(readiness.canStart,true);assert.match(readiness.accounts.find(a=>a.exchange==='gate')!.message,/双向分仓模式已核验/);
  await f.adapter.inspectTrading(market.symbol,2);
  assert.deepEqual(f.leverages,{dual_long:'10',dual_short:'10'});
  assert.ok(f.calls.every(c=>['account','unified-account','positions','orders','conditional-orders','leverage-read'].includes(c.name)));
  assert.deepEqual(f.calls.filter(c=>c.name==='leverage-read').map(c=>c.params.pos_margin_mode),['cross','cross']);
});

test('Gate signed account GETs aggregate slots without fee requests and explicit fee reads preserve exact native evidence',async()=>{
  const key='gate-offline-portfolio-key',secret='gate-offline-portfolio-secret',calls:{method:string;path:string;query:Record<string,string>}[]=[];
  const client:any=new ccxt.gate({apiKey:key,secret,enableRateLimit:false,options:{unifiedAccount:false,maxRetriesOnFailure:0}});
  client.setMarkets([{...market,type:'swap',spot:false,contract:true,inverse:false,baseId:'BTC',quoteId:'USDT',settleId:'USDT'}]);
  client.fetchImplementation=async(urlText:string,params:any)=>{
    const url=new URL(urlText),method=String(params.method),headers=new Headers(params.headers);
    assert.equal(url.hostname,'api.gateio.ws');assert.equal(method,'GET');assert.equal(params.body,undefined);assert.equal(headers.get('KEY'),key);
    const auth=[method,url.pathname,decodeURIComponent(url.search.slice(1)),createHash('sha512').update('').digest('hex'),headers.get('Timestamp')].join('\n');
    assert.equal(headers.get('SIGN'),createHmac('sha512',secret).update(auth).digest('hex'));
    const query=Object.fromEntries(url.searchParams);calls.push({method,path:url.pathname,query});let data:any;
    if(url.pathname==='/api/v4/futures/usdt/accounts')data={currency:'USDT',available:'400',total:'0',unrealised_pnl:'3',
      position_mode:'dual_plus',margin_mode:3,margin_mode_name:'single_currency'};
    else if(url.pathname==='/api/v4/futures/usdt/positions'){
      assert.equal(query.holding,'true');assert.equal(query.limit,undefined);
      data=[{contract:market.id,size:'10',mode:'dual_long',pos_margin_mode:'isolated',lever:'2',mark_price:'10000',liq_price:'5000',unrealised_pnl:'1'},
        {contract:market.id,size:'20',mode:'dual_long',pos_margin_mode:'cross',lever:'2',mark_price:'10000',liq_price:'0',unrealised_pnl:'2'}];
    }else if(url.pathname==='/api/v4/unified/accounts')data={unified_account_total_equity:'403'};
    else if(url.pathname==='/api/v4/futures/usdt/fee'){assert.equal(query.contract,market.id);data={[market.id]:{taker_fee:'.0005'}};}
    else throw new Error('Unexpected offline portfolio route');
    return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const adapter=new CcxtAdapter('gate',config,client);
  try{
    const first=await adapter.fetchPortfolioAccount();
    assert.deepEqual(first.positions.map(p=>[p.quantity,p.marginMode,p.unrealizedPnlUsd,p.positionId,p.splitPositionCount]),[[.03,undefined,3,undefined,2]]);
    assert.equal(first.positions[0].liquidationStatus,'unavailable');assert.equal(first.positions[0].liquidationPrice,0);
    assert.equal(first.freeUsd,400);assert.equal(first.equityUsd,403);
    await new Promise<void>(resolve=>setImmediate(resolve));
    const second=await adapter.fetchPortfolioAccount();assert.ok(second.positions.every(p=>p.takerFeeRate===undefined&&p.takerFeeSource===undefined));
    assert.equal((await adapter.fetchAccount()).positions[0].quantity,.03);
    assert.equal(calls.filter(c=>c.path==='/api/v4/futures/usdt/fee').length,0,'account quantities never warm private fees');
    const fee=await adapter.fetchTradingFee(market.symbol);assert.equal(fee?.takerFeeRate,.0005);assert.equal(fee?.takerFeeSource,'exchange');
    const afterAction=await adapter.fetchPortfolioAccount();assert.ok(afterAction.positions.every(p=>p.takerFeeRate===.0005&&p.takerFeeSource==='exchange'));
    assert.ok(afterAction.positions.every(p=>p.feeReference?.source==='account-reference'&&p.feeReference.takerRate===.0005));
    assert.equal(calls.filter(c=>c.path==='/api/v4/futures/usdt/fee').length,1);
    assert.ok(calls.every(c=>c.method==='GET'));
  }finally{await adapter.close();}
});

test('Gate native adapter preserves preparation across helpers and maps all four bounded order directions',async()=>{
  const f=fixture();await f.adapter.prepareTrading(market.symbol,2);
  const writes=f.calls.filter(c=>c.name==='leverage-write');assert.equal(writes.length,1);
  assert.ok(writes.every(c=>c.params.margin_mode==='cross'&&c.params.leverage==='2'));
  for(const [side,reduceOnly,positionSide] of [['buy',false,'dual_long'],['sell',false,'dual_short'],['sell',true,'dual_long'],['buy',true,'dual_short']] as const){
    f.positions(reduceOnly?[{contract:market.id,mode:positionSide,size:positionSide==='dual_long'?'10':'-10',pos_margin_mode:'isolated',pid:'987'}]:[]);
    const request:OrderRequest={base:'BTC',symbol:market.symbol,clientOrderId:`gate-${side}-${reduceOnly}`,side,reduceOnly,quantity:.01,limitPrice:10000};
    const result=await f.adapter.placeOrder(request);assert.equal(result.status,'filled');assert.equal(result.filledQuantity,.01);assert.equal(result.feeUsd,.05);
    const payload=f.calls.filter(c=>c.name==='place').at(-1)!.params;
    assert.equal(Number(payload.size),side==='buy'?10:-10);assert.equal(payload.pos_margin_mode,reduceOnly?'isolated':'cross');
    assert.equal(payload.reduce_only,reduceOnly);assert.equal(payload.auto_size,undefined);
    assert.equal(payload.pid,reduceOnly?'987':undefined);
    const sent=f.calls.filter(c=>c.name==='place').length;assert.deepEqual(await f.adapter.placeOrder(request),result);
    assert.equal(f.calls.filter(c=>c.name==='place').length,sent);
  }
  assert.equal(f.calls.filter(c=>c.name==='place').length,4);
});

test('Gate lost create acknowledgement is resolved by deterministic ID without another submission',async()=>{
  const f=fixture();await f.adapter.prepareTrading(market.symbol,2);f.timeout();
  const request:OrderRequest={base:'BTC',symbol:market.symbol,clientOrderId:'gate-timeout',side:'buy',reduceOnly:false,quantity:.01,limitPrice:10000};
  const result=await f.adapter.placeOrder(request);assert.equal(result.status,'filled');
  assert.deepEqual(await f.adapter.placeOrder(request),result);assert.equal(f.calls.filter(c=>c.name==='place').length,1);
});
