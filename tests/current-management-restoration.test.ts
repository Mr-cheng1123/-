import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCurrentManagementRestorationEligible,buildCurrentManagementRestorationAudit} from '../src/core/current-management-restoration.js';
import type {JournalOrder,Position} from '../src/shared/types.js';
import type {ManualCloseOperation} from '../src/shared/manual-close.js';

function fixture(){
  const now=20_000,p:Position={id:'original-strategy',base:'STORJ',mode:'live',status:'attention',openedAt:1000,
    plannedExitAt:100_000,entryPolicy:'aligned',automaticEntry:true,holdMode:'adaptive',feeOnly:true,
    manualCloseOnly:true,manualCloseOperationId:'completed-scoped-operation',closeRequestedAt:8000,closeAttemptedAt:8200,
    closeReason:'用户确认所选账户仓位手动平仓',closeProfitRequired:false,closePricing:'best-opposite',
    closePauseReason:'旧意图等待核对',profitExitNotionalUsd:12.06,
    long:{exchange:'bybit',symbol:'STORJ/USDT:USDT',side:'long',quantity:100,entryPrice:.1,markPrice:.11,feesUsd:.012,liquidationDistancePct:null},
    short:{exchange:'gate',symbol:'STORJ/USDT:USDT',side:'short',quantity:100,entryPrice:.101,markPrice:.111,feesUsd:.013,liquidationDistancePct:null},
    feesUsd:.025,fundingUsd:.02,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:.01,netPnlUsd:0,deltaUsd:0,
    fundingEvents:['actual-invoice'],riskReasons:['等待原账户核对']};
  const make=(index:number,leg:Position['long'],reduceOnly:boolean):JournalOrder=>{
    const clientOrderId=`original-client-${index}`,quantity=reduceOnly?20:120,feeUsd=reduceOnly?(leg.side==='long'?.002:.003):.01;
    return {positionId:p.id,exchange:leg.exchange,createdAt:reduceOnly?8200:1100+index*100,
      request:{clientOrderId,base:p.base,symbol:leg.symbol,side:reduceOnly?(leg.side==='long'?'sell':'buy'):(leg.side==='long'?'buy':'sell'),
        quantity,limitPrice:leg.entryPrice,reduceOnly},
      result:{id:`native-order-${index}`,clientOrderId,status:'filled',filledQuantity:quantity,averagePrice:leg.entryPrice,
        averagePriceVerified:true,feeUsd,timestamp:reduceOnly?8300:1200+index*100},
      executionEvidence:{version:1,method:'ioc',role:reduceOnly?'exit':(leg.side==='long'?'entry':'hedge'),
        batchId:reduceOnly?'manual-close-prior':'opening-original',bookedFeeUsd:feeUsd}};
  };
  const orders=[make(0,p.long,false),make(1,p.short,false),make(2,p.long,true),make(3,p.short,true)],positions=[p];
  const operation:ManualCloseOperation={id:p.manualCloseOperationId!,state:'completed',positionId:p.id,sourcePositionId:p.id,
    createdAt:10_000,expiresAt:15_000,error:'本次手动平仓已结束',selection:JSON.stringify({sourceId:p.id,base:p.base,
      acknowledgement:'CLOSE_SELECTED_POSITION',legs:[p.long,p.short].map(leg=>({exchange:leg.exchange,symbol:leg.symbol,side:leg.side,
        quantity:leg.quantity,accountPositionKey:JSON.stringify([leg.exchange,leg.symbol,leg.side,'crossed',null]),positionOpenedAt:1100}))})};
  const operations=[operation],check=()=>assertCurrentManagementRestorationEligible(p,positions,orders,operations,now);
  return {now,p,orders,positions,operation,operations,check};
}

