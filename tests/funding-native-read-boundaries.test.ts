import test from 'node:test';
import assert from 'node:assert/strict';
import {readFundingLedger} from '../src/adapters/funding-ledger.js';
import {BitgetUta} from '../src/adapters/bitget-uta.js';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {ExchangeNetworkError,withExchangeRequestContext} from '../src/adapters/network.js';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeId} from '../src/shared/types.js';

const now=1791648000000,day=86400000;
const market={id:'BTCUSDT',symbol:'BTC/USDT:USDT',base:'BTC',quote:'USDT',settle:'USDT',swap:true,linear:true,contractSize:1};
const paths=[...(['binance','bybit','okx','gate','bitget'] as ExchangeId[]),'bitget-uta'] as const;
type Path=typeof paths[number];
const invoice=(path:Path,index=0,timestamp=now-500)=>({
  binance:{symbol:market.id,asset:'USDT',tranId:String(index+1),time:timestamp,income:'.1'},
  bybit:{symbol:market.id,execId:String(index+1),execTime:String(timestamp),execFee:'-.1',execQty:'1',side:'Buy'},
  okx:{instId:market.id,ccy:'USDT',billId:String(index+1),ts:String(timestamp),balChg:'.1',posBalChg:'0'},
  gate:{contract:market.id,id:String(index+1),time:timestamp/1000,change:'.1'},
  bitget:{symbol:market.id,coin:'USDT',billId:String(index+1),businessType:'contract_settle_fee',cTime:String(timestamp),amount:'.1',fee:'0',feeByCoupon:'0'},
  'bitget-uta':{id:String(index+1),ts:String(timestamp),symbol:market.id,type:'CONTRACT_MAIN_SETTLE_FEE_USER_IN',
    coin:'USDT',category:'USDT-FUTURES',amount:'.1',fee:'0'},
}[path]);
function nativeResponse(path:Path,rows:unknown[],next=false):unknown {
  if(path==='bybit')return {result:{list:rows,nextPageCursor:next?'next':''}};
  if(path==='okx')return {data:rows};
  if(path==='bitget')return {code:'00000',data:{bills:rows,...(next?{endId:'100'}:{})}};
  if(path==='bitget-uta')return {code:'00000',data:{list:rows,cursor:next?'next':''}};
  return rows;
}
function fixture(path:Path,handler:(call:number,params:unknown)=>Promise<unknown>){
  const method={binance:'fapiPrivateGetIncome',bybit:'privateGetV5ExecutionList',okx:'privateGetAccountBillsArchive',
    gate:'privateFuturesGetSettleAccountBook',bitget:'privateMixGetV2MixAccountBill','bitget-uta':'privateUtaGetV3AccountFinancialRecords'}[path];
  let calls=0;
  // Native read stubs deliberately have no transport wrapper: the ledger itself
  // must stop at each native call boundary and reject late successful empty reads.
  const client:any={markets:{[market.symbol]:market},[method]:async(params:unknown)=>handler(++calls,params)};
  return {client,calls:()=>calls,read:(since=now-1000,until=now)=>path==='bitget-uta'
    ?new BitgetUta(client).fetchFundingPayments(since,until)
    :readFundingLedger(client,path,since,until)};
}
const timeout=(error:unknown)=>error instanceof ExchangeNetworkError&&error.code==='TIMEOUT';

