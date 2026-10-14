import type {AppState,Position} from '../../src/shared/types';
import type {PerformanceRow,PerformanceSummary} from '../../src/shared/performance-types';

/** Presentation only: ended account exposure does not settle unknown historical
 * cash. Keep every row in its original pending category and retain order guards. */
export function pendingPerformanceRecords(state:Pick<AppState,'positions'|'unconfirmedOrders'>,
  summary:PerformanceSummary,now=Date.now()):{current:PerformanceRow[];archived:PerformanceRow[]} {
  const positions=new Map<string,Position[]>();
  for(const position of state.positions){const rows=positions.get(position.id)??[];rows.push(position);positions.set(position.id,rows);}
  const current:PerformanceRow[]=[],archived:PerformanceRow[]=[];
  for(const row of summary.rows){
    if(row.category!=='pending')continue;
    const owners=positions.get(row.id),position=owners?.length===1?owners[0]:undefined;
    const closure=position?.accountClosure?.confirmedAt;
    const identity=position?.mode==='live'&&position.base===row.base&&position.openedAt===row.openedAt&&
      Number.isFinite(position.openedAt)&&position.openedAt>0;
    const ended=identity&&Number.isFinite(now)&&Number.isFinite(closure)&&closure!>=position!.openedAt&&closure!<=now;
    const activity=position?[position.openedAt,position.closeRequestedAt??0,position.closeAttemptedAt??0]:[];
    const currentOrders=state.unconfirmedOrders;
    const guarded=Array.isArray(currentOrders)&&!currentOrders.some(order=>order.positionId===row.id&&order.historical!==true)&&
      activity.every(time=>Number.isFinite(time)&&time>=0&&time<=closure!);
    (ended&&guarded?archived:current).push(row);
  }
  return {current,archived};
}
