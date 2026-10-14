import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import ccxt from 'ccxt';
import {NativeTradingFees,NATIVE_FEE_MAX_AGE_MS,NATIVE_FEE_RETRY_MS,readNativeTradingFee,readNativeTradingFeeRates} from '../src/adapters/native-trading-fees.js';
import {CcxtAdapter,bybitFeeProfile} from '../src/adapters/ccxt.js';
import {accountFeeIdentity,LocalAccountFeeCache,LOCAL_ACCOUNT_FEE_MAX_ENTRIES} from '../src/adapters/local-account-fee-cache.js';
import {nativeTakerFeeRate,nativeMakerFeeRate} from '../src/shared/trading-fees.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountPosition,ExchangeId} from '../src/shared/types.js';

const KEY='offline-fee-key',SECRET='offline-fee-secret',PASSWORD='offline-fee-passphrase';
function cleanReferenceFolder(folder:string):void {
  const fullPath=resolve(folder),temporaryRoot=resolve(tmpdir());
  assert.ok(fullPath.startsWith(`${temporaryRoot}${sep}`)&&basename(fullPath).startsWith('fee-reference-'));
  rmSync(fullPath,{recursive:true,force:true});
}
const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,autoEnabled:false};
function market(id:ExchangeId,base='DGAI'):any{return {id:id==='gate'?`${base}_USDT`:id==='okx'?`${base}-USDT-SWAP`:`${base}USDT`,
  symbol:`${base}/USDT:USDT`,base,quote:'USDT',settle:'USDT',baseId:base,quoteId:'USDT',settleId:'USDT',type:'swap',spot:false,swap:true,
  margin:false,future:false,option:false,contract:true,active:true,linear:true,inverse:false,contractSize:1,precision:{amount:1,price:.0001},
  limits:{amount:{min:1},cost:{min:1}},info:id==='okx'?{instFamily:`${base}-USDT`,groupId:'4'}:{}};}
