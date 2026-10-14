import test from 'node:test';
import assert from 'node:assert/strict';
import ccxt from 'ccxt';
import { GatePrivate, gateReadError } from '../src/adapters/gate-private.js';
import { exchangeClientId, unknownOrder } from '../src/adapters/normalization.js';
import type { OrderRequest } from '../src/shared/types.js';

const market={id:'BTC_USDT',symbol:'BTC/USDT:USDT',base:'BTC',quote:'USDT',settle:'USDT',swap:true,linear:true,active:true,contractSize:.001,
  precision:{amount:1,price:.1},limits:{amount:{min:1},cost:{min:5}}};
const request:OrderRequest={clientOrderId:'gate-fixture-only',symbol:market.symbol,base:'BTC',side:'buy',quantity:.1,limitPrice:60000,reduceOnly:false};
const account=()=>({currency:'USDT',available:'321.125',total:'500',unrealised_pnl:'12.5',in_dual_mode:true,position_mode:'dual_plus',
  margin_mode:3,margin_mode_name:'single_currency',enable_credit:true,enable_evolved_classic:true,enable_new_dual_mode:true});
const position=(changes:any={})=>({contract:'BTC_USDT',size:'100',mode:'dual_long',pid:'922337203685477581',pos_margin_mode:'isolated',lever:'2',
  leverage:'0',mark_price:'60000',liq_price:'30000',...changes});
const rawOrder=(req=request,changes:any={})=>({id:'10001',contract:market.id,size:req.side==='buy'?'100':'-100',left:'40',price:'60000',fill_price:'59999',
  tif:'ioc',text:exchangeClientId('gate',req.clientOrderId),is_reduce_only:req.reduceOnly,is_close:false,status:'finished',finish_as:'ioc',
  pos_margin_mode:'cross',create_time:1770000000,finish_time:1770000001,...changes});
const trade=(changes:any={})=>({id:'501',order_id:'10001',contract:'BTC_USDT',size:'60',price:'59999',fee:'1.8',point_fee:'0',...changes});

test('Gate Maker terminal execution requires native poc and retains actual trade fee rebates',async()=>{
  const maker={...request,postOnly:true},s=setup({privateFuturesGetSettleOrdersOrderId:async()=>rawOrder(maker,{tif:'poc'}),
    privateFuturesGetSettleMyTrades:async()=>[trade({fee:'-.0001'})]});
  const good=await s.adapter.inspectOrder(maker);assert.equal(good.status,'partial');assert.equal(good.feeUsd,-.0001);
  s.client.privateFuturesGetSettleOrdersOrderId=async()=>rawOrder(maker,{tif:'ioc'});
  assert.equal((await s.adapter.inspectOrder(maker)).status,'unknown','IOC cannot be misclassified as a Maker execution');
});
test('Gate live position metrics preserve exchange PnL and normalize funding/fee signs without writes',async()=>{
  const s=setup({privateFuturesGetSettlePositions:async()=>[position({entry_price:'59990',unrealised_pnl:'1',pnl_fund:'.12',pnl_fee:'-.03'})]});
  const p=(await s.adapter.fetchAccount()).positions[0];assert.equal(p.quantity,.1);assert.equal(p.entryPrice,59990);
  assert.equal(p.marginMode,'isolated');
  assert.equal(p.unrealizedPnlUsd,1);assert.equal(p.fundingUsd,.12);assert.equal(p.feesUsd,.03);
  assert.ok(s.calls.every(c=>!['place','cancel','set-leverage'].includes(c.method)));
  s.client.privateFuturesGetSettlePositions=async()=>[position({pos_margin_mode:'cross'})];
  assert.equal((await s.adapter.fetchAccount()).positions[0].marginMode,'crossed');
});
function setup(overrides:Record<string,any>={}){
  const calls:{method:string;params:any}[]=[];
  const leverage:Record<string,string>={dual_long:'10',dual_short:'10'};
  const method=(name:string,fn:(params:any)=>any)=>async(params:any)=>{calls.push({method:name,params});return fn(params);};
  const client:any={markets:{[market.symbol]:market,'BTC/USDT':{...market,id:'BTC_USDT',symbol:'BTC/USDT',swap:false}},market:()=>market,
    amountToPrecision:(_s:string,n:number)=>String(Math.floor(n)),priceToPrecision:(_s:string,n:number)=>(Math.round(n*10)/10).toFixed(1),
    privateFuturesGetSettleAccounts:method('account',account),privateFuturesGetSettlePositions:method('positions',()=>[]),
    privateUnifiedGetAccounts:method('unified-account',()=>({mode:'single_currency',unified_account_total_equity:'512.5'})),
    privateFuturesGetSettleOrders:method('orders',()=>[]),
    privateFuturesGetSettlePriceOrders:method('conditional-orders',()=>[]),
    privateFuturesGetSettlePositionsContract:method('single-position',()=>{throw new Error('single GET is not supported for split mode');}),
    privateFuturesGetSettleGetLeverageContract:method('get-leverage',p=>({Lever:leverage[p.dual_side]})),
    privateFuturesPostSettlePositionsContractSetLeverage:method('set-leverage',p=>{assert.equal(p.dual_side,undefined);leverage.dual_long=p.leverage;leverage.dual_short=p.leverage;return position({lever:p.leverage});}),
    privateFuturesPostSettleOrders:method('place',()=>({id:'10001'})),
    privateFuturesGetSettleOrdersOrderId:method('order-info',()=>rawOrder()),
    privateFuturesDeleteSettleOrdersOrderId:method('cancel',()=>rawOrder(request,{status:'finished'})),
    privateFuturesGetSettleMyTrades:method('trades',()=>[trade()]),...overrides};
  return {client,calls,adapter:new GatePrivate(client,.0005),leverage};
}

