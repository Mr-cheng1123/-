import type {Position} from '../../src/shared/types';
import {positionDate as date} from './position-formatters';
import {positionExitReasonKind} from './position-exit-presentation';
import TradingOperationProgress from './TradingOperationProgress';

/** Past triggers remain auditable, without presenting a cancelled trigger as today's exit decision. */
export default function PositionExitNotes({position}:{position:Position}){
  const kind=positionExitReasonKind(position);
  const previous=position.automaticCloseHistory?.at(-1);
  return <>
    <TradingOperationProgress operation={position.operationProgress} now={Date.now()}/>
    {(kind==='current'||kind==='closed')&&<span className="cell-caption">{kind==='closed'?'退出原因':'本次退出触发原因'}：{position.closeReason}</span>}
    {(kind==='historical'||kind==='rechecking')&&<details className="ledger-note"><summary>{kind==='historical'?'历史执行说明':'本次退出原触发 · 待复核'}</summary><p>{position.closeReason}</p>{kind==='rechecking'&&<p>当前续持判断已变化，退出流程正在核对剩余数量和原订单状态。</p>}</details>}
    {previous&&<details className="ledger-note" data-testid="automatic-close-history"><summary>上次自动减仓 · 已暂停</summary><p>暂停时间：{date(previous.suspendedAt)}</p>{previous.reason&&<p>原触发原因：{previous.reason}</p>}<p>停止原因：{previous.suspensionReason}</p><p>这是一笔历史退出尝试；当前续持判断以下方最新评估为准。</p></details>}
  </>;
}
