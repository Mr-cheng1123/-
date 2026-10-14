import type {AppState} from '../../src/shared/types';
import type {PerformanceSummary} from '../../src/shared/performance-types';
import {summarizePerformanceRows} from '../../src/shared/performance-aggregation';
import {applyPerformanceException,isReviewedPerformanceException} from '../../src/shared/performance-exceptions';
import {ledgerPositionMetrics} from './ledger-position-metrics';

/** Overview display only. Keep confirmed lifecycle cash, and replace only the
 * current unrealized price component with an exact fresh account observation.
 * This projection never updates a position, grants permission, or changes a trade. */
export function overviewPerformance(state:AppState,now=Date.now()):PerformanceSummary|undefined {
  if(!state.performance)return;
  const positions=new Map(state.positions.map(position=>[position.id,position]));
  // Reclassify an explicitly reviewed lifecycle even while an older backend is
  // serving its previous reporting category; never mutate its journal or state.
  const classified=state.performance.rows.map(row=>applyPerformanceException(row,positions.get(row.id)));
  const claims=new Map<string,Array<{id:string;key?:string}>>();
  for(const row of classified){
    const position=positions.get(row.id);
    const archived=Number.isFinite(position?.accountClosure?.confirmedAt)&&position!.accountClosure!.confirmedAt>0&&
      position!.accountClosure!.confirmedAt<=now;
    if(row.closed||row.category!=='normal'&&(!isReviewedPerformanceException(position)||archived))continue;
    if(position?.mode!=='live')continue;
    for(const leg of [position.long,position.short]){
      if(!(leg.quantity>0))continue;
      const contract=JSON.stringify([leg.exchange,leg.symbol,leg.side]);
      const owners=claims.get(contract)??[];
      owners.push({id:position.id,key:leg.accountPositionKey});claims.set(contract,owners);
    }
  }
  const duplicateClaims=new Set<string>();
  for(const owners of claims.values())if(owners.length>1&&
    (owners.some(owner=>owner.key===undefined)||new Set(owners.map(owner=>owner.key)).size!==owners.length))
    for(const owner of owners)duplicateClaims.add(owner.id);
  const rows=classified.map(row=>{
    if(row.category!=='normal'||row.closed)return row;
    const position=positions.get(row.id);
    if(position?.mode==='paper')return row;
    const unavailable=(reason:string)=>({...row,spreadPnlUsd:null,netPnlUsd:null,estimatedNetPnlAfterRebateUsd:null,
      reason:`${row.reason}；${reason}`});
    if(!position||position.mode!=='live')return unavailable('当前策略记录未同步');
    if(duplicateClaims.has(row.id))return unavailable('多个策略记录对应同一账户仓位，等待确认各自归属');
    const metrics=ledgerPositionMetrics(position,state.livePortfolio,now);
    if(metrics.source!=='account'||!['paired','imbalanced','single'].includes(metrics.holding)||
      metrics.cycleMismatch||metrics.ledgerQuantitiesMatch!==true||
      !Number.isFinite(metrics.unrealizedPnlUsd)||!Number.isFinite(position.realizedSpreadPnlUsd))
      return unavailable('等待该仓位两腿的最新账户价格损益');
    const spreadPnlUsd=metrics.unrealizedPnlUsd!+position.realizedSpreadPnlUsd;
    const cash=[row.fundingUsd,row.feesUsd,row.transferCostUsd];
    const netPnlUsd=cash.every(value=>value!==null&&Number.isFinite(value))?
      row.fundingUsd!+spreadPnlUsd-row.feesUsd!-row.transferCostUsd!:null;
    const estimatedNetPnlAfterRebateUsd=netPnlUsd!==null&&Number.isFinite(row.estimatedFeeRebateUsd)?
      netPnlUsd+row.estimatedFeeRebateUsd!:null;
    return {...row,spreadPnlUsd,netPnlUsd,estimatedNetPnlAfterRebateUsd};
  });
  return summarizePerformanceRows(rows,now);
}
