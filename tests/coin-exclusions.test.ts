import test from 'node:test';
import { ReadyHistory } from './ready-history.js';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {Engine} from '../src/core/engine.js';
import {Store} from '../src/core/store.js';
import {defaultConfig} from './legacy-config.js';
import {EXCHANGES,type AccountPosition,type AccountState,type ExchangeAdapter,type ExchangeId,type MarketSnapshot,type OrderRequest,type Position} from '../src/shared/types.js';

const actual=(base='BTC',quantity=1,side:'long'|'short'='long'):AccountPosition=>({base,symbol:`${base}/USDT:USDT`,side,quantity,markPrice:100,liquidationPrice:side==='long'?50:150,leverage:2});
function quote(exchange:ExchangeId,base:string,nextFundingTime:number,at=Date.now()):MarketSnapshot{
  return {exchange,base,symbol:`${base}/USDT:USDT`,source:'public',timestamp:at,observedAt:at,fundingObservedAt:at,markPrice:100,indexPrice:100,
    fundingRate:exchange==='gate'?0:.01,nextFundingTime,intervalHours:8,fundingHistory:[],
    // A fresh 30 bps entry edge satisfies the independent automatic filter; this suite tests coin isolation.
    bids:[{price:exchange==='gate'?100:100.3,quantity:100}],asks:[{price:exchange==='gate'?100:100.31,quantity:100}],openInterestUsd:1e9,volume24hUsd:1e9,
    quantityStep:.01,minQuantity:.01,minNotional:1,contractSize:1,
    takerFeeRate:exchange==='bybit'?.00055:exchange==='bitget'?.0006:.0005,takerFeeAt:at,takerFeeSource:'exchange'};
}
const oldPosition=(base:string):Position=>({id:`old-${base}`,base,mode:'live',status:'attention',feeOnly:true,
  long:{exchange:'gate',symbol:`${base}/USDT:USDT`,side:'long',quantity:1,entryPrice:100,markPrice:100,feesUsd:0,liquidationDistancePct:50},
  short:{exchange:'bitget',symbol:`${base}/USDT:USDT`,side:'short',quantity:1,entryPrice:100,markPrice:100,feesUsd:0,liquidationDistancePct:50},
  openedAt:Date.now()-1000,plannedExitAt:Date.now()+60000,holdMode:'continuous',fundingUsd:0,feesUsd:0,transferCostUsd:0,
  spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:['待核对']});

