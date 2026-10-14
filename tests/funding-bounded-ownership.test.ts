import test from 'node:test';
import assert from 'node:assert/strict';
import {findFundingOwner} from '../src/core/funding-attribution.js';
import type {FundingPayment,JournalOrder,Position} from '../src/shared/types.js';

const openedAt=1_790_900_000_000,eventAt=openedAt+4*3_600_000;
function fixture(side:'long'|'short'='long'){
  const p:Position={id:'original-cycle',base:'ALT',mode:'live',status:'open',entryPolicy:'aligned',holdMode:'adaptive',
    openedAt,plannedExitAt:eventAt+3_600_000,
    long:{exchange:'gate',symbol:'ALT/USDT:USDT',side:'long',quantity:508,entryPrice:1,markPrice:1,feesUsd:.1,liquidationDistancePct:null},
    short:{exchange:'bitget',symbol:'ALT/USDT:USDT',side:'short',quantity:508,entryPrice:1,markPrice:1,feesUsd:.1,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:.2,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:-.2,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  const leg=p[side],peer=p[side==='long'?'short':'long'];
  function confirmed(which:'long'|'short',client:string,quantity:number,reduceOnly:boolean,at:number):JournalOrder {
    const current=p[which],request={clientOrderId:client,base:p.base,symbol:current.symbol,quantity,limitPrice:1,reduceOnly,
      side:which==='long'?(reduceOnly?'sell' as const:'buy' as const):(reduceOnly?'buy' as const:'sell' as const)};
    return {positionId:p.id,exchange:current.exchange,createdAt:at,request,
      execution:{bookObservedAt:at,quoteAgeMs:0,bookTransport:'rest',confirmedAt:at,confirmationMs:0},
      result:{id:`native-${client}`,clientOrderId:client,status:'filled',filledQuantity:quantity,averagePrice:1,averagePriceVerified:true,feeUsd:.01,timestamp:at}};
  }
  const openings=[confirmed('long','open-long',733,false,openedAt+1000),confirmed('short','open-short',733,false,openedAt+2000)];
  const parent=confirmed(peer.side,'original-maker',225,true,openedAt+3000);parent.request.postOnly=true;
  parent.makerReduction={makerLeg:peer.side,activity:'terminal',bookedExecution:true,deadlineAt:openedAt+4000};
  parent.executionEvidence={version:1,method:'maker',role:'exit',batchId:'original',bookedFeeUsd:parent.result!.feeUsd};
  const knownPeer=confirmed(side,'known-peer',221,true,openedAt+4000);
  knownPeer.executionEvidence={version:1,method:'ioc',role:'exit-tail',batchId:'original',makerCloseParentClientId:parent.request.clientOrderId,bookedFeeUsd:.01};
  const unknown:JournalOrder={positionId:p.id,exchange:leg.exchange,createdAt:openedAt+5000,
    request:{clientOrderId:'original-unknown',base:p.base,symbol:leg.symbol,side:side==='long'?'sell':'buy',quantity:4,limitPrice:1,reduceOnly:true},
    result:{id:'',clientOrderId:'original-unknown',status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:openedAt+5000},
    executionEvidence:{version:1,method:'ioc',role:'exit-tail',batchId:'original',makerCloseParentClientId:parent.request.clientOrderId,bookedFeeUsd:0}};
  const newPeer=confirmed(side,'new-independent-peer',4,true,openedAt+6000);
  newPeer.executionEvidence={version:1,method:'ioc',role:'exit-tail',batchId:'new',makerCloseParentClientId:parent.request.clientOrderId,bookedFeeUsd:.01};
  const orders=[...openings,parent,knownPeer,unknown,newPeer],positions=[p],authorized=new Set([unknown]);
  const payment:FundingPayment={id:'native-invoice',base:p.base,symbol:leg.symbol,timestamp:eventAt,amountUsd:.02};
  const assess=()=>findFundingOwner(positions,orders,leg.exchange,payment,authorized);
  return {p,leg,peer,openings,parent,knownPeer,unknown,newPeer,orders,positions,authorized,payment,assess,confirmed};
}
type Fixture=ReturnType<typeof fixture>;

for(const side of ['long','short'] as const)for(const cash of [-.02,0,.02])
test(`${side} original unknown reduction bounds uniquely own actual native cash ${cash}`,()=>{
  const f=fixture(side);f.payment.amountUsd=cash;
  const original=structuredClone({positions:f.positions,orders:f.orders,payment:f.payment});
  assert.equal(findFundingOwner(f.positions,f.orders,f.leg.exchange,f.payment),undefined,'the original strict path stays unknown');
  const owner=f.assess();assert.equal(owner?.position,f.p);assert.equal(owner?.leg,f.leg);
  assert.deepEqual(owner?.quantityRange,{minimum:504,maximum:508,unknownClientOrderIds:['original-unknown']});
  assert.deepEqual({positions:f.positions,orders:f.orders,payment:f.payment},original,'ownership never books guessed order cash or changes funding windows');
});

test('native funding quantity inside proven continuous bounds owns only its actual invoice cash',()=>{
  const f=fixture();
  const original=structuredClone({positions:f.positions,orders:f.orders});
  for(const quantity of [504,506,508]){
    f.payment.quantity=quantity;const owner=f.assess();
    assert.equal(owner?.leg,f.leg);assert.deepEqual(owner?.quantityRange,{minimum:504,maximum:508,unknownClientOrderIds:['original-unknown']});
    assert.equal(f.payment.quantity,quantity);
    assert.equal(findFundingOwner(f.positions,f.orders,f.leg.exchange,f.payment),undefined);
  }
  for(const quantity of [0,-1,NaN,Infinity,503,509,512]){f.payment.quantity=quantity;assert.equal(f.assess(),undefined);}
  f.payment.timestamp=f.unknown.createdAt-1;f.payment.quantity=512;
  assert.equal(f.assess()?.leg,f.leg);assert.equal(f.assess()?.quantityRange,undefined,'later unknowns do not rewrite an earlier exact quantity');
  assert.deepEqual({positions:f.positions,orders:f.orders},original);
});

test('bounded native funding quantity uses the existing positive-quantity comparison tolerance',()=>{
  const f=fixture();
  for(const quantity of [504-504e-8/2,508+508e-8/2]){f.payment.quantity=quantity;assert.equal(f.assess()?.leg,f.leg);}
  for(const quantity of [504-504e-8*2,508+508e-8*2]){f.payment.quantity=quantity;assert.equal(f.assess(),undefined);}
});

for(const side of ['long','short'] as const)for(const cash of [-.02,0,.02])
test(`${side} positive native invoice quantity preserves actual cash ${cash} and original unknown identity`,()=>{
  const f=fixture(side);f.payment.quantity=506;f.payment.side=side;f.payment.amountUsd=cash;
  const before=structuredClone({positions:f.positions,orders:f.orders,payment:f.payment});
  const owner=f.assess();assert.equal(owner?.leg,f.leg);assert.equal(owner?.position,f.p);
  assert.deepEqual({positions:f.positions,orders:f.orders,payment:f.payment},before);
  f.authorized.clear();assert.equal(f.assess(),undefined);
  f.authorized.add(structuredClone(f.unknown));assert.equal(f.assess(),undefined);
});

for(const obstruction of ['new-unknown','flat-reopen','unbooked-parent','duplicate-native','wrong-contract','invalid-window'] as const)
test(`quantity-bearing invoice keeps original ${obstruction} blocker`,()=>{
  const f=fixture();f.payment.quantity=506;
  if(obstruction==='new-unknown'){
    const foreign=structuredClone(f.unknown);foreign.request.clientOrderId='new';foreign.result!.clientOrderId='new';f.orders.push(foreign);
  }
  if(obstruction==='flat-reopen'){
    f.unknown.request.quantity=512;f.orders.push(f.confirmed(f.leg.side,'reopen',1000,false,openedAt+7000));
  }
  if(obstruction==='unbooked-parent')f.parent.makerReduction!.bookedExecution=false;
  if(obstruction==='duplicate-native'){
    const other=structuredClone(f.parent);other.request.clientOrderId='other';other.result!.clientOrderId='other';f.orders.push(other);
  }
  if(obstruction==='wrong-contract')f.payment.symbol='OTHER/USDT:USDT';
  if(obstruction==='invalid-window')f.p.openedAt=NaN;
  const before=structuredClone({positions:f.positions,orders:f.orders,payment:f.payment});
  assert.equal(f.assess(),undefined);assert.deepEqual({positions:f.positions,orders:f.orders,payment:f.payment},before);
});

for(const state of ['unknown','zero','closed-overlap','invalid-window','exact-other-owner'] as const)
test(`another compatible ${state} cycle cannot take a quantity-bearing invoice`,()=>{
  const f=fixture(),other=structuredClone(f.p);f.payment.quantity=506;other.id='other-cycle';other[f.leg.side].quantity=506;
  if(state==='unknown'){
    const uncertain=structuredClone(f.unknown);uncertain.positionId=other.id;uncertain.request.clientOrderId='foreign-unknown';
    uncertain.result!.clientOrderId='foreign-unknown';f.orders.push(uncertain);
  }
  if(state==='zero')other[f.leg.side].quantity=0;
  if(state==='closed-overlap'){other.status='closed';other.closedAt=eventAt+1;}
  if(state==='invalid-window')other.openedAt=NaN;
  if(state==='exact-other-owner'){
    const opening=f.confirmed(f.leg.side,'other-exact-open',506,false,openedAt+1000);opening.positionId=other.id;f.orders.push(opening);
    f.payment.quantity=600;opening.request.quantity=600;opening.result!.filledQuantity=600;
  }
  f.positions.push(other);assert.equal(f.assess(),undefined,'a failed bounded candidate cannot hand its cash to another exact owner');
});

test('missing native symbol cannot borrow the bounded ownership capability',()=>{
  const f=fixture();delete f.payment.symbol;assert.equal(f.assess(),undefined);
  f.orders.splice(f.orders.indexOf(f.unknown),1);
  assert.equal(findFundingOwner(f.positions,f.orders,f.leg.exchange,f.payment)?.position,f.p,'the original exact no-symbol behavior remains compatible');
});

test('only selected original ledger objects grant bounded ownership',()=>{
  const f=fixture();f.authorized.clear();assert.equal(f.assess(),undefined);
  f.authorized.add(structuredClone(f.unknown));assert.equal(f.assess(),undefined);
  f.authorized.clear();f.authorized.add(f.unknown);assert.equal(f.assess()?.position,f.p);
});

test('multiple explicitly selected reductions subtract their full possible amounts without guessing fills',()=>{
  const f=fixture(),second=structuredClone(f.unknown);second.request.clientOrderId='other-selected';second.result!.clientOrderId='other-selected';
  second.request.quantity=3;second.createdAt++;f.orders.push(second);
  assert.equal(f.assess(),undefined,'the second unknown has no permission');f.authorized.add(second);
  assert.deepEqual(f.assess()?.quantityRange,{minimum:501,maximum:508,unknownClientOrderIds:['original-unknown','other-selected']});
});

test('a possible full close cannot be revived by a subsequent opening in the same saved record',()=>{
  const f=fixture();f.unknown.request.quantity=512;
  f.orders.push(f.confirmed(f.leg.side,'later-reopen',1000,false,openedAt+7000));
  assert.equal(f.assess(),undefined,'continuous positive exposure is required at every history prefix');
});

for(const quantity of [508,509,512,513,733])test(`full possible unknown reduction ${quantity} cannot prove continuous ownership`,()=>{
  const f=fixture();f.unknown.request.quantity=quantity;assert.equal(f.assess(),undefined);
});

for(const [label,change] of [
  ['unknown opening',(f:Fixture)=>{f.unknown.request.reduceOnly=false;f.unknown.request.side=f.leg.side==='long'?'buy':'sell';}],
  ['PostOnly unknown',(f:Fixture)=>{f.unknown.request.postOnly=true;}],
  ['close-all selector',(f:Fixture)=>{f.unknown.request.closePosition={side:f.leg.side};}],
  ['Maker method',(f:Fixture)=>{f.unknown.executionEvidence!.method='maker';}],
  ['unrelated role',(f:Fixture)=>{f.unknown.executionEvidence!.role='exit';}],
  ['missing parent',(f:Fixture)=>{delete f.unknown.executionEvidence!.makerCloseParentClientId;}],
  ['wrong contract',(f:Fixture)=>{f.unknown.request.symbol='1000ALT/USDT:USDT';}],
  ['wrong base',(f:Fixture)=>{f.unknown.request.base='FOREIGN';}],
  ['wrong side',(f:Fixture)=>{f.unknown.request.side=f.leg.side==='long'?'buy':'sell';}],
  ['nonfinite maximum',(f:Fixture)=>{f.unknown.request.quantity=NaN;}],
  ['zero maximum',(f:Fixture)=>{f.unknown.request.quantity=0;}],
  ['invalid limit',(f:Fixture)=>{f.unknown.request.limitPrice=0;}],
  ['foreign client receipt',(f:Fixture)=>{f.unknown.result!.clientOrderId='other';}],
  ['new native identity',(f:Fixture)=>{f.unknown.result!.id='late-native';}],
  ['unknown filled lower bound',(f:Fixture)=>{f.unknown.result!.filledQuantity=1;}],
  ['unknown actual price',(f:Fixture)=>{f.unknown.result!.averagePrice=1;}],
  ['unknown actual fee',(f:Fixture)=>{f.unknown.result!.feeUsd=.01;}],
  ['booked unknown fee',(f:Fixture)=>{f.unknown.executionEvidence!.bookedFeeUsd=.01;}],
  ['invalid request time',(f:Fixture)=>{f.unknown.createdAt=NaN;}],
  ['request before cycle',(f:Fixture)=>{f.unknown.createdAt=openedAt-1;}],
  ['unknown Maker activity',(f:Fixture)=>{f.parent.makerReduction!.activity='unknown';}],
  ['unbooked parent',(f:Fixture)=>{f.parent.makerReduction!.bookedExecution=false;}],
  ['missing parent native cash',(f:Fixture)=>{f.parent.result!.averagePriceVerified=false;}],
  ['parent fee not booked',(f:Fixture)=>{f.parent.executionEvidence!.bookedFeeUsd=0;}],
  ['manual-only scope',(f:Fixture)=>{f.p.manualCloseOnly=true;}],
  ['synthetic account record',(f:Fixture)=>{f.p.manualCloseAccountRecord=true;}],
  ['archived account scope',(f:Fixture)=>{f.p.accountClosure={confirmedAt:eventAt+1000,reason:'flat proof',historicalOrdersPending:true};}],
  ['closed strategy scope',(f:Fixture)=>{f.p.status='closed';f.p.closedAt=eventAt+1000;}],
] as const)test(`bounded invoice ownership rejects ${label}`,()=>{
  const f=fixture();change(f);const before=structuredClone(f.orders);assert.equal(f.assess(),undefined);assert.deepEqual(f.orders,before);
});

for(const scope of ['same-leg','other-leg','other-position-same-base','other-contract-same-base','same-contract-foreign-base','unidentified'] as const)
test(`an unselected new unknown in ${scope} blocks bounded ownership`,()=>{
  const f=fixture(),newUnknown=structuredClone(f.unknown);newUnknown.request.clientOrderId='new-unknown';newUnknown.result!.clientOrderId='new-unknown';
  newUnknown.createdAt=eventAt+1000;
  if(scope==='other-leg'){newUnknown.exchange=f.peer.exchange;newUnknown.request.side=f.peer.side==='long'?'sell':'buy';}
  if(scope==='other-position-same-base')newUnknown.positionId='foreign-position';
  if(scope==='other-contract-same-base')newUnknown.request.symbol='ALT-OTHER/USDT:USDT';
  if(scope==='same-contract-foreign-base'){newUnknown.positionId='foreign-position';newUnknown.request.base='FOREIGN';}
  if(scope==='unidentified'){newUnknown.positionId='absent';newUnknown.request.base='';newUnknown.request.symbol='';}
  f.orders.push(newUnknown);assert.equal(f.assess(),undefined);
});

test('a scoped unrelated coin unknown cannot prevent uniquely proven funding cash',()=>{
  const f=fixture(),foreign=structuredClone(f.unknown);foreign.positionId='other-position';foreign.request.base='OTHER';foreign.request.symbol='OTHER/USDT:USDT';
  foreign.request.clientOrderId='foreign';foreign.result!.clientOrderId='foreign';f.orders.push(foreign);
  assert.equal(f.assess()?.position,f.p);
});

for(const state of ['unknown','zero','closed-overlap','invalid-window'] as const)test(`another compatible ${state} lifecycle prevents a symbol-only fallback`,()=>{
  const f=fixture(),other=structuredClone(f.p);other.id='other-cycle';other[f.leg.side].quantity=0;
  if(state==='unknown'){
    const uncertain=structuredClone(f.unknown);uncertain.positionId=other.id;uncertain.request.clientOrderId='foreign-unknown';uncertain.result!.clientOrderId='foreign-unknown';f.orders.push(uncertain);
  }
  if(state==='closed-overlap'){other.status='closed';other.closedAt=eventAt+1;}
  if(state==='invalid-window')other.openedAt=NaN;
  f.positions.push(other);assert.equal(f.assess(),undefined);
});

test('a nonoverlapping closed cycle cannot claim a later uniquely owned invoice',()=>{
  const f=fixture(),old=structuredClone(f.p);old.id='old';old.status='closed';old.openedAt=openedAt-3_600_000;old.closedAt=openedAt-1;
  f.positions.push(old);assert.equal(f.assess()?.position,f.p);
});

test('duplicate native cash or client intent identities cannot establish ownership bounds',()=>{
  for(const duplicate of ['unknown-client','parent-client','parent-native','opening-native'] as const){
    const f=fixture(),original=duplicate.startsWith('parent')?f.parent:duplicate==='opening-native'?f.openings[0]:f.unknown;
    const foreign=structuredClone(original);foreign.positionId='foreign';
    if(duplicate.endsWith('native')){foreign.request.clientOrderId='foreign-client';foreign.result!.clientOrderId='foreign-client';}
    f.orders.push(foreign);assert.equal(f.assess(),undefined,duplicate);
  }
});

test('a cumulative positive receipt first confirmed after settlement cannot prove earlier funding ownership',()=>{
  const f=fixture();f.openings.find(order=>order.exchange===f.leg.exchange)!.result!.timestamp=eventAt+1;
  assert.equal(f.assess(),undefined);
});

for(const clock of ['native-completion','local-completion','missing-local','before-request','nonfinite-local'] as const)
test(`positive opening ${clock} cannot supply unproven exposure before reduction begins`,()=>{
  const f=fixture(),opening=f.openings.find(order=>order.exchange===f.leg.exchange)!;
  if(clock==='native-completion')opening.result!.timestamp=f.knownPeer.createdAt+1;
  if(clock==='local-completion')opening.execution!.confirmedAt=f.knownPeer.createdAt+1;
  if(clock==='missing-local')delete opening.execution!.confirmedAt;
  if(clock==='before-request')opening.execution!.confirmedAt=opening.createdAt-1;
  if(clock==='nonfinite-local')opening.execution!.confirmedAt=NaN;
  assert.equal(f.assess(),undefined);
});

test('a late additional opening cannot hide a possible flat lifecycle before the original unknown',()=>{
  const f=fixture(),opening=f.openings.find(order=>order.exchange===f.leg.exchange)!;
  opening.request.quantity=221;opening.result!.filledQuantity=221;
  const additional=f.confirmed(f.leg.side,'late-addition',1000,false,openedAt+1500);
  additional.result!.timestamp=openedAt+4500;additional.execution!.confirmedAt=openedAt+4500;f.orders.push(additional);
  assert.equal(f.assess(),undefined,'the known 221 reduction could flatten the initial holding before the additional fill');
});

test('native symbol and side identify an invoice and never come from the selected unknown',()=>{
  const f=fixture();f.payment.side='short';assert.equal(f.assess(),undefined);delete f.payment.side;
  f.payment.symbol='FOREIGN/USDT:USDT';assert.equal(f.assess(),undefined);
});
