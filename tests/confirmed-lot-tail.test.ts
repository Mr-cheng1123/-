import test from 'node:test';
import assert from 'node:assert/strict';
import {lotTailFixture} from './confirmed-lot-tail-fixture.js';
import {assessBestOppositeProfitExit,assessConfirmedLotTailProfitExit} from '../src/core/profit-exit.js';
import {assessConfirmedLotTailFundingExit} from '../src/core/confirmed-lot-tail-funding.js';
import {FundingExitStabilityTracker} from '../src/core/funding-exit-stability.js';
import {planConfirmedLotTailRestoration} from '../src/core/confirmed-lot-tail.js';

function fundingTailFixture(samples=5,paymentDelayMs=120_000){
  const f=lotTailFixture(),tracker=new FundingExitStabilityTracker();let currentAt=f.now;
  f.p.openedAt=f.now-600_000;f.p.closeRequestedAt=f.now-250_000;
  f.parent.createdAt=f.now-249_900;f.parent.result!.timestamp=f.now-249_800;
  f.parent.makerReduction!.deadlineAt=f.now-244_900;
  f.long.bids[0].price=.03;f.long.asks[0].price=.03001;f.p.long.markPrice=.03;
  const payAt=f.now+paymentDelayMs;
  const update=(at:number,longRate=.01)=>{currentAt=at;
    for(const book of [f.long,f.short]){book.timestamp=at;book.observedAt=at;book.fundingObservedAt=at;
      book.takerFeeAt=at;book.makerFeeAt=at;book.markPrice=.03;book.intervalHours=1;book.nextFundingTime=payAt;
      book.fundingRate=book.exchange==='gate'?longRate:0;}
    for(const leg of [f.p.long,f.p.short]){leg.fundingObservedSince=f.p.openedAt;leg.fundingObservedAt=at;}
  };
  const assessment=(longReduction=10,shortReduction=4,requireNativeFees=true)=>
    assessConfirmedLotTailFundingExit(f.p,f.long,f.short,f.config,currentAt,longReduction,shortReduction,requireNativeFees);
  for(const offset of [0,45_000,90_000,135_000,180_000].slice(5-samples)){
    update(f.now-180_000+offset);tracker.evaluate(f.p,f.long,f.short,assessment(),f.config,currentAt);
  }
  update(f.now);
  const plan=(requireNativeFees=true)=>planConfirmedLotTailRestoration({position:f.p,parent:f.parent,orders:f.orders,
    long:f.long,short:f.short,config:f.config,now:currentAt,requireNativeFees,
    fundingExitQualified:(value,long,short,at)=>tracker.evaluate(f.p,long,short,value,f.config,at).passes});
  return {...f,tracker,update,assessment,plan};
}

test('a real six-coin tail proposes only four additional finer Maker coins, then ten peer coins after actual confirmation',()=>{
  const f=lotTailFixture(),original=structuredClone(f.parent),first=f.plan();
  assert.equal(assessBestOppositeProfitExit(f.p,f.long,f.short,f.config,f.now),undefined,'ordinary joint exits still reject the real mismatch');
  assert.equal(first.status,'augment-maker');assert.equal(first.augmentationQuantity,4);assert.equal(first.confirmedBudget,6);assert.equal(first.targetQuantity,3660);
  assert.equal(first.peerReductionQuantity,10);assert.equal(first.makerLeg,'short');assert.equal(first.makerLimitPrice,.03);
  f.augmentation(4,4);const second=f.plan();assert.equal(second.status,'reduce-peer');assert.equal(second.confirmedBudget,10);assert.equal(second.peerReductionQuantity,10);
  f.peer();assert.equal(f.plan().status,'matched');assert.equal(f.p.long.quantity,3660);assert.equal(f.p.short.quantity,3660);assert.deepEqual(f.parent,original);
});

