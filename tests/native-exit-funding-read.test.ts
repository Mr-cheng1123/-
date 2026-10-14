import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import type {FundingPayment,Position} from '../src/shared/types.js';
import {assessBestOppositeProfitExit} from '../src/core/profit-exit.js';
import {fixture,completeKnownTail,extraUnknown,NOW,base,symbol,type Internal} from './native-exit-read-fixture.js';

type FundingInternal=Internal&{accrueLiveFunding():Promise<void>};
async function setup(t:TestContext,grant=true){
  const f=fixture(t,{makerExchange:'bitget',peerExchange:'gate'});
  completeKnownTail(f);
  f.unknown.executionEvidence!.bookedFeeUsd=0;
  for(const order of f.store.data.orders.filter(o=>!o.request.reduceOnly&&o.result!.filledQuantity>0))
    order.execution={bookObservedAt:order.createdAt,quoteAgeMs:0,bookTransport:'websocket',confirmedAt:order.result!.timestamp};
  if(grant)await f.grant();
  f.advance(62_000);
  for(const q of f.quotes.values())Object.assign(q,{timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now(),
    intervalHours:1,nextFundingTime:NOW+3_600_000,takerFeeAt:Date.now(),makerFeeAt:Date.now()});
  const payment:FundingPayment={id:'gate-real-native-bill',base,symbol,timestamp:NOW+1,amountUsd:-.0175};
  f.adapters.find(a=>a.id==='gate')!.fetchFundingPayments=async()=>[structuredClone(payment)];
  return {...f,payment,internal:f.engine as unknown as FundingInternal};
}
test('native recovery consumes a real unique-contract bill and completes the actual read window without resolving the old IOC',async t=>{
  const f=await setup(t),originalOrders=structuredClone(f.store.data.orders),fees=f.p.feesUsd,realized=f.p.realizedSpreadPnlUsd,
    quantities=[f.p.long.quantity,f.p.short.quantity],funding=f.p.fundingUsd;
  assert.equal(assessBestOppositeProfitExit(f.internal.economicsPosition(f.p),f.quotes.get('bitget'),f.quotes.get('gate'),f.engine.config,Date.now()),undefined);
  await f.internal.accrueLiveFunding();
  assert.equal(f.p.fundingUsd,funding+f.payment.amountUsd);
  assert.equal(f.p.short.lastFundingAt,f.payment.timestamp);
  assert.equal(f.p.short.fundingObservedAt,Date.now());
  assert.equal(f.p.short.fundingObservedSince,f.p.openedAt);
  assert.deepEqual(f.store.data.fundingSeen,['gate:'+f.payment.id]);
  assert.deepEqual(f.store.data.orders,originalOrders);
  assert.equal(f.p.feesUsd,fees);assert.equal(f.p.realizedSpreadPnlUsd,realized);
  assert.deepEqual([f.p.long.quantity,f.p.short.quantity],quantities);
  assert.equal(f.unknown.result!.status,'unknown');
  assert.ok(assessBestOppositeProfitExit(f.internal.economicsPosition(f.p),f.quotes.get('bitget'),f.quotes.get('gate'),f.engine.config,Date.now()));
  await f.internal.accrueLiveFunding();
  assert.equal(f.p.fundingUsd,funding+f.payment.amountUsd);assert.equal(f.store.data.fundingSeen.length,1);
});
for(const changed of ['ungranted','kill','config','openedAt','policy','new-unknown'] as const){
  test(`funding read leaves the old cash unconsumed when native recovery is ${changed}`,async t=>{
    const f=await setup(t,changed!=='ungranted');
    if(changed==='kill')f.store.data.killSwitch=true;
    if(changed==='config')f.store.data.config={...f.engine.config};
    if(changed==='openedAt')f.p.openedAt-=1;
    if(changed==='policy')f.p.profitExitPolicy={firstFundingTime:NOW,earliestExitAt:NOW,minCombinedNetUsd:0,minSpreadNetUsd:0,fundingChecks:[]};
    if(changed==='new-unknown')extraUnknown(f,'position');
    const funding=f.p.fundingUsd,orders=structuredClone(f.store.data.orders);
    await f.internal.accrueLiveFunding();
    assert.equal(f.p.fundingUsd,funding);assert.deepEqual(f.store.data.fundingSeen,[]);
    assert.equal(f.p.short.fundingObservedAt,undefined);assert.equal(f.p.short.fundingObservedSince,undefined);
    assert.deepEqual(f.store.data.orders,orders);
  });
}
test('a read failure cannot manufacture complete funding evidence or zero cash',async t=>{
  const f=await setup(t),funding=f.p.fundingUsd;
  f.adapters.find(a=>a.id==='gate')!.fetchFundingPayments=async()=>{throw new Error('memory native read unavailable');};
  await f.internal.accrueLiveFunding();
  assert.equal(f.p.fundingUsd,funding);assert.deepEqual(f.store.data.fundingSeen,[]);
  assert.equal(f.p.short.fundingObservedAt,undefined);assert.equal(f.p.short.fundingObservedSince,undefined);
});
test('a native bill quantity beyond the continuous ownership bounds stays unconsumed',async t=>{
  const f=await setup(t),funding=f.p.fundingUsd;f.payment.quantity=f.p.short.quantity+1;
  await f.internal.accrueLiveFunding();
  assert.equal(f.p.fundingUsd,funding);assert.deepEqual(f.store.data.fundingSeen,[]);
  assert.equal(f.p.short.fundingObservedAt,undefined);
});

