import type {AppState,ExchangeId} from '../shared/types.js';
import type {FundingOpportunitiesResponse} from '../shared/funding-opportunities.js';
import {isPositionActive} from '../shared/ledger-lifecycle.js';
import {assertManagedPositionsForHandoff} from './maintenance-handoff.js';

/** A maintenance reload may preserve only permission explicitly present in the paused source process. */
export function authorizedReloadExchanges(state:AppState,candidates:FundingOpportunitiesResponse,now=Date.now(),preservePositions=false):ExchangeId[]{
  if(state.config.mode!=='live'||state.autoEnabled||!state.liveUnlocked)throw new Error('Authorization preservation requires a paused, already authorized live process');
  if(!Number.isFinite(state.timestamp)||Math.abs(now-state.timestamp)>15_000)throw new Error('Source process state is stale');
  if((!preservePositions&&state.positions.some(isPositionActive))||(state.unconfirmedOrders??[]).some(order=>order.historical!==true))throw new Error('Current strategy exposure must be resolved before a maintenance reload');
  if(preservePositions)assertManagedPositionsForHandoff(state.positions);
  const configured=(state.liveReadiness?.exchanges??[]).filter(venue=>state.config.exchanges.includes(venue.exchange)&&venue.supported&&venue.credentialsConfigured);
  if(configured.length<2)throw new Error('At least two configured venues are required');
  const authorized=new Set<ExchangeId>();
  for(const venue of configured)if(venue.executionAuthorized===true)authorized.add(venue.exchange);
  // Old processes did not expose per-venue permission. Only fresh explicit pair checks can prove it.
  if(configured.some(venue=>venue.executionAuthorized===undefined)){
    if(candidates.status!=='ready'||!Number.isFinite(candidates.computedAt)||Math.abs(now-candidates.computedAt)>15_000)throw new Error('Source authorization checks are stale');
    for(const row of candidates.rows){
      if(now-row.updatedAt>candidates.maxAgeMs||row.updatedAt>now+5000)continue;
      const opportunity=row.execution;
      if(!opportunity||opportunity.id!==row.id||opportunity.longExchange!==row.longExchange||opportunity.shortExchange!==row.shortExchange)continue;
      if(opportunity.checks?.some(check=>check.group==='account'&&check.label==='两腿交易账户已授权'&&check.pass===true)){
        for(const exchange of [row.longExchange,row.shortExchange])if(configured.some(venue=>venue.exchange===exchange&&venue.executionAuthorized===undefined))authorized.add(exchange);
      }
    }
  }
  // Environment-based permission applies to all configured clients, so widening the source scope is prohibited.
  if(configured.some(venue=>!authorized.has(venue.exchange)))throw new Error('Every configured venue must already have execution permission in the source process');
  return configured.map(venue=>venue.exchange).sort();
}