test('a planned four-coin request and its ACK never create a ten-coin hedge budget',()=>{
  const f=lotTailFixture(),journal=f.augmentation(4,0);journal.result!.status='unknown';journal.makerReduction!.activity='active';journal.makerReduction!.bookedExecution=false;
  assert.equal(f.plan().status,'waiting');assert.equal(f.p.short.quantity,3664);assert.equal(f.p.long.quantity,3670);
});

test('a real terminal two-coin partial fill allows only the remaining two after a renewed profitable signal',()=>{
  const f=lotTailFixture();f.augmentation(4,2);const plan=f.plan();
  assert.equal(plan.status,'augment-maker');assert.equal(plan.confirmedBudget,8);assert.equal(plan.augmentationQuantity,2);assert.equal(plan.peerReductionQuantity,10);
  f.long.bids[0].price=.029;f.long.asks[0].price=.02901;assert.equal(f.plan().status,'waiting','lost profit stops new finer reduction');
});

test('loss of future profit cannot withdraw an already complete ten-coin real peer budget',()=>{
  const f=lotTailFixture();f.augmentation(4,4);f.long.bids[0].price=.029;f.long.asks[0].price=.02901;
  delete f.short.takerFeeRate;assert.equal(f.plan().status,'reduce-peer','only the confirmed excess is reduced, without a new common batch');
});

test('the scoped signal uses both unequal actual quantities and never a trimmed imaginary hedge',()=>{
  const f=lotTailFixture(),before=structuredClone(f.p),profit=assessConfirmedLotTailProfitExit(f.p,f.long,f.short,f.config,f.now)!;
  assert.equal(profit.longQuantity,3670);assert.equal(profit.shortQuantity,3664);assert.equal(profit.valuation,'actual-unequal-position-estimate');
  const expected=3670*(.031-.03)+3664*(.03-.03001)-.2-(3670*.031+3664*.03001)*.0005;
  assert.ok(Math.abs(profit.netPnlUsd-expected)<1e-10);assert.deepEqual(f.p,before);
});

test('unknown native fees, unrecorded due funding and absent frozen principal deny the new augmentation',()=>{
  for(const scenario of ['fee','funding','principal'] as const){const f=lotTailFixture();
    if(scenario==='fee')delete f.short.takerFeeRate;
    else if(scenario==='principal')delete f.p.profitExitNotionalUsd;
    else {f.p.profitExitPolicy!.fundingChecks=[{exchange:'bybit',timestamp:f.now-500}];delete f.p.short.lastFundingAt;f.p.short.fundingObservedAt=f.now-600;}
    assert.equal(f.plan().status,'waiting',scenario);
  }
});

test('an unknown result, unbooked cash, mismatched native identity or budget disagreement cannot authorize repair',()=>{
  for(const scenario of ['unknown','fee','id','budget','step','duplicate'] as const){const f=lotTailFixture();
    if(scenario==='unknown')f.parent.result!.status='unknown';
    else if(scenario==='fee')f.parent.executionEvidence!.bookedFeeUsd=NaN;
    else if(scenario==='id')f.parent.result!.clientOrderId='OTHER';
    else if(scenario==='budget')f.p.long.quantity+=10;
    else if(scenario==='step')f.short.quantityStep=2;
    else f.orders.push(structuredClone(f.parent));
    assert.ok(['blocked','waiting'].includes(f.plan().status),scenario);
  }
});

test('zero or insufficient legal peer capacity never changes the true confirmed budget or expands the extra Maker lot',()=>{
  const f=lotTailFixture();f.augmentation(4,4);f.long.bids[0].quantity=5;const plan=f.plan();
  assert.equal(plan.status,'waiting');assert.equal(plan.confirmedBudget,10);assert.equal(f.p.short.quantity,3660);assert.equal(f.p.long.quantity,3670);
});

