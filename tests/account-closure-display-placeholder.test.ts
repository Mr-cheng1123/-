import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Engine} from '../src/core/engine.js';
import {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountOpenOrder,AccountPosition,AccountState,ExchangeAdapter,ExchangeId,JournalOrder,LivePortfolio,Position,PositionLeg} from '../src/shared/types.js';

const symbol='DGAI/USDT:USDT';
function fixture(side:'long'|'short'='long'){
  const directory=mkdtempSync(join(tmpdir(),'closure-display-')),now=Date.now();
  const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,exchanges:['bybit','gate'] as ExchangeId[],symbols:['DGAI']};
  const real={exchange:'bybit' as const,symbol,side,quantity:1.2,entryPrice:1.02,markPrice:1.03,feesUsd:.013,liquidationDistancePct:null};
  const absentSide=side==='long'?'short':'long';
  const absent:PositionLeg={exchange:'bybit',symbol:`${symbol}#display-absent-${absentSide}`,side:absentSide,quantity:0,entryPrice:0,markPrice:1.03,feesUsd:0,liquidationDistancePct:null};
  const p:Position={id:'dgai-readonly-record',base:'DGAI',mode:'live',status:'attention',holdMode:'adaptive',
    manualCloseOnly:true,manualCloseAccountRecord:true,openedAt:now-300000,plannedExitAt:now-240000,closeRequestedAt:now-100000,
    long:side==='long'?real:absent,short:side==='short'?real:absent,
    fundingUsd:-.27,feesUsd:.013,transferCostUsd:.01,spreadPnlUsd:.007,realizedSpreadPnlUsd:-.019,netPnlUsd:-.285,deltaUsd:1.236,
    fundingEvents:['retained-funding-event'],riskReasons:['original attention reason']};
  const order:JournalOrder={positionId:p.id,exchange:'bybit',createdAt:now-299000,
    request:{clientOrderId:'original-dgai-unknown',base:p.base,symbol,side:side==='long'?'buy':'sell',quantity:1.2,limitPrice:1.02,reduceOnly:false},
    result:{id:'',clientOrderId:'original-dgai-unknown',status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:now-299000,
      confirmation:{stage:'order-read',reason:'not-found',observedAt:now-298000}},
    originalConfirmation:{stage:'create',reason:'request-failed',apiCode:'110126',apiMessage:'Original retained diagnostic'},error:'Original unknown remains unknown'};
  const store=new Store(join(directory,'state.json'),config);store.data.positions=[p];store.data.orders=[order];store.save();
  const open=new Map<ExchangeId,AccountOpenOrder[]>([['bybit',[]],['gate',[]]]);
  const actual=new Map<ExchangeId,AccountPosition[]>([['bybit',[]],['gate',[]]]);
  const calls:Array<{exchange:ExchangeId;kind:'open'|'account';symbol?:string}>=[];
  let writes=0,feeReads=0;
  const forbidden=async()=>{writes++;throw new Error('No financial writes or trading preparation are authorized in observation');};
  const adapters=config.exchanges.map(exchange=>({id:exchange,fetchSnapshots:async()=>[],
    fetchOpenOrders:async requested=>{calls.push({exchange,kind:'open',symbol:requested});if(requested!==symbol)throw new Error('Unknown native contract');return structuredClone(open.get(exchange)!);},
    fetchAccount:async()=>{calls.push({exchange,kind:'account'});return {freeUsd:1000,equityUsd:1000,positions:structuredClone(actual.get(exchange)!)};},
    fetchTradingFee:async()=>{feeReads++;throw new Error('No private fee reads during observation');},
    prepareTrading:forbidden,placeOrder:forbidden,cancelOrder:forbidden,reconcileOrder:forbidden,fetchFundingPayments:async()=>[],close:async()=>{}
  } as ExchangeAdapter));
  const engine=new Engine(store,false,{adapterFactory:()=>adapters,liveEnvironment:{BYBIT_API_KEY:'offline-fixture',BYBIT_API_SECRET:'offline-fixture',GATE_API_KEY:'offline-fixture',GATE_API_SECRET:'offline-fixture'}});
  const portfolio=(at=Date.now()-10):LivePortfolio=>({timestamp:Date.now(),pollIntervalMs:5000,maxAgeMs:15000,
    exchanges:config.exchanges.map(exchange=>({exchange,credentialsConfigured:true,status:'ready',requestedAt:at,receivedAt:at+1,positions:[],freeUsd:1000,equityUsd:1000}))});
  const financial=()=>JSON.stringify({long:p.long,short:p.short,fundingUsd:p.fundingUsd,feesUsd:p.feesUsd,transferCostUsd:p.transferCostUsd,
    spreadPnlUsd:p.spreadPnlUsd,realizedSpreadPnlUsd:p.realizedSpreadPnlUsd,netPnlUsd:p.netPnlUsd,deltaUsd:p.deltaUsd,
    fundingEvents:p.fundingEvents,orders:store.data.orders});
  const paired=(sameVenue=false)=>{
    delete p.manualCloseOnly;delete p.manualCloseAccountRecord;
    p.long={...real,side:'long',exchange:'bybit',symbol};
    p.short={...real,side:'short',exchange:sameVenue?'bybit':'gate',symbol,quantity:0};
  };
  return {p,order,engine,store,adapters,actual,open,calls,portfolio,financial,paired,writes:()=>writes,feeReads:()=>feeReads,
    count:(exchange:ExchangeId,kind:'open'|'account')=>calls.filter(call=>call.exchange===exchange&&call.kind===kind).length,
    cleanup:async()=>{await engine.stop();rmSync(directory,{recursive:true,force:true});}};
}
const immediate=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
const emptyAccount=():AccountState=>({freeUsd:1000,equityUsd:1000,positions:[]});