test('Gate native holding fields retain seconds lifecycle, realized price PnL and signed cash without false liquidation distance',async()=>{
  const raw=position({size:'-11',mode:'dual_short',entry_price:'.9022',mark_price:'.906',liq_price:'0',
    unrealised_pnl:'-.418',pnl_pnl:'.0245',pnl_fund:'.01492205',pnl_fee:'-.049621',open_time:1790878400,update_time:1790913612});
  const s=setup({privateFuturesGetSettlePositions:async()=>[raw]});
  const p=(await s.adapter.fetchAccount()).positions[0];
  assert.equal(p.realizedPnlUsd,.0245);assert.equal(p.fundingUsd,.01492205);assert.equal(p.feesUsd,.049621);
  assert.equal(p.positionOpenedAt,1790878400000);assert.equal(p.positionUpdatedAt,1790913612000);
  assert.equal(p.liquidationPrice,0);assert.equal(p.liquidationStatus,'unavailable');assert.ok(p.liquidationReason);
  delete (raw as any).pnl_pnl;delete (raw as any).pnl_fund;delete (raw as any).pnl_fee;
  const missing=(await s.adapter.fetchAccount()).positions[0];
  assert.equal(missing.realizedPnlUsd,undefined);assert.equal(missing.fundingUsd,undefined);assert.equal(missing.feesUsd,undefined);
  assert.ok(s.calls.every(c=>['account','positions','unified-account'].includes(c.method)));
});

test('Gate classic equity retains total plus UPL without querying the unified account',async()=>{
  const s=setup({privateFuturesGetSettleAccounts:async()=>({...account(),margin_mode:0,margin_mode_name:undefined,total:'500',unrealised_pnl:'-7.5'}),
    privateUnifiedGetAccounts:async()=>{throw new Error('classic accounts must not read unified balances');}});
  const accountState=await s.adapter.fetchAccount(),overview=await s.adapter.fetchAccountOverview();
  assert.equal(accountState.equityUsd,492.5);assert.equal(overview.equityUsd,492.5);
  assert.equal(accountState.freeUsd,321.125);assert.equal(overview.freeUsd,321.125);
});

test('Gate UTA uses the native account USD equity once per observation and never adds futures UPL again',async()=>{
  const s=setup({privateFuturesGetSettleAccounts:async()=>({...account(),total:'0.000000007411',unrealised_pnl:'-7.52',available:'1963.49'}),
    privateUnifiedGetAccounts:async()=>{s.calls.push({method:'unified-account',params:{}});return {
      mode:'single_currency',unified_account_total_equity:'2924.1',balances:{USDT:{equity:'2921.91',iso_balance:'950.27'}}};}});
  const accountState=await s.adapter.fetchAccount();
  assert.equal(accountState.equityUsd,2924.1);assert.equal(accountState.freeUsd,1963.49);
  assert.equal(s.calls.filter(c=>c.method==='unified-account').length,1);
  assert.equal((await s.adapter.fetchAccountOverview()).equityUsd,2924.1);
  assert.equal(s.calls.filter(c=>c.method==='unified-account').length,2);
  await s.adapter.inspectTrading(market.symbol,2);
  assert.equal(s.calls.filter(c=>c.method==='unified-account').length,2,'entry preflight does not request display-only total equity');
  assert.ok(!s.calls.some(c=>['place','cancel','set-leverage'].includes(c.method)));
});

test('Gate UTA missing, invalid or failed account equity stays unavailable rather than falling back to a zero classic wallet',async()=>{
  for(const value of [undefined,null,'','bad',Infinity]){
    const s=setup({privateUnifiedGetAccounts:async()=>({unified_account_total_equity:value})});
    await assert.rejects(s.adapter.fetchAccount(),/unified account equity is unavailable/);
    await assert.rejects(s.adapter.fetchAccountOverview(),/unified account equity is unavailable/);
  }
  const s=setup({privateUnifiedGetAccounts:async()=>{throw new Error('fixture unified account unavailable');}});
  await assert.rejects(s.adapter.fetchAccount(),/fixture unified account unavailable/);
  await assert.rejects(s.adapter.fetchAccountOverview(),/fixture unified account unavailable/);
  assert.ok(!s.calls.some(c=>['place','cancel','set-leverage'].includes(c.method)));
});