interface Wire {method:string;path:string;params:Record<string,string>}
function signedFixture(id:ExchangeId,mode='unified'){
  const Constructor=(ccxt as any)[id==='binance'?'binanceusdm':id],client:any=new Constructor({apiKey:KEY,secret:SECRET,password:PASSWORD,
    enableRateLimit:false,options:{adjustForTimeDifference:false,maxRetriesOnFailure:0}}),calls:Wire[]=[];
  client.setMarkets([market(id),market(id,'SOON')]);
  client.fetchImplementation=async(urlText:string,init:any)=>{
    const url=new URL(urlText),headers=new Headers(init.headers),method=String(init.method),query=url.search.slice(1);
    assert.equal(method,'GET','fees must never make any financial writes');assert.equal(init.body,undefined);
    const params=Object.fromEntries(url.searchParams);calls.push({method,path:url.pathname,params});
    let response:any;
    if(id==='bybit'){
      assert.equal(headers.get('X-BAPI-API-KEY'),KEY);
      const input=headers.get('X-BAPI-TIMESTAMP')!+KEY+headers.get('X-BAPI-RECV-WINDOW')!+decodeURIComponent(query);
      assert.equal(headers.get('X-BAPI-SIGN'),createHmac('sha256',SECRET).update(input).digest('hex'));
      assert.equal(url.pathname,'/v5/account/fee-rate');assert.equal(params.category,'linear');
      response={retCode:0,retMsg:'OK',result:{list:[{symbol:params.symbol,takerFeeRate:params.symbol==='SOONUSDT'?'.00055':'.0011',makerFeeRate:'.00018'}]}};
    }else if(id==='gate'){
      assert.equal(headers.get('KEY'),KEY);
      const input=[method,url.pathname,query,createHash('sha512').update('').digest('hex'),headers.get('Timestamp')!].join('\n');
      assert.equal(headers.get('SIGN'),createHmac('sha512',SECRET).update(input).digest('hex'));
      assert.equal(url.pathname,'/api/v4/futures/usdt/fee');assert.ok(params.contract?.endsWith('_USDT'));
      response={[params.contract]:{taker_fee:'.0005',maker_fee:'-.0001'}};
    }else if(id==='binance'){
      assert.equal(headers.get('X-MBX-APIKEY'),KEY);
      const unsigned=query.slice(0,query.lastIndexOf('&signature='));
      assert.equal(params.signature,createHmac('sha256',SECRET).update(unsigned).digest('hex'));
      assert.equal(url.pathname,'/fapi/v1/commissionRate');response={symbol:params.symbol,takerCommissionRate:'.0005',makerCommissionRate:'.0002'};
    }else if(id==='bitget'){
      assert.equal(headers.get('ACCESS-KEY'),KEY);assert.equal(headers.get('ACCESS-PASSPHRASE'),PASSWORD);
      const input=headers.get('ACCESS-TIMESTAMP')!+method+url.pathname+url.search;
      assert.equal(headers.get('ACCESS-SIGN'),createHmac('sha256',SECRET).update(input).digest('base64'));
      if(url.pathname==='/api/v3/account/settings')response={code:'00000',data:{accountMode:mode}};
      else{
        if(mode==='unified'){assert.equal(url.pathname,'/api/v3/account/all-fee-rate');assert.equal(params.category,'USDT-FUTURES');}
        else {assert.equal(url.pathname,'/api/v2/common/trade-rate');assert.equal(params.businessType,'mix');}
        assert.equal(params.symbol,'DGAIUSDT');response={code:'00000',data:mode==='unified'?[{symbol:params.symbol,takerFeeRate:'.0006',makerFeeRate:'.0002'}]:{takerFeeRate:'.0006',makerFeeRate:'.0002'}};
      }
    }else{
      assert.equal(headers.get('OK-ACCESS-KEY'),KEY);assert.equal(headers.get('OK-ACCESS-PASSPHRASE'),PASSWORD);
      const input=headers.get('OK-ACCESS-TIMESTAMP')!+method+url.pathname+url.search;
      assert.equal(headers.get('OK-ACCESS-SIGN'),createHmac('sha256',SECRET).update(input).digest('base64'));
      assert.equal(url.pathname,'/api/v5/account/trade-fee');assert.equal(params.instType,'SWAP');assert.equal(params.instFamily,'DGAI-USDT');
      response={code:'0',data:[{instType:'SWAP',feeGroup:[{groupId:'4',taker:'-.0005',maker:'.0001'}]}]};
    }
    return new Response(JSON.stringify(response),{headers:{'Content-Type':'application/json'}});
  };
  return {client,calls};
}

test('all five native symbol fee GETs use real CCXT signatures and exact contract parameters',async()=>{
  for(const [id,rate] of [['bybit',.0011],['gate',.0005],['binance',.0005],['bitget',.0006],['okx',.0005]] as const){
    const {client,calls}=signedFixture(id),adapter=new CcxtAdapter(id,config,client);
    try{const value=await adapter.fetchTradingFee('DGAI/USDT:USDT');assert.equal(value?.takerFeeRate,rate);assert.equal(value?.takerFeeSource,'exchange');
      assert.equal(value?.makerFeeRate,id==='bybit'?.00018:id==='gate'||id==='okx'?-.0001:.0002);
      assert.equal(value?.makerFeeSource,'exchange');assert.equal(value?.makerFeeAt,value?.takerFeeAt);
      assert.ok(value!.takerFeeAt<=Date.now());assert.ok(calls.length);assert.ok(calls.every(c=>c.method==='GET'));
      assert.deepEqual(adapter.cachedTradingFee('DGAI/USDT:USDT'),value);assert.equal(adapter.cachedTradingFee('SOON/USDT:USDT'),undefined);
      await adapter.fetchTradingFee('DGAI/USDT:USDT');assert.equal(calls.length,id==='bitget'?2:1,'fresh symbol fee comes from cache');
    }finally{await adapter.close();}
  }
});
test('Bybit per-symbol special fees do not share a venue-wide configured rate',async()=>{
  const {client}=signedFixture('bybit'),adapter=new CcxtAdapter('bybit',config,client);
  try{assert.equal((await adapter.fetchTradingFee('DGAI/USDT:USDT'))?.takerFeeRate,.0011);
    assert.equal((await adapter.fetchTradingFee('SOON/USDT:USDT'))?.takerFeeRate,.00055);}
  finally{await adapter.close();}
});
test('verified Bitget classic mode uses only classic symbol fee GET',async()=>{
  const {client,calls}=signedFixture('bitget','hybrid');assert.equal(await readNativeTradingFee('bitget',client,market('bitget')),.0006);
  assert.deepEqual(calls.map(c=>c.path),['/api/v3/account/settings','/api/v2/common/trade-rate']);await client.close();
});

