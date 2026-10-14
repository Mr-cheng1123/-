import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {summarizeTradingOperations,type TradingOperation} from '../src/shared/trading-operations.js';
import TradingOperationStatistics from '../web/src/TradingOperationStatistics.js';
import {
  tradingOperationAge,tradingOperationMetricText,tradingOperationRecentRows,tradingOperationScopeSummary,
} from '../web/src/execution-statistics-view.js';

const operation=(id:string,changes:Partial<TradingOperation>={}):TradingOperation=>({
  version:1,id,positionId:'position-1',base:'CVC',mode:'live',origin:'automatic',kind:'profit-exit',protocol:'ioc',
  state:'complete',startedAt:1000,updatedAt:1600,endedAt:1600,
  target:{long:10,short:10},confirmed:{long:10,short:10},remaining:{long:0,short:0},
  stages:{signalObservedAt:1000,preparationStartedAt:1000,preparationCompletedAt:1100,submittedAt:1200,
    acknowledgedAt:1250,firstFillObservedAt:1300,pairedAt:1400,accountConfirmedAt:1500},
  attempts:{preflightNotSent:0,zeroFill:0,unknown:0,submitted:2},...changes,
});

test('operation view preserves unknown and partial in completion denominator, and does not turn missing evidence into zero',()=>{
  const summary=summarizeTradingOperations([
    operation('closed'),operation('unknown',{state:'unknown',endedAt:undefined,stages:{},
      confirmed:{long:null,short:null},remaining:{long:null,short:null},attempts:{preflightNotSent:1,zeroFill:0,unknown:1,submitted:1}}),
    operation('partial',{state:'partial',endedAt:undefined,remaining:{long:2,short:2},confirmed:{long:8,short:8}}),
  ],2000),before=structuredClone(summary);
  const html=renderToStaticMarkup(createElement(TradingOperationStatistics,{summary}));
  assert.match(html,/33\.3%/);assert.match(html,/1 \/ 3 次操作/);
  assert.match(html,/结果未知/);assert.match(html,/部分完成/);assert.match(html,/未知、部分完成和进行中保留在分母/);
  assert.match(html,/原单待确认 1/);assert.match(html,/缺介入记录不能判定无需救援/);
  assert.match(html,/3 次未知/);assert.match(html,/已记录最大名义金额 未知/);
  assert.equal((html.match(/data-trading-operation=/g)??[]).length,3);
  assert.doesNotMatch(html,/实盘开仓|提交平仓|恢复管理/);
  assert.deepEqual(summary,before,'Rendering must preserve recorded quantities, status and evidence.');
});

test('actual exit protocol and operation kind filter independently of historical entry method',()=>{
  const summary=summarizeTradingOperations([
    operation('entry',{kind:'entry',origin:'manual',protocol:'ioc'}),
    operation('maker-close',{kind:'manual-close',origin:'manual',protocol:'maker-ioc'}),
    operation('ioc-close',{kind:'profit-exit',protocol:'ioc'}),
    operation('paper',{mode:'paper',protocol:'maker-ioc'}),
  ],2000);
  const selected=tradingOperationScopeSummary(summary,{mode:'live',kind:'manual-close',protocol:'maker-ioc'});
  assert.deepEqual(selected.rows.map(row=>row.id),['maker-close']);
  assert.equal(selected.counts.total,1);assert.equal(selected.counts.manual,1);
  const html=renderToStaticMarkup(createElement(TradingOperationStatistics,{summary}));
  assert.match(html,/data-trading-operation="maker-close"/);assert.match(html,/手动平仓/);assert.match(html,/Maker \+ IOC/);
  assert.doesNotMatch(html,/data-trading-operation="paper"/);
  assert.equal(tradingOperationScopeSummary(summary,{mode:'all',kind:'all',protocol:'all'}),summary);
});

test('bounded recent operation details keep all operations in aggregates and sort by original start',()=>{
  const rows=Array.from({length:80},(_,index)=>operation(`op-${index}`,{startedAt:1000+index}));
  const summary=summarizeTradingOperations(rows,2000),before=structuredClone(rows);
  const html=renderToStaticMarkup(createElement(TradingOperationStatistics,{summary}));
  assert.equal((html.match(/data-trading-operation=/g)??[]).length,50);
  assert.match(html,/80 \/ 80 次操作/);assert.match(html,/50 \/ 80 次有完整身份/);
  const ordered=tradingOperationRecentRows(summary.rows).map(row=>row.id);
  rows[79].state='unknown';rows[0].updatedAt=1999;
  assert.deepEqual(tradingOperationRecentRows(rows).map(row=>row.id),ordered);
  assert.deepEqual(before.map(row=>row.id),rows.map(row=>row.id),'Ordering must not mutate source arrays.');
});

test('old summaries, empty cohorts and incomplete clocks have explicit evidence states',()=>{
  const legacy=renderToStaticMarkup(createElement(TradingOperationStatistics,{}));
  assert.match(legacy,/本版本开始记录，历史操作未重建/);assert.doesNotMatch(legacy,/100%|0 次操作/);
  const empty=renderToStaticMarkup(createElement(TradingOperationStatistics,{summary:summarizeTradingOperations([],2000)}));
  assert.match(empty,/无样本/);assert.match(empty,/历史操作未重建/);assert.doesNotMatch(empty,/100%/);
  assert.equal(tradingOperationMetricText({mean:null,max:null,p50:null,p95:null,knownCount:0,unknownCount:1}),'未记录');
  assert.equal(tradingOperationMetricText({mean:0,max:0,p50:0,p95:0,knownCount:1,unknownCount:0}),'0 ms');
  assert.equal(tradingOperationAge(operation('done'),2000),null);
  assert.equal(tradingOperationAge(operation('waiting',{state:'running',endedAt:undefined}),2000),1000);
});

test('invalid and duplicate evidence remains visible and is not silently counted as successful operations',()=>{
  const valid=operation('same'),conflict=operation('same',{protocol:'maker-ioc'});
  const invalid=operation('invalid',{startedAt:2500});
  const summary=summarizeTradingOperations([valid,conflict,invalid],2000);
  const html=renderToStaticMarkup(createElement(TradingOperationStatistics,{summary}));
  assert.match(html,/1 条操作记录字段不完整/);assert.match(html,/1 条重复编号记录/);
  assert.match(html,/同一操作存在不同记录，等待核对/);assert.match(html,/结果未知/);
  assert.doesNotMatch(html,/100%/);
});

test('limited retention and diagnostic saving errors are visible without implying full history or stopped trading',()=>{
  const summary={...summarizeTradingOperations([operation('recent')],2000),coverageLimited:true,retainedFrom:1000,
    diagnosticError:'操作统计文件写入失败，当前统计尚未保存；交易账本未由本功能更改'};
  const html=renderToStaticMarkup(createElement(TradingOperationStatistics,{summary}));
  assert.match(html,/统计仅覆盖保留样本/);assert.match(html,/未表示全部历史操作/);assert.match(html,/操作统计文件写入失败/);
  assert.match(html,/下单调用包含适配器内部检查，不证明已经发出HTTP请求/);
  assert.doesNotMatch(html,/策略已停止|已暂停策略/);
});
