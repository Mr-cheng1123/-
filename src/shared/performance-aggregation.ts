import type {EquityPoint} from './types.js';
import type {PerformanceAmounts,PerformanceBucket,PerformanceRow,PerformanceSummary} from './performance-types.js';

const fields=['fundingUsd','feesUsd','spreadPnlUsd','transferCostUsd','netPnlUsd',
  'estimatedFeeRebateUsd','estimatedNetPnlAfterRebateUsd'] as const;
export function nullablePerformanceSum(rows:ReadonlyArray<PerformanceAmounts>,field:keyof PerformanceAmounts):number|null {
  if(rows.some(row=>!Number.isFinite(row[field])))return null;
  const sum=rows.reduce((value,row)=>value+row[field]!,0);
  return Number.isFinite(sum)?sum:null;
}
function bucket(rows:PerformanceRow[]):PerformanceBucket {
  const amounts=Object.fromEntries(fields.map(field=>[field,nullablePerformanceSum(rows,field)])) as unknown as PerformanceAmounts;
  const included=rows.filter(row=>Number.isFinite(row.netPnlUsd));
  return {...amounts,count:rows.length,includedCount:included.length,
    knownNetUsd:included.reduce((sum,row)=>sum+row.netPnlUsd!,0)};
}
/** Projection only. Normal closed history is rebuilt without rewriting the original equity series. */
export function summarizePerformanceRows(rows:PerformanceRow[],now=Date.now()):PerformanceSummary {
  const normal=rows.filter(row=>row.category==='normal');
  const completed=normal.filter(row=>row.closed&&Number.isFinite(row.closedAt)&&row.closedAt!>0&&row.closedAt!<=now&&
    Number.isFinite(row.netPnlUsd)&&Number.isFinite(row.fundingUsd)&&Number.isFinite(row.feesUsd))
    .slice().sort((a,b)=>a.closedAt!-b.closedAt!||a.id.localeCompare(b.id));
  const closedNormalEquity:EquityPoint[]=[];
  let netPnlUsd=0,fundingUsd=0,feesUsd=0;
  if(completed.length){
    const firstOpened=Math.min(...completed.map(row=>row.openedAt).filter(at=>Number.isFinite(at)&&at>0));
    if(Number.isFinite(firstOpened)&&firstOpened<completed[0].closedAt!)closedNormalEquity.push({timestamp:firstOpened,netPnlUsd:0,fundingUsd:0,feesUsd:0});
    for(const row of completed){netPnlUsd+=row.netPnlUsd!;fundingUsd+=row.fundingUsd!;feesUsd+=row.feesUsd!;
      closedNormalEquity.push({timestamp:row.closedAt!,netPnlUsd,fundingUsd,feesUsd});}
  }
  return {rows,normal:bucket(normal),abnormal:bucket(rows.filter(row=>row.category==='abnormal')),
    pending:bucket(rows.filter(row=>row.category==='pending')),external:bucket(rows.filter(row=>row.category==='external')),
    noFillCount:rows.filter(row=>row.category==='no_fill').length,closedNormalEquity};
}