function fixture(coins=['BTC','ETH'],local:Position[]=[]){
  const directory=mkdtempSync(join(tmpdir(),'funding-coin-scope-'));
  const settlement=Date.now()+60000;
  const store=new Store(join(directory,'state.json'),{...defaultConfig,mode:'live',dataSource:'public',entryPolicy:'aligned',feeOnly:true,orderNotionalUsd:100,symbols:coins});
  store.data.positions=local;
  const accounts=new Map<ExchangeId,AccountState>(EXCHANGES.map(exchange=>[exchange,{freeUsd:1000,equityUsd:1000,positions:[]}]));
  const env:Record<string,string>={ALLOW_LIVE_TRADING:'false',LIVE_TRADING_ACK:''};
  for(const exchange of EXCHANGES){const prefix=exchange.toUpperCase();env[`${prefix}_API_KEY`]='fixture-key';env[`${prefix}_API_SECRET`]='fixture-secret';env[`${prefix}_PASSPHRASE`]='fixture-pass';}
  const writes:Array<{exchange:ExchangeId;request:OrderRequest}>=[];let prepared=0;
  const adapters=EXCHANGES.map(exchange=>({id:exchange,fetchAccount:async()=>structuredClone(accounts.get(exchange)!),
    fetchSnapshots:async(bases:string[])=>bases.map(base=>quote(exchange,base,settlement)),fetchFundingPayments:async()=>[],close:async()=>{},
    inspectTrading:async()=>{},validateOrder:async()=>{},prepareTrading:async()=>{prepared++;},cancelOrder:async()=>{throw new Error('Unexpected cancellation');},
    reconcileOrder:async(req:OrderRequest)=>({id:'',clientOrderId:req.clientOrderId,status:'unknown' as const,filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()}),
    placeOrder:async(request:OrderRequest)=>{
      writes.push({exchange,request});const account=accounts.get(exchange)!;
      const side=request.reduceOnly?(request.side==='buy'?'short':'long'):(request.side==='buy'?'long':'short');
      let row=account.positions.find(p=>p.base===request.base&&p.side===side);
      if(request.reduceOnly){assert(row,'A reduction must target an actual mocked position');row.quantity-=request.quantity;account.positions=account.positions.filter(p=>p.quantity>1e-12);}
      else if(row)row.quantity+=request.quantity;else account.positions.push(actual(request.base,request.quantity,side));
      return {id:`mock-${writes.length}`,clientOrderId:request.clientOrderId,status:'filled' as const,filledQuantity:request.quantity,averagePrice:request.limitPrice,feeUsd:.05,timestamp:Date.now()};
    },
  }) as ExchangeAdapter);
  const engine=new Engine(store,false,{liveEnvironment:env,adapterFactory:()=>adapters,spreadHistory:new ReadyHistory()});
  engine.health=EXCHANGES.map(exchange=>({exchange,status:'online',latencyMs:1,lastSuccess:Date.now()}));
  const refresh=(at=Date.now())=>{engine.snapshots=EXCHANGES.flatMap(exchange=>coins.map(base=>quote(exchange,base,settlement,at)));};refresh();
  const opportunity=(base:string)=>engine.currentOpportunities().find(o=>o.base===base&&o.longExchange==='gate'&&o.shortExchange==='bitget')!;
  const confirmFunding=()=>{
    const now=Date.now();
    // Native funding observations, not an already-confirmed DTO or book-only events.
    // Keep the original settlement time fixed while exercising the real Engine tracker.
    for(const age of [180_000,135_000,90_000,45_000,0]){
      refresh(now-age);
      (engine as unknown as {detailedOpportunities(now:number):unknown}).detailedOpportunities(now-age);
    }
    for(const base of coins){
      const stability=opportunity(base).fundingEntryStability;
      assert.equal(stability?.passes,true);assert.equal(stability!.sampleCount,1);assert.equal(stability!.observedSpanMs,0);
    }
  };
  const pending=(base?:string)=>store.data.orders.push({positionId:'orphan',exchange:'bybit',request:{base:base as string,symbol:'BTC/USDT:USDT',side:'sell',quantity:1,limitPrice:100,reduceOnly:false,clientOrderId:'original-unknown'},createdAt:Date.now()});
  return {engine,store,accounts,env,writes,prepared:()=>prepared,opportunity,pending,refresh,confirmFunding,cleanup:async()=>{
    await engine.stop();const target=resolve(directory);assert.equal(dirname(target),resolve(tmpdir()));assert(basename(target).startsWith('funding-coin-scope-'));rmSync(target,{recursive:true,force:true});
  }};
}

test('all five exchanges may hold BTC and still start and submit an ETH hedge on the same accounts',async()=>{
  const f=fixture();try{
    for(const account of f.accounts.values())account.positions=[actual('BTC')];
    const report=await f.engine.tradingPreflight();assert.equal(report.canStart,true);assert.equal(report.accounts.filter(a=>a.status==='ready').length,5);
    assert.deepEqual(report.excludedCoins?.map(c=>c.base),['BTC']);assert.equal(report.excludedCoins?.[0].exchanges.length,5);
    await f.engine.startLive('START_LIVE_TRADING');assert.equal(f.engine.liveReadiness().ready,true);
    assert(f.engine.currentOpportunities().filter(o=>o.base==='BTC').every(o=>!o.eligible));
    await assert.rejects(f.engine.open(f.opportunity('BTC').id),/持仓/);assert.equal(f.prepared(),0);
    const result=await f.engine.open(f.opportunity('ETH').id);assert.equal(result.status,'open');assert.equal(f.writes.length,2);
    assert(f.writes.every(w=>w.request.base==='ETH'&&w.request.quantity===1));assert.equal(f.engine.autoEnabled,true);assert.equal(f.store.data.killSwitch,false);
    for(const account of f.accounts.values())assert.equal(account.positions.find(p=>p.base==='BTC')?.quantity,1);
  }finally{await f.cleanup();}
});

