import test from 'node:test';
import assert from 'node:assert/strict';
import {readFundingLedger} from '../src/adapters/funding-ledger.js';
import type {ExchangeId} from '../src/shared/types.js';

const now=1791086400123;
const market={id:'SIRENUSDT',symbol:'SIREN/USDT:USDT',base:'SIREN',quote:'USDT',settle:'USDT',swap:true,linear:true,contractSize:1};
const client=(extra:Record<string,unknown>)=>({markets:{[market.symbol]:market},...extra});
const row=(id:ExchangeId)=>({
  binance:{symbol:market.id,asset:'USDT',tranId:'invoice',time:now,income:'1'},
  bybit:{symbol:market.id,execId:'invoice',execTime:String(now),execFee:'-1'},
  okx:{instId:market.id,ccy:'USDT',billId:'invoice',ts:String(now),balChg:'1',posBalChg:'0'},
  gate:{contract:market.id,id:'invoice',time:now/1000,change:'1'},
  bitget:{symbol:market.id,coin:'USDT',billId:'invoice',businessType:'contract_settle_fee',cTime:String(now),amount:'1',fee:'0',feeByCoupon:'0'},
}[id] as Record<string,unknown>);
const withRows=(id:ExchangeId,rows:Record<string,unknown>[])=>client({
  [({binance:'fapiPrivateGetIncome',bybit:'privateGetV5ExecutionList',okx:'privateGetAccountBillsArchive',gate:'privateFuturesGetSettleAccountBook',bitget:'privateMixGetV2MixAccountBill'} as const)[id]]:
    async()=>id==='bybit'?{result:{list:rows}}:id==='okx'?{data:rows}:id==='bitget'?{code:'00000',data:{bills:rows}}:rows,
});

test('Gate rounds GET time bounds to seconds but ignores padding invoices before market resolution',async()=>{
  const since=now,until=now+400;
  const rows=[
    {...row('gate'),contract:'DELISTEDUSDT',time:Math.floor(since/1000),change:undefined},
    {...row('gate'),contract:'DELISTEDUSDT',time:Math.ceil(until/1000),change:undefined},
    row('gate'),
  ];
  const payments=await readFundingLedger(client({privateFuturesGetSettleAccountBook:async(params:any)=>{
    assert.equal(params.from,Math.floor(since/1000));assert.equal(params.to,Math.ceil(until/1000));return rows;
  }}),'gate',since,until);
  assert.deepEqual(payments.map(p=>[p.id,p.timestamp,p.amountUsd]),[['gate:SIRENUSDT:invoice',now,1]]);
  await assert.rejects(readFundingLedger(withRows('gate',[{...row('gate'),contract:'DELISTEDUSDT'}]),'gate',since,until),/cannot identify/);
});

test('OKX never invents zero funding cash when both native balance changes are absent',async()=>{
  for(const missing of [undefined,null,'',' ']){
    await assert.rejects(readFundingLedger(withRows('okx',[{...row('okx'),balChg:missing,posBalChg:missing}]),'okx',now-1,now),/invalid funding ledger amount/);
  }
  const payments=await readFundingLedger(withRows('okx',[
    {...row('okx'),billId:'cross',balChg:'-1.25',posBalChg:''},
    {...row('okx'),billId:'isolated',balChg:'0',posBalChg:'2.5'},
    {...row('okx'),billId:'position-only',balChg:undefined,posBalChg:'3'},
    {...row('okx'),billId:'zero',balChg:'0',posBalChg:''},
  ]),'okx',now-1,now);
  assert.deepEqual(payments.map(p=>[p.id,p.amountUsd]),[
    ['okx:SIRENUSDT:cross',-1.25],['okx:SIRENUSDT:isolated',2.5],['okx:SIRENUSDT:position-only',3],['okx:SIRENUSDT:zero',0],
  ]);
});

test('funding cash values do not accept booleans or objects as native zero/one cash',async()=>{
  const cashField={binance:'income',bybit:'execFee',okx:'balChg',gate:'change',bitget:'amount'} as const;
  for(const id of ['binance','bybit','okx','gate','bitget'] as const){
    for(const value of [false,true,[],[1],{}]){
      await assert.rejects(readFundingLedger(withRows(id,[{...row(id),[cashField[id]]:value}]),id,now-1,now),/invalid funding ledger amount/);
    }
  }
  await assert.rejects(readFundingLedger(withRows('okx',[{...row('okx'),balChg:'broken',posBalChg:'2'}]),'okx',now-1,now),/invalid funding ledger amount/);
});

test('funding invoices require native identity and preserve exact legacy IDs for valid receipts',async()=>{
  const idField={binance:'tranId',bybit:'execId',okx:'billId',gate:'id',bitget:'billId'} as const;
  for(const id of ['binance','bybit','okx','gate','bitget'] as const){
    for(const value of [undefined,null,'',' ',{},[],Number.MAX_SAFE_INTEGER+1]){
      await assert.rejects(readFundingLedger(withRows(id,[{...row(id),[idField[id]]:value}]),id,now-1,now),/funding invoice.*ID|missing ID/);
    }
    const exact='98765432109876543210';
    const payments=await readFundingLedger(withRows(id,[{...row(id),[idField[id]]:exact},{...row(id),[idField[id]]:'other'}]),id,now-1,now);
    assert.equal(payments.length,2);
    assert.equal(payments[0].id,`${id}:${market.id}:${exact}`);
    assert.equal(payments[1].id,`${id}:${market.id}:other`);
  }
});

test('native funding timestamps retain venue units rather than guessing a recent settlement',async()=>{
  const timeField={binance:'time',bybit:'execTime',okx:'ts',bitget:'cTime'} as const;
  for(const id of ['binance','bybit','okx','bitget'] as const){
    const payments=await readFundingLedger(withRows(id,[{...row(id),[timeField[id]]:Math.floor(now/1000)}]),id,now-1000,now);
    assert.deepEqual(payments,[],'millisecond fields must not be silently multiplied by 1000');
  }
  for(const id of ['binance','bybit','okx','gate','bitget'] as const){
    const field=id==='gate'?'time':timeField[id];
    await assert.rejects(readFundingLedger(withRows(id,[{...row(id),[field]:false}]),id,now-1000,now),/invalid funding ledger.*time/);
  }
});
