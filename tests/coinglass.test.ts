import test from 'node:test';
import assert from 'node:assert/strict';
import { CoinGlassFundingStatistics, normalizeCoinGlassRows, type CoinGlassRequest } from '../src/data/coinglass.js';
import { FUNDING_RANGES, fundingCellIsFresh } from '../src/shared/funding-statistics.js';

const sample=(rate:unknown=0.01)=>[{symbol:'BTC',stablecoin_margin_list:[{exchange:'Binance',funding_rate:rate,funding_rate_interval:8,next_funding_time:2_000_000}]}];
const reply=(data:unknown)=>({status:200,json:async()=>({code:'0',data})});
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('official percentage conversion preserves zero, normalizes five venues, excludes coin margin and invalid rates',()=>{
  const rows=normalizeCoinGlassRows([{symbol:'btc',stablecoin_margin_list:[
    {exchange:'BINANCE',funding_rate:0,funding_rate_interval:8,next_funding_time:2_000_000},
    {exchange:'Binance',funding_rate:3},
    {exchange:'Bybit',funding_rate:-0.02,funding_rate_interval:4},
    {exchange:'OKX',funding_rate:'0.01'},
    {exchange:'Gate.io',funding_rate:0.03,funding_rate_interval:0},
    {exchange:'Bitget',funding_rate:0.04},
    {exchange:'UNKNOWN',funding_rate:1},
  ],token_margin_list:[{exchange:'Binance',funding_rate:99}]},
  {symbol:'ETH',stablecoin_margin_list:[{exchange:'Binance',funding_rate:null},{exchange:'Bybit',funding_rate:''},{exchange:'OKX',funding_rate:Infinity}]}], 'current',1_000_000);
  assert.equal(rows.length,1);assert.equal(rows[0].base,'BTC');assert.equal(Object.keys(rows[0].cells).length,5);
  const {binance,bybit,okx,gate,bitget}=rows[0].cells;
  assert.equal(binance!.rate,0);assert.equal(bybit!.rate,-0.0002);assert.equal(okx!.rate,0.0001);
  assert.equal(gate!.rate,0.0003);assert.equal(bitget!.rate,0.0004);
  assert.equal(bybit!.intervalHours,4);assert.equal(gate!.intervalHours,null);assert.equal(okx!.nextFundingTime,null);
  assert.equal(binance!.updatedAt,1_000_000);assert.equal(binance!.timestampKind,'received');
  assert.equal(binance!.predictedRate,undefined);assert.equal(binance!.openInterestUsd,undefined);
});

test('cumulative ranges do not invent settlement schedules or current predictions',()=>{
  const cell=normalizeCoinGlassRows(sample(0.42),'30d',100)[0].cells.binance!;
  assert.equal(cell.rate,0.0042);assert.equal(cell.intervalHours,null);assert.equal(cell.nextFundingTime,null);
});

test('Unicode tickers preserve stablecoin duplicates while rejecting spaces, controls, slashes and excessive length',()=>{
  const invalid=['中文 币','中文/币','中文\u0000币',' 中文币','中文币\n','币'.repeat(41)];
  const rows=normalizeCoinGlassRows([
    {symbol:'中文币',stablecoin_margin_list:[{exchange:'Gate.io',funding_rate:null},{exchange:'Gate.io',funding_rate:0.01}],token_margin_list:[{exchange:'Gate.io',funding_rate:99},{exchange:'Bybit',funding_rate:88}]},
    {symbol:'中文币',stablecoin_margin_list:[{exchange:'Gate',funding_rate:0.02}]},
    ...invalid.map(symbol=>({symbol,stablecoin_margin_list:[{exchange:'Binance',funding_rate:0.01}]})),
  ],'current',100);
  assert.equal(rows.length,1);assert.equal(rows[0].base,'中文币');
  assert.deepEqual(Object.keys(rows[0].cells),['gate']);assert.equal(rows[0].cells.gate!.rate,0.0001);
});

test('missing API key returns not_configured without starting a request',async()=>{
  let requests=0;
  const client=new CoinGlassFundingStatistics({env:{},request:async()=>{requests++;return reply([]);}});
  assert.equal(client.configured,false);assert.equal(client.get('current').status,'not_configured');
  await client.refresh('current');assert.equal(requests,0);await client.stop();
});