test('Gate split account and read-only inspection use raw mode and both cross leverages without any writes',async()=>{
  const s=setup();assert.deepEqual(await s.adapter.fetchAccount(),{freeUsd:321.125,equityUsd:512.5,positions:[],positionMode:'dual_plus'});
  const overview=await s.adapter.fetchAccountOverview();assert.equal(overview.positionMode,'dual_plus');assert.equal(overview.executionSupported,true);
  await s.adapter.inspectTrading(market.symbol,2);
  assert.deepEqual(s.calls.filter(c=>c.method==='get-leverage').map(c=>c.params),['dual_long','dual_short'].map(dual_side=>
    ({settle:'usdt',contract:'BTC_USDT',pos_margin_mode:'cross',dual_side})));
  assert.ok(!s.calls.some(c=>['set-leverage','place','cancel','single-position'].includes(c.method)));
  assert.ok(s.calls.filter(c=>c.method==='positions').every(c=>c.params.holding===true&&c.params.limit===undefined));
  s.client.privateFuturesGetSettleAccounts=async()=>({...account(),in_dual_mode:false});
  assert.equal((await s.adapter.fetchAccount()).positionMode,'dual_plus');
});

test('Gate split positions use base quantity and aggregate identified same-side slots without approving order routing',async()=>{
  const s=setup({privateFuturesGetSettlePositions:async()=>[position(),position({mode:'dual_short',size:'-70',pid:'922337203685477582'})]});
  const state=await s.adapter.fetchAccount();
  assert.deepEqual(state.positions.map(p=>[p.side,p.quantity,p.leverage]),[['long',.1,2],['short',.07,2]]);
  for(const changed of [{pid:null},{pid:9223372036854775807},{pos_margin_mode:undefined},{lever:'0'},{mark_price:null},{size:'bad'},{mode:'single'}]){
    s.client.privateFuturesGetSettlePositions=async()=>[position(changed)];await assert.rejects(s.adapter.fetchAccount());
  }
  s.client.privateFuturesGetSettlePositions=async()=>[position(),position({pid:'922337203685477582',pos_margin_mode:'cross'})];
  const aggregate=(await s.adapter.fetchAccount()).positions[0];assert.equal(aggregate.quantity,.2);assert.equal(aggregate.splitPositionCount,2);
  assert.equal(aggregate.marginMode,undefined);assert.equal(aggregate.positionId,undefined);
  const overview=await s.adapter.fetchAccountOverview();assert.equal(overview.executionSupported,true);assert.equal(overview.positionCount,2);
  await assert.rejects(s.adapter.inspectTrading(market.symbol,2),/existing position/);
});

test('Gate portfolio aggregates cross and isolated same-side slots without PID while native entry routing remains blocked',async()=>{
  const s=setup({privateFuturesGetSettlePositions:async()=>[
    position({pid:undefined,size:'10',entry_price:'59990',unrealised_pnl:'1',pnl_fund:'.1',pnl_fee:'-.02'}),
    position({pid:undefined,size:'20',pos_margin_mode:'cross',entry_price:'59980',unrealised_pnl:'2',pnl_fund:'.2',pnl_fee:'-.04'})]});
  const state=await s.adapter.fetchPortfolioAccount();
  assert.deepEqual(state.positions.map(p=>[p.marginMode,p.quantity,p.positionId,p.unrealizedPnlUsd,p.fundingUsd,p.feesUsd]),[
    [undefined,.03,undefined,3,.30000000000000004,.06]]);
  assert.equal(state.freeUsd,321.125);assert.equal(state.equityUsd,512.5);assert.equal(state.positionMode,'dual_plus');
  assert.equal((await s.adapter.fetchAccount()).positions[0].quantity,.03);
  assert.ok(s.calls.every(c=>['account','unified-account'].includes(c.method)));
  await assert.rejects(s.adapter.inspectTrading(market.symbol,2),/existing position/);
});

test('Gate portfolio aggregates distinct same-margin native PIDs without borrowing one native routing identity',async()=>{
  const s=setup({privateFuturesGetSettlePositions:async()=>[position(),position({size:'20',pid:'922337203685477582'})]});
  const state=await s.adapter.fetchPortfolioAccount();
  assert.equal(state.positions.length,1);assert.equal(state.positions[0].positionId,undefined);
  assert.ok(Math.abs(state.positions[0].quantity-.12)<1e-12);assert.equal(state.positions[0].marginMode,'isolated');
  assert.equal(state.positions[0].splitPositionCount,2);
  assert.equal((await s.adapter.fetchAccount()).positions.length,1);
  s.client.privateFuturesGetSettlePositions=async()=>[position()];
  assert.equal((await s.adapter.fetchAccount()).positions[0].positionId,'922337203685477581','a single native slot retains its exact observation identity');
  assert.ok(s.calls.every(c=>['account','unified-account'].includes(c.method)));
});

test('Gate portfolio rejects repeated PID and slots without distinct native identity evidence',async()=>{
  for(const raw of [
    [position(),position({pos_margin_mode:'cross'})],
    [position(),position({size:'-10',mode:'dual_short'})],
    [position({pid:undefined}),position({pid:undefined})],
    [position({pid:undefined}),position({pid:'123'})],
    [position(),position({pid:null,pos_margin_mode:'cross'})],
    [position(),position({pid:9223372036854775807,pos_margin_mode:'cross'})],
  ]){
    const s=setup({privateFuturesGetSettlePositions:async()=>raw});
    await assert.rejects(s.adapter.fetchPortfolioAccount(),/multiple positions|split position ID is unverified/);
    assert.ok(s.calls.every(c=>c.method==='account'));
  }
});