test('finished scoped manual protection on an original strategy is eligible without changing cash or provenance',()=>{
  const f=fixture(),before=JSON.stringify(f);assert.equal(f.check(),f.operation);assert.equal(JSON.stringify(f),before);
  assert.equal(f.p.manualCloseOnly,true);assert.equal(f.p.closeProfitRequired,false);
});
test('legacy strategy without automaticEntry or execution metadata still needs complete original native opening journal',()=>{
  const f=fixture();delete f.p.automaticEntry;for(const order of f.orders)delete order.executionEvidence;
  assert.equal(f.check(),f.operation);
  f.orders.splice(0,1);assert.throws(f.check,/开仓现金|完整/);
});
test('audit freezes the prior manual intent and original order identities as detached data',()=>{
  const f=fixture();f.check();const before=JSON.stringify(f),audit=buildCurrentManagementRestorationAudit(f.p,f.operation,f.orders,f.now);
  assert.equal(JSON.stringify(f),before);assert.equal(audit.sourceOperationId,f.operation.id);
  assert.equal(audit.previousCloseIntent.profitRequired,false);assert.equal(audit.previousCloseIntent.requestedAt,8000);
  assert.equal(audit.originalManualCloseOnly,true);assert.equal(audit.originalOrderIds.length,4);
  audit.previousRiskReasons.push('audit-only');audit.legs[0].quantity=1;audit.previousCloseIntent.reason='audit-only';
  assert.deepEqual(f.p.riskReasons,['等待原账户核对']);assert.equal(f.p.long.quantity,100);
  assert.equal(f.p.closeReason,'用户确认所选账户仓位手动平仓');
});

const positionRejections:Array<[string,(f:ReturnType<typeof fixture>)=>void]>=[
  ['synthetic account-close ledger',f=>{f.p.manualCloseAccountRecord=true;}],
  ['imported manual source ledger',f=>{f.p.manualCloseSourcePositionId=f.p.id;}],
  ['confirmed flat-account archive',f=>{f.p.accountClosure={confirmedAt:15_000,reason:'flat',historicalOrdersPending:false};}],
  ['explicit nonautomatic entry',f=>{f.p.automaticEntry=false;}],
  ['manual entry evidence',f=>{f.p.executionEvidence={version:1,method:'ioc',entryPath:'manual'};}],
  ['closed position',f=>{f.p.status='closed';}],
  ['previously closed timestamp',f=>{f.p.closedAt=9000;}],
  ['unmatched remaining exposure',f=>{f.p.short.quantity=99;}],
  ['duplicate active base',f=>{f.positions.push({...structuredClone(f.p),id:'different-record',base:'storj'});}],
  ['duplicate original position identity',f=>{f.positions.push(structuredClone(f.p));}],
  ['missing manual protection',f=>{delete f.p.manualCloseOnly;}],
  ['missing original opening price',f=>{f.p.long.entryPrice=0;}],
  ['incomplete real fees',f=>{f.p.long.feesUsd=NaN;}],
  ['total fees disagree with leg cash',f=>{f.p.feesUsd=0;}],
];
for(const [name,mutate] of positionRejections)test(`rejects ${name}`,()=>{const f=fixture();mutate(f);assert.throws(f.check);});

const operationRejections:Array<[string,(f:ReturnType<typeof fixture>)=>void]>=[
  ['checking operation',f=>{f.operation.state='checking';}],
  ['running operation',f=>{f.operation.state='closing';}],
  ['failed operation',f=>{f.operation.state='failed';}],
  ['missing original operation',f=>{f.operations.length=0;}],
  ['duplicate operation identity',f=>{f.operations.push(structuredClone(f.operation));}],
  ['later queued scoped operation',f=>{f.operations.push({...structuredClone(f.operation),id:'queued-other-operation',state:'checking',createdAt:11_000});}],
  ['later completed scoped operation',f=>{f.operations.push({...structuredClone(f.operation),id:'later-other-operation',createdAt:11_000});}],
  ['foreign source ID',f=>{f.operation.sourcePositionId='foreign-source';}],
  ['foreign reused position ID',f=>{f.operation.positionId='foreign-record';}],
  ['future operation',f=>{f.operation.createdAt=30_000;}],
  ['operation before original cycle',f=>{f.operation.createdAt=900;}],
  ['malformed saved selection',f=>{f.operation.selection='bad JSON';}],
  ['manual account-only selection',f=>{const s=JSON.parse(f.operation.selection);s.acknowledgement='CLOSE_SELECTED_ACCOUNT_POSITION';f.operation.selection=JSON.stringify(s);}],
  ['missing selected leg',f=>{const s=JSON.parse(f.operation.selection);s.legs.pop();f.operation.selection=JSON.stringify(s);}],
  ['foreign selected contract',f=>{const s=JSON.parse(f.operation.selection);s.legs[0].symbol='OTHER/USDT:USDT';f.operation.selection=JSON.stringify(s);}],
  ['changed selected quantity',f=>{const s=JSON.parse(f.operation.selection);s.legs[0].quantity=99;f.operation.selection=JSON.stringify(s);}],
  ['foreign account position key',f=>{const s=JSON.parse(f.operation.selection);s.legs[0].accountPositionKey='["gate","STORJ/USDT:USDT","short","crossed",null]';f.operation.selection=JSON.stringify(s);}],
];
for(const [name,mutate] of operationRejections)test(`rejects ${name}`,()=>{const f=fixture();mutate(f);assert.throws(f.check);});