test('restart with a mismatched local BTC ledger and orphan BTC order permits other coins without clearing either record',async()=>{
  const p=oldPosition('BTC'),f=fixture(['BTC','ETH'],[p]);try{
    f.pending('BTC');const original=JSON.stringify(f.store.data.orders);
    const report=await f.engine.tradingPreflight();assert.equal(report.canStart,true);assert(report.excludedCoins?.[0].reasons.some(r=>r.includes('未确认订单')));
    await f.engine.startLive('START_LIVE_TRADING');f.confirmFunding();await f.engine.tick();
    assert.equal(f.engine.autoEnabled,true);assert.equal(f.store.data.killSwitch,false);assert.equal(p.status,'attention');
    assert.equal(p.long.quantity,1);assert.equal(p.short.quantity,1);assert.equal(f.writes.length,2);assert(f.writes.every(w=>w.request.base==='ETH'));
    assert.equal(JSON.stringify(f.store.data.orders.slice(0,1)),original);assert.equal(f.store.data.orders[0].result,undefined);
    assert.equal(f.engine.liveReadiness().ready,true);
  }finally{await f.cleanup();}
});

test('a new target-coin holding discovered during private checks blocks that entry before any preparation',async()=>{
  const f=fixture();try{
    await f.engine.startLive('START_LIVE_TRADING');const id=f.opportunity('BTC').id;
    f.accounts.get('gate')!.positions=[actual('BTC')];
    await assert.rejects(f.engine.open(id),/持仓/);assert.equal(f.prepared(),0);assert.equal(f.writes.length,0);
    assert.equal(f.engine.autoEnabled,true);assert.equal(f.store.data.killSwitch,false);assert.equal(f.opportunity('ETH').eligible,true);
    await f.engine.open(f.opportunity('ETH').id);assert.equal(f.writes.length,2);
  }finally{await f.cleanup();}
});

test('a discrepancy on BTC freezes only BTC and leaves an unrelated strategy position managed normally',async()=>{
  const btc=oldPosition('BTC'),eth=oldPosition('ETH'),f=fixture(['BTC','ETH','DOGE'],[btc,eth]);try{
    await f.engine.startLive('START_LIVE_TRADING');eth.status='open';eth.riskReasons=[];
    f.accounts.get('gate')!.positions=[actual('BTC',2),actual('ETH')];f.accounts.get('bitget')!.positions=[actual('BTC',1,'short'),actual('ETH',1,'short')];
    f.confirmFunding();
    await f.engine.tick();assert.equal(btc.status,'attention');assert.equal(eth.status,'open');assert.deepEqual(eth.riskReasons,[]);
    assert.equal(f.engine.autoEnabled,true);assert.equal(f.store.data.killSwitch,false);assert(f.writes.length===2&&f.writes.every(w=>w.request.base==='DOGE'));
  }finally{await f.cleanup();}
});

test('unknown ETH order results keep the original journal and freeze ETH without stopping DOGE',async()=>{
  const f=fixture(['ETH','DOGE']);try{
    for(const adapter of f.engine.adapters){const original=adapter.placeOrder;adapter.placeOrder=async request=>request.base==='ETH'?
      {id:'',clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()}:original(request);}
    await f.engine.startLive('START_LIVE_TRADING');const eth=await f.engine.open(f.opportunity('ETH').id);
    assert.equal(eth.status,'attention');assert.equal(f.store.data.orders.length,1);assert(f.store.data.orders.every(o=>o.result?.status==='unknown'));
    assert.equal(f.engine.autoEnabled,true);assert.equal(f.store.data.killSwitch,false);assert.equal(f.engine.liveReadiness().ready,true);
    await assert.rejects(f.engine.open(f.opportunity('ETH').id),/未确认订单/);
    const doge=await f.engine.open(f.opportunity('DOGE').id);assert.equal(doge.status,'open');assert.equal(f.writes.length,2);
  }finally{await f.cleanup();}
});