test('Gate portfolio never relaxes same-side uniqueness outside native split mode',async()=>{
  for(const mode of ['single','dual']){
    const s=setup({privateFuturesGetSettleAccounts:async()=>({...account(),position_mode:mode}),
      privateFuturesGetSettlePositions:async()=>[
        position({mode:mode==='single'?'single':'dual_long'}),
        position({mode:mode==='single'?'single':'dual_long',pid:'922337203685477582',pos_margin_mode:'cross'})]});
    await assert.rejects(s.adapter.fetchPortfolioAccount(),/multiple positions/);
    await assert.rejects(s.adapter.fetchAccount(),/multiple positions/);
    assert.equal(s.calls.length,0);
  }
});

test('Gate missing balances and unknown/account-mismatched modes do not become execution-ready',async()=>{
  for(const changed of [{available:undefined},{total:''},{unrealised_pnl:null},{currency:'BTC'},
    {position_mode:'unknown'},{margin_mode_name:'portfolio_margin'}]){
    const s=setup({privateFuturesGetSettleAccounts:async()=>({...account(),...changed})});
    await assert.rejects(s.adapter.fetchAccount());await assert.rejects(s.adapter.inspectTrading(market.symbol,2));
    assert.ok(!s.calls.some(c=>['set-leverage','place'].includes(c.method)));
  }
  assert.ok(gateReadError(new Error('gate: account position mode is unverified'))?.includes('持仓模式'));
  assert.equal(gateReadError(new Error('untrusted sensitive response')),undefined);
});

test('Gate prepare checks absence of positions and orders, writes shared cross leverage once and verifies both Lever readbacks',async()=>{
  const s=setup();await s.adapter.prepare(market.symbol,2);
  assert.deepEqual(s.calls.filter(c=>c.method==='set-leverage').map(c=>c.params),[{settle:'usdt',contract:'BTC_USDT',leverage:'2',margin_mode:'cross'}]);
  assert.equal(await new GatePrivate(s.client).assertTradingMode(market.symbol),'dual_plus');
  for(const override of [
    {privateFuturesGetSettlePositions:async()=>[position()]},{privateFuturesGetSettleOrders:async()=>[{id:'pending'}]},
    {privateFuturesGetSettlePriceOrders:async()=>[{id:'pending-conditional'}]},
    {privateFuturesGetSettleGetLeverageContract:async()=>({lever:'2'})},
  ]){
    const blocked=setup(override);await assert.rejects(blocked.adapter.prepare(market.symbol,2));
    assert.ok(!blocked.calls.some(c=>c.method==='set-leverage'));
  }
  const stale=setup({privateFuturesPostSettlePositionsContractSetLeverage:async()=>({})});
  await assert.rejects(stale.adapter.prepare(market.symbol,2),/could not be verified/);
  const changed=setup();await changed.adapter.prepare(market.symbol,2);changed.leverage.dual_short='10';
  await assert.rejects(new GatePrivate(changed.client).place(request,100,60000),/could not be verified/);
  assert.ok(!changed.calls.some(c=>c.method==='place'));
});

test('Gate legacy single and dual empty contracts switch to cross, set leverage and verify without split-position parameters',async()=>{
  for(const mode of ['single','dual']){
    let effective='3',margin='isolated';const switches:any[]=[],writes:any[]=[];
    const switchMode=async(path:string,api:string[],method:string,params:any,_headers:any,body:string)=>{
      assert.equal(path,mode==='single'?'{settle}/positions/cross_mode':'{settle}/dual_comp/positions/cross_mode');
      assert.deepEqual(api,['private','futures']);assert.equal(method,'POST');assert.deepEqual(params,{settle:'usdt'});
      switches.push(JSON.parse(body));margin='cross';return {};};
    const s=setup({privateFuturesGetSettleAccounts:async()=>({...account(),position_mode:mode,in_dual_mode:mode!=='single'}),
      privateFuturesGetSettlePositionsContract:async()=>position({mode:'single',size:'0',pos_margin_mode:margin,leverage:effective,lever:effective}),
      privateFuturesGetSettleDualCompPositionsContract:async()=>['dual_long','dual_short'].map(side=>position({mode:side,size:'0',pos_margin_mode:margin,leverage:effective,lever:effective})),
      request:switchMode,
      privateFuturesPostSettlePositionsContractSetLeverage:async(p:any)=>{writes.push(p);effective=p.leverage;return {};}});
    await s.adapter.prepare(market.symbol,2);await s.adapter.place(request,100,60000);
    assert.deepEqual(switches,[{contract:market.id,mode:'CROSS'}]);assert.deepEqual(writes,[{settle:'usdt',contract:market.id,margin_mode:'cross',leverage:'2'}]);
    const payload=s.calls.find(c=>c.method==='place')?.params;assert.equal(payload.pos_margin_mode,undefined);assert.equal(payload.pid,undefined);
    s.client.privateFuturesGetSettleOrdersOrderId=async()=>rawOrder(request,{pos_margin_mode:undefined});
    assert.equal((await s.adapter.reconcile(request)).status,'partial');
  }
});

