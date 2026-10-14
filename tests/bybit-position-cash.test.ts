import test from 'node:test';
import assert from 'node:assert/strict';
import {BybitPositionCash,summarizeBybitPositionCash} from '../src/adapters/bybit-position-cash.js';
import type {AccountPosition} from '../src/shared/types.js';

const OPEN=1_790_878_380_457,NOW=OPEN+86_400_000;
const h={symbol:'SIRENUSDT',side:'Sell' as const,quantity:4330,openTime:OPEN,key:'test'};
const raw=(extra:any={})=>({symbol:h.symbol,side:h.side,size:String(h.quantity),positionIdx:0,openTime:OPEN,updatedTime:OPEN,...extra});
const p:AccountPosition={base:'SIREN',symbol:'SIREN/USDT:USDT',side:'short',quantity:4330,markPrice:.02316,liquidationPrice:1,leverage:2};
const trade=(extra:any={})=>({id:'open',symbol:h.symbol,category:'linear',currency:'USDT',type:'TRADE',side:'Sell',qty:'4330',size:'-4330',fee:'0.1105016',funding:'0',transactionTime:String(OPEN),...extra});
const funding=(extra:any={})=>({id:'fund',symbol:h.symbol,category:'linear',currency:'USDT',type:'SETTLEMENT',side:'Sell',qty:'4330',size:'-4330',fee:'0',funding:'0.12009716',transactionTime:String(OPEN+1000),...extra});
const ok=(rows:any[],cursor='')=>({retCode:0,result:{list:rows,nextPageCursor:cursor}});
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('current position uses actual signed funding and fee fields, excludes previous cycles and other symbols',()=>{
  const cash=summarizeBybitPositionCash(h,[trade(),funding(),funding({id:'next',funding:'0.18708195'}),
    trade({id:'past',transactionTime:String(OPEN-1),fee:'100'}),funding({symbol:'BTRUSDT',funding:'999'})],NOW)!;
  assert.ok(Math.abs(cash.fundingUsd-.30717911)<1e-12);assert.equal(cash.feesUsd,.1105016);assert.equal(cash.cashFlowAt,NOW);
});

test('no settled funding after complete opening is genuine zero; rebates remain negative fees',()=>{
  const cash=summarizeBybitPositionCash(h,[trade({fee:'-.02'})],NOW)!;
  assert.equal(cash.fundingUsd,0);assert.equal(cash.feesUsd,-.02);
  assert.equal(summarizeBybitPositionCash(h,[],NOW),undefined);
  assert.equal(summarizeBybitPositionCash(h,[funding()],NOW),undefined);
});

test('funding payments remain negative and realized spread cashFlow is never called funding',()=>{
  const cash=summarizeBybitPositionCash(h,[trade({cashFlow:'876'}),funding({funding:'-.03',cashFlow:'654',change:'888'})],NOW)!;
  assert.equal(cash.fundingUsd,-.03);assert.equal(cash.feesUsd,.1105016);
});

test('partial closes use signed remaining size to attribute the opposite-side trade fee correctly',()=>{
  const cash=summarizeBybitPositionCash({...h,quantity:4000},[trade(),trade({id:'close',side:'Buy',qty:'330',size:'-4000',fee:'.01',transactionTime:String(OPEN+500)})],NOW)!;
  assert.ok(Math.abs(cash.feesUsd-.1205016)<1e-12);
});

test('concurrent hedge legs do not share funding or open/close fees',()=>{
  const cash=summarizeBybitPositionCash(h,[trade(),funding(),trade({id:'other-open',side:'Buy',qty:'100',size:'100',fee:'50'}),
    trade({id:'other-close',side:'Sell',qty:'100',size:'0',fee:'70'}),funding({side:'Buy',size:'100',funding:'999'})],NOW)!;
  assert.equal(cash.fundingUsd,.12009716);assert.equal(cash.feesUsd,.1105016);
});

test('one-way reversal attributes only the new opening share of its fee',()=>{
  const cash=summarizeBybitPositionCash(h,[trade({qty:'5000',size:'-4330',fee:'.1'})],NOW)!;
  assert.ok(Math.abs(cash.feesUsd-.0866)<1e-12);
});

