import type {TradingOperation} from '../../src/shared/trading-operations';
import {tradingOperationProgress} from './trading-operation-progress';

export default function TradingOperationProgress({operation,now}:{operation?:TradingOperation;now:number}) {
  const shown=tradingOperationProgress(operation,now);
  if(!shown)return null;
  return <div className="trading-operation-progress" data-trading-operation-progress={shown.state}>
    <p className="trading-operation-progress-title"><b>{shown.title}</b></p>
    <p className="trading-operation-progress-reason" title={shown.reason}>{shown.reason}</p>
    <details><summary>本次处理数量与窗口</summary><dl>
      <div><dt>本次目标</dt><dd>{shown.quantityLabels.target}</dd></div>
      <div><dt>已确认完成</dt><dd>{shown.quantityLabels.confirmed}</dd></div>
      <div><dt>本次剩余</dt><dd>{shown.quantityLabels.remaining}</dd></div>
    </dl><p>{shown.window}</p><p>{shown.observedAt}</p>
      <p>以上为本次操作的已记录数量；当前账户持仓仍以交易所新鲜快照为准。</p>
    </details>
  </div>;
}