test('Gate refuses an unverified cross switch and never switches a contract with an existing position or conditional order',async()=>{
  for(const mode of ['single','dual']){
    let switches=0;
    const legacy={privateFuturesGetSettleAccounts:async()=>({...account(),position_mode:mode}),
      privateFuturesGetSettlePositionsContract:async()=>position({mode:'single',size:'0'}),
      privateFuturesGetSettleDualCompPositionsContract:async()=>['dual_long','dual_short'].map(side=>position({mode:side,size:'0'})),
      request:async()=>{switches++;return {};}};
    const stale=setup(legacy);
    await assert.rejects(stale.adapter.prepare(market.symbol,2),/requested cross margin/);
    assert.equal(switches,1);assert.ok(!stale.calls.some(c=>['set-leverage','place'].includes(c.method)));
    for(const override of [{privateFuturesGetSettlePositions:async()=>[position()]},
      {privateFuturesGetSettlePriceOrders:async()=>[{id:'pending-conditional'}]}]){
      const blocked=setup({...legacy,...override});switches=0;
      await assert.rejects(blocked.adapter.prepare(market.symbol,2),/existing position or pending order/);
      assert.equal(switches,0);assert.ok(!blocked.calls.some(c=>['set-leverage','place'].includes(c.method)));
    }
  }
});

test('Gate legacy cross leverage reads cross_leverage_limit when lever is absent and does not switch an already-cross contract',async()=>{
  const s=setup({privateFuturesGetSettleAccounts:async()=>({...account(),position_mode:'single'}),
    privateFuturesGetSettlePositionsContract:async()=>position({mode:'single',size:'0',pos_margin_mode:undefined,lever:undefined,leverage:'0',cross_leverage_limit:'2'}),
    privateFuturesPostSettlePositionsCrossMode:async()=>{throw new Error('must not switch an already-cross contract');}});
  await s.adapter.prepare(market.symbol,2);await s.adapter.place(request,100,60000);
  assert.equal(s.calls.filter(c=>c.method==='set-leverage').length,0);assert.equal(s.calls.filter(c=>c.method==='place').length,1);
});

test('Gate prepare is idempotent and updates shared cross leverage once when either readback differs',async()=>{
  const ready=setup();ready.leverage.dual_long='2';ready.leverage.dual_short='2';
  await ready.adapter.prepare(market.symbol,2);
  assert.equal(ready.calls.filter(c=>c.method==='set-leverage').length,0);
  assert.equal(ready.calls.filter(c=>c.method==='get-leverage').length,4); // Initial check plus fresh readback for both sides.
  await new GatePrivate(ready.client).prepare(market.symbol,2);
  assert.equal(ready.calls.filter(c=>c.method==='set-leverage').length,0);
  const partial=setup();partial.leverage.dual_long='2';
  await partial.adapter.prepare(market.symbol,2);
  assert.deepEqual(partial.calls.filter(c=>c.method==='set-leverage').map(c=>c.params),[{settle:'usdt',contract:market.id,margin_mode:'cross',leverage:'2'}]);
  assert.deepEqual(partial.leverage,{dual_long:'2',dual_short:'2'});
});

test('Gate NO_CHANGE is accepted only after fresh complete leverage verification and never authorizes a failed preparation',async()=>{
  for(const changed of [true,false]){
    const s=setup({privateFuturesPostSettlePositionsContractSetLeverage:async(p:any)=>{
      if(changed){s.leverage.dual_long=p.leverage;s.leverage.dual_short=p.leverage;}
      throw Object.assign(new Error('fixed business error'),{apiCode:'NO_CHANGE'});
    }});
    if(changed){await s.adapter.prepare(market.symbol,2);assert.equal(await s.adapter.place(request,100,60000),'10001');}
    else{
      await assert.rejects(s.adapter.prepare(market.symbol,2),/could not be verified/);
      await assert.rejects(s.adapter.place(request,100,60000),/requires verified preparation/);
      assert.ok(!s.calls.some(c=>c.method==='place'));
    }
  }
  const denied=setup({privateFuturesPostSettlePositionsContractSetLeverage:async()=>{throw Object.assign(new Error('denied'),{apiCode:'READ_ONLY'});}});
  await assert.rejects(denied.adapter.prepare(market.symbol,2),/denied/);
  await assert.rejects(denied.adapter.place(request,100,60000),/requires verified preparation/);
});

test('Gate unchanged initial leverage still requires a fresh matching mode and leverage readback',async()=>{
  let reads=0;
  const s=setup({privateFuturesGetSettleGetLeverageContract:async()=>({Lever:++reads<=2?'2':'3'})});
  await assert.rejects(s.adapter.prepare(market.symbol,2),/could not be verified/);
  assert.ok(!s.calls.some(c=>c.method==='set-leverage'));
  await assert.rejects(s.adapter.place(request,100,60000),/requires verified preparation/);
});