test('unknown/wrong symbol, invalid fee and native rejection never use generic or public defaults',async()=>{
  const m=market('bybit');let row:any={symbol:'SOONUSDT',takerFeeRate:'.0011'},code=0,category:any='linear';
  const client={privateGetV5AccountFeeRate:async()=>({retCode:code,result:{category,list:[row]}}),fetchTradingFee:()=>{throw new Error('forbidden generic fallback');}};
  assert.equal(await readNativeTradingFee('bybit',client,m),undefined);
  row.symbol='DGAIUSDT';for(const value of ['',null,false,NaN,Infinity,'-.0001','.011']){row.takerFeeRate=value;assert.equal(await readNativeTradingFee('bybit',client,m),undefined);}
  row.takerFeeRate='0';assert.equal(await readNativeTradingFee('bybit',client,m),0);code=10003;assert.equal(await readNativeTradingFee('bybit',client,m),undefined);
  code=0;category='inverse';assert.equal(await readNativeTradingFee('bybit',client,m),undefined);
  assert.equal(await readNativeTradingFee('gate',{privateFuturesGetSettleFee:async()=>({SOON_USDT:{taker_fee:'.0005'}})},market('gate')),undefined);
  assert.equal(await readNativeTradingFee('binance',{fapiPrivateGetCommissionRate:async()=>({symbol:'SOONUSDT',takerCommissionRate:'.0005'})},market('binance')),undefined);
});
test('Bitget unknown account mode never falls back to an empty classic fee',async()=>{
  let classicCalls=0;const client={privateUtaGetV3AccountSettings:async()=>({code:'00000',data:{accountMode:'transition'}}),
    privateCommonGetV2CommonTradeRate:async()=>{classicCalls++;return {code:'00000',data:{takerFeeRate:'.0006'}};}};
  assert.equal(await readNativeTradingFee('bitget',client,market('bitget')),undefined);assert.equal(classicCalls,0);
});
test('OKX native fee-group identity and commission sign are validated',async()=>{
  let row:any={instType:'SWAP',feeGroup:[{groupId:'5',taker:'-.0005'}]},client={privateGetAccountTradeFee:async()=>({code:'0',data:[row]})};
  assert.equal(await readNativeTradingFee('okx',client,market('okx')),undefined);
  row.feeGroup=[{groupId:'4',taker:'.0005'}];assert.equal(await readNativeTradingFee('okx',client,market('okx')),undefined,'rebate not invented as positive fee');
  row={instType:'SWAP',takerU:'-.0007',taker:'-.001'};assert.equal(await readNativeTradingFee('okx',client,market('okx')),.0007);
  row.instType='SPOT';assert.equal(await readNativeTradingFee('okx',client,market('okx')),undefined);
});

