import test from 'node:test';
import assert from 'node:assert/strict';
import {GatePrivate} from '../src/adapters/gate-private.js';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {LivePortfolioMonitor} from '../src/core/live-portfolio.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountPosition,AppState,ExchangeId,OrderRequest} from '../src/shared/types.js';
import {ledgerAccountProjection} from '../web/src/ledger-account-projection.js';
import {ledgerPositionMetrics} from '../web/src/ledger-position-metrics.js';
import {accountPositionKey} from '../web/src/account-position-identity.js';
import {portfolioPositionSummary} from '../web/src/position-observation.js';

const markets=Object.fromEntries(['ONE','BTC'].map(base=>[`${base}/USDT:USDT`,{
  id:`${base}_USDT`,symbol:`${base}/USDT:USDT`,base,quote:'USDT',settle:'USDT',swap:true,linear:true,active:true,
  contractSize:base==='ONE'?10:.001,precision:{amount:1,price:.0000001},limits:{amount:{min:1},cost:{min:1}},
}]));
const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,exchanges:['gate'] as ExchangeId[],autoEnabled:false};
const slot=(changes:Record<string,unknown>={}):Record<string,any>=>({contract:'ONE_USDT',size:'2781',mode:'dual_long',pos_margin_mode:'isolated',
  lever:'2',leverage:'2',cross_leverage_limit:'20',mark_price:'.002024',liq_price:'.001057',entry_price:'.002085',
  unrealised_pnl:'-1.69641',pnl_pnl:'0',pnl_fund:'.01',pnl_fee:'-.05',open_time:'1790927498',update_time:'1790934900',...changes});
function fixture(rows:any[]){
  const calls:string[]=[],get=(name:string,value:()=>unknown)=>async()=>{calls.push(name);return value();};
  const forbidden=async()=>{calls.push('financial-write');throw new Error('No financial action is permitted by this fixture');};
  const client:any={apiKey:'offline-fixture',secret:'offline-fixture',precisionMode:4,markets,
    loadMarkets:async()=>markets,market:(symbol:string)=>markets[symbol],
    amountToPrecision:(_symbol:string,quantity:number)=>String(quantity),priceToPrecision:(_symbol:string,price:number)=>String(price),
    privateFuturesGetSettleAccounts:get('account',()=>({currency:'USDT',available:'400',total:'0',unrealised_pnl:'-2',
      position_mode:'dual_plus',margin_mode:3,margin_mode_name:'single_currency'})),
    privateFuturesGetSettlePositions:get('positions',()=>rows),
    privateUnifiedGetAccounts:get('unified-account',()=>({unified_account_total_equity:'500'})),
    privateFuturesGetSettleOrders:get('orders',()=>[]),privateFuturesGetSettlePriceOrders:get('conditional-orders',()=>[]),
    privateFuturesGetSettleGetLeverageContract:get('settings',()=>({Lever:'2'})),
    privateFuturesGetSettleFee:get('fees',()=>Object.fromEntries(Object.values(markets).map(m=>[m.id,{taker_fee:'.0005'}]))),
    privateFuturesPostSettleOrders:forbidden,privateFuturesPostSettlePositionsContractSetLeverage:forbidden,
    privateFuturesDeleteSettleOrdersOrderId:forbidden,close:async()=>{},
  };
  return {client,calls,adapter:new GatePrivate(client),ccxt:new CcxtAdapter('gate',config,client)};
}
const close=(a:number|undefined,b:number)=>assert.ok(a!==undefined&&Math.abs(a-b)<1e-10,`${a} != ${b}`);

