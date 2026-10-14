import type {Position} from '../../src/shared/types';

/** A saved close intent can be waiting for evidence; it is not proof of an active native order. */
export function positionCloseProgressLabel(position:Position):string {
  const {long,short}=position;
  const tolerance=Math.max(1e-12,Math.max(Math.abs(long.quantity),Math.abs(short.quantity))*Number.EPSILON*8);
  if(Math.abs(long.quantity-short.quantity)>tolerance)return '平仓残余数量待处理';
  if(position.closeProfitRequired===true&&position.holdDecision?.action!=='close')return '自动退出条件待复核';
  return '平仓流程尚未结束';
}

export function positionExitReasonKind(position:Position):'current'|'rechecking'|'historical'|'closed'|undefined {
  if(!position.closeReason)return;
  if(position.status==='closed'||position.accountClosure)return 'closed';
  if(position.closeRequestedAt===undefined&&position.status!=='closing')return 'historical';
  if(position.closeProfitRequired===true&&position.holdDecision?.action!=='close')return 'rechecking';
  return 'current';
}
