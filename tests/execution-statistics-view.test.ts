import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {summarizeExecutionStatisticsRows,type ExecutionStatisticsRow,type ExecutionStatisticsOrder} from '../src/shared/execution-statistics.js';
import ExecutionStatistics,{ExecutionRowEvidence} from '../web/src/ExecutionStatistics.js';
import {
  executionAbnormalSummary,executionOrderCallGapMetric,executionClosedCsv,executionEntrySuccess,executionEvidenceJson,executionMoneyPresentation,executionNormalClosedSummary,
  executionRowsPage,executionSamplePresentation,executionScopeRows,executionScopeSummary,executionVisibleRows,
} from '../web/src/execution-statistics-view.js';

const row=(id:string,overrides:Partial<ExecutionStatisticsRow>={}):ExecutionStatisticsRow=>({
  id,base:id.toUpperCase(),mode:'live',method:'ioc',entryPath:'manual',methodSource:'recorded',pathSource:'recorded',
  status:'hedged',reason:'双腿订单已确认',closed:true,closeRecorded:true,openedAt:1000,closedAt:2000,
  longExchange:'gate',shortExchange:'bybit',longQuantity:10,shortQuantity:10,
  amounts:{fundingUsd:1,feesUsd:.2,spreadPnlUsd:-.1,transferCostUsd:0,closedNetPnlUsd:.7,rollbackCostUsd:0,makerFeeSavingUsd:0},
  prediction:null,timing:{firstLegSubmissionGapMs:20,firstLegConfirmationGapMs:100,unhedgedObservedMs:null,longestUnhedgedObservedMs:null},
  timingBasis:{submission:'outbound',confirmation:'local-confirmation',exposure:'unknown'},
  slippageUsd:null,slippageBps:null,compensations:[],orders:[],...overrides,
});
const order=():ExecutionStatisticsOrder=>({
  key:'order-stable-key',clientOrderId:'client-safe-1',nativeOrderId:'native-safe-1',exchange:'gate',symbol:'CT/USDT:USDT',
  side:'buy',reduceOnly:false,createdAt:1200,status:'partial',requestQuantity:106,filledQuantity:96,limitPrice:.5,
  averagePrice:.49,feeUsd:.02,method:'maker',role:'entry',batchId:'batch-safe-1',confirmedAt:1400,
  confirmationMs:200,bookObservedAt:1100,quoteAgeMs:100,referencePrice:.51,referenceObservedAt:1100,
  submittedAt:1205,
  slippageUsd:-1.92,slippageBps:-392.15,makerFeeSavingUsd:.013,
});

test('display scope keeps execution method, entry cohort and paper facts separate without mutating source',()=>{
  const rows=[row('manual'),row('cycle',{entryPath:'single-cycle'}),row('edge',{entryPath:'price-100'}),
    row('maker',{method:'maker-ioc',entryPath:'price-100'}),row('old',{entryPath:'legacy',pathSource:'legacy'}),row('paper',{mode:'paper'})];
  const before=structuredClone(rows),summary=summarizeExecutionStatisticsRows(rows,3000);
  const filtered=executionScopeSummary(summary,{method:'ioc',entryPath:'price-100',mode:'live'});
  assert.deepEqual(filtered.rows.map(item=>item.id),['edge']);assert.equal(filtered.amounts.closedNetPnlUsd.knownCount,1);
  assert.deepEqual(executionScopeRows(rows,{method:'maker-ioc',entryPath:'all',mode:'live'}).map(item=>item.id),['maker']);
  assert.deepEqual(executionScopeRows(rows,{method:'all',entryPath:'all',mode:'paper'}).map(item=>item.id),['paper']);
  assert.deepEqual(rows,before);
});

test('normal closed, abnormal compensation and all confirmed closed sums preserve partial unknown values',()=>{
  const normal=row('normal'),abnormal=row('ct',{status:'abnormal',amounts:{...normal.amounts,fundingUsd:0,closedNetPnlUsd:-.4,rollbackCostUsd:.4}});
  const pending=row('unknown',{status:'pending',amounts:{...normal.amounts,closedNetPnlUsd:null,rollbackCostUsd:null}});
  const held=row('held',{closed:false,closeRecorded:false,closedAt:null,amounts:{...normal.amounts,spreadPnlUsd:999,closedNetPnlUsd:null}});
  const summary=summarizeExecutionStatisticsRows([normal,abnormal,pending,held],3000);
  assert.equal(executionNormalClosedSummary(summary).amounts.closedNetPnlUsd.valueUsd,.7);
  assert.equal(executionAbnormalSummary(summary).amounts.rollbackCostUsd.valueUsd,.4);
  assert.equal(summary.amounts.closedNetPnlUsd.valueUsd,null);
  assert.ok(Math.abs(summary.amounts.closedNetPnlUsd.knownUsd-.3)<1e-9);
  assert.equal(summary.amounts.closedNetPnlUsd.unknownCount,1,'An open marked position is not an incomplete closed sample.');
  const shown=executionMoneyPresentation(summary.amounts.closedNetPnlUsd,true);
  assert.equal(shown.text,'+$0.30');assert.match(shown.caption,/已确认部分.*1 笔待核对/);
});