test('Gate native split IOC opens cross and closes existing isolated positions without mode changes',async()=>{
  for(const [side,reduceOnly,target] of [['buy',false,'dual_long'],['sell',false,'dual_short'],['sell',true,'dual_long'],['buy',true,'dual_short']] as const){
    const req={...request,side,reduceOnly},s=setup();await s.adapter.prepare(market.symbol,2);
    if(reduceOnly)s.client.privateFuturesGetSettlePositions=async()=>[position({mode:target,size:target==='dual_long'?'100':'-100'})];
    assert.equal(await new GatePrivate(s.client).place(req,100,60000),'10001');
    const payload=s.calls.find(c=>c.method==='place')?.params;
    assert.deepEqual(payload,{settle:'usdt',contract:'BTC_USDT',size:side==='buy'?'100':'-100',price:'60000',tif:'ioc',
      text:exchangeClientId('gate',req.clientOrderId),reduce_only:reduceOnly,pos_margin_mode:reduceOnly?'isolated':'cross',...(reduceOnly?{pid:'922337203685477581'}:{})});
    assert.ok(!Object.hasOwn(payload,'auto_size'));assert.ok(!Object.hasOwn(payload,'close'));assert.ok(!Object.hasOwn(payload,'position_side'));
    s.client.privateFuturesGetSettleOrdersOrderId=async()=>rawOrder(req,{...(reduceOnly?{pid:'922337203685477581',pos_margin_mode:'isolated'}:{})});
    s.client.privateFuturesGetSettleMyTrades=async()=>[trade({size:side==='buy'?'60':'-60',price:side==='buy'?'59999':'60000'})];
    const result=await new GatePrivate(s.client).reconcile(req);assert.equal(result.status,'partial');assert.equal(result.filledQuantity,.06);assert.equal(result.feeUsd,1.8);
    assert.equal(await new GatePrivate(s.client).place(req,100,60000),'10001');assert.equal(s.calls.filter(c=>c.method==='place').length,1);
  }
});

test('Gate quantitative close rejects absent, ambiguous, unknown-margin, wrong-side and undersized positions before posting',async()=>{
  const req={...request,side:'sell' as const,reduceOnly:true};
  for(const positions of [[],[position({pos_margin_mode:'unknown'})],[position({size:'20'})],
    [position({mode:'dual_short',size:'-100'})],[position({pid:null})],[position(),position({pid:'2'})]]){
    const s=setup({privateFuturesGetSettlePositions:async()=>positions});await assert.rejects(s.adapter.place(req,100,60000));
    assert.ok(!s.calls.some(c=>['place','cancel'].includes(c.method)));
  }
  const precise=setup();await precise.adapter.prepare(market.symbol,2);
  await assert.rejects(precise.adapter.place({...request,clientOrderId:'bad-qty'},100.1,60000),/bounds/);
  await assert.rejects(precise.adapter.place({...request,clientOrderId:'bad-price'},100,60000.1),/bounds/);
});

test('Gate optional PID can be absent from unique positions and write-only order responses',async()=>{
  const req={...request,side:'sell' as const,reduceOnly:true};
  for(const includePositionPid of [false,true]){
    const s=setup({privateFuturesGetSettlePositions:async()=>[position(includePositionPid?{}:{pid:undefined})],
      privateFuturesGetSettleOrdersOrderId:async()=>rawOrder(req,{pos_margin_mode:'isolated'}),privateFuturesGetSettleMyTrades:async()=>[trade({size:'-60',price:'60000'})]});
    assert.equal((await s.adapter.fetchAccount()).positions.length,1);
    await s.adapter.place(req,100,60000);
    assert.equal(s.calls.find(c=>c.method==='place')?.params.pid,includePositionPid?'922337203685477581':undefined);
    assert.equal((await new GatePrivate(s.client).reconcile(req)).status,'partial');
  }
});

test('Gate verified reduce-only close is not blocked by a later leverage change',async()=>{
  const s=setup();await s.adapter.prepare(market.symbol,2);
  s.leverage.dual_long='3';s.leverage.dual_short='3';
  s.client.privateFuturesGetSettlePositions=async()=>[position({lever:'3'})];
  await s.adapter.place({...request,side:'sell',reduceOnly:true},100,60000);
  assert.equal(s.calls.filter(c=>c.method==='place').length,1);
});

test('Gate reduce-only close follows the actual cross or isolated slot without new-entry settings or margin writes',async()=>{
  const req={...request,side:'sell' as const,reduceOnly:true};
  for(const margin of ['cross','isolated']){
    const s=setup({privateFuturesGetSettlePositions:async()=>[position({pos_margin_mode:margin})],
      privateFuturesGetSettleGetLeverageContract:async()=>{throw new Error('unrelated entry setting unavailable');},
      privateFuturesGetSettleOrdersOrderId:async()=>rawOrder(req,{pos_margin_mode:margin}),
      privateFuturesGetSettleMyTrades:async()=>[trade({size:'-60',price:'60000'})]});
    await s.adapter.place(req,100,60000);
    assert.equal(s.calls.find(c=>c.method==='place')?.params.pos_margin_mode,margin);
    assert.equal((await s.adapter.reconcile(req)).status,'partial');
    assert.ok(!s.calls.some(c=>c.method==='set-leverage'));
  }
});