test('current-cycle pure realized price PnL includes partial closing cashFlow without adding funding or fees twice',()=>{
  const cash=summarizeBybitPositionCash({...h,quantity:4000},[trade({cashFlow:'0'}),funding({funding:'.5',cashFlow:'0'}),
    trade({id:'reduce',side:'Buy',qty:'330',size:'-4000',fee:'.01',cashFlow:'1.25',transactionTime:String(OPEN+500)})],NOW)!;
  assert.equal(cash.realizedPnlUsd,1.25);assert.equal(cash.fundingUsd,.5);
  assert.ok(Math.abs(cash.feesUsd-.1205016)<1e-12);assert.equal(cash.cashFlowSince,OPEN);
});

test('reversal cashFlow belongs to the prior closed cycle; missing cashFlow leaves price realization unknown',()=>{
  const reversal=summarizeBybitPositionCash(h,[trade({qty:'5000',size:'-4330',cashFlow:'999',fee:'.1'})],NOW)!;
  assert.equal(reversal.realizedPnlUsd,0);
  const incomplete=summarizeBybitPositionCash(h,[trade()],NOW)!;
  assert.equal(incomplete.realizedPnlUsd,undefined);assert.equal(incomplete.fundingUsd,0);
});

test('malformed, delayed, incomplete and moved-position histories stay unknown',()=>{
  for(const rows of [[trade({fee:''})],[trade({qty:'4300'})],[trade(),funding({funding:''})],[trade(),funding({size:'4330'})],
    [trade({currency:'USDC'})],[trade(),funding({type:'MOVE',fee:'.1'})]]){
    assert.equal(summarizeBybitPositionCash(h,rows,NOW),undefined);
  }
});

test('collector follows every page and deduplicates repeated rows without double counting',async()=>{
  const calls:any[]=[],reader=new BybitPositionCash(async params=>{calls.push(params);return params.cursor?ok([funding(),trade()]):ok([funding()],'next');},()=>NOW);
  assert.equal(reader.enrich([raw()],[p])[0].fundingUsd,undefined);await flush();
  const output=reader.enrich([raw()],[p])[0];assert.equal(output.fundingUsd,.12009716);assert.equal(output.feesUsd,.1105016);assert.equal(calls.length,2);
  assert.equal(calls[0].accountType,'UNIFIED');assert.equal(calls[0].category,'linear');assert.equal(calls[0].currency,'USDT');assert.equal(calls[0].limit,50);
  assert.equal(calls[0].startTime,OPEN);assert.equal(calls[0].endTime,NOW);assert.equal(calls[1].cursor,'next');reader.stop();
});

test('partial pages, conflicting duplicates and repeated cursors never publish apparently complete cash',async()=>{
  for(const kind of ['failed','duplicate','cursor']){
    let calls=0;const reader=new BybitPositionCash(async()=>{
      if(++calls===1)return ok([trade()],'next');
      if(kind==='failed')throw new Error('private payload');
      return kind==='duplicate'?ok([trade({fee:'999'})]):ok([funding()],'next');
    },()=>NOW);
    reader.enrich([raw()],[p]);await flush();assert.equal(reader.enrich([raw()],[p])[0].fundingUsd,undefined);reader.stop();
  }
});

test('conflicting pure-price cashFlow on the same paginated receipt cannot publish a fabricated realized or net PnL',async()=>{
  const reader=new BybitPositionCash(async params=>params.cursor?ok([trade({cashFlow:'5'})]):ok([trade({cashFlow:'0'})],'next'),()=>NOW);
  reader.enrich([raw()],[p]);await flush();
  const output=reader.enrich([raw()],[p])[0];assert.equal(output.realizedPnlUsd,undefined);assert.equal(output.fundingUsd,undefined);
  assert.equal(reader.status().error,'Bybit cash history duplicate conflict');reader.stop();
});

test('Bybit terminal empty page can return a null nextPageCursor',async()=>{
  const reader=new BybitPositionCash(async params=>params.cursor?{retCode:0,result:{list:[],nextPageCursor:null}}:ok([trade()],'next'),()=>NOW);
  reader.enrich([raw()],[p]);await flush();assert.equal(reader.enrich([raw()],[p])[0].feesUsd,.1105016);reader.stop();
});

