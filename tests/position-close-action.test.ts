import assert from 'node:assert/strict';
import test from 'node:test';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountPosition,AppState,Position} from '../src/shared/types.js';
import {ledgerAccountProjection} from '../web/src/ledger-account-projection.js';
import {finishedManualClose,positionCloseAction} from '../web/src/position-close-action.js';

const now=1_000_000;
function fixture(){
  const row:AccountPosition={base:'ONE',symbol:'ONE/USDT:USDT',side:'long',quantity:55620,
    markPrice:.002,liquidationPrice:0,leverage:2,splitPositionCount:2};
  const state:AppState={timestamp:now,config:{...structuredClone(defaultConfig),mode:'live'},running:true,
    autoEnabled:false,liveUnlocked:false,killSwitch:false,opportunities:[],snapshots:[],exchanges:[],positions:[],logs:[],equity:[],
    totals:{fundingUsd:0,feesUsd:0,spreadPnlUsd:0,netPnlUsd:0,grossExposureUsd:0,availableBalanceUsd:0,openPositions:0},
    risk:{status:'healthy',reasons:[]},unconfirmedOrders:[],livePortfolio:{timestamp:now,pollIntervalMs:5000,maxAgeMs:15000,
      exchanges:[{exchange:'gate',credentialsConfigured:true,status:'ready',requestedAt:now-100,positions:[row]},
        {exchange:'bitget',credentialsConfigured:true,status:'ready',requestedAt:now-100,positions:[{...row,side:'short',splitPositionCount:undefined,marginMode:'crossed'}]}]}};
  return state;
}
test('external actual pair is manually closable while automatic trading is locked, without mutating state',()=>{
  const state=fixture(),before=structuredClone(state),p=ledgerAccountProjection(state,now)[0].position;
  const action=positionCloseAction(p,state,now);
  assert.equal(action.enabled,true);assert.equal(action.external,true);
  assert.deepEqual(action.legs.map(leg=>[leg.exchange,leg.side,leg.quantity]),[['gate','long',55620],['bitget','short',55620]]);
  assert.ok(action.legs.every(leg=>JSON.parse(leg.accountPositionKey)[1]===leg.symbol));
  assert.deepEqual(state,before);
});
test('single actual holding never submits the display-only absent leg',()=>{
  const state=fixture();state.livePortfolio!.exchanges[1].positions=[];
  const p=ledgerAccountProjection(state,now)[0].position,action=positionCloseAction(p,state,now);
  assert.equal(action.enabled,true);assert.equal(action.legs.length,1);
  assert.equal(action.legs[0].quantity,55620);assert.ok(!action.legs[0].symbol.includes('#'));
});
test('owned attention position also closes from account quantities without global unlock',()=>{
  const state=fixture(),p={...ledgerAccountProjection(state,now)[0].position,id:'old-journal'};
  p.long.quantity=27810;p.short.quantity=27810;state.positions=[p];
  const action=positionCloseAction(p,state,now);
  assert.equal(action.enabled,true);assert.equal(action.external,false);assert.equal(action.legs[0].quantity,55620);
  assert.equal(p.long.quantity,27810);
});
test('stale reads and in-flight same-coin orders show precise reasons, unrelated coins do not block',()=>{
  const state=fixture(),p=ledgerAccountProjection(state,now)[0].position;
  assert.match(positionCloseAction(p,state,now+16000).reason!,/待刷新/);
  const current={...p,id:'owned'};state.positions=[current];
  state.unconfirmedOrders=[{positionId:'owned',exchange:'gate'}];
  assert.match(positionCloseAction(p,state,now).reason!,/未确认订单/);
  state.unconfirmedOrders=[{positionId:'unrelated',exchange:'gate'}];
  assert.equal(positionCloseAction(p,state,now).enabled,true);
});
test('current cycle and archived records cannot be closed using old journal identity',()=>{
  const state=fixture(),p={...ledgerAccountProjection(state,now)[0].position,id:'old',openedAt:1};
  state.livePortfolio!.exchanges[0].positions[0].positionOpenedAt=now-1000;
  assert.match(positionCloseAction(p,state,now).reason!,/新的开仓周期/);
  p.accountClosure={confirmedAt:now-500,reason:'flat',historicalOrdersPending:false};
  assert.equal(positionCloseAction(p,state,now).enabled,false);
});

