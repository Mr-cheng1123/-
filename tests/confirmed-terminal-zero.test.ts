import test from 'node:test';
import assert from 'node:assert/strict';
import {isDurableConfirmedMakerZero} from '../src/core/confirmed-terminal-zero.js';
import {exchangeClientId} from '../src/adapters/normalization.js';
import {createMakerCloseComparison,updateMakerCloseComparison} from '../src/shared/maker-close-comparison.js';
import type {JournalOrder,Position} from '../src/shared/types.js';

function fixture(){
  const now=200_000,p:Position={id:'original-strategy',base:'ERA',mode:'live',status:'attention',openedAt:1000,
    plannedExitAt:300_000,entryPolicy:'dual',automaticEntry:true,holdMode:'once',feeOnly:true,
    long:{exchange:'gate',symbol:'ERA/USDT:USDT',side:'long',quantity:500,entryPrice:.078,markPrice:.079,feesUsd:.02,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'ERA/USDT:USDT',side:'short',quantity:500,entryPrice:.079,markPrice:.08,feesUsd:.02,liquidationDistancePct:null},
    feesUsd:.04,fundingUsd:.02,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,
    fundingEvents:[],riskReasons:['Original account verification pending']};
  const order:JournalOrder={positionId:p.id,exchange:'gate',createdAt:2000,
    request:{clientOrderId:'original-maker-client',base:p.base,symbol:p.long.symbol,side:'sell',quantity:140,limitPrice:.079,
      reduceOnly:true,postOnly:true},
    result:{id:'900000000000000003',clientOrderId:'original-maker-client',status:'cancelled',filledQuantity:0,
      averagePrice:0,feeUsd:0,averagePriceVerified:true,timestamp:3380},
    makerReduction:{activity:'terminal',makerLeg:'long',deadlineAt:7000,bookedExecution:true,submittedAt:2100,
      acknowledgedAt:2200,cancelRequestedAt:2300,lastObservedAt:3200,observationQueuedAt:3250,
      observationCommitStartedAt:3300,observationCommittedAt:3400,finishedAt:3500},
    executionEvidence:{version:1,method:'maker',role:'exit',batchId:'original-strategy:maker-close:original-maker-client',
      submittedAt:2100,bookedFeeUsd:0}};
  const orders=[order],check=()=>isDurableConfirmedMakerZero(order,p,orders,now);
  return {now,p,order,orders,check};
}
type Fixture=ReturnType<typeof fixture>;

test('complete original native zero survives retention expiry without refreshing evidence or changing cash',()=>{
  const f=fixture(),before=JSON.stringify(f);
  assert.equal(f.check(),true);assert.equal(isDurableConfirmedMakerZero(f.order,f.p,f.orders,f.now+86_400_000),true);
  assert.equal(JSON.stringify(f),before);assert.equal(f.order.result!.timestamp,3380);
  assert.equal(f.order.makerReduction!.lastObservedAt,3200);assert.equal(f.p.long.quantity,500);
});
test('normal original manual protection remains evidence eligible while synthetic and manual entry do not',()=>{
  const f=fixture();f.p.manualCloseOnly=true;f.p.manualCloseOperationId='completed-original-operation';
  assert.equal(f.check(),true);delete f.p.automaticEntry;assert.equal(f.check(),true);
});
test('native clock skew is bounded independently of the monotonic local cancellation lifecycle',()=>{
  const f=fixture();f.order.result!.timestamp=f.order.makerReduction!.lastObservedAt!+5000;assert.equal(f.check(),true);
  f.order.result!.timestamp++;assert.equal(f.check(),false);
  f.order.result!.timestamp=3380;f.order.makerReduction!.observationCommittedAt=3299;assert.equal(f.check(),false);
});
test('all existing native Maker venues retain exact original leg semantics',()=>{
  for(const exchange of ['gate','bybit','bitget'] as const){
    const f=fixture();f.p.long.exchange=exchange;f.p.short.exchange=exchange==='bybit'?'gate':'bybit';f.order.exchange=exchange;
    if(exchange==='bybit'){f.order.result!.rejectionCode='EC_PerCancelRequest';f.order.result!.rejectionReason='Native user cancellation';}
    assert.equal(f.check(),true,exchange);
  }
  const f=fixture();f.order.exchange='binance';f.p.long.exchange='binance';assert.equal(f.check(),false);
});
test('verified zero on the short original leg requires its buy reduction',()=>{
  const f=fixture();f.order.exchange='bybit';f.order.request.symbol=f.p.short.symbol;f.order.request.side='buy';
  f.order.makerReduction!.makerLeg='short';f.order.result!.rejectionCode='EC_PerCancelRequest';assert.equal(f.check(),true);
  f.order.request.side='sell';assert.equal(f.check(),false);
});

