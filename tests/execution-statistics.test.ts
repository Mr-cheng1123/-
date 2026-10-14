import test from 'node:test';
import assert from 'node:assert/strict';
import type {JournalOrder,Position} from '../src/shared/types.js';
import type {ExecutionFillEvidence,OrderExecutionEvidence} from '../src/shared/execution-statistics.js';
import {executionStatistics,summarizeExecutionStatisticsRows} from '../src/core/execution-statistics.js';

const now=100_000;
function position(id='pair'):Position {
  return {id,base:'BTC',mode:'live',status:'closed',openedAt:1000,closedAt:4000,plannedExitAt:4000,closeRequestedAt:3000,holdMode:'adaptive',
    long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long',quantity:0,entryPrice:100,markPrice:100,feesUsd:999,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short',quantity:0,entryPrice:101,markPrice:101,feesUsd:999,liquidationDistancePct:null},
    fundingUsd:.3,feesUsd:999,transferCostUsd:0,spreadPnlUsd:999,realizedSpreadPnlUsd:999,netPnlUsd:999,deltaUsd:0,fundingEvents:[],riskReasons:[]};
}
let serial=0;
function order(p:Position,leg:'long'|'short',quantity:number,price:number,at:number,reduceOnly=false,fee=.1):JournalOrder {
  const id=`order-${++serial}`,slot=p[leg];
  return {positionId:p.id,exchange:slot.exchange,createdAt:at,
    request:{clientOrderId:id,base:p.base,symbol:slot.symbol,side:leg==='long'?(reduceOnly?'sell':'buy'):(reduceOnly?'buy':'sell'),
      quantity:quantity||10,limitPrice:price||100,reduceOnly},
    result:{id:`native-${id}`,clientOrderId:id,status:quantity?'filled':'cancelled',filledQuantity:quantity,averagePrice:price,feeUsd:fee,timestamp:at+10}};
}
function pair(id='pair'){
  const p=position(id),orders=[order(p,'long',10,100,1100),order(p,'short',10,101,1120),
    order(p,'long',10,100.2,3000,true),order(p,'short',10,101.1,3020,true)];
  return {p,orders};
}
function evidence(o:JournalOrder,value:Partial<OrderExecutionEvidence>={}){
  o.executionEvidence={version:1,method:'ioc',role:o.request.reduceOnly?'exit':o.request.side==='sell'?'entry':'hedge',batchId:'batch-1',
    referencePrice:o.result!.averagePrice,referenceObservedAt:1000,nativeTakerFeeRate:.001,feeObservedAt:1000,...value};
}
const near=(actual:number|null,expected:number)=>assert.ok(actual!==null&&Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);
const fill=(execId:string,quantity:number,price:number,feeUsd:number,observedAt:number,liquidity:'maker'|'taker'='taker'):ExecutionFillEvidence=>
  ({execId,quantity,price,feeUsd,observedAt,liquidity,feeCurrency:'USDT'});

test('closed IOC profit uses complete native cash and four actual fees, keeps legacy classification and never mutates a ledger',()=>{
  const {p,orders}=pair(),before=structuredClone({p,orders});p.transferCostUsd=.02;before.p.transferCostUsd=.02;
  const s=executionStatistics([p],orders,now),row=s.rows[0];
  assert.equal(row.status,'hedged');assert.equal(row.entryPath,'legacy');assert.equal(row.methodSource,'legacy-ioc');
  near(row.amounts.spreadPnlUsd,1);near(row.amounts.feesUsd,.4);near(row.amounts.closedNetPnlUsd,.88);
  near(s.amounts.closedNetPnlUsd.valueUsd,.88);assert.equal(s.counts.closedKnown,1);assert.deepEqual({p,orders},before);
});

test('a CT single-leg rollback preserves its complete loss and opening/reduction fees as compensation cost',()=>{
  const p=position('ct');p.fundingUsd=0;delete p.closeRequestedAt;
  const orders=[order(p,'long',190,.5068,1100),order(p,'short',0,0,1120,false,0),order(p,'long',190,.5052,1300,true)];
  const s=executionStatistics([p],orders,now),row=s.rows[0];assert.equal(row.status,'abnormal');
  near(row.amounts.spreadPnlUsd,-.304);near(row.amounts.closedNetPnlUsd,-.504);near(row.amounts.rollbackCostUsd,.504);
  assert.equal(s.counts.abnormal,1);assert.equal(s.counts.closedKnown,1);
});

test('a terminal zero-fill attempt is distinct from a closed profitable trade',()=>{
  const p=position('zero');p.fundingUsd=0;p.feesUsd=0;p.spreadPnlUsd=0;p.realizedSpreadPnlUsd=0;p.netPnlUsd=0;
  const s=executionStatistics([p],[order(p,'short',0,0,1100,false,0)],now);
  assert.equal(s.rows[0].status,'no-fill');assert.equal(s.counts.noFill,1);assert.equal(s.counts.closedKnown,0);
  assert.equal(s.amounts.closedNetPnlUsd.knownCount,0);near(s.rows[0].amounts.rollbackCostUsd,0);
});

