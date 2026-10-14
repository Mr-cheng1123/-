import type {AppState,Position,PositionLeg} from '../../src/shared/types';
import {ledgerPositionMetrics} from './ledger-position-metrics';
import {groupLivePositions,type LivePositionRow} from './live-position-groups';
import {isFreshPortfolioExchange} from './position-observation';
import {accountPositionKey,accountPositionMatchesLeg} from './account-position-identity';

export interface LedgerDisplayPosition {position:Position;origin:'strategy'|'account';paired:boolean;historyOnly?:boolean}

/** Display-only records for account holdings with no current strategy relationship.
 * They never enter saved state, adopt an archived journal or grant management permission. */
export function ledgerAccountProjection(state:AppState,now=Date.now()):LedgerDisplayPosition[] {
  const records:LedgerDisplayPosition[]=state.positions.map(position=>{
    const metrics=ledgerPositionMetrics(position,state.livePortfolio,now);
    return {position,origin:'strategy',paired:['paired','imbalanced'].includes(metrics.holding),historyOnly:metrics.cycleMismatch===true};
  });
  if(state.config.mode!=='live'||!state.livePortfolio)return records;
  const portfolio=state.livePortfolio;
  const rows:LivePositionRow[]=portfolio.exchanges.filter(account=>isFreshPortfolioExchange(account,portfolio,now))
    .flatMap(account=>account.positions.filter(row=>row.quantity>0).map(row=>({...row,exchange:account.exchange,
      receivedAt:account.receivedAt,rowKey:accountPositionKey(account.exchange,row)})));
  const consumed=new Set<string>();
  const active=state.positions.filter(position=>position.mode==='live'&&position.status!=='closed'&&!position.accountClosure);
  for(const position of active){
    const metrics=ledgerPositionMetrics(position,portfolio,now);
    if(metrics.cycleMismatch)continue;
    for(const leg of [position.long,position.short])for(const row of rows)
      if(accountPositionMatchesLeg(row.exchange,row,leg)&&row.base===position.base)consumed.add(row.rowKey);
  }
  const external=groupLivePositions(rows.filter(row=>!consumed.has(row.rowKey)),[]);
  for(const group of external){
    const rowLeg=(side:'long'|'short'):PositionLeg=>{
      const row=group.rows.find(item=>item.side===side),fallback=group.rows[0];
      return {exchange:(row??fallback).exchange,symbol:row?.symbol??`${fallback.symbol}#display-absent-${side}`,side,quantity:row?.quantity??0,
        entryPrice:row?.entryPrice??0,markPrice:row?.markPrice??fallback.markPrice,feesUsd:0,liquidationDistancePct:null,
        ...(row?{accountPositionKey:row.rowKey}:{})};
    };
    const openedAt=Math.min(...group.rows.map(row=>row.positionOpenedAt??row.cashFlowSince??1));
    const position:Position={id:`account-display:${encodeURIComponent(group.id)}`,base:group.base,mode:'live',status:'attention',
      long:rowLeg('long'),short:rowLeg('short'),openedAt,plannedExitAt:0,holdMode:'adaptive',fundingUsd:0,feesUsd:0,
      transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
    records.push({position,origin:'account',paired:group.paired});
  }
  return records;
}