test('Gate restart can inspect historical isolated and cross orders while an in-session margin mismatch stays unknown',async()=>{
  for(const margin of ['cross','isolated']){
    const s=setup({privateFuturesGetSettleOrdersOrderId:async()=>rawOrder(request,{pos_margin_mode:margin})});
    assert.equal((await s.adapter.inspectOrder(request,undefined,'10001')).status,'partial');
    assert.ok(!s.calls.some(c=>['place','set-leverage','cancel'].includes(c.method)));
  }
  const s=setup();await s.adapter.prepare(market.symbol,2);await s.adapter.place(request,100,60000);
  s.client.privateFuturesGetSettleOrdersOrderId=async()=>rawOrder(request,{pos_margin_mode:'isolated',status:'open'});
  assert.equal((await s.adapter.reconcile(request)).status,'unknown');
  assert.ok(!s.calls.some(c=>c.method==='cancel'));
});

test('Gate unknown POST is not resubmitted, including fresh adapter instances and concurrent calls',async()=>{
  let posts=0;
  const s=setup({privateFuturesPostSettleOrders:async()=>{posts++;throw new Error('timeout after sending');}});await s.adapter.prepare(market.symbol,2);
  await assert.rejects(s.adapter.place(request,100,60000));
  assert.equal(await new GatePrivate(s.client).place(request,100,60000),undefined);assert.equal(posts,1);
  await assert.rejects(s.adapter.place({...request,quantity:.2},200,60000),/reused/);
  const concurrent=setup();await concurrent.adapter.prepare(market.symbol,2);
  await Promise.all([concurrent.adapter.place(request,100,60000),new GatePrivate(concurrent.client).place(request,100,60000)]);
  assert.equal(concurrent.calls.filter(c=>c.method==='place').length,1);
});

test('Gate order reconciliation rejects wrong identities, changed PID and decreasing fills without canceling unrelated orders',async()=>{
  for(const changes of [{text:'other'},{contract:'ETH_USDT'},{size:'-100'},{size:'200'},{is_reduce_only:true},{tif:'gtc'},
    {pos_margin_mode:'unknown'},{left:'120'},{is_close:true},{auto_size:'close_long'}]){
    const s=setup({privateFuturesGetSettleOrdersOrderId:async()=>rawOrder(request,{status:'open',...changes})});
    assert.equal((await s.adapter.reconcile(request)).status,'unknown');assert.ok(!s.calls.some(c=>c.method==='cancel'));
  }
  const req={...request,reduceOnly:true,side:'sell' as const},s=setup({privateFuturesGetSettlePositions:async()=>[position()]});
  await s.adapter.place(req,100,60000);
  s.client.privateFuturesGetSettleOrdersOrderId=async()=>rawOrder(req,{pid:'999',status:'open'});
  assert.equal((await s.adapter.reconcile(req)).status,'unknown');assert.ok(!s.calls.some(c=>c.method==='cancel'));
  const prior={...unknownOrder(request),filledQuantity:.08,averagePrice:59999,feeUsd:2};
  assert.equal((await setup().adapter.reconcile(request,prior)).filledQuantity,.08);
});

test('Gate anomalous open IOC is canceled then queried; later failures preserve the observed partial exposure',async()=>{
  let count=0;const s=setup({privateFuturesGetSettleOrdersOrderId:async()=>rawOrder(request,++count===1?{status:'open',finish_time:0}:{left:'30'})});
  s.client.privateFuturesGetSettleMyTrades=async()=>[trade({size:'70',fee:'2.1'})];
  const result=await s.adapter.reconcile(request);assert.equal(result.status,'partial');assert.equal(result.filledQuantity,.07);
  assert.deepEqual(s.calls.find(c=>c.method==='cancel')?.params,{settle:'usdt',order_id:'10001'});
  const failed=setup({privateFuturesGetSettleOrdersOrderId:async()=>rawOrder(request,{status:'open'}),
    privateFuturesDeleteSettleOrdersOrderId:async()=>{throw new Error('timeout');}});
  const unknown=await failed.adapter.reconcile(request);assert.equal(unknown.status,'unknown');assert.equal(unknown.filledQuantity,.06);
});

test('Gate missing custom-ID queries use bounded exact-text history; unknown is not inferred as canceled',async()=>{
  const s=setup({privateFuturesGetSettleOrdersOrderId:async()=>{throw new Error('not found');},
    privateFuturesGetSettleOrders:async(p:any)=>p.status==='finished'?[rawOrder()]:[]});
  assert.equal((await s.adapter.reconcile(request)).status,'partial');
  s.client.privateFuturesGetSettleOrders=async()=>[];
  assert.equal((await s.adapter.reconcile(request)).status,'unknown');assert.ok(!s.calls.some(c=>c.method==='place'));
});