const position=(symbol='DGAI/USDT:USDT'):AccountPosition=>({base:symbol.split('/')[0],symbol,side:'long',quantity:110,markPrice:.9,liquidationPrice:0,leverage:2});
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('position enrichment reads only existing cache while explicit requests join one native GET',async()=>{
  let now=1_000_000,calls=0,resolve!:(value:any)=>void;
  const pending=new Promise(r=>resolve=r),client={privateGetV5AccountFeeRate:()=>{calls++;return pending;}};
  const fees=new NativeTradingFees('bybit',client,()=>market('bybit'),()=>now,20);
  assert.equal(fees.enrich([position(),{...position(),side:'short'}])[0].takerFeeRate,undefined);await tick();assert.equal(calls,0);
  const requested=fees.fetch(position().symbol),joined=fees.fetch(position().symbol);await tick();assert.equal(calls,1);
  resolve({retCode:0,result:{list:[{symbol:'DGAIUSDT',takerFeeRate:'.0011'}]}});assert.equal((await joined)?.takerFeeRate,.0011);
  assert.equal((await requested)?.takerFeeRate,.0011);
  assert.equal(fees.enrich([position()])[0].takerFeeRate,.0011);assert.equal(calls,1);
  now+=NATIVE_FEE_MAX_AGE_MS+1;assert.equal(fees.cached(position().symbol),undefined);fees.stop();
});
test('per-symbol refresh is bounded, quantity polling continues during hung fee reads, and stop discards late data',async()=>{
  let resolve!:(value:any)=>void,calls=0,now=1_000_000;
  const client={privateGetV5AccountFeeRate:()=>{calls++;return new Promise(r=>resolve=r);}};
  const fees=new NativeTradingFees('bybit',client,symbol=>market('bybit',symbol.split('/')[0]),()=>now,5);
  const symbols=Array.from({length:300},(_,n)=>`COIN${n}/USDT:USDT`);
  const rows=fees.enrich(symbols.map(position));assert.equal(rows.length,300);assert.ok(rows.every(p=>p.quantity===110));await tick();assert.equal(calls,0);
  const requests=symbols.map(symbol=>fees.fetch(symbol));await tick();assert.equal(calls,2);
  fees.enrich([position(symbols[0])]);assert.equal(await fees.fetch(symbols[0]),undefined);assert.equal(calls,2,'hung GETs do not overlap retries');
  fees.stop();resolve({retCode:0,result:{list:[{symbol:'COIN1USDT',takerFeeRate:'.0011'}]}});await tick();assert.equal(fees.cached(symbols[1]),undefined);
  await Promise.all(requests);
});
test('private fee metadata is disabled for public monitoring clients, missing credentials and paper mode',async()=>{
  let calls=0;const client={apiKey:KEY,secret:SECRET,loadMarkets:async()=>{calls++;},privateGetV5AccountFeeRate:async()=>{calls++;}};
  const adapters=[new CcxtAdapter('bybit',config,client,true),new CcxtAdapter('bybit',{...config,mode:'paper'},client),
    new CcxtAdapter('bybit',config,{...client,apiKey:''})];
  for(const adapter of adapters){assert.equal(await adapter.fetchTradingFee('DGAI/USDT:USDT'),undefined);assert.equal(adapter.cachedTradingFee('DGAI/USDT:USDT'),undefined);await adapter.close();}
  assert.equal(calls,0);
});
test('account polling never requests fees and gains fee evidence only after an explicit action read',async()=>{
  let resolve!:(value:any)=>void,calls=0;const m=market('binance');
  const client={apiKey:KEY,secret:SECRET,loadMarkets:async()=>{},market:()=>m,
    fetchBalance:async()=>({USDT:{free:100,total:200}}),fetchPositions:async()=>[{symbol:m.symbol,side:'long',contracts:110,markPrice:.9,entryPrice:.9007,leverage:2}],
    fapiPrivateGetCommissionRate:()=>{calls++;return new Promise(r=>resolve=r);}};
  const adapter=new CcxtAdapter('binance',config,client);
  try{const first=await adapter.fetchAccount();assert.equal(first.positions[0].quantity,110);assert.equal(first.positions[0].takerFeeRate,undefined);await tick();assert.equal(calls,0);
    const requested=adapter.fetchTradingFee(m.symbol);await tick();assert.equal(calls,1);
    resolve({symbol:m.id,takerCommissionRate:'.0011'});await requested;const second=await adapter.fetchAccount();assert.equal(second.positions[0].quantity,110);
    assert.equal(second.positions[0].takerFeeRate,.0011);assert.equal(second.positions[0].takerFeeSource,'exchange');assert.equal(calls,1);}
  finally{await adapter.close();}
});
test('native fee refresh updates exact symbol rate and an unsuccessful refresh keeps only still-fresh evidence',async()=>{
  let now=1_000_000,calls=0,rate:any='.00055';const client={privateGetV5AccountFeeRate:async()=>{calls++;return {retCode:0,result:{list:[{symbol:'DGAIUSDT',takerFeeRate:rate}]}};}};
  const fees=new NativeTradingFees('bybit',client,()=>market('bybit'),()=>now,10),symbol=position().symbol;
  assert.equal((await fees.fetch(symbol))?.takerFeeRate,.00055);now+=60_000;rate='.0011';assert.equal((await fees.fetch(symbol))?.takerFeeRate,.0011);assert.equal(calls,2);
  now+=60_000;rate='';assert.equal((await fees.fetch(symbol))?.takerFeeRate,.0011);assert.equal(calls,3);
  now+=60_001;assert.equal(fees.cached(symbol),undefined);assert.equal(await fees.fetch(symbol),undefined);fees.stop();
});
test('late native response cannot establish a fresh fee using its completion time',async()=>{
  let now=1_000_000,resolve!:(value:any)=>void;const client={privateGetV5AccountFeeRate:()=>new Promise(r=>resolve=r)};
  const fees=new NativeTradingFees('bybit',client,()=>market('bybit'),()=>now,10),result=fees.fetch(position().symbol);
  await tick();now+=NATIVE_FEE_MAX_AGE_MS+1;resolve({retCode:0,result:{list:[{symbol:'DGAIUSDT',takerFeeRate:'.0011'}]}});
  assert.equal(await result,undefined);assert.equal(fees.cached(position().symbol),undefined);fees.stop();
});
test('failed native GET retries after 15 seconds while a successful zero fee keeps the 60-second cache',async()=>{
  let now=1_000_000,calls=0,fail=true;const client={privateGetV5AccountFeeRate:async()=>{
    calls++;if(fail)throw new Error('private payload');return {retCode:0,result:{list:[{symbol:'DGAIUSDT',takerFeeRate:'0'}]}};
  }};
  const fees=new NativeTradingFees('bybit',client,()=>market('bybit'),()=>now,10),symbol=position().symbol;
  assert.equal(await fees.fetch(symbol),undefined);now+=NATIVE_FEE_RETRY_MS-1;assert.equal(await fees.fetch(symbol),undefined);assert.equal(calls,1);
  now++;fail=false;assert.equal((await fees.fetch(symbol))?.takerFeeRate,0);assert.equal(calls,2);
  now+=59_999;assert.equal((await fees.fetch(symbol))?.takerFeeRate,0);assert.equal(calls,2);
  now++;assert.equal((await fees.fetch(symbol))?.takerFeeRate,0);assert.equal(calls,3);fees.stop();
});
test('malformed refresh uses the failure retry window without extending the older native evidence timestamp',async()=>{
  let now=1_000_000,calls=0,invalid=false;const client={privateGetV5AccountFeeRate:async()=>{calls++;return {
    retCode:0,result:{list:[{symbol:invalid?'SOONUSDT':'DGAIUSDT',takerFeeRate:'.0011'}]}};}};
  const fees=new NativeTradingFees('bybit',client,()=>market('bybit'),()=>now,10),symbol=position().symbol;
  await fees.fetch(symbol);const first=fees.cached(symbol)!;now+=60_000;invalid=true;
  assert.equal((await fees.fetch(symbol))?.takerFeeAt,first.takerFeeAt);assert.equal(calls,2);now+=14_999;await fees.fetch(symbol);assert.equal(calls,2);
  now++;invalid=false;assert.equal((await fees.fetch(symbol))?.takerFeeAt,now);assert.equal(calls,3);fees.stop();
});
test('Bitget current all-fee endpoint must echo exactly one matching contract and never falls back after failure',async()=>{
  let data:any=[{symbol:'SOONUSDT',takerFeeRate:'.0006'}],fallback=0;
  const client={privateUtaGetV3AccountSettings:async()=>({code:'00000',data:{accountMode:'unified'}}),
    privateUtaGetV3AccountAllFeeRate:async(params:any)=>{assert.deepEqual(params,{category:'USDT-FUTURES',symbol:'DGAIUSDT'});return {code:'00000',data};},
    privateUtaGetV3AccountFeeRate:async()=>{fallback++;return {code:'00000',data:{takerFeeRate:'.0006'}};}};
  assert.equal(await readNativeTradingFee('bitget',client,market('bitget')),undefined);assert.equal(fallback,0);
  data=[{symbol:'DGAIUSDT',takerFeeRate:'.0006'},{symbol:'DGAIUSDT',takerFeeRate:'.001'}];assert.equal(await readNativeTradingFee('bitget',client,market('bitget')),undefined);
  data=[{symbol:'DGAIUSDT',takerFeeRate:'.0006'}];assert.equal(await readNativeTradingFee('bitget',client,market('bitget')),.0006);
});

