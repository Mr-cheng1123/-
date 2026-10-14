import {resolve} from 'node:path';
import type {SavedState} from './store.js';
import type {ExchangeId} from '../shared/types.js';
import {isCurrentUnconfirmedOrder} from '../shared/ledger-lifecycle.js';
import {maintenanceHash,maintenanceLedgerHash,maintenancePositionPartition,validateMaintenanceHandoff,type MaintenanceHandoff} from './maintenance-handoff.js';

export interface PreviewMaintenanceHandoff extends MaintenanceHandoff {sourceOrdersHash:string}
export function previewHasPendingOperations(ledger:SavedState):boolean{
  return !!ledger.manualEntryOperations?.some(o=>['queued','checking','preparing','submitting','reconciling'].includes(o.state))||
    !!ledger.manualCloseOperations?.some(o=>['checking','closing'].includes(o.state));
}

/** Freeze the drained journal while proving that no request slipped into the last-GET/shutdown gap. */
export function sealPreviewMaintenanceHandoff(source:PreviewMaintenanceHandoff,ledger:SavedState,project:string,
  credentialsHash:string,eligible:ExchangeId[],sourceExited:boolean,now=Date.now()):MaintenanceHandoff{
  const partition=maintenancePositionPartition(ledger.positions);
  if(!sourceExited||source.version!==2||!Number.isSafeInteger(source.sourcePid)||source.sourcePid<=0||
    !Number.isFinite(source.at)||now-source.at>120000||source.at>now+5000||resolve(source.project)!==resolve(project)||
    !Array.isArray(source.positionIds)||source.positionIds.length||partition.positionIds.length||
    !Array.isArray(source.attentionPositionIds)||
    maintenanceHash(partition.attentionPositionIds)!==maintenanceHash([...source.attentionPositionIds].sort())||
    source.credentialsHash!==credentialsHash||maintenanceHash(ledger.config)!==source.configHash||
    typeof source.sourceOrdersHash!=='string'||maintenanceHash(ledger.orders)!==source.sourceOrdersHash||
    ledger.killSwitch||previewHasPendingOperations(ledger)||ledger.orders.some(o=>isCurrentUnconfirmedOrder(o,ledger.positions)))
    throw new Error('The drained source scope, policy, order journal or attention records changed');
  // Only standard fields reach the one-time consumer; the source orders hash is used by this sealing gate.
  const proof:MaintenanceHandoff={version:2,at:now,sourcePid:source.sourcePid,project:source.project,credentialsHash,
    configHash:source.configHash,ledgerHash:maintenanceLedgerHash(ledger),venues:[...source.venues],...partition};
  validateMaintenanceHandoff(proof,ledger,ledger.config,project,credentialsHash,eligible,now);
  return proof;
}