test('closed zero-fill native charges and rebates remain in confirmed execution profit and rollback costs',()=>{
  for(const fee of [.02,-.01]){
    const p=position('native-zero-cash');p.fundingUsd=0;p.feesUsd=fee;p.spreadPnlUsd=0;p.realizedSpreadPnlUsd=0;p.netPnlUsd=-fee;
    const orders=[order(p,'short',0,0,1100,false,fee)],before=structuredClone({p,orders});
    const s=executionStatistics([p],orders,now),row=s.rows[0];
    assert.equal(row.status,'abnormal');assert.equal(s.counts.noFill,0);assert.equal(s.counts.hedged,0);assert.equal(s.counts.closedKnown,1);
    near(row.amounts.feesUsd,fee);near(row.amounts.spreadPnlUsd,0);near(row.amounts.closedNetPnlUsd,-fee);near(row.amounts.rollbackCostUsd,fee);
    near(s.amounts.closedNetPnlUsd.valueUsd,-fee);near(s.amounts.rollbackCostUsd.valueUsd,fee);
    near(s.groups[0].amounts.closedNetPnlUsd.valueUsd,-fee);assert.deepEqual({p,orders},before);
  }
});

test('a locally rejected invalid Maker selector has no native order or invented fee',()=>{
  const p=position('invalid-maker');p.fundingUsd=0;p.feesUsd=0;p.spreadPnlUsd=0;p.realizedSpreadPnlUsd=0;p.netPnlUsd=0;
  const attempted=order(p,'short',0,0,1120,false,0);attempted.request.postOnly=true;
  attempted.result!.id='';attempted.result!.rejectionCode='INVALID_MAKER_ORDER';
  evidence(attempted,{method:'maker'});
  const row=executionStatistics([p],[attempted],now).rows[0];
  assert.equal(row.status,'no-fill');assert.equal(row.orders[0].filledQuantity,0);assert.equal(row.orders[0].feeUsd,0);
  assert.equal(row.orders[0].makerFeeSavingUsd,0);
});

test('unknown or duplicated cumulative receipts cannot become zero losses or double-count an actual Maker saving',()=>{
  const {p,orders}=pair('unknown');orders[1].result!.status='unknown';
  let s=executionStatistics([p],orders,now);assert.equal(s.rows[0].status,'pending');assert.equal(s.amounts.closedNetPnlUsd.valueUsd,null);
  assert.equal(s.amounts.closedNetPnlUsd.unknownCount,1);assert.equal(s.rows[0].amounts.rollbackCostUsd,null);
  orders[1].result!.status='filled';orders.push(structuredClone(orders[0]));s=executionStatistics([p],orders,now);
  assert.equal(s.rows[0].status,'pending');assert.equal(s.rows[0].amounts.feesUsd,null);
  assert.equal(new Set(s.rows[0].orders.map(row=>row.key)).size,s.rows[0].orders.length);
});

test('a reused native order ID invalidates cash, slippage and Maker savings instead of duplicating physical fills',()=>{
  const {p,orders}=pair('native-identity-collision');evidence(orders[0]);evidence(orders[2]);
  orders[2].result!.id=orders[0].result!.id;
  const row=executionStatistics([p],orders,now).rows[0];
  assert.equal(row.status,'pending');assert.equal(row.amounts.closedNetPnlUsd,null);assert.equal(row.amounts.feesUsd,null);
  assert.equal(row.orders[0].filledQuantity,null);assert.equal(row.orders[2].filledQuantity,null);assert.equal(row.slippageUsd,null);
});

test('historical cash can be reconstructed while absent quote, confirmation and fill clocks stay unknown',()=>{
  const {p,orders}=pair('history'),row=executionStatistics([p],orders,now).rows[0];
  near(row.amounts.closedNetPnlUsd,.9);assert.equal(row.slippageUsd,null);assert.equal(row.slippageBps,null);
  assert.equal(row.timing.firstLegSubmissionGapMs,20);assert.equal(row.timingBasis?.submission,'journal-intent');
  assert.equal(row.timing.firstLegConfirmationGapMs,null);assert.equal(row.timing.unhedgedObservedMs,null);
  assert.equal(row.timing.longestUnhedgedObservedMs,null);near(row.amounts.makerFeeSavingUsd,0);
});