test('missing or malformed native Maker stays unknown while independently verified Taker survives',async()=>{
  const row:any={symbol:'DGAIUSDT',takerFeeRate:'.0011'},client={privateGetV5AccountFeeRate:async()=>({retCode:0,result:{list:[row]}})};
  for(const maker of [undefined,'',null,false,NaN,Infinity,'.011','-.011']){
    row.makerFeeRate=maker;assert.deepEqual(await readNativeTradingFeeRates('bybit',client,market('bybit')),{takerFeeRate:.0011});
  }
  row.makerFeeRate='-.0001';assert.deepEqual(await readNativeTradingFeeRates('bybit',client,market('bybit')),{takerFeeRate:.0011,makerFeeRate:-.0001});
  row.symbol='SOONUSDT';assert.equal(await readNativeTradingFeeRates('bybit',client,market('bybit')),undefined);
});

test('successful refresh with no Maker removes earlier Maker evidence without extending its lifetime',async()=>{
  let now=1_000_000,maker:any='.0002',calls=0;
  const client={privateGetV5AccountFeeRate:async()=>{calls++;return {retCode:0,result:{list:[{symbol:'DGAIUSDT',takerFeeRate:'.0011',makerFeeRate:maker}]}};}};
  const fees=new NativeTradingFees('bybit',client,()=>market('bybit'),()=>now,10),symbol=position().symbol;
  assert.equal((await fees.fetch(symbol))?.makerFeeRate,.0002);assert.equal(calls,1);
  now+=60_000;maker=undefined;const latest=await fees.fetch(symbol);
  assert.equal(latest?.takerFeeRate,.0011);assert.equal(latest?.makerFeeRate,undefined);assert.equal(latest?.makerFeeAt,undefined);
  assert.equal(calls,2,'Maker and Taker share one identified response');fees.stop();
});