test('actual ONE cross plus isolated native shape combines quantities, notional, weighted prices and UPL',async()=>{
  const rows=[slot(),slot({pos_margin_mode:'cross',leverage:'0',cross_leverage_limit:'2',liq_price:'0',
    entry_price:'.00215',mark_price:'.00203',unrealised_pnl:'-3.3372',open_time:'1790933775'})],before=structuredClone(rows),f=fixture(rows);
  try{
    const account=await f.ccxt.fetchAccount(),p=account.positions[0];
    assert.equal(account.positions.length,1);assert.equal(p.quantity,55_620);assert.equal(p.splitPositionCount,2);
    close(p.markPrice,.002027);close(p.quantity*p.markPrice,27_810*.002024+27_810*.00203);
    close(p.entryPrice,(.002085+.00215)/2);close(p.unrealizedPnlUsd,-5.03361);
    assert.equal(p.marginMode,undefined);assert.equal(p.positionId,undefined);assert.equal(p.leverage,2);
    close(p.fundingUsd,.02);close(p.feesUsd,.1);close(p.realizedPnlUsd,0);
    assert.equal(p.positionOpenedAt,undefined);assert.match(p.positionMetricReason!,/不代表原策略单一周期/);
    assert.equal(p.liquidationPrice,0);assert.equal(p.liquidationStatus,'unavailable');assert.match(p.liquidationReason!,/无单一强平价/);
    assert.deepEqual(rows,before);assert.equal(f.calls.includes('financial-write'),false);
  }finally{await f.ccxt.close();}
});

test('complete native slot cash aggregates across cycles, preserving real zero and rebates while missing counters stay unknown',async()=>{
  const rows=[slot({pnl_fund:'0',pnl_fee:'-.05',pnl_pnl:'.12'}),slot({pos_margin_mode:'cross',pnl_fund:'-.03',pnl_fee:'.01',pnl_pnl:'-.02'})],f=fixture(rows);
  const p=(await f.adapter.fetchPortfolioAccount()).positions[0];
  close(p.fundingUsd,-.03);close(p.feesUsd,.04);close(p.realizedPnlUsd,.1);assert.equal(p.positionOpenedAt,1790927498000);
  delete (rows[1] as any).pnl_fee;
  const missing=(await f.adapter.fetchAccount()).positions[0];assert.equal(missing.feesUsd,undefined);close(missing.fundingUsd,-.03);
  delete (rows[0] as any).open_time;
  const noCycle=(await f.adapter.fetchAccount()).positions[0];close(noCycle.fundingUsd,-.03);close(noCycle.realizedPnlUsd,.1);
  assert.equal(noCycle.positionOpenedAt,undefined);assert.equal(noCycle.feesUsd,undefined);
  assert.equal(f.calls.includes('financial-write'),false);
});

test('native IDs allow independent same-margin slots but unknown aggregate leverage, cash and entry stay unknown',async()=>{
  const rows=[slot({pid:'123'}),slot({pid:'124',lever:'3',entry_price:'',unrealised_pnl:undefined})],f=fixture(rows);
  const p=(await f.adapter.fetchAccount()).positions[0];
  assert.equal(p.quantity,55_620);assert.equal(p.marginMode,'isolated');assert.ok(Number.isNaN(p.leverage));
  assert.equal(p.entryPrice,undefined);assert.equal(p.unrealizedPnlUsd,undefined);assert.equal(p.positionId,undefined);
  rows[1].pid='123';await assert.rejects(f.adapter.fetchAccount(),/multiple positions/);
  delete rows[0].pid;delete rows[1].pid;await assert.rejects(f.adapter.fetchPortfolioAccount(),/multiple positions/);
});

test('aggregation never nets opposite sides and unrelated split holdings do not block an empty contract inspection',async()=>{
  const f=fixture([slot(),slot({pos_margin_mode:'cross'}),slot({mode:'dual_short',size:'-30',pos_margin_mode:'cross'})]);
  const account=await f.ccxt.fetchAccount();assert.deepEqual(account.positions.map(p=>[p.side,p.quantity]),[['long',55_620],['short',300]]);
  assert.equal((await f.ccxt.fetchAccountOverview()).executionSupported,true);
  await f.ccxt.inspectTrading('BTC/USDT:USDT',2);
  await assert.rejects(f.ccxt.inspectTrading('ONE/USDT:USDT',2),/existing position/);
  const request:OrderRequest={base:'ONE',symbol:'ONE/USDT:USDT',side:'sell',quantity:55_620,limitPrice:.002,reduceOnly:true,clientOrderId:'fixture-close-ambiguous'};
  await assert.rejects(f.adapter.place(request,5562,.002),/exact position.*ambiguous/);
  assert.equal(f.calls.includes('financial-write'),false);await f.ccxt.close();
});