const orderRejections:Array<[string,(f:ReturnType<typeof fixture>)=>void]>=[
  ['missing native receipt',f=>{delete f.orders[0].result;}],
  ['foreign receipt client ID',f=>{f.orders[0].result!.clientOrderId='foreign-client';}],
  ['synthetic native ID copied from client',f=>{f.orders[0].result!.id=f.orders[0].request.clientOrderId;}],
  ['missing actual fee',f=>{f.orders[0].result!.feeUsd=NaN;}],
  ['fee cash not booked consistently',f=>{f.orders[0].executionEvidence!.bookedFeeUsd=0;}],
  ['unverified execution price',f=>{f.orders[0].result!.averagePriceVerified=false;}],
  ['unknown original order',f=>{f.orders[0].result!.status='unknown';}],
  ['active original Maker',f=>{f.orders[0].makerReduction={activity:'active',makerLeg:'long',deadlineAt:30_000};}],
  ['forged opening quantity',f=>{f.orders[0].request.quantity=130;f.orders[0].result!.filledQuantity=130;}],
  ['foreign contract in ledger',f=>{f.orders[0].request.symbol='OTHER/USDT:USDT';}],
  ['wrong opening direction',f=>{f.orders[0].request.side='sell';}],
  ['wrong opening role',f=>{f.orders[0].executionEvidence!.role='exit';}],
  ['later transaction on original ledger',f=>{f.orders.push({...structuredClone(f.orders[2]),createdAt:10_001});}],
  ['transaction at operation creation',f=>{f.orders[2].createdAt=f.operation.createdAt;}],
  ['later foreign transaction on selected contract',f=>{f.orders.push({...structuredClone(f.orders[2]),positionId:'foreign',createdAt:10_001});}],
  ['foreign unresolved order for same base',f=>{const o=structuredClone(f.orders[0]);o.positionId='foreign';o.request.clientOrderId='another-client';o.result!.clientOrderId='another-client';o.result!.id='another-native';o.result!.status='unknown';f.orders.push(o);}],
  ['native receipt reused on a different intent',f=>{const o=structuredClone(f.orders[0]);o.positionId='foreign';o.request.clientOrderId='another-client';o.result!.clientOrderId='another-client';f.orders.push(o);}],
];
for(const [name,mutate] of orderRejections)test(`rejects ${name}`,()=>{const f=fixture();mutate(f);assert.throws(f.check);});

test('unrelated existing unknown and closed historical same-base records do not create a global blocker',()=>{
  const f=fixture(),other=structuredClone(f.orders[0]);other.positionId='unrelated';other.request.base='OTHER';
  other.request.symbol='OTHER/USDT:USDT';other.request.clientOrderId='unrelated-client';
  other.result!.id='unrelated-native';other.result!.clientOrderId='unrelated-client';other.result!.status='unknown';f.orders.push(other);
  f.positions.push({...structuredClone(f.p),id:'archived',status:'closed'});assert.equal(f.check(),f.operation);
});
test('verified native zero reduction remains zero cash and can accompany the complete opening journal',()=>{
  const f=fixture(),zero=structuredClone(f.orders[2]);zero.request.clientOrderId='zero-client';zero.result!.clientOrderId='zero-client';
  zero.result!.id='zero-native';zero.result!.status='cancelled';zero.result!.filledQuantity=0;zero.result!.averagePrice=0;
  zero.result!.feeUsd=0;zero.executionEvidence!.bookedFeeUsd=0;f.orders.push(zero);assert.equal(f.check(),f.operation);
  zero.result!.feeUsd=.001;assert.throws(f.check,/完整真实现金/);
});
test('audit refuses a different or ongoing source operation',()=>{
  const f=fixture();f.operation.state='closing';assert.throws(()=>buildCurrentManagementRestorationAudit(f.p,f.operation,f.orders,f.now));
  f.operation.state='completed';f.operation.sourcePositionId='different';assert.throws(()=>buildCurrentManagementRestorationAudit(f.p,f.operation,f.orders,f.now));
});
