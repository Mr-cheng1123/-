import type {AppState,Position} from '../../src/shared/types';
import {nativeTakerFeeRate} from '../../src/shared/trading-fees';
import {accountPositionKey,accountPositionMatchesLeg} from './account-position-identity';
import {ledgerCloseBreakdownNet,type LedgerCloseBatch,type LedgerCloseBreakdown,type LedgerHoldingEstimate} from './ledger-holding-estimate';
import type {LedgerPositionMetrics} from './ledger-position-metrics';

export const LEDGER_CLOSE_VALUE_RETENTION_MS=10_000;

/** A whole, previous book valuation, used only by the view while new books arrive. */
export interface LedgerCloseValueCache {
  identity:string;
  closingFeeSource:'exchange'|'reference';
  feeLegs:LedgerHoldingEstimate['legs'];
  netPnlUsd:number;
  closingFeesUsd:number;
  bookObservedAt:number;
  retainUntil:number;
  closePricing:'best-opposite';
  closeBatch:LedgerCloseBatch;
  breakdown:LedgerCloseBreakdown;
}

export interface LedgerCloseValue {
  status:'current'|'retained'|'pending';
  pendingReason?:'account'|'entry'|'fees'|'cash'|'book';
  netPnlUsd?:number;
  closingFeesUsd?:number;
  closingFeeSource?:'exchange'|'reference';
  feeLegs?:LedgerHoldingEstimate['legs'];
  bookObservedAt?:number;
  closePricing?:'best-opposite';
  closeBatch?:LedgerCloseBatch;
  breakdown?:LedgerCloseBreakdown;
  breakEven:'recovered'|'not_recovered'|'unknown';
  nextCache?:LedgerCloseValueCache;
}

const finite=(value:number|undefined):value is number=>Number.isFinite(value);
const sameNumber=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1e-10,Math.max(Math.abs(a),Math.abs(b))*1e-10);

function validBreakdown(value:LedgerCloseBreakdown|undefined,net:number,closingFees:number):value is LedgerCloseBreakdown {
  return !!value&&[value.pricePnlUsd,value.realizedPnlUsd,value.fundingUsd,value.paidFeesUsd,value.closingFeesUsd,
    value.transferCostUsd].every(finite)&&value.closingFeesUsd>=0&&value.transferCostUsd>=0&&
    sameNumber(value.closingFeesUsd,closingFees)&&sameNumber(ledgerCloseBreakdownNet(value),net);
}

function validCloseBatch(batch:LedgerCloseBatch|undefined,metrics:LedgerPositionMetrics):batch is LedgerCloseBatch {
  if(!batch||!['paired','excess-long','excess-short','single-long','single-short'].includes(batch.kind)||
    !finite(batch.longQuantity)||!finite(batch.shortQuantity)||batch.longQuantity<0||batch.shortQuantity<0||
    batch.longQuantity+batch.shortQuantity<=0||batch.longTotalQuantity!==metrics.long.quantity||batch.shortTotalQuantity!==metrics.short.quantity)
    return false;
  for(const side of ['long','short'] as const){
    const quantity=batch[side==='long'?'longQuantity':'shortQuantity'],total=batch[side==='long'?'longTotalQuantity':'shortTotalQuantity'];
    const price=batch[side==='long'?'longLimitPrice':'shortLimitPrice'],top=batch[side==='long'?'longTopQuantity':'shortTopQuantity'];
    const rate=batch[side==='long'?'longTakerFeeRate':'shortTakerFeeRate'];
    const entry=batch[side==='long'?'longEntryPrice':'shortEntryPrice'];
    if(quantity>total+1e-9||total>0&&(!finite(price)||price<=0||!finite(top)||top<=0||!finite(rate)||rate<0||
      !finite(entry)||entry<=0||!finite(metrics[side].entryPrice)||!sameNumber(entry,metrics[side].entryPrice!))||
      quantity>0&&quantity>top!+1e-9)return false;
  }
  return true;
}

/** Keep cached estimates within the same actual quantity, contract and cash cycle.
 * Marks and UPL deliberately do not change the key: a retained value is the whole
 * previous observation, never an old book adjustment mixed with a new mark. */