test('missing values and empty Maker observations display unknown or no samples rather than zero savings or time',()=>{
  assert.equal(executionMoneyPresentation({valueUsd:null,knownUsd:0,knownCount:0,unknownCount:1}).text,'待核对');
  assert.equal(executionMoneyPresentation({valueUsd:0,knownUsd:0,knownCount:0,unknownCount:0}).text,'无样本');
  assert.equal(executionMoneyPresentation({valueUsd:0,knownUsd:0,knownCount:1,unknownCount:0}).text,'$0.00','A confirmed actual zero stays visible.');
  assert.equal(executionSamplePresentation({mean:null,max:null,knownCount:0,unknownCount:2},'duration').text,'无样本');
  assert.match(executionSamplePresentation({mean:null,max:null,knownCount:0,unknownCount:2},'duration').caption,/2 笔无完整观察/);
});

test('entry completion rate excludes pending and account-import entries from denominator, includes real failures',()=>{
  const rows=[row('paired'),row('held',{closed:false}),row('empty',{status:'no-fill'}),row('ct',{status:'abnormal'}),
    row('waiting',{status:'pending'}),row('imported',{status:'external'})];
  assert.deepEqual(executionEntrySuccess(rows),{succeeded:2,resolved:4,unknown:1,external:1,percent:50});
  assert.equal(executionEntrySuccess([rows[4],rows[5]]).percent,null);
});

test('stable detail ordering never depends on changing PnL, quantity, completion or quote values',()=>{
  const rows=[row('z',{openedAt:4000}),row('a',{openedAt:4000}),row('last',{openedAt:1000})],before=structuredClone(rows);
  const sorted=executionVisibleRows(rows,'','all');assert.deepEqual(sorted.map(item=>item.id),['a','z','last']);
  rows[0].amounts.closedNetPnlUsd=-100;rows[1].amounts.closedNetPnlUsd=200;rows[2].status='pending';rows[2].longQuantity=0;
  assert.deepEqual(executionVisibleRows(rows,'','all').map(item=>item.id),['a','z','last']);
  assert.deepEqual(before.map(item=>item.id),rows.map(item=>item.id),'Projection must not sort the supplied array in place.');
});

test('search includes native order IDs, result selection and pagination retain exact stable record IDs',()=>{
  const rows=Array.from({length:31},(_,index)=>row(`id-${index}`,{openedAt:index+1}));
  rows[4].orders=[order()];rows[5].closed=false;rows[5].closeRecorded=false;
  assert.deepEqual(executionVisibleRows(rows,' NATIVE-SAFE-1 ','all').map(item=>item.id),['id-4']);
  assert.deepEqual(executionVisibleRows(rows,'','held').map(item=>item.id),['id-5']);
  const visible=executionVisibleRows(rows,'','all'),page=executionRowsPage(visible,99,10);
  assert.equal(page.page,4);assert.equal(page.pageCount,4);assert.deepEqual(page.rows.map(item=>item.id),['id-0']);
  assert.equal(page.start,31);assert.equal(page.end,31);
  assert.deepEqual(executionRowsPage([],5,25),{rows:[],page:1,pageCount:1,start:0,end:0});
});

test('statistics render independent normal and abnormal totals, Maker no samples, strict path conditions and no trade controls',()=>{
  const normal=row('sand'),abnormal=row('ct',{status:'abnormal',amounts:{...normal.amounts,closedNetPnlUsd:-.4,rollbackCostUsd:.4}});
  normal.orders=[order()];
  const html=renderToStaticMarkup(createElement(ExecutionStatistics,{summary:summarizeExecutionStatisticsRows([normal,abnormal],3000)}));
  assert.match(html,/正常闭合净收益/);assert.match(html,/异常执行成本/);assert.match(html,/全部已确认闭合净损益/);
  assert.match(html,/\+\$0\.70/);assert.match(html,/\+\$0\.40/);assert.match(html,/\+\$0\.30/);
  assert.match(html,/Maker \+ IOC/);assert.match(html,/无样本/);assert.match(html,/实际 IOC 限价优势 &gt;80 bps/);assert.match(html,/&gt;100 bps/);
  assert.match(html,/data-execution-record="sand"/);assert.ok(!html.includes('native-safe-1'),'Evidence loads only for expanded rows.');
  assert.ok(!html.includes('data-execution-evidence='));assert.ok(!html.includes('实盘开仓'));assert.ok(!html.includes('启动自动策略'));
});