test('cash lookup is nonblocking, single-flight and throttled independently of position refresh',async()=>{
  let now=NOW,calls=0,resolve!:(r:any)=>void;
  const reader=new BybitPositionCash(()=>{calls++;return new Promise(r=>{resolve=r;});},()=>now);
  for(let i=0;i<10;i++)assert.equal(reader.enrich([raw()],[p])[0].quantity,4330);
  assert.equal(calls,1);resolve(ok([trade()]));await flush();assert.equal(reader.enrich([raw()],[p])[0].fundingUsd,0);
  now+=29_999;reader.enrich([raw()],[p]);assert.equal(calls,1);
  now++;reader.enrich([raw()],[p]);assert.equal(calls,2);resolve(ok([trade()]));await flush();reader.stop();
});

test('a newly opened cycle never inherits old cash even when symbol, side and quantity match',async()=>{
  const reader=new BybitPositionCash(async()=>ok([trade(),funding()]),()=>NOW);
  reader.enrich([raw()],[p]);await flush();assert.equal(reader.enrich([raw()],[p])[0].fundingUsd,.12009716);
  assert.equal(reader.enrich([raw({openTime:OPEN+2000})],[p])[0].fundingUsd,undefined);reader.stop();
});

test('missing current openTime never falls back to all-time createdTime or starts ledger queries',()=>{
  let calls=0;const reader=new BybitPositionCash(async()=>{calls++;return ok([trade()]);},()=>NOW);
  assert.equal(reader.enrich([raw({openTime:0,createdTime:OPEN})],[p])[0].fundingUsd,undefined);assert.equal(calls,0);reader.stop();
});

test('old cash expires, future-dated or out-of-window records cannot populate totals',async()=>{
  let now=NOW,fail=false;
  const reader=new BybitPositionCash(async()=>{if(fail)throw new Error('failure');return ok([trade()]);},()=>now);
  reader.enrich([raw()],[p]);await flush();fail=true;now+=90_001;
  assert.equal(reader.enrich([raw()],[p])[0].fundingUsd,undefined);await flush();reader.stop();
  const invalid=new BybitPositionCash(async()=>ok([trade(),funding({transactionTime:String(NOW+1)})]),()=>NOW);
  invalid.enrich([raw()],[p]);await flush();assert.equal(invalid.enrich([raw()],[p])[0].fundingUsd,undefined);invalid.stop();
});

test('long-lived positions use inclusive windows no longer than seven days without gaps',async()=>{
  const now=OPEN+8*86_400_000,calls:any[]=[],reader=new BybitPositionCash(async params=>{calls.push(params);return ok(params.startTime===OPEN?[trade()]:[funding({transactionTime:String(now)})]);},()=>now);
  reader.enrich([raw()],[p]);await flush();assert.equal(reader.enrich([raw()],[p])[0].fundingUsd,.12009716);assert.equal(calls.length,2);
  assert.equal(calls[1].startTime,calls[0].endTime+1);assert.ok(calls.every(c=>c.endTime-c.startTime<7*86_400_000));reader.stop();
});

test('stopped reader cannot publish late cash or continue pagination',async()=>{
  let calls=0,resolve!:(r:any)=>void;const reader=new BybitPositionCash(()=>{calls++;return new Promise(r=>{resolve=r;});},()=>NOW);
  reader.enrich([raw()],[p]);reader.stop();resolve(ok([trade()],'next'));await flush();
  assert.equal(reader.enrich([raw()],[p])[0].fundingUsd,undefined);assert.equal(calls,1);
});