function closeValueIdentity(position:Position,metrics:LedgerPositionMetrics,estimate:LedgerHoldingEstimate,state:AppState,now:number):
  {identity?:string;pendingReason:LedgerCloseValue['pendingReason']} {
  if(position.mode!=='live'||position.status==='closed'||position.accountClosure||metrics.source!=='account'||
    metrics.observation.status!=='present'||!['paired','imbalanced','single'].includes(metrics.holding)||
    metrics.cycleMismatch&&!position.id.startsWith('account-display:')||!state.livePortfolio||
    !finite(metrics.long.quantity)||!finite(metrics.short.quantity)||metrics.long.quantity<0||metrics.short.quantity<0||
    metrics.long.quantity+metrics.short.quantity<=0)return {pendingReason:'account'};
  if(!finite(metrics.realizedPnlUsd)||!finite(metrics.fundingUsd)||!finite(metrics.feesUsd)||
    !finite(position.transferCostUsd)||position.transferCostUsd<0)
    return {pendingReason:'cash'};
  if(estimate.closingFeeSource!=='exchange'&&estimate.closingFeeSource!=='reference')return {pendingReason:'fees'};
  const legs=[],feeSources=[];
  for(const side of ['long','short'] as const){
    const leg=position[side],observed=metrics[side];
    if(observed.quantity!>0&&(!finite(observed.entryPrice)||observed.entryPrice<=0))return {pendingReason:'entry'};
    if(![observed.realizedPnlUsd,observed.fundingUsd,observed.feesUsd].every(finite))return {pendingReason:'cash'};
    const fee=estimate.legs.find(item=>item.side===side&&item.exchange===leg.exchange);
    // Preserve the recorded source. A public estimate must never be wrapped as an account observation.
    const nativeRate=fee?.takerFeeSource==='exchange'?nativeTakerFeeRate({takerFeeSource:fee.takerFeeSource,
      takerFeeRate:fee.takerFeeRate,takerFeeAt:fee.takerFeeAt},now):undefined;
    const referenceRate=fee?.takerFeeSource==='reference'&&finite(fee.takerFeeRate)&&fee.takerFeeRate>=0&&fee.takerFeeRate<=.01&&
      (fee.takerFeeReferenceSource==='official-reference'||fee.takerFeeReferenceSource==='account-reference'&&
        finite(fee.takerFeeReferenceAt)&&fee.takerFeeReferenceAt>0&&fee.takerFeeReferenceAt<=now)?fee.takerFeeRate:undefined;
    const feeRate=nativeRate??referenceRate;
    if(observed.quantity!>0&&feeRate===undefined)return {pendingReason:'fees'};
    if(observed.quantity!>0)feeSources.push(fee!.takerFeeSource);
    const account=state.livePortfolio.exchanges.find(item=>item.exchange===leg.exchange);
    if(!account)return {pendingReason:'account'};
    const rows=account.positions.filter(row=>accountPositionMatchesLeg(account.exchange,row,leg)&&row.quantity>0);
    if(observed.quantity!>0&&!rows.length)return {pendingReason:'account'};
    // Native cycle clocks and entry prices also distinguish a reopened contract
    // when the venue reuses a position identifier or the external display row ID.
    const cycles=rows.map(row=>[accountPositionKey(account.exchange,row),row.positionOpenedAt??null,
      row.cashFlowSince??null,row.entryPrice??null]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    legs.push([leg.exchange,leg.symbol,leg.side,leg.accountPositionKey??null,observed.quantity,observed.entryPrice??null,
      feeRate??null,fee?.takerFeeSource??null,referenceRate===undefined?null:
        [fee!.takerFeeReferenceSource,fee!.takerFeeReferenceAt??null,fee!.feeProfile??'unknown'],
      observed.realizedPnlUsd,observed.fundingUsd,observed.feesUsd,cycles]);
  }
  if(estimate.closingFeeSource==='exchange'&&feeSources.some(source=>source!=='exchange')||
    estimate.closingFeeSource==='reference'&&!feeSources.includes('reference'))return {pendingReason:'fees'};
  return {identity:JSON.stringify([position.id,position.base,position.openedAt,state.config.dataSource,position.transferCostUsd,
    estimate.closingFeeSource,legs]),pendingReason:'book'};
}

const sameCache=(a:LedgerCloseValueCache|undefined,b:LedgerCloseValueCache)=>!!a&&a.identity===b.identity&&
  a.closingFeeSource===b.closingFeeSource&&JSON.stringify(a.feeLegs)===JSON.stringify(b.feeLegs)&&
  a.netPnlUsd===b.netPnlUsd&&a.closingFeesUsd===b.closingFeesUsd&&a.bookObservedAt===b.bookObservedAt&&a.retainUntil===b.retainUntil&&
  a.closePricing===b.closePricing&&JSON.stringify(a.closeBatch)===JSON.stringify(b.closeBatch)&&JSON.stringify(a.breakdown)===JSON.stringify(b.breakdown);

/** Display only. Cached values never enter trading state or close decisions. */
export function ledgerCloseValue(position:Position,metrics:LedgerPositionMetrics,estimate:LedgerHoldingEstimate,state:AppState,
  now=Date.now(),previous?:LedgerCloseValueCache):LedgerCloseValue {
  const {identity,pendingReason}=closeValueIdentity(position,metrics,estimate,state,now);
  const pending:LedgerCloseValue={status:'pending',pendingReason,breakEven:'unknown'};
  if(identity===undefined)return pending;
  if(estimate.basis==='book'&&finite(estimate.closeNetPnlUsd)&&finite(estimate.closingFeesUsd)&&estimate.closingFeesUsd>=0&&
    validBreakdown(estimate.closeBreakdown,estimate.closeNetPnlUsd,estimate.closingFeesUsd)&&
    estimate.closePricing==='best-opposite'&&validCloseBatch(estimate.closeBatch,metrics)&&
    finite(estimate.closeBookObservedAt)&&estimate.closeBookObservedAt>0&&estimate.closeBookObservedAt<=now+5000&&
    finite(estimate.closeBookExpiresAt)&&now<estimate.closeBookExpiresAt){
    const cache:LedgerCloseValueCache={identity,closingFeeSource:estimate.closingFeeSource as 'exchange'|'reference',
      feeLegs:estimate.legs.map(leg=>({...leg})),netPnlUsd:estimate.closeNetPnlUsd,closingFeesUsd:estimate.closingFeesUsd,
      bookObservedAt:estimate.closeBookObservedAt,retainUntil:estimate.closeBookObservedAt+LEDGER_CLOSE_VALUE_RETENTION_MS,
      closePricing:'best-opposite',closeBatch:{...estimate.closeBatch},breakdown:{...estimate.closeBreakdown}};
    return {status:'current',closingFeeSource:cache.closingFeeSource,feeLegs:cache.feeLegs,
      netPnlUsd:cache.netPnlUsd,closingFeesUsd:cache.closingFeesUsd,bookObservedAt:cache.bookObservedAt,
      closePricing:cache.closePricing,closeBatch:cache.closeBatch,breakdown:cache.breakdown,
      breakEven:cache.netPnlUsd>=0?'recovered':'not_recovered',
      ...(now<cache.retainUntil?{nextCache:sameCache(previous,cache)?previous:cache}:{})};
  }
  if(previous?.identity===identity&&finite(previous.netPnlUsd)&&finite(previous.closingFeesUsd)&&previous.closingFeesUsd>=0&&
    validBreakdown(previous.breakdown,previous.netPnlUsd,previous.closingFeesUsd)&&
    previous.closePricing==='best-opposite'&&validCloseBatch(previous.closeBatch,metrics)&&
    finite(previous.bookObservedAt)&&previous.bookObservedAt>0&&previous.bookObservedAt<=now+5000&&
    previous.retainUntil===previous.bookObservedAt+LEDGER_CLOSE_VALUE_RETENTION_MS&&now<previous.retainUntil)
    return {status:'retained',closingFeeSource:previous.closingFeeSource,feeLegs:previous.feeLegs,
      netPnlUsd:previous.netPnlUsd,closingFeesUsd:previous.closingFeesUsd,
      bookObservedAt:previous.bookObservedAt,closePricing:previous.closePricing,closeBatch:previous.closeBatch,
      breakdown:previous.breakdown,breakEven:'unknown',nextCache:previous};
  return pending;
}

export function ledgerCloseValueBreakEvenLabel(value:LedgerCloseValue):string {
  if(value.status!=='current'||value.breakEven==='unknown')return '回本待核验';
  if(value.closingFeeSource==='reference')return value.breakEven==='recovered'?'参考已回本（本地费率）':'参考尚未回本（本地费率）';
  return value.breakEven==='recovered'?value.closePricing==='best-opposite'?'预计已回本（分批估算）':'已回本（可平估计）':'尚未回本';
}

/** Earliest cache expiry adds one scheduled refresh, with no one-second table timer. */
export function ledgerCloseValueDeadline(cache:ReadonlyMap<string,LedgerCloseValueCache>):number|undefined {
  const deadlines=[...cache.values()].map(value=>value.retainUntil).filter(Number.isFinite);
  return deadlines.length?Math.min(...deadlines):undefined;
}

/** Preserve the map/reference on StrictMode's repeated effects and unchanged state. */
export function updateLedgerCloseValueCache(previous:ReadonlyMap<string,LedgerCloseValueCache>,values:ReadonlyMap<string,LedgerCloseValue>):
  ReadonlyMap<string,LedgerCloseValueCache> {
  const next=new Map<string,LedgerCloseValueCache>();
  for(const [id,value] of values)if(value.nextCache)next.set(id,value.nextCache);
  if(previous.size===next.size&&[...next].every(([id,value])=>previous.get(id)===value))return previous;
  return next;
}