test('account enrichment clears seeded Maker when the current cache is Taker-only or unavailable',async()=>{
  let now=1_000_000,maker:any='.0002';
  const client={privateGetV5AccountFeeRate:async()=>({retCode:0,result:{list:[{symbol:'DGAIUSDT',takerFeeRate:'.0011',makerFeeRate:maker}]}})};
  const fees=new NativeTradingFees('bybit',client,()=>market('bybit'),()=>now,10),symbol=position().symbol;
  const assertNoMaker=(row:AccountPosition)=>{
    assert.equal(row.makerFeeRate,undefined);assert.equal(row.makerFeeAt,undefined);assert.equal(row.makerFeeSource,undefined);
    assert.equal(row.quantity,110);
  };
  try{
    const fresh=await fees.fetch(symbol);assert.equal(fresh?.makerFeeRate,.0002);
    const seeded={...position(),...fresh};
    now+=60_000;maker=undefined;await fees.fetch(symbol);
    const takerOnly=fees.enrich([seeded])[0];assertNoMaker(takerOnly);assert.equal(takerOnly.takerFeeRate,.0011);
    // Stop removes the cache deterministically without inventing a fee read or renewing the old row.
    fees.stop();const empty=fees.enrich([seeded])[0];assertNoMaker(empty);
    assert.equal(empty.takerFeeRate,undefined);assert.equal(empty.takerFeeAt,undefined);assert.equal(empty.takerFeeSource,undefined);
  }finally{fees.stop();}
});