test('non-cash position revisions retain the original verified cash and do not bypass the read throttle',async()=>{
  let now=NOW,calls=0;
  const reader=new BybitPositionCash(async()=>{calls++;return ok([trade({cashFlow:'0'}),funding()]);},()=>now);
  const initial=reader.enrich([raw({seq:'10'})],[p])[0];
  assert.equal(initial.cashFlowStatus,'loading');assert.equal(initial.cashFlowReason,'正在读取当前持仓周期账单');
  await flush();const verified=reader.enrich([raw({seq:'10'})],[p])[0];
  assert.equal(verified.cashFlowStatus,'ready');assert.equal(verified.cashFlowReason,'账单已完整核对');
  now+=5000;
  const revised=reader.enrich([raw({updatedTime:NOW+5000,seq:'11'})],[p])[0];
  assert.equal(revised.fundingUsd,verified.fundingUsd);assert.equal(revised.feesUsd,verified.feesUsd);
  assert.equal(revised.cashFlowAt,NOW);assert.equal(calls,1);
  reader.stop();
});

test('quantity changes discard old cash and publish only a fully attributable replacement snapshot',async()=>{
  let calls=0;
  const reader=new BybitPositionCash(async()=>{calls++;return ok(calls===1?[trade({cashFlow:'0'})]:
    [trade({cashFlow:'0'}),trade({id:'close',side:'Buy',qty:'330',size:'-4000',fee:'.01',cashFlow:'1.25',transactionTime:String(OPEN+500)})]);},()=>NOW);
  reader.enrich([raw()],[p]);await flush();assert.equal(reader.enrich([raw()],[p])[0].cashFlowStatus,'ready');
  const reduced={...p,quantity:4000},changed=reader.enrich([raw({size:'4000'})],[reduced])[0];
  assert.equal(changed.quantity,4000);assert.equal(changed.fundingUsd,undefined);assert.equal(changed.feesUsd,undefined);
  assert.equal(changed.cashFlowStatus,'loading');assert.equal(calls,2);
  await flush();const verified=reader.enrich([raw({size:'4000'})],[reduced])[0];
  assert.equal(verified.cashFlowStatus,'ready');assert.equal(verified.realizedPnlUsd,1.25);
  assert.ok(Math.abs(verified.feesUsd!-.1205016)<1e-12);reader.stop();
});

test('a replacement opening cycle cannot inherit funding, fees or status from the previous cycle',async()=>{
  let calls=0;
  const reader=new BybitPositionCash(async()=>{calls++;return ok(calls===1?[trade({cashFlow:'0'}),funding()]:
    [trade({transactionTime:String(OPEN+2000),cashFlow:'0',fee:'.02'})]);},()=>NOW);
  reader.enrich([raw()],[p]);await flush();assert.equal(reader.enrich([raw()],[p])[0].cashFlowStatus,'ready');
  const initial=reader.enrich([raw({openTime:OPEN+2000})],[p])[0];
  assert.equal(initial.cashFlowStatus,'loading');assert.equal(initial.fundingUsd,undefined);assert.equal(initial.feesUsd,undefined);
  await flush();const fresh=reader.enrich([raw({openTime:OPEN+2000})],[p])[0];
  assert.equal(fresh.cashFlowStatus,'ready');assert.equal(fresh.fundingUsd,0);assert.equal(fresh.feesUsd,.02);
  assert.equal(fresh.cashFlowSince,OPEN+2000);assert.equal(calls,2);reader.stop();
});

test('missing current-cycle time is explicitly unavailable and never fabricates zero cash or starts a query',()=>{
  let calls=0;const reader=new BybitPositionCash(async()=>{calls++;return ok([]);},()=>NOW);
  const output=reader.enrich([raw({openTime:0,createdTime:OPEN})],[p])[0];
  assert.equal(output.cashFlowStatus,'unavailable');assert.equal(output.cashFlowReason,'交易所未返回当前持仓周期时间');
  assert.equal(output.fundingUsd,undefined);assert.equal(output.feesUsd,undefined);assert.equal(calls,0);reader.stop();
});

