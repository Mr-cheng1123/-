import test from 'node:test';
import assert from 'node:assert/strict';
import {projectPositionFeeRebate} from '../src/shared/position-fee-rebates.js';
import type {AppConfig,JournalOrder,Position} from '../src/shared/types.js';

const config:Pick<AppConfig,'feeRebatePct'>={feeRebatePct:{gate:70,bitget:50}};
function position(longFee=.1,shortFee=.2):Position{return {id:'test-position',base:'ONE',status:'open',mode:'live',
  long:{exchange:'gate',symbol:'ONE/USDT:USDT',side:'long',quantity:10,entryPrice:1,markPrice:1,feesUsd:longFee,liquidationDistancePct:null},
  short:{exchange:'bitget',symbol:'ONE/USDT:USDT',side:'short',quantity:10,entryPrice:1,markPrice:1,feesUsd:shortFee,liquidationDistancePct:null},
  openedAt:1,plannedExitAt:2,holdMode:'adaptive',fundingUsd:0,feesUsd:longFee+shortFee,transferCostUsd:0,
  spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:-longFee-shortFee,deltaUsd:0,fundingEvents:[],riskReasons:[]};}
function order(exchange:'gate'|'bitget',feeUsd:number,clientOrderId=`${exchange}-entry`):JournalOrder{return {positionId:'test-position',exchange,
  request:{symbol:'ONE/USDT:USDT',base:'ONE',side:exchange==='gate'?'buy':'sell',quantity:10,limitPrice:1,reduceOnly:false,clientOrderId},
  result:{id:`native-${clientOrderId}`,clientOrderId,status:'filled',filledQuantity:10,averagePrice:1,feeUsd,timestamp:1},createdAt:1};}
const near=(actual:number|undefined,expected:number)=>{assert.equal(typeof actual,'number');assert.ok(Math.abs(actual!-expected)<1e-14,`${actual} != ${expected}`);};

test('latest cumulative booked charges generate one venue-specific rebate without mutating cash',()=>{
  const p=position(),orders=[order('gate',.1),order('bitget',.2)],before=JSON.stringify({p,orders,config});
  near(projectPositionFeeRebate(p,orders,config),.17);near(projectPositionFeeRebate(p,orders,config),.17);
  assert.equal(JSON.stringify({p,orders,config}),before);
});
test('complete mixed positive and negative native fees use the positive charges rather than net-leg fees',()=>{
  const p=position(.1,.2),orders=[order('gate',.3,'gate-positive'),order('gate',-.2,'gate-native-credit'),order('bitget',.2)];
  near(projectPositionFeeRebate(p,orders,config),.31);
});
test('metadata selects the already booked fee when a later cumulative result has not been booked',()=>{
  const p=position(),gate=order('gate',.15);gate.executionEvidence={version:1,method:'ioc',role:'entry',batchId:'batch',bookedFeeUsd:.1};
  near(projectPositionFeeRebate(p,[gate,order('bitget',.2)],config),.17);
});
test('a prior calculated projection is not used after the configured percentages change',()=>{
  const p=position();p.estimatedFeeRebateUsd=999;
  near(projectPositionFeeRebate(p,[order('gate',.1),order('bitget',.2)],{feeRebatePct:{gate:10,bitget:20}}),.05);
});
test('legacy positions without an order journal use the explicitly conservative net-leg fallback',()=>{
  const p=position(-.1,.2);p.estimatedFeeRebateUsd=null;
  near(projectPositionFeeRebate(p,[],config),.1);
});
test('a wholly missing leg journal makes the whole fallback conservative, including a known mixed-fee leg',()=>{
  near(projectPositionFeeRebate(position(.1,.2),[order('gate',.3,'charge'),order('gate',-.2,'credit')],config),.17);
});
test('known zero fee legs need no fabricated journal',()=>{near(projectPositionFeeRebate(position(0,0),[],config),0);});
test('disabled rebates return zero without granting native fee or order permission',()=>{
  const unknown=order('gate',NaN);unknown.result!.status='unknown';
  near(projectPositionFeeRebate(position(),[unknown],{}),0);assert.equal(unknown.result!.status,'unknown');
  assert.equal(projectPositionFeeRebate(position(NaN,.2),[],{}),undefined);
});
for(const mutation of ['unknown-fee','invalid-booked-fee','unknown-order','wrong-symbol','wrong-side','wrong-base','wrong-client','overfill'] as const)
  test(`known ${mutation} evidence cannot obtain a fallback rebate`,()=>{
    const p=position(),gate=order('gate',.1);
    if(mutation==='unknown-fee')gate.result!.feeUsd=NaN;
    if(mutation==='invalid-booked-fee')gate.executionEvidence={version:1,method:'ioc',role:'entry',batchId:'batch',bookedFeeUsd:NaN};
    if(mutation==='unknown-order')gate.result!.status='unknown';
    if(mutation==='wrong-symbol')gate.request.symbol='OTHER/USDT:USDT';
    if(mutation==='wrong-side')gate.request.side='sell';
    if(mutation==='wrong-base')gate.request.base='OTHER';
    if(mutation==='wrong-client')gate.result!.clientOrderId='foreign';
    if(mutation==='overfill')gate.result!.filledQuantity=11;
    assert.equal(projectPositionFeeRebate(p,[gate,order('bitget',.2)],config),undefined);
  });
