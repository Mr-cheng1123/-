import test from 'node:test';
import assert from 'node:assert/strict';
import { GatePrivate } from '../src/adapters/gate-private.js';
import { CcxtAdapter } from '../src/adapters/ccxt.js';
import { OrderNotSubmittedError } from '../src/adapters/order-rejection.js';
import { exchangeClientId } from '../src/adapters/normalization.js';
import { defaultConfig } from '../src/shared/config.js';
import type { AccountPosition, OrderRequest } from '../src/shared/types.js';

const market = { id:'ONE_USDT',symbol:'ONE/USDT:USDT',base:'ONE',quote:'USDT',settle:'USDT',swap:true,linear:true,active:true,
  contractSize:10,precision:{amount:1,price:.000001},limits:{amount:{min:1},cost:{min:1}} };
const slot = (changes:Record<string,unknown> = {}):Record<string,unknown> => ({ contract:market.id,size:'2781',mode:'dual_long',pos_margin_mode:'isolated',
  lever:'2',leverage:'2',cross_leverage_limit:'2',mark_price:'.002024',liq_price:'.001057',entry_price:'.002085',
  unrealised_pnl:'-1.7',pnl_fund:'.01',pnl_fee:'-.05',pnl_pnl:'0',open_time:'1790927498',update_time:'1790934900',...changes });
function fixture(rows:Record<string,unknown>[]){
  const posted:any[] = [];
  const client:any = { markets:{[market.symbol]:market},market:()=>market,loadMarkets:async()=>({[market.symbol]:market}),precisionMode:4,
    amountToPrecision:(_s:string,n:number)=>String(n),priceToPrecision:(_s:string,n:number)=>String(n),
    privateFuturesGetSettleAccounts:async()=>({currency:'USDT',available:'400',total:'500',unrealised_pnl:'0',position_mode:'dual_plus',margin_mode:0}),
    privateFuturesGetSettlePositions:async()=>rows,
    privateFuturesPostSettleOrders:async(payload:any)=>{posted.push(payload);return {id:String(1000+posted.length)};},close:async()=>{} };
  return {client,posted,gate:new GatePrivate(client)};
}
function request(row:AccountPosition, clientOrderId='offline-close'):OrderRequest {
  return {clientOrderId,base:row.base,symbol:row.symbol,side:row.side==='long'?'sell':'buy',quantity:row.quantity,limitPrice:.002,reduceOnly:true,
    closePosition:{side:row.side,marginMode:row.marginMode,positionId:row.positionId,positionOpenedAt:row.positionOpenedAt}};
}

test('ONE cross and isolated slots are read separately and reduced by their exact mode, preserving all 55,620 coins', async()=>{
  const raw=[slot(),slot({pos_margin_mode:'cross',open_time:'1790933775'}),slot({mode:'dual_short',size:'-10',pos_margin_mode:'cross'})],before=structuredClone(raw),f=fixture(raw);
  const native=await f.gate.fetchClosePositions(market.symbol),longs=native.filter(p=>p.side==='long');
  assert.equal(longs.length,2);assert.deepEqual(longs.map(p=>p.quantity),[27_810,27_810]);
  assert.equal((await f.gate.fetchAccount()).positions.find(p=>p.side==='long')!.quantity,55_620);
  assert.equal(f.posted.length,0);
  for(const [index,row] of longs.entries()){
    const req=request(row,`offline-one-${index}`);await f.gate.validateClosePosition(req,2781);
    await f.gate.place(req,2781,.002);
  }
  assert.deepEqual(f.posted.map(p=>[p.contract,p.size,p.pos_margin_mode,p.reduce_only,p.tif]),[
    [market.id,'-2781','isolated',true,'ioc'],[market.id,'-2781','cross',true,'ioc']]);
  assert.ok(f.posted.every(p=>p.pid===undefined&&p.auto_size===undefined&&p.close===undefined));assert.deepEqual(raw,before);
});

test('same-margin dual_plus slots require their exact int64 PID; no opposite or neighbouring slot is targeted', async()=>{
  const ids=['922337203685477581','922337203685477582'],raw=ids.map(pid=>slot({pid})),f=fixture(raw);
  const rows=await f.gate.fetchClosePositions(market.symbol);
  for(const [index,row] of rows.entries())await f.gate.place(request(row,`offline-pid-${index}`),2781,.002);
  assert.deepEqual(f.posted.map(p=>p.pid),ids);
  assert.ok(f.posted.every(p=>typeof p.pid==='string'&&p.reduce_only===true&&p.pos_margin_mode==='isolated'));
  delete raw[1].pid;await assert.rejects(f.gate.fetchClosePositions(market.symbol),/multiple positions/);
});