function completedResidual(){
  const state=fixture(),position:Position={...ledgerAccountProjection(state,now)[0].position,id:'owned',
    status:'closing',manualCloseOnly:true,manualCloseOperationId:'close-request-1',closeAttemptedAt:now-200};
  state.positions=[position];
  state.manualCloseOperations=[{id:'close-request-1',state:'completed',positionId:position.id,createdAt:now-300}];
  return {state,position};
}

test('completed manual request with remaining holdings permits a new explicit selection without rewriting the journal',()=>{
  const {state,position}=completedResidual(),before=structuredClone(state);
  const action=positionCloseAction(position,state,now);
  assert.equal(action.enabled,true);assert.equal(action.external,false);
  assert.deepEqual(action.legs.map(leg=>leg.quantity),[55620,55620]);assert.deepEqual(state,before);
  state.livePortfolio!.exchanges[0].positions[0].quantity=106;
  state.livePortfolio!.exchanges[1].positions[0].quantity=106;
  assert.deepEqual(positionCloseAction(position,state,now).legs.map(leg=>leg.quantity),[106,106]);
  assert.equal(position.long.quantity,55620,'A new selection uses current native holdings, without editing original ledger quantities.');
  assert.equal(positionCloseAction(position,state,now+16000).enabled,false,'Completion is not permission to use stale account quantities.');
});

test('ordinary closing and mismatched or duplicated completion receipts remain blocked',()=>{
  const {state,position}=completedResidual();
  position.manualCloseOnly=false;assert.equal(positionCloseAction(position,state,now).enabled,false);
  position.manualCloseOnly=true;state.manualCloseOperations![0].positionId='another-position';
  assert.equal(positionCloseAction(position,state,now).enabled,false);
  state.manualCloseOperations![0].positionId=position.id;
  state.manualCloseOperations!.push({...state.manualCloseOperations![0]});
  assert.equal(positionCloseAction(position,state,now).enabled,false);
  state.manualCloseOperations=[];assert.equal(positionCloseAction(position,state,now).enabled,false,'Missing receipt cannot unlock a closing position.');
});

test('current same-coin orders and active manual requests outweigh a completed receipt',()=>{
  const {state,position}=completedResidual();
  state.positions.push({...position,id:'same-coin-record',status:'attention'});
  state.unconfirmedOrders=[{positionId:'same-coin-record',exchange:'gate'}];
  assert.equal(positionCloseAction(position,state,now).enabled,false);
  state.unconfirmedOrders[0].historical=true;assert.equal(positionCloseAction(position,state,now).enabled,true);
  position.manualCloseSourcePositionId='source-outside-dashboard';
  state.unconfirmedOrders=[{positionId:'source-outside-dashboard',exchange:'gate'}];
  assert.equal(positionCloseAction(position,state,now).enabled,false,'Current orders on the exact source journal still block when its row is not returned.');
  state.unconfirmedOrders=[];
  for(const active of [
    {id:'other-close',state:'checking' as const,positionId:'same-coin-record',createdAt:now},
    {id:'other-close',state:'closing' as const,positionId:position.id,createdAt:now},
    {id:'unbound-close',state:'checking' as const,createdAt:now},
  ]){
    state.manualCloseOperations!.push(active);
    assert.equal(positionCloseAction(position,state,now).enabled,false);
    state.manualCloseOperations!.pop();
  }
  state.positions.push({...position,id:'other-coin-record',base:'OTHER',status:'attention'});
  state.manualCloseOperations!.push({id:'unrelated-close',state:'closing',positionId:'other-coin-record',createdAt:now});
  assert.equal(positionCloseAction(position,state,now).enabled,true,'A bound request for another coin does not block this selection.');
});

