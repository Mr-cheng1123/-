import type {AccountPosition} from '../../src/shared/types';

type CashPosition=Pick<AccountPosition,'unrealizedPnlUsd'|'realizedPnlUsd'|'fundingUsd'|'feesUsd'|'cashFlowStatus'|'cashFlowReason'>;
const finite=(value:number|undefined):value is number=>Number.isFinite(value);
const billLabels:Record<NonNullable<AccountPosition['cashFlowStatus']>,string>={
  loading:'账单读取中',ready:'账单字段待核对',incomplete:'账单归属待核对',
  error:'账单读取失败',unavailable:'账单暂不可用',stale:'账单已过期',
};

/** Cash amounts must come from actual account evidence. A partial sum never becomes a complete net value. */
export function accountPositionCashDisplay(position:CashPosition){
  const status=position.cashFlowStatus,statusLabel=status?billLabels[status]:undefined;
  const fundingKnown=finite(position.fundingUsd),feesKnown=finite(position.feesUsd),realizedKnown=finite(position.realizedPnlUsd);
  const subtotalKnown=finite(position.unrealizedPnlUsd)&&fundingKnown&&feesKnown;
  const totalKind=subtotalKnown?(realizedKnown?'net' as const:'subtotal' as const):'pending' as const;
  const subtotalUsd=subtotalKnown?position.unrealizedPnlUsd!+position.fundingUsd!-position.feesUsd!:undefined;
  const totalUsd=totalKind==='net'?subtotalUsd!+position.realizedPnlUsd!:subtotalUsd;
  const missing=[...(!finite(position.unrealizedPnlUsd)?['未实现损益']:[]),...(!realizedKnown?['已实现损益']:[]),
    ...(!fundingKnown?['资金费']:[]),...(!feesKnown?['已付费用']:[])];
  return {
    totalKind,totalUsd,
    totalLabel:totalKind==='pending'?statusLabel??'账单同步中':undefined,
    totalCaption:totalKind==='net'?'未实现＋已实现＋资金费−已付费':
      totalKind==='subtotal'?'已实现损益未确认 · 参考小计':`缺少${missing.join('、')} · 非完整净值`,
    fundingLabel:fundingKnown?undefined:statusLabel??'资金费同步中',
    feesLabel:feesKnown?undefined:statusLabel??'手续费同步中',
    realizedLabel:realizedKnown?undefined:statusLabel??'同步中',
    statusLabel:status==='ready'&&totalKind==='net'?'账单已核对':statusLabel,
    reason:status?position.cashFlowReason:undefined,
  };
}