test('Gate fees require exact deduplicated fill coverage and reject unknown currency/points while preserving quantities',async()=>{
  for(const trades of [[],[trade({fee:undefined})],[trade({point_fee:'1'})],[trade({fee_currency:'GT'})],
    [trade({size:'50'})],[trade(),trade({fee:'2'})]]){
    const s=setup({privateFuturesGetSettleMyTrades:async()=>trades}),result=await s.adapter.reconcile(request);
    assert.equal(result.status,'unknown');assert.equal(result.filledQuantity,.06);
  }
  const s=setup({privateFuturesGetSettleMyTrades:async()=>[trade(),trade(),trade({order_id:'unrelated',fee:'999'})]});
  assert.equal((await s.adapter.reconcile(request)).feeUsd,1.8);
  s.client.privateFuturesGetSettleMyTrades=async()=>[trade({fee:'-.1'})];assert.equal((await s.adapter.reconcile(request)).feeUsd,-.1);
  const canceled=setup({privateFuturesGetSettleOrdersOrderId:async()=>rawOrder(request,{left:'100',fill_price:'0'})});
  assert.equal((await canceled.adapter.reconcile(request)).status,'cancelled');assert.ok(!canceled.calls.some(c=>c.method==='trades'));
});

test('Gate fully covered BTR trades replace rounded order averages for both open and close',async()=>{
  const btrMarket={...market,id:'BTR_USDT',symbol:'BTR/USDT:USDT',base:'BTR',contractSize:10};
  for(const [side,reduceOnly,prices,sizes,rounded] of [
    ['buy',false,[.05028,.05029],[106,93],'.0503'],
    ['sell',true,[.0498,.04981,.04982],[13,94,92],'.0498'],
  ] as const){
    const req:OrderRequest={...request,symbol:btrMarket.symbol,base:'BTR',side,reduceOnly,quantity:1990,limitPrice:side==='buy'?.0503:.0498};
    const sign=side==='buy'?1:-1;
    const s=setup({privateFuturesGetSettleOrdersOrderId:async()=>rawOrder(req,{contract:btrMarket.id,size:String(sign*199),left:'0',price:String(req.limitPrice),fill_price:rounded}),
      privateFuturesGetSettleMyTrades:async()=>prices.map((price,i)=>trade({id:String(i+1),contract:btrMarket.id,size:String(sign*sizes[i]),price:String(price),fee:String(sizes[i]*10*price*.0005)}))});
    s.client.market=()=>btrMarket;
    const result=await s.adapter.inspectOrder(req,undefined,'10001');
    const actual=prices.reduce((value,price,i)=>value+price*sizes[i],0)/199;
    assert.equal(result.status,'filled');assert.ok(Math.abs(result.averagePrice-actual)<1e-12);
    assert.notEqual(result.averagePrice,Number(rounded));
    assert.ok(Math.abs(result.feeUsd-1990*actual*.0005)<1e-12);
    assert.ok(!s.calls.some(c=>['place','cancel','set-leverage'].includes(c.method)));
  }
});

test('Gate exact fill averaging rejects missing prices, conflicting duplicates and out-of-limit trades',async()=>{
  for(const trades of [[trade({price:undefined})],[trade(),trade({price:'59998'})],[trade({price:'60001'})]]){
    const s=setup({privateFuturesGetSettleMyTrades:async()=>trades});
    const result=await s.adapter.inspectOrder(request,undefined,'10001');
    assert.equal(result.status,'unknown');assert.equal(result.filledQuantity,.06);assert.equal(result.averagePrice,59999);
    assert.ok(!s.calls.some(c=>['place','cancel','set-leverage'].includes(c.method)));
  }
});

test('Gate fees paginate bounded native fill records until cumulative confirmed quantity is covered',async()=>{
  const req={...request,quantity:.2},offsets:number[]=[];
  const s=setup({privateFuturesGetSettleOrdersOrderId:async()=>rawOrder(req,{size:'200',left:'0'}),
    privateFuturesGetSettleMyTrades:async(p:any)=>{offsets.push(p.offset);return Array.from({length:100},(_,i)=>trade({id:String(p.offset+i+1),size:'1',fee:'.01'}));}});
  const result=await s.adapter.reconcile(req);assert.equal(result.status,'filled');assert.deepEqual(offsets,[0,100]);
  assert.ok(Math.abs(result.feeUsd-2)<1e-10);
});

test('installed CCXT exposes every native Gate split endpoint without making requests',()=>{
  const client=new ccxt.gate();
  for(const method of ['privateFuturesGetSettleAccounts','privateFuturesGetSettlePositions','privateFuturesGetSettleGetLeverageContract',
    'privateUnifiedGetAccounts',
    'privateFuturesPostSettlePositionsContractSetLeverage','privateFuturesPostSettlePositionsCrossMode','privateFuturesPostSettleDualCompPositionsCrossMode',
    'privateFuturesGetSettleOrders','privateFuturesGetSettlePriceOrders','privateFuturesPostSettleOrders',
    'privateFuturesGetSettleOrdersOrderId','privateFuturesDeleteSettleOrdersOrderId','privateFuturesGetSettleMyTrades'])assert.equal(typeof(client as any)[method],'function',method);
});