for(const side of ['long','short'] as const)test(`Bybit ${side}-only display record reads only its real contract and retains the original unknown and all cash`,async()=>{
  const f=fixture(side);try{
    const before=f.financial();await f.engine.observeAccountClosures(f.portfolio(Date.now()-100));assert.equal(f.calls.length,0);
    await f.engine.observeAccountClosures(f.portfolio(Date.now()-50));
    assert(f.p.accountClosure,'independent empty observations and the real native GETs archive only current exposure');
    assert.equal(f.count('bybit','open'),1);assert.equal(f.count('bybit','account'),1);assert.equal(f.calls.filter(call=>call.exchange==='gate').length,0);
    assert.deepEqual(f.calls.filter(call=>call.kind==='open').map(call=>call.symbol),[symbol]);
    assert.equal(f.financial(),before);assert.equal(f.order.result!.status,'unknown');assert.equal(f.p.accountClosure.historicalOrdersPending,true);
    assert.equal(f.engine.state().unconfirmedOrders![0].historical,true);assert.equal(f.engine.activePositions().length,0);
    assert.equal(f.writes(),0);assert.equal(f.feeReads(),0);assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);
  }finally{await f.cleanup();}
});

test('real hedge legs sharing one venue and one contract need one complete open-order GET and one fresh account GET',async()=>{
  const f=fixture();try{
    f.paired(true);f.p.short.quantity=1.2;const before=f.financial();
    await f.engine.observeAccountClosures(f.portfolio(Date.now()-100));await f.engine.observeAccountClosures(f.portfolio(Date.now()-50));
    assert(f.p.accountClosure);assert.equal(f.count('bybit','open'),1);assert.equal(f.count('bybit','account'),1);assert.equal(f.financial(),before);assert.equal(f.writes(),0);
  }finally{await f.cleanup();}
});

test('a real dual-venue zero leg still requires both native order lists and both independently read accounts',async()=>{
  const f=fixture();try{
    f.paired();assert.equal(f.p.short.quantity,0);
    await f.engine.observeAccountClosures(f.portfolio(Date.now()-100));await f.engine.observeAccountClosures(f.portfolio(Date.now()-50));
    assert(f.p.accountClosure);for(const exchange of ['bybit','gate'] as const){assert.equal(f.count(exchange,'open'),1);assert.equal(f.count(exchange,'account'),1);}
    assert.equal(f.writes(),0);
  }finally{await f.cleanup();}
});

