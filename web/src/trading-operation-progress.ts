import {
  summarizeTradingOperations,type TradingOperation,type TradingOperationQuantities,
} from '../../src/shared/trading-operations';
import {executionNumber,executionTime,tradingOperationKindLabels,tradingOperationStateLabels} from './execution-statistics-view';

export interface TradingOperationProgressView {
  state:TradingOperation['state']|'await-account';title:string;reason:string;window:string;observedAt:string;
  target:TradingOperationQuantities;confirmed:TradingOperationQuantities;remaining:TradingOperationQuantities;
  quantityLabels:{target:string;confirmed:string;remaining:string};
}
const unknownQuantities=():TradingOperationQuantities=>({long:null,short:null});
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const clock=(value:unknown,operation:TradingOperation,now:number):value is number=>finite(value)&&
  value>=operation.startedAt&&value<=operation.updatedAt&&value<=now;
const same=(first:number|null,second:number|null)=>first!==null&&second!==null&&
  (first===0||second===0?first===second:Math.abs(first-second)<=64*Number.EPSILON*Math.max(Math.abs(first),Math.abs(second)));
const quantityNumber=(value:number|null)=>value!==null&&Number.isFinite(value)&&value!==0&&Math.abs(value)<1e-6?
  value.toExponential(8):executionNumber(value);
const quantityLabel=(value:TradingOperationQuantities)=>`多 ${quantityNumber(value.long)} / 空 ${quantityNumber(value.short)}`;

/** Read recorded observations only. This projection cannot authorize a retry or determine live account quantities. */
export function tradingOperationProgress(operation:TradingOperation|undefined,now:number):TradingOperationProgressView|undefined {
  if(!operation)return undefined;
  const empty=unknownQuantities();
  const invalid=():TradingOperationProgressView=>({state:'unknown',title:'本次操作进度待核对',reason:'操作记录或本地观察时间不完整，等待核对',
    window:'处理窗口未记录',observedAt:'观察时间待核对',target:empty,confirmed:empty,remaining:empty,
    quantityLabels:{target:quantityLabel(empty),confirmed:quantityLabel(empty),remaining:quantityLabel(empty)}});
  if(!finite(now)||now<=0)return invalid();
  const summary=summarizeTradingOperations([operation],now),row=summary.rows[0];
  if(!row)return invalid();
  const stages=Object.values(row.stages).filter(value=>value!==undefined);
  const invalidStages=stages.some(value=>!clock(value,row,now));
  const accountAfterPaired=clock(row.stages.accountConfirmedAt,row,now)&&clock(row.stages.pairedAt,row,now)&&
    row.stages.accountConfirmedAt>=row.stages.pairedAt;
  const targetConfirmed=['long','short'].every(side=>{
    const key=side as keyof TradingOperationQuantities;
    return same(row.target[key],row.confirmed[key])&&row.remaining[key]===0;
  })&&((row.target.long??0)>0||(row.target.short??0)>0)&&row.attempts.unknown===0&&(row.attempts.pending??0)===0&&clock(row.stages.pairedAt,row,now);
  const awaitingAccount=!invalidStages&&row.state!=='complete'&&row.state!=='unknown'&&targetConfirmed&&!accountAfterPaired;
  let state:TradingOperationProgressView['state']=invalidStages?'unknown':awaitingAccount?'await-account':row.state;
  let reason=row.waitReason?.text||'当前阶段未记录，等待新的执行观察';
  if(state==='complete')reason='本次目标数量与账户数量已确认';
  else if(state==='await-account')reason='成交已确认，等待账户数量核对';
  else if(invalidStages)reason='阶段观察时间异常，当前进度待核对';
  else if(!row.waitReason){
    if(row.attempts.unknown>0||state==='unknown')reason='存在未确认的操作结果，等待订单与账户核对';
    else if(clock(row.stages.pairedAt,row,now))reason='正在核对剩余账户数量';
    else if(clock(row.stages.firstFillObservedAt,row,now))reason='已有成交，正在处理剩余数量';
    else if(clock(row.stages.acknowledgedAt,row,now))reason='已收到订单回执，等待成交核对';
    else if(clock(row.stages.submittedAt,row,now))reason='已调用下单适配器，等待原单回执';
    else if(clock(row.stages.preparationCompletedAt,row,now))reason='准备检查已完成，等待本批执行确认';
    else if(clock(row.stages.preparationStartedAt,row,now))reason='正在准备盘口与账户检查';
  }
  const windowEnd=row.windowEndsAt;
  let window='处理窗口未记录';
  if(windowEnd!==undefined){
    if(!finite(windowEnd)||windowEnd<row.startedAt)window='处理窗口待核对';
    else if(state==='complete'||row.endedAt!==undefined)window='本次处理已结束';
    else if(now>=windowEnd)window='处理窗口已结束，剩余数量需确认';
    else window=`处理窗口截止 ${executionTime(windowEnd)}`;
  }
  if(row.endedAt!==undefined&&(!clock(row.endedAt,row,now)))state='unknown';
  const label=state==='await-account'?'等待账户核对':tradingOperationStateLabels[state];
  return {state,title:`${tradingOperationKindLabels[row.kind]} · ${label}`,reason,window,
    observedAt:`本次最后观察 ${executionTime(row.updatedAt)}`,target:row.target,confirmed:row.confirmed,remaining:row.remaining,
    quantityLabels:{target:quantityLabel(row.target),confirmed:quantityLabel(row.confirmed),remaining:quantityLabel(row.remaining)}};
}