const rejections:Array<[string,(f:Fixture)=>void]>=[
  ['closed original',f=>{f.p.status='closed';}],['closed timestamp',f=>{f.p.closedAt=3000;}],
  ['paper record',f=>{f.p.mode='paper';}],['opening record',f=>{f.p.status='opening';}],
  ['synthetic account record',f=>{f.p.manualCloseAccountRecord=true;}],
  ['imported account source',f=>{f.p.manualCloseSourcePositionId=f.p.id;}],
  ['flat account archive',f=>{f.p.accountClosure={confirmedAt:5000,reason:'flat',historicalOrdersPending:false};}],
  ['explicit manual entry',f=>{f.p.automaticEntry=false;}],
  ['manual execution origin',f=>{f.p.executionEvidence={version:1,method:'ioc',entryPath:'manual'};}],
  ['missing original opening time',f=>{f.p.openedAt=NaN;}],
  ['missing original opening price',f=>{f.p.long.entryPrice=0;}],['one-sided current position',f=>{f.p.short.quantity=0;}],
  ['order before original position',f=>{f.order.createdAt=999;}],
  ['foreign original position ID',f=>{f.order.positionId='different-position';}],
  ['foreign base',f=>{f.order.request.base='OTHER';}],['foreign contract',f=>{f.order.request.symbol='OTHER/USDT:USDT';}],
  ['foreign exchange',f=>{f.order.exchange='bitget';}],['wrong Maker leg',f=>{f.order.makerReduction!.makerLeg='short';}],
  ['wrong close side',f=>{f.order.request.side='buy';}],['not reduce-only',f=>{f.order.request.reduceOnly=false;}],
  ['not PostOnly',f=>{f.order.request.postOnly=false;}],
  ['account close selector',f=>{f.order.request.closePosition={side:'long'};}],
  ['missing requested amount',f=>{f.order.request.quantity=0;}],['invalid requested price',f=>{f.order.request.limitPrice=NaN;}],
  ['missing native ID',f=>{f.order.result!.id='';}],['client masquerading as native ID',f=>{f.order.result!.id=f.order.request.clientOrderId;}],
  ['native client alias masquerading as order ID',f=>{f.order.result!.id=exchangeClientId(f.order.exchange,f.order.request.clientOrderId);}],
  ['foreign receipt client',f=>{f.order.result!.clientOrderId='foreign-client';}],['missing receipt',f=>{delete f.order.result;}],
  ['unknown receipt',f=>{f.order.result!.status='unknown';}],['partial receipt mislabeled zero',f=>{f.order.result!.status='partial';}],
  ['positive filled amount',f=>{f.order.result!.filledQuantity=1;}],['nonzero average',f=>{f.order.result!.averagePrice=.079;}],
  ['positive native fee',f=>{f.order.result!.feeUsd=.0001;}],['negative native fee',f=>{f.order.result!.feeUsd=-.0001;}],
  ['unknown fee',f=>{f.order.result!.feeUsd=NaN;}],['missing native price verification',f=>{delete f.order.result!.averagePriceVerified;}],
  ['failed native price verification',f=>{f.order.result!.averagePriceVerified=false;}],
  ['404 diagnostic is no zero proof',f=>{f.order.result!.confirmation={stage:'order-read',reason:'not-found',apiCode:'ORDER_NOT_FOUND'};}],
  ['hard native refusal',f=>{f.order.result!.rejectionCode='110017';}],
  ['unsupported Gate finish reason',f=>{f.order.result!.rejectionCode='MAKER_REDUCTION_FINISH_REASON_BLOCKED';}],
  ['Bybit unidentified cancellation',f=>{f.order.exchange='bybit';f.p.long.exchange='bybit';f.p.short.exchange='gate';f.order.result!.rejectionCode='BYBIT_CANCELLED_ZERO_FILL';}],
  ['missing Bybit native cancellation reason',f=>{f.order.exchange='bybit';f.p.long.exchange='bybit';f.p.short.exchange='gate';}],
  ['current journal error',f=>{f.order.error='unresolved native read';}],['active Maker',f=>{f.order.makerReduction!.activity='active';}],
  ['unknown Maker activity',f=>{f.order.makerReduction!.activity='unknown';}],
  ['cash not committed',f=>{f.order.makerReduction!.bookedExecution=false;}],
  ['missing method evidence',f=>{delete f.order.executionEvidence;}],['IOC method',f=>{f.order.executionEvidence!.method='ioc';}],
  ['entry role',f=>{f.order.executionEvidence!.role='entry';}],['missing batch provenance',f=>{f.order.executionEvidence!.batchId='';}],
  ['nonzero booked fee',f=>{f.order.executionEvidence!.bookedFeeUsd=.0001;}],
  ['submission clocks disagree',f=>{f.order.executionEvidence!.submittedAt=2099;}],
  ['missing submit',f=>{delete f.order.makerReduction!.submittedAt;}],['missing native ACK',f=>{delete f.order.makerReduction!.acknowledgedAt;}],
  ['no native cancellation request',f=>{delete f.order.makerReduction!.cancelRequestedAt;}],
  ['missing observation',f=>{delete f.order.makerReduction!.lastObservedAt;}],['missing commit',f=>{delete f.order.makerReduction!.observationCommittedAt;}],
  ['missing finished lifecycle',f=>{delete f.order.makerReduction!.finishedAt;}],
  ['observation predates cancellation',f=>{f.order.makerReduction!.lastObservedAt=2299;}],
  ['commit predates queued observation',f=>{f.order.makerReduction!.observationCommitStartedAt=3249;}],
  ['future local lifecycle',f=>{f.order.makerReduction!.finishedAt=f.now+1;}],
  ['native timestamp predates original intent',f=>{f.order.result!.timestamp=-3001;}],
  ['earlier positive fill observed',f=>{f.order.makerReduction!.firstFillObservedAt=2500;}],
  ['earlier positive fill completion',f=>{f.order.makerReduction!.lastFillObservedAt=2500;}],
  ['peer hedge started',f=>{f.order.makerReduction!.hedgeStartedAt=2500;}],
  ['recovered peer cash',f=>{f.order.makerReduction!.recoveredPeers={verifiedAt:3500,clientOrderIds:['peer']};}],
  ['positive execution lower bound',f=>{f.order.makerReduction!.lotTailObservedExecution={...f.order.result!,filledQuantity:1,averagePrice:.079};}],
  ['individual positive native execution',f=>{f.order.executionEvidence!.fills=[{execId:'native-exec',quantity:1,price:.079,feeUsd:.001,feeCurrency:'USDT',liquidity:'maker',observedAt:2500}];}],
];
for(const [name,mutate] of rejections)test(`durable zero refuses ${name}`,()=>{const f=fixture();mutate(f);assert.equal(f.check(),false);});