test('persistent account references isolate venue, credential identity and exact contract without saving credentials',()=>{
  const folder=mkdtempSync(join(tmpdir(),'fee-reference-')),path=join(folder,'cache.json'),now=2_000_000;
  const identity=accountFeeIdentity({apiKey:KEY,secret:SECRET,password:PASSWORD})!,symbol=position().symbol;
  try{
    const store=new LocalAccountFeeCache(path,()=>now),value={source:'account-reference' as const,takerRate:.0011,makerRate:-.0001,observedAt:1_000_000};
    store.remember('bybit',identity,symbol,value);
    const text=readFileSync(path,'utf8');assert.ok(!text.includes(KEY));assert.ok(!text.includes(SECRET));assert.ok(!text.includes(PASSWORD));
    const restarted=new LocalAccountFeeCache(path,()=>now);assert.deepEqual(restarted.cached('bybit',identity,symbol),value);
    assert.equal(restarted.cached('gate',identity,symbol),undefined);assert.equal(restarted.cached('bybit',identity,'SOON/USDT:USDT'),undefined);
    for(const changed of [{apiKey:`${KEY}-new`,secret:SECRET,password:PASSWORD},{apiKey:KEY,secret:`${SECRET}-new`,password:PASSWORD},
      {apiKey:KEY,secret:SECRET,password:`${PASSWORD}-new`}])assert.equal(restarted.cached('bybit',accountFeeIdentity(changed),symbol),undefined);
    assert.equal(nativeTakerFeeRate(value as any,now),undefined);assert.equal(nativeMakerFeeRate(value as any,now),undefined);
    assert.deepEqual(readdirSync(folder),['cache.json'],'atomic writes leave no temporary files');
  }finally{cleanReferenceFolder(folder);}
});

test('local references are bounded and invalid/older evidence cannot overwrite a verified observation',()=>{
  const folder=mkdtempSync(join(tmpdir(),'fee-reference-')),path=join(folder,'cache.json'),identity=accountFeeIdentity({apiKey:KEY,secret:SECRET})!,now=2_000_000;
  try{
    const store=new LocalAccountFeeCache(path,()=>now),value={source:'account-reference' as const,takerRate:.0011,observedAt:now-1000};
    for(let n=0;n<LOCAL_ACCOUNT_FEE_MAX_ENTRIES+20;n++)store.remember('bybit',identity,`COIN${n}/USDT:USDT`,{...value,observedAt:value.observedAt+n},false);
    const symbol=`COIN${LOCAL_ACCOUNT_FEE_MAX_ENTRIES+19}/USDT:USDT`,latest=store.cached('bybit',identity,symbol)!;
    store.remember('bybit',identity,symbol,{...latest,observedAt:latest.observedAt-1,takerRate:0},false);
    for(const invalid of [{takerRate:NaN},{takerRate:-.0001},{takerRate:.02},{makerRate:.02},{observedAt:now+1}])
      store.remember('bybit',identity,symbol,{...latest,...invalid},false);
    assert.deepEqual(store.cached('bybit',identity,symbol),latest);assert.equal(store.cached('bybit',identity,'COIN0/USDT:USDT'),undefined);
    store.remember('bybit',identity,symbol,latest);assert.equal(JSON.parse(readFileSync(path,'utf8')).entries.length,LOCAL_ACCOUNT_FEE_MAX_ENTRIES);
    writeFileSync(path,'not-json');assert.equal(new LocalAccountFeeCache(path,()=>now).cached('bybit',identity,symbol),undefined);
  }finally{cleanReferenceFolder(folder);}
});

