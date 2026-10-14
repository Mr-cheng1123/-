import test from 'node:test';
import assert from 'node:assert/strict';
import {findFundingOwner,fundingRecordsForRead} from '../src/core/funding-attribution.js';
import type {FundingPayment,JournalOrder,Position} from '../src/shared/types.js';

const openedAt=1_790_900_000_000,settledAt=openedAt+3_600_000;
function position(id='one'):Position {
  return {id,base:'ONE',mode:'live',status:'attention',openedAt,plannedExitAt:settledAt,holdMode:'adaptive',
    long:{exchange:'gate',symbol:'ONE/USDT:USDT',side:'long',quantity:46600,entryPrice:.002,markPrice:.002,feesUsd:.05,liquidationDistancePct:null},
    short:{exchange:'bitget',symbol:'ONE/USDT:USDT',side:'short',quantity:0,entryPrice:0,markPrice:.002,feesUsd:0,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:.05,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:-.05,deltaUsd:93.2,fundingEvents:[],riskReasons:[]};
}
const receipt=(changes:Partial<FundingPayment>={}):FundingPayment=>({id:'fund',base:'ONE',timestamp:settledAt,amountUsd:.2,...changes});
function order(p:Position,reduceOnly=false,changes:Partial<JournalOrder['result']>={},at=openedAt+1000):JournalOrder {
  const request={base:p.base,symbol:p.long.symbol,side:reduceOnly?'sell' as const:'buy' as const,reduceOnly,quantity:100,limitPrice:.002,clientOrderId:`test-${at}`};
  return {positionId:p.id,exchange:'gate',request,createdAt:at,result:{id:request.clientOrderId,clientOrderId:request.clientOrderId,status:'filled',filledQuantity:100,averagePrice:.002,feeUsd:.001,timestamp:at,...changes}};
}

test('an unfilled second leg never receives same-ticker external funding while the real held leg can',()=>{
  const p=position();assert.equal(findFundingOwner([p],[],'bitget',receipt()),undefined);
  assert.equal(findFundingOwner([p],[],'gate',receipt())?.leg,p.long);
});

test('the confirmed quantity at funding time remains attributable after a later full close',()=>{
  const p=position();p.long.quantity=0;p.status='closed';p.closedAt=settledAt+10000;
  const rows=[order(p),order(p,true,{},settledAt+1000)];
  assert.equal(findFundingOwner([p],rows,'gate',receipt({quantity:100}))?.position,p);
  assert.equal(findFundingOwner([p],rows,'gate',receipt({timestamp:p.closedAt+1})),undefined);
});

test('supplementary and partial closing quantities are reconstructed without attributing an external add-on',()=>{
  const p=position(),rows=[order(p,false,{status:'partial',filledQuantity:80}),order(p,false,{status:'partial',filledQuantity:20},openedAt+2000),order(p,true,{status:'partial',filledQuantity:30},openedAt+3000)];
  assert.equal(findFundingOwner([p],rows,'gate',receipt({quantity:70}))?.position,p);
  assert.equal(findFundingOwner([p],rows,'gate',receipt({quantity:100})),undefined);
});

test('unconfirmed, delayed cumulative and malformed results keep receipts unconsumed for a complete later GET',()=>{
  const p=position(),row=order(p,false,{status:'unknown'}),f=receipt({quantity:100});
  assert.equal(findFundingOwner([p],[row],'gate',f),undefined);
  row.result!.status='filled';assert.equal(findFundingOwner([p],[row],'gate',f)?.position,p);
  row.result!.timestamp=settledAt+1;assert.equal(findFundingOwner([p],[row],'gate',f),undefined);
  row.result!.timestamp=openedAt+1000;row.result!.filledQuantity=NaN;assert.equal(findFundingOwner([p],[row],'gate',f),undefined);
});

test('same-symbol overlapping records remain ambiguous unless native settlement evidence identifies one',()=>{
  const first=position('first'),second=position('second');second.long.quantity=100;
  assert.equal(findFundingOwner([first,second],[],'gate',receipt()),undefined);
  assert.equal(findFundingOwner([first,second],[],'gate',receipt({quantity:100}))?.position,second);
});

test('separate cycles, exact symbols and native side preserve receipt ownership',()=>{
  const old=position('old'),next=position('next');old.status='closed';old.closedAt=settledAt-10;next.openedAt=settledAt-5;
  assert.equal(findFundingOwner([old,next],[],'gate',receipt())?.position,next);
  assert.equal(findFundingOwner([next],[],'gate',receipt({side:'short'})),undefined);
  assert.equal(findFundingOwner([next],[],'gate',receipt({symbol:'1000ONE/USDT:USDT'})),undefined);
  next.accountClosure={confirmedAt:settledAt+5,reason:'external cycle',historicalOrdersPending:false};
  assert.equal(findFundingOwner([next],[],'gate',receipt()),undefined);
});

test('a late invoice from an archived cycle requires its confirmed historical fills and cannot extend past the flat proof',()=>{
  const archived=position('archived');archived.accountClosure={confirmedAt:settledAt+1000,reason:'independent flat account',historicalOrdersPending:false};
  const rows=[order(archived)],fund=receipt({symbol:archived.long.symbol,side:'long',quantity:100});
  assert.equal(findFundingOwner([archived],[],'gate',fund),undefined,'historical displayed quantity alone is insufficient');
  assert.equal(findFundingOwner([archived],rows,'gate',fund)?.position,archived);
  assert.equal(findFundingOwner([archived],rows,'gate',receipt({...fund,timestamp:settledAt+1001})),undefined);
  archived.closedAt=settledAt-1;assert.equal(findFundingOwner([archived],rows,'gate',fund),undefined,'a confirmed order close is a tighter boundary');
});

test('archived late funding excludes already-reduced exposure and keeps the following cycle separate',()=>{
  const old=position('archived'),next=position('reopened');old.accountClosure={confirmedAt:settledAt-100,reason:'flat',historicalOrdersPending:false};
  next.openedAt=settledAt-50;next.long.quantity=100;
  const rows=[order(old)];
  assert.equal(findFundingOwner([old,next],rows,'gate',receipt({timestamp:settledAt-200,quantity:100}))?.position,old);
  assert.equal(findFundingOwner([old,next],rows,'gate',receipt({quantity:100}))?.position,next);
  rows.push(order(old,true,{},settledAt-300));
  assert.equal(findFundingOwner([old,next],rows,'gate',receipt({timestamp:settledAt-200,quantity:100})),undefined);
});

test('only recent closed/archived cycles extend routine funding reads; old archives do not grow the query forever',()=>{
  const recent=position('recent'),old=position('old'),active=position('active');
  recent.accountClosure={confirmedAt:settledAt-1000,reason:'flat',historicalOrdersPending:false};
  old.openedAt=openedAt-4*86_400_000;old.accountClosure={confirmedAt:settledAt-2*86_400_000,reason:'flat',historicalOrdersPending:false};
  assert.deepEqual(fundingRecordsForRead([recent,old,active],settledAt).map(p=>p.id),['recent','active']);
});

test('foreign, unbounded and contradictory terminal receipts cannot claim a funding invoice',()=>{
  const p=position();
  const invalid=[
    order(p,false,{clientOrderId:'another-intent'}),
    order(p,false,{id:''}),
    order(p,false,{filledQuantity:101}),
    order(p,false,{filledQuantity:80}),
    order(p,false,{averagePrice:.0021}),
  ];
  for(const row of invalid){
    const before=structuredClone(row);
    assert.equal(findFundingOwner([p],[row],'gate',receipt({quantity:row.result!.filledQuantity})),undefined);
    assert.deepEqual(row,before,'read-only attribution must not rewrite the original receipt');
  }
  const corrected=order(p);assert.equal(findFundingOwner([p],[corrected],'gate',receipt({quantity:100}))?.position,p);
});

test('a reused native order or duplicated client intent does not double the held funding quantity',()=>{
  const p=position(),first=order(p),second=order(p,false,{},openedAt+2000);
  second.result!.id=first.result!.id;
  assert.equal(findFundingOwner([p],[first,second],'gate',receipt({quantity:200})),undefined);
  second.result!.id='distinct-native';second.request.clientOrderId=first.request.clientOrderId;second.result!.clientOrderId=first.request.clientOrderId;
  assert.equal(findFundingOwner([p],[first,second],'gate',receipt({quantity:200})),undefined);
  second.request.clientOrderId='distinct-client';second.result!.clientOrderId='distinct-client';
  assert.equal(findFundingOwner([p],[first,second],'gate',receipt({quantity:200}))?.position,p);
});

test('native IDs shared across position records leave the invoice unconsumed until the historical identity is resolved',()=>{
  const p=position('owned'),foreign=position('other-cycle');foreign.openedAt=settledAt+1;
  const first=order(p),second=order(foreign,false,{},settledAt+2);second.result!.id=first.result!.id;
  assert.equal(findFundingOwner([p,foreign],[first,second],'gate',receipt({quantity:100})),undefined);
});

test('over-reduction and invalid intent timestamps cannot fabricate an earlier funded holding',()=>{
  const p=position(),initial=order(p),close=order(p,true,{filledQuantity:200},openedAt+2000),reopen=order(p,false,{filledQuantity:200},openedAt+3000);
  close.request.quantity=200;reopen.request.quantity=200;
  assert.equal(findFundingOwner([p],[initial,close,reopen],'gate',receipt({quantity:100})),undefined);
  initial.createdAt=NaN;assert.equal(findFundingOwner([p],[initial],'gate',receipt({quantity:100})),undefined);
});

test('a valid terminal quantity can own funding without inventing an unavailable execution fee',()=>{
  const p=position(),row=order(p,false,{status:'partial',filledQuantity:80,feeUsd:NaN});
  assert.equal(findFundingOwner([p],[row],'gate',receipt({quantity:80}))?.position,p);
  assert.equal(Number.isNaN(row.result!.feeUsd),true);
});

test('a funding receipt needs an explicit native identity and a valid holding window',()=>{
  const p=position(),rows=[order(p)];
  for(const id of ['', '   ', null, {}])
    assert.equal(findFundingOwner([p],rows,'gate',receipt({id:id as string,quantity:100})),undefined);
  p.openedAt=NaN;assert.equal(findFundingOwner([p],rows,'gate',receipt({quantity:100})),undefined);
});
