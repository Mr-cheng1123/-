import test from 'node:test';
import assert from 'node:assert/strict';
import type {EntryExecutionProgress,Opportunity} from '../src/shared/types.js';
import {copyEntryExecutionProgress,entryTargetReached} from '../src/shared/entry-execution-progress.js';
import {entryBatchPresentation} from '../web/src/entry-batch-presentation.js';
import {applyManualEntryReceipt,createManualEntryRequest,isManualEntryReceipt,manualEntryStage,restoreManualEntries} from '../web/src/manual-entry.js';
import type {ManualEntryOperation} from '../src/shared/manual-entry.js';

const opportunity=()=>({entryBatch:{pricing:'best-opposite',targetQuantity:160,batchQuantity:20,longLimitPrice:.6239,shortLimitPrice:.6255}} as Opportunity);
const progress=():EntryExecutionProgress=>({pricing:'best-opposite',targetQuantity:160,matchedQuantity:40,completedBatches:2,
  stopReason:'本批 IOC 价格优势不再为正，已停止补仓'});
const request=()=>createManualEntryRequest('CT-bitget-bybit',1000000,'batch-receipt-0001');
const receipt=(entryExecution?:EntryExecutionProgress):ManualEntryOperation=>({
  id:request().id,opportunityId:request().opportunityId,state:'completed',createdAt:1000000,updatedAt:1000001,
  expiresAt:1030000,leaseExpiresAt:1012000,message:'双腿已形成对冲持仓',cancelable:false,ordersSubmitted:true,
  result:{positionStatus:'open',base:'CT',longQuantity:40,shortQuantity:40,executionSummary:{
    ...(entryExecution?{entryExecution}:{}),long:{exchange:'bitget',openedQuantity:40,reducedQuantity:0,openingAttempts:2},
    short:{exchange:'bybit',openedQuantity:40,reducedQuantity:0,openingAttempts:2},accountingStatus:'confirmed',events:[]}},
});

test('first IOC batch retains the independent full goal and actual limit prices in its display',()=>{
  const display=entryBatchPresentation(opportunity(),100)!;
  assert.equal(display.label,'对手价分批 IOC · 本批 20 币 · 目标 160 币 / 每腿 100 U');
  assert.equal(display.prices,'多腿 IOC 买入限价 0.6239 · 空腿 IOC 卖出限价 0.6255');
  assert.equal(display.bestPrices,undefined);assert.equal(display.priceBuffers,undefined);
  assert.match(display.forecastNote,/完整目标条件预估/);assert.match(display.forecastNote,/未成交的目标数量不计为持仓/);
  assert.match(display.forecastNote,/首批分项按本批数量独立估算/);
  assert.equal(display.plan.targetQuantity,160);assert.equal(display.plan.batchQuantity,20);
});

test('buffered IOC batches display recorded best prices and limits without inventing legacy values',()=>{
  const row=opportunity();Object.assign(row.entryBatch!,{longBestPrice:.6234,shortBestPrice:.626,longPriceBufferBps:8,shortPriceBufferBps:8});
  const display=entryBatchPresentation(row,100)!;
  assert.equal(display.bestPrices,'首批对手价：多腿卖一 0.6234 · 空腿买一 0.626');
  assert.equal(display.priceBuffers,'限价相对对手价缓冲：多腿 8 bps · 空腿 8 bps');
  assert.match(display.prices,/买入限价 0\.6239/);assert.match(display.prices,/卖出限价 0\.6255/);
  Object.assign(row.entryBatch!,{longBestPrice:NaN,shortBestPrice:undefined,longPriceBufferBps:Infinity,shortPriceBufferBps:0});
  const incomplete=entryBatchPresentation(row,100)!;
  assert.equal(incomplete.bestPrices,undefined);assert.equal(incomplete.priceBuffers,'限价相对对手价缓冲：空腿 0 bps');
});

test('unknown, invalid or legacy plans never invent a first batch quantity or limit price',()=>{
  assert.equal(entryBatchPresentation(undefined,100),undefined);
  assert.equal(entryBatchPresentation({} as Opportunity,100),undefined);
  for(const patch of [{batchQuantity:0},{batchQuantity:200},{longLimitPrice:NaN},{shortLimitPrice:0},{targetQuantity:Infinity}]){
    const row=opportunity();Object.assign(row.entryBatch!,patch);assert.equal(entryBatchPresentation(row,100),undefined);
  }
  assert.doesNotMatch(entryBatchPresentation(opportunity(),NaN)!.label,/每腿|NaN/);
});

test('retained matched batches are not described as a fully completed goal on restore',()=>{
  const operation=receipt(progress());assert.equal(isManualEntryReceipt(operation,request()),true);
  const entry=applyManualEntryReceipt(request(),operation);
  assert.equal(manualEntryStage(entry),'已保留部分对冲，目标未补满');
  const restored=restoreManualEntries(JSON.stringify([entry]))[0];
  assert.equal(restored.operation!.result!.longQuantity,40);
  assert.deepEqual(restored.operation!.result!.executionSummary!.entryExecution,progress());
  assert.equal(manualEntryStage(restored),'已保留部分对冲，目标未补满');
  assert.equal(manualEntryStage(applyManualEntryReceipt(request(),receipt({...progress(),matchedQuantity:160,completedBatches:8}))), '双腿开仓完成');
  assert.equal(manualEntryStage(applyManualEntryReceipt(request(),receipt())), '双腿开仓完成','Legacy receipts keep their previous meaning.');
});

test('goal progress is a finite whitelist DTO and never copies credential fields into a receipt',()=>{
  const original={...progress(),apiSecret:'private-value',stopReason:'查询停止 token=private-token http://userpass@example.invalid/path'};
  const before=JSON.stringify(original),copy=copyEntryExecutionProgress(original)!;
  assert.equal(JSON.stringify(original),before);assert.equal('apiSecret' in copy,false);
  assert.doesNotMatch(copy.stopReason!,/private-token|userpass/);assert.match(copy.stopReason!,/已隐藏/);
  for(const patch of [{targetQuantity:-1},{matchedQuantity:NaN},{completedBatches:1.5},{stopReason:42},{pricing:'market'}]){
    assert.equal(copyEntryExecutionProgress({...progress(),...patch}),undefined);
    assert.equal(isManualEntryReceipt(receipt({...progress(),...patch} as EntryExecutionProgress),request()),false);
  }
  assert.equal(entryTargetReached({...progress(),matchedQuantity:160-1e-8}),true);
  assert.equal(entryTargetReached(progress()),false);assert.equal(entryTargetReached({...progress(),targetQuantity:0,matchedQuantity:0}),false);
});
