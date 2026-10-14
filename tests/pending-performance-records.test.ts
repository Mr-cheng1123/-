import test from 'node:test';
import assert from 'node:assert/strict';
import type {AppState,Position} from '../src/shared/types.js';
import type {PerformanceRow} from '../src/shared/performance-types.js';
import {summarizePerformanceRows} from '../src/shared/performance-aggregation.js';
import {pendingPerformanceRecords} from '../web/src/pending-performance-records.js';

const now=10_000;
const row=(id:string,category:PerformanceRow['category']='pending'):PerformanceRow=>({id,base:'AAA',category,reason:'历史成交未确认',
  openedAt:1000,closed:false,fundingUsd:.2,feesUsd:.1,spreadPnlUsd:null,transferCostUsd:0,netPnlUsd:null,
  estimatedFeeRebateUsd:.07,estimatedNetPnlAfterRebateUsd:null});
const position=(id:string):Position=>({id,base:'AAA',mode:'live',status:'attention',openedAt:1000,plannedExitAt:20_000,
  holdMode:'adaptive',fundingUsd:.2,feesUsd:.1,spreadPnlUsd:999,transferCostUsd:0,netPnlUsd:999,realizedSpreadPnlUsd:0,
  deltaUsd:0,fundingEvents:[],riskReasons:['原单待确认'],accountClosure:{confirmedAt:5000,reason:'独立原生双空',historicalOrdersPending:true},
  long:{exchange:'gate',symbol:'AAA/USDT:USDT',side:'long',quantity:10,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null},
  short:{exchange:'bybit',symbol:'AAA/USDT:USDT',side:'short',quantity:10,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null}});
const input=()=>({positions:[position('old')],unconfirmedOrders:[{positionId:'old',exchange:'gate' as const,historical:true}]});

test('verified ended exposure moves only the display row to historical pending and preserves all unknown cash',()=>{
  const state=input(),summary=summarizePerformanceRows([row('old'),row('live'),row('normal','normal')],now),before=structuredClone({state,summary});
  const split=pendingPerformanceRecords(state,summary,now);
  assert.deepEqual(split.archived.map(row=>row.id),['old']);assert.deepEqual(split.current.map(row=>row.id),['live']);
  assert.equal(split.archived[0],summary.rows[0]);assert.equal(split.archived[0].category,'pending');assert.equal(split.archived[0].netPnlUsd,null);
  assert.equal(split.archived[0].feesUsd,.1);assert.equal(split.archived[0].fundingUsd,.2);assert.equal(split.archived[0].estimatedFeeRebateUsd,.07);
  assert.deepEqual({state,summary},before);
});

test('a bare closed flag, local zero or a fresh-looking account without closure is not an archive proof',()=>{
  for(const zero of [false,true]){
    const state=input();delete state.positions[0].accountClosure;state.positions[0].status='closed';
    if(zero){state.positions[0].long.quantity=0;state.positions[0].short.quantity=0;}
    const split=pendingPerformanceRecords(state,summarizePerformanceRows([row('old')],now),now);
    assert.equal(split.archived.length,0);assert.equal(split.current.length,1);
  }
});

test('current or undetermined original order guards keep an ended record in current pending',()=>{
  for(const historical of [false,undefined]){
    const state:{positions:Position[];unconfirmedOrders:AppState['unconfirmedOrders']}={...input(),unconfirmedOrders:[{positionId:'old',exchange:'gate',historical}]};
    assert.equal(pendingPerformanceRecords(state,summarizePerformanceRows([row('old')],now),now).current.length,1);
  }
  const state:{positions:Position[];unconfirmedOrders:AppState['unconfirmedOrders']}={...input(),unconfirmedOrders:undefined};
  assert.equal(pendingPerformanceRecords(state,summarizePerformanceRows([row('old')],now),now).archived.length,0);
});

test('invalid, future, stale-to-activity or wrong-identity closure fields cannot hide a current row',()=>{
  const changes:Array<(p:Position)=>void>=[
    p=>{p.accountClosure!.confirmedAt=0;},p=>{p.accountClosure!.confirmedAt=NaN;},p=>{p.accountClosure!.confirmedAt=now+1;},
    p=>{p.accountClosure!.confirmedAt=999;},p=>{p.closeRequestedAt=5001;},p=>{p.closeAttemptedAt=NaN;},
    p=>{p.base='OTHER';},p=>{p.openedAt=1001;},p=>{p.mode='paper';},
  ];
  for(const change of changes){const state=input();change(state.positions[0]);
    assert.equal(pendingPerformanceRecords(state,summarizePerformanceRows([row('old')],now),now).archived.length,0);
  }
  const ambiguous=input();ambiguous.positions.push(structuredClone(ambiguous.positions[0]));
  assert.equal(pendingPerformanceRecords(ambiguous,summarizePerformanceRows([row('old')],now),now).archived.length,0);
});