test('an unknown BTC order does not prevent closing a confirmed ETH pair',async()=>{
  const f=fixture();try{
    f.pending('BTC');await f.engine.startLive('START_LIVE_TRADING');const eth=await f.engine.open(f.opportunity('ETH').id);
    await f.engine.close(eth.id);assert.equal(eth.status,'closed');assert.equal(f.writes.length,4);assert(f.writes.slice(2).every(w=>w.request.reduceOnly&&w.request.base==='ETH'));
    assert.equal(f.store.data.orders[0].result,undefined);assert.equal(f.engine.autoEnabled,true);
  }finally{await f.cleanup();}
});

test('missing coin identification keeps the startup blocked instead of guessing which coin is affected',async()=>{
  const f=fixture();try{
    f.pending();const report=await f.engine.tradingPreflight();assert.equal(report.canStart,false);assert(report.blockers.some(r=>r.includes('缺少币种')));
    await assert.rejects(f.engine.startLive('START_LIVE_TRADING'),/缺少币种/);assert.equal(f.engine.liveUnlocked,false);assert.equal(f.writes.length,0);
  }finally{await f.cleanup();}
});

test('reconcile continues past an unknown BTC journal and resume restores only confirmed ETH',async()=>{
  const btc=oldPosition('BTC'),eth=oldPosition('ETH'),f=fixture(['BTC','ETH','DOGE'],[btc,eth]);try{
    f.pending('BTC');const unknown=structuredClone(f.store.data.orders[0]);
    for(const p of [btc,eth]){
      f.accounts.get('gate')!.positions.push(actual(p.base));f.accounts.get('bitget')!.positions.push(actual(p.base,1,'short'));
      for(const leg of [p.long,p.short])f.store.data.orders.push({positionId:p.id,exchange:leg.exchange,
        request:{base:p.base,symbol:leg.symbol,side:leg.side==='long'?'buy':'sell',quantity:1,limitPrice:100,reduceOnly:false,clientOrderId:`original-${p.base}-${leg.exchange}`},createdAt:p.openedAt,
        result:{id:'mock-original',clientOrderId:`original-${p.base}-${leg.exchange}`,status:'filled',filledQuantity:1,averagePrice:100,feeUsd:0,timestamp:p.openedAt}});
    }
    await f.engine.startLive('START_LIVE_TRADING');await f.engine.control('pause');f.store.data.killSwitch=true;
    await f.engine.control('reconcile');assert.equal(eth.status,'attention');assert.equal(btc.status,'attention');
    await f.engine.control('resume');assert.equal(eth.status,'open');assert.equal(btc.status,'attention');
    assert.equal(f.store.data.killSwitch,false);assert.equal(f.engine.autoEnabled,false);assert.equal(f.writes.length,0);
    assert.deepEqual(f.store.data.orders[0],unknown);assert(f.engine.currentOpportunities().filter(o=>o.base==='BTC').every(o=>!o.eligible));
  }finally{await f.cleanup();}
});