test('empty or incomplete history is identified separately from an actual request failure',async()=>{
  for(const rows of [[],[funding()],[trade({qty:'4300'})]]){
    const reader=new BybitPositionCash(async()=>ok(rows),()=>NOW);
    reader.enrich([raw()],[p]);await flush();const incomplete=reader.enrich([raw()],[p])[0];
    assert.equal(incomplete.cashFlowStatus,'incomplete');assert.equal(incomplete.cashFlowReason,'账单无法完整归属当前持仓周期');
    assert.equal(incomplete.fundingUsd,undefined);assert.equal(incomplete.feesUsd,undefined);
    assert.equal(reader.status().pending,false);assert.equal(reader.status().error,undefined);reader.stop();
  }
  const failed=new BybitPositionCash(async()=>{throw new Error('sensitive private response');},()=>NOW);
  failed.enrich([raw()],[p]);await flush();const output=failed.enrich([raw()],[p])[0];
  assert.equal(output.cashFlowStatus,'error');assert.equal(output.cashFlowReason,'账单请求失败，后台会自动重试');
  assert.equal(output.fundingUsd,undefined);assert.equal(output.feesUsd,undefined);
  assert.equal(failed.status().error,'Bybit cash history request failed');failed.stop();
});

test('verified funding and fees remain visible when a missing pure-price cash field prevents a complete net value',async()=>{
  const reader=new BybitPositionCash(async()=>ok([trade(),funding()]),()=>NOW);
  reader.enrich([raw()],[p]);await flush();const partial=reader.enrich([raw()],[p])[0];
  assert.equal(partial.fundingUsd,.12009716);assert.equal(partial.feesUsd,.1105016);assert.equal(partial.cashFlowAt,NOW);
  assert.equal(partial.realizedPnlUsd,undefined);assert.equal(partial.cashFlowStatus,'incomplete');reader.stop();
});

test('failed background refresh retains only still-valid evidence without renewing its observed timestamp',async()=>{
  let now=NOW,fail=false;
  const reader=new BybitPositionCash(async()=>{if(fail)throw new Error('failed');return ok([trade({cashFlow:'0'})]);},()=>now);
  reader.enrich([raw()],[p]);await flush();fail=true;now+=30_000;
  reader.enrich([raw()],[p]);await flush();const cached=reader.enrich([raw()],[p])[0];
  assert.equal(cached.cashFlowStatus,'ready');assert.equal(cached.cashFlowAt,NOW);assert.equal(cached.fundingUsd,0);
  now=NOW+90_001;const expired=reader.enrich([raw()],[p])[0];
  assert.equal(expired.cashFlowStatus,'error');assert.equal(expired.fundingUsd,undefined);assert.equal(expired.feesUsd,undefined);
  assert.equal(expired.cashFlowAt,undefined);await flush();reader.stop();
});

test('expired evidence is marked stale while a slow refresh preserves fresh holding quantities',async()=>{
  let now=NOW,calls=0,resolve!:(result:any)=>void;
  const reader=new BybitPositionCash(async()=>++calls===1?ok([trade({cashFlow:'0'})]):new Promise(r=>{resolve=r;}),()=>now);
  reader.enrich([raw()],[p]);await flush();now+=30_000;reader.enrich([raw()],[p]);
  now=NOW+90_001;const expired=reader.enrich([raw()],[p])[0];
  assert.equal(expired.cashFlowStatus,'stale');assert.equal(expired.cashFlowReason,'账单证据已过期，等待重新读取');
  assert.equal(expired.quantity,p.quantity);assert.equal(expired.fundingUsd,undefined);assert.equal(expired.feesUsd,undefined);
  assert.equal(calls,2);resolve(ok([trade({cashFlow:'0'})]));await flush();reader.stop();
});