test('two zero quantities on genuine dual venues do not discard a conditional zero-quantity close-all order',async()=>{
  const f=fixture();try{
    f.paired();f.p.long.quantity=0;
    f.open.set('gate',[{id:'conditional-close-all',base:'DGAI',symbol,side:'buy',quantity:0,remainingQuantity:0,reduceOnly:true,kind:'conditional'}]);
    await f.engine.observeAccountClosures(f.portfolio(Date.now()-100));await f.engine.observeAccountClosures(f.portfolio(Date.now()-50));
    assert.equal(f.p.accountClosure,undefined);for(const exchange of ['bybit','gate'] as const){assert.equal(f.count(exchange,'open'),1);assert.equal(f.count(exchange,'account'),0);}
    assert.equal(f.writes(),0);
  }finally{await f.cleanup();}
});

test('only the complete locally generated zero placeholder may be omitted, never a malformed or funded leg',async()=>{
  const variants:Array<{name:string;mutate:(p:Position)=>void}>=[
    {name:'nonzero quantity',mutate:p=>{p.short.quantity=.1;}},
    {name:'missing manual-only flag',mutate:p=>{delete p.manualCloseOnly;}},
    {name:'missing account-record flag',mutate:p=>{delete p.manualCloseAccountRecord;}},
    {name:'false flags',mutate:p=>{p.manualCloseOnly=false;p.manualCloseAccountRecord=false;}},
    {name:'different venue',mutate:p=>{p.short.exchange='gate';}},
    {name:'other real contract',mutate:p=>{p.short.symbol='OTHER/USDT:USDT#display-absent-short';}},
    {name:'wrong side suffix',mutate:p=>{p.short.symbol=`${symbol}#display-absent-long`;}},
    {name:'unexpected trailing text',mutate:p=>{p.short.symbol+='-trusted';}},
    {name:'side inconsistent with slot',mutate:p=>{p.short.side='long';}},
    {name:'untrusted peer placeholder',mutate:p=>{p.long.symbol=`${symbol}#display-absent-long`;p.short.symbol=`${p.long.symbol}#display-absent-short`;}}
  ];
  for(const variant of variants){
    const f=fixture();try{
      variant.mutate(f.p);const before=f.financial();
      await f.engine.observeAccountClosures(f.portfolio(Date.now()-100));await f.engine.observeAccountClosures(f.portfolio(Date.now()-50));
      assert(f.calls.some(call=>call.kind==='open'&&call.symbol?.includes('#display-absent-')),variant.name);
      assert.equal(f.p.accountClosure,undefined,variant.name);assert.equal(f.financial(),before,variant.name);assert.equal(f.writes(),0,variant.name);
    }finally{await f.cleanup();}
  }
});

test('a single real contract with a conditional zero-quantity order cannot be archived or cancelled by observation',async()=>{
  const f=fixture('short');try{
    f.open.set('bybit',[{id:'working-conditional',base:'DGAI',symbol,side:'buy',quantity:0,remainingQuantity:0,reduceOnly:true,kind:'conditional'}]);
    const before=f.financial();await f.engine.observeAccountClosures(f.portfolio(Date.now()-100));await f.engine.observeAccountClosures(f.portfolio(Date.now()-50));
    assert.equal(f.p.accountClosure,undefined);assert.equal(f.count('bybit','open'),1);assert.equal(f.count('bybit','account'),0);assert.equal(f.financial(),before);assert.equal(f.writes(),0);
  }finally{await f.cleanup();}
});

test('reopening the real single-venue contract during the final account GET prevents archival',async()=>{
  const f=fixture();try{
    f.actual.set('bybit',[{base:'DGAI',symbol,side:'short',quantity:.3,markPrice:1.03,liquidationPrice:0,leverage:2}]);
    const before=f.financial();await f.engine.observeAccountClosures(f.portfolio(Date.now()-100));await f.engine.observeAccountClosures(f.portfolio(Date.now()-50));
    assert.equal(f.p.accountClosure,undefined);assert.equal(f.count('bybit','open'),1);assert.equal(f.count('bybit','account'),1);assert.equal(f.financial(),before);assert.equal(f.writes(),0);
  }finally{await f.cleanup();}
});