test('a new-entry margin shortage on one venue does not remove reduction permission for an existing leg',async()=>{
  const p=oldPosition('BTC'),f=fixture(['BTC','ETH'],[p]);try{
    f.accounts.get('gate')!.freeUsd=0;f.accounts.get('gate')!.positions=[actual('BTC')];f.accounts.get('bitget')!.positions=[actual('BTC',1,'short')];
    const result=await f.engine.startLive('START_LIVE_TRADING');assert.equal(result.accounts.find(a=>a.exchange==='gate')?.status,'insufficient');
    const eth=f.opportunity('ETH');assert.equal(eth.eligible,false);assert(eth.reasons.some(r=>r.includes('余额不足')));
    const alternativeLong=f.engine.snapshot('bybit','ETH')!;alternativeLong.fundingRate=0;
    alternativeLong.bids[0].price=100;alternativeLong.asks[0].price=100;
    assert.equal(f.engine.currentOpportunities().find(o=>o.base==='ETH'&&o.longExchange==='bybit'&&o.shortExchange==='bitget')!.eligible,true);
    await f.engine.control('pause');await f.engine.close(p.id);
    assert.equal(p.status,'closed');assert.equal(f.writes.length,2);assert(f.writes.every(w=>w.request.reduceOnly));
  }finally{await f.cleanup();}
});

test('only the venue with a confirmed nonzero residual is needed for read-only recovery and reduction',async()=>{
  const p=oldPosition('BTC');p.short.quantity=0;const f=fixture(['BTC','ETH'],[p]);try{
    for(const id of EXCHANGES.filter(id=>id!=='gate')){delete f.env[`${id.toUpperCase()}_API_KEY`];delete f.env[`${id.toUpperCase()}_API_SECRET`];}
    f.accounts.get('gate')!.freeUsd=0;f.accounts.get('gate')!.positions=[actual('BTC')];
    const report=await f.engine.tradingPreflight();assert.equal(report.canStart,false);assert.equal(report.canRecover,true);assert.equal(f.writes.length,0);
    await f.engine.recoverLive('RESTORE_LIVE_MANAGEMENT');assert.equal(f.engine.liveUnlocked,true);assert.equal(f.engine.liveReadiness().ready,false);assert.equal(f.engine.autoEnabled,false);
    await f.engine.close(p.id);assert.equal(p.status,'closed');assert.equal(f.writes.length,1);assert(f.writes[0].request.reduceOnly);assert.equal(f.writes[0].exchange,'gate');
  }finally{await f.cleanup();}
});

test('resume retains a global block when an unresolved journal has no identifiable coin',async()=>{
  const f=fixture();try{
    await f.engine.startLive('START_LIVE_TRADING');await f.engine.control('pause');f.store.data.killSwitch=true;f.pending();
    await assert.rejects(f.engine.control('resume'),/缺少币种/);assert.equal(f.store.data.killSwitch,true);assert.equal(f.writes.length,0);
  }finally{await f.cleanup();}
});

test('zero positions exclude no coin; confirmed removal of an external holding clears only that exclusion',async()=>{
  const f=fixture();try{
    f.accounts.get('gate')!.positions=[actual('BTC',0)];f.accounts.get('bitget')!.positions=[actual('ETH')];
    await f.engine.startLive('START_LIVE_TRADING');await f.engine.control('pause');assert.equal(f.opportunity('BTC').eligible,true);assert.equal(f.opportunity('ETH').eligible,false);
    f.accounts.get('bitget')!.positions=[];await f.engine.tick();assert.equal(f.opportunity('ETH').eligible,true);assert.deepEqual(f.engine.liveReadiness().excludedCoins,[]);assert.equal(f.writes.length,0);
  }finally{await f.cleanup();}
});

test('a venue with unidentifiable nonzero positions fails its account read while other funded venues can start',async()=>{
  const f=fixture();try{
    f.accounts.get('gate')!.positions=[{...actual(),base:''}];const report=await f.engine.tradingPreflight();assert.equal(report.canStart,true);
    assert.equal(report.accounts.find(a=>a.exchange==='gate')?.status,'error');assert.match(report.accounts.find(a=>a.exchange==='gate')!.message,/数据不完整/);
    await f.engine.startLive('START_LIVE_TRADING');assert.equal(f.engine.liveReadiness().ready,true);assert.equal(f.writes.length,0);
  }finally{await f.cleanup();}
});
