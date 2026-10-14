import assert from 'node:assert/strict';
import test from 'node:test';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountPosition,AppState,Position} from '../src/shared/types.js';
import {accountPositionKey} from '../web/src/account-position-identity.js';
import {ledgerAccountProjection} from '../web/src/ledger-account-projection.js';
import {ledgerPositionMetrics} from '../web/src/ledger-position-metrics.js';
import {portfolioPositionSummary} from '../web/src/position-observation.js';

const now=1_000_000;
const holding=(marginMode:'crossed'|'isolated',quantity:number,unrealizedPnlUsd:number,feesUsd:number):AccountPosition=>({
  base:'ONE',symbol:'ONE/USDT:USDT',side:'long',quantity,markPrice:2,liquidationPrice:0,leverage:2,marginMode,
  entryPrice:1,unrealizedPnlUsd,realizedPnlUsd:0,fundingUsd:0,feesUsd});
const state=():AppState=>({timestamp:now,config:{...structuredClone(defaultConfig),mode:'live'},running:true,autoEnabled:false,
  killSwitch:false,liveUnlocked:false,opportunities:[],exchanges:[],logs:[],equity:[],snapshots:[],positions:[],
  totals:{fundingUsd:0,feesUsd:0,spreadPnlUsd:0,netPnlUsd:0,grossExposureUsd:0,availableBalanceUsd:0,openPositions:0},
  risk:{status:'healthy',reasons:[]},livePortfolio:{timestamp:now,pollIntervalMs:5000,maxAgeMs:15000,exchanges:[
    {exchange:'gate',credentialsConfigured:true,status:'ready',requestedAt:now-100,receivedAt:now-50,freeUsd:20,
      positions:[holding('isolated',100,5,.2),holding('crossed',25,-2,.05)]},
    {exchange:'bitget',credentialsConfigured:true,status:'ready',requestedAt:now-100,receivedAt:now-50,freeUsd:30,
      positions:[{...holding('crossed',100,-1,.1),side:'short'}]}
  ]}});
const near=(actual:number|undefined,expected:number)=>assert.ok(actual!==undefined&&Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);
const aggregate=(positions:Position[],s:AppState)=>positions.map(position=>ledgerPositionMetrics(position,s.livePortfolio,now));

test('Gate margin partitions without native IDs keep their own quantities and cash, once per account row',()=>{
  const s=state(),before=structuredClone(s),records=ledgerAccountProjection(s,now),metrics=aggregate(records.map(record=>record.position),s);
  assert.equal(records.length,2);assert.deepEqual(metrics.map(metric=>metric.long.quantity).sort((a,b)=>a!-b!),[25,100]);
  const legs=metrics.map(metric=>metric.long);
  assert.deepEqual(legs.map(leg=>[leg.quantity,leg.unrealizedPnlUsd,leg.feesUsd]).sort((a,b)=>a[0]!-b[0]!),[[25,-2,.05],[100,5,.2]]);
  near(metrics.reduce((sum,metric)=>sum+metric.unrealizedPnlUsd!,0),2);
  near(metrics.reduce((sum,metric)=>sum+metric.feesUsd!,0),.35);
  assert.deepEqual(metrics.map(metric=>metric.observation.longQuantity).sort((a,b)=>a!-b!),[25,100]);
  const summary=portfolioPositionSummary(s.livePortfolio,now);
  assert.equal(summary.count,3);near(summary.exposureUsd,450);near(summary.unrealizedPnlUsd,2);
  assert.deepEqual(s,before,'Read-only display must not rewrite the saved journal or native observations.');
  const ids=records.map(record=>record.position.id);
  s.livePortfolio!.exchanges[0].positions.reverse();
  assert.deepEqual(ledgerAccountProjection(s,now).map(record=>record.position.id),ids,'Native response ordering must not change display identities.');
});

test('an explicitly mapped strategy consumes its own partition and leaves the other margin row external',()=>{
  const s=state(),pair=ledgerAccountProjection(s,now).find(record=>record.paired)!.position;
  s.positions=[{...pair,id:'managed-isolated',status:'attention'}];
  const records=ledgerAccountProjection(s,now);
  assert.deepEqual(records.map(record=>record.origin),['strategy','account']);
  const metrics=aggregate(records.map(record=>record.position),s);
  assert.equal(metrics[0].long.quantity,100);assert.equal(metrics[1].long.quantity,25);
  near(metrics[0].long.unrealizedPnlUsd,5);near(metrics[1].long.unrealizedPnlUsd,-2);
  near(metrics.reduce((sum,metric)=>sum+metric.unrealizedPnlUsd!,0),2);
  near(metrics.reduce((sum,metric)=>sum+metric.feesUsd!,0),.35);
  assert.notEqual(records[0].position.long.accountPositionKey,records[1].position.long.accountPositionKey);
});

test('a legacy strategy with no partition identity observes the aggregate without also projecting duplicate external cash',()=>{
  const s=state(),pair=ledgerAccountProjection(s,now).find(record=>record.paired)!.position;
  delete pair.long.accountPositionKey;delete pair.short.accountPositionKey;
  s.positions=[{...pair,id:'legacy-strategy'}];
  const records=ledgerAccountProjection(s,now);
  assert.equal(records.length,1);assert.equal(records[0].origin,'strategy');
  const metrics=ledgerPositionMetrics(records[0].position,s.livePortfolio,now);
  assert.equal(metrics.long.quantity,125);near(metrics.long.unrealizedPnlUsd,3);near(metrics.long.feesUsd,.25);
  near(metrics.unrealizedPnlUsd,2);near(metrics.feesUsd,.35);
});

test('native position IDs distinguish same-mode partitions and a removed partition cannot borrow its neighbor metrics',()=>{
  const s=state(),account=s.livePortfolio!.exchanges[0];
  account.positions=[{...holding('isolated',100,5,.2),positionId:'one-a'},{...holding('isolated',25,-2,.05),positionId:'one-b'}];
  const records=ledgerAccountProjection(s,now),pair=records.find(record=>record.paired)!.position;
  assert.equal(pair.long.accountPositionKey,accountPositionKey('gate',account.positions[0]));
  assert.notEqual(pair.long.accountPositionKey,records.find(record=>!record.paired)!.position.long.accountPositionKey);
  account.positions.shift();
  const metrics=ledgerPositionMetrics(pair,s.livePortfolio,now);
  assert.equal(metrics.long.quantity,0);assert.equal(metrics.long.unrealizedPnlUsd,0);assert.equal(metrics.long.feesUsd,undefined);
  assert.equal(metrics.observation.longQuantity,0);
});
