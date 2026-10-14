import test from 'node:test';
import assert from 'node:assert/strict';
import { readFundingLedger } from '../src/adapters/funding-ledger.js';
const market={id:'BTCUSDT',symbol:'BTC/USDT:USDT',base:'BTC',swap:true,linear:true,settle:'USDT'};
const now=Date.now(),row=(id:string,changes:any={})=>({billId:id,symbol:'BTCUSDT',businessType:'contract_settle_fee',coin:'USDT',amount:'1',fee:'0',cTime:String(now-100),...changes});
const response=(bills:any[],endId?:string)=>({code:'00000',data:{bills,endId}});
const client=(fn:(p:any)=>Promise<any>)=>({markets:{[market.symbol]:market},privateMixGetV2MixAccountBill:fn});
test('Bitget funding ledger keeps signed receipts/payments and excludes non-funding/other-currency bills',async()=>{
  const rows=await readFundingLedger(client(async p=>{
    assert.equal(p.productType,'USDT-FUTURES');assert.equal(p.businessType,'contract_settle_fee');
    return response([row('a',{amount:'-2'}),row('b',{amount:'3'}),row('c',{businessType:'open_long',amount:'999'}),row('d',{coin:'USDC',amount:'999'})]);
  }),'bitget',now-1000,now);
  assert.deepEqual(rows.map(x=>x.amountUsd),[-2,3]);assert.ok(rows.every(x=>x.base==='BTC'));
});
test('Bitget bills paginate fixed 30-day windows, deduplicate overlap and follow endId',async()=>{
  const start=now-31*86400000,month=30*86400000;let calls=0;
  const first=Array.from({length:100},(_,i)=>row(String(200-i),{cTime:String(start+100)}));
  const rows=await readFundingLedger(client(async p=>{
    calls++;assert.ok(Number(p.endTime)-Number(p.startTime)<month);assert.equal(p.limit,'100');
    if(calls===1)return response(first,'101');
    if(calls===2){assert.equal(p.idLessThan,'101');return response([first[99],row('100',{cTime:String(start+101)})],'100');}
    assert.equal(Number(p.startTime),start+month);assert.equal(p.idLessThan,undefined);return response([row('99')]);
  }),'bitget',start,now);
  assert.equal(calls,3);assert.equal(rows.length,102);
});
test('Bitget funding pagination rejects cycles, conflicting invoices, unknown symbols and unexpected fees',async()=>{
  let page=0;const full=Array.from({length:100},(_,i)=>row(String(i)));
  await assert.rejects(readFundingLedger(client(async()=>response(full,++page%2?'100':'200')),'bitget',now-1000,now),/did not advance/);
  for(const bills of [[row('same'),row('same',{amount:'2'})],[row('bad',{symbol:'UNKNOWN'})],[row('bad',{fee:'-.01'})],[row('bad',{amount:'invalid'})]]){
    await assert.rejects(readFundingLedger(client(async()=>response(bills)),'bitget',now-1000,now),/duplicate|identify|unexpected fee|invalid funding/);
  }
});
test('Bitget does not silently truncate funding history beyond its 90-day API retention',async()=>{
  let calls=0;await assert.rejects(readFundingLedger(client(async()=>{calls++;return response([]);}),'bitget',now-91*86400000,now),/90 days/);assert.equal(calls,0);
});