for(const path of paths){
  test(`${path} funding ledger rejects an expired inherited deadline before any native read`,async t=>{
    t.mock.method(Date,'now',()=>now);
    const f=fixture(path,async()=>nativeResponse(path,[]));
    await assert.rejects(withExchangeRequestContext(f.client,{deadlineAt:now-1},()=>f.read()),timeout);
    assert.equal(f.calls(),0);
  });
  test(`${path} funding ledger rejects a late final empty response instead of establishing zero cash coverage`,async t=>{
    let at=now;t.mock.method(Date,'now',()=>at);
    const f=fixture(path,async()=>{at=now+101;return nativeResponse(path,[]);});
    await assert.rejects(withExchangeRequestContext(f.client,{deadlineAt:now+100},()=>f.read()),timeout);
    assert.equal(f.calls(),1);
  });
  test(`${path} funding ledger cannot start another native page after a late complete response`,async t=>{
    let at=now;t.mock.method(Date,'now',()=>at);
    const f=fixture(path,async call=>{
      if(call===1){at=now+101;return nativeResponse(path,Array.from({length:100},(_,i)=>invoice(path,i)),true);}
      return nativeResponse(path,[]);
    });
    await assert.rejects(withExchangeRequestContext(f.client,{deadlineAt:now+100},()=>f.read()),timeout);
    assert.equal(f.calls(),1,'late native read must not schedule the next cursor or page');
  });
  test(`${path} funding ledger respects inherited abort even when the native response succeeds`,async t=>{
    t.mock.method(Date,'now',()=>now);const controller=new AbortController();
    const f=fixture(path,async()=>{controller.abort();return nativeResponse(path,[invoice(path)]);});
    await assert.rejects(withExchangeRequestContext(f.client,{deadlineAt:now+100,signal:controller.signal},()=>f.read()),timeout);
    assert.equal(f.calls(),1);
  });
}

for(const path of ['bybit','bitget','bitget-uta'] as const){
  test(`${path} funding ledger cannot begin the next time slice after a late short page`,async t=>{
    let at=now;t.mock.method(Date,'now',()=>at);
    const f=fixture(path,async()=>{at=now+101;return nativeResponse(path,[]);});
    await assert.rejects(withExchangeRequestContext(f.client,{deadlineAt:now+100},()=>f.read(now-31*day)),timeout);
    assert.equal(f.calls(),1);
  });
}

test('funding ledgers retain a native failure as a failed read rather than empty successful coverage',async t=>{
  t.mock.method(Date,'now',()=>now);const failure=new ExchangeNetworkError('ACCESS_DENIED',0,undefined,'bitget');
  for(const path of paths){
    const f=fixture(path,async()=>{throw failure;});
    await assert.rejects(withExchangeRequestContext(f.client,{deadlineAt:now+100},()=>f.read()),error=>error===failure);
    assert.equal(f.calls(),1);
  }
});

for(const id of ['bybit','bitget'] as const){
  test(`${id} funding adapter rejects expiry before initiating metadata or account routing`,async t=>{
    t.mock.method(Date,'now',()=>now);let metadata=0,routing=0;
    const f=fixture(id,async()=>nativeResponse(id,[]));
    f.client.loadMarkets=async()=>{metadata++;return f.client.markets;};
    f.client.privateUtaGetV3AccountSettings=async()=>{routing++;return {code:'00000',data:{accountMode:'hybrid'}};};
    Object.assign(f.client,{apiKey:'offline-key',secret:'offline-secret',password:'offline-passphrase'});
    const adapter=new CcxtAdapter(id,{...structuredClone(defaultConfig),mode:'live',dataSource:'public'},f.client);
    await assert.rejects(adapter.fetchFundingPayments(now-1000,{deadlineAt:now-1}),timeout);
    assert.equal(metadata,0);assert.equal(routing,0);assert.equal(f.calls(),0);
  });
  test(`${id} funding adapter cannot initiate account routing or ledger after metadata finishes too late`,async t=>{
    let at=now;t.mock.method(Date,'now',()=>at);let metadata=0,routing=0;
    const f=fixture(id,async()=>nativeResponse(id,[]));
    f.client.loadMarkets=async()=>{metadata++;at=now+101;return f.client.markets;};
    f.client.privateUtaGetV3AccountSettings=async()=>{routing++;return {code:'00000',data:{accountMode:'hybrid'}};};
    Object.assign(f.client,{apiKey:'offline-key',secret:'offline-secret',password:'offline-passphrase'});
    const adapter=new CcxtAdapter(id,{...structuredClone(defaultConfig),mode:'live',dataSource:'public'},f.client);
    await assert.rejects(adapter.fetchFundingPayments(now-1000,{deadlineAt:now+100}),timeout);
    assert.equal(metadata,1);assert.equal(routing,0);assert.equal(f.calls(),0);
  });
}
