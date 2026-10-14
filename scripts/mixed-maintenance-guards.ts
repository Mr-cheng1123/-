import {resolve} from 'node:path';
import {maintenanceHash,maintenanceLedgerHash,maintenancePositionPartition,maintenanceVenueScope,
  validateMaintenanceHandoff,verifyMaintenanceFundingReads,type MaintenanceHandoff} from '../src/core/maintenance-handoff.js';
import {previewHasPendingOperations} from '../src/core/preview-maintenance-handoff.js';
import {isCurrentUnconfirmedOrder} from '../src/shared/ledger-lifecycle.js';
import type {SavedState} from '../src/core/store.js';
import type {AppState,ExchangeId,FundingPayment} from '../src/shared/types.js';

/** The preflight order hash rejects requests accepted in the final GET / shutdown gap. */
export interface MixedMaintenanceReceipt extends MaintenanceHandoff {sourceOrdersHash:string}
export function assertMixedMaintenanceIdle(ledger:SavedState,state?:AppState):void {
  if(ledger.config.mode!=='live'||ledger.config.autoEnabled||ledger.killSwitch||previewHasPendingOperations(ledger)||
    ledger.orders.some(order=>isCurrentUnconfirmedOrder(order,ledger.positions))||
    state&&(state.autoEnabled||state.killSwitch||state.manualCloseOperations?.some(operation=>['checking','closing'].includes(operation.state))))
    throw new Error('Mixed maintenance requires a paused source with no pending financial operation');
  maintenancePositionPartition(ledger.positions);
}
export function assertMixedMaintenanceScope(venues:readonly ExchangeId[],eligible:readonly ExchangeId[],positions:SavedState['positions']):ExchangeId[] {
  const authorized=maintenanceVenueScope(venues,eligible),managed=new Set(maintenancePositionPartition(positions).positionIds);
  if(positions.some(position=>managed.has(position.id)&&[position.long,position.short].some(leg=>!authorized.includes(leg.exchange))))
    throw new Error('The exact authorized source scope does not cover both managed legs');
  return authorized;
}
/** No financial write may be introduced by sealing. Changed cash requires independent native GET receipts. */
export function sealMixedMaintenanceHandoff(source:MixedMaintenanceReceipt,baseline:SavedState,ledger:SavedState,project:string,
  credentialsHash:string,eligible:ExchangeId[],sourceExited:boolean,payments:readonly (FundingPayment&{exchange:ExchangeId})[]=[],now=Date.now()):
  {proof:MaintenanceHandoff;fundingReceiptsObserved:number} {
  assertMixedMaintenanceIdle(baseline);assertMixedMaintenanceIdle(ledger);
  const partition=maintenancePositionPartition(ledger.positions);
  if(!sourceExited||source.version!==2||!Number.isSafeInteger(source.sourcePid)||source.sourcePid<=0||
    !Number.isFinite(source.at)||now-source.at>120000||source.at>now+5000||resolve(source.project)!==resolve(project)||
    source.credentialsHash!==credentialsHash||maintenanceHash(ledger.config)!==source.configHash||
    maintenanceHash(baseline.config)!==source.configHash||maintenanceLedgerHash(baseline)!==source.ledgerHash||
    typeof source.sourceOrdersHash!=='string'||maintenanceHash(baseline.orders)!==source.sourceOrdersHash||
    maintenanceHash(ledger.orders)!==source.sourceOrdersHash||
    !Array.isArray(source.positionIds)||!Array.isArray(source.attentionPositionIds)||
    maintenanceHash(partition)!==maintenanceHash({positionIds:[...source.positionIds].sort(),attentionPositionIds:[...source.attentionPositionIds].sort()})||
    maintenanceHash(maintenancePositionPartition(baseline.positions))!==maintenanceHash(partition))
    throw new Error('The drained source policy, order journal or management scope changed');
  assertMixedMaintenanceScope(source.venues,eligible,ledger.positions);
  const fundingReceiptsObserved=maintenanceLedgerHash(ledger)===source.ledgerHash?0:
    verifyMaintenanceFundingReads(baseline,ledger,payments,now);
  const proof:MaintenanceHandoff={version:2,at:now,sourcePid:source.sourcePid,project:source.project,credentialsHash,
    configHash:source.configHash,ledgerHash:maintenanceLedgerHash(ledger),venues:[...source.venues].sort(),...partition};
  validateMaintenanceHandoff(proof,ledger,ledger.config,project,credentialsHash,eligible,now);
  return {proof,fundingReceiptsObserved};
}