test('expanded evidence preserves exact original order, quote and fee facts, separates predictions, and escapes reason text',()=>{
  const record=row('ct',{orders:[order()],reason:'<img src=x onerror=trade()>',prediction:{fundingUsd:12,singleCycleNetUsd:999,rawOppositeEdgeBps:125},
    compensations:[{observedAt:1300,batchId:'batch-safe-1',unmatchedSide:'long',unmatchedQuantity:10,decision:'hedge',
      hedge:{quantity:10,limitPrice:.51,pricePnlUsd:.03,feesUsd:.005,costUsd:-.025}}]});
  const html=renderToStaticMarkup(createElement(ExecutionRowEvidence,{row:record}));
  assert.match(html,/native-safe-1/);assert.match(html,/client-safe-1/);assert.match(html,/batch-safe-1/);assert.match(html,/106/);assert.match(html,/96/);
  assert.match(html,/0\.49/);assert.match(html,/0\.51/);assert.match(html,/\$0\.02/);assert.match(html,/开仓前预测 · 不计入已确认损益/);
  assert.match(html,/补齐与回撤 · 决策时预测/);assert.match(html,/\+\$999\.00/);assert.match(html,/&lt;img/);assert.ok(!html.includes('<img'));
});

test('absent server classification remains a waiting message, not fabricated all-zero statistics',()=>{
  const html=renderToStaticMarkup(createElement(ExecutionStatistics,{}));
  assert.match(html,/等待执行统计同步/);assert.ok(!html.includes('$0.00'));assert.ok(!html.includes('data-execution-stat='));
});

test('CSV retains nullable closed amounts, exact orders and excludes held, no-fill and external records; text cannot become a spreadsheet formula',()=>{
  const unknown=row('=SUM(A1)',{orders:[order()],amounts:{...row('unused').amounts,closedNetPnlUsd:null}});
  const rows=[unknown,row('held-only',{closed:false,closeRecorded:false}),row('no-fill-only',{status:'no-fill'}),row('external-only',{status:'external'})];
  const before=structuredClone(rows),csv=executionClosedCsv(rows);
  assert.ok(csv.startsWith('\uFEFF'));assert.equal(csv.split('\r\n').length,2);assert.match(csv,/"'=SUM\(A1\)"/);
  assert.ok(!csv.includes('held-only'));assert.ok(!csv.includes('no-fill-only'));assert.ok(!csv.includes('external-only'));
  assert.match(csv,/,1000,2000,,1,0\.2,-0\.1,0,0,0,/);assert.match(csv,/native-safe-1/);assert.deepEqual(rows,before);
});

test('JSON download retains filtered actual and forecast evidence separately without recasting missing facts',()=>{
  const rows=[row('evidence',{orders:[order()],prediction:{singleCycleNetUsd:999},slippageUsd:null})];
  const source=executionEvidenceJson(rows,3000,{method:'ioc',entryPath:'manual',mode:'live'},'native-safe-1','all');
  const data=JSON.parse(source);
  assert.equal(data.exportedSnapshotAt,3000);assert.equal(data.detailFilter.search,'native-safe-1');
  assert.equal(data.rows[0].slippageUsd,null);assert.equal(data.rows[0].amounts.closedNetPnlUsd,.7);
  assert.equal(data.rows[0].prediction.singleCycleNetUsd,999);assert.equal(data.rows[0].orders[0].nativeOrderId,'native-safe-1');
});

test('local order-call comparison excludes historical journal intent intervals and unknown clocks',()=>{
  const rows=[row('actual'),row('old',{timingBasis:{submission:'journal-intent',confirmation:'unknown',exposure:'unknown'}}),
    row('missing',{timingBasis:undefined})];
  assert.deepEqual(executionOrderCallGapMetric(rows),{mean:20,max:20,knownCount:1,unknownCount:2});
  const historical=renderToStaticMarkup(createElement(ExecutionRowEvidence,{row:rows[1]}));
  assert.match(historical,/历史仅订单记录时刻/);assert.match(historical,/20 ms/);
  const actual=renderToStaticMarkup(createElement(ExecutionRowEvidence,{row:rows[0]}));
  assert.match(actual,/本地 adapter 下单调用起点/);assert.match(actual,/不表示交易所收单或成交时刻/);assert.ok(!actual.includes('真实请求发出'));
});