test('engine and portfolio adapters share only account references and do not promote them to native evidence',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'fee-reference-')),path=join(folder,'cache.json');let calls=0;const m=market('binance');
  const makeClient=(secret=SECRET)=>({apiKey:KEY,secret,loadMarkets:async()=>{},market:()=>m,
    fetchBalance:async()=>({USDT:{free:100,total:200}}),fetchPositions:async()=>[{symbol:m.symbol,side:'long',contracts:110,markPrice:.9,entryPrice:.9007,leverage:2}],
    fapiPrivateGetCommissionRate:async()=>{calls++;return {symbol:m.id,takerCommissionRate:'.0011',makerCommissionRate:'.0002'};}});
  const engine=new CcxtAdapter('binance',config,makeClient(),false,{feeReferencePath:path});
  const portfolio=new CcxtAdapter('binance',config,makeClient(),false,{feeReferencePath:path});
  const replaced=new CcxtAdapter('binance',config,makeClient(`${SECRET}-new`),false,{feeReferencePath:path});
  try{
    assert.equal(portfolio.referenceTradingFee(m.symbol),undefined);await engine.fetchTradingFee(m.symbol);assert.equal(calls,1);
    const reference=portfolio.referenceTradingFee(m.symbol)!;assert.equal(reference.source,'account-reference');assert.equal(reference.takerRate,.0011);
    const row=(await portfolio.fetchAccount()).positions[0];assert.equal(calls,1);assert.equal(row.quantity,110);
    assert.deepEqual(row.feeReference,reference);assert.equal(row.takerFeeSource,undefined);assert.equal(portfolio.cachedTradingFee(m.symbol),undefined);
    assert.equal(replaced.referenceTradingFee(m.symbol),undefined);assert.equal(reference.observedAt,engine.cachedTradingFee(m.symbol)!.takerFeeAt);
  }finally{await Promise.all([engine.close(),portfolio.close(),replaced.close()]);cleanReferenceFolder(folder);}
});

test('reference persistence failures cannot fail a successful explicit native fee read',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'fee-reference-')),cache=new LocalAccountFeeCache(folder),{client,calls}=signedFixture('bybit');
  const adapter=new CcxtAdapter('bybit',config,client,false,{feeReferenceCache:cache});
  try{
    assert.equal((await adapter.fetchTradingFee(position().symbol))?.takerFeeRate,.0011);assert.equal(calls.length,1);
    assert.equal(adapter.referenceTradingFee(position().symbol)?.takerRate,.0011);assert.deepEqual(readdirSync(folder),[]);
  }finally{await adapter.close();cleanReferenceFolder(folder);}
});

test('reference callbacks run only for successful native reads and enrichment never refreshes evidence',async()=>{
  let now=1_000_000,calls=0,observations=0,invalid=false;
  const client={privateGetV5AccountFeeRate:async()=>{calls++;return {retCode:0,result:{list:[{symbol:invalid?'SOONUSDT':'DGAIUSDT',takerFeeRate:'.0011'}]}};}};
  const reference={source:'account-reference' as const,takerRate:.0011,observedAt:now};
  const fees=new NativeTradingFees('bybit',client,()=>market('bybit'),()=>now,10,{reference:()=>reference,onObservation:()=>{observations++;}});
  try{
    assert.equal(fees.enrich([position()])[0].feeReference?.source,'account-reference');assert.equal(calls,0);
    const fresh=await fees.fetch(position().symbol);assert.equal(observations,1);
    now+=60_000;invalid=true;await fees.fetch(position().symbol);assert.equal(observations,1);
    now+=60_001;const row=fees.enrich([{...position(),...fresh}])[0];assert.equal(calls,2);
    assert.equal(row.takerFeeRate,undefined);assert.equal(row.makerFeeRate,undefined);assert.deepEqual(row.feeReference,reference);
  }finally{fees.stop();}
});

test('Bybit fee profiles use native classification signals and never coin names',()=>{
  assert.equal(bybitFeeProfile({...market('bybit'),info:{isPreListing:true,symbolType:'innovation'}}),'pre-market');
  assert.equal(bybitFeeProfile({...market('bybit'),info:{symbolType:'innovation'}}),'innovation');
  assert.equal(bybitFeeProfile({...market('bybit'),info:{symbolType:'',isPreListing:false}}),'standard');
  assert.equal(bybitFeeProfile({...market('bybit'),info:{symbolType:''}}),'unknown');
  assert.equal(bybitFeeProfile({...market('bybit'),info:{symbolType:'',status:'PreLaunch'}}),'pre-market');
  assert.equal(bybitFeeProfile({...market('bybit'),info:{symbolType:'commodity',isPreListing:false}}),'unknown');
  assert.equal(bybitFeeProfile(market('bybit','BTC')),'unknown');assert.equal(bybitFeeProfile(market('bybit','DGAI')),'unknown');
  assert.equal(bybitFeeProfile({...market('bybit'),info:{symbolType:'future-new-classification'}}),'unknown');
});