test('restoration rejects a forged aggregate parent list, changed finer metadata and incomplete recorded cash',()=>{
  for(const scenario of ['cash','step','parent-list','nested-parent'] as const){const f=lotTailFixture();
    if(scenario==='cash'){f.augmentation(4,4);f.p.realizedSpreadPnlUsd=NaN;}
    else if(scenario==='step')f.augmentation(4,4).makerReduction!.peerQuantityStep=1;
    else if(scenario==='parent-list'){f.augmentation(4,4);f.peer().executionEvidence!.makerCloseLotTailParentClientIds=[f.parent.request.clientOrderId];}
    else f.parent.makerReduction!.lotTailOriginalParentClientId='OTHER-ORIGINAL';
    assert.equal(f.plan().status,'blocked',scenario);
  }
});

test('reference discovery can flag an unequal candidate without granting the actual planner missing native fee permission',()=>{
  const f=lotTailFixture();delete f.short.takerFeeRate;delete f.long.takerFeeRate;
  assert.ok(assessConfirmedLotTailProfitExit(f.p,f.long,f.short,f.config,f.now,false));
  assert.equal(assessConfirmedLotTailProfitExit(f.p,f.long,f.short,f.config,f.now),undefined);
  assert.equal(f.plan().status,'waiting');assert.equal(f.orders.length,1);
});

test('a zero common remainder cannot create a finer reduction that the two-positive-row account protocol cannot verify',()=>{
  const f=lotTailFixture();f.p.long.quantity=10;f.p.short.quantity=4;
  const before=structuredClone(f.p),plan=f.plan();assert.equal(plan.status,'blocked');
  assert.equal(plan.augmentationQuantity,undefined);assert.equal(plan.peerReductionQuantity,undefined);
  assert.equal(f.orders.length,1);assert.deepEqual(f.p,before);
});

test('a stale book waits for refresh without disguising changed contract metadata or invalid original cash',()=>{
  const fresh=lotTailFixture();assert.equal(fresh.plan().status,'augment-maker');
  const scenarios=[
    {name:'stale-book',status:'waiting',mutate:(_f:ReturnType<typeof lotTailFixture>)=>{}},
    {name:'changed-finer-step',status:'blocked',mutate:(f:ReturnType<typeof lotTailFixture>)=>{f.short.quantityStep=2;}},
    {name:'missing-peer-step',status:'blocked',mutate:(f:ReturnType<typeof lotTailFixture>)=>{f.long.quantityStep=NaN;}},
    {name:'foreign-symbol',status:'blocked',mutate:(f:ReturnType<typeof lotTailFixture>)=>{f.long.symbol='OTHER/USDT:USDT';}},
    {name:'invalid-position-cash',status:'blocked',mutate:(f:ReturnType<typeof lotTailFixture>)=>{f.p.feesUsd=NaN;}},
    {name:'unbooked-original-fee',status:'blocked',mutate:(f:ReturnType<typeof lotTailFixture>)=>{f.parent.executionEvidence!.bookedFeeUsd=NaN;}},
    {name:'inconsistent-confirmed-budget',status:'blocked',mutate:(f:ReturnType<typeof lotTailFixture>)=>{f.p.long.quantity+=10;}},
  ];
  for(const scenario of scenarios){const f=lotTailFixture();f.long.bookTransport='websocket';
    f.long.timestamp=f.now-2500;f.long.observedAt=f.now-2500;scenario.mutate(f);
    const position=structuredClone(f.p),orders=structuredClone(f.orders),plan=f.plan();
    assert.equal(plan.status,scenario.status,scenario.name);assert.equal(plan.augmentationQuantity,undefined,scenario.name);
    assert.equal(plan.peerReductionQuantity,undefined,scenario.name);assert.deepEqual(f.p,position);assert.deepEqual(f.orders,orders);
  }
});