test('get is immediate, refresh is single-flight and TTL differs between current and cumulative',async()=>{
  let now=1_000_000,calls=0;
  let complete:((value:ReturnType<typeof reply>)=>void)|undefined;
  const request:CoinGlassRequest=async(url,options)=>{
    calls++;assert.equal(options.headers['CG-API-KEY'],'test-key');assert.ok(!url.includes('test-key'));
    if(calls===1)return new Promise(resolve=>{complete=resolve;});return reply(sample());
  };
  const client=new CoinGlassFundingStatistics({env:{COINGLASS_API_KEY:'test-key'},request,now:()=>now});
  assert.equal(client.get('current').status,'loading');
  await tick();const first=client.refresh('current');assert.equal(first,client.refresh('current'));assert.equal(calls,1);
  complete!(reply(sample()));await first;
  assert.equal(client.get('current').status,'ready');assert.equal(client.get('current').nextRefreshAt,now+20_000);
  await client.refresh('7d');assert.equal(client.get('7d').nextRefreshAt,now+3_600_000);
  now+=19_999;await client.refresh('current');assert.equal(calls,2);
  now+=1;await client.refresh('current');assert.equal(calls,3);
  assert.equal(client.get('7d').receivedAt,1_000_000);await client.stop();
});

test('HTTP 200 authentication failure clears eligibility and preserves original cache timestamp',async()=>{
  let now=1_000_000,calls=0;
  const client=new CoinGlassFundingStatistics({env:{COINGLASS_API_KEY:'private-test-value'},now:()=>now,request:async()=>{
    calls++;return calls===1?reply(sample()):{status:200,json:async()=>({code:'401',msg:'private-test-value'})};
  }});
  await client.refresh('current');const initial=client.get('current');assert.equal(initial.status,'ready');
  now+=20_000;await client.refresh('current');
  const failed=client.get('current'),cell=failed.rows[0].cells.binance!;
  assert.equal(failed.status,'error');assert.match(failed.message!,/API Key/);assert.equal(failed.receivedAt,initial.receivedAt);
  assert.equal(cell.updatedAt,initial.receivedAt);assert.equal(cell.available,false);assert.equal(fundingCellIsFresh(cell,failed,now),false);
  assert.equal(JSON.stringify(failed).includes('private-test-value'),false);assert.equal(failed.nextRefreshAt,now+60_000);
  await client.refresh('current');assert.equal(calls,2);
  now+=120_001;assert.equal(client.get('current').status,'stale');await client.stop();
});

test('all range requests share a maximum concurrency of two and stop cancels active plus queued work',async()=>{
  let active=0,maximum=0,calls=0;
  const client=new CoinGlassFundingStatistics({env:{COINGLASS_API_KEY:'test-key'},request:async(_url,options)=>{
    calls++;active++;maximum=Math.max(maximum,active);
    return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>{active--;reject(new Error('aborted'));},{once:true}));
  }});
  const pending=FUNDING_RANGES.map(range=>client.refresh(range));await tick();
  assert.equal(calls,2);assert.equal(maximum,2);
  await client.stop();await Promise.all(pending);assert.equal(active,0);assert.equal(calls,2);
  client.get('current');await tick();assert.equal(calls,2);
});

test('timeout bounds a non-cooperating request and uses a cooldown without returning raw errors',async()=>{
  const client=new CoinGlassFundingStatistics({env:{COINGLASS_API_KEY:'test-key'},timeoutMs:15,request:async()=>new Promise(()=>{})});
  await client.refresh('current');const result=client.get('current');
  assert.equal(result.status,'error');assert.match(result.message!,/超时/);assert.ok(result.nextRefreshAt>result.lastAttemptAt);
  await client.stop();
});

test('rate limit and malformed payload never become ready funding data',async()=>{
  for(const response of [{status:429,json:async()=>({})},{status:200,json:async()=>({code:'0',data:{}})}]){
    const client=new CoinGlassFundingStatistics({env:{COINGLASS_API_KEY:'test-key'},request:async()=>response});
    await client.refresh('current');const result=client.get('current');assert.equal(result.status,'error');assert.deepEqual(result.rows,[]);await client.stop();
  }
});
