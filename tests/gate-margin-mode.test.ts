import test from 'node:test';
import assert from 'node:assert/strict';
import {GatePrivate,gateReadError} from '../src/adapters/gate-private.js';
import type {OrderRequest} from '../src/shared/types.js';

type Mode='single'|'dual'|'dual_plus';
type Margin='cross'|'isolated';
const market={id:'BTC_USDT',symbol:'BTC/USDT:USDT',base:'BTC',quote:'USDT',settle:'USDT',swap:true,linear:true,active:true,contractSize:.001};
const opening:OrderRequest={clientOrderId:'offline-gate-margin',symbol:market.symbol,base:'BTC',side:'buy',quantity:.1,limitPrice:60000,reduceOnly:false};
function fixture(mode:Mode,desired?:'crossed'|'isolated',initialMargin:Margin='cross'){
  const calls:{method:string;params:any}[]=[],holdings:any[]=[];
  const leverage={cross:{dual_long:'10',dual_short:'10'},isolated:{dual_long:'7',dual_short:'8'}};
  let currentMargin=initialMargin,pending=false,conditional=false,persistSwitch=true,persistLeverage=true;
  const read=(name:string,fn:(params:any)=>any)=>async(params:any)=>{calls.push({method:name,params});return fn(params);};
  const position=(side:string,size='0',margin:Margin=currentMargin)=>({contract:market.id,mode:side,size,pos_margin_mode:margin,
    lever:leverage[margin][side==='dual_short'?'dual_short':'dual_long'],mark_price:'60000',liq_price:'30000'});
  const client:any={markets:{[market.symbol]:market},market:()=>market,
    amountToPrecision:(_symbol:string,value:number)=>String(value),priceToPrecision:(_symbol:string,value:number)=>String(value),
    privateFuturesGetSettleAccounts:read('account',()=>({currency:'USDT',available:'500',total:'500',unrealised_pnl:'0',position_mode:mode,margin_mode:0})),
    privateFuturesGetSettlePositions:read('positions',()=>holdings),
    privateFuturesGetSettleOrders:read('orders',()=>pending?[{id:'pending'}]:[]),
    privateFuturesGetSettlePriceOrders:read('conditional',()=>conditional?[{id:'pending'}]:[]),
    privateFuturesGetSettlePositionsContract:read('settings',()=>position('single')),
    privateFuturesGetSettleDualCompPositionsContract:read('settings',()=>['dual_long','dual_short'].map(side=>position(side))),
    privateFuturesGetSettleGetLeverageContract:read('settings',p=>({Lever:leverage[p.pos_margin_mode as Margin][p.dual_side as 'dual_long'|'dual_short']})),
    request:async(path:string,api:string[],method:string,params:any,_headers:any,body:string)=>{
      const parsed=JSON.parse(body);calls.push({method:'switch',params:{path,api,method,...params,body:parsed}});
      if(persistSwitch)currentMargin=parsed.mode==='CROSS'?'cross':'isolated';return {};
    },
    privateFuturesPostSettlePositionsContractSetLeverage:read('leverage',p=>{
      if(persistLeverage){
        const values=leverage[p.margin_mode as Margin];
        if(p.dual_side)values[p.dual_side as 'dual_long'|'dual_short']=p.leverage;
        else values.dual_long=values.dual_short=p.leverage;
      }
      return {};
    }),
    privateFuturesPostSettleOrders:read('place',()=>({id:'10001'})),
  };
  return {client,calls,holdings,leverage,position,adapter:new GatePrivate(client,undefined,desired),
    pending:()=>{pending=true;},conditional:()=>{conditional=true;},staleSwitch:()=>{persistSwitch=false;},staleLeverage:()=>{persistLeverage=false;}};
}