test('compensation evidence displays conditional funding, cycle books and official fees without booking predicted savings as profit',()=>{
  const record=row('conditional',{compensations:[{observedAt:1300,batchId:'batch-conditional',unmatchedSide:'short',unmatchedQuantity:10,
    projectionUntil:3_600_000,longBookObservedAt:1250,shortBookObservedAt:1260,longTakerFeeRate:.0006,shortTakerFeeRate:.00055,
    decision:'rollback',constraint:'retry-budget',hedge:{quantity:10,limitPrice:.51,pricePnlUsd:.03,feesUsd:.015,costUsd:-.095,
      predictedFundingUsd:.08,basis:'current-book-at-cycle-end',longClosePrice:.5,shortClosePrice:.499},
    rollback:{quantity:10,limitPrice:.51,pricePnlUsd:-.02,feesUsd:.006,costUsd:.026,predictedFundingUsd:0,basis:'immediate-rollback'}}]});
  const before=structuredClone(record),html=renderToStaticMarkup(createElement(ExecutionRowEvidence,{row:record}));
  assert.match(html,/预计资金费 \+\$0\.08/);assert.match(html,/当前两所平仓盘口保持到本周期末/);assert.match(html,/已付首腿开仓费是共同沉没成本，不重复扣/);
  assert.match(html,/预测不计入已实现损益/);assert.match(html,/新增开仓及两腿平仓预计费/);assert.match(html,/立即撤回预计费/);
  assert.match(html,/0\.06%/);assert.match(html,/0\.055%/);assert.match(html,/多腿平仓价 0\.5 \/ 空腿平仓价 0\.499/);
  assert.match(html,/补齐重试预算已用完/);assert.deepEqual(record,before);
  const csv=executionClosedCsv([record]);assert.match(csv,/predictedFundingUsd/);assert.match(csv,/current-book-at-cycle-end/);
  const exported=JSON.parse(executionEvidenceJson([record],3000,{method:'ioc',entryPath:'manual',mode:'live'},'','all'));
  assert.equal(exported.rows[0].amounts.closedNetPnlUsd,.7);assert.equal(exported.rows[0].compensations[0].hedge.predictedFundingUsd,.08);
});

test('predicted hedge choice and confirmed rollback result stay separate; absent results never imply completed hedge',()=>{
  const compensation={observedAt:1300,batchId:'batch-result',unmatchedSide:'short' as const,unmatchedQuantity:6,decision:'hedge' as const,
    outcome:'rollback' as const,hedgeFilledQuantity:0,reducedLongQuantity:0,reducedShortQuantity:6,constraint:'no-fresh-refresh' as const};
  const record=row('outcome',{compensations:[compensation]});
  const html=renderToStaticMarkup(createElement(ExecutionRowEvidence,{row:record}));
  assert.match(html,/预测选择 \/ 执行限制/);assert.match(html,/实际结果 \/ 已确认数量/);
  assert.match(html,/<td>补齐<small>缺少新鲜盘口刷新/);assert.match(html,/<td>已执行回撤<small>补齐成交 0/);
  assert.match(html,/减多腿 0 \/ 减空腿 6/);assert.ok(!html.includes('已补齐对冲'));
  const legacy=row('legacy-result',{compensations:[{observedAt:1300,batchId:'old-batch',unmatchedSide:'short',unmatchedQuantity:6,decision:'hedge'}]});
  const missing=renderToStaticMarkup(createElement(ExecutionRowEvidence,{row:legacy}));
  assert.match(missing,/实际结果未记录/);assert.match(missing,/补齐成交 —/);assert.ok(!missing.includes('已补齐对冲'));
  const json=JSON.parse(executionEvidenceJson([record],3000,{method:'ioc',entryPath:'manual',mode:'live'},'','all'));
  assert.equal(json.rows[0].compensations[0].decision,'hedge');assert.equal(json.rows[0].compensations[0].outcome,'rollback');
  assert.equal(json.rows[0].compensations[0].hedgeFilledQuantity,0);assert.equal(json.rows[0].compensations[0].reducedShortQuantity,6);
  assert.match(executionClosedCsv([record]),/reducedShortQuantity/);
});
