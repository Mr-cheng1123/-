import type {LivePortfolio,LivePortfolioExchange,Position} from '../../src/shared/types';
import {accountPositionMatchesLeg} from './account-position-identity';

export function isFreshPortfolioExchange(account:LivePortfolioExchange|undefined,portfolio:LivePortfolio,now=Date.now()):account is LivePortfolioExchange {
  return !!account && account.credentialsConfigured && account.status==='ready' &&
    Number.isFinite(account.requestedAt) && account.requestedAt!>0 && account.requestedAt!<=now &&
    now-account.requestedAt!<=portfolio.maxAgeMs;
}

export interface PositionObservation {
  status:'ledger'|'present'|'account_flat'|'unverified';
  longQuantity?:number;shortQuantity?:number;observedAt?:number;
}

/** Project current account evidence without rewriting fills or pretending an external close was a strategy fill. */
export function observeLedgerPosition(position:Position,portfolio:LivePortfolio|undefined,now=Date.now()):PositionObservation {
  if(position.mode!=='live'||position.status==='closed')return {status:'ledger'};
  // A later same-coin holding is a separate account observation, never a revival of these old execution records.
  if(position.accountClosure)return {status:'account_flat',observedAt:position.accountClosure.confirmedAt};
  if(!portfolio)return {status:'unverified'};
  const accounts=[position.long,position.short].map(leg=>portfolio.exchanges.find(account=>account.exchange===leg.exchange));
  const lastActivity=Math.max(position.openedAt,position.closeRequestedAt??0,position.closeAttemptedAt??0);
  const matches=(row:{base:string;symbol:string},leg:Position['long'])=>row.symbol===leg.symbol||row.base.toUpperCase()===position.base.toUpperCase();
  const fresh=accounts.map(account=>isFreshPortfolioExchange(account,portfolio,now)&&account.requestedAt!>=lastActivity);
  const quantities=[position.long,position.short].map((leg,index)=>fresh[index]?accounts[index]!.positions
    .filter(row=>accountPositionMatchesLeg(accounts[index]!.exchange,row,leg)).reduce((sum,row)=>sum+row.quantity,0):undefined);
  const present=[position.long,position.short].some((leg,index)=>fresh[index]&&accounts[index]!.positions.some(row=>matches(row,leg)&&row.quantity>0));
  if(fresh.some(value=>!value))return {status:'unverified',longQuantity:quantities[0],shortQuantity:quantities[1]};
  return {status:present?'present':'account_flat',longQuantity:quantities[0],shortQuantity:quantities[1],
    observedAt:Math.min(...accounts.map(account=>account!.receivedAt??account!.requestedAt!))};
}

export function portfolioPositionSummary(portfolio:LivePortfolio|undefined,now=Date.now()) {
  const accounts=portfolio?.exchanges.filter(account=>account.credentialsConfigured)??[];
  const complete=!!portfolio&&accounts.length>0&&accounts.every(account=>isFreshPortfolioExchange(account,portfolio,now));
  const rows=portfolio?accounts.filter(account=>isFreshPortfolioExchange(account,portfolio,now)).flatMap(account=>account.positions.filter(row=>row.quantity>0)):[];
  return {complete,count:complete?rows.length:null,exposureUsd:complete?rows.reduce((sum,row)=>sum+row.quantity*row.markPrice,0):undefined,
    unrealizedPnlUsd:complete&&rows.every(row=>Number.isFinite(row.unrealizedPnlUsd))?rows.reduce((sum,row)=>sum+row.unrealizedPnlUsd!,0):undefined,
    availableUsd:complete&&accounts.every(account=>Number.isFinite(account.freeUsd))?accounts.reduce((sum,account)=>sum+account.freeUsd!,0):undefined};
}