test('unverified actual prices and missing fees stay null independently of a large predicted profit',()=>{
  const {p,orders}=pair('missing');p.executionEvidence={version:1,method:'ioc',entryPath:'price-100',prediction:{singleCycleNetUsd:1000,fundingUsd:50,rawOppositeEdgeBps:150}};
  orders[3].result!.averagePriceVerified=false;
  let s=executionStatistics([p],orders,now);assert.equal(s.rows[0].amounts.closedNetPnlUsd,null);near(s.rows[0].amounts.feesUsd,.4);
  assert.equal(s.rows[0].prediction!.singleCycleNetUsd,1000);assert.equal(s.groups[0].entryPath,'price-100');
  orders[3].result!.averagePriceVerified=true;delete (orders[3].result as Partial<NonNullable<JournalOrder['result']>>).feeUsd;
  s=executionStatistics([p],orders,now);assert.equal(s.rows[0].amounts.feesUsd,null);assert.equal(s.rows[0].amounts.closedNetPnlUsd,null);
});

test('verified PostOnly terminal receipts prove actual Maker fee saving without inventing a fill clock',()=>{
  const {p,orders}=pair('maker');p.executionEvidence={version:1,method:'maker-ioc',entryPath:'single-cycle',prediction:{makerFeeSavingUsd:999}};
  orders[1].request.postOnly=true;orders[1].result!.feeUsd=.2;orders[1].result!.averagePriceVerified=true;
  evidence(orders[1],{method:'maker',nativeTakerFeeRate:.0011,nativeMakerFeeRate:.0002});
  const s=executionStatistics([p],orders,now),row=s.rows[0];
  near(row.orders[1].makerFeeSavingUsd,.911);near(row.amounts.makerFeeSavingUsd,.911);
  assert.equal(row.prediction!.makerFeeSavingUsd,999);assert.equal(row.method,'maker-ioc');assert.equal(row.timing.unhedgedObservedMs,null);
  near(row.amounts.feesUsd,.5);near(row.amounts.closedNetPnlUsd,.8);
});

test('a planned Maker mode, missing official baseline or explicit taker fill never fabricates an actual saving',()=>{
  const {p,orders}=pair('no-baseline');p.executionEvidence={version:1,method:'maker-ioc',entryPath:'manual',prediction:{makerFeeSavingUsd:10}};
  orders[1].request.postOnly=true;
  let row=executionStatistics([p],orders,now).rows[0];assert.equal(row.amounts.makerFeeSavingUsd,null);
  evidence(orders[1],{method:'maker',nativeTakerFeeRate:undefined});row=executionStatistics([p],orders,now).rows[0];
  assert.equal(row.amounts.makerFeeSavingUsd,null);
  evidence(orders[1],{method:'maker',fills:[fill('real-taker',10,101,.1,1200,'taker')]});
  row=executionStatistics([p],orders,now).rows[0];assert.equal(row.amounts.makerFeeSavingUsd,null);
});

test('identified base-coin fills reconstruct observed naked intervals using local clocks and deduplicate repeated execution IDs',()=>{
  const p=position('fills');p.status='open';p.long.quantity=10;p.short.quantity=10;delete p.closeRequestedAt;delete p.closedAt;
  const orders=[order(p,'short',10,101,1100),order(p,'long',10,100,1120)];
  const repeated=fill('short-six',6,101,.06,1200);repeated.exchangeTimestamp=999_000_000;
  evidence(orders[0],{fills:[repeated,{...repeated},fill('short-four',4,101,.04,1280)]});
  evidence(orders[1],{fills:[{...fill('long-six',6,100,.06,1240),exchangeTimestamp:1},fill('long-four',4,100,.04,1350)]});
  orders[0].execution={bookObservedAt:1000,quoteAgeMs:100,bookTransport:'websocket',confirmedAt:1380,confirmationMs:280};
  orders[1].execution={bookObservedAt:1000,quoteAgeMs:120,bookTransport:'websocket',confirmedAt:1390,confirmationMs:270};
  const row=executionStatistics([p],orders,now).rows[0];
  assert.equal(row.timing.unhedgedObservedMs,110);assert.equal(row.timing.longestUnhedgedObservedMs,70);
  assert.equal(row.timing.firstLegConfirmationGapMs,10);assert.equal(row.timingBasis?.exposure,'identified-fills');
  assert.equal(row.amounts.closedNetPnlUsd,null);
});

test('slippage compares actual fills with each recorded preparation quote, preserves sign and cannot use a future quote',()=>{
  const {p,orders}=pair('slippage');for(const o of orders)evidence(o);
  orders[0].executionEvidence!.referencePrice=99.9;orders[1].executionEvidence!.referencePrice=101.2;
  let row=executionStatistics([p],orders,now).rows[0];near(row.slippageUsd,3);
  near(row.slippageBps,3/(10*(99.9+101.2+100.2+101.1))*10000);
  orders[1].executionEvidence!.referencePrice=100.9;row=executionStatistics([p],orders,now).rows[0];near(row.orders[1].slippageUsd,-1);
  orders[0].executionEvidence!.referenceObservedAt=orders[0].createdAt+1;
  row=executionStatistics([p],orders,now).rows[0];assert.equal(row.slippageUsd,null);
});