test('duplicate client and native IDs cannot double the rebate, including foreign position ownership',()=>{
  const p=position(),gate=order('gate',.1),peer=order('bitget',.2);
  assert.equal(projectPositionFeeRebate(p,[gate,{...gate},peer],config),undefined);
  const duplicate=order('gate',.1,'other-client');duplicate.result!.id=gate.result!.id;
  assert.equal(projectPositionFeeRebate(p,[gate,duplicate,peer],config),undefined);
  duplicate.positionId='foreign-position';assert.equal(projectPositionFeeRebate(p,[gate,duplicate,peer],config),undefined);
});
test('unrelated position fees are never attributed to this holding',()=>{
  const foreign=order('gate',900,'foreign');foreign.positionId='foreign-position';
  near(projectPositionFeeRebate(position(),[order('gate',.1),order('bitget',.2),foreign],config),.17);
});
test('journal signed totals and aggregate position fees must agree with the original booked gross cash',()=>{
  assert.equal(projectPositionFeeRebate(position(),[order('gate',.11),order('bitget',.2)],config),undefined);
  const p=position();p.feesUsd+=.001;assert.equal(projectPositionFeeRebate(p,[],config),undefined);
});
test('only explicitly booked active Maker cash can project a rebate before terminal',()=>{
  const p=position(),gate=order('gate',.1);gate.request.side='sell';gate.request.reduceOnly=true;gate.request.postOnly=true;
  gate.result!.status='unknown';gate.executionEvidence={version:1,method:'maker',role:'exit',batchId:'batch',bookedFeeUsd:.1};
  gate.makerReduction={activity:'active',bookedExecution:true} as JournalOrder['makerReduction'];
  near(projectPositionFeeRebate(p,[gate,order('bitget',.2)],config),.17);
  gate.makerReduction!.bookedExecution=false;assert.equal(projectPositionFeeRebate(p,[gate,order('bitget',.2)],config),undefined);
});
test('proven local zero no-submit receipts do not manufacture cash or block the existing complete rebate',()=>{
  const zero=order('gate',0,'not-submitted');zero.result={id:'',clientOrderId:zero.request.clientOrderId,status:'cancelled',filledQuantity:0,
    averagePrice:0,feeUsd:0,timestamp:1,rejectionCode:'PRE_SUBMISSION_CHECK_FAILED'};
  near(projectPositionFeeRebate(position(),[order('gate',.1),order('bitget',.2),zero],config),.17);
  delete zero.result.rejectionCode;assert.equal(projectPositionFeeRebate(position(),[order('gate',.1),order('bitget',.2),zero],config),undefined);
});
