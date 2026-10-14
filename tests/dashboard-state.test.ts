import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardState} from '../src/shared/dashboard-state.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AppState,Opportunity} from '../src/shared/types.js';

function fixture():AppState {
  return {
    timestamp:123,config:{...defaultConfig,mode:'live',dataSource:'public'},
    opportunities:[
      {id:'BTC-gate-bybit',base:'BTC',entryReady:true,eligible:false,entryLimitPriceEdgeBps:21,
        reasons:['未授权'],checks:[{group:'account',label:'两腿交易账户已授权',pass:false,reason:'未授权'}],
        spreadAdvantage:{status:'ready',expectedSpreadPnlUsd:1},historicalSpreadAdvantage:{status:'warming'}} as Opportunity,
      {id:'ETH-bybit-gate',base:'ETH',entryReady:false,eligible:false,entryLimitPriceEdgeBps:-10,reasons:['价差不利']} as Opportunity,
    ],
    snapshots:[{exchange:'gate',base:'BTC',bids:[{price:100,quantity:1},{price:99,quantity:2}],
      asks:[{price:101,quantity:1},{price:102,quantity:2}]}],
    positions:[{id:'held'}],equity:[{timestamp:1,netPnlUsd:-1},{timestamp:2,netPnlUsd:1}],logs:[{id:'log'}],
    livePortfolio:{exchanges:[{exchange:'gate',positions:[{base:'BTC',quantity:3}]}]},
    autoEnabled:false,liveUnlocked:true,killSwitch:false,
    unconfirmedOrders:[{positionId:'held',exchange:'gate'}],liveReadiness:{unlocked:true},
  } as unknown as AppState;
}

test('public dashboard omits duplicate evidence without changing opportunity identity or readiness',()=>{
  const original=fixture(),view=dashboardState(original);
  assert.notEqual(view,original);
  assert.equal(view.opportunities.length,original.opportunities.length);
  for(let i=0;i<original.opportunities.length;i++){
    const {checks,spreadAdvantage,historicalSpreadAdvantage,...rest}=original.opportunities[i];
    assert.deepEqual(view.opportunities[i],rest);
  }
  assert.equal(view.opportunities.filter(row=>row.entryReady??row.eligible).length,1);
  assert.equal(original.opportunities[0].checks?.[0].pass,false);
  assert.ok(original.opportunities[0].spreadAdvantage);
});

test('dashboard preserves full depth, positions, history, balances and execution permission',()=>{
  const original=fixture(),view=dashboardState(original);
  for(const key of Object.keys(original) as Array<keyof AppState>){
    if(key!=='opportunities')assert.equal(view[key],original[key],key);
  }
  assert.equal(view.snapshots[0].bids.length,2);
  assert.equal(view.snapshots[0].asks.length,2);
});

test('demo opportunity detail retains the complete entry evidence',()=>{
  const original=fixture();original.config={...original.config,dataSource:'demo',mode:'paper'};
  assert.equal(dashboardState(original),original);
});