test('a cached single-venue empty observation or an observation without its independent request time cannot archive',async()=>{
  const f=fixture();try{
    const data=f.portfolio(Date.now()-100);await f.engine.observeAccountClosures(data);await f.engine.observeAccountClosures(data);
    assert.equal(f.calls.length,0);assert.equal(f.p.accountClosure,undefined);
    const missing=f.portfolio(Date.now()-50);delete missing.exchanges[0].requestedAt;
    await f.engine.observeAccountClosures(missing);assert.equal(f.calls.length,0);assert.equal(f.p.accountClosure,undefined);
    const finalData=f.portfolio(Date.now()-40);await f.engine.observeAccountClosures(finalData);assert.equal(f.calls.length,0);
    await f.engine.observeAccountClosures(f.portfolio(Date.now()-30));assert(f.p.accountClosure);assert.equal(f.count('bybit','open'),1);
  }finally{await f.cleanup();}
});

for(const phase of ['open','account'] as const)test(`a fast ${phase} failure waits for the already started bounded peer GET before reporting or starting another observation`,async()=>{
  const f=fixture(),held=deferred<AccountOpenOrder[]|AccountState>(),began=deferred<void>();let observation:Promise<void>|undefined;
  try{
    f.paired();const before=f.financial();await f.engine.observeAccountClosures(f.portfolio(Date.now()-100));
    const bybit=f.engine.adapter('bybit'),gate=f.engine.adapter('gate');
    if(phase==='open'){
      bybit.fetchOpenOrders=async()=>{f.calls.push({exchange:'bybit',kind:'open',symbol});throw new Error('Fast native open-order failure');};
      gate.fetchOpenOrders=async()=>{f.calls.push({exchange:'gate',kind:'open',symbol});began.resolve();return await held.promise as AccountOpenOrder[];};
    }else{
      bybit.fetchAccount=async()=>{f.calls.push({exchange:'bybit',kind:'account'});throw new Error('Fast native account failure');};
      gate.fetchAccount=async()=>{f.calls.push({exchange:'gate',kind:'account'});began.resolve();return await held.promise as AccountState;};
    }
    let ended=false;observation=f.engine.observeAccountClosures(f.portfolio(Date.now()-50)).then(()=>{ended=true;});await began.promise;
    await immediate();await immediate();assert.equal(ended,false,'the peer has not reached its original bound or settled');
    held.resolve(phase==='open'?[]:emptyAccount());await observation;
    assert.equal(f.p.accountClosure,undefined);assert.equal(f.financial(),before);
    assert.equal((f.engine as any).privateReadRequests.get(gate)?.size??0,0,'settled peer GET no longer occupies the single-flight map');
    await f.engine.observeAccountClosures(f.portfolio(Date.now()-20));assert.equal(f.count('gate',phase),2);
    assert(!f.store.data.logs.some(log=>log.message.includes('上次只读请求尚未结束')));assert.equal(f.writes(),0);
  }finally{held.resolve(phase==='open'?[]:emptyAccount());await observation;await f.cleanup();}
});

test('an actually expired bounded peer GET remains single-flight and its eventual raw result cannot archive the account',async()=>{
  const f=fixture(),held=deferred<AccountOpenOrder[]>();try{
    f.paired();(f.engine as any).options.privateReadDeadlineMs=5;
    const gate=f.engine.adapter('gate');gate.fetchOpenOrders=async()=>{f.calls.push({exchange:'gate',kind:'open',symbol});return held.promise;};
    const before=f.financial();await f.engine.observeAccountClosures(f.portfolio(Date.now()-100));await f.engine.observeAccountClosures(f.portfolio(Date.now()-50));
    assert.equal(f.p.accountClosure,undefined);assert.equal(f.count('gate','open'),1);
    assert.equal((f.engine as any).privateReadRequests.get(gate)?.size,1);
    await f.engine.observeAccountClosures(f.portfolio(Date.now()-20));assert.equal(f.count('gate','open'),1,'the raw request is still in flight');
    held.resolve([]);await immediate();await immediate();assert.equal((f.engine as any).privateReadRequests.get(gate)?.size??0,0);
    assert.equal(f.p.accountClosure,undefined);assert.equal(f.financial(),before);assert.equal(f.writes(),0);
  }finally{held.resolve([]);await immediate();await f.cleanup();}
});
