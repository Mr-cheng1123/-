import test from 'node:test';
import assert from 'node:assert/strict';
import {findFundingOwner} from '../src/core/funding-attribution.js';
import type {FundingPayment,JournalOrder,Position} from '../src/shared/types.js';

const openedAt=1_790_900_000_000,eventAt=openedAt+3_600_000;
function fixture(){
  const position=(id:string):Position=>({id,base:'ALT',mode:'live',status:'open',openedAt,plannedExitAt:eventAt+3_600_000,
    entryPolicy:'aligned',holdMode:'adaptive',
    long:{exchange:'gate',symbol:'ALT/USDT:USDT',side:'long',quantity:95,entryPrice:1,markPrice:1,feesUsd:.01,liquidationDistancePct:null},
    short:{exchange:'bitget',symbol:'ALT/USDT:USDT',side:'short',quantity:95,entryPrice:1,markPrice:1,feesUsd:.01,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:.02,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:-.02,deltaUsd:0,fundingEvents:[],riskReasons:[]});
  const p=position('selected'),other=position('competing');
  const confirmed=(owner:Position,exchange:'gate'|'bitget',id:string,reduceOnly:boolean,at:number,quantity:number):JournalOrder=>({
    positionId:owner.id,exchange,createdAt:at,
    request:{clientOrderId:id,base:'ALT',symbol:'ALT/USDT:USDT',side:exchange==='gate'?(reduceOnly?'sell':'buy'):(reduceOnly?'buy':'sell'),
      quantity,limitPrice:1,reduceOnly},
    result:{id:`native-${id}`,clientOrderId:id,status:'filled',filledQuantity:quantity,averagePrice:1,averagePriceVerified:true,feeUsd:.01,timestamp:at},
    execution:{bookObservedAt:at,quoteAgeMs:0,bookTransport:'rest',confirmedAt:at}});
  const opening=confirmed(p,'gate','selected-open',false,openedAt+1000,100),parent=confirmed(p,'bitget','parent',true,openedAt+2000,5);
  parent.request.postOnly=true;parent.makerReduction={makerLeg:'short',activity:'terminal',bookedExecution:true,deadlineAt:openedAt+2000};
  parent.executionEvidence={version:1,method:'maker',role:'exit',batchId:'parent',bookedFeeUsd:.01};
  const unknown:JournalOrder={positionId:p.id,exchange:'gate',createdAt:openedAt+3000,
    request:{clientOrderId:'old-unknown',base:'ALT',symbol:'ALT/USDT:USDT',side:'sell',quantity:5,limitPrice:1,reduceOnly:true},
    result:{id:'',clientOrderId:'old-unknown',status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:openedAt+3000},
    executionEvidence:{version:1,method:'ioc',role:'exit-tail',batchId:'old',makerCloseParentClientId:'parent',bookedFeeUsd:0}};
  const orders=[opening,parent,unknown],authorized=new Set([unknown]),payment:FundingPayment={id:'actual-native-cash',base:'ALT',symbol:'ALT/USDT:USDT',timestamp:eventAt,amountUsd:.02};
  return {p,other,orders,authorized,payment,confirmed};
}

for(const competitor of ['display-quantity','terminal-fill','closed-overlap'] as const)
test(`a compatible ${competitor} cycle cannot receive cash after the selected unknown cycle fails uniqueness`,()=>{
  const f=fixture();
  assert.equal(findFundingOwner([f.p],f.orders,'gate',f.payment,f.authorized)?.position,f.p,'the original scoped interval is valid in isolation');
  if(competitor!=='display-quantity')f.orders.push(f.confirmed(f.other,'gate','competing-open',false,openedAt+1000,95));
  if(competitor==='closed-overlap'){f.other.status='closed';f.other.closedAt=eventAt+1000;}
  const before=structuredClone({positions:[f.p,f.other],orders:f.orders});
  assert.equal(findFundingOwner([f.p,f.other],f.orders,'gate',f.payment,f.authorized),undefined,'reject the entire ambiguous native invoice; do not give it to the remaining exact candidate');
  assert.deepEqual({positions:[f.p,f.other],orders:f.orders},before);
});

test('native quantity cannot assign cash to a competing cycle while the authorized interval also fits it',()=>{
  const f=fixture();f.orders.push(f.confirmed(f.other,'gate','competing-open',false,openedAt+1000,95));f.payment.quantity=95;
  assert.equal(findFundingOwner([f.p,f.other],f.orders,'gate',f.payment,f.authorized),undefined);
  assert.equal(findFundingOwner([f.p,f.other],f.orders,'gate',f.payment)?.position,f.other,'the original ungranted exact-quantity path remains compatible');
});

test('an opening fill confirmed after the unknown reduction cannot prove continuously positive exposure before it',()=>{
  const f=fixture(),first=f.orders[0];first.request.quantity=1;first.result!.filledQuantity=1;
  const delayedOpening=f.confirmed(f.p,'gate','delayed-opening',false,openedAt+1500,100);
  delayedOpening.result!.timestamp=openedAt+4000;delayedOpening.execution!.confirmedAt=openedAt+4000;
  f.orders.push(delayedOpening);f.p.long.quantity=101;
  assert.equal(findFundingOwner([f.p],f.orders,'gate',f.payment,f.authorized),undefined,
    'an older intent is not proof its additional exposure existed before the later unknown IOC could flatten the first holding');
});

test('an early native timestamp cannot replace a local opening confirmation obtained after the unknown reduction',()=>{
  const f=fixture(),first=f.orders[0];first.request.quantity=1;first.result!.filledQuantity=1;
  const delayedOpening=f.confirmed(f.p,'gate','late-local-confirmation',false,openedAt+1500,100);
  delayedOpening.execution!.confirmedAt=openedAt+4000;f.orders.push(delayedOpening);f.p.long.quantity=101;
  assert.equal(findFundingOwner([f.p],f.orders,'gate',f.payment,f.authorized),undefined,
    'the scoped exception needs positive opening evidence committed before possible reductions, independently of the native creation timestamp');
});
