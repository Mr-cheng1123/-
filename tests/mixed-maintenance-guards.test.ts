import assert from 'node:assert/strict';
import test from 'node:test';
import {defaultConfig,validateConfig} from '../src/shared/config.js';
import type {ExchangeId,Position} from '../src/shared/types.js';
import type {SavedState} from '../src/core/store.js';
import {maintenanceHash,maintenanceLedgerHash,maintenancePositionPartition} from '../src/core/maintenance-handoff.js';
import {assertMixedMaintenanceIdle,assertMixedMaintenanceScope,sealMixedMaintenanceHandoff,type MixedMaintenanceReceipt} from '../scripts/mixed-maintenance-guards.js';

const now=1_790_001_000_000,project='D:/mixed-maintenance-fixture',credentialsHash='unchanged-private-file-hash';
const eligible:ExchangeId[]=['bitget','bybit','gate'];
function fixture(){
  const p:Position={id:'current-sand',base:'SAND',status:'open',mode:'live',entryPolicy:'aligned',holdMode:'adaptive',
    openedAt:now-60_000,plannedExitAt:now+3_600_000,
    long:{exchange:'bitget',symbol:'SAND/USDT:USDT',side:'long',quantity:1261,entryPrice:.07863,markPrice:.07864,feesUsd:.06,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'SAND/USDT:USDT',side:'short',quantity:1261,entryPrice:.07891,markPrice:.07897,feesUsd:.055,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:.115,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:-.115,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  const attention:Position={...structuredClone(p),id:'legacy-gate-single',base:'ONE',status:'attention',
    long:{...p.long,exchange:'gate',symbol:'ONE/USDT:USDT',quantity:46600},
    short:{...p.short,symbol:'ONE/USDT:USDT',quantity:0},closeRequestedAt:now-10_000,riskReasons:['Original paused record']};
  const ledger:SavedState={version:1,config:validateConfig({...defaultConfig,mode:'live',holdMode:'adaptive',entryPolicy:'aligned',autoEnabled:false}),
    positions:[p,attention],orders:[],fundingSeen:[],logs:[],equity:[],killSwitch:false};
  const receipt:MixedMaintenanceReceipt={version:2,at:now,sourcePid:4444,project,credentialsHash,venues:['bitget','bybit'],
    configHash:maintenanceHash(ledger.config),ledgerHash:maintenanceLedgerHash(ledger),sourceOrdersHash:maintenanceHash(ledger.orders),
    ...maintenancePositionPartition(ledger.positions)};
  return {p,attention,baseline:structuredClone(ledger),ledger,receipt};
}
const seal=(f:ReturnType<typeof fixture>,payments:any[]=[])=>sealMixedMaintenanceHandoff(f.receipt,f.baseline,f.ledger,project,credentialsHash,eligible,true,payments,now);

test('a configured Gate credential does not widen an exact Bybit / Bitget maintenance handover',()=>{
  const f=fixture(),before=structuredClone(f.ledger);
  assert.deepEqual(assertMixedMaintenanceScope(f.receipt.venues,eligible,f.ledger.positions),['bitget','bybit']);
  const result=seal(f);assert.deepEqual(result.proof.venues,['bitget','bybit']);assert.deepEqual(result.proof.positionIds,['current-sand']);
  assert.deepEqual(result.proof.attentionPositionIds,['legacy-gate-single']);assert.equal(result.fundingReceiptsObserved,0);
  assert.deepEqual(f.ledger,before,'Preparing a receipt cannot mutate or promote a financial record.');
  assert.equal(f.ledger.config.autoEnabled,false);assert.equal(f.p.status,'open');assert.equal(f.attention.status,'attention');
});

test('empty, repeated, missing and newly unavailable permissions reject restoration',()=>{
  for(const venues of [[],['bybit'],['bybit','bybit'],['bybit','okx']] as ExchangeId[][]){
    const f=fixture();assert.throws(()=>assertMixedMaintenanceScope(venues,eligible,f.ledger.positions));
  }
  const f=fixture();assert.throws(()=>sealMixedMaintenanceHandoff(f.receipt,f.baseline,f.ledger,project,credentialsHash,['bybit','gate'],true,[],now));
});

test('orders accepted after the last source GET cannot be hidden by sealing a new financial hash',()=>{
  const f=fixture();f.ledger.orders.push({positionId:f.p.id,exchange:'bybit',createdAt:now,
    request:{base:'SAND',symbol:f.p.short.symbol,clientOrderId:'late-request',side:'sell',reduceOnly:false,quantity:1,limitPrice:.079},
    result:{id:'zero-fill-order',clientOrderId:'late-request',status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:now}});
  assert.throws(()=>seal(f),/order journal/);
  f.receipt.ledgerHash=maintenanceLedgerHash(f.ledger);assert.throws(()=>seal(f),'Tampering with the receipt cannot bypass the saved preflight baseline.');
});

test('delayed changes to existing order execution evidence also reject the financial handover',()=>{
  const f=fixture(),order:any={positionId:f.p.id,exchange:'bybit',createdAt:now-50_000,
    request:{base:'SAND',symbol:f.p.short.symbol,clientOrderId:'old-request',side:'sell',reduceOnly:false,quantity:1261,limitPrice:.0789},
    result:{id:'original-order',clientOrderId:'old-request',status:'filled',filledQuantity:1261,averagePrice:.07891,feeUsd:.055,timestamp:now-50_000}};
  f.ledger.orders=[structuredClone(order)];f.baseline.orders=[structuredClone(order)];
  f.receipt.ledgerHash=maintenanceLedgerHash(f.baseline);f.receipt.sourceOrdersHash=maintenanceHash(f.baseline.orders);
  f.ledger.orders[0].result!.feeUsd=.056;assert.throws(()=>seal(f),/order journal/);
});

test('sealing permits only independently fetched funding receipts and preserves old fees and quantities',()=>{
  const f=fixture(),payment={exchange:'bybit' as const,id:'native-settlement',base:'SAND',symbol:f.p.short.symbol,side:'short' as const,
    quantity:1261,amountUsd:-.12,timestamp:now-1000};
  f.p.fundingUsd=-.12;f.p.short.fundingUsd=-.12;f.p.short.lastFundingAt=payment.timestamp;
  f.p.fundingEvents.push('bybit:native-settlement');f.ledger.fundingSeen.push('bybit:native-settlement');
  assert.throws(()=>seal(f),/independently read receipt/);
  assert.throws(()=>seal(f,[{...payment,amountUsd:-.11}]),/Financial history/);
  const result=seal(f,[payment]);assert.equal(result.fundingReceiptsObserved,1);assert.equal(result.proof.ledgerHash,maintenanceLedgerHash(f.ledger));
  assert.deepEqual(result.proof.venues,['bitget','bybit']);assert.equal(f.p.status,'open');assert.equal(f.attention.status,'attention');
  f.attention.feesUsd+=.01;assert.throws(()=>seal(f,[payment]),/Financial history/);
});

test('new entry or close activity, source liveness and expired receipts cannot be sealed',()=>{
  for(const state of ['queued','checking','preparing','submitting','reconciling']){
    const f=fixture();f.ledger.manualEntryOperations=[{state} as any];assert.throws(()=>assertMixedMaintenanceIdle(f.ledger));
  }
  const f=fixture();assert.throws(()=>assertMixedMaintenanceIdle(f.ledger,{autoEnabled:false,killSwitch:false,
    manualCloseOperations:[{state:'closing'}]} as any));
  assert.throws(()=>sealMixedMaintenanceHandoff(f.receipt,f.baseline,f.ledger,project,credentialsHash,eligible,false,[],now));
  f.receipt.at=now-120001;assert.throws(()=>seal(f));
});

test('source financial, config and manager changes reject sealing even when the order list is unchanged',()=>{
  for(const change of ['config','fee','quantity','promote-attention','source-baseline']){
    const f=fixture();
    if(change==='config')f.ledger.config.leverage++;
    if(change==='fee')f.p.feesUsd+=.01;
    if(change==='quantity')f.p.long.quantity--;
    if(change==='promote-attention')f.attention.status='open';
    if(change==='source-baseline')f.baseline.positions[0].feesUsd+=.01;
    assert.throws(()=>seal(f),change);
  }
});
