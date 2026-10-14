import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {performanceSummary} from '../src/core/performance-summary.js';
import type {AppState,JournalOrder,Position} from '../src/shared/types.js';
import {ledgerClosedRebate} from '../web/src/ledger-closed-rebate.js';
import LedgerClosedNet from '../web/src/LedgerClosedNet.js';
const near=(actual:number,expected:number)=>assert(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);
function fixture(){
  const p:Position={id:'bz-closed',base:'BZ',mode:'live',status:'closed',openedAt:1000,closedAt:2000,plannedExitAt:2000,holdMode:'adaptive',entryPolicy:'aligned',
    long:{exchange:'gate',symbol:'BZ/USDT:USDT',side:'long',quantity:0,entryPrice:1,markPrice:1,feesUsd:.0987456,liquidationDistancePct:null},
    short:{exchange:'bitget',symbol:'BZ/USDT:USDT',side:'short',quantity:0,entryPrice:1.01,markPrice:1.01,feesUsd:.11870208,liquidationDistancePct:null},
    fundingUsd:.0972990048,feesUsd:.21744768,transferCostUsd:0,realizedSpreadPnlUsd:.096,spreadPnlUsd:.096,netPnlUsd:-.0241486752,
    deltaUsd:0,fundingEvents:[],riskReasons:[],estimatedFeeRebateUsd:.12847296,estimatedNetPnlAfterRebateUsd:.1043242848};
  const orders:JournalOrder[]=(['long','short'] as const).flatMap(side=>[false,true].map(reduceOnly=>{
    const leg=p[side],clientOrderId=`${side}-${reduceOnly?'close':'open'}`,price=side==='long'?reduceOnly?1.0096:1:1.01;
    const request={clientOrderId,base:p.base,symbol:leg.symbol,side:(side==='long'?(reduceOnly?'sell':'buy'):(reduceOnly?'buy':'sell')) as 'buy'|'sell',quantity:10,limitPrice:price,reduceOnly};
    return {positionId:p.id,exchange:leg.exchange,createdAt:reduceOnly?1900:1000,request,
      result:{id:`native-${clientOrderId}`,clientOrderId,status:'filled' as const,filledQuantity:10,averagePrice:price,averagePriceVerified:true,feeUsd:leg.feesUsd/2,timestamp:reduceOnly?1901:1001}};
  }));
  const config={feeRebatePct:{gate:70,bitget:50}},performance=performanceSummary([p],orders,3000,config);
  return {p,orders,config,state:{performance,unconfirmedOrders:[]} as Pick<AppState,'performance'|'unconfirmedOrders'>};
}

test('closed complete original cash can be negative while exact projected rebates produce positive lifecycle profit',()=>{
  const f=fixture(),before=structuredClone(f),value=ledgerClosedRebate(f.p,f.state.performance?.rows,f.state.unconfirmedOrders);assert(value);
  near(value.cashNetPnlUsd,-.0241486752);near(value.grossFeesUsd,.21744768);near(value.estimatedFeeRebateUsd,.12847296);
  near(value.estimatedNetPnlAfterRebateUsd,.1043242848);assert.deepEqual(f,before);
});

test('the visible closed primary amount and color follow projected profit while original cash fees and unaudited rebate status stay explicit',()=>{
  const f=fixture(),html=renderToStaticMarkup(createElement(LedgerClosedNet,{position:f.p,state:f.state,grossNet:f.p.netPnlUsd,showRebates:true}));
  assert.match(html,/<b class="positive" data-testid="ledger-close-net">\+\$0\.10<\/b>/);
  assert.match(html,/返佣后估算 · 完整开平成交/);assert.match(html,/实账净收益（返佣前）/);
  assert.match(html,/<b class="negative">−\$0\.02<\/b>/);assert.match(html,/实账手续费 \$0\.22/);
  assert.match(html,/预计返佣 \+\$0\.13/);assert.match(html,/未确认为到账现金/);
});

for(const missing of ['unknown-order','fee','price','missing-orders','source-proof','derived-rebate-only'] as const)
test(`${missing} cannot manufacture a completed estimated profit from a derived position value`,()=>{
  const f=fixture();
  if(missing==='unknown-order'){f.orders[0].result!.status='unknown';f.state.unconfirmedOrders=[{positionId:f.p.id,exchange:'gate'}];}
  else if(missing==='fee')f.orders[0].result!.feeUsd=NaN;
  else if(missing==='price')f.orders[0].result!.averagePriceVerified=false;
  else if(missing==='missing-orders')f.orders=[];
  else if(missing==='source-proof')f.state.performance=undefined;
  else f.state.performance!.rows=[];
  if(!['source-proof','derived-rebate-only'].includes(missing))f.state.performance=performanceSummary([f.p],f.orders,3000,f.config);
  assert.equal(ledgerClosedRebate(f.p,f.state.performance?.rows,f.state.unconfirmedOrders),undefined);
  const html=renderToStaticMarkup(createElement(LedgerClosedNet,{position:f.p,state:f.state,grossNet:f.p.netPnlUsd,showRebates:true}));
  assert(!html.includes('返佣后估算 · 完整开平成交'));assert.match(html,/原账本记录（返佣前）/);assert.match(html,/不补算缺失现金/);
  assert(!html.includes('+$0.10'));
});

test('duplicate row identity, cycle mismatch and inconsistent projected arithmetic are rejected',()=>{
  for(const change of ['duplicate','cycle','cash','rebate'] as const){const f=fixture(),row=f.state.performance!.rows[0];
    if(change==='duplicate')f.state.performance!.rows.push(structuredClone(row));
    else if(change==='cycle')row.openedAt++;
    else if(change==='cash')row.netPnlUsd!+=1;
    else row.estimatedNetPnlAfterRebateUsd!+=1;
    assert.equal(ledgerClosedRebate(f.p,f.state.performance?.rows,f.state.unconfirmedOrders),undefined);
  }
});

test('disabled rebate policy preserves the clearly labeled original cash amount rather than reusing an old projection',()=>{
  const f=fixture(),html=renderToStaticMarkup(createElement(LedgerClosedNet,{position:f.p,state:f.state,grossNet:f.p.netPnlUsd,showRebates:false}));
  assert.match(html,/<b class="negative" data-testid="ledger-close-net">−\$0\.02<\/b>/);assert.match(html,/原账本记录（返佣前）/);
  assert(!html.includes('返佣后估算'));assert(!html.includes('预计返佣'));
});

test('paper, active, external or unconfirmed closed lifecycles are not silently presented as complete native rebate evidence',()=>{
  for(const change of ['paper','active','external','pending'] as const){const f=fixture();
    if(change==='paper')f.p.mode='paper';else if(change==='active')f.p.status='open';else if(change==='external')f.p.manualCloseAccountRecord=true;
    else f.state.performance!.rows[0].category='pending';
    assert.equal(ledgerClosedRebate(f.p,f.state.performance?.rows,f.state.unconfirmedOrders),undefined);
  }
});