test('a changed slot, cycle, direction, margin or insufficient quantity fails before any financial request', async()=>{
  const cases:Record<string,unknown>[]=[{pid:'2'},{pos_margin_mode:'cross'},{open_time:'1790933775'},{size:'100'},
    {mode:'dual_short',size:'-2781'}];
  for(const change of cases){
    const raw=[slot({pid:'1'})],f=fixture(raw),row=(await f.gate.fetchClosePositions(market.symbol))[0],req=request(row);
    Object.assign(raw[0],change);
    await assert.rejects(f.gate.place(req,2781,.002),OrderNotSubmittedError);assert.equal(f.posted.length,0);
  }
  const f=fixture([slot({pid:'1'})]),row=(await f.gate.fetchClosePositions(market.symbol))[0];
  await assert.rejects(f.gate.place({...request(row),reduceOnly:false},2781,.002),OrderNotSubmittedError);
  await assert.rejects(f.gate.place({...request(row),closePosition:{...request(row).closePosition!,positionId:undefined}},2781,.002),OrderNotSubmittedError);
  assert.equal(f.posted.length,0);
});

test('partial quantity stays bounded to selected slot; duplicate IDs and unknown POST never cause another submission', async()=>{
  const f=fixture([slot({pid:'1'}),slot({pid:'2'})]),row=(await f.gate.fetchClosePositions(market.symbol))[0];
  const req={...request(row),quantity:100};
  await f.gate.place(req,10,.002);await f.gate.place(req,10,.002);assert.equal(f.posted.length,1);
  await assert.rejects(f.gate.place({...req,quantity:110},11,.002),/reused/);
  const timeout=fixture([slot({pid:'1'})]);let attempts=0;
  timeout.client.privateFuturesPostSettleOrders=async()=>{attempts++;throw new Error('mock ambiguous transport timeout');};
  await assert.rejects(timeout.gate.place(req,10,.002),/timeout/);
  assert.equal(await timeout.gate.place(req,10,.002),undefined);assert.equal(attempts,1);
});

test('Ccxt native-slot validation is GET-only and refuses unsupported selectors before order registration', async()=>{
  const f=fixture([slot(),slot({pos_margin_mode:'cross'})]);
  const adapter=new CcxtAdapter('gate',{...defaultConfig,mode:'live',dataSource:'public'},f.client);
  try{
    const rows=await adapter.fetchClosePositions(market.symbol);assert.equal(rows.length,2);
    await adapter.validateOrder(request(rows[0]));assert.equal(f.posted.length,0);
    const bybit=new CcxtAdapter('bybit',{...defaultConfig,mode:'live',dataSource:'public'},f.client);
    try{await assert.rejects(bybit.validateOrder(request(rows[0])),/Unsupported exact close selector/);}finally{await bybit.close();}
  }finally{await adapter.close();}
});

test('exact slots bypass private WS confirmations and retain selector identity after a persisted-request restart', async()=>{
  const f=fixture([slot({pid:'922337203685477581'})]),row=(await f.gate.fetchClosePositions(market.symbol))[0],req=request(row);
  f.client.apiKey='offline-only';f.client.secret='offline-only';
  let margin='cross',pid:string|undefined=row.positionId,reads=0,wsCalls=0;
  const nativeOrder=()=>({id:'1001',contract:market.id,text:exchangeClientId('gate',req.clientOrderId),size:'-2781',left:'-2781',
    price:'.002',fill_price:'0',tif:'ioc',is_reduce_only:true,is_close:false,status:'finished',create_time:1790927498,
    pos_margin_mode:margin,...(pid?{pid}:{})});
  f.client.privateFuturesGetSettleOrdersOrderId=async()=>{reads++;return nativeOrder();};
  const stream={observe:()=>{wsCalls++;},wait:async()=>{wsCalls++;throw new Error('exact slot must use REST');},
    result:()=>{wsCalls++;throw new Error('exact slot must use REST');},close:async()=>{}};
  const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const};
  const adapter=new CcxtAdapter('gate',config,f.client);(adapter as any).privateEvents=stream;
  try{
    assert.equal((await adapter.placeOrder(req)).status,'unknown','wrong native margin cannot be accepted via WS');
    assert.equal(f.posted.length,1);assert.equal(reads,1);assert.equal(wsCalls,0);
    const persisted=JSON.parse(JSON.stringify(req)) as OrderRequest;
    await assert.rejects(adapter.reconcileOrder({...persisted,closePosition:{...persisted.closePosition!,positionId:'other'}},'1001'),/reused/);
    const fresh=fixture([slot({pid:row.positionId})]);fresh.client.apiKey='offline-only';fresh.client.secret='offline-only';
    fresh.client.privateFuturesGetSettleOrdersOrderId=f.client.privateFuturesGetSettleOrdersOrderId;
    const restarted=new CcxtAdapter('gate',config,fresh.client);(restarted as any).privateEvents=stream;
    try{
      assert.equal((await restarted.reconcileOrder(persisted,'1001')).status,'unknown','restart must retain margin identity');
      margin='isolated';pid='922337203685477582';
      assert.equal((await restarted.reconcileOrder(persisted,'1001')).status,'unknown','restart must retain PID identity when returned');
      pid=undefined;
      assert.equal((await restarted.reconcileOrder(persisted,'1001')).status,'cancelled','Gate write-only PID may be absent from an otherwise exact terminal order');
      assert.equal(fresh.posted.length,0);assert.equal(wsCalls,0);
    }finally{await restarted.close();}
  }finally{await adapter.close();}
});
