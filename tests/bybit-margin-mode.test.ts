import test from 'node:test';
import assert from 'node:assert/strict';
import {BybitPrivate,bybitReadError} from '../src/adapters/bybit-private.js';
import type {OrderRequest} from '../src/shared/types.js';

const market={id:'BTCUSDT',symbol:'BTC/USDT:USDT',base:'BTC',quote:'USDT',settle:'USDT',swap:true,linear:true,active:true,contractSize:1};
const opening:OrderRequest={clientOrderId:'offline-bybit-margin',symbol:market.symbol,base:'BTC',side:'buy',quantity:.01,limitPrice:10000,reduceOnly:false};
function fixture(accountMargin:'REGULAR_MARGIN'|'ISOLATED_MARGIN',desired?:'crossed'|'isolated',hedged=false){
  const calls:{method:string;params:any}[]=[],holdings=new Map<number,{side:string;size:number}>();
  let leverage='10',pending=false,margin=accountMargin;
  const ok=(result:any)=>({retCode:0,result});
  const method=(name:string,fn:(p:any)=>any)=>async(p:any)=>{calls.push({method:name,params:p});return ok(fn(p));};
  const client:any={markets:{[market.symbol]:market},market:()=>market,
    amountToPrecision:(_symbol:string,value:number)=>String(value),priceToPrecision:(_symbol:string,value:number)=>String(value),
    privateGetV5AccountInfo:method('info',()=>({unifiedMarginStatus:5,marginMode:margin})),
    privateGetV5AccountWalletBalance:method('wallet',()=>({list:[{accountType:'UNIFIED',totalEquity:'500',totalAvailableBalance:'500',coin:[{
      coin:'USDT',walletBalance:'500',equity:'500',usdValue:'500',locked:'0',bonus:'0',totalPositionIM:'0',totalOrderIM:'0',borrowAmount:'0',spotBorrow:'0',accruedInterest:'0'}]}]})),
    privateGetV5PositionList:method('positions',()=>({list:(hedged?[1,2]:[0]).map(positionIdx=>{
      const held=holdings.get(positionIdx);return {symbol:market.id,positionIdx,leverage,size:String(held?.size??0),side:held?.side??''};
    })})),
    privateGetV5OrderRealtime:method('pending',()=>({list:pending?[{orderId:'pending'}]:[]})),
    privatePostV5PositionSetLeverage:method('leverage',p=>{leverage=p.buyLeverage;return {};}),
    privatePostV5AccountSetMarginMode:method('account-mode',()=>{throw new Error('The fixture forbids account margin changes');}),
    privatePostV5OrderCreate:method('place',()=>({orderId:'10001'})),
  };
  return {client,calls,holdings,adapter:new BybitPrivate(client,desired),pending:()=>{pending=true;},setMargin:(value:typeof accountMargin)=>{margin=value;}};
}

for(const desired of ['crossed','isolated'] as const)for(const hedged of [false,true]){
  test(`Bybit ${desired} ${hedged?'hedge':'one-way'} matching account prepares only symbol leverage`,async()=>{
    const f=fixture(desired==='crossed'?'REGULAR_MARGIN':'ISOLATED_MARGIN',desired,hedged);
    await f.adapter.inspectTrading(market.symbol,2);assert.ok(f.calls.every(c=>!['leverage','account-mode','place'].includes(c.method)));
    await f.adapter.prepare(market.symbol,2);await f.adapter.prepare(market.symbol,2);
    assert.deepEqual(f.calls.filter(c=>c.method==='leverage').map(c=>c.params),[{category:'linear',symbol:market.id,buyLeverage:'2',sellLeverage:'2'}]);
    await f.adapter.place(opening,.01,10000);
    const order=f.calls.find(c=>c.method==='place')?.params;assert.equal(order.positionIdx,hedged?1:0);
    assert.equal(order.marginMode,undefined);assert.equal(order.tradeMode,undefined);assert.equal(order.reduceOnly,false);
    assert.equal(f.calls.some(c=>c.method==='account-mode'),false);
  });
}

test('Bybit requested margin mismatch prevents leverage and order writes with an account adjustment message',async()=>{
  for(const desired of ['crossed','isolated'] as const){
    const f=fixture(desired==='crossed'?'ISOLATED_MARGIN':'REGULAR_MARGIN',desired);
    const error=new RegExp(`configure ${desired} account margin before live entry`);
    await assert.rejects(f.adapter.inspectTrading(market.symbol,2),error);await assert.rejects(f.adapter.prepare(market.symbol,2),error);
    await assert.rejects(f.adapter.place(opening,.01,10000),error);
    assert.ok(f.calls.every(c=>!['leverage','account-mode','place'].includes(c.method)));
    assert.match(bybitReadError(new Error(`bybit: configure ${desired} account margin before live entry`))!,/Bybit 账户设置/);
  }
});

test('Bybit held contracts and pending orders block all preparation writes in either selected margin mode',async()=>{
  for(const desired of ['crossed','isolated'] as const)for(const blocker of ['held','pending']){
    const f=fixture(desired==='crossed'?'REGULAR_MARGIN':'ISOLATED_MARGIN',desired);
    if(blocker==='held')f.holdings.set(0,{side:'Buy',size:.01});else f.pending();
    await assert.rejects(f.adapter.prepare(market.symbol,2),/existing position or pending order/);
    assert.ok(f.calls.every(c=>!['leverage','account-mode','place'].includes(c.method)));
  }
});

test('Bybit reduce-only keeps native side and positionIdx even when entry preference differs from the account',async()=>{
  for(const desired of ['crossed','isolated'] as const)for(const hedged of [false,true]){
    const f=fixture(desired==='crossed'?'ISOLATED_MARGIN':'REGULAR_MARGIN',desired,hedged),positionIdx=hedged?1:0;
    f.holdings.set(positionIdx,{side:'Buy',size:.01});
    const close:OrderRequest={...opening,clientOrderId:`offline-bybit-close-${desired}-${hedged}`,side:'sell',reduceOnly:true};
    await f.adapter.validateReduction(close,.01);await f.adapter.place(close,.01,10000);
    const order=f.calls.find(c=>c.method==='place')?.params;
    assert.equal(order.positionIdx,positionIdx);assert.equal(order.side,'Sell');assert.equal(order.reduceOnly,true);
    assert.ok(f.calls.every(c=>!['leverage','account-mode'].includes(c.method)));
  }
});

test('Bybit omitted preference retains existing native margin mode behavior',async()=>{
  for(const margin of ['REGULAR_MARGIN','ISOLATED_MARGIN'] as const){
    const f=fixture(margin);await f.adapter.prepare(market.symbol,2);
    assert.equal(f.calls.filter(c=>c.method==='leverage').length,1);assert.equal(f.calls.some(c=>c.method==='account-mode'),false);
  }
});