test('read-only portfolio forwards safe aggregate provenance and remains complete with mixed-margin holdings',async()=>{
  const now=Date.now(),f=fixture([slot(),slot({pos_margin_mode:'cross',lever:'3',open_time:'1790933775'})]);
  const monitor=new LivePortfolioMonitor(()=>config,{env:{GATE_API_KEY:'offline',GATE_API_SECRET:'offline'},now:()=>now,
    createClient:()=>({fetchAccount:()=>f.ccxt.fetchPortfolioAccount(),close:()=>f.ccxt.close()})});
  try{
    const portfolio=await monitor.refresh(),p=portfolio.exchanges[0].positions[0];
    assert.equal(portfolio.exchanges[0].status,'ready');assert.equal(p.quantity,55_620);assert.equal(p.splitPositionCount,2);
    assert.match(p.positionMetricReason!,/周期/);close(p.feesUsd,.1);assert.equal(p.liquidationStatus,'unavailable');
    const summary=portfolioPositionSummary(portfolio,now);assert.equal(summary.complete,true);assert.equal(summary.count,1);
    close(summary.exposureUsd,55_620*.002024);close(summary.unrealizedPnlUsd,-3.39282);
    const serialized=JSON.parse(JSON.stringify(p));assert.equal(serialized.leverage,null);close(serialized.feesUsd,.1);
    assert.equal(f.calls.includes('financial-write'),false);
  }finally{await monitor.stop();}
});

test('legacy legs observe the native aggregate once, while a disappeared native slot key never borrows that aggregate',async()=>{
  const now=Date.now(),f=fixture([slot(),slot({pos_margin_mode:'cross',open_time:'1790933775'})]),p=(await f.adapter.fetchAccount()).positions[0];
  const state={timestamp:now,config,positions:[],livePortfolio:{timestamp:now,pollIntervalMs:5000,maxAgeMs:15000,exchanges:[
    {exchange:'gate',credentialsConfigured:true,status:'ready',requestedAt:now,receivedAt:now,positions:[p]},
  ]}} as unknown as AppState;
  const external=ledgerAccountProjection(state,now)[0].position;
  delete external.long.accountPositionKey;delete external.short.accountPositionKey;
  state.positions=[{...external,id:'legacy-ledger',status:'attention'}];
  const legacy=ledgerPositionMetrics(state.positions[0],state.livePortfolio,now);assert.equal(legacy.long.quantity,55_620);
  assert.equal(legacy.cycleMismatch,true);close(legacy.long.feesUsd,.1);
  const projected=ledgerAccountProjection(state,now);assert.equal(projected.filter(record=>!record.historyOnly).length,1);
  assert.equal(projected[0].historyOnly,true);assert.equal(projected[1].origin,'account');
  const accountMetrics=ledgerPositionMetrics(projected[1].position,state.livePortfolio,now);
  assert.equal(accountMetrics.cycleMismatch,false);close(accountMetrics.long.feesUsd,.1);
  state.positions[0].long.accountPositionKey=accountPositionKey('gate',{...p,marginMode:'isolated',positionId:'old-disappeared-slot'});
  const gone=ledgerPositionMetrics(state.positions[0],state.livePortfolio,now);assert.equal(gone.long.quantity,0);assert.equal(gone.long.feesUsd,undefined);
  const records=ledgerAccountProjection(state,now);assert.equal(records.length,2);assert.equal(records[1].origin,'account');
  assert.equal(ledgerPositionMetrics(records[1].position,state.livePortfolio,now).long.quantity,55_620);
});