test('truncated dashboard receipts require the exact terminal manual position, and allow an external row of the same coin',()=>{
  const {state,position}=completedResidual();state.manualCloseOperations=[];
  position.status='attention';
  assert.equal(finishedManualClose(position,state,'close-request-1'),true);
  assert.equal(finishedManualClose(position,state,'old-request'),false);
  position.manualCloseOnly=false;assert.equal(finishedManualClose(position,state,'close-request-1'),false);
  position.manualCloseOnly=true;position.status='closing';
  state.manualCloseOperations=[{id:'close-request-1',state:'completed',positionId:position.id,createdAt:now-300}];
  const external=ledgerAccountProjection({...state,positions:[]},now)[0].position;
  assert.equal(positionCloseAction(external,state,now).enabled,true);
  state.manualCloseOperations[0].state='closing';assert.equal(positionCloseAction(external,state,now).enabled,false);
});

test('resumed holding after a suspended economic exit permits manual closing from fresh remaining quantities',()=>{
  for(const base of ['ARK','OTHER']){
    const state=fixture(),position:Position={...ledgerAccountProjection(state,now)[0].position,id:`owned-${base}`,base,status:'open',
      automaticCloseHistory:[{requestedAt:now-500,attemptedAt:now-400,suspendedAt:now-300,reason:'曾预计资金费支出大于平仓成本',
        suspensionReason:'本轮资金费已恢复正值',longQuantity:60,shortQuantity:60,pricing:'best-opposite'}]};
    for(const leg of [position.long,position.short]){leg.symbol=`${base}/USDT:USDT`;leg.quantity=60;delete leg.accountPositionKey;}
    for(const account of state.livePortfolio!.exchanges)for(const row of account.positions){row.base=base;row.symbol=`${base}/USDT:USDT`;row.quantity=60;}
    state.positions=[position];
    const before=structuredClone(state),action=positionCloseAction(position,state,now);
    assert.equal(action.enabled,true,base);assert.deepEqual(action.legs.map(leg=>leg.quantity),[60,60]);
    assert.deepEqual(state,before,'Showing a fresh manual selection cannot rewrite fills or the saved exit attempt.');
    state.unconfirmedOrders=[{positionId:position.id,exchange:'gate'}];
    assert.equal(positionCloseAction(position,state,now).enabled,false);
    assert.match(positionCloseAction(position,state,now).reason!,/未确认订单/);
    state.unconfirmedOrders=[];
    assert.equal(positionCloseAction(position,state,now+16000).enabled,false,'Suspending an economic exit does not waive account freshness.');
  }
});

test('an automatic close still awaiting backend reconciliation remains protected with an accurate reason',()=>{
  const {state,position}=completedResidual();
  position.manualCloseOnly=false;delete position.manualCloseOperationId;state.manualCloseOperations=[];
  position.closeProfitRequired=true;
  position.holdDecision={action:'hold',reason:'本轮资金费恢复正值',expectedFundingUsd:.2,incrementalCostUsd:0,
    expectedNetUsd:.2,nextReviewAt:now+1000,targetFundingTime:now+10000};
  assert.equal(positionCloseAction(position,state,now).enabled,false);
  assert.match(positionCloseAction(position,state,now).reason!,/自动退出条件待复核/);
  state.unconfirmedOrders=[{positionId:position.id,exchange:'gate'}];
  assert.match(positionCloseAction(position,state,now).reason!,/未确认订单/,'Actual unknown orders take priority over a saved closing intent.');
  state.unconfirmedOrders=[];position.short.quantity-=1;
  assert.match(positionCloseAction(position,state,now).reason!,/残余数量待处理/,'An unmatched tail cannot be unlocked by positive funding.');
  position.short.quantity=position.long.quantity;position.closeProfitRequired=false;
  assert.match(positionCloseAction(position,state,now).reason!,/平仓流程尚未结束/,'Explicit manual and emergency exits retain their protection.');
});