test('proof must be the single original object in the current ledger',()=>{
  const f=fixture();assert.equal(isDurableConfirmedMakerZero(structuredClone(f.order),f.p,f.orders,f.now),false);
  f.orders.push(f.order);assert.equal(f.check(),false);f.orders.length=0;assert.equal(f.check(),false);
});
test('client and native order IDs cannot be reused by another original intent',()=>{
  for(const duplicate of ['client','native'] as const){
    const f=fixture(),other=structuredClone(f.order);other.positionId='foreign-position';
    if(duplicate==='native'){other.request.clientOrderId='foreign-client';other.result!.clientOrderId='foreign-client';}
    else other.result!.id='different-native';
    f.orders.push(other);assert.equal(f.check(),false,duplicate);
  }
});
test('a different symbol cannot conceal a duplicate venue native or client identity',()=>{
  for(const duplicate of ['client','native'] as const){
    const f=fixture(),other=structuredClone(f.order);other.positionId='foreign-position';
    other.request.base='OTHER';other.request.symbol='OTHER/USDT:USDT';
    if(duplicate==='native'){other.request.clientOrderId='foreign-client';other.result!.clientOrderId='foreign-client';}
    else other.result!.id='different-native';
    f.orders.push(other);assert.equal(f.check(),false,duplicate);
  }
});
test('a current unknown on the original position or contract blocks reuse; unrelated unknown does not',()=>{
  for(const scope of ['position','contract','unrelated'] as const){
    const f=fixture(),other=structuredClone(f.order);other.request.clientOrderId='other-client';other.result!.clientOrderId='other-client';
    other.result!.id='other-native';other.result!.status='unknown';other.makerReduction!.activity='unknown';
    if(scope!=='position')other.positionId='other-position';
    if(scope!=='contract'){other.request.base='OTHER';other.request.symbol='OTHER/USDT:USDT';}
    f.orders.push(other);assert.equal(f.check(),scope==='unrelated',scope);
  }
});
test('a related peer journal cannot consume a zero original Maker budget',()=>{
  const f=fixture(),peer=structuredClone(f.order);peer.request.clientOrderId='peer-client';peer.result!.clientOrderId='peer-client';
  peer.result!.id='peer-native';peer.executionEvidence!.makerCloseParentClientId=f.order.request.clientOrderId;
  f.orders.push(peer);assert.equal(f.check(),false);
  delete peer.executionEvidence!.makerCloseParentClientId;peer.executionEvidence!.makerCloseLotTailParentClientIds=[f.order.request.clientOrderId];
  assert.equal(f.check(),false);
});
test('prior safe create uncertainty stays auditable after an independently verified native zero',()=>{
  const f=fixture();f.order.originalConfirmation={stage:'create',reason:'request-failed',observedAt:2150};
  f.order.result!.originalConfirmation={stage:'create',reason:'request-failed',observedAt:2150};
  assert.equal(f.check(),true);
});
test('a saved comparison must agree with the complete zero native cash and no peer execution',()=>{
  const f=fixture();f.order.makerCloseComparison=createMakerCloseComparison({timestamp:2100,longOppositePrice:.079,
    shortOppositePrice:.08,longTakerFeeRate:.0005,shortTakerFeeRate:.0005,makerLeg:'long',originalOneLegNotionalUsd:39});
  updateMakerCloseComparison(f.order,f.orders);assert.equal(f.check(),true);
  f.order.makerCloseComparison.peerActualFeeUsd=.0001;assert.equal(f.check(),false);
  f.order.makerCloseComparison.peerActualFeeUsd=0;f.order.makerCloseComparison.peerQuantity=1;assert.equal(f.check(),false);
});
