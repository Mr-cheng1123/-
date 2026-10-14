import type {AppConfig,ExchangeId,LivePortfolio,LiveReadiness} from './types.js';
import type {FundingStatsDataset,FundingStatsRow} from './funding-statistics.js';

export interface OpportunityExchangeScope {
  config:Pick<AppConfig,'mode'|'exchanges'>;
  liveReadiness?:Pick<LiveReadiness,'exchanges'>;
  livePortfolio?:Pick<LivePortfolio,'exchanges'>;
}

/** Display scope, never trading permission or a current balance proof.
 * An actual successful private account read establishes a venue. Retain it during
 * ordinary retries; credential replacement clears the portfolio monitor's proof.
 * Public quotes or configured credentials alone do not establish a connection. */
export function opportunityExchangeScope(state:OpportunityExchangeScope):ExchangeId[] {
  const enabled=[...new Set(state.config.exchanges)];
  if(state.config.mode!=='live')return enabled;
  return enabled.filter(exchange=>{
    const readiness=state.liveReadiness?.exchanges.find(account=>account.exchange===exchange);
    const account=state.livePortfolio?.exchanges.find(account=>account.exchange===exchange);
    return readiness?.supported===true&&readiness.credentialsConfigured===true&&account?.credentialsConfigured===true&&
      (account.status==='ready'||typeof account.lastSuccessAt==='number'&&Number.isFinite(account.lastSuccessAt)&&account.lastSuccessAt>0);
  });
}

/** Return a projection without mutating records or changing execution eligibility. */
export function filterOpportunityPairs<T extends {longExchange:ExchangeId;shortExchange:ExchangeId}>(rows:readonly T[],exchanges:readonly ExchangeId[]):T[] {
  const connected=new Set(exchanges);
  return rows.filter(row=>connected.has(row.longExchange)&&connected.has(row.shortExchange));
}

/** Recalculate coverage and spreads from the same visible venues. Keep the public
 * provider dataset intact: this projection is only for the display endpoints. */
export function scopedFundingDataset<T extends FundingStatsDataset>(dataset:T,exchanges:readonly ExchangeId[]):T {
  const rows:FundingStatsRow[]=dataset.rows.flatMap(row=>{
    const cells:FundingStatsRow['cells']={};
    for(const exchange of exchanges){
      const cell=row.cells[exchange];
      if(cell)cells[exchange]=cell;
    }
    return Object.keys(cells).length?[{...row,cells}]:[];
  });
  return {...dataset,rows};
}