test('a successful incomplete refresh retains only the same holding original unexpired cash observation',async()=>{
  for(const incompleteRows of [[],[funding()],[trade({qty:'4300',fee:'999',cashFlow:'999'})]]){
    let now=NOW,calls=0;
    const reader=new BybitPositionCash(async()=>++calls===1?ok([trade({cashFlow:'0'}),funding()]):ok(incompleteRows),()=>now);
    reader.enrich([raw()],[p]);await flush();const original=reader.enrich([raw()],[p])[0];
    assert.equal(original.cashFlowStatus,'ready');
    now+=30_000;reader.enrich([raw()],[p]);await flush();const retained=reader.enrich([raw()],[p])[0];
    assert.equal(retained.cashFlowStatus,'incomplete');assert.equal(retained.cashFlowReason,'账单无法完整归属当前持仓周期');
    assert.equal(retained.fundingUsd,original.fundingUsd);assert.equal(retained.feesUsd,original.feesUsd);
    assert.equal(retained.realizedPnlUsd,original.realizedPnlUsd);assert.equal(retained.cashFlowAt,NOW);
    assert.equal(retained.cashFlowSince,OPEN);assert.equal(reader.status().available,1);assert.equal(calls,2);
    now+=10_000;assert.equal(reader.enrich([raw()],[p])[0].cashFlowAt,NOW);assert.equal(calls,2);
    now=NOW+90_001;const expired=reader.enrich([raw()],[p])[0];
    assert.equal(expired.fundingUsd,undefined);assert.equal(expired.feesUsd,undefined);assert.equal(expired.cashFlowAt,undefined);
    await flush();assert.equal(reader.status().available,0);reader.stop();
  }
});

test('incomplete replacement quantity or opening-cycle histories cannot inherit previously verified cash',async()=>{
  for(const change of [{raw:{size:'4000'},position:{...p,quantity:4000}},{raw:{openTime:OPEN+2000},position:p}]){
    let calls=0;const reader=new BybitPositionCash(async()=>++calls===1?ok([trade({cashFlow:'0'}),funding()]):ok([]),()=>NOW);
    reader.enrich([raw()],[p]);await flush();assert.equal(reader.enrich([raw()],[p])[0].cashFlowStatus,'ready');
    const changed=reader.enrich([raw(change.raw)],[change.position])[0];
    assert.equal(changed.fundingUsd,undefined);assert.equal(changed.feesUsd,undefined);assert.equal(changed.cashFlowAt,undefined);
    await flush();const incomplete=reader.enrich([raw(change.raw)],[change.position])[0];
    assert.equal(incomplete.cashFlowStatus,'incomplete');assert.equal(incomplete.fundingUsd,undefined);
    assert.equal(incomplete.feesUsd,undefined);assert.equal(incomplete.cashFlowAt,undefined);assert.equal(reader.status().available,0);
    reader.stop();
  }
});

test('a slow incomplete response cannot retain cash that expired while its pages were being read',async()=>{
  let now=NOW,calls=0,resolve!:(result:any)=>void;
  const reader=new BybitPositionCash(async()=>++calls===1?ok([trade({cashFlow:'0'})]):new Promise(r=>{resolve=r;}),()=>now);
  reader.enrich([raw()],[p]);await flush();assert.equal(reader.enrich([raw()],[p])[0].cashFlowStatus,'ready');
  now+=30_000;reader.enrich([raw()],[p]);now=NOW+90_001;resolve(ok([]));await flush();
  const expired=reader.enrich([raw()],[p])[0];
  assert.equal(expired.cashFlowStatus,'incomplete');assert.equal(expired.fundingUsd,undefined);assert.equal(expired.feesUsd,undefined);
  assert.equal(expired.cashFlowAt,undefined);assert.equal(reader.status().available,0);reader.stop();
});

test('a complete refresh after an incomplete response publishes only the newly read cash and timestamp',async()=>{
  let now=NOW,calls=0;
  const reader=new BybitPositionCash(async()=>ok(++calls===2?[]:
    [trade({cashFlow:'0'}),funding({funding:calls===1?'.1':'.2'})]),()=>now);
  reader.enrich([raw()],[p]);await flush();assert.equal(reader.enrich([raw()],[p])[0].fundingUsd,.1);
  now+=30_000;reader.enrich([raw()],[p]);await flush();const incomplete=reader.enrich([raw()],[p])[0];
  assert.equal(incomplete.cashFlowStatus,'incomplete');assert.equal(incomplete.fundingUsd,.1);assert.equal(incomplete.cashFlowAt,NOW);
  now+=30_000;reader.enrich([raw()],[p]);await flush();const recovered=reader.enrich([raw()],[p])[0];
  assert.equal(recovered.cashFlowStatus,'ready');assert.equal(recovered.fundingUsd,.2);assert.equal(recovered.cashFlowAt,NOW+60_000);
  assert.equal(calls,3);reader.stop();
});