for(const mode of ['single','dual','dual_plus'] as const)for(const desired of ['crossed','isolated'] as const){
  test(`Gate ${mode} prepares ${desired} with the matching native leverage scope and order slot`,async()=>{
    const native:Margin=desired==='crossed'?'cross':'isolated',f=fixture(mode,desired,native==='cross'?'isolated':'cross');
    const untouched=structuredClone(f.leverage[native==='cross'?'isolated':'cross']);
    await f.adapter.inspectTrading(market.symbol,2);assert.ok(f.calls.every(c=>!['switch','leverage','place'].includes(c.method)));
    if(mode==='dual_plus')assert.ok(f.calls.filter(c=>c.method==='settings').every(c=>c.params.pos_margin_mode===native));
    await f.adapter.prepare(market.symbol,2);
    const switches=f.calls.filter(c=>c.method==='switch');assert.equal(switches.length,mode==='dual_plus'?0:1);
    if(switches.length)assert.deepEqual(switches[0].params,{path:mode==='single'?'{settle}/positions/cross_mode':'{settle}/dual_comp/positions/cross_mode',
      api:['private','futures'],method:'POST',settle:'usdt',body:{contract:market.id,mode:native==='cross'?'CROSS':'ISOLATED'}});
    const expected={settle:'usdt',contract:market.id,margin_mode:native,leverage:'2'};
    assert.deepEqual(f.calls.filter(c=>c.method==='leverage').map(c=>c.params),native==='isolated'&&mode!=='single'
      ?['dual_long','dual_short'].map(dual_side=>({...expected,dual_side})):[expected]);
    assert.deepEqual(f.leverage[native==='cross'?'isolated':'cross'],untouched);
    const writes=f.calls.filter(c=>['switch','leverage'].includes(c.method)).length;
    await f.adapter.prepare(market.symbol,2);assert.equal(f.calls.filter(c=>['switch','leverage'].includes(c.method)).length,writes);
    // Helpers share native preparation evidence; a fresh helper must not replace its margin slot with a default.
    await new GatePrivate(f.client).place(opening,100,60000);
    assert.equal(f.calls.find(c=>c.method==='place')?.params.pos_margin_mode,mode==='dual_plus'?native:undefined);
  });
}

test('Gate omitted preference keeps its existing cross entry behavior',async()=>{
  const f=fixture('dual_plus');await f.adapter.prepare(market.symbol,2);
  assert.deepEqual(f.calls.filter(c=>c.method==='leverage').map(c=>c.params),[{settle:'usdt',contract:market.id,margin_mode:'cross',leverage:'2'}]);
});

test('Gate held contracts, regular and conditional orders block both margin and leverage writes',async()=>{
  for(const mode of ['single','dual','dual_plus'] as const)for(const desired of ['crossed','isolated'] as const)for(const blocker of ['held','pending','conditional']){
    const f=fixture(mode,desired,desired==='crossed'?'isolated':'cross');
    if(blocker==='held')f.holdings.push(f.position(mode==='single'?'single':'dual_long','100'));
    else if(blocker==='pending')f.pending();else f.conditional();
    await assert.rejects(f.adapter.inspectTrading(market.symbol,2),/existing position or pending order/);
    await assert.rejects(f.adapter.prepare(market.symbol,2),/existing position or pending order/);
    assert.ok(f.calls.every(c=>!['switch','leverage','place'].includes(c.method)));
  }
});

test('Gate isolated mode and directional leverage readbacks must persist before entry',async()=>{
  const mode=fixture('dual','isolated');mode.staleSwitch();
  await assert.rejects(mode.adapter.prepare(market.symbol,2),/requested isolated margin could not be verified/);
  assert.ok(mode.calls.every(c=>!['leverage','place'].includes(c.method)));
  assert.match(gateReadError(new Error('gate: requested isolated margin could not be verified'))!,/逐仓/);
  const leverage=fixture('dual_plus','isolated');leverage.staleLeverage();
  await assert.rejects(leverage.adapter.prepare(market.symbol,2),/could not be verified/);
  await assert.rejects(leverage.adapter.place(opening,100,60000),/requires verified preparation/);
  assert.ok(leverage.calls.every(c=>c.method!=='place'));
});

test('Gate opposite entry preferences preserve native reduction margin and PID without setting writes',async()=>{
  for(const desired of ['crossed','isolated'] as const){
    const native:Margin=desired==='crossed'?'isolated':'cross',f=fixture('dual_plus',desired);
    f.holdings.push({...f.position('dual_long','100',native),pid:'922337203685477581'});
    const close:OrderRequest={...opening,clientOrderId:`offline-gate-close-${desired}`,side:'sell',reduceOnly:true,
      closePosition:{side:'long',marginMode:native==='cross'?'crossed':'isolated',positionId:'922337203685477581'}};
    await f.adapter.validateReduction(close,100);await f.adapter.place(close,100,60000);
    const order=f.calls.find(c=>c.method==='place')?.params;
    assert.equal(order.pos_margin_mode,native);assert.equal(order.pid,'922337203685477581');assert.equal(order.reduce_only,true);
    assert.ok(f.calls.every(c=>!['settings','switch','leverage'].includes(c.method)));
  }
});
