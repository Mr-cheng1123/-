import test from 'node:test';
import assert from 'node:assert/strict';
import type {JournalOrder,Position} from '../src/shared/types.js';
import type {PerformanceRow} from '../src/shared/performance-types.js';
import {performanceSummary,summarizePerformanceRows} from '../src/core/performance-summary.js';
import {applyPerformanceException} from '../src/shared/performance-exceptions.js';

const now=100000;
function position(id='pair',mode:'live'|'paper'='live'):Position {
  return {id,base:'BTC',mode,status:'attention',long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long',
    quantity:10,entryPrice:100,markPrice:100,feesUsd:.1,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short',quantity:10,entryPrice:101,markPrice:101,feesUsd:.1,liquidationDistancePct:50},
    openedAt:1000,plannedExitAt:now+1000,holdMode:'adaptive',fundingUsd:.3,feesUsd:.2,transferCostUsd:0,
    spreadPnlUsd:999,realizedSpreadPnlUsd:0,netPnlUsd:999,deltaUsd:0,fundingEvents:['native-payment'],
    riskReasons:['实盘进程恢复，等待账户与订单对账']};
}
let serial=0;
function order(p:Position,side:'long'|'short',quantity:number,price:number,reduceOnly=false,
  options:{status?:'filled'|'partial'|'cancelled'|'unknown';requestedQuantity?:number;fee?:number;createdAt?:number}={}):JournalOrder {
  const id=`native-${++serial}`,leg=p[side];
  return {positionId:p.id,exchange:leg.exchange,createdAt:options.createdAt??1000+serial,
    request:{clientOrderId:id,base:p.base,symbol:leg.symbol,side:side==='long'?(reduceOnly?'sell':'buy'):(reduceOnly?'buy':'sell'),
      quantity:options.requestedQuantity??(quantity||10),limitPrice:price||100,reduceOnly},
    result:{id,clientOrderId:id,status:options.status??'filled',filledQuantity:quantity,averagePrice:price,feeUsd:options.fee??.1,
      timestamp:options.createdAt??1000+serial}};
}
const pairOrders=(p:Position)=>[order(p,'long',10,100),order(p,'short',10,101)];
function closedPair(id:string,closedAt=5000):{p:Position;orders:JournalOrder[]} {
  const p=position(id);p.status='closed';p.closedAt=closedAt;p.long.quantity=0;p.short.quantity=0;p.fundingUsd=.1;
  p.feesUsd=999;p.spreadPnlUsd=999;p.netPnlUsd=999;
  const orders=[order(p,'long',10,100),order(p,'short',10,100.1),order(p,'long',10,100,true),order(p,'short',10,100.3,true)];
  return {p,orders};
}
const near=(actual:number|null,expected:number)=>assert.ok(actual!==null&&Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

function reviewedDos():Position {
  const p=position('d0000000-0000-4000-8000-000000000001');p.base='DOS';p.openedAt=1700000000000;
  p.long.exchange='bitget';p.long.symbol='DOS/USDT:USDT';p.short.exchange='gate';p.short.symbol='DOS/USDT:USDT';
  return p;
}

test('reviewed DOS ADL lifecycle leaves all normal totals without erasing its original cash or ordinary losses',()=>{
  const dos=reviewedDos(),otherDos={...structuredClone(dos),id:'another-DOS-lifecycle'},loss=closedPair('ordinary-loss');
  const positions=[dos,otherDos,loss.p],orders=[...pairOrders(dos),...pairOrders(otherDos),...loss.orders];
  const before=structuredClone({positions,orders}),config={feeRebatePct:{gate:70,bitget:50}};
  const summary=performanceSummary(positions,orders,now,config),baseline=performanceSummary([otherDos,loss.p],orders,now,config);
  assert.deepEqual(summary.normal,baseline.normal);assert.deepEqual(summary.closedNormalEquity,baseline.closedNormalEquity);
  assert.equal(summary.normal.count,2);assert.equal(summary.rows.find(row=>row.id===otherDos.id)!.category,'normal');
  assert.equal(summary.rows.find(row=>row.id===loss.p.id)!.category,'normal');
  const row=summary.rows.find(row=>row.id===dos.id)!;
  assert.equal(row.category,'abnormal');assert.equal(row.netPnlUsd,null);assert.equal(row.spreadPnlUsd,null);
  assert.equal(row.estimatedNetPnlAfterRebateUsd,null);near(row.fundingUsd,.3);near(row.feesUsd,.2);
  near(row.estimatedFeeRebateUsd!,.12);assert.match(row.reason,/ADL.*不计入正常策略收益/);
  assert.deepEqual({positions,orders},before);
});

test('the reviewed exception binds the full historical lifecycle, never the ticker, attention or a guessed cause',()=>{
  const dos=reviewedDos(),original=performanceSummary([dos],pairOrders(dos),now).rows[0];
  const changes:Array<(p:Position)=>void>=[
    p=>{p.id='another-DOS';},p=>{p.base='OTHER';},p=>{p.openedAt++;},p=>{p.mode='paper';},
    p=>{p.long.exchange='bybit';},p=>{p.short.exchange='bybit';},
    p=>{p.long.symbol='DOS/USDC:USDC';},p=>{p.short.symbol='OTHER/USDT:USDT';},
    p=>{p.long.side='short';},p=>{p.short.side='long';},p=>{p.manualCloseAccountRecord=true;},
  ];
  for(const change of changes){const p=structuredClone(dos);change(p);
    assert.equal(applyPerformanceException(original,p),original,'An identity mismatch cannot inherit the user exception.');
  }
  for(const change of [(row:PerformanceRow)=>{row.id='other';},(row:PerformanceRow)=>{row.base='OTHER';},
    (row:PerformanceRow)=>{row.openedAt++;}]){
    const row=structuredClone(original);change(row);assert.equal(applyPerformanceException(row,dos),row);
  }
  assert.equal(applyPerformanceException(original,undefined),original);
});

test('reviewed DOS with an unknown native order remains unpriced and the original receipt is not changed',()=>{
  const dos=reviewedDos(),orders=pairOrders(dos);orders[1].result!.status='unknown';
  const before=structuredClone({dos,orders}),summary=performanceSummary([dos],orders,now,{feeRebatePct:{gate:70,bitget:50}});
  assert.equal(summary.rows[0].category,'abnormal');assert.equal(summary.rows[0].netPnlUsd,null);
  assert.equal(summary.rows[0].feesUsd,null);assert.equal(summary.rows[0].estimatedFeeRebateUsd,null);
  assert.equal(summary.normal.count,0);assert.equal(summary.closedNormalEquity.length,0);
  assert.deepEqual({dos,orders},before);assert.equal(orders[1].result!.status,'unknown');
});

test('matched attention holdings remain normal and native cash recomputes stale journal PnL',()=>{
  const p=position(),orders=pairOrders(p),before=structuredClone({p,orders});
  const result=performanceSummary([p],orders,now),row=result.rows[0];
  assert.equal(row.category,'normal');assert.equal(row.closed,false);near(row.spreadPnlUsd,0);near(row.netPnlUsd,.1);
  near(row.feesUsd,.2);assert.equal(result.normal.count,1);assert.equal(result.closedNormalEquity.length,0);
  assert.deepEqual({p,orders},before);
});
test('ordinary closed strategy losses stay normal and use actual opening/closing cash once',()=>{
  const {p,orders}=closedPair('normal-loss');p.transferCostUsd=.02;
  const summary=performanceSummary([p],orders,now),row=summary.rows[0];
  assert.equal(row.category,'normal');assert.equal(row.closed,true);near(row.spreadPnlUsd,-2);near(row.feesUsd,.4);near(row.netPnlUsd,-2.32);
  near(summary.normal.netPnlUsd,-2.32);assert.equal(summary.abnormal.count,0);
});
test('a single-leg entry followed by confirmed compensation is abnormal with its entire realized cost',()=>{
  const p=position('ct-single');p.status='closed';p.closedAt=5000;p.long.quantity=0;p.short.quantity=0;p.fundingUsd=0;
  p.closeReason='另一腿未成交，撤回已确认的单腿敞口';
  const orders=[order(p,'long',160,.5132),order(p,'short',0,0,false,{status:'cancelled',requestedQuantity:160,fee:0}),
    order(p,'long',160,.51109,true)];
  const s=performanceSummary([p],orders,now);assert.equal(s.rows[0].category,'abnormal');assert.equal(s.normal.count,0);
  near(s.abnormal.spreadPnlUsd,-.3376);near(s.abnormal.feesUsd,.2);near(s.abnormal.netPnlUsd,-.5376);
});
test('190 / 106 CT overlap followed by full rollback never counts as completed normal entry',()=>{
  const p=position('ct-overlap');p.status='closed';p.closedAt=5000;p.long.quantity=0;p.short.quantity=0;p.fundingUsd=0;
  p.closeReason='双腿数量无法匹配，撤回已成交仓位';
  const orders=[order(p,'long',190,.5068),order(p,'short',106,.506,false,{status:'partial',requestedQuantity:190}),
    order(p,'long',80,.5052,true),order(p,'long',110,.5052,true),order(p,'short',106,.5052,true)];
  const s=performanceSummary([p],orders,now);assert.equal(s.rows[0].category,'abnormal');assert.equal(s.closedNormalEquity.length,0);
  near(s.abnormal.netPnlUsd,-.7192);
});
test('successful partial supplementation and exact trim retain a normal hedge and their costs',()=>{
  const p=position('trim');p.long.quantity=106;p.short.quantity=106;p.long.markPrice=100;p.short.markPrice=102;
  const orders=[order(p,'long',190,100),order(p,'short',106,102,false,{status:'partial',requestedQuantity:190}),
    order(p,'long',84,100,true)];
  const s=performanceSummary([p],orders,now);assert.equal(s.rows[0].category,'normal');near(s.normal.feesUsd,.3);near(s.normal.spreadPnlUsd,0);
  const supplemented=position('supplemented');supplemented.status='closed';supplemented.closedAt=5000;
  supplemented.long.quantity=0;supplemented.short.quantity=0;
  const filled=[order(supplemented,'long',10,100),order(supplemented,'short',6,101,false,{status:'partial',requestedQuantity:10}),
    order(supplemented,'short',4,101),order(supplemented,'long',10,100,true),order(supplemented,'short',10,101,true)];
  assert.equal(performanceSummary([supplemented],filled,now).rows[0].category,'normal');
});
test('an earlier successful batch remains normal when a later unmatched tail is fully removed',()=>{
  const p=position('batch');p.long.quantity=10;p.short.quantity=10;
  const orders=[...pairOrders(p),order(p,'long',5,100),order(p,'short',0,0,false,{status:'cancelled',fee:0}),order(p,'long',5,99.9,true)];
  p.entryExecution={pricing:'best-opposite',targetQuantity:15,matchedQuantity:10,completedBatches:1,stopReason:'本批尾差撤回，保留先前对冲'};
  const s=performanceSummary([p],orders,now);assert.equal(s.rows[0].category,'normal');near(s.normal.spreadPnlUsd,-.5);near(s.normal.feesUsd,.4);
});
test('archived native flat evidence cannot fabricate missing closing cash',()=>{
  const p=position('archived');p.accountClosure={confirmedAt:5000,reason:'账户空仓',historicalOrdersPending:false};
  const summary=performanceSummary([p],pairOrders(p),now),row=summary.rows[0];
  assert.equal(row.category,'pending');assert.equal(row.netPnlUsd,null);assert.equal(row.spreadPnlUsd,null);
  near(row.fundingUsd,.3);near(row.feesUsd,.2);assert.equal(summary.closedNormalEquity.length,0);assert.equal(summary.pending.includedCount,0);
});
test('complete close flows plus native flat archive produce a normal completed lifecycle',()=>{
  const {p,orders}=closedPair('archived-complete');p.status='attention';p.long.quantity=10;p.short.quantity=10;
  p.accountClosure={confirmedAt:5000,reason:'账户空仓',historicalOrdersPending:false};
  const s=performanceSummary([p],orders,now);assert.equal(s.rows[0].category,'normal');assert.equal(s.rows[0].closed,true);near(s.normal.netPnlUsd,-2.3);
});
test('unknown receipts and terminal mismatched identities remain pending rather than zero-fill',()=>{
  for(const change of [(o:JournalOrder)=>{o.result!.status='unknown';},(o:JournalOrder)=>{o.result!.clientOrderId='another-order';},
    (o:JournalOrder)=>{o.request.symbol='BTC/USDC:USDC';},(o:JournalOrder)=>{o.request.base='ETH';},
    (o:JournalOrder)=>{o.request.side='buy';}]){
    const p=position(),orders=pairOrders(p);change(orders[1]);const s=performanceSummary([p],orders,now);
    assert.equal(s.rows[0].category,'pending');assert.equal(s.rows[0].netPnlUsd,null);assert.equal(s.noFillCount,0);
  }
});
test('all explicit cancelled zero-fill attempts are counted without adding a strategy sample',()=>{
  const p=position('zero');p.status='closed';p.closedAt=5000;p.long.quantity=0;p.short.quantity=0;
  p.fundingUsd=0;p.feesUsd=0;p.spreadPnlUsd=0;p.netPnlUsd=0;
  const orders=[order(p,'short',0,0,false,{status:'cancelled',fee:0}),order(p,'short',0,0,false,{status:'cancelled',fee:0})];
  const s=performanceSummary([p],orders,now);assert.equal(s.rows[0].category,'no_fill');assert.equal(s.noFillCount,1);assert.equal(s.normal.count,0);
  orders[0].result!.status='filled';assert.equal(performanceSummary([p],orders,now).rows[0].category,'pending');
});
test('imported account reductions stay external even with a source ID and known realized cash',()=>{
  const p=position('external');p.manualCloseAccountRecord=true;p.manualCloseSourcePositionId='same-ticker-strategy';
  p.status='closed';p.closedAt=5000;p.long.quantity=0;p.short.quantity=0;p.realizedSpreadPnlUsd=.51856800857;
  const orders=[order(p,'long',20,100,true,{fee:.056976205}),order(p,'short',20,101,true,{fee:.0721002})];
  const s=performanceSummary([p],orders,now);assert.equal(s.rows[0].category,'external');near(s.external.feesUsd,.129076405);
  near(s.external.spreadPnlUsd,.51856800857);assert.equal(s.external.fundingUsd,null);assert.equal(s.external.netPnlUsd,null);
  assert.equal(s.normal.count,0);assert.equal(s.closedNormalEquity.length,0);
});
test('missing prices and fees propagate null while negative official rebates remain negative',()=>{
  const {p,orders}=closedPair('missing');delete (orders[3].result as Partial<JournalOrder['result']> & {feeUsd?:number}).feeUsd;
  const missing=performanceSummary([p],orders,now);assert.equal(missing.normal.netPnlUsd,null);assert.equal(missing.normal.feesUsd,null);
  assert.equal(missing.normal.includedCount,0);assert.equal(missing.closedNormalEquity.length,0);
  orders[3].result!.feeUsd=-.2;const rebate=performanceSummary([p],orders,now);near(rebate.normal.feesUsd,.1);near(rebate.normal.netPnlUsd,-2);
  orders[3].result!.averagePriceVerified=false;const unverified=performanceSummary([p],orders,now);
  assert.equal(unverified.normal.spreadPnlUsd,null);assert.equal(unverified.normal.netPnlUsd,null);
});
test('normal closed equity sorts completed lifecycles and excludes failed or unpriced executions',()=>{
  const early=closedPair('earlier-loss',5000),later=closedPair('later-profit',7000);
  later.orders[3].result!.averagePrice=99.8;
  const partial=closedPair('unverified',6000);partial.orders[3].result!.averagePriceVerified=false;
  const s=performanceSummary([later.p,partial.p,early.p],[...later.orders,...partial.orders,...early.orders],now);
  assert.equal(s.closedNormalEquity.length,3);assert.equal(s.closedNormalEquity[0].timestamp,1000);assert.equal(s.closedNormalEquity[0].netPnlUsd,0);
  assert.equal(s.closedNormalEquity[1].timestamp,5000);near(s.closedNormalEquity[1].netPnlUsd,-2.3);
  assert.equal(s.closedNormalEquity[2].timestamp,7000);near(s.closedNormalEquity[2].netPnlUsd,.4);
  assert.equal(s.normal.netPnlUsd,null);assert.equal(s.normal.includedCount,2);near(s.normal.knownNetUsd,.4);
});
test('browser regrouping keeps unknown totals null and never mutates its input rows',()=>{
  const row:PerformanceRow={id:'one',base:'ONE',category:'normal',reason:'paired',closed:false,openedAt:1000,
    fundingUsd:.2,feesUsd:.1,spreadPnlUsd:.3,transferCostUsd:0,netPnlUsd:.4};
  const rows=[row,{...row,id:'missing',spreadPnlUsd:null,netPnlUsd:null}],before=structuredClone(rows);
  const s=summarizePerformanceRows(rows,now);assert.equal(s.normal.count,2);assert.equal(s.normal.includedCount,1);
  near(s.normal.fundingUsd,.4);near(s.normal.feesUsd,.2);assert.equal(s.normal.spreadPnlUsd,null);assert.equal(s.normal.netPnlUsd,null);
  near(s.normal.knownNetUsd,.4);assert.deepEqual(rows,before);
});
test('duplicate cumulative receipts cannot double-count fees or classify a strategy as completed',()=>{
  const p=position(),orders=pairOrders(p);orders.push(structuredClone(orders[0]));
  const s=performanceSummary([p],orders,now);assert.equal(s.rows[0].category,'pending');assert.equal(s.rows[0].feesUsd,null);
});

test('one physical native order referenced by two client intents cannot double-count a closed lifecycle',()=>{
  const {p,orders}=closedPair('reused-native');orders[2].result!.id=orders[0].result!.id;
  const row=performanceSummary([p],orders,now).rows[0];
  assert.equal(row.category,'pending');assert.equal(row.closed,false);assert.equal(row.feesUsd,null);
  assert.equal(row.spreadPnlUsd,null);assert.equal(row.netPnlUsd,null);
});

test('a shared venue symbol native receipt cannot be assigned to two distinct strategy records',()=>{
  const first=closedPair('first-native'),second=closedPair('second-native');second.orders[0].result!.id=first.orders[0].result!.id;
  const before=structuredClone([first,second]),summary=performanceSummary([first.p,second.p],[...first.orders,...second.orders],now);
  assert.deepEqual(summary.rows.map(row=>row.category),['pending','pending']);assert.equal(summary.normal.count,0);
  assert.deepEqual([first,second],before);
});

test('documented create refusals retain known zero cash while internal processing codes with no native ID stay pending',()=>{
  const p=position('create-refusal');p.status='closed';p.long.quantity=0;p.short.quantity=0;
  p.fundingUsd=0;p.feesUsd=0;p.netPnlUsd=0;p.spreadPnlUsd=0;p.realizedSpreadPnlUsd=0;
  const attempted=order(p,'short',0,0,false,{status:'cancelled',fee:0});attempted.result!.id='';attempted.result!.rejectionCode='10001';
  let row=performanceSummary([p],[attempted],now).rows[0];assert.equal(row.category,'no_fill');assert.equal(row.feesUsd,0);
  attempted.result!.rejectionCode='10016';row=performanceSummary([p],[attempted],now).rows[0];
  assert.equal(row.category,'pending');assert.equal(row.feesUsd,null);assert.equal(row.netPnlUsd,null);
});
test('legacy missing fields and invalid quantities become pending without breaking state projection',()=>{
  const malformed={id:'old',base:'BTC',openedAt:1000,fundingUsd:1} as Position;
  const p=position('invalid');p.long.quantity=NaN;const orders=pairOrders(p);
  const s=performanceSummary([malformed,p],orders,now);assert.equal(s.pending.count,2);assert.equal(s.pending.netPnlUsd,null);
  assert.equal(s.rows[0].id,'old');assert.equal(s.rows[0].category,'pending');assert.equal(s.rows[1].category,'pending');
  const broken=position('broken-request');const receipt=order(broken,'long',10,100);delete (receipt as Partial<JournalOrder>).request;
  assert.doesNotThrow(()=>performanceSummary([broken],[receipt],now));
});
test('paper execution receipts use the same normal lifecycle accounting',()=>{
  const {p,orders}=closedPair('paper');p.mode='paper';const s=performanceSummary([p],orders,now);
  assert.equal(s.rows[0].category,'normal');assert.equal(s.rows[0].closed,true);near(s.normal.netPnlUsd,-2.3);
});
test('explicit local pre-submission zero receipts preserve known fees while unknown zero remains pending',()=>{
  const p=position('archive-local-zero');p.accountClosure={confirmedAt:5000,reason:'账户已空仓',historicalOrdersPending:false};
  const orders=pairOrders(p),blocked=order(p,'short',0,0,true,{status:'cancelled',fee:0});
  blocked.result!.id='';blocked.result!.rejectionCode='PRE_SUBMISSION_CHECK_FAILED';orders.push(blocked);
  const s=performanceSummary([p],orders,now);assert.equal(s.rows[0].category,'pending');near(s.pending.feesUsd,.2);
  blocked.result!.rejectionCode='UNPROVEN_ZERO';assert.equal(performanceSummary([p],orders,now).pending.feesUsd,null);
  blocked.result!.status='unknown';blocked.result!.rejectionCode='PRE_SUBMISSION_CHECK_FAILED';
  assert.equal(performanceSummary([p],orders,now).pending.feesUsd,null);
});
test('closed native zero fills retain confirmed cancellation charges and rebates as abnormal execution cash',()=>{
  for(const fee of [.1,-.1,1e-12]){
    const p=position('cancel-cost');p.status='closed';p.long.quantity=0;p.short.quantity=0;p.fundingUsd=0;
    p.feesUsd=fee;p.realizedSpreadPnlUsd=0;p.spreadPnlUsd=0;p.netPnlUsd=-fee;
    const orders=[order(p,'short',0,0,false,{status:'cancelled',fee})];const s=performanceSummary([p],orders,now);
    assert.equal(s.noFillCount,0);assert.equal(s.rows[0].category,'abnormal');assert.equal(s.rows[0].closed,true);
    near(s.abnormal.feesUsd,fee);near(s.abnormal.spreadPnlUsd,0);near(s.abnormal.netPnlUsd,-fee);
    assert.equal(s.closedNormalEquity.length,0,'zero fills never enter normal strategy return or win-rate samples');
    orders[0].result!.status='unknown';const unresolved=performanceSummary([p],orders,now);
    assert.equal(unresolved.rows[0].category,'pending');assert.equal(unresolved.rows[0].netPnlUsd,null);
  }
});

test('configured rebates project confirmed positive fees by venue without rewriting gross cash or closed equity',()=>{
  const {p,orders}=closedPair('rebate-pair');p.short.exchange='bitget';
  for(const item of orders)if(item.exchange==='bybit')item.exchange='bitget';
  const before=structuredClone({p,orders});
  const summary=performanceSummary([p],orders,now,{feeRebatePct:{gate:70,bitget:50}}),row=summary.rows[0];
  near(row.feesUsd,.4);near(row.netPnlUsd,-2.3);near(row.estimatedFeeRebateUsd!,.24);
  near(row.estimatedNetPnlAfterRebateUsd!,-2.06);near(summary.normal.estimatedNetPnlAfterRebateUsd!,-2.06);
  near(summary.closedNormalEquity.at(-1)!.netPnlUsd,-2.3);
  assert.deepEqual({p,orders},before,'Configured rebates must never mutate receipts or become confirmed cash.');
});

test('negative native fees get no second configured rebate and incomplete fee evidence stays unknown',()=>{
  const {p,orders}=closedPair('signed-fees');p.short.exchange='bitget';
  for(const item of orders)if(item.exchange==='bybit')item.exchange='bitget';
  orders[2].result!.feeUsd=-.05;orders[3].result!.feeUsd=-.1;
  const config={feeRebatePct:{gate:70,bitget:50}},complete=performanceSummary([p],orders,now,config).rows[0];
  near(complete.feesUsd,.05);near(complete.estimatedFeeRebateUsd!,.12);
  near(complete.estimatedNetPnlAfterRebateUsd!,complete.netPnlUsd!+.12);
  orders[1].result!.feeUsd=NaN;
  const missing=performanceSummary([p],orders,now,config).rows[0];
  assert.equal(missing.feesUsd,null);assert.equal(missing.estimatedFeeRebateUsd,null);
  assert.equal(missing.estimatedNetPnlAfterRebateUsd,null);
});

test('ambiguous receipts cannot manufacture rebates while legacy configs preserve gross economics',()=>{
  const {p,orders}=closedPair('ambiguous-rebate');
  const legacy=performanceSummary([p],orders,now).rows[0];
  assert.equal(legacy.estimatedFeeRebateUsd,0);assert.equal(legacy.estimatedNetPnlAfterRebateUsd,legacy.netPnlUsd);
  orders.push(structuredClone(orders[0]));
  const ambiguous=performanceSummary([p],orders,now,{feeRebatePct:{gate:70}}).rows[0];
  assert.equal(ambiguous.category,'pending');assert.equal(ambiguous.estimatedFeeRebateUsd,null);
  assert.equal(ambiguous.estimatedNetPnlAfterRebateUsd,null);
});