test('a tagged new-batch rollback uses that batch basis without consuming prior matched profits',()=>{
  const p=position('batch');p.status='open';p.long.quantity=10;p.short.quantity=10;delete p.closeRequestedAt;delete p.closedAt;
  const orders=[order(p,'short',10,101,1100),order(p,'long',10,100,1120),order(p,'short',5,110,1200),order(p,'short',5,111,1300,true)];
  for(let i=0;i<orders.length;i++)evidence(orders[i],{batchId:i<2?'first':'second',role:i===3?'entry-tail':i===1?'hedge':'entry'});
  const row=executionStatistics([p],orders,now).rows[0];assert.equal(row.status,'hedged');near(row.amounts.rollbackCostUsd,5.2);
  delete orders[2].executionEvidence;delete orders[3].executionEvidence;
  assert.equal(executionStatistics([p],orders,now).rows[0].amounts.rollbackCostUsd,null,'unlabelled mixed-cost historical batches have no invented compensation basis');
});

test('normal exit imbalance is not mislabelled as an entry rollback or counted a second time',()=>{
  const {p,orders}=pair('exit');for(const o of orders)evidence(o,{role:o.request.reduceOnly?'exit':'entry'});
  const row=executionStatistics([p],orders,now).rows[0];near(row.amounts.rollbackCostUsd,0);near(row.amounts.closedNetPnlUsd,.9);
});

test('entry method/path regrouping preserves known subtotals and unknown counts without open marked PnL in closed profit',()=>{
  const a=pair('a'),b=pair('b'),c=pair('c');a.p.executionEvidence={version:1,method:'ioc',entryPath:'single-cycle'};
  b.p.executionEvidence={version:1,method:'ioc',entryPath:'price-100'};b.orders[3].result!.averagePriceVerified=false;
  c.p.status='open';c.p.long.quantity=10;c.p.short.quantity=10;c.p.long.markPrice=110;delete c.p.closedAt;delete c.p.closeRequestedAt;c.orders.splice(2);
  c.p.executionEvidence={version:1,method:'maker-ioc',entryPath:'manual'};
  const summary=executionStatistics([a.p,b.p,c.p],[...a.orders,...b.orders,...c.orders],now),before=structuredClone(summary.rows);
  assert.equal(summary.groups.length,3);assert.equal(summary.amounts.closedNetPnlUsd.valueUsd,null);
  near(summary.amounts.closedNetPnlUsd.knownUsd,.9);assert.equal(summary.amounts.closedNetPnlUsd.unknownCount,1);
  const filtered=summarizeExecutionStatisticsRows(summary.rows.filter(row=>row.entryPath==='single-cycle'),now);
  near(filtered.amounts.closedNetPnlUsd.valueUsd,.9);assert.equal(filtered.counts.total,1);assert.deepEqual(summary.rows,before);
});

test('prediction and compensation comparisons are copied for review and never alter the actual account ledger profit',()=>{
  const {p,orders}=pair('comparison');p.executionEvidence={version:1,method:'ioc',entryPath:'manual',prediction:{singleCycleNetUsd:100},
    compensations:[{observedAt:1200,batchId:'test',unmatchedSide:'short',unmatchedQuantity:10,decision:'hedge',
      hedge:{quantity:10,limitPrice:100,pricePnlUsd:-1,feesUsd:.1,costUsd:1.1},
      rollback:{quantity:10,limitPrice:101,pricePnlUsd:-2,feesUsd:.1,costUsd:2.1}}]};
  const row=executionStatistics([p],orders,now).rows[0];near(row.amounts.closedNetPnlUsd,.9);assert.equal(row.compensations[0].decision,'hedge');
  row.compensations[0].hedge!.costUsd=999;row.prediction!.singleCycleNetUsd=999;
  assert.equal(p.executionEvidence.compensations![0].hedge!.costUsd,1.1);assert.equal(p.executionEvidence.prediction!.singleCycleNetUsd,100);
});

test('malformed history and external account reductions remain reviewable without inventing lifecycle profits',()=>{
  const bad={id:'old',base:'OLD',openedAt:1000,fundingUsd:1,status:'closed'} as Position,{p,orders}=pair('external');p.manualCloseAccountRecord=true;
  const s=executionStatistics([bad,p],orders,now);assert.equal(s.counts.pending,1);assert.equal(s.counts.external,1);
  assert.equal(s.rows[0].amounts.closedNetPnlUsd,null);assert.equal(s.rows[1].amounts.closedNetPnlUsd,null);
  assert.equal(s.rows[1].amounts.rollbackCostUsd,null);assert.equal(s.amounts.closedNetPnlUsd.unknownCount,1);
});