test('quantity-bearing native bills complete the actual funding window once per ID and restore the original profit candidate',async t=>{
  const f=await setup(t),orders=structuredClone(f.store.data.orders),fees=f.p.feesUsd,realized=f.p.realizedSpreadPnlUsd,
    transfer=f.p.transferCostUsd,quantities=[f.p.long.quantity,f.p.short.quantity],funding=f.p.fundingUsd;
  const payments:FundingPayment[]=[
    {...f.payment,id:'native-bill-positive',quantity:95,side:'short',amountUsd:.03307629},
    {...f.payment,id:'native-bill-zero',timestamp:f.payment.timestamp+1,quantity:93,side:'short',amountUsd:0},
    {...f.payment,id:'native-bill-negative',timestamp:f.payment.timestamp+2,quantity:90,side:'short',amountUsd:-.01124435},
  ];
  let reads=0;
  f.adapters.find(a=>a.id==='gate')!.fetchFundingPayments=async()=>{reads++;return structuredClone([...payments,payments[0]]);};
  assert.equal(assessBestOppositeProfitExit(f.internal.economicsPosition(f.p),f.quotes.get('bitget'),f.quotes.get('gate'),f.engine.config,Date.now()),undefined);
  await f.internal.accrueLiveFunding();
  assert.equal(reads,1);assert.ok(Math.abs(f.p.fundingUsd-(funding+.03307629-.01124435))<1e-12);
  assert.equal(f.p.short.lastFundingAt,payments[2].timestamp);
  assert.equal(f.p.short.fundingObservedSince,f.p.openedAt);assert.equal(f.p.short.fundingObservedAt,Date.now());
  assert.deepEqual(f.store.data.fundingSeen,payments.map(p=>'gate:'+p.id));
  assert.deepEqual(f.p.fundingEvents,payments.map(p=>'gate:'+p.id));
  assert.deepEqual(f.store.data.orders,orders);assert.equal(f.p.feesUsd,fees);assert.equal(f.p.realizedSpreadPnlUsd,realized);
  assert.equal(f.p.transferCostUsd,transfer);assert.deepEqual([f.p.long.quantity,f.p.short.quantity],quantities);
  assert.equal(f.unknown.result!.status,'unknown');assert.equal(f.unknown.result!.filledQuantity,0);
  assert.equal(f.unknown.result!.averagePrice,0);assert.equal(f.unknown.result!.feeUsd,0);
  assert.ok(assessBestOppositeProfitExit(f.internal.economicsPosition(f.p),f.quotes.get('bitget'),f.quotes.get('gate'),f.engine.config,Date.now()));
  const afterFirst={funding:f.p.fundingUsd,shortFunding:f.p.short.fundingUsd};
  f.advance(62_000);
  for(const q of f.quotes.values())Object.assign(q,{timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now(),
    takerFeeAt:Date.now(),makerFeeAt:Date.now()});
  await f.internal.accrueLiveFunding();
  assert.equal(reads,2,'a second real read, rather than retry throttling, proves native IDs are consumed once');
  assert.deepEqual({funding:f.p.fundingUsd,shortFunding:f.p.short.fundingUsd},afterFirst);
  assert.deepEqual(f.store.data.fundingSeen,payments.map(p=>'gate:'+p.id));
  assert.deepEqual(f.p.fundingEvents,payments.map(p=>'gate:'+p.id));assert.deepEqual(f.store.data.orders,orders);
  assert.equal(f.p.short.fundingObservedAt,Date.now());
});

test('an out-of-bounds sibling bill prevents complete funding evidence even when other exact IDs were consumed',async t=>{
  const f=await setup(t),orders=structuredClone(f.store.data.orders),funding=f.p.fundingUsd;
  const valid:FundingPayment={...f.payment,id:'owned-native-bill',quantity:95,side:'short',amountUsd:.01};
  const invalid:FundingPayment={...f.payment,id:'unowned-native-bill',quantity:96,side:'short',amountUsd:.02};
  f.adapters.find(a=>a.id==='gate')!.fetchFundingPayments=async()=>structuredClone([valid,invalid]);
  await f.internal.accrueLiveFunding();
  assert.equal(f.p.fundingUsd,funding+.01);assert.deepEqual(f.store.data.fundingSeen,['gate:'+valid.id]);
  assert.equal(f.p.short.fundingObservedSince,undefined);assert.equal(f.p.short.fundingObservedAt,undefined);
  assert.equal(assessBestOppositeProfitExit(f.internal.economicsPosition(f.p),f.quotes.get('bitget'),f.quotes.get('gate'),f.engine.config,Date.now()),undefined);
  assert.deepEqual(f.store.data.orders,orders);assert.equal(f.unknown.result!.status,'unknown');
});
test('all lifecycle records participate in ambiguity checks even when excluded from the recent query list',async t=>{
  const f=await setup(t),funding=f.p.fundingUsd;
  const other:Position=structuredClone(f.p);other.id='older-incompatible-cash-owner';other.status='closed';
  other.closedAt=f.payment.timestamp;other.long.quantity=0;other.short.quantity=0;delete other.nativeExitRecoveryAudit;
  f.store.data.positions.push(other);
  await f.internal.accrueLiveFunding();
  assert.equal(f.p.fundingUsd,funding);assert.deepEqual(f.store.data.fundingSeen,[]);
  assert.equal(f.p.short.fundingObservedAt,undefined);
});