test('a nonprofitable unequal tail needs five real funding observations spanning three minutes before its exact minimum reduction',()=>{
  for(const samples of [0,1,4,5]){const f=fundingTailFixture(samples),before=structuredClone(f.p),orders=structuredClone(f.orders),plan=f.plan();
    assert.equal(plan.status,samples===5?'augment-maker':'waiting',`independent funding samples ${samples}`);
    assert.deepEqual(f.p,before);assert.deepEqual(f.orders,orders);
    if(samples!==5){assert.equal(plan.augmentationQuantity,undefined);continue;}
    assert.equal(plan.exitSignal,'funding-loss');assert.equal(plan.augmentationQuantity,4);assert.equal(plan.peerReductionQuantity,10);
    assert.equal(plan.confirmedBudget,6);assert.equal(plan.targetQuantity,3660);assert.ok(plan.profit!.netPnlUsd<0);
    assert.ok(Math.abs(plan.funding!.expectedFundingUsd+3670*.03*.01)<1e-12,'the tracker assessment retains both complete actual holdings');
    assert.ok(Math.abs(plan.funding!.fundingLossExit!.expectedFundingLossUsd-10*.03*.01)<1e-12,'the action avoids only Gate ten funding, never imaginary equal quantities');
    assert.equal(plan.funding!.fundingLossExit!.paymentWindowOpen,true);
  }
});

test('a mature tail funding signal still waits outside the payment window, on rate reversal or missing actual fees',()=>{
  const distant=fundingTailFixture(5,600_000);assert.equal(distant.plan().status,'waiting');
  assert.equal(distant.assessment()!.fundingLossExit!.paymentWindowOpen,false);
  const reversed=fundingTailFixture();assert.equal(reversed.plan().status,'augment-maker');
  reversed.update(reversed.now+1,0);assert.equal(reversed.plan().status,'waiting');
  for(const missing of ['maker','long-taker','short-taker'] as const){const f=fundingTailFixture();
    if(missing==='maker')delete f.short.makerFeeRate;
    else if(missing==='long-taker')delete f.long.takerFeeRate;
    else delete f.short.takerFeeRate;
    assert.equal(f.plan().status,'waiting',missing);assert.equal(f.orders.length,1);
    assert.equal(f.plan(false).status,'augment-maker',`${missing} may discover a reference candidate only`);
    assert.equal(f.plan().status,'waiting',`${missing} the same reference observation grants no actual native permit`);
  }
  for(const principal of [undefined,NaN,0]){const f=fundingTailFixture();f.p.profitExitNotionalUsd=principal;
    assert.equal(f.plan().status,'waiting',`original fixed principal ${principal}`);
    assert.equal(f.plan(false).status,'waiting','reference funding cannot replace a missing or invalid frozen original principal');
    assert.equal(f.orders.length,1);assert.equal(f.p.long.quantity,3670);assert.equal(f.p.short.quantity,3664);
  }
});

test('partial additional funding-loss cash grants only the remaining fine amount, while full four cash makes peer ten independent of the signal',()=>{
  const partial=fundingTailFixture(),newTwo=partial.augmentation(4,2);
  partial.p.short.feesUsd+=newTwo.result!.feeUsd;partial.p.feesUsd+=newTwo.result!.feeUsd;
  const ready=partial.plan();assert.equal(ready.status,'augment-maker');assert.equal(ready.augmentationQuantity,2);
  assert.equal(ready.confirmedBudget,8);assert.equal(ready.peerReductionQuantity,10);assert.equal(ready.exitSignal,'funding-loss');
  partial.update(partial.now+1,0);assert.equal(partial.plan().status,'waiting','two confirmed coins cannot authorize the still-new remaining two after rates recover');
  const full=fundingTailFixture(),newFour=full.augmentation(4,4);
  full.p.short.feesUsd+=newFour.result!.feeUsd;full.p.feesUsd+=newFour.result!.feeUsd;
  full.update(full.now+1,0);delete full.long.takerFeeRate;delete full.short.takerFeeRate;delete full.short.makerFeeRate;
  const peer=full.plan();assert.equal(peer.status,'reduce-peer');assert.equal(peer.confirmedBudget,10);assert.equal(peer.peerReductionQuantity,10);
  assert.equal(peer.augmentationQuantity,undefined);assert.equal(full.p.long.quantity,3670);assert.equal(full.p.short.quantity,3660);
});
