import type {Position} from './types.js';
import type {PerformanceRow} from './performance-types.js';

/** Synthetic reviewed lifecycle used by the public example and regression tests.
 * Personal reviewed lifecycle identities are intentionally excluded from this
 * source distribution. This read-only classification never authorizes trading
 * or adjusts actual cash. */
const dosAdl={id:'d0000000-0000-4000-8000-000000000001',openedAt:1700000000000} as const;

export function isReviewedPerformanceException(position:Position|undefined):boolean {
  return !!position&&position.id===dosAdl.id&&position.base==='DOS'&&position.openedAt===dosAdl.openedAt&&
    position.mode==='live'&&!position.manualCloseAccountRecord&&
    position.long?.exchange==='bitget'&&position.long.symbol==='DOS/USDT:USDT'&&position.long.side==='long'&&
    position.short?.exchange==='gate'&&position.short.symbol==='DOS/USDT:USDT'&&position.short.side==='short';
}

export function applyPerformanceException(row:PerformanceRow,position:Position|undefined):PerformanceRow {
  if(!isReviewedPerformanceException(position)||row.id!==position!.id||
    row.base!==position!.base||row.openedAt!==position!.openedAt)return row;
  return {...row,category:'abnormal',
    reason:'Gate ADL 后形成单腿风险，按用户指定归入异常交易，不计入正常策略收益；外部减仓损益尚未完整入账',
    // Local marks and software journal cash cannot reconstruct the missing ADL
    // lifecycle. Retain separately confirmed fees/funding/rebate estimates.
    spreadPnlUsd:null,netPnlUsd:null,estimatedNetPnlAfterRebateUsd:null};
}
