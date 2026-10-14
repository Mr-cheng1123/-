import { randomUUID } from 'node:crypto';
import {EXCHANGES,type LiveAuthorizationReport} from '../shared/types.js';
import type { AccountState, AppConfig, AppState, ExchangeAdapter, ExchangeHealth, ExchangeId, FundingPayment, JournalOrder, LiveReadiness, LivePortfolio, MarketSnapshot, NativeExitRecoveryAudit, Opportunity, OrderResult, Position, PrivateReadContext } from '../shared/types.js';
import { validateConfig } from '../shared/config.js';
import { createAdapters, createPublicMonitoringAdapters } from '../adapters/index.js';
import { calculateOpportunities } from './strategy.js';
import { evaluateHoldingDecision, confirmHoldingDecision, type HoldingConfirmation } from './holding-decision.js';
import {FundingExitStabilityTracker} from './funding-exit-stability.js';
import { Execution, refreshPnl, MakerClosePreflightError, preparedBookChangedReason, type MakerClosePreparation, type CloseProfitValidation } from './execution.js';
import { Store } from './store.js';
import {accountExposureIncident,accountExposureIncidentMessage} from './account-exposure-incident.js';
import {runExternalExposureReduction} from './external-exposure-reduction.js';
import {performanceSummary} from './performance-summary.js';
import {executionStatistics} from './execution-statistics.js';
import {operationConfigDigest} from './operation-config-digest.js';
import {runtimeSourceVersion} from './runtime-source-version.js';
import {operationAccountConfirmationAt,type OperationAccountObservation} from './operation-account-evidence.js';
import type {BeginTradingOperation} from './trading-operation-tracker.js';
import {AutomaticEntryAttempts} from './automatic-entry-attempts.js';
import {FundingEntryStabilityTracker} from './funding-entry-stability.js';
import {currentExitStrategyPosition} from '../shared/current-exit-strategy.js';
import {assertCurrentManagementRestorationEligible,buildCurrentManagementRestorationAudit} from './current-management-restoration.js';
import {assertCurrentIocCloseRestorationEligible,buildCurrentIocCloseRestorationAudit,type CurrentIocNativeOrderProof} from './current-ioc-close-restoration.js';
import {isDurableConfirmedMakerZero} from './confirmed-terminal-zero.js';
import {isDurableConfirmedIocOpeningZero} from './confirmed-ioc-opening-zero.js';
import type {FundingEntryConfirmationEvidence} from '../shared/funding-entry-stability.js';
import { classifyNetworkError, ExchangeNetworkError, networkMessage } from '../adapters/network.js';
import {AccountReadPending,accountReadDiagnostic} from './account-read-diagnostic.js';
import type { FundingStatsDataset } from '../shared/funding-statistics.js';
import { calculateFundingCandidates, fundingPairKey, type FundingCandidate, type FundingAutoVerification } from '../shared/funding-opportunities.js';
import { inspectLiveEnvironment, liveEligibleExchanges, type LiveEnvironment } from './live-readiness.js';
import { isFeeOnly } from '../shared/strategy-profile.js';
import { inspectLiveStart, type LiveStartReadiness } from './live-start.js';
import { legEntryMarginUsd } from './margin.js';
import { gateReadError } from '../adapters/gate-private.js';
import { bitgetAccountReadError } from '../adapters/bitget-account.js';
import { TradingError, tradingError } from './trading-errors.js';
import {SelectedPublicBookError,selectedPublicBookReason} from './selected-public-book-error.js';
import { OrderNotSubmittedError } from '../adapters/order-rejection.js';
import { SpreadHistory } from './spread-history.js';
import { accountCoins, coinBase, collectCoinExclusions, unresolvedCoin } from './coin-exclusions.js';
import {assessProfitExit,assessBestOppositeProfitExit,bothExitProfitsPass,assessAlignedExit,alignedExitProfitsPass,type AlignedExitAssessment} from './profit-exit.js';
import {planConfirmedLotTailRestoration} from './confirmed-lot-tail.js';
import {confirmedIocOrderProof,planConfirmedIocTail,type ConfirmedIocTailPlan} from './confirmed-ioc-tail.js';
import {estimateNativeExitReserve} from './native-exit-reserve.js';
import {configUpdatePolicy} from '../shared/config-update-policy.js';
import {configConcurrencyKey} from '../shared/config-concurrency.js';
import {credentialUpdateBlocker} from '../shared/credential-update-policy.js';
import {applyEntryAvailability} from './entry-availability.js';
import {quoteIsFresh,quoteObservedAt} from './market-validity.js';
import {isPositionActive,isCurrentUnconfirmedOrder,isHistoricalJournalOrder,isUnconfirmedJournalOrder} from '../shared/ledger-lifecycle.js';
import {accountClosureLegs,flatAccountEvidence,type FlatAccountEvidence} from './account-closure.js';
import {scheduleFundingWatches} from './funding-watch-scheduler.js';
import {PublicFundingMonitor} from './public-funding-monitor.js';
import {buildFundingVerificationPriorities} from './funding-verification-priority.js';



import {instrumentIdentityBlockReason} from '../shared/instrument-identity.js';
import {findFundingOwner,fundingRecordsForRead,fundingWindowEnd} from './funding-attribution.js';
import {FundingReadRetry,type FundingReadClock,type FundingReadPhase} from './funding-read-retry.js';
import {ManualEntryOperations,ManualEntryCancelled,MANUAL_ENTRY_DEADLINE_MS,MANUAL_ENTRY_QUEUE_MS} from './manual-entry-operations.js';
import type {ManualEntryOperation} from '../shared/manual-entry.js';
import {manualEntryOpportunityBase,pendingManualEntryBases} from '../shared/manual-entry.js';
import {estimatedTakerFeeRate,nativeMakerFeeRate,nativeTakerFeeRate} from '../shared/trading-fees.js';
import {bestOppositeLevel} from './entry-batch.js';
import {automaticEntryAssessment,automaticEntryCandidateReady} from '../shared/automatic-entry-policy.js';
import {isQuantityOnStep,quantityAdd,quantitySubtract} from './order-quantity.js';
import {planMakerClose,selectMakerCloseLeg} from './maker-close-plan.js';
import {exitProfitThresholdUsd,freezeProfitExitNotional} from './exit-profit-threshold.js';
import {feeRebatePct} from '../shared/fee-rebates.js';
import {projectPositionFeeRebate} from '../shared/position-fee-rebates.js';
import {isTerminalOrderReceipt,isProvenNoSubmitReceipt} from '../shared/order-receipt-validity.js';

import {RealtimeLatency} from './realtime-latency.js';
import type {ManualCloseRequest,ManualCloseOperation} from '../shared/manual-close.js';
import {selectManualCloseLegs,type SelectedManualCloseLeg} from './manual-close-selection.js';
import {executeScopedManualClose,manualCloseLegKey,verifyCloseSlots} from './scoped-manual-close.js';
import type {AccountPosition,PositionLeg} from '../shared/types.js';
interface ManualEntryContext {generation:number;operationId?:string;ensure:()=>void;stage:(stage:'checking'|'preparing',message:string)=>void;attachPosition?:(position:Position)=>void;commit?:()=>void;reconciling?:()=>void;fail?:(error:string,position:Position)=>void;
  preflight?:{accounts:Map<ExchangeId,AccountState>;checkedAt:number;symbols:Map<ExchangeId,string>};tradingPrepared?:boolean}
export interface EngineOptions { spreadHistory?:SpreadHistory;publicSnapshotDeadlineMs?:number;privateReadDeadlineMs?:number;fundingStatistics?:()=>FundingStatsDataset;liveEnvironment?:Readonly<Record<string,string|undefined>>;adapterFactory?:(config:AppConfig)=>ExchangeAdapter[];publicMonitoringAdapterFactory?:(config:AppConfig)=>ExchangeAdapter[];
  /** Only a consumed maintenance proof may supply this source process's exact permission scope. */
  maintenanceExchanges?:readonly ExchangeId[] }
export interface SelectedReconcileRequest {
  acknowledgement:'RECONCILE_SELECTED_POSITIONS'|'RECONCILE_CURRENT_STRATEGY_POSITIONS';expiresAt:number;positionIds:string[];
  expected:Array<{id:string;base:string;openedAt:number;longExchange:ExchangeId;longSymbol:string;longQuantity:number;
    shortExchange:ExchangeId;shortSymbol:string;shortQuantity:number}>;
}
export interface SelectedMakerCloseRepairRequest {
  acknowledgement:'REPAIR_SELECTED_MAKER_CLOSE_TAIL'|'REPAIR_SELECTED_MAKER_CLOSE_LOT_TAIL';expiresAt:number;positionId:string;parentClientOrderId:string;
  legacyPeerClientOrderIds?:string[];
  feeCorrectionAcknowledgement?:'RECONCILE_CONFIRMED_PEER_FEES';
  expectedPeerFeeCorrections?:Array<{clientOrderId:string;bookedFeeUsd:number;confirmedFeeUsd:number}>;
  expected:{base:string;openedAt:number;longExchange:ExchangeId;longSymbol:string;longQuantity:number;
    shortExchange:ExchangeId;shortSymbol:string;shortQuantity:number};
}
export interface SelectedNativeExitRecoveryRequest {
  acknowledgement:'RESTORE_SELECTED_NATIVE_EXIT_MANAGEMENT';operationId:string;expiresAt:number;positionId:string;
  parentClientOrderId:string;confirmedTailParentClientOrderId?:string;confirmedIocBatchId?:string;unknownClientOrderIds:string[];expected:SelectedMakerCloseRepairRequest['expected'];
}
export interface SelectedExternalExposureRecoveryRequest {
  acknowledgement:'RESTORE_SELECTED_EXTERNAL_EXPOSURE_MANAGEMENT';expiresAt:number;positionId:string;
  expected:SelectedMakerCloseRepairRequest['expected'];
}
const ENTRY_RETRY_COOLDOWN_MS=120_000;
export const FUNDING_WATCH_LIMIT=6;
interface FundingWatch { candidate:FundingCandidate;expiresAt:number;selectedAt:number;manual:boolean }
class PublicSnapshotTimeout extends Error {
  constructor(){super('Public market snapshot timeout');}
}
class PublicSnapshotBusy extends Error {
  constructor(){super('A public snapshot read is already in progress');}
}
class PrivateReadTimeout extends ExchangeNetworkError {
  constructor(exchange:ExchangeId){super('TIMEOUT',0,undefined,exchange);this.message='交易所只读请求超时，本轮已跳过；迟到结果不会更新账户或资金费';}
}
class MakerRepairAccountPending extends Error {
  constructor(reason:'freshness'|'quantity'){super(reason==='freshness'?'已确认尾差成交，等待本批之后的新鲜账户时间证据':'已确认尾差成交，等待账户数量完成本批更新');}
}
interface MakerRepairSettlement {
  identities:Map<ExchangeId,string>;quantities:Map<ExchangeId,number[]>;
}
const makerRepairNativeIdentity=(exchange:ExchangeId,row:AccountPosition)=>JSON.stringify({exchange,symbol:row.symbol,side:row.side,
  marginMode:row.marginMode,positionId:row.positionId,positionOpenedAt:row.positionOpenedAt,entryPrice:row.entryPrice});
export class Engine {
  snapshots:MarketSnapshot[]=[];opportunities:Opportunity[]=[];health:ExchangeHealth[]=[];
  adapters:ExchangeAdapter[]=[];accounts=new Map<ExchangeId,AccountState>();errors=new Map<ExchangeId,number>();
  autoEnabled=false;running=false;private timer?:ReturnType<typeof setTimeout>;private queue=Promise.resolve();
  private lastLedgerAt=0;private lastEquityAt=0;private stopping=false;
  private reconciledPositions=new Set<string>();
  private continuingClosePositions=new Set<string>();
  private pendingCloseChecks=new Map<string,number>();
  private readonly pendingCloseReadWorkers=new Map<string,Promise<void>>();
  private readonly holdingExitReadWorkers=new Map<string,Promise<void>>();
  /** Session authority, never inferred from a saved incident or historical attention row. */
  private readonly externalExposureSources=new Set<string>();
  private readonly externalExposureWorkers=new Map<string,Promise<void>>();
  private readonly externalExposureRetryAt=new Map<string,number>();
  private readonly externalExposureRetryTimers=new Map<string,ReturnType<typeof setTimeout>>();
  private publicSnapshotRequests=new Map<ExchangeId,Promise<MarketSnapshot[]>>();
  private privateReadRequests=new WeakMap<ExchangeAdapter,Map<string,Promise<unknown>>>();
  private readonly accountReadAt=new WeakMap<object,number>();
  private readonly accountReadSources=new WeakMap<object,{adapter:ExchangeAdapter;config:AppConfig;generation:number}>();
  private readonly accountCacheRevision=new Map<ExchangeId,number>();
  private readonly fundingReadRetry=new FundingReadRetry();
  private fundingWatch=new Map<string,FundingWatch>();
  private fundingChecked=new Map<string,number>();
  private publicMonitor?:PublicFundingMonitor;
  private unavailableSnapshots=new Set<string>();
  private liveEnvironment:LiveEnvironment;
  private holdingSamples=new Map<string,HoldingConfirmation>();
  private feeExitPreviewSamples=new Map<string,HoldingConfirmation>();
  private readonly fundingExitStability=new FundingExitStabilityTracker();
  private sessionLivePermission=false;
  private sessionExchanges?:Set<ExchangeId>;
  private environmentPermissionRevoked=false;
  private credentialUpdatePending=false;
  private maintenanceTradingPending=false;
  private observedPortfolio?:LivePortfolio;
  private startGeneration=0;
  private readonly manualEntries:ManualEntryOperations;
  private readonly entryContractPreviews=new Map<string,{status:'ready'|'pending'|'failed';at:number;reason?:string}>();
  private entryContractPreviewRunning=false;
  /** Exact contract identities outlive short-lived books; fee evidence remains in the account adapter. */

  /** Independent per-venue bulk GETs never wait for entry discovery or a peer venue. */


  private pendingManualPermission?:{restore:()=>void};
  private readonly overlaidSnapshotFees=new WeakSet<MarketSnapshot>();
  private realtimeTimer?:ReturnType<typeof setTimeout>;
  private realtimeWarmTimer?:ReturnType<typeof setTimeout>;





  private realtimeQueued=false;
  private realtimeProfitTimer?:ReturnType<typeof setTimeout>;
  private realtimeProfitQueued=false;
  private readonly realtimeProfitPending=new Set<string>();
  private readonly realtimeProfitSettled=new Set<string>();
  private readonly realtimeProfitPreparing=new Set<string>();
  private readonly realtimeProfitRetryTimers=new Map<string,ReturnType<typeof setTimeout>>();
  private readonly realtimeProfitFeeRetryAt=new Map<string,number>();
  private readonly realtimeProfitSignalAt=new Map<string,number>();
  private readonly realtimeProfitPreparationFailureAt=new Map<string,number>();
  private readonly confirmedLotTailPreparing=new Set<string>();
  private readonly nativeExitTailPreparing=new Set<string>();
  private readonly confirmedLotTailRetryAt=new Map<string,number>();
  private readonly realtimeProfitAccountRequests=new WeakMap<ExchangeAdapter,Promise<AccountState>>();
  private readonly realtimeProfitAccountReadProofs=new WeakMap<AccountState,{financialEpoch:number;cacheRevision:number}>();
  /** Exact native reads for one close commit; never a balance/entry cache after unrelated financial activity. */
  private readonly realtimeProfitAccountProofs=new Map<string,{financialProof:string;accounts:Map<ExchangeId,AccountState>}>();
  private realtimeWarmRunning=false;
  private lastRealtimeQuoteAt=0;
  private lastRealtimeSignalAt=0;
  private readonly realtimeLatency=new RealtimeLatency();
  private readonly realtimePrepared=new Map<string,{generation:number;config:AppConfig;financialEpoch:number;context:ManualEntryContext}>();
  private readonly realtimePrepareFailedAt=new Map<string,number>();
  private financialEpoch=0;
  /** A scoped recovery owns only the exact new native cash objects it creates. */
  private makerFinancialScopeObserver?:(journal:JournalOrder|undefined,previousEpoch:number)=>void;
  private readonly automaticEntryAttempts=new AutomaticEntryAttempts();
  /** Only a proven no-send automatic product rejection is cached; it never grants trading access. */
  private readonly automaticProductRejections=new Map<string,{until:number;generation:number;config:AppConfig;adapters:ExchangeAdapter[]}>();
  private readonly fundingEntryStability=new FundingEntryStabilityTracker();
  private readonly automaticEntryScopes=new WeakMap<Position,{generation:number;config:AppConfig}>();
  private readonly manualCloseRequests=new Map<string,Promise<Position>>();
  readonly execution:Execution;
  private readonly spreadHistory:SpreadHistory;
  constructor(readonly store:Store,private readonly livePermissionGranted=false,private readonly options:EngineOptions={}){
    this.maintenanceTradingPending=options.maintenanceExchanges!==undefined;
    this.liveEnvironment=inspectLiveEnvironment(options.liveEnvironment??process.env);
    if(options.maintenanceExchanges!==undefined){
      const scope=options.maintenanceExchanges,eligible=liveEligibleExchanges(this.liveEnvironment,this.config.exchanges);
      if(this.config.mode!=='live'||!livePermissionGranted||!this.liveEnvironment.permissionGranted||!scope.length||
        new Set(scope).size!==scope.length||scope.some(exchange=>!eligible.some(venue=>venue.exchange===exchange)))
        throw new Error('Maintenance execution scope is invalid');
      this.sessionExchanges=new Set(scope);this.sessionLivePermission=true;
    }
    this.adapters=(options.adapterFactory??createAdapters)(this.config);
    this.health=this.config.exchanges.map(exchange=>({exchange,status:'connecting',latencyMs:0,lastSuccess:0}));
    this.spreadHistory=options.spreadHistory??new SpreadHistory(store.data.spreadObservations);
    this.execution=new Execution(store,{config:()=>this.config,snapshot:(x,b)=>this.snapshot(x,b),adapter:x=>{this.assertLiveAccess(x as ExchangeId);return this.adapter(x);},liveUnlocked:()=>this.liveUnlocked,allowEntry:p=>!this.store.data.killSwitch&&!this.credentialUpdatePending&&!this.coinExclusions(p.id).some(x=>x.base===coinBase(p.base)),
      refreshSnapshots:(base,exchanges)=>this.refreshExecutionSnapshots(base,exchanges),
      refreshReductionSnapshots:(base,exchanges)=>this.refreshExecutionSnapshots(base,exchanges,false),
      fundingExitQualified:(p,assessment,long,short,now)=>this.confirmLotTailFundingExit(p,assessment,long,short,now),
      assertAutomaticEntryStability:p=>this.assertAutomaticFundingEntryStability(p),
      confirmCloseSuspension:p=>this.canResumeConditionalHolding(p),
      serialize:fn=>this.exclusive(fn),makerActionsAllowed:()=>!this.stopping&&!this.credentialUpdatePending&&!this.maintenanceTradingPending&&!this.store.data.killSwitch&&this.liveUnlocked,
      makerCloseSettled:p=>this.scheduleRealtimeProfitExits(p,50),
      iocProfitCloseSettled:p=>{
        if(isPositionActive(p)&&p.closeRequestedAt!==undefined)this.continuingClosePositions.add(p.id);
        else {this.continuingClosePositions.delete(p.id);this.pendingCloseChecks.delete(p.id);}
        this.scheduleRealtimeProfitExits(p,50);
      },
      makerFinancialActivity:journal=>{const previous=this.financialEpoch++;this.realtimePrepared.clear();this.makerFinancialScopeObserver?.(journal,previous);},
      makerCloseSignalAt:p=>this.realtimeProfitSignalAt.get(p.id),
      trace:event=>{this.realtimeLatency.observe(event);if(event.phase==='first-submit'||event.phase==='finished')this.financialEpoch++;if(event.phase==='first-submit')this.realtimePrepared.clear();},
      canUseSnapshot:(x,b)=>!this.paperFeeOnly()||(!this.unavailableSnapshots.has(this.snapshotKey(x as ExchangeId,b))&&['online','degraded'].includes(this.health.find(h=>h.exchange===x)?.status??'')),halt:(r,base)=>this.halt(r,base)});
    // Never resume automatic entries after restart. A crash may leave exchange-side orders unresolved.
    if(this.config.mode==='live' && (store.data.positions.some(isPositionActive)||store.data.orders.some(o=>isCurrentUnconfirmedOrder(o,store.data.positions)))){
      for(const p of this.activePositions()){p.status='attention';p.riskReasons=['实盘进程恢复，等待账户与订单对账'];}
      // Scoped, not global: the affected coins are already excluded from new entries (see coinExclusions), and
      // automatic entry only exists after an explicit startLive. A persisted global stop would also disable the
      // emergency-stop button and block every unrelated coin until the user cleared it by hand.
      store.log('warn','实盘重启检测到未完成仓位或订单：对应币种已暂停新开仓，其他币种不受影响；请核对交易所仓位与订单');
    }
    if(this.config.mode==='paper'){
      for(const o of store.data.orders.filter(o=>!o.result))o.result={id:o.request.clientOrderId,clientOrderId:o.request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()};
      for(const p of this.activePositions().filter(p=>p.status==='opening'||p.status==='closing')){p.status='attention';p.riskReasons=['纸面进程恢复中断，请检查并关闭残余仓位'];}
    }
    if(store.data.positions.some(p=>p.mode==='paper'&&p.status!=='closed'))store.log('warn','纸面仓位已恢复；离线期间的资金费不补造，收益记录可能缺失');
    if(this.config.mode==='live'&&!this.liveUnlocked)store.log('warn','实盘只读准备状态：公开行情可用，账户和交易接口已锁定');
    this.manualEntries=new ManualEntryOperations(store.data.manualEntryOperations??= [],{persist:()=>this.persistObservation(()=>store.save()),positions:()=>store.data.positions,orders:()=>store.data.orders,hasOrderIntent:id=>store.data.orders.some(order=>order.positionId===id),
      log:operation=>this.persistObservation(()=>store.log(['failed','cancelled','expired'].includes(operation.state)?'warn':'info',`手动开仓 ${operation.opportunityId} · ${operation.message}`,operation.positionId??operation.id))});
    this.manualEntries.recover();
    for(const operation of store.data.manualCloseOperations??[]){
      if(operation.state==='checking'||operation.state==='closing'){
        operation.state=operation.positionId?'closing':'failed';operation.error='进程已重启：本次平仓不会自动重发，请核对账户及原订单';
      }
    }
  }
  get config(){return this.store.data.config;}
  /** Observations have no authority to change orders, permissions or the financial ledger. */
  private diagnostic<T>(action:()=>T):T|undefined {try{return action();}catch{return undefined;}}
  private beginOperation(input:Omit<BeginTradingOperation,'mode'|'configDigest'|'runtimeVersion'>):string|undefined {
    return this.diagnostic(()=>this.store.operations.begin({...input,mode:this.config.mode,
      configDigest:operationConfigDigest(this.config),runtimeVersion:runtimeSourceVersion()})?.id);
  }
  private operationPreflightFailed(id:string|undefined,error:unknown):void {
    if(!id)return;
    this.diagnostic(()=>{
      const operation=this.store.operations.activeRows().find(row=>row.id===id);
      if(!operation||operation.endedAt!==undefined||operation.attempts.submitted>0)return;
      this.store.operations.attemptNotSent(id,'preflight-not-sent',safeMessage(error));
      this.store.operations.end(id,error instanceof ManualEntryCancelled?'cancelled':'failed',
        {code:'preflight-not-sent',text:safeMessage(error)});
    });
  }
  private confirmOperationAccounts(now=Date.now()):void {
    this.diagnostic(()=>{
      const operations=this.store.operations.activeRows().filter(operation=>operation.stages.pairedAt!==undefined);
      if(!operations.length)return;
      const positions=new Map(this.store.data.positions.map(position=>[position.id,position]));
      const accounts=new Map<ExchangeId,OperationAccountObservation>();
      for(const [exchange,account] of this.accounts){
        const requestedAt=this.accountReadAt.get(account);
        if(requestedAt!==undefined)accounts.set(exchange,{account,requestedAt});
      }
      for(const operation of operations){
        const position=positions.get(operation.positionId);if(!position)continue;
        const at=operationAccountConfirmationAt(operation,position,accounts,now,this.config.maxSnapshotAgeMs);
        if(at!==undefined)this.store.operations.confirm(operation.id,at);
      }
    });
  }
  /** Reuse the existing read-only portfolio refresh for diagnostics only. Never publish it as an execution account proof. */
  observeOperationPortfolio(portfolio:LivePortfolio):void {
    this.diagnostic(()=>{
      const now=Date.now(),maxAgeMs=Math.min(this.config.maxSnapshotAgeMs,portfolio.maxAgeMs);
      if(!Number.isFinite(maxAgeMs)||maxAgeMs<=0||!Array.isArray(portfolio.exchanges))return;
      const operations=this.store.operations.activeRows().filter(operation=>operation.mode==='live'&&operation.stages.pairedAt!==undefined);
      if(!operations.length)return;
      const positions=new Map(this.store.data.positions.map(position=>[position.id,position]));
      const accounts=new Map<ExchangeId,OperationAccountObservation>();
      for(const row of portfolio.exchanges){
        if(!row.credentialsConfigured||row.status!=='ready'||!EXCHANGES.includes(row.exchange)||
          portfolio.exchanges.filter(other=>other.exchange===row.exchange).length!==1||
          !Number.isFinite(row.requestedAt)||row.requestedAt!<=0||row.requestedAt!>now||now-row.requestedAt!>maxAgeMs||
          !Number.isFinite(row.freeUsd)||!Number.isFinite(row.equityUsd)||!Array.isArray(row.positions)||
          row.positions.some(position=>!position||typeof position.base!=='string'||!position.base||typeof position.symbol!=='string'||!position.symbol||
            !['long','short'].includes(position.side)||!Number.isFinite(position.quantity)||position.quantity<0||
            !Number.isFinite(position.markPrice)||position.markPrice<=0))continue;
        accounts.set(row.exchange,{requestedAt:row.requestedAt!,account:{freeUsd:row.freeUsd!,equityUsd:row.equityUsd!,positions:row.positions}});
      }
      for(const operation of operations){
        const position=positions.get(operation.positionId);if(!position)continue;
        const at=operationAccountConfirmationAt(operation,position,accounts,now,maxAgeMs);
        if(at!==undefined)this.store.operations.confirm(operation.id,at);
      }
    });
  }
  get liveUnlocked(){return this.config.mode==='live'&&(this.sessionLivePermission&&this.liveVenues().length>=1||!this.environmentPermissionRevoked&&this.livePermissionGranted&&this.liveEnvironment.permissionGranted&&this.liveVenues().length>=2);}
  private liveVenues(){return liveEligibleExchanges(this.liveEnvironment,this.config.exchanges).filter(x=>!this.sessionExchanges||this.sessionExchanges.has(x.exchange));}
  private hasLiveAccess(exchange:ExchangeId){return this.liveUnlocked&&this.liveVenues().some(x=>x.exchange===exchange);}
  private assertLiveAccess(exchange?:ExchangeId){
    if(this.config.mode!=='live')return;
    if(!this.liveUnlocked)throw new Error('实盘只读锁定：手动开仓可直接点击实盘开仓；自动开仓需单独启动自动策略');
    if(exchange&&!this.hasLiveAccess(exchange))throw new Error(`${exchange} 尚未配置受支持的实盘账户，交易接口已锁定`);
  }
  liveReadiness():LiveReadiness{
    const exchanges=this.liveEnvironment.exchanges.filter(x=>this.config.exchanges.includes(x.exchange)).map(x=>({...x,executionAuthorized:this.hasLiveAccess(x.exchange)})),reasons:string[]=[];
    if(this.config.mode!=='live')reasons.push('当前不是实盘模式');
    if(!this.sessionLivePermission&&(this.environmentPermissionRevoked||!this.livePermissionGranted||!this.liveEnvironment.permissionGranted))reasons.push('手动开仓点击后会核对并授权所选两腿；自动策略尚未单独启动');
    if(this.liveVenues().length<2)reasons.push('至少需要两家受支持交易所配置完整凭据');
    if(this.liveVenues().length<2)for(const x of exchanges){if(!x.supported)reasons.push(`${x.exchange} 仅支持公开行情，暂不支持实盘交易`);else if(!x.credentialsConfigured)reasons.push(`${x.exchange} 尚未配置完整凭据`);}
    const verified=this.liveVenues().filter(x=>{
      const account=this.accounts.get(x.exchange);
      // No exact contract exists at account-level readiness; its native fee is checked on each concrete opportunity.
      return account&&account.freeUsd>=this.config.orderNotionalUsd/this.config.leverage;
    });
    if(this.liveUnlocked&&verified.length<2)reasons.push('至少两家账户的合约可用保证金够开一单，才能开新仓');
    if(this.store.data.killSwitch)reasons.push('已手动紧急停止');
    return {unlocked:this.liveUnlocked,ready:this.liveUnlocked&&verified.length>=2&&!this.store.data.killSwitch,exchanges,reasons,excludedCoins:this.coinExclusions()};
  }
  /** Margin one leg needs: initial margin plus the opening and closing taker fees. */
  private requiredMarginUsd(exchange:ExchangeId,legNotionalUsd:number,base?:string,submitting=false){
    const fee=this.config.mode==='live'?base?(submitting?nativeTakerFeeRate(this.snapshot(exchange,base)):estimatedTakerFeeRate(this.snapshot(exchange,base))):undefined:this.config.takerFees[exchange];
    // Read-only fee discovery checks available principal first. Actual submission needs the exact exchange fee.
    if(fee===undefined)return submitting?Infinity:legNotionalUsd/this.config.leverage;
    return legEntryMarginUsd(legNotionalUsd,this.config.leverage,fee);
  }
  /** Coins that cannot take a new entry: an open strategy position, an unknown order, or a coin the account already holds. */
  private previewAccounts(now=Date.now()):Map<ExchangeId,AccountState>{
    const accounts=new Map<ExchangeId,AccountState>();
    if(this.config.mode!=='live')return accounts;
    for(const exchange of this.config.exchanges){
      const row=this.observedPortfolio?.exchanges.find(item=>item.exchange===exchange);
      if(row){
        if(row.credentialsConfigured&&row.status==='ready'&&Number.isFinite(row.requestedAt)&&row.requestedAt!<=now&&
          now-row.requestedAt!<=this.observedPortfolio!.maxAgeMs&&Number.isFinite(row.freeUsd)&&Number.isFinite(row.equityUsd))
          accounts.set(exchange,{freeUsd:row.freeUsd!,equityUsd:row.equityUsd!,positions:row.positions});
        continue;
      }
      const actual=this.accounts.get(exchange),health=this.health.find(item=>item.exchange===exchange);
      if(actual&&health?.accountStatus==='ready'&&Number.isFinite(health.accountUpdatedAt)&&health.accountUpdatedAt!<=now&&
        now-health.accountUpdatedAt!<=this.config.maxSnapshotAgeMs)accounts.set(exchange,actual);
    }
    return accounts;
  }
  private coinExclusions(ignorePositionId?:string){
    const accounts=new Map(this.accounts);
    for(const [exchange,account] of this.previewAccounts())accounts.set(exchange,account);
    return collectCoinExclusions(this.store.data.positions,this.store.data.orders,accounts,ignorePositionId);
  }
  private unidentifiedOrder(){return this.store.data.orders.some(o=>isCurrentUnconfirmedOrder(o,this.store.data.positions)&&!unresolvedCoin(o,this.store.data.positions));}
  private async inspectStart():Promise<{report:LiveStartReadiness;accounts:Map<ExchangeId,AccountState>}>{
    const accounts=new Map<ExchangeId,AccountState>(),blockedReasons:string[]=[];
    if(this.stopping)blockedReasons.push('服务正在停止');
    if(this.unidentifiedOrder())blockedReasons.push('未确认订单缺少币种，无法划定影响范围，须先核对');
    const environment=inspectLiveEnvironment(this.options.liveEnvironment??process.env);
    const recoveryExchanges=this.liveUnlocked?[]:[...new Set([...this.activePositions().flatMap(p=>[p.long,p.short].filter(l=>l.quantity>0).map(l=>l.exchange)),...this.store.data.orders.filter(o=>isCurrentUnconfirmedOrder(o,this.store.data.positions)).map(o=>o.exchange)])];
    const report=await inspectLiveStart(this.config,environment,{executionUnlocked:this.liveUnlocked,blockedReasons,excludedCoins:collectCoinExclusions(this.store.data.positions,this.store.data.orders,new Map()),recoveryExchanges,recoveryBlockedReasons:this.stopping?['服务正在停止']:[],
      adapter:exchange=>({fetchAccount:async()=>{const a=this.adapter(exchange);const account=await this.boundedPrivateRead(a,'account',context=>a.fetchAccount(context));accounts.set(exchange,account);return account;}})});
    return {report,accounts};
  }
  private assertCredentialsStable(){if(this.credentialUpdatePending)throw new Error('账户凭据正在更新，请等待保存完成后重新检查或启动');}
  private revokeExecutionPermission(){this.pendingManualPermission=undefined;this.environmentPermissionRevoked=true;this.sessionLivePermission=false;this.sessionExchanges=undefined;this.autoEnabled=false;}
  async tradingPreflight():Promise<LiveStartReadiness>{
    this.assertCredentialsStable();const generation=this.startGeneration;
    return this.exclusive(async()=>{
      this.assertCredentialsStable();
      if(generation!==this.startGeneration||this.stopping)throw new Error('启动检查已取消，请重新检查');
      const {report}=await this.inspectStart();
      if(generation!==this.startGeneration||this.stopping)throw new Error('启动检查已取消，请重新检查');
      return report;
    });
  }
  /** Explicitly renew account scope after private GET validation. Never starts entries or resumes paused managers. */
  async authorizeLiveAccounts(acknowledgement:string):Promise<LiveAuthorizationReport>{
    if(acknowledgement!=='RECHECK_LIVE_AUTHORIZATION')throw new Error('请使用本机重新核对实盘授权操作');
    this.assertCredentialsStable();const generation=this.startGeneration,config=this.config;
    return this.exclusive(async()=>{
      const ensure=()=>{this.assertCredentialsStable();if(this.stopping||generation!==this.startGeneration||config!==this.config)throw new Error('账户授权核对已取消，请重新检查');};
      ensure();
      if(config.mode!=='live'||config.dataSource!=='public')throw new Error('账户授权核对仅适用于实盘公开行情模式');
      const checkedAt=Date.now(),{report,accounts}=await this.inspectStart();ensure();
      const environment=inspectLiveEnvironment(this.options.liveEnvironment??process.env);
      const valid=report.accounts.filter(row=>row.status==='ready'||row.status==='insufficient').map(row=>row.exchange);
      // Reading less than the margin required for a new entry does not revoke reduction permission.
      // Failed reads do not grant a new venue, and must not revoke an existing manager's scope.
      const previous=this.liveUnlocked?this.liveVenues().map(row=>row.exchange):[];
      const scope=new Set([...previous,...valid].filter(exchange=>environment.exchanges.some(row=>
        row.exchange===exchange&&row.supported&&row.credentialsConfigured)&&config.exchanges.includes(exchange)));
      this.store.log(valid.length?'info':'warn',`用户重新核对交易所账户授权：${valid.length?valid.join(' / '):'本次没有账户通过读取'}；未启动自动策略，未提交订单`);
      ensure();
      if(scope.size){this.liveEnvironment=environment;this.sessionExchanges=scope;this.sessionLivePermission=true;}
      for(const row of report.accounts){
        if(valid.includes(row.exchange)){const account=accounts.get(row.exchange);if(account)this.cacheAccount(row.exchange,account);}
        else if(row.status==='error')this.accountReadFailed(row.exchange);
      }
      return {checkedAt,autoEnabled:this.autoEnabled,authorizedExchanges:EXCHANGES.filter(exchange=>this.hasLiveAccess(exchange)),
        accounts:EXCHANGES.map(exchange=>{
          const venue=environment.exchanges.find(row=>row.exchange===exchange)!,row=report.accounts.find(item=>item.exchange===exchange);
          return {exchange,credentialsConfigured:venue.credentialsConfigured,executionAuthorized:this.hasLiveAccess(exchange),
            status:row?.status??(venue.credentialsConfigured?'disabled':'not_configured'),
            ...(row?.freeUsd!==undefined?{freeUsd:row.freeUsd}:{}),
            message:row?.message??(venue.credentialsConfigured?'未启用该交易所；本次没有授予执行许可':'尚未配置完整凭据；本次没有读取或授予执行许可')};
        })};
    });
  }
  async recoverLive(acknowledgement:string):Promise<LiveStartReadiness>{
    if(acknowledgement!=='RESTORE_LIVE_MANAGEMENT')throw new Error('请在本机确认恢复持仓管理');
    this.assertCredentialsStable();
    const generation=++this.startGeneration;
    return this.exclusive(async()=>{
      this.assertCredentialsStable();
      if(generation!==this.startGeneration||this.stopping)throw new Error('恢复已取消');
      this.autoEnabled=false;
      const {report,accounts}=await this.inspectStart();
      if(generation!==this.startGeneration||this.stopping)throw new Error('恢复已取消');
      if(!report.canRecover)throw new Error(report.recoveryBlockers?.join('；')||'当前没有可恢复的持仓管理会话');
      this.liveEnvironment=inspectLiveEnvironment(this.options.liveEnvironment??process.env);
      this.sessionExchanges=new Set(report.managementExchanges);
      this.sessionLivePermission=true;
      if(!this.liveUnlocked){this.sessionLivePermission=false;this.sessionExchanges=undefined;throw new Error('账户配置已变化，请重新检查');}
      this.accounts.clear();
      for(const exchange of this.sessionExchanges){const account=accounts.get(exchange);if(account)this.cacheAccount(exchange,account);}
      for(const p of this.activePositions()){p.status='attention';p.riskReasons=['已恢复管理，等待用户对账或平仓'];}
      try{this.store.log('info','用户已恢复当前会话持仓管理，自动开仓保持关闭');}
      catch(error){this.sessionLivePermission=false;this.sessionExchanges=undefined;this.accounts.clear();throw error;}
      return {...report,executionUnlocked:true};
    });
  }
  /** Explicit normal-session reconciliation. No source permission, unknown order or other attention manager is adopted. */
  async reconcileSelectedPositions(request:SelectedReconcileRequest):Promise<{positionIds:string[];checkedAt:number;autoEnabled:false}>{
    const now=Date.now();
    if(!request||!['RECONCILE_SELECTED_POSITIONS','RECONCILE_CURRENT_STRATEGY_POSITIONS'].includes(request.acknowledgement)||!Number.isFinite(request.expiresAt)||
      request.expiresAt<=now||request.expiresAt>now+60_000||!Array.isArray(request.positionIds)||!request.positionIds.length||
      request.positionIds.length>50||new Set(request.positionIds).size!==request.positionIds.length||
      request.positionIds.some(id=>typeof id!=='string'||!id||id.length>150)||!Array.isArray(request.expected)||
      request.expected.length!==request.positionIds.length||new Set(request.expected.map(value=>value?.id)).size!==request.expected.length||
      request.expected.some(value=>!value||!request.positionIds.includes(value.id)))
      throw new Error('缺少有效且一一对应的限定持仓对账确认，请刷新后重新选择');
    this.assertCredentialsStable();
    // Copy before queuing so an in-process caller cannot widen a later authorization.
    const input=structuredClone(request),generation=this.startGeneration,config=this.config,epoch=this.financialEpoch;
    const restoreCurrent=input.acknowledgement==='RECONCILE_CURRENT_STRATEGY_POSITIONS';
    const expected=new Map(input.expected.map(value=>[value.id,value]));
    return this.exclusive(async()=>{
      const selected=input.positionIds.map(id=>this.store.data.positions.find(position=>position.id===id));
      const provenNoSendClose=(position:Position)=>{
        if(!restoreCurrent||position.manualCloseOnly||position.closeRequestedAt===undefined||position.closeProfitRequired!==true||
          position.closePricing!=='best-opposite'||position.closeAttemptedAt===undefined)return false;
        const orders=this.store.data.orders.filter(order=>order.positionId===position.id&&order.createdAt>=position.closeRequestedAt!);
        return orders.length>0&&orders.every(order=>order.request.reduceOnly&&order.request.postOnly===true&&
          order.makerReduction?.activity==='terminal'&&order.makerReduction.bookedExecution===true&&
          order.result?.rejectionCode==='MAKER_REDUCTION_PERMISSION_CHANGED'&&isProvenNoSubmitReceipt(order.request,order.result)&&
          order.result.averagePrice===0&&order.executionEvidence?.bookedFeeUsd===0&&
          [position.long,position.short].some(leg=>leg.exchange===order.exchange&&leg.symbol===order.request.symbol&&
            order.request.base===position.base&&order.request.side===(leg.side==='long'?'sell':'buy')));
      };
      const restoreKnownIocClose=(position:Position)=>{
        if(!restoreCurrent||config.profitExitExecutionMode!=='ioc'||position.manualCloseOnly||
          position.closeRequestedAt===undefined||position.closeProfitRequired!==true||position.closePricing!=='best-opposite'||
          position.executionEvidence?.method!=='ioc')return false;
        const reductions=this.store.data.orders.filter(order=>order.positionId===position.id&&order.createdAt>=position.closeRequestedAt!);
        if(!reductions.length||reductions.some(order=>order.request.postOnly===true||order.makerReduction||order.executionEvidence?.method==='maker'))return false;
        assertCurrentIocCloseRestorationEligible(position,this.store.data.positions,this.store.data.orders,this.store.data.manualCloseOperations??[]);
        if(this.execution.hasMakerClose(position)||this.execution.hasIocProfitClose(position))
          throw new Error('所选原 IOC 退出仍有活动执行任务，未恢复管理');
        return true;
      };
      const ensure=()=>{
        this.assertCredentialsStable();
        if(this.stopping||this.startGeneration!==generation||this.config!==config||this.financialEpoch!==epoch||
          Date.now()>=input.expiresAt)throw new Error('限定持仓对账确认已过期或运行状态已变化，请重新选择');
        if(config.mode!=='live'||config.dataSource!=='public'||!this.sessionLivePermission||!this.liveUnlocked)
          throw new Error('请先重新核对当前会话实盘授权，再恢复所选持仓');
        if(this.autoEnabled||this.store.data.killSwitch)throw new Error('恢复所选持仓前须暂停自动开仓并保留正常风险开关');
        if(restoreCurrent&&(config.entryPolicy!=='aligned'||config.holdMode!=='adaptive'))throw new Error('当前全局策略未启用资金费与价差自主退出，未恢复管理');
        if(this.unidentifiedOrder())throw new Error('未确认订单缺少币种，无法确认限定恢复范围');
        for(const position of selected){
          const wanted=position&&expected.get(position.id);
          const restoreManual=!!position&&restoreCurrent&&position.manualCloseOnly===true;
          const restoreNoSend=!!position&&provenNoSendClose(position);
          const restoreIoc=!!position&&restoreKnownIocClose(position);
          if(restoreManual)assertCurrentManagementRestorationEligible(position!,this.store.data.positions,this.store.data.orders,
            this.store.data.manualCloseOperations??[]);
          if(!position||!wanted||this.store.data.positions.find(value=>value.id===position.id)!==position||
            position.mode!=='live'||!isPositionActive(position)||!['attention','open'].includes(position.status)||
            position.manualCloseOnly&&!restoreManual||position.accountClosure||position.manualCloseAccountRecord||
            !restoreManual&&!restoreNoSend&&!restoreIoc&&(position.closeRequestedAt!==undefined||position.closeAttemptedAt!==undefined)||
            position.closedAt!==undefined||position.base!==wanted.base||position.openedAt!==wanted.openedAt||
            position.long.side!=='long'||position.short.side!=='short'||position.long.exchange===position.short.exchange||
            position.long.exchange!==wanted.longExchange||position.short.exchange!==wanted.shortExchange||
            position.long.symbol!==wanted.longSymbol||position.short.symbol!==wanted.shortSymbol||
            !(Number.isFinite(wanted.openedAt)&&wanted.openedAt>0)||
            ![wanted.longQuantity,wanted.shortQuantity].every(quantity=>Number.isFinite(quantity)&&quantity>0)||
            position.long.quantity!==wanted.longQuantity||position.short.quantity!==wanted.shortQuantity)
            throw new Error('所选持仓的身份、数量或原处理状态已变化，未恢复管理');
          for(const leg of [position.long,position.short]){
            this.assertLiveAccess(leg.exchange);
            const quote=this.snapshot(leg.exchange,position.base);
            if(!quote||quote.symbol!==leg.symbol||!isQuantityOnStep(leg.quantity,quote.quantityStep))
              throw new Error('所选持仓缺少有效合约数量步长或数量不合法，未恢复管理');
          }
          const step=Math.min(...[position.long,position.short].map(leg=>this.snapshot(leg.exchange,position.base)!.quantityStep));
          const tolerance=Math.min(step*1e-7,Number.EPSILON*Math.max(position.long.quantity,position.short.quantity)*8);
          if(Math.abs(position.long.quantity-position.short.quantity)>tolerance||this.pendingCoin(position.base)||
            this.store.data.orders.some(order=>order.positionId===position.id&&isUnconfirmedJournalOrder(order))||
            this.activePositions().some(other=>other.id!==position.id&&coinBase(other.base)===coinBase(position.base)))
            throw new Error('所选币种存在未确认订单、重复持仓或数量尾差，未恢复管理');
        }
      };
      ensure();
      const positions=selected as Position[],venues=[...new Set(positions.flatMap(position=>[position.long.exchange,position.short.exchange]))];
      const clients=new Map(venues.map(exchange=>[exchange,this.adapter(exchange)]));
      const confirmedZeroOrders=new Map<string,NonNullable<NonNullable<Position['automaticCloseHistory']>[number]['confirmedZeroOrders']>>();
      const confirmedIocOrders=new Map<string,CurrentIocNativeOrderProof[]>();
      const scopeKey=()=>JSON.stringify({venues:this.liveVenues().map(venue=>venue.exchange).sort(),
        positions:positions.map(position=>({id:position.id,base:position.base,openedAt:position.openedAt,status:position.status,
          legs:[position.long,position.short].map(leg=>({exchange:leg.exchange,symbol:leg.symbol,side:leg.side,quantity:leg.quantity,entryPrice:leg.entryPrice,
            feesUsd:leg.feesUsd,fundingUsd:leg.fundingUsd,realizedPnlUsd:leg.realizedPnlUsd})),
          entryPolicy:position.entryPolicy,holdMode:position.holdMode,profitExitPolicy:position.profitExitPolicy,
          profitExitNotionalUsd:position.profitExitNotionalUsd,fundingUsd:position.fundingUsd,feesUsd:position.feesUsd,
          realizedSpreadPnlUsd:position.realizedSpreadPnlUsd,transferCostUsd:position.transferCostUsd,
          fundingEvents:position.fundingEvents,feeOnly:position.feeOnly,automaticEntry:position.automaticEntry,
          executionEvidence:position.executionEvidence,currentManagementRestorationHistory:position.currentManagementRestorationHistory,automaticCloseHistory:position.automaticCloseHistory,
          manualCloseOnly:position.manualCloseOnly,manualCloseOperationId:position.manualCloseOperationId,
          closeRequestedAt:position.closeRequestedAt,closeAttemptedAt:position.closeAttemptedAt,closeReason:position.closeReason,
          closeProfitRequired:position.closeProfitRequired,closePricing:position.closePricing,closePauseReason:position.closePauseReason})),
        orders:this.store.data.orders.filter(order=>positions.some(position=>position.id===order.positionId)),
        operations:(this.store.data.manualCloseOperations??[]).filter(operation=>positions.some(position=>
          position.id===operation.positionId||position.id===operation.sourcePositionId))});
      const frozenScope=scopeKey();
      const checkScope=()=>{ensure();if(scopeKey()!==frozenScope||venues.some(exchange=>this.adapter(exchange)!==clients.get(exchange)))
        throw new Error('所选持仓或当前会话账户范围已变化，未恢复管理');};
      for(const position of positions.filter(position=>position.manualCloseOnly||provenNoSendClose(position)||restoreKnownIocClose(position))){
        const own=this.store.data.orders.filter(order=>order.positionId===position.id);
        for(const journal of own){
          checkScope();
          if(isProvenNoSubmitReceipt(journal.request,journal.result))continue;
          // Reuse only an already committed Bitget opening cancellation whose
          // native retention has elapsed. Its original zero proof is unchanged;
          // positive cash, current accounts and complete order absence remain mandatory.
          if(restoreKnownIocClose(position)&&isDurableConfirmedIocOpeningZero(journal,position,this.store.data.orders))continue;
          // Completed native zero cash is durable evidence. Venue retention expiry
          // cannot turn that receipt into an unknown or grant new execution budget.
          // Explicit selected authorization, positive native cash and fresh accounts
          // and complete open-order absence are still required before resuming.
          if(restoreCurrent&&isDurableConfirmedMakerZero(journal,position,this.store.data.orders)){
            const proofs=confirmedZeroOrders.get(position.id)??[];
            proofs.push({exchange:journal.exchange,symbol:journal.request.symbol,clientOrderId:journal.request.clientOrderId,
              nativeOrderId:journal.result!.id,observedAt:journal.makerReduction!.lastObservedAt!,committedAt:journal.makerReduction!.observationCommittedAt!});
            confirmedZeroOrders.set(position.id,proofs);continue;
          }
          const adapter=clients.get(journal.exchange)!;
          if(journal.makerReduction?!adapter.inspectMakerReduction:!adapter.inspectOrder)
            throw new Error('原退出记录缺少完整原生查单接口，未恢复自动管理');
          const readAt=Date.now();let observed:OrderResult,nativeReadAt:number|undefined;
          if(journal.makerReduction){
            const observation=await this.boundedPrivateRead(adapter,`management-maker:${journal.request.clientOrderId}`,
              ()=>adapter.inspectMakerReduction!(journal.request,journal.result!.id));checkScope();
            if(observation.activity!=='terminal'||!observation.executionVerified)
              throw new Error('原 Maker 减仓未取得完整终态现金，未恢复自动管理');
            observed=observation.result;nativeReadAt=observation.observedAt;
          }else{
            observed=await this.boundedPrivateRead(adapter,`management-restore:${journal.request.clientOrderId}`,
              ()=>adapter.inspectOrder!(journal.request,journal.result!.id));checkScope();nativeReadAt=observed.orderReadAt;
          }
          const equal=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(1,Math.abs(a),Math.abs(b))*Number.EPSILON*16;
          if(observed.averagePriceVerified!==true&&observed.filledQuantity>0&&
            (journal.request.reduceOnly?adapter.verifyOrderExecution:adapter.verifyOpeningExecution)){
            observed=await this.boundedPrivateRead(adapter,`management-cash:${journal.request.clientOrderId}`,
              ()=>journal.request.reduceOnly?adapter.verifyOrderExecution!(journal.request,journal.result!.id):
                adapter.verifyOpeningExecution!(journal.request,journal.result!.id));checkScope();nativeReadAt=observed.orderReadAt;
          }
          const saved=journal.result!;
          if(!isTerminalOrderReceipt(journal.request,observed)||observed.id!==saved.id||observed.status!==saved.status||
            !equal(observed.filledQuantity,saved.filledQuantity)||!equal(observed.averagePrice,saved.averagePrice)||
            !equal(observed.feeUsd,saved.feeUsd)||observed.filledQuantity>0&&observed.averagePriceVerified!==true||
            !Number.isFinite(nativeReadAt)||nativeReadAt!<readAt||nativeReadAt!>Date.now())
            throw new Error('原订单的原生终态或真实现金与账本不一致，未恢复自动管理');
          if(restoreKnownIocClose(position)){
            const proofs=confirmedIocOrders.get(position.id)??[];
            proofs.push({exchange:journal.exchange,clientOrderId:journal.request.clientOrderId,nativeOrderId:observed.id,observedAt:nativeReadAt!});
            confirmedIocOrders.set(position.id,proofs);
          }
        }
      }
      const readAccounts=async()=>{
        const startedAt=Date.now(),accounts=new Map(await Promise.all(venues.map(async exchange=>
          [exchange,await this.readScopedTradingAccount(clients.get(exchange)!,checkScope)] as const)));checkScope();
        const completedAt=Date.now(),latestActivity=Math.max(...positions.map(position=>position.openedAt),
          ...this.store.data.orders.filter(order=>positions.some(position=>position.id===order.positionId))
            .map(order=>Math.max(order.createdAt,order.result?.timestamp??0)));
        for(const account of accounts.values()){
          const at=this.accountReadAt.get(account);
          if(!Number.isFinite(at)||at!<startedAt||at!<=latestActivity||at!>completedAt||completedAt-at!>config.maxSnapshotAgeMs||!Number.isFinite(account.equityUsd))
            throw new Error('所选交易所账户结果不完整或不属于本轮新鲜读取，未恢复管理');
        }
        return accounts;
      };
      const checkAccounts=(accounts:Map<ExchangeId,AccountState>)=>positions.flatMap(position=>[position.long,position.short].map(leg=>{
        const rows=accounts.get(leg.exchange)!.positions.filter(row=>row.quantity>0&&(row.symbol===leg.symbol||coinBase(row.base)===coinBase(position.base)));
        const row=rows[0],tolerance=Math.min(this.snapshot(leg.exchange,position.base)!.quantityStep*1e-7,
          Number.EPSILON*Math.max(leg.quantity,row?.quantity??0)*8);
        const latestOpeningAt=Math.max(position.openedAt,...this.store.data.orders.filter(order=>order.positionId===position.id&&!order.request.reduceOnly)
          .map(order=>Math.max(order.createdAt,order.result?.timestamp??0)));
        if(rows.length!==1||row.symbol!==leg.symbol||row.side!==leg.side||coinBase(row.base)!==coinBase(position.base)||
          Math.abs(row.quantity-leg.quantity)>tolerance||
          row.marginMode!==undefined&&!['crossed','isolated'].includes(row.marginMode)||
          row.positionId!==undefined&&(typeof row.positionId!=='string'||!row.positionId.trim())||
          row.entryPrice!==undefined&&(!Number.isFinite(row.entryPrice)||row.entryPrice!<=0)||
          row.splitPositionCount!==undefined&&(!Number.isSafeInteger(row.splitPositionCount)||row.splitPositionCount!<1)||
          row.positionOpenedAt!==undefined&&(!Number.isFinite(row.positionOpenedAt)||row.positionOpenedAt!<position.openedAt-5000||row.positionOpenedAt!>latestOpeningAt+5000))
          throw new Error('实际账户持仓的方向、数量或开仓周期与所选账本不一致，未恢复管理');
        if(position.manualCloseOnly){
          const operation=assertCurrentManagementRestorationEligible(position,this.store.data.positions,this.store.data.orders,this.store.data.manualCloseOperations??[]);
          const selection=JSON.parse(operation.selection),selected=selection.legs.find((value:any)=>value.exchange===leg.exchange&&value.symbol===leg.symbol&&value.side===leg.side);
          const key=JSON.stringify([leg.exchange,row.symbol,row.side,row.marginMode??null,row.positionId??null]);
          if(key!==selected.accountPositionKey||selected.positionOpenedAt!==undefined&&selected.positionOpenedAt!==row.positionOpenedAt)
            throw new Error('实际账户身份或开仓周期与原手动选择不一致，未恢复管理');
        }
        return JSON.stringify({exchange:leg.exchange,base:row.base,symbol:row.symbol,side:row.side,quantity:row.quantity,
          marginMode:row.marginMode??null,positionId:row.positionId??null,positionOpenedAt:row.positionOpenedAt??null,entryPrice:row.entryPrice??null,
          splitPositionCount:row.splitPositionCount??null,accountMode:accounts.get(leg.exchange)!.positionMode??null});
      }));
      const initialIdentity=checkAccounts(await readAccounts());
      await Promise.all(positions.flatMap(position=>[position.long,position.short]).map(async leg=>{
        const client=clients.get(leg.exchange)!;
        if(!client.fetchOpenOrders)throw new Error('所选合约缺少完整原生挂单读取，未恢复管理');
        const orders=await this.boundedPrivateRead(client,`selected-reconcile-orders:${leg.symbol}`,()=>client.fetchOpenOrders!(leg.symbol));checkScope();
        if(!Array.isArray(orders)||orders.length)throw new Error('所选合约仍有挂单或挂单数据不完整，未恢复管理');
      }));
      const accounts=await readAccounts();
      if(JSON.stringify(checkAccounts(accounts))!==JSON.stringify(initialIdentity))
        throw new Error('挂单核验前后实际持仓身份或数量发生变化，未恢复管理');
      checkScope();
      for(const [exchange,account] of accounts){
        const at=this.accountReadAt.get(account)!;
        if((this.health.find(health=>health.exchange===exchange)?.accountUpdatedAt??0)>at)
          throw new Error('已有更新的账户观测，请按最新账户重新核对所选持仓');
      }
      // Logging/persistence failure cannot silently leave an in-memory manager enabled.
      const iocCloseAudits=new Map(positions.filter(restoreKnownIocClose).map(position=>[position.id,
        buildCurrentIocCloseRestorationAudit(position,this.store.data.orders,confirmedIocOrders.get(position.id)??[])]));
      this.store.log('info',`用户限定核对 ${positions.length} 组持仓已通过；仅恢复所选管理，其他待核对记录保持暂停`);
      checkScope();
      for(const [exchange,account] of accounts)if(!this.cacheAccount(exchange,account))throw new Error('账户核对结果已过期，未恢复管理');
      const previous=positions.map(position=>({position,status:position.status,reasons:position.riskReasons,reconciled:this.reconciledPositions.has(position.id),
        manualCloseOnly:position.manualCloseOnly,history:position.currentManagementRestorationHistory,automaticHistory:position.automaticCloseHistory,profitExitNotionalUsd:position.profitExitNotionalUsd,
        intent:{closeRequestedAt:position.closeRequestedAt,closeAttemptedAt:position.closeAttemptedAt,closeReason:position.closeReason,
          closePricing:position.closePricing,closeProfitRequired:position.closeProfitRequired,closePauseReason:position.closePauseReason}}));
      try{for(const position of positions){
        const iocCloseAudit=iocCloseAudits.get(position.id);
        if(iocCloseAudit){
          position.automaticCloseHistory=[...(position.automaticCloseHistory??[]),{requestedAt:position.closeRequestedAt!,attemptedAt:position.closeAttemptedAt,
            suspendedAt:iocCloseAudit.restoredAt,reason:position.closeReason,
            suspensionReason:'原 IOC 条件退出全部终态现金、双轮新鲜账户与完整挂单核验通过；旧意图已审计暂挂，恢复原返佣后 10 bps 当前策略',
            pricing:position.closePricing,longQuantity:position.long.quantity,shortQuantity:position.short.quantity,iocRestoration:iocCloseAudit}];
          delete position.closeRequestedAt;delete position.closeAttemptedAt;delete position.closeReason;delete position.closePricing;
          delete position.closeProfitRequired;delete position.closePauseReason;
        }
        if(provenNoSendClose(position)){
          position.automaticCloseHistory=[...(position.automaticCloseHistory??[]),{requestedAt:position.closeRequestedAt!,attemptedAt:position.closeAttemptedAt,
            suspendedAt:Date.now(),reason:position.closeReason,suspensionReason:'原自动 Maker 已有提交前零现金见证；限定核验原现金、双账户与完整挂单后恢复当前管理',
            pricing:position.closePricing,longQuantity:position.long.quantity,shortQuantity:position.short.quantity,
            ...(confirmedZeroOrders.has(position.id)?{confirmedZeroOrders:confirmedZeroOrders.get(position.id)}:{})}];
          delete position.closeRequestedAt;delete position.closeAttemptedAt;delete position.closeReason;delete position.closePricing;
          delete position.closeProfitRequired;delete position.closePauseReason;
        }
        if(position.manualCloseOnly){
          const operation=assertCurrentManagementRestorationEligible(position,this.store.data.positions,this.store.data.orders,
            this.store.data.manualCloseOperations??[]);
          position.currentManagementRestorationHistory=[...(position.currentManagementRestorationHistory??[]),
            buildCurrentManagementRestorationAudit(position,operation,this.store.data.orders)];
          delete position.manualCloseOnly;delete position.closeRequestedAt;delete position.closeAttemptedAt;delete position.closeReason;
          delete position.closePricing;delete position.closeProfitRequired;delete position.closePauseReason;
          freezeProfitExitNotional(position,this.store.data.orders);
        }
        position.status='open';position.riskReasons=[];this.reconciledPositions.add(position.id);
      }
      this.store.save();}
      catch(error){for(const old of previous){old.position.status=old.status;old.position.riskReasons=old.reasons;
        old.position.manualCloseOnly=old.manualCloseOnly;old.position.currentManagementRestorationHistory=old.history;
        old.position.profitExitNotionalUsd=old.profitExitNotionalUsd;old.position.automaticCloseHistory=old.automaticHistory;
        Object.assign(old.position,old.intent);if(!old.reconciled)this.reconciledPositions.delete(old.position.id);}throw error;}
      return {positionIds:positions.map(position=>position.id),checkedAt:Date.now(),autoEnabled:false};
    });
  }
  /** Explicit exit-only adoption of fresh native exposure. Old IOC outcomes stay unknown. */
  async restoreSelectedNativeExitManagement(request:SelectedNativeExitRecoveryRequest):Promise<{positionId:string;auditId:string;longQuantity:number;shortQuantity:number;checkedAt:number}> {
    const now=Date.now(),wanted=request?.expected,ids=request?.unknownClientOrderIds;
    if(!request||request.acknowledgement!=='RESTORE_SELECTED_NATIVE_EXIT_MANAGEMENT'||!wanted||
      typeof request.operationId!=='string'||!/^[-\w]{8,80}$/.test(request.operationId)||
      !Number.isFinite(request.expiresAt)||request.expiresAt<=now||request.expiresAt>now+60_000||
      ![request.positionId,request.parentClientOrderId].every(id=>typeof id==='string'&&id.length>0&&id.length<=150)||
      request.confirmedTailParentClientOrderId!==undefined&&(typeof request.confirmedTailParentClientOrderId!=='string'||
        !request.confirmedTailParentClientOrderId||request.confirmedTailParentClientOrderId.length>150||request.confirmedTailParentClientOrderId===request.parentClientOrderId)||
      request.confirmedIocBatchId!==undefined&&(typeof request.confirmedIocBatchId!=='string'||!request.confirmedIocBatchId||
        request.confirmedIocBatchId.length>250||request.confirmedTailParentClientOrderId!==undefined)||
      !Array.isArray(ids)||!ids.length||ids.length>20||new Set(ids).size!==ids.length||
      ids.some(id=>typeof id!=='string'||!id||id.length>150||id===request.parentClientOrderId||id===request.confirmedTailParentClientOrderId)||
      ![wanted.openedAt,wanted.longQuantity,wanted.shortQuantity].every(value=>Number.isFinite(value)&&value>0))
      throw new Error('缺少有效的所选真实持仓退出恢复确认，请刷新后重新选择');
    this.assertCredentialsStable();
    const input=structuredClone(request),config=this.config,configProof=JSON.stringify(config),generation=this.startGeneration,epoch=this.financialEpoch;
    const p=this.store.data.positions.find(p=>p.id===input.positionId),parent=this.store.data.orders.find(o=>o.positionId===input.positionId&&o.request.clientOrderId===input.parentClientOrderId);
    if(!p||p.nativeExitRecoveryAudit?.some(audit=>audit.id===input.operationId)||this.execution.hasNativeExitAuthority(p))
      throw new Error('所选真实退出恢复已接收或原持仓已变化，未重复授权');
    const legs=[p.long,p.short],unknowns=input.unknownClientOrderIds.map(id=>this.store.data.orders.find(o=>o.positionId===p.id&&o.request.clientOrderId===id)),
      tailParent=input.confirmedTailParentClientOrderId===undefined?undefined:this.store.data.orders.find(o=>o.positionId===p.id&&o.request.clientOrderId===input.confirmedTailParentClientOrderId);
    const iocPlan:ConfirmedIocTailPlan|undefined=input.confirmedIocBatchId===undefined?undefined:planConfirmedIocTail(p,this.store.data.orders,input.confirmedIocBatchId),
      frozenIoc=iocPlan?.orders.map(confirmedIocOrderProof),iocReads:NonNullable<NativeExitRecoveryAudit['confirmedIocOrders']>=[];
    if([input.parentClientOrderId,...input.unknownClientOrderIds,...(input.confirmedTailParentClientOrderId?[input.confirmedTailParentClientOrderId]:[])]
      .some(id=>this.store.data.orders.filter(o=>o.request.clientOrderId===id).length!==1))
      throw new Error('所选原单客户 ID 不唯一，未恢复真实持仓退出');
    const clients=new Map(legs.map(leg=>[leg.exchange,this.adapters.find(a=>a.id===leg.exchange)!]));
    const fingerprint=(order:JournalOrder)=>JSON.stringify({positionId:order.positionId,exchange:order.exchange,createdAt:order.createdAt,request:order.request,
      result:order.result&&{id:order.result.id,clientOrderId:order.result.clientOrderId,status:order.result.status,filledQuantity:order.result.filledQuantity,
        averagePrice:order.result.averagePrice,averagePriceVerified:order.result.averagePriceVerified,feeUsd:order.result.feeUsd,timestamp:order.result.timestamp,
        rejectionCode:order.result.rejectionCode},bookedFeeUsd:order.executionEvidence?.bookedFeeUsd,
      method:order.executionEvidence?.method,role:order.executionEvidence?.role,nativeTakerFeeRate:order.executionEvidence?.nativeTakerFeeRate,
      parent:order.executionEvidence?.makerCloseParentClientId,makerLeg:order.makerReduction?.makerLeg,
      activity:order.makerReduction?.activity,booked:order.makerReduction?.bookedExecution});
    const identity=()=>JSON.stringify({id:p.id,base:p.base,mode:p.mode,openedAt:p.openedAt,entryPolicy:p.entryPolicy,holdMode:p.holdMode,
      profitExitNotionalUsd:p.profitExitNotionalUsd,profitExitPolicy:p.profitExitPolicy,legs:legs.map(leg=>({exchange:leg.exchange,symbol:leg.symbol,side:leg.side,entryPrice:leg.entryPrice}))});
    const frozenIdentity=identity(),frozenParent=parent&&fingerprint(parent),frozenTailParent=tailParent&&fingerprint(tailParent),frozenUnknowns=unknowns.map(o=>o&&fingerprint(o));
    const financial=()=>JSON.stringify({identity:identity(),quantities:legs.map(l=>l.quantity),fees:legs.map(l=>l.feesUsd),
      legRealized:legs.map(l=>l.realizedPnlUsd),legFunding:legs.map(l=>l.fundingUsd),funding:p.fundingUsd,events:p.fundingEvents,
      feesUsd:p.feesUsd,realized:p.realizedSpreadPnlUsd,transfer:p.transferCostUsd,closeRequestedAt:p.closeRequestedAt,
      closeAttemptedAt:p.closeAttemptedAt,closeProfitRequired:p.closeProfitRequired,closePricing:p.closePricing,
      orders:this.store.data.orders.filter(o=>o.positionId===p.id||iocPlan&&legs.some(l=>o.exchange===l.exchange&&o.request.symbol===l.symbol))
        .map(o=>iocPlan?confirmedIocOrderProof(o):fingerprint(o))});
    const frozenFinancial=financial();
    const active=()=>{
      this.assertCredentialsStable();
      if(this.stopping||this.maintenanceTradingPending||this.config!==config||JSON.stringify(config)!==configProof||
        config.mode!=='live'||p.mode!=='live'||config.dataSource!=='public'||!this.sessionLivePermission||!this.liveUnlocked||this.store.data.killSwitch||
        this.store.data.positions.find(position=>position.id===p.id)!==p||p.long!==legs[0]||p.short!==legs[1]||
        !isPositionActive(p)||p.manualCloseOnly||p.manualCloseAccountRecord||p.accountClosure||identity()!==frozenIdentity||
        currentExitStrategyPosition(p,config).entryPolicy!=='aligned'||currentExitStrategyPosition(p,config).holdMode!=='adaptive'||
        this.activePositions().some(other=>other!==p&&coinBase(other.base)===coinBase(p.base)))
        throw new Error('所选真实持仓退出范围、会话或身份已变化，未新增减仓');
      for(const leg of legs){this.assertLiveAccess(leg.exchange);if(!clients.get(leg.exchange)||this.adapter(leg.exchange)!==clients.get(leg.exchange))throw new Error('所选真实持仓账户连接已变化');}
      if(!parent||!this.store.data.orders.includes(parent)||fingerprint(parent)!==frozenParent||
        input.confirmedTailParentClientOrderId!==undefined&&(!tailParent||!this.store.data.orders.includes(tailParent)||fingerprint(tailParent)!==frozenTailParent)||
        unknowns.some((o,index)=>!o||!this.store.data.orders.includes(o)||fingerprint(o)!==frozenUnknowns[index]))
        throw new Error('原已确认 Maker 或选中未知订单记录已变化，退出恢复授权失效');
      if(iocPlan&&(config.profitExitExecutionMode!=='ioc'||iocPlan.orders.some((order,index)=>
        !this.store.data.orders.includes(order)||confirmedIocOrderProof(order)!==frozenIoc![index])))
        throw new Error('所选 IOC 原批次身份、现金或执行方式已变化，未恢复尾差授权');
    };
    const ensure=()=>{
      active();
      if(this.autoEnabled||this.startGeneration!==generation||Date.now()>=input.expiresAt||this.financialEpoch!==epoch||financial()!==frozenFinancial||
        p.base!==wanted.base||p.openedAt!==wanted.openedAt||p.long.exchange!==wanted.longExchange||p.long.symbol!==wanted.longSymbol||p.long.quantity!==wanted.longQuantity||
        p.short.exchange!==wanted.shortExchange||p.short.symbol!==wanted.shortSymbol||p.short.quantity!==wanted.shortQuantity||this.execution.hasMakerClose(p)||
        this.execution.hasIocProfitClose(p)||this.execution.hasPendingIocProfitTail(p)||
        this.unidentifiedOrder()||this.store.data.orders.some(o=>isCurrentUnconfirmedOrder(o,this.store.data.positions)&&!unknowns.includes(o)&&
          (o.positionId===p.id||unresolvedCoin(o,this.store.data.positions)===coinBase(p.base)||legs.some(l=>o.exchange===l.exchange&&o.request.symbol===l.symbol))))
        throw new Error('须暂停自动开仓并保持所选现金、数量及确认有效，才可恢复真实持仓退出');
    };
    ensure();
    if(!parent?.makerReduction||parent.makerReduction.activity!=='terminal'||parent.makerReduction.bookedExecution!==true||
      parent.executionEvidence?.method!=='maker'||parent.executionEvidence.role!=='exit'||!parent.request.reduceOnly||parent.request.postOnly!==true||
      !parent.result?.id||parent.result.id===parent.request.clientOrderId||parent.result.filledQuantity<=0||parent.result.averagePriceVerified!==true||
      !Number.isFinite(parent.result.feeUsd)||parent.executionEvidence.bookedFeeUsd!==parent.result.feeUsd||!isTerminalOrderReceipt(parent.request,parent.result)||
      p.closeRequestedAt!==undefined&&(p.closeProfitRequired!==true||p.closePricing!=='best-opposite')||!Number.isFinite(p.profitExitNotionalUsd)||p.profitExitNotionalUsd!<=0)
      throw new Error('原 Maker 缺少完整真实成交现金、固定本金或退出意图，未恢复真实持仓退出');
    const maker=p[parent.makerReduction.makerLeg],peer=p[parent.makerReduction.makerLeg==='long'?'short':'long'];
    if(parent.exchange!==maker.exchange||parent.request.symbol!==maker.symbol||parent.request.base!==p.base||parent.request.side!==(maker.side==='long'?'sell':'buy')||
      unknowns.some(o=>!o||o.makerReduction||o.result?.status!=='unknown'||o.result.id!==''||o.result.clientOrderId!==o.request.clientOrderId||
        o.result.filledQuantity!==0||o.result.averagePrice!==0||o.result.feeUsd!==0||o.createdAt<parent.createdAt||!o.request.reduceOnly||o.request.postOnly===true||
        o.request.closePosition!==undefined||o.exchange!==peer.exchange||o.request.base!==p.base||o.request.symbol!==peer.symbol||o.request.side!==(peer.side==='long'?'sell':'buy')||
        o.executionEvidence?.method!=='ioc'||o.executionEvidence.role!=='exit-tail'||o.executionEvidence.makerCloseParentClientId!==parent.request.clientOrderId))
      throw new Error('所选未知原订单必须是该 Maker 的原普通 IOC 对侧减仓，不能认领其他订单');
    const peers=this.store.data.orders.filter(o=>o.positionId===p.id&&o.executionEvidence?.makerCloseParentClientId===parent.request.clientOrderId&&!unknowns.includes(o));
    if(peers.some(o=>o.exchange!==peer.exchange||o.request.base!==p.base||o.request.symbol!==peer.symbol||o.request.side!==(peer.side==='long'?'sell':'buy')||
      !o.request.reduceOnly||o.request.postOnly===true||o.executionEvidence?.method!=='ioc'||o.executionEvidence.role!=='exit-tail'||
      !o.result||!isTerminalOrderReceipt(o.request,o.result)||o.result.averagePriceVerified===false||!Number.isFinite(o.result.feeUsd)||o.executionEvidence?.bookedFeeUsd!==o.result.feeUsd))
      throw new Error('原 Maker 其他对侧现金未确认，不能恢复当前真实尾差');
    const budget=quantitySubtract(parent.result.filledQuantity,peers.reduce((sum,o)=>quantityAdd(sum,o.result!.filledQuantity),0));
    let selectedBudget=budget,selectedParent=parent;
    if(iocPlan){
      if(budget!==0||iocPlan.orders.some(order=>order.createdAt<=parent.createdAt))
        throw new Error('恢复 IOC 尾差前历史 Maker 原预算须已全部消费');
      selectedBudget=iocPlan.quantity;
    }
    if(tailParent){
      if(budget!==0||tailParent.createdAt<=parent.createdAt||!tailParent.makerReduction||
        !['long','short'].includes(tailParent.makerReduction.makerLeg)||tailParent.makerReduction.activity!=='terminal'||
        tailParent.makerReduction.bookedExecution!==true||tailParent.makerReduction.lotTailOriginalParentClientId||
        tailParent.executionEvidence?.method!=='maker'||tailParent.executionEvidence.role!=='exit'||
        tailParent.request.reduceOnly!==true||tailParent.request.postOnly!==true||tailParent.request.closePosition!==undefined||
        !tailParent.result?.id||tailParent.result.id===tailParent.request.clientOrderId||tailParent.result.filledQuantity<=0||
        tailParent.result.averagePriceVerified!==true||!Number.isFinite(tailParent.result.feeUsd)||
        tailParent.executionEvidence.bookedFeeUsd!==tailParent.result.feeUsd||!isTerminalOrderReceipt(tailParent.request,tailParent.result))
        throw new Error('当前尾差须另选完整已确认 Maker，且历史未知所属原父预算已全部消费');
      const tailMaker=p[tailParent.makerReduction.makerLeg],tailPeer=p[tailParent.makerReduction.makerLeg==='long'?'short':'long'];
      const tailPeers=this.store.data.orders.filter(order=>order.positionId===p.id&&order.executionEvidence?.makerCloseParentClientId===tailParent.request.clientOrderId);
      if(tailParent.exchange!==tailMaker.exchange||tailParent.request.base!==p.base||tailParent.request.symbol!==tailMaker.symbol||
        tailParent.request.side!==(tailMaker.side==='long'?'sell':'buy')||tailPeers.some(o=>
          o.createdAt<tailParent.createdAt||o.exchange!==tailPeer.exchange||o.request.base!==p.base||o.request.symbol!==tailPeer.symbol||
          o.request.side!==(tailPeer.side==='long'?'sell':'buy')||o.request.reduceOnly!==true||o.request.postOnly===true||
          o.executionEvidence?.method!=='ioc'||o.executionEvidence.role!=='exit-tail'||!o.result||
          !isTerminalOrderReceipt(o.request,o.result)||o.result.averagePriceVerified===false||!Number.isFinite(o.result.feeUsd)||
          o.executionEvidence.bookedFeeUsd!==o.result.feeUsd))
        throw new Error('当前已确认 Maker 或其对侧终态现金身份不一致，未认领当前尾差');
      selectedBudget=quantitySubtract(tailParent.result.filledQuantity,tailPeers.reduce((sum,o)=>quantityAdd(sum,o.result!.filledQuantity),0));
      if(!Number.isFinite(selectedBudget)||selectedBudget<=0)throw new Error('另选当前 Maker 已无合法未消费预算');
      selectedParent=tailParent;
    }
    const selectedPeer=iocPlan?.leg??p[selectedParent.makerReduction!.makerLeg==='long'?'short':'long'],
      selectedMaker=iocPlan?(selectedPeer===p.long?p.short:p.long):p[selectedParent.makerReduction!.makerLeg],
      excess=quantitySubtract(selectedPeer.quantity,selectedMaker.quantity),
      tolerance=Number.EPSILON*Math.max(selectedPeer.quantity,selectedMaker.quantity,selectedParent.result!.filledQuantity)*8;
    if(!Number.isFinite(budget)||!Number.isFinite(excess)||budget<0||excess<0||Math.abs(selectedBudget-excess)>tolerance||
      selectedBudget>0&&(p.closeRequestedAt===undefined||p.closeProfitRequired!==true||p.closePricing!=='best-opposite')||
      selectedBudget===0&&excess!==0)
      throw new Error('真实余仓尾差与原已确认 Maker 尚未消费预算不一致，未新增減仓');
    for(const verifiedParent of tailParent?[parent,tailParent]:[parent]){
      const nativeParent=clients.get(verifiedParent.exchange)!;
      if(!nativeParent.inspectMakerReduction)throw new Error('所选 Maker 缺少原生只读核验接口');
      const nativeStarted=Date.now(),observation=await this.boundedPrivateRead(nativeParent,`native-exit-parent:${verifiedParent.request.clientOrderId}`,
        ()=>nativeParent.inspectMakerReduction!(structuredClone(verifiedParent.request),verifiedParent.result!.id));ensure();
      if(observation.activity!=='terminal'||!observation.executionVerified||observation.observedAt<nativeStarted||observation.observedAt>Date.now()||
        observation.result.id!==verifiedParent.result!.id||observation.result.clientOrderId!==verifiedParent.request.clientOrderId||
        !isTerminalOrderReceipt(verifiedParent.request,observation.result)||observation.result.averagePriceVerified!==true||
        observation.result.filledQuantity!==verifiedParent.result!.filledQuantity||observation.result.averagePrice!==verifiedParent.result!.averagePrice||observation.result.feeUsd!==verifiedParent.result!.feeUsd)
        throw new Error('原 Maker 原生完整现金与已确认账本不一致，未恢复真实持仓退出');
    }
    for(const order of iocPlan?.orders??[]){
      if(order.result!.id===''){
        // The original internal veto is preserved as local evidence; no fictitious native ID or GET is created.
        iocReads.push({clientOrderId:order.request.clientOrderId,financialFingerprint:confirmedIocOrderProof(order),localNoSend:true});continue;
      }
      const adapter=clients.get(order.exchange)!;
      if(!adapter.inspectOrder)throw new Error('所选 IOC 原单缺少严格原生只读现金核验接口');
      const nativeStarted=Date.now(),result=await this.boundedPrivateRead(adapter,`native-exit-ioc:${order.request.clientOrderId}`,
        ()=>adapter.inspectOrder!(structuredClone(order.request),order.result!.id));ensure();
      if(!Number.isFinite(result.orderReadAt)||result.orderReadAt!<nativeStarted||result.orderReadAt!>Date.now()||
        result.id!==order.result!.id||result.clientOrderId!==order.request.clientOrderId||!isTerminalOrderReceipt(order.request,result)||
        result.status!==order.result!.status||result.filledQuantity!==order.result!.filledQuantity||
        result.averagePrice!==order.result!.averagePrice||result.feeUsd!==order.result!.feeUsd||
        result.filledQuantity>0&&result.averagePriceVerified!==true||result.rejectionCode!==order.result!.rejectionCode)
        throw new Error('原 IOC 原生终态完整现金与已入账原单不一致，未恢复尾差');
      iocReads.push({clientOrderId:order.request.clientOrderId,financialFingerprint:confirmedIocOrderProof(order),nativeObservedAt:result.orderReadAt});
    }
    await this.refreshExecutionSnapshots(p.base,legs.map(l=>l.exchange));ensure();
    const {feeReserveUsd,lossReserveUsd}=estimateNativeExitReserve(unknowns as JournalOrder[],p,
      legs.map(leg=>this.snapshot(leg.exchange,p.base)!),config);
    const audit:NativeExitRecoveryAudit={version:1,id:input.operationId,authorizedAt:Date.now(),parentClientOrderId:parent.request.clientOrderId,
      unknownClientOrderIds:[...input.unknownClientOrderIds],originalRemainingBudget:budget,feeReserveUsd,lossReserveUsd,
      originalUnknowns:(unknowns as JournalOrder[]).map(order=>({clientOrderId:order.request.clientOrderId,financialFingerprint:fingerprint(order),originalResult:structuredClone(order.result!)})),
      originalParentFingerprint:frozenParent!,nativeReadEvidence:[],noOpenOrders:[]};
    if(tailParent)Object.assign(audit,{confirmedTailParentClientOrderId:tailParent.request.clientOrderId,
      confirmedTailParentFingerprint:frozenTailParent,confirmedTailRemainingBudget:selectedBudget});
    if(iocPlan)Object.assign(audit,{confirmedIocBatchId:iocPlan.batchId,confirmedIocRemainingBudget:iocPlan.quantity,confirmedIocOrders:iocReads});
    const accounts=await this.readStableMakerRepairAccounts(p,clients,ensure,true,undefined,audit);ensure();
    return this.exclusive(async()=>{
      ensure();
      for(const [exchange,account] of accounts)if(!this.cacheAccount(exchange,account))throw new Error('所选真实持仓账户证据已过期');
      const old={status:p.status,riskReasons:p.riskReasons,audits:p.nativeExitRecoveryAudit,reconciled:this.reconciledPositions.has(p.id),continuing:this.continuingClosePositions.has(p.id)};
      p.nativeExitRecoveryAudit=[...(p.nativeExitRecoveryAudit??[]),audit];p.status=selectedBudget>0?'closing':'open';p.riskReasons=['原未知 IOC 保留待核账，当前真实持仓按独立退出授权管理'];
      try{
        this.store.save();ensure();this.execution.installNativeExitAuthority(p,audit,()=>{try{active();return true;}catch{return false;}});
        if(iocPlan)this.execution.installVerifiedIocTail(p,audit);
        this.reconciledPositions.add(p.id);if(p.closeRequestedAt!==undefined)this.continuingClosePositions.add(p.id);this.financialEpoch++;
      }catch(error){
        try{this.execution.revokeNativeExitAuthority(p,'所选真实退出授权保存或安装失败');}catch{/* Preserve the original persistence failure and roll back the local grant. */}
        p.status=old.status;p.riskReasons=old.riskReasons;
        p.nativeExitRecoveryAudit=old.audits;if(!old.reconciled)this.reconciledPositions.delete(p.id);if(!old.continuing)this.continuingClosePositions.delete(p.id);
        this.autoEnabled=false;this.store.data.killSwitch=true;throw error;
      }
      return {positionId:p.id,auditId:audit.id,longQuantity:p.long.quantity,shortQuantity:p.short.quantity,checkedAt:Date.now()};
    });
  }
  /** Explicit recovery of one already-filled Maker's peer budget. GET verification never replays an original order. */
  async repairSelectedMakerClose(request:SelectedMakerCloseRepairRequest):Promise<{positionId:string;repaired:boolean;longQuantity:number;shortQuantity:number;checkedAt:number;feeCorrectionCount?:number}>{
    if(request?.acknowledgement==='REPAIR_SELECTED_MAKER_CLOSE_LOT_TAIL')return this.repairSelectedMakerLotTail(request);
    const now=Date.now(),ids=request?.legacyPeerClientOrderIds??[],wanted=request?.expected,fees=request?.expectedPeerFeeCorrections;
    if(!request||request.acknowledgement!=='REPAIR_SELECTED_MAKER_CLOSE_TAIL'||!wanted||
      !Number.isFinite(request.expiresAt)||request.expiresAt<=now||request.expiresAt>now+60_000||
      ![request.positionId,request.parentClientOrderId,...ids].every(id=>typeof id==='string'&&id.length>0&&id.length<=150)||
      !Array.isArray(ids)||ids.length>20||new Set(ids).size!==ids.length||ids.includes(request.parentClientOrderId)||
      ![wanted.openedAt,wanted.longQuantity,wanted.shortQuantity].every(value=>Number.isFinite(value)&&value>0)||
      fees===undefined&&request.feeCorrectionAcknowledgement!==undefined||fees!==undefined&&
        (request.feeCorrectionAcknowledgement!=='RECONCILE_CONFIRMED_PEER_FEES'||!Array.isArray(fees)||!fees.length||fees.length>20||
          fees.some(fee=>!fee||typeof fee.clientOrderId!=='string'||!fee.clientOrderId||fee.clientOrderId.length>150||
            ![fee.bookedFeeUsd,fee.confirmedFeeUsd].every(Number.isFinite)||fee.bookedFeeUsd===fee.confirmedFeeUsd)||
          new Set(fees.map(fee=>fee.clientOrderId)).size!==fees.length))
      throw new Error('缺少有效的单组 Maker 尾差修复确认，请刷新后重新选择');
    this.assertCredentialsStable();
    const input=structuredClone(request),generation=this.startGeneration,config=this.config,epoch=this.financialEpoch;
    const p=this.store.data.positions.find(position=>position.id===input.positionId),legacy=input.legacyPeerClientOrderIds??[];
    const originalLegs=p&&[p.long,p.short];
    const parent=this.store.data.orders.find(order=>order.positionId===input.positionId&&order.request.clientOrderId===input.parentClientOrderId);
    const peerIds=[...new Set([...legacy,...(parent?.makerReduction?.recoveredPeers?.clientOrderIds??[]),
      ...this.store.data.orders.filter(order=>order.positionId===input.positionId&&order.executionEvidence?.makerCloseParentClientId===input.parentClientOrderId)
        .map(order=>order.request.clientOrderId)])];
    const peers=peerIds.map(id=>this.store.data.orders.find(order=>order.positionId===input.positionId&&order.request.clientOrderId===id));
    const originalCash=()=>JSON.stringify([parent,...peers].map(journal=>journal&&({positionId:journal.positionId,exchange:journal.exchange,
      request:journal.request,result:journal.result,bookedFeeUsd:journal.executionEvidence?.bookedFeeUsd})));
    let frozenCash=originalCash();
    const feeCorrections=new Map((input.expectedPeerFeeCorrections??[]).map(fee=>[fee.clientOrderId,fee]));
    const originalIdentity=()=>JSON.stringify(p&&{id:p.id,base:p.base,openedAt:p.openedAt,mode:p.mode,entryPolicy:p.entryPolicy,
      holdMode:p.holdMode,profitExitPolicy:p.profitExitPolicy,profitExitNotionalUsd:p.profitExitNotionalUsd,
      legs:[p.long,p.short].map(leg=>({exchange:leg.exchange,symbol:leg.symbol,side:leg.side,entryPrice:leg.entryPrice}))});
    const frozenIdentity=originalIdentity();
    const clients=p?new Map([p.long,p.short].map(leg=>[leg.exchange,this.adapters.find(adapter=>adapter.id===leg.exchange)!])):new Map<ExchangeId,ExchangeAdapter>();
    const scope=()=>JSON.stringify({permission:this.liveVenues().map(venue=>venue.exchange).sort(),position:p&&{
      id:p.id,base:p.base,mode:p.mode,status:p.status,openedAt:p.openedAt,entryPolicy:p.entryPolicy,holdMode:p.holdMode,
      profitExitPolicy:p.profitExitPolicy,profitExitNotionalUsd:p.profitExitNotionalUsd,manualCloseOnly:p.manualCloseOnly,accountClosure:p.accountClosure,
      legs:[p.long,p.short].map(leg=>({exchange:leg.exchange,symbol:leg.symbol,side:leg.side,quantity:leg.quantity,entryPrice:leg.entryPrice,
        feesUsd:leg.feesUsd,fundingUsd:leg.fundingUsd,realizedPnlUsd:leg.realizedPnlUsd})),
      fundingUsd:p.fundingUsd,feesUsd:p.feesUsd,realizedSpreadPnlUsd:p.realizedSpreadPnlUsd,transferCostUsd:p.transferCostUsd,fundingEvents:p.fundingEvents,
      closeRequestedAt:p.closeRequestedAt,closeAttemptedAt:p.closeAttemptedAt,closeReason:p.closeReason,closeProfitRequired:p.closeProfitRequired,closePricing:p.closePricing},
      orders:this.store.data.orders.filter(order=>order.positionId===input.positionId)});
    const frozen=scope();
    const active=(pending?:JournalOrder)=>{
      this.assertCredentialsStable();
      if(this.stopping||this.maintenanceTradingPending||this.startGeneration!==generation||this.config!==config||
        config.mode!=='live'||config.dataSource!=='public'||!this.sessionLivePermission||!this.liveUnlocked||
        this.autoEnabled||this.store.data.killSwitch)throw new Error('须暂停自动开仓并核对当前会话授权后，才可修复所选 Maker 尾差');
      if(!p||this.store.data.positions.find(position=>position.id===p.id)!==p||p.long!==originalLegs?.[0]||p.short!==originalLegs?.[1]||p.mode!=='live'||!isPositionActive(p)||!['attention','closing'].includes(p.status)||p.manualCloseOnly||p.accountClosure||
        p.entryPolicy!=='aligned'||p.holdMode!=='adaptive'||p.closeProfitRequired!==true||p.closePricing!=='best-opposite'||
        !p.profitExitPolicy||p.long.side!=='long'||p.short.side!=='short'||p.long.exchange===p.short.exchange||
        p.closeRequestedAt===undefined||this.execution.hasMakerClose(p)||this.execution.hasIocProfitClose(p)||
        this.execution.hasPendingIocProfitTail(p)||this.unidentifiedOrder()||
        this.store.data.orders.some(order=>order!==pending&&isCurrentUnconfirmedOrder(order,this.store.data.positions)&&
          (order.positionId===p.id||unresolvedCoin(order,this.store.data.positions)===coinBase(p.base)||
            [p.long,p.short].some(leg=>order.exchange===leg.exchange&&order.request.symbol===leg.symbol))))
        throw new Error('原 Maker 或平仓意图未完整确认，禁止新增减仓');
      for(const leg of [p.long,p.short]){
        this.assertLiveAccess(leg.exchange);
        if(!clients.get(leg.exchange)||this.adapter(leg.exchange)!==clients.get(leg.exchange))throw new Error('所选账户范围已变化');
      }
      if(this.activePositions().some(other=>other.id!==p.id&&coinBase(other.base)===coinBase(p.base)))throw new Error('所选币种存在重复管理记录');
    };
    const ensure=()=>{
      active();
      if(this.financialEpoch!==epoch||Date.now()>=input.expiresAt||scope()!==frozen||
        p!.base!==input.expected.base||p!.openedAt!==input.expected.openedAt||p!.long.exchange!==input.expected.longExchange||p!.long.symbol!==input.expected.longSymbol||
        p!.long.quantity!==input.expected.longQuantity||p!.short.exchange!==input.expected.shortExchange||p!.short.symbol!==input.expected.shortSymbol||p!.short.quantity!==input.expected.shortQuantity)
        throw new Error('所选原意图、数量或修复确认已变化，请重新选择');
    };
    ensure();
    if(!parent?.makerReduction||parent.makerReduction.activity!=='terminal'||!parent.result?.id||parent.result.filledQuantity<0||
      isUnconfirmedJournalOrder(parent)||peers.some(peer=>!peer||isUnconfirmedJournalOrder(peer)))
      throw new Error('原 Maker 或已减对侧缺少完整终态现金，未提交修复');
    // A genuine native zero-fill Maker owns no hedge budget. Explicitly verified matched
    // holdings may release that old conditional intent, without entering any order path.
    const zeroFilledParent=parent.result.filledQuantity===0;
    const verifyZeroIntent=()=>{
      if(!zeroFilledParent)return;
      const zero=(journal:JournalOrder)=>journal.request.reduceOnly===true&&journal.request.postOnly===true&&
        journal.makerReduction?.activity==='terminal'&&journal.makerReduction.bookedExecution===true&&
        journal.executionEvidence?.method==='maker'&&journal.executionEvidence.role==='exit'&&
        journal.result?.status==='cancelled'&&journal.result.filledQuantity===0&&journal.result.averagePrice===0&&
        journal.result.averagePriceVerified===true&&journal.result.feeUsd===0&&journal.executionEvidence.bookedFeeUsd===0&&
        !isUnconfirmedJournalOrder(journal);
      const sameIntent=this.store.data.orders.filter(order=>order.positionId===p!.id&&order.createdAt>=p!.closeRequestedAt!);
      if(parent.result!.id===parent.request.clientOrderId||!parent.result!.id.trim()||parent.createdAt<p!.closeRequestedAt!||
        !zero(parent)||peers.length||legacy.length||feeCorrections.size||!this.matchedQuantities(p!)||
        !sameIntent.includes(parent)||sameIntent.some(order=>!zero(order)||
          ![p!.long,p!.short].some(leg=>order.exchange===leg.exchange&&order.request.symbol===leg.symbol&&
            order.request.base===p!.base&&order.request.side===(leg.side==='long'?'sell':'buy'))))
        throw new Error('零成交原 Maker 必须有真实原生身份、完整零现金及同量持仓，未恢复管理');
    };
    verifyZeroIntent();
    const peerLeg=p![parent.makerReduction.makerLeg==='long'?'short':'long'];
    if(parent.request.reduceOnly!==true||parent.request.postOnly!==true||
      peers.some(peer=>peer!.exchange!==peerLeg.exchange||peer!.request.symbol!==peerLeg.symbol||peer!.request.base!==p!.base||
        peer!.request.side!==(peerLeg.side==='long'?'sell':'buy')||peer!.request.reduceOnly!==true||peer!.request.postOnly===true||
        peer!.createdAt<parent.createdAt||!peer!.result?.id))throw new Error('所选旧对侧订单不属于原 Maker 确认预算');
    const makerClient=clients.get(parent.exchange)!;
    if(!makerClient?.inspectMakerReduction||peers.some(peer=>!clients.get(peer!.exchange)?.inspectOrder))
      throw new Error('所选原订单缺少只读原生查单接口');
    if(feeCorrections.size&&(!this.matchedQuantities(p!)||p!.status!=='attention'||parent.result.averagePriceVerified!==true||
      quantitySubtract(parent.result.filledQuantity,peers.reduce((sum,peer)=>quantityAdd(sum,peer!.result!.filledQuantity),0))!==0||
      [...feeCorrections.values()].some(fee=>{
        const peer=peers.find(peer=>peer!.request.clientOrderId===fee.clientOrderId);
        return !peer||peer.exchange!=='bitget'||peer.executionEvidence?.makerCloseParentClientId!==input.parentClientOrderId||
          peer.result!.filledQuantity<=0||peer.result!.feeUsd!==fee.bookedFeeUsd||peer.executionEvidence.bookedFeeUsd!==fee.bookedFeeUsd||
          !clients.get(peer.exchange)?.verifyOrderExecution;
      })))throw new Error('显式费用更正仅适用于原 Maker 已配平且预算为零的已关联完整对侧成交');
    const equal=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(1,Math.abs(a),Math.abs(b))*Number.EPSILON*16;
    const sameExecution=(journal:JournalOrder,result:OrderResult)=>result.id===journal.result!.id&&result.clientOrderId===journal.request.clientOrderId&&
      !isUnconfirmedJournalOrder({...journal,result})&&equal(result.filledQuantity,journal.result!.filledQuantity)&&
      equal(result.feeUsd,journal.result!.feeUsd);
    const sameCash=(journal:JournalOrder,result:OrderResult)=>sameExecution(journal,result)&&equal(result.averagePrice,journal.result!.averagePrice);
    const sameFeeCorrection=(journal:JournalOrder,result:OrderResult,fee:{confirmedFeeUsd:number})=>
      result.id===journal.result!.id&&result.clientOrderId===journal.request.clientOrderId&&!isUnconfirmedJournalOrder({...journal,result})&&
      result.status===journal.result!.status&&result.filledQuantity===journal.result!.filledQuantity&&
      result.averagePrice===journal.result!.averagePrice&&result.averagePriceVerified===true&&result.feeUsd===fee.confirmedFeeUsd;
    const correctedProofs=new Map<JournalOrder,OrderResult>();
    const readAt=Date.now();
    const [observed,peerResults]=await Promise.all([
      this.boundedPrivateRead(makerClient,`maker-tail-parent:${parent.request.clientOrderId}`,()=>makerClient.inspectMakerReduction!(parent.request,parent.result!.id)),
      Promise.all(peers.map(peer=>this.boundedPrivateRead(clients.get(peer!.exchange)!,`maker-tail-peer:${peer!.request.clientOrderId}`,
        ()=>clients.get(peer!.exchange)!.inspectOrder!(peer!.request,peer!.result!.id)))),
    ]);
    ensure();
    if(observed.activity!=='terminal'||!observed.executionVerified||!Number.isFinite(observed.observedAt)||observed.observedAt<readAt||observed.observedAt>Date.now()||
      zeroFilledParent&&(observed.result.status!=='cancelled'||observed.result.filledQuantity!==0||observed.result.averagePrice!==0||
        observed.result.feeUsd!==0||observed.result.averagePriceVerified!==true)||
      !sameCash(parent,observed.result)||peerResults.some((result,index)=>{
        const peer=peers[index]!,fee=feeCorrections.get(peer.request.clientOrderId);
        return !(fee?sameFeeCorrection(peer,result,fee):sameExecution(peer,result))||
          !Number.isFinite(result.orderReadAt)||result.orderReadAt!<readAt||result.orderReadAt!>Date.now();
      }))
      throw new Error('原生终态、身份或累计成交现金与原账本不一致，未提交修复');
    for(let index=0;index<peers.length;index++){
      const peer=peers[index]!,result=peerResults[index],fee=feeCorrections.get(peer.request.clientOrderId);
      if(!fee&&equal(result.averagePrice,peer.result!.averagePrice))continue;
      const client=clients.get(peer.exchange)!;
      // A Bybit order summary can truncate its weighted average. Only independently complete
      // original execution cash may prove that exact saved price; never widen its tolerance.
      if((fee?peer.exchange!=='bitget':peer.exchange!=='bybit')||peer.request.reduceOnly!==true||peer.request.postOnly===true||result.filledQuantity<=0||!client.verifyOrderExecution)
        throw new Error('原生终态、身份或累计成交现金与原账本不一致，未提交修复');
      ensure();const executionReadAt=Date.now();
      const execution=await this.boundedPrivateRead(client,`maker-tail-peer-execution:${peer.request.clientOrderId}`,
        ()=>client.verifyOrderExecution!(peer.request,peer.result!.id));
      ensure();
      if(execution.averagePriceVerified!==true||!(fee?sameFeeCorrection(peer,execution,fee):sameCash(peer,execution))||!Number.isFinite(execution.orderReadAt)||
        execution.orderReadAt!<executionReadAt||execution.orderReadAt!>Date.now())
        throw new Error('原生完整成交现金与原账本不一致，未提交修复');
      if(fee)correctedProofs.set(peer,structuredClone(execution));
    }
    ensure();verifyZeroIntent();
    if(!this.execution.canRepairConfirmedMakerCloseTail(p!,input.parentClientOrderId,legacy))
      throw new Error('原 Maker 已确认预算不足、对侧关联不明或存在明确拒绝，未提交修复');
    const initialAccounts=await this.readStableMakerRepairAccounts(p!,clients,ensure,true);ensure();
    return this.exclusive(async()=>{
      ensure();verifyZeroIntent();
      if(!this.execution.canRepairConfirmedMakerCloseTail(p!,input.parentClientOrderId,legacy))throw new Error('所选已确认尾差预算已变化');
      for(const [peer,proof] of correctedProofs)if(!sameFeeCorrection(peer,proof,feeCorrections.get(peer.request.clientOrderId)!)||
        Date.now()-proof.orderReadAt!>config.maxSnapshotAgeMs)throw new Error('已确认费用的完整原生成交证据已过期，未更正或恢复管理');
      for(const [exchange,account] of initialAccounts)if(!this.cacheAccount(exchange,account))throw new Error('所选尾差账户证据已过期');
      this.financialEpoch++;
      let feeCorrectionCount=0;
      if(correctedProofs.size){
        const expectedPosition=JSON.parse(scope()).position,expectedCash=JSON.parse(frozenCash);
        for(const [peer,proof] of correctedProofs){
          const fee=feeCorrections.get(peer.request.clientOrderId)!,delta=proof.feeUsd-fee.bookedFeeUsd;
          expectedPosition.feesUsd+=delta;expectedPosition.legs[peerLeg===p!.long?0:1].feesUsd+=delta;
          const index=[parent,...peers].indexOf(peer);expectedCash[index].result.feeUsd=proof.feeUsd;expectedCash[index].bookedFeeUsd=proof.feeUsd;
        }
        try{
          for(const [peer,proof] of correctedProofs){
            active();if(Date.now()>=input.expiresAt)throw new Error('显式费用更正确认已过期');
            if(this.execution.reconcileConfirmedMakerPeerFee(peer,proof,feeCorrections.get(peer.request.clientOrderId)!.bookedFeeUsd))feeCorrectionCount++;
          }
          active();
          if(Date.now()>=input.expiresAt||originalCash()!==JSON.stringify(expectedCash)||
            JSON.stringify(JSON.parse(scope()).position)!==JSON.stringify(expectedPosition))
            throw new Error('显式费用更正出现授权范围之外的原现金或持仓变化');
          // Only this explicitly verified, saved fee delta becomes the next phase's cash baseline.
          frozenCash=JSON.stringify(expectedCash);
        }catch(error){
          this.financialEpoch++;this.store.data.killSwitch=true;p!.status='attention';
          p!.riskReasons=['已确认对侧费用更正或保存未完成，停止新交易；保留原成交审计等待核对'];
          try{this.store.save();}catch(saveError){throw saveError;}throw error;
        }
      }
      const originalId=p!.id,originalIntent=p!.closeRequestedAt;
      const makerLeg=p![parent.makerReduction!.makerLeg],makerQuantity=makerLeg.quantity,peerQuantity=peerLeg.quantity;
      const originalOrders=new Set(this.store.data.orders);
      const permit=(pending?:JournalOrder)=>{
        // The native callback sees its own already-durable intent before it has a
        // receipt. Only that exact object may be excluded; every other unknown
        // order remains a blocker, including records under another position ID.
        active(pending);
        const additions=this.store.data.orders.filter(order=>order.positionId===p!.id&&!originalOrders.has(order));
        if(pending&&(!additions.includes(pending)||pending.result!==undefined))
          throw new Error('本次原生末检查不是所选修复自己尚未发送的意图');
        let confirmed=0;
        for(const order of additions){
          if(order.executionEvidence?.makerCloseParentClientId!==input.parentClientOrderId||order.exchange!==peerLeg.exchange||
            order.request.symbol!==peerLeg.symbol||order.request.side!==(peerLeg.side==='long'?'sell':'buy')||
            order.request.base!==p!.base||order.request.reduceOnly!==true||order.request.postOnly===true||
            order.executionEvidence.method!=='ioc'||order.executionEvidence.role!=='exit-tail'||order.createdAt<parent.createdAt||
            order!==pending&&isUnconfirmedJournalOrder(order))
            throw new Error('本次尾差修复出现未确认或范围外新订单，停止新增减仓');
          if(order===pending)continue;
          confirmed=quantityAdd(confirmed,order.result!.filledQuantity);
        }
        const expectedPeer=quantitySubtract(peerQuantity,confirmed),tolerance=Number.EPSILON*Math.max(peerQuantity,expectedPeer)*8;
        // The exclusive commit owns its subsequent cash epochs; its own confirmed partial fills
        // must not revoke the remaining original budget. No other financial commit can enter here.
        if(Date.now()>=input.expiresAt||p!.id!==originalId||p!.closeRequestedAt!==originalIntent||
          makerLeg.quantity!==makerQuantity||!Number.isFinite(expectedPeer)||Math.abs(peerLeg.quantity-expectedPeer)>tolerance||
          originalIdentity()!==frozenIdentity||originalCash()!==frozenCash||
          [parent,...peers].some(journal=>!journal||!this.store.data.orders.includes(journal))||
          (pending?!(Number.isFinite(pending.request.quantity)&&pending.request.quantity>0&&
            pending.request.quantity<=expectedPeer-makerQuantity+tolerance):
            !this.execution.canRepairConfirmedMakerCloseTail(p!,input.parentClientOrderId,legacy)))throw new Error('本次尾差修复提交条件已变化');
        return true;
      };
      let repaired=false;
      try{
        if(zeroFilledParent){permit();verifyZeroIntent();repaired=true;}
        else repaired=await this.execution.repairConfirmedMakerCloseTail(p!,input.parentClientOrderId,legacy,permit);
        if(repaired&&this.matchedQuantities(p!)){
          const completedScope=scope(),settlement:MakerRepairSettlement={identities:new Map(),quantities:new Map()};
          for(const leg of [p!.long,p!.short]){
            const row=initialAccounts.get(leg.exchange)!.positions.find(row=>row.symbol===leg.symbol&&row.side===leg.side&&row.quantity>0)!;
            settlement.identities.set(leg.exchange,makerRepairNativeIdentity(leg.exchange,row));
            settlement.quantities.set(leg.exchange,[row.quantity,leg.quantity]);
          }
          let remaining=peerQuantity;
          for(const order of this.store.data.orders.filter(order=>order.positionId===p!.id&&!originalOrders.has(order))){
            remaining=quantitySubtract(remaining,order.result!.filledQuantity);settlement.quantities.get(peerLeg.exchange)!.push(remaining);
          }
          const confirm=()=>{permit();if(scope()!==completedScope)throw new Error('修复后原意图、数量或已确认现金已变化');};
          const accounts=await this.readSettledMakerRepairAccounts(p!,clients,confirm,settlement);
          for(const [exchange,account] of accounts)if(!this.cacheAccount(exchange,account))throw new Error('修复后账户数量证据已过期');
          let resumed=false;
          try{resumed=this.execution.suspendAutomaticClose(p!,'已核验原 Maker 成交并仅修复确认尾差，恢复按原本金 10 bps 条件管理');}
          catch(error){this.store.data.killSwitch=true;throw error;}
          if(!resumed)throw new Error('尾差已确认，等待最新账户数量核对后恢复持有');
          this.continuingClosePositions.delete(p!.id);this.pendingCloseChecks.delete(p!.id);this.holdingSamples.delete(p!.id);
          this.feeExitPreviewSamples.delete(p!.id);this.fundingExitStability.forget(p!.id);this.reconciledPositions.add(p!.id);
          try{this.store.save();}catch(error){this.store.data.killSwitch=true;throw error;}
        }else if(p!.closeRequestedAt!==undefined&&this.execution.hasPendingMakerCloseTail(p!))this.continuingClosePositions.add(p!.id);
      }catch(error){
        if(feeCorrectionCount>0)this.store.data.killSwitch=true;
        if(repaired||feeCorrectionCount>0){
          p!.status='attention';p!.riskReasons=[feeCorrectionCount>0?'已确认费用更正已保存，恢复管理仍待原账户或范围核验；停止新交易':
            '已确认尾差成交，恢复管理仍待账户或保存核验；未继续共同减仓'];
          try{this.store.save();}catch(saveError){this.store.data.killSwitch=true;throw saveError;}
        }
        throw error;
      }finally{this.financialEpoch++;}
      return {positionId:p!.id,repaired,longQuantity:p!.long.quantity,shortQuantity:p!.short.quantity,checkedAt:Date.now(),
        ...(feeCorrections.size?{feeCorrectionCount}:{})};
    });
  }
  /** A distinct scoped repair may augment a confirmed sub-lot Maker budget by only the
   * smallest profitable reduction. It never replays the old order or invents peer cash. */
  private async repairSelectedMakerLotTail(request:SelectedMakerCloseRepairRequest,automatic=false):Promise<{positionId:string;repaired:boolean;longQuantity:number;shortQuantity:number;checkedAt:number}>{
    const now=Date.now(),wanted=request.expected;
    if(request.acknowledgement!=='REPAIR_SELECTED_MAKER_CLOSE_LOT_TAIL'||!wanted||
      request.legacyPeerClientOrderIds!==undefined||request.feeCorrectionAcknowledgement!==undefined||request.expectedPeerFeeCorrections!==undefined||
      !Number.isFinite(request.expiresAt)||request.expiresAt<=now||request.expiresAt>now+60_000||
      ![request.positionId,request.parentClientOrderId].every(id=>typeof id==='string'&&id.length>0&&id.length<=150)||
      ![wanted.openedAt,wanted.longQuantity,wanted.shortQuantity].every(value=>Number.isFinite(value)&&value>0))
      throw new Error('缺少有效的所选最小共同尾差恢复确认');
    const input=structuredClone(request),generation=this.startGeneration,config=this.config;
    return this.exclusive(async()=>{
      const p=this.store.data.positions.find(position=>position.id===input.positionId),
        parent=this.store.data.orders.find(order=>order.positionId===input.positionId&&order.request.clientOrderId===input.parentClientOrderId);
      if(!p||!parent?.makerReduction||!parent.result?.id)throw new Error('所选原 Maker 或持仓身份不存在');
      let epoch=this.financialEpoch;
      const legs=[p.long,p.short],clients=new Map(legs.map(leg=>[leg.exchange,this.adapter(leg.exchange)]));
      const originalOrders=this.store.data.orders.filter(order=>order.positionId===p.id),originalSet=new Set(originalOrders),
        frozenOrders=JSON.stringify(originalOrders),originalQuantities={long:p.long.quantity,short:p.short.quantity},
        originalFees={long:p.long.feesUsd,short:p.short.feesUsd,total:p.feesUsd},originalRealized=p.realizedSpreadPnlUsd;
      const identity=()=>JSON.stringify({id:p.id,base:p.base,mode:p.mode,openedAt:p.openedAt,entryPolicy:p.entryPolicy,holdMode:p.holdMode,
        feeOnly:p.feeOnly,automaticEntry:p.automaticEntry,executionEvidence:p.executionEvidence,profitExitPolicy:p.profitExitPolicy,
        profitExitNotionalUsd:p.profitExitNotionalUsd,manualCloseOnly:p.manualCloseOnly,manualCloseOperationId:p.manualCloseOperationId,
        manualCloseAccountRecord:p.manualCloseAccountRecord,accountClosure:p.accountClosure,currentManagementRestorationHistory:p.currentManagementRestorationHistory,
        fundingUsd:p.fundingUsd,fundingEvents:p.fundingEvents,transferCostUsd:p.transferCostUsd,
        legs:legs.map(leg=>({exchange:leg.exchange,symbol:leg.symbol,side:leg.side,entryPrice:leg.entryPrice,fundingUsd:leg.fundingUsd})),
        intent:[p.closeRequestedAt,p.closeAttemptedAt,p.closeReason,p.closePricing,p.closeProfitRequired,p.closePauseReason],
        permission:this.liveVenues().map(venue=>venue.exchange).sort()});
      const frozenIdentity=identity(),equal=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(1,Math.abs(a),Math.abs(b))*Number.EPSILON*32;
      let executing=false;
      const ensure=()=>{
        this.assertCredentialsStable();
        if(this.stopping||this.maintenanceTradingPending||this.startGeneration!==generation||this.config!==config||
          this.financialEpoch!==epoch||Date.now()>=input.expiresAt||config.mode!=='live'||config.dataSource!=='public'||
          !this.sessionLivePermission||!this.liveUnlocked||this.autoEnabled!==automatic||automatic&&!this.running||this.store.data.killSwitch)
          throw new Error('所选共同尾差恢复的授权、运行状态或确认期限已变化');
        if(this.store.data.positions.find(position=>position.id===p.id)!==p||p.long!==legs[0]||p.short!==legs[1]||
          !isPositionActive(p)||!['attention','closing'].includes(p.status)||p.manualCloseOnly||p.manualCloseAccountRecord||p.accountClosure||
          currentExitStrategyPosition(p,config).entryPolicy!=='aligned'||currentExitStrategyPosition(p,config).holdMode!=='adaptive'||
          p.closeProfitRequired!==true||p.closePricing!=='best-opposite'||p.closeRequestedAt===undefined||
          p.long.side!=='long'||p.short.side!=='short'||p.long.exchange===p.short.exchange||this.unidentifiedOrder()||
          this.store.data.orders.some(order=>order.positionId!==p.id&&isCurrentUnconfirmedOrder(order,this.store.data.positions)&&
            unresolvedCoin(order,this.store.data.positions)===coinBase(p.base))||
          identity()!==frozenIdentity||JSON.stringify(originalOrders)!==frozenOrders||originalOrders.some(order=>!this.store.data.orders.includes(order))||
          this.activePositions().some(other=>other.id!==p.id&&coinBase(other.base)===coinBase(p.base)))
          throw new Error('所选原意图、身份或已确认现金已变化，未新增减仓');
        for(const leg of legs){this.assertLiveAccess(leg.exchange);if(this.adapter(leg.exchange)!==clients.get(leg.exchange))throw new Error('所选账户连接已变化');}
        const additions=this.store.data.orders.filter(order=>order.positionId===p.id&&!originalSet.has(order));
        if(!executing&&(additions.length||this.execution.hasMakerClose(p)||this.execution.hasIocProfitClose(p)||
          this.execution.hasPendingIocProfitTail(p)||originalOrders.some(order=>isCurrentUnconfirmedOrder(order,this.store.data.positions))))
          throw new Error('原 Maker 仍在活动或存在未知现金，未提交恢复');
        const quantities={...originalQuantities},fees={...originalFees};let realized=originalRealized;
        for(const order of additions){
          const makerSide=parent.makerReduction!.makerLeg,peerSide=makerSide==='long'?'short':'long',isMaker=!!order.makerReduction,
            side=isMaker?makerSide:peerSide,leg=p[side];
          if(order.exchange!==leg.exchange||order.request.base!==p.base||order.request.symbol!==leg.symbol||!order.request.reduceOnly||
            order.request.side!==(leg.side==='long'?'sell':'buy')||isMaker!==!!order.request.postOnly||
            (isMaker?order.makerReduction!.lotTailOriginalParentClientId:order.executionEvidence?.makerCloseLotTailOriginalParentClientId)!==input.parentClientOrderId)
            throw new Error('本次恢复出现所选原预算之外的新增订单');
          const result=order.result,booked=isMaker?order.makerReduction!.bookedExecution===true:
            !!result&&isTerminalOrderReceipt(order.request,result)&&order.executionEvidence?.bookedFeeUsd===result.feeUsd;
          if(booked){
            if(!result||!isTerminalOrderReceipt(order.request,result)||!Number.isFinite(result.feeUsd)||order.executionEvidence?.bookedFeeUsd!==result.feeUsd)
              throw new Error('新增现金缺少完整终态，未授权对侧消费');
            quantities[side]=quantitySubtract(quantities[side],result.filledQuantity);fees[side]+=result.feeUsd;fees.total+=result.feeUsd;
            realized+=(leg.side==='long'?result.averagePrice-leg.entryPrice:leg.entryPrice-result.averagePrice)*result.filledQuantity;
          }
        }
        if(!equal(p.long.quantity,quantities.long)||!equal(p.short.quantity,quantities.short)||
          !equal(p.long.feesUsd,fees.long)||!equal(p.short.feesUsd,fees.short)||!equal(p.feesUsd,fees.total)||!equal(p.realizedSpreadPnlUsd,realized))
          throw new Error('新增减仓与真实持仓数量或现金不一致，未继续恢复');
      };
      ensure();
      if(p.base!==wanted.base||p.openedAt!==wanted.openedAt||p.long.exchange!==wanted.longExchange||p.long.symbol!==wanted.longSymbol||
        p.long.quantity!==wanted.longQuantity||p.short.exchange!==wanted.shortExchange||p.short.symbol!==wanted.shortSymbol||p.short.quantity!==wanted.shortQuantity)
        throw new Error('所选尾差数量或身份已变化，请重新核对');
      const parentId=parent.request.clientOrderId,augmentations=originalOrders.filter(order=>order.makerReduction?.lotTailOriginalParentClientId===parentId),
        parents=[parent,...augmentations],parentIds=new Set(parents.map(order=>order.request.clientOrderId)),
        peerIds=new Set(parent.makerReduction.recoveredPeers?.clientOrderIds??[]),
        peers=originalOrders.filter(order=>peerIds.has(order.request.clientOrderId)||parentIds.has(order.executionEvidence?.makerCloseParentClientId??'')||
          order.executionEvidence?.makerCloseLotTailOriginalParentClientId===parentId);
      for(const order of [...parents,...peers]){
        ensure();const client=clients.get(order.exchange),saved=order.result,readAt=Date.now();
        // A prior augmentation vetoed before POST owns no native ID and adds no cash budget.
        // The original positive parent and every real or unknown native outcome still require GET proof.
        if(order!==parent&&order.makerReduction?.lotTailOriginalParentClientId===parentId&&
          order.exchange===parent.exchange&&order.request.base===parent.request.base&&order.request.symbol===parent.request.symbol&&
          order.request.side===parent.request.side&&order.request.reduceOnly===true&&order.request.postOnly===true&&
          order.makerReduction.makerLeg===parent.makerReduction.makerLeg&&order.executionEvidence?.method==='maker'&&order.executionEvidence.role==='exit'&&
          order.makerReduction.activity==='terminal'&&order.makerReduction.bookedExecution===true&&
          saved?.rejectionCode==='MAKER_REDUCTION_PERMISSION_CHANGED'&&isProvenNoSubmitReceipt(order.request,saved)&&
          saved.averagePrice===0&&order.executionEvidence?.bookedFeeUsd===0)continue;
        if(!client||!saved?.id||!isTerminalOrderReceipt(order.request,saved))throw new Error('关联原订单缺少完整原生终态');
        let observed:OrderResult,observedAt:number|undefined;
        if(order.makerReduction){
          if(!client.inspectMakerReduction)throw new Error('所选原 Maker 缺少原生查单');
          const result=await this.boundedPrivateRead(client,`lot-tail-maker:${order.request.clientOrderId}`,()=>client.inspectMakerReduction!(order.request,saved.id));ensure();
          if(result.activity!=='terminal'||!result.executionVerified)throw new Error('原 Maker 尚未确认完整终态现金');
          observed=result.result;observedAt=result.observedAt;
        }else{
          if(!client.inspectOrder)throw new Error('关联对侧缺少完整原生查单');
          observed=await this.boundedPrivateRead(client,`lot-tail-peer:${order.request.clientOrderId}`,()=>client.inspectOrder!(order.request,saved.id));ensure();observedAt=observed.orderReadAt;
          if((!equal(observed.averagePrice,saved.averagePrice)||observed.averagePriceVerified!==true)&&observed.filledQuantity>0&&client.verifyOrderExecution){
            observed=await this.boundedPrivateRead(client,`lot-tail-cash:${order.request.clientOrderId}`,()=>client.verifyOrderExecution!(order.request,saved.id));ensure();observedAt=observed.orderReadAt;
          }
        }
        if(!isTerminalOrderReceipt(order.request,observed)||observed.id!==saved.id||observed.clientOrderId!==order.request.clientOrderId||
          !equal(observed.filledQuantity,saved.filledQuantity)||!equal(observed.averagePrice,saved.averagePrice)||!equal(observed.feeUsd,saved.feeUsd)||
          observed.filledQuantity>0&&observed.averagePriceVerified!==true||!Number.isFinite(observedAt)||observedAt!<readAt||observedAt!>Date.now())
          throw new Error('所选原生身份或完整现金与账本不一致，未恢复尾差');
      }
      // Original native reads can outlast a BBO. Refresh only this repair's books
      // and metadata; actual account fees stay in the later execution preflight.
      await this.refreshExecutionSnapshots(p.base,legs.map(leg=>leg.exchange),false);ensure();
      if(!this.execution.canRepairConfirmedMakerLotTail(p,parent))throw new Error('所选共同尾差预算、数量步长或历史拒绝尚未通过');
      const initialAccounts=await this.readStableMakerRepairAccounts(p,clients,ensure,true);ensure();
      for(const leg of legs){
        const row=initialAccounts.get(leg.exchange)!.positions.find(row=>row.symbol===leg.symbol&&row.side===leg.side&&row.quantity>0)!;
        // Native position summaries may round weighted fill averages. The maximum
        // relative allowance is 0.01 bps; another cost basis is never adopted.
        if(!Number.isFinite(row.entryPrice)||row.entryPrice!<=0||Math.abs(row.entryPrice!-leg.entryPrice)>Math.max(row.entryPrice!,leg.entryPrice)*1e-6)
          throw new Error('所选原生持仓均价与真实原开仓成本不一致，未认领外部重开仓位');
      }
      for(const [exchange,account] of initialAccounts)if(!this.cacheAccount(exchange,account))throw new Error('所选尾差账户证据已过期');
      const verifyAccounts=async(previous?:{long:number;short:number})=>{
        const cashScope=()=>JSON.stringify({identity:identity(),quantities:[p.long.quantity,p.short.quantity],
          fees:[p.long.feesUsd,p.short.feesUsd,p.feesUsd],realized:p.realizedSpreadPnlUsd,
          orders:this.store.data.orders.filter(order=>order.positionId===p.id)});
        ensure();const completed=cashScope(),
          confirm=()=>{ensure();if(cashScope()!==completed)
            throw new Error('已确认动作后的数量或现金正在变化，未继续恢复');},settlement:MakerRepairSettlement={identities:new Map(),quantities:new Map()};
        for(const side of ['long','short'] as const){
          const leg=p[side],row=initialAccounts.get(leg.exchange)!.positions.find(row=>row.symbol===leg.symbol&&row.side===leg.side&&row.quantity>0)!;
          settlement.identities.set(leg.exchange,makerRepairNativeIdentity(leg.exchange,row));
          settlement.quantities.set(leg.exchange,[leg.quantity,...(previous?[previous[side]]:[])]);
        }
        const accounts=await this.readSettledMakerRepairAccounts(p,clients,confirm,settlement);confirm();
        for(const leg of legs){const client=clients.get(leg.exchange)!;
          const orders=await this.boundedPrivateRead(client,`lot-tail-final-orders:${leg.symbol}`,()=>client.fetchOpenOrders!(leg.symbol));confirm();
          if(!Array.isArray(orders)||orders.length)throw new Error('新增动作后存在原生挂单，未继续恢复');}
        for(const [exchange,account] of accounts)if(!this.cacheAccount(exchange,account))throw new Error('新增动作后的账户证据已过期');
      };
      executing=true;
      const notified=new Set<JournalOrder>(),owner=(journal:JournalOrder|undefined,previousEpoch:number)=>{
        if(!journal||previousEpoch!==epoch||originalSet.has(journal)||notified.has(journal)||
          !this.store.data.orders.includes(journal)||journal.positionId!==p.id||journal.exchange!==p[parent.makerReduction!.makerLeg].exchange||
          journal.makerReduction?.lotTailOriginalParentClientId!==parentId||!journal.request.reduceOnly||journal.request.postOnly!==true||
          !journal.result||!isTerminalOrderReceipt(journal.request,journal.result)||!Number.isFinite(journal.result.feeUsd)||
          journal.executionEvidence?.bookedFeeUsd!==journal.result.feeUsd||identity()!==frozenIdentity||JSON.stringify(originalOrders)!==frozenOrders)return;
        notified.add(journal);epoch=this.financialEpoch;
      };
      if(this.makerFinancialScopeObserver)throw new Error('另一限定财务核验仍在进行，未新增减仓');
      this.makerFinancialScopeObserver=owner;
      let repaired=false;
      try{
        repaired=await this.execution.repairConfirmedMakerLotTail(p,parent,ensure,verifyAccounts);
        if(repaired&&this.matchedQuantities(p)){
          await verifyAccounts();ensure();
          if(!this.execution.suspendAutomaticClose(p,'已按当前自动退出条件完成最小共同尾差恢复，按当前统一策略继续管理'))
            throw new Error('已确认共同余量，等待原自动意图恢复核验');
          this.continuingClosePositions.delete(p.id);this.pendingCloseChecks.delete(p.id);this.holdingSamples.delete(p.id);
          // Same-session funding observations remain real after this budget-only repair.
          // Ordinary management rechecks the now-matched actual quantities and current cycle.
          this.feeExitPreviewSamples.delete(p.id);this.reconciledPositions.add(p.id);
          try{this.store.save();}catch(error){this.store.data.killSwitch=true;throw error;}
        }
      }catch(error){
        p.status='attention';p.riskReasons=[`所选最小共同尾差恢复未通过：${safeMessage(error)}；保留原 ID 与真实现金，等待下一轮复核`];
        try{this.store.save();}catch(saveError){this.store.data.killSwitch=true;throw saveError;}throw error;
      }finally{if(this.makerFinancialScopeObserver===owner)this.makerFinancialScopeObserver=undefined;this.financialEpoch++;}
      return {positionId:p.id,repaired,longQuantity:p.long.quantity,shortQuantity:p.short.quantity,checkedAt:Date.now()};
    });
  }
  /** Only a confirmed, matched repair may briefly wait for the native account to reflect that exact cash. */
  private async readSettledMakerRepairAccounts(p:Position,clients:Map<ExchangeId,ExchangeAdapter>,ensure:()=>void,settlement:MakerRepairSettlement):Promise<Map<ExchangeId,AccountState>>{
    for(let attempt=0;;attempt++){
      ensure();
      try{return await this.readStableMakerRepairAccounts(p,clients,ensure,false,settlement);}
      catch(error){
        ensure();if(!(error instanceof MakerRepairAccountPending)||attempt>=2)throw error;
        await new Promise<void>(resolve=>setTimeout(resolve,500));ensure();
      }
    }
  }
  /** Two fresh GETs bind exact native rows around an optional original-order absence check. */
  private async readStableMakerRepairAccounts(p:Position,clients:Map<ExchangeId,ExchangeAdapter>,ensure:()=>void,checkOpenOrders=false,settlement?:MakerRepairSettlement,
    nativeExitAudit?:Pick<NativeExitRecoveryAudit,'nativeReadEvidence'|'noOpenOrders'>):Promise<Map<ExchangeId,AccountState>>{
    const read=async()=>{
      const startedAt=Date.now(),accounts=new Map(await Promise.all([...clients].map(async([exchange,adapter])=>[exchange,await this.readScopedTradingAccount(adapter,ensure)] as const)));
      ensure();const now=Date.now(),latest=Math.max(p.openedAt,p.closeRequestedAt??0,p.closeAttemptedAt??0,
        ...this.store.data.orders.filter(order=>order.positionId===p.id).map(order=>Math.max(order.createdAt,order.result?.timestamp??0)));
      const identities=[p.long,p.short].map(leg=>{
        const account=accounts.get(leg.exchange),at=account&&this.accountReadAt.get(account),quote=this.snapshot(leg.exchange,p.base);
        const rows=account?.positions.filter(row=>row.quantity>0&&(row.symbol===leg.symbol||coinBase(row.base)===coinBase(p.base))),row=rows?.[0];
        const tolerance=Math.min((quote?.quantityStep??0)*1e-7,Number.EPSILON*Math.max(leg.quantity,row?.quantity??0)*8);
        const openingAt=Math.max(p.openedAt,...this.store.data.orders.filter(order=>order.positionId===p.id&&!order.request.reduceOnly)
          .map(order=>Math.max(order.createdAt,order.result?.timestamp??0)));
        if(!account||!Number.isFinite(at)||at!<=0||
          !Number.isFinite(account.equityUsd)||!quote||quote.symbol!==leg.symbol||!isQuantityOnStep(leg.quantity,quote.quantityStep)||
          rows?.length!==1||!row||row.symbol!==leg.symbol||row.side!==leg.side||coinBase(row.base)!==coinBase(p.base)||
          !Number.isFinite(row.quantity)||
          row.splitPositionCount!==undefined&&row.splitPositionCount!==1||
          row.marginMode!==undefined&&!['crossed','isolated'].includes(row.marginMode)||
          row.positionId!==undefined&&(typeof row.positionId!=='string'||!row.positionId.trim())||
          row.entryPrice!==undefined&&(!Number.isFinite(row.entryPrice)||row.entryPrice<=0)||
          nativeExitAudit&&(row.entryPrice===undefined||Math.abs(row.entryPrice-leg.entryPrice)>Math.max(1e-8,leg.entryPrice*1e-6))||
          row.positionOpenedAt!==undefined&&(!Number.isFinite(row.positionOpenedAt)||row.positionOpenedAt<p.openedAt-5000||row.positionOpenedAt>openingAt+5000))
          throw new Error('所选原 Maker 尾差与新鲜账户身份或数量不一致');
        if(settlement&&makerRepairNativeIdentity(leg.exchange,row)!==settlement.identities.get(leg.exchange))
          throw new Error('修复后原生持仓身份已变化，未恢复管理');
        if(Math.abs(row.quantity-leg.quantity)>tolerance){
          if(settlement?.quantities.get(leg.exchange)?.some(quantity=>Math.abs(row.quantity-quantity)<=tolerance))
            throw new MakerRepairAccountPending('quantity');
          throw new Error('所选原 Maker 尾差与新鲜账户身份或数量不一致');
        }
        if(at!<startedAt||at!<=latest||at!>now||now-at!>this.config.maxSnapshotAgeMs){
          if(settlement)throw new MakerRepairAccountPending('freshness');
          throw new Error('所选原 Maker 尾差与新鲜账户身份或数量不一致');
        }
        if(nativeExitAudit)nativeExitAudit.nativeReadEvidence.push({exchange:leg.exchange,requestedAt:at!,symbol:row.symbol,side:row.side,quantity:row.quantity,
          marginMode:row.marginMode,positionId:row.positionId,positionOpenedAt:row.positionOpenedAt,entryPrice:row.entryPrice});
        return {exchange:leg.exchange,symbol:row.symbol,side:row.side,quantity:row.quantity,marginMode:row.marginMode,
          positionId:row.positionId,positionOpenedAt:row.positionOpenedAt,entryPrice:row.entryPrice};
      });
      return {accounts,identities};
    };
    const first=await read();
    if(checkOpenOrders)await Promise.all([p.long,p.short].map(async leg=>{
      const client=clients.get(leg.exchange)!;if(!client.fetchOpenOrders)throw new Error('所选合约缺少完整原生挂单读取');
      const orders=await this.boundedPrivateRead(client,`maker-tail-orders:${leg.symbol}`,()=>client.fetchOpenOrders!(leg.symbol));ensure();
      if(!Array.isArray(orders)||orders.length)throw new Error('所选合约仍有原生挂单，未提交尾差修复');
      if(nativeExitAudit)nativeExitAudit.noOpenOrders.push({exchange:leg.exchange,symbol:leg.symbol,checkedAt:Date.now()});
    }));
    const final=await read();
    if(JSON.stringify(first.identities)!==JSON.stringify(final.identities))throw new Error('原生挂单核验前后持仓身份或数量发生变化');
    return final.accounts;
  }
  /** Called only by the explicit local user action. Preflight alone never grants execution permission. */
  async startLive(acknowledgement:string):Promise<LiveStartReadiness>{
    if(acknowledgement!=='START_LIVE_TRADING')throw new Error('请在本机确认启动实盘自动策略');
    this.assertCredentialsStable();
    const generation=++this.startGeneration;
    return this.exclusive(async()=>{
      this.assertCredentialsStable();
      if(generation!==this.startGeneration||this.stopping)throw new Error('启动已取消');
      const {report,accounts}=await this.inspectStart();
      if(generation!==this.startGeneration||this.stopping)throw new Error('启动已取消');
      if(!report.canStart)throw new Error(report.blockers.join('；')||'至少需要两家有足够合约保证金的交易所');
      this.liveEnvironment=inspectLiveEnvironment(this.options.liveEnvironment??process.env);
      // Insufficient entry margin must not remove permission to reduce an existing position.
      this.sessionExchanges=new Set(report.accounts.filter(x=>x.status==='ready'||x.status==='insufficient').map(x=>x.exchange));
      this.sessionLivePermission=true;
      if(!this.liveUnlocked){this.sessionLivePermission=false;this.sessionExchanges=undefined;throw new Error('账户配置已变化，请重新检查');}
      this.accounts.clear();
      for(const exchange of this.sessionExchanges){const account=accounts.get(exchange);if(account)this.cacheAccount(exchange,account);}
      this.fundingWatch.clear();this.fundingChecked.clear();
      const previousStop=this.store.data.killSwitch;
      this.store.data.killSwitch=false;
      try{this.store.log('info','用户已在本机启动实盘自动策略；本次许可仅对当前进程会话有效');}
      catch(error){this.store.data.killSwitch=previousStop;this.autoEnabled=false;this.sessionLivePermission=false;this.sessionExchanges=undefined;this.accounts.clear();throw error;}
      this.autoEnabled=true;
      return {...report,executionUnlocked:true};
    });
  }
  snapshot(x:string,b:string){const pushed=this.adapters.find(a=>a.id===x)?.getExecutionSnapshot?.(b);const snapshot=pushed??this.snapshots.find(s=>s.exchange===x&&s.base===b);if(snapshot)this.overlayNativeSnapshotFee(snapshot);return snapshot;}
  /** Same object identity is retained for Execution's final quote identity check. Only native fee metadata is overlaid. */
  private overlayNativeSnapshotFee(snapshot:MarketSnapshot){
    type NativeFee={takerFeeRate?:number;takerFeeAt?:number;takerFeeSource?:'exchange';makerFeeRate?:number;makerFeeAt?:number;makerFeeSource?:'exchange'|'simulation'};
    const now=Date.now(),row=this.observedPortfolio?.exchanges.find(venue=>venue.exchange===snapshot.exchange),target=snapshot as MarketSnapshot&NativeFee;
    const adapter=this.adapters.find(value=>value.id===snapshot.exchange);
    try{
      const reference=adapter?.referenceTradingFee?.(snapshot.symbol)??row?.positions.find(position=>position.symbol===snapshot.symbol&&position.base===snapshot.base)?.feeReference;
      if(reference)target.feeReference={...reference};else delete target.feeReference;
    }catch{delete target.feeReference;}
    const candidates=row?.status==='ready'&&Number.isFinite(row.requestedAt)&&row.requestedAt!<=now&&now-row.requestedAt!<=this.observedPortfolio!.maxAgeMs
      ?row.positions.filter(position=>position.symbol===snapshot.symbol&&position.base===snapshot.base&&position.quantity>0).map(position=>position as typeof position&NativeFee).filter(position=>
        position.takerFeeSource==='exchange'&&Number.isFinite(position.takerFeeRate)&&position.takerFeeRate!>=0&&position.takerFeeRate!<=.01&&
        Number.isFinite(position.takerFeeAt)&&position.takerFeeAt!<=now&&now-position.takerFeeAt!<=120000):[];
    let cached:NativeFee|undefined;
    try{cached=this.adapters.find(adapter=>adapter.id===snapshot.exchange)?.cachedTradingFee?.(snapshot.symbol);}catch{/* A display fee cache failure never creates a financial action. */}
    const validCached=cached?.takerFeeSource==='exchange'&&Number.isFinite(cached.takerFeeRate)&&cached.takerFeeRate!>=0&&cached.takerFeeRate!<=.01&&
      Number.isFinite(cached.takerFeeAt)&&cached.takerFeeAt!<=now&&now-cached.takerFeeAt!<=120000;
    const rates=new Set(candidates.map(candidate=>candidate.takerFeeRate));
    if(candidates.length&&rates.size===1||validCached){
      const chosen=validCached?cached!:candidates[0];
      target.takerFeeRate=chosen.takerFeeRate;target.takerFeeAt=validCached?chosen.takerFeeAt:Math.min(...candidates.map(candidate=>candidate.takerFeeAt!));target.takerFeeSource='exchange';this.overlaidSnapshotFees.add(snapshot);
      const maker=validCached?nativeMakerFeeRate(cached,now):nativeMakerFeeRate(candidates[0],now);
      const makers=validCached?[]:candidates.map(value=>nativeMakerFeeRate(value,now));
      if(maker!==undefined&&(validCached||makers.every(value=>value===maker))){
        target.makerFeeRate=maker;target.makerFeeAt=validCached?chosen.makerFeeAt:Math.min(...candidates.map(value=>value.makerFeeAt!));target.makerFeeSource='exchange';
      }else{delete target.makerFeeRate;delete target.makerFeeAt;delete target.makerFeeSource;}
    }else if(this.overlaidSnapshotFees.has(snapshot)){delete target.takerFeeRate;delete target.takerFeeAt;delete target.takerFeeSource;
      delete target.makerFeeRate;delete target.makerFeeAt;delete target.makerFeeSource;this.overlaidSnapshotFees.delete(snapshot);}
  }
  adapter(x:string){const a=this.adapters.find(a=>a.id===x);if(!a)throw new Error('交易所未启用');return a;}
  exclusive<T>(fn:()=>Promise<T>):Promise<T>{const result=this.queue.then(fn,fn);this.queue=result.then(()=>undefined,()=>undefined);return result;}
  halt(reason:string,base?:string){
    if(base){this.coinAttention(base,reason);return;}
    this.store.data.killSwitch=true;this.autoEnabled=false;this.store.log('error',reason);
  }
  async start(){this.running=true;this.stopping=false;this.bindRealtime();this.updateRealtimeFocus();await this.tick();this.schedule();if(this.usesFundingStatistics())this.publicFundingMonitor().start();}
  private schedule(){
    if(this.stopping)return;
    const timer=setTimeout(()=>{
      if(this.timer===timer)this.timer=undefined;
      // Observe the returned chain too: finally alone creates another rejected promise.
      void Promise.resolve().then(()=>this.tick()).catch(error=>this.tickFailed(error))
        .then(()=>this.schedule()).catch(error=>this.tickFailed(error));
    },this.config.pollIntervalMs);
    this.timer=timer;
  }
  async stop(){try{this.pendingManualPermission?.restore();this.startGeneration++;this.stopping=true;this.running=false;this.fundingExitStability.clear();this.fundingEntryStability.clear();this.fundingReadRetry.clear();this.manualEntries.stop();if(this.timer)clearTimeout(this.timer);if(this.realtimeTimer)clearTimeout(this.realtimeTimer);if(this.realtimeProfitTimer)clearTimeout(this.realtimeProfitTimer);for(const timer of this.realtimeProfitRetryTimers.values())clearTimeout(timer);this.realtimeProfitRetryTimers.clear();for(const timer of this.externalExposureRetryTimers.values())clearTimeout(timer);this.externalExposureRetryTimers.clear();if(this.realtimeWarmTimer)clearTimeout(this.realtimeWarmTimer);this.realtimeProfitPending.clear();this.realtimePrepared.clear();await this.publicMonitor?.stop();await Promise.all([this.execution.drainMakerCloses(),this.execution.drainIocProfitCloses(),Promise.allSettled([...this.pendingCloseReadWorkers.values(),...this.holdingExitReadWorkers.values(),...this.externalExposureWorkers.values()])]);await this.queue;await Promise.allSettled(this.adapters.map(a=>a.close()));this.store.save();}finally{this.diagnostic(()=>this.store.operations.dispose());}}
  private bindRealtime(){for(const adapter of this.adapters)adapter.startRealtime?.(quote=>{
    if(this.stopping||!this.adapters.includes(adapter)||quote.exchange!==adapter.id||!quoteIsFresh(quote,this.config))return;
    const prior=this.snapshots.find(s=>s.exchange===quote.exchange&&s.base===quote.base);
    if(prior&&quoteObservedAt(prior)>quoteObservedAt(quote))return;
    this.snapshots=this.snapshots.filter(s=>s.exchange!==quote.exchange||s.base!==quote.base).concat(quote);
    this.unavailableSnapshots.delete(this.snapshotKey(quote.exchange,quote.base));this.lastRealtimeQuoteAt=quoteObservedAt(quote);
    if(!this.realtimeTimer)this.realtimeTimer=setTimeout(()=>{this.realtimeTimer=undefined;this.onRealtimeSignal();},50);
  });}

  private updateRealtimeFocus(){
    const candidates=this.fundingCandidates(),held=this.actualPositionMarkets();
    for(const adapter of this.adapters){
      const owned=this.activePositions().filter(p=>p.long.exchange===adapter.id||p.short.exchange===adapter.id).map(p=>p.base);
      const watched=[...this.fundingWatch.values()].filter(w=>w.candidate.longExchange===adapter.id||w.candidate.shortExchange===adapter.id).map(w=>w.candidate.base);
      const ranked=candidates.filter(c=>c.longExchange===adapter.id||c.shortExchange===adapter.id).map(c=>c.base);
      adapter.setRealtimeBases?.([...new Set([...owned,...held.filter(p=>p.exchange===adapter.id).map(p=>p.base),...watched,...ranked,...this.config.symbols])].slice(0,24));
    }
  }
  /** This timer performs public reads even when automatic order submission is off. */





  private realtimePairFresh(opportunity:Opportunity,now=Date.now()){
    const pair=[this.snapshot(opportunity.longExchange,opportunity.base),this.snapshot(opportunity.shortExchange,opportunity.base)];
    return pair.every(s=>s?.bookTransport==='websocket'&&quoteIsFresh(s,this.config,now)&&now-quoteObservedAt(s)<=750)&&
      Math.abs(quoteObservedAt(pair[0]!)-quoteObservedAt(pair[1]!))<=Math.min(this.config.maxQuoteSkewMs,300);
  }
  private onRealtimeSignal(){
    if(this.stopping||!this.running)return;
    this.scheduleRealtimeProfitExits();
    this.lastRealtimeSignalAt=Date.now();this.opportunities=this.detailedOpportunities(this.lastRealtimeSignalAt);
    // Inspection/display stays active when auto mode is off. Only this explicit gate can enqueue a purchase.
    if(!this.autoEnabled||!this.liveUnlocked||this.store.data.killSwitch||this.credentialUpdatePending||this.hasPriorityCloseWork())return;
    this.scheduleRealtimeWarmup();
    if(this.realtimeQueued)return;
    const pendingManual=pendingManualEntryBases(this.store.data.manualEntryOperations??[]);
    const candidate=this.opportunities.find(o=>automaticEntryCandidateReady(o)&&!this.automaticProductRejectionUntil(o)&&!pendingManual.has(o.base)&&this.automaticEntryAttempts.ready(o.base)&&this.realtimePairFresh(o)&&!this.activePositions().some(p=>p.base===o.base));
    if(!candidate)return;
    const generation=this.startGeneration;this.realtimeQueued=true;
    void this.exclusive(async()=>{
      if(this.stopping||generation!==this.startGeneration||!this.autoEnabled||this.store.data.killSwitch||this.hasPriorityCloseWork())return;
      const latest=this.detailedOpportunities(Date.now()).find(o=>o.id===candidate.id);
      if(!latest||!automaticEntryCandidateReady(latest)||this.automaticProductRejectionUntil(latest)||pendingManualEntryBases(this.store.data.manualEntryOperations??[]).has(latest.base)||!this.automaticEntryAttempts.ready(latest.base)||!this.realtimePairFresh(latest))return;
      const proof=this.realtimePrepared.get(latest.id),context=proof&&proof.generation===generation&&proof.config===this.config&&proof.financialEpoch===this.financialEpoch&&
        proof.context.preflight&&Date.now()-proof.context.preflight.checkedAt<=8000?proof.context:undefined;
      // Cold pairs are prepared separately; a stale price signal must not become a delayed financial order.
      if(!context)return;
      try{await this.openInternal(latest.id,true,context);}catch(error){this.store.log('warn',`推送入场 ${latest.base} 已跳过：${safeMessage(error)}`);}
    }).catch(error=>this.tickFailed(error)).finally(()=>{this.realtimeQueued=false;});
  }
  /** A quote wakes held profit capture independently of the switch for new entries. */
  private makerRouteBlockReason(p:Position,long=this.snapshot(p.long.exchange,p.base),short=this.snapshot(p.short.exchange,p.base)):string|undefined {
    if(!this.execution.requiresMakerProfitClose(p))return;
    const selected=selectMakerCloseLeg(long,short);if(!selected)return;
    const adapter=this.adapters.find(value=>value.id===p[selected].exchange);
    if(adapter?.supportsMakerReduction?.()===true&&adapter.submitMakerReduction&&adapter.inspectMakerReduction&&
      adapter.validateMakerReduction&&adapter.cancelMakerReduction)return;
    return `${p[selected].exchange} 宽盘口腿尚未支持已验证的 Maker 减仓；保留仓位等待，未改用该腿 IOC`;
  }
  private realtimeProfitCandidate(p:Position):boolean {
    const exit=currentExitStrategyPosition(p,this.config);
    if(this.stopping||!this.running||this.credentialUpdatePending||this.maintenanceTradingPending||this.config.mode!=='live'||!this.liveUnlocked||
      this.store.data.killSwitch||!isPositionActive(p)||exit.entryPolicy!=='aligned'||exit.holdMode!=='adaptive'||p.manualCloseOnly||
      ![p.long.exchange,p.short.exchange].every(exchange=>this.hasLiveAccess(exchange))||
      this.execution.hasMakerClose(p)||this.execution.hasIocProfitClose(p)||
      this.pendingCloseReadWorkers.has(p.id)||this.holdingExitReadWorkers.has(p.id)||
      this.exitPendingCoin(p))return false;
    if(this.realtimeIocProfitTailCandidate(p))return true;
    if(this.realtimeMakerTailCandidate(p))return this.execution.makerCloseTailRetryAfter(p)<=Date.now();
    if(p.status==='attention'&&!this.store.data.orders.some(order=>order.positionId===p.id&&order.makerReduction?.activity==='terminal'&&
      order.makerReduction.bookedExecution===true&&!!order.result&&isTerminalOrderReceipt(order.request,order.result)))return false;
    if(this.execution.makerCloseRetryAfter(p)>Date.now()||this.makerRouteBlockReason(p))return false;
    if(p.status!=='open'&&!(['closing','attention'].includes(p.status)&&this.continuingClosePositions.has(p.id)&&
      p.closeRequestedAt!==undefined&&p.closeProfitRequired===true&&!p.closePauseReason))return false;
    const usable=(quote:MarketSnapshot|undefined)=>quote&&!this.unavailableSnapshots.has(this.snapshotKey(quote.exchange,p.base))&&
      ['online','degraded'].includes(this.health.find(health=>health.exchange===quote.exchange)?.status??'')?quote:undefined;
    // A legacy held remainder may not have its original basis persisted yet. Recover it on a
    // local copy before fee discovery; the normal serialized manager owns the eventual freeze.
    const valuation=p.profitExitNotionalUsd===undefined?{...p}:p;
    if(valuation!==p)freezeProfitExitNotional(valuation,this.store.data.orders);
    return alignedExitProfitsPass(valuation,assessBestOppositeProfitExit(this.economicsPosition(valuation),usable(this.snapshot(p.long.exchange,p.base)),
      usable(this.snapshot(p.short.exchange,p.base)),this.config,Date.now(),undefined,undefined,false),this.config);
  }
  private realtimeMakerTailCandidate(p:Position):boolean {
    return p.status==='closing'&&this.continuingClosePositions.has(p.id)&&p.closeRequestedAt!==undefined&&
      p.closeProfitRequired===true&&[p.long.exchange,p.short.exchange].every(exchange=>this.hasLiveAccess(exchange))&&
      this.execution.hasPendingMakerCloseTail(p);
  }
  private realtimeIocProfitTailCandidate(p:Position):boolean {
    return p.status==='closing'&&this.continuingClosePositions.has(p.id)&&p.closeRequestedAt!==undefined&&
      p.closeProfitRequired===true&&[p.long.exchange,p.short.exchange].every(exchange=>this.hasLiveAccess(exchange))&&
      this.execution.hasPendingIocProfitTail(p);
  }
  private realtimeProfitFeesMissing(p:Position,now=Date.now()):ExchangeId[] {
    const long=this.snapshot(p.long.exchange,p.base),short=this.snapshot(p.short.exchange,p.base);
    const maker=this.execution.requiresMakerProfitClose(p)&&this.execution.canUseMakerClose(p)?selectMakerCloseLeg(long,short):undefined;
    return [p.long,p.short].filter((leg,index)=>{
      const quote=index===0?long:short;
      return nativeTakerFeeRate(quote,now)===undefined||(maker===(index===0?'long':'short')&&nativeMakerFeeRate(quote,now)===undefined);
    }).map(leg=>leg.exchange);
  }
  private closeAccountsFresh(p:Position,now=Date.now()):boolean {
    const activity=Math.max(p.closeRequestedAt??0,p.closeAttemptedAt??0,...this.store.data.orders.filter(order=>order.positionId===p.id)
      .map(order=>Math.max(order.createdAt,order.result?.timestamp??0)));
    const scoped=this.realtimeProfitAccountProof(p);
    if(scoped)return [p.long,p.short].every(leg=>{
      const account=scoped.accounts.get(leg.exchange),at=account&&this.accountReadAt.get(account);
      return !!account&&Number.isFinite(at)&&at!>=activity&&at!<=now&&now-at!<=this.config.maxSnapshotAgeMs;
    });
    return [p.long,p.short].every(leg=>{
      const health=this.health.find(value=>value.exchange===leg.exchange),at=health?.accountUpdatedAt;
      return health?.accountStatus==='ready'&&Number.isFinite(at)&&at!>=activity&&at!<=now&&now-at!<=this.config.maxSnapshotAgeMs;
    });
  }
  /** A different contract's close cannot invalidate this one's cash or confirmed quantity budget. */
  private profitExitFinancialProof(p:Position):string {
    const instruments=new Set([p.long,p.short].map(leg=>`${leg.exchange}:${leg.symbol}`));
    const scope=(position:Position)=>({id:position.id,base:position.base,mode:position.mode,status:position.status,
      openedAt:position.openedAt,entryPolicy:position.entryPolicy,holdMode:position.holdMode,manualCloseOnly:position.manualCloseOnly,
      accountClosure:position.accountClosure,profitExitPolicy:position.profitExitPolicy,profitExitNotionalUsd:position.profitExitNotionalUsd,
      feesUsd:position.feesUsd,fundingUsd:position.fundingUsd,realizedSpreadPnlUsd:position.realizedSpreadPnlUsd,
      transferCostUsd:position.transferCostUsd,closeRequestedAt:position.closeRequestedAt,closeAttemptedAt:position.closeAttemptedAt,
      closeReason:position.closeReason,
      closePricing:position.closePricing,closeProfitRequired:position.closeProfitRequired,closePauseReason:position.closePauseReason,
      legs:[position.long,position.short].map(leg=>({...leg,markPrice:undefined,liquidationDistancePct:undefined}))});
    return JSON.stringify({position:scope(p),collisions:this.activePositions().filter(position=>position!==p&&
      [position.long,position.short].some(leg=>instruments.has(`${leg.exchange}:${leg.symbol}`))).map(scope),
      orders:this.store.data.orders.filter(order=>order.positionId===p.id||instruments.has(`${order.exchange}:${order.request.symbol}`))});
  }
  private realtimeProfitAccountProof(p:Position){
    const proof=this.realtimeProfitAccountProofs.get(p.id);
    if(proof?.financialProof!==this.profitExitFinancialProof(p))return;
    for(const [exchange,account] of proof.accounts){
      const origin=this.realtimeProfitAccountReadProofs.get(account),cached=this.accounts.get(exchange),readAt=this.accountReadAt.get(account),
        latestAt=cached&&(this.accountReadAt.get(cached)??this.health.find(health=>health.exchange===exchange)?.accountUpdatedAt);
      if(!origin||!cached||cached===account||(this.accountCacheRevision.get(exchange)??0)<=origin.cacheRevision||
        latestAt===undefined||readAt===undefined||latestAt<readAt)continue;
      const selected=(value:AccountState)=>JSON.stringify(value.positions.filter(row=>row.quantity>0&&[p.long,p.short]
        .some(leg=>leg.exchange===exchange&&leg.symbol===row.symbol)).map(row=>({symbol:row.symbol,side:row.side,quantity:row.quantity,
          positionId:row.positionId,positionOpenedAt:row.positionOpenedAt,entryPrice:row.entryPrice,marginMode:row.marginMode}))
        .sort((left,right)=>JSON.stringify(left).localeCompare(JSON.stringify(right))));
      if(selected(cached)!==selected(account))return;
    }
    return proof;
  }
  private readProfitExitAccount(adapter:ExchangeAdapter):Promise<AccountState>{
    const active=this.realtimeProfitAccountRequests.get(adapter);if(active)return active;
    const financialEpoch=this.financialEpoch,cacheRevision=this.accountCacheRevision.get(adapter.id)??0,
      config=this.config,generation=this.startGeneration;
    const request=this.readTradingAccount(adapter).then(account=>{
      if(this.stopping||this.credentialUpdatePending||this.config!==config||this.startGeneration!==generation||
        !this.adapters.includes(adapter)||!this.hasLiveAccess(adapter.id))throw new Error('平仓账户读取会话已变化，等待新的只读核验');
      this.realtimeProfitAccountReadProofs.set(account,{financialEpoch,cacheRevision});return account;
    });this.realtimeProfitAccountRequests.set(adapter,request);
    const clear=()=>{if(this.realtimeProfitAccountRequests.get(adapter)===request)this.realtimeProfitAccountRequests.delete(adapter);};
    void request.then(clear,clear);return request;
  }
  /** Only this process's existing close registry may use a Maker completion to request another batch. */
  private scheduleRealtimeProfitExits(settled?:Position,delayMs=0):void {
    if(this.stopping||!this.running)return;
    const positions=settled?[settled]:this.activePositions();
    for(const p of positions){
      if(this.realtimeProfitPreparing.has(p.id))continue;
      const tail=this.realtimeMakerTailCandidate(p)||this.realtimeIocProfitTailCandidate(p),retryAt=Math.max(this.execution.iocProfitCloseRetryAfter(p),
        tail?Math.max(this.execution.makerCloseTailRetryAfter(p),delayMs>=500?Date.now()+delayMs:0):settled?this.execution.makerCloseRetryAfter(p):0);
      if(tail&&this.realtimeProfitRetryTimers.has(p.id))continue;
      if(retryAt>Date.now()){
        if(!this.realtimeProfitRetryTimers.has(p.id))this.realtimeProfitRetryTimers.set(p.id,setTimeout(()=>{
          this.realtimeProfitRetryTimers.delete(p.id);this.scheduleRealtimeProfitExits(p);
        },Math.max(50,retryAt-Date.now())));
        continue;
      }
      if(this.realtimeProfitCandidate(p)){
        const last=this.store.data.orders.filter(order=>order.positionId===p.id&&order.request.reduceOnly).at(-1);
        if(!tail&&!settled&&p.status==='closing'&&p.closeAttemptedAt!==undefined&&Date.now()-p.closeAttemptedAt<this.config.pollIntervalMs&&
          !(last?.result&&last.result.filledQuantity>0))continue;
        if(settled)this.realtimeProfitSettled.add(p.id);
        this.realtimeProfitPending.add(p.id);if(!this.realtimeProfitSignalAt.has(p.id))this.realtimeProfitSignalAt.set(p.id,Date.now());
      }else if(p.status==='open'||!isPositionActive(p))this.realtimeProfitSignalAt.delete(p.id);
    }
    if(!this.realtimeProfitPending.size||this.realtimeProfitTimer||this.realtimeProfitQueued)return;
    this.realtimeProfitTimer=setTimeout(()=>{
      this.realtimeProfitTimer=undefined;void this.runRealtimeProfitExits().catch(error=>this.tickFailed(error));
    },delayMs);
  }
  private async runRealtimeProfitExits():Promise<void> {
    if(this.realtimeProfitQueued||this.stopping||!this.running)return;
    this.realtimeProfitQueued=true;
    const ids=[...this.realtimeProfitPending].filter(id=>!this.realtimeProfitPreparing.has(id))
      .map(id=>({id,settled:this.realtimeProfitSettled.delete(id)}));this.realtimeProfitPending.clear();
    for(const {id} of ids)this.realtimeProfitPreparing.add(id);
    this.realtimeProfitQueued=false;
    const config=this.config,generation=this.startGeneration;
    const current=()=>this.running&&!this.stopping&&!this.credentialUpdatePending&&this.config===config&&generation===this.startGeneration;
    try{
      const results=await Promise.allSettled(ids.map(async({id,settled})=>{let tailPosition:Position|undefined;try{
        const p=this.store.data.positions.find(position=>position.id===id);
        if(!p||!current()||!this.realtimeProfitCandidate(p))return;
        const tail=this.realtimeMakerTailCandidate(p)||this.realtimeIocProfitTailCandidate(p);if(tail)tailPosition=p;
        const last=this.store.data.orders.filter(order=>order.positionId===id&&order.request.reduceOnly).at(-1);
        if(!tail&&!settled&&p.status==='closing'&&p.closeAttemptedAt!==undefined&&Date.now()-p.closeAttemptedAt<this.config.pollIntervalMs&&
          !(last?.result&&last.result.filledQuantity>0))return;
        const financialProof=this.profitExitFinancialProof(p),
          quantities=[p.long.quantity,p.short.quantity],requestAt=p.closeRequestedAt;
        // Exact contract fees are prepared only after the unchanged opposite-1 trigger qualifies.
        // GET waits stay outside the financial queue and neither create nor restore an exit intent.
        const missing=tail?[]:this.realtimeProfitFeesMissing(p);
        if(missing.length){
          if(Date.now()<(this.realtimeProfitFeeRetryAt.get(id)??0))return;
          await Promise.all(missing.map(exchange=>{
            const symbol=this.snapshot(exchange,p.base)?.symbol;
            return symbol?this.refreshTradingFee(this.adapter(exchange),symbol):Promise.resolve();
          }));
          if(!current()||financialProof!==this.profitExitFinancialProof(p)||!this.store.data.positions.includes(p)||
            p.long.quantity!==quantities[0]||p.short.quantity!==quantities[1]||p.closeRequestedAt!==requestAt||!this.realtimeProfitCandidate(p))return;
          if(this.realtimeProfitFeesMissing(p).length){this.realtimeProfitFeeRetryAt.set(id,Date.now()+15000);return;}
          this.realtimeProfitFeeRetryAt.delete(id);
        }
        let accounts:Array<{exchange:ExchangeId;account:AccountState}>|undefined;
        if(p.status==='closing'||p.status==='attention'||
          p.closeRequestedAt!==undefined&&this.continuingClosePositions.has(p.id)){
          const reads=await Promise.allSettled([...new Set([p.long.exchange,p.short.exchange])].map(async exchange=>({
            exchange,account:await this.readProfitExitAccount(this.adapter(exchange))})));
          if(reads.some(read=>read.status==='rejected'))return;
          accounts=reads.flatMap(read=>read.status==='fulfilled'?[read.value]:[]);
          if(!current()||financialProof!==this.profitExitFinancialProof(p))return;
          this.realtimeProfitAccountProofs.set(id,{financialProof,accounts:new Map(accounts.map(row=>[row.exchange,row.account]))});
          if(!this.realtimeProfitAccountProof(p)||!this.closeAccountsFresh(p)||!this.accountMatchesPosition(p))return;
        }
        let makerPreparation:MakerClosePreparation|undefined;
        if(!tail&&this.execution.requiresMakerProfitClose(p))try{
          this.diagnostic(()=>{
            const previous=this.store.operations.current(p.id);
            const operationId=previous&&previous.kind!=='entry'?previous.id:this.beginOperation({positionId:p.id,base:p.base,
              origin:'automatic',kind:'profit-exit',protocol:'maker-ioc',target:{long:p.long.quantity,short:p.short.quantity},
              signalObservedAt:this.realtimeProfitSignalAt.get(p.id)});
            if(operationId)this.store.operations.stage(operationId,'preparationStartedAt');
          });
          makerPreparation=await this.execution.prepareMakerClose(p);
        }
        catch(error){
          // No durable order intent exists at this GET/parameter stage. A transient preflight cannot stop other coins.
          // Disk failures still reach the original persistence stop rather than being hidden as network waits.
          if(this.isPersistenceFailure(error))throw error;
          this.diagnostic(()=>{
            const operation=this.store.operations.current(p.id);
            if(operation?.kind==='profit-exit')this.store.operations.attemptNotSent(operation.id,'maker-preflight-not-sent',safeMessage(error));
          });
          if(current()&&financialProof===this.profitExitFinancialProof(p)&&this.store.data.positions.includes(p)){
            const diagnosis=error instanceof MakerClosePreflightError?error.message:safeMessage(error);
            const reason=`Maker 提交前核验未通过：${diagnosis}；等待重新准备，本轮未创建委托`;p.riskReasons=[reason];
            const now=Date.now(),last=this.realtimeProfitPreparationFailureAt.get(id);
            if(last===undefined||now-last>=60_000){this.realtimeProfitPreparationFailureAt.set(id,now);this.persistObservation(()=>this.store.log('warn',`${p.base} ${reason}`,id));}
          }
          return;
        }
        if(!tail&&this.execution.requiresMakerProfitClose(p)&&!makerPreparation)return;
        await this.exclusive(async()=>{
          if(!current()||financialProof!==this.profitExitFinancialProof(p)||!this.store.data.positions.includes(p)||
            p.long.quantity!==quantities[0]||p.short.quantity!==quantities[1]||p.closeRequestedAt!==requestAt||!this.realtimeProfitCandidate(p))return;
          if(accounts){
            // Publishing a whole old account after another contract's action would resurrect stale entry balances.
            // The unchanged selected instrument may still use its own fresh native quantity evidence.
            if(!this.realtimeProfitAccountProof(p))return;
            for(const {exchange,account} of accounts)if(this.realtimeProfitAccountReadProofs.get(account)?.financialEpoch===this.financialEpoch)
              this.cacheAccount(exchange,account);
            this.realtimeProfitAccountProofs.set(id,{financialProof,accounts:new Map(accounts.map(row=>[row.exchange,row.account]))});
          }
          try{
            if(accounts&&(!this.realtimeProfitAccountProof(p)||!this.closeAccountsFresh(p)||!this.accountMatchesPosition(p)))return;
            if(!tail&&this.realtimeProfitFeesMissing(p).length)return;
            await this.managePosition(p,Date.now(),true,makerPreparation);this.persistObservation(()=>this.store.save());
          }finally{this.realtimeProfitAccountProofs.delete(id);}
        });
      }finally{
        this.realtimeProfitAccountProofs.delete(id);
        this.realtimeProfitPreparing.delete(id);
        if(tailPosition&&current()&&(this.realtimeMakerTailCandidate(tailPosition)||this.realtimeIocProfitTailCandidate(tailPosition)))this.scheduleRealtimeProfitExits(tailPosition,500);
      }}));
      for(const result of results)if(result.status==='rejected')this.tickFailed(result.reason);
    }catch(error){this.tickFailed(error);}
    finally{
      this.realtimeProfitQueued=false;
      if(current()&&this.realtimeProfitPending.size&&!this.realtimeProfitTimer)this.realtimeProfitTimer=setTimeout(()=>{
        this.realtimeProfitTimer=undefined;void this.runRealtimeProfitExits().catch(error=>this.tickFailed(error));
      },50);
    }
  }
  private scheduleRealtimeWarmup(){
    if(this.realtimeWarmRunning||this.realtimeWarmTimer||!this.autoEnabled||this.stopping||this.hasPriorityCloseWork())return;
    this.realtimeWarmTimer=setTimeout(()=>{this.realtimeWarmTimer=undefined;void this.warmRealtimeEntries().catch(error=>this.tickFailed(error));},0);
  }
  private async warmRealtimeEntries(){
    if(this.realtimeWarmRunning||!this.autoEnabled||!this.liveUnlocked||this.stopping||this.store.data.killSwitch||this.hasPriorityCloseWork())return;
    this.realtimeWarmRunning=true;const generation=this.startGeneration,config=this.config;
    try{
      const now=Date.now();
      for(const [key,proof] of this.realtimePrepared)if(proof.generation!==generation||proof.config!==config||proof.financialEpoch!==this.financialEpoch||now-(proof.context.preflight?.checkedAt??0)>8000)this.realtimePrepared.delete(key);
      for(const [key,at] of this.realtimePrepareFailedAt)if(now-at>15000)this.realtimePrepareFailedAt.delete(key);
      const candidates=this.detailedOpportunities(now).filter(o=>o.expectedFundingUsd>0&&
        !this.automaticProductRejectionUntil(o,now)&&
        o.fundingEntryStability?.passes===true&&
        [o.longExchange,o.shortExchange].every(x=>this.hasLiveAccess(x)&&quoteIsFresh(this.snapshot(x,o.base),config,now))&&
        !this.coinExclusions().some(c=>c.base===coinBase(o.base))&&!this.realtimePrepareFailedAt.has(o.id)&&
        now-(this.realtimePrepared.get(o.id)?.context.preflight?.checkedAt??0)>=6000)
        .sort((a,b)=>Number(automaticEntryCandidateReady(b)&&this.realtimePairFresh(b,now))-
          Number(automaticEntryCandidateReady(a)&&this.realtimePairFresh(a,now))||
          Number(b.eligible&&this.realtimePairFresh(b,now))-Number(a.eligible&&this.realtimePairFresh(a,now))||b.expectedFundingUsd-a.expectedFundingUsd).slice(0,1);
      for(const o of candidates){
        const old=this.realtimePrepared.get(o.id);if(old?.generation===generation&&old.context.preflight&&Date.now()-old.context.preflight.checkedAt<6000)continue;
        const ensure=()=>{if(this.stopping||config!==this.config||generation!==this.startGeneration||!this.autoEnabled||this.store.data.killSwitch||this.credentialUpdatePending)throw new ManualEntryCancelled('自动入场预备已取消');};
        try{
          const epoch=this.financialEpoch,intent=JSON.stringify(this.store.data.orders.filter(order=>order.request.base===o.base));
          const ensurePreparation=()=>{ensure();if(epoch!==this.financialEpoch||this.hasPriorityCloseWork()||
            this.coinExclusions().some(coin=>coin.base===coinBase(o.base))||
            JSON.stringify(this.store.data.orders.filter(order=>order.request.base===o.base))!==intent)
            throw new ManualEntryCancelled('资金或平仓状态已变化，自动入场预备已取消');};
          ensurePreparation();const exchanges=[o.longExchange,o.shortExchange],symbols=new Map<ExchangeId,string>();
          for(const x of exchanges){const symbol=this.snapshot(x,o.base)?.symbol;if(!symbol)throw new Error('合约未就绪');symbols.set(x,symbol);}
          // These are GET-only proofs. Waiting for a new entry cannot hold up already-confirmed Maker cash.
          const accountStarted=Date.now(),reads=await Promise.all(exchanges.map(x=>this.readTradingAccount(this.adapter(x))));ensurePreparation();
          const accounts=new Map(exchanges.map((x,i)=>[x,reads[i]]));
          for(const account of accounts.values()){if(account.positions.some(p=>coinBase(p.base)===coinBase(o.base)&&p.quantity>0))throw new Error('该币已有账户仓位');if(account.freeUsd<config.orderNotionalUsd/config.leverage)throw new Error('合约可用保证金不足');}
          await Promise.all(exchanges.map(x=>this.adapter(x).inspectTrading?.(symbols.get(x)!,config.leverage)));ensurePreparation();
          await this.exclusive(async()=>{
            ensurePreparation();
            for(const [x,account] of accounts)if(!this.cacheAccount(x,account))throw new Error('账户预备结果已过期或已有更新结果');
            for(const x of exchanges)if(this.snapshot(x,o.base)?.symbol!==symbols.get(x))throw new Error('预备合约身份已变化');
            const ready=await Promise.allSettled(exchanges.map(x=>{ensurePreparation();return this.adapter(x).prepareTrading(symbols.get(x)!,config.leverage);}));ensurePreparation();
            for(const result of ready)if(result.status==='rejected')throw result.reason;
            this.realtimePrepared.set(o.id,{generation,config,financialEpoch:epoch,context:{generation,ensure,stage:()=>{},tradingPrepared:true,preflight:{accounts,symbols,checkedAt:accountStarted}}});
          });
        }catch{this.realtimePrepared.delete(o.id);this.realtimePrepareFailedAt.set(o.id,Date.now());}
      }
    }finally{this.realtimeWarmRunning=false;if(this.autoEnabled&&!this.stopping)this.realtimeWarmTimer=setTimeout(()=>{this.realtimeWarmTimer=undefined;void this.warmRealtimeEntries().catch(error=>this.tickFailed(error));},2000);}
  }
  private hasPriorityCloseWork():boolean{
    return this.pendingCloseReadWorkers.size>0||this.holdingExitReadWorkers.size>0||this.realtimeProfitPreparing.size>0||this.realtimeProfitPending.size>0||this.activePositions().some(position=>
      this.execution.hasMakerClose(position)||this.execution.hasIocProfitClose(position)||this.execution.hasPendingMakerCloseTail(position)||
      this.execution.hasPendingIocProfitTail(position)||this.realtimeProfitCandidate(position));
  }
  private usesFundingStatistics(){return this.config.dataSource==='public'&&Boolean(this.options.fundingStatistics);}
  private paperFeeOnly(){return isFeeOnly(this.config);}
  private fundingCandidates(now=Date.now()):FundingCandidate[]{
    if(!this.usesFundingStatistics())return [];
    try{return calculateFundingCandidates(this.options.fundingStatistics!(),this.config,now);}
    catch{return [];}
  }
  private snapshotKey(exchange:ExchangeId,base:string){return `${exchange}:${base}`;}

  /** The market page observes the same account, contract, cooldown and order
   * evidence used for entry. It cannot promote a statistics-only candidate. */

  private actualPositionMarkets(){
    return (this.observedPortfolio?.exchanges??[]).filter(row=>this.config.exchanges.includes(row.exchange)).flatMap(row=>
      row.positions.filter(position=>Number.isFinite(position.quantity)&&position.quantity>0).map(position=>({exchange:row.exchange,base:position.base,symbol:position.symbol})));
  }



  private publicProtectedBases(){return new Set([...this.fundingWatch.keys(),...this.activePositions().map(position=>position.base),...this.coinExclusions().map(coin=>coin.base),...this.actualPositionMarkets().map(position=>position.base)]);}
  private canObserveTradingCandidate(candidate:FundingCandidate){
    return this.config.mode!=='live'||[candidate.longExchange,candidate.shortExchange].every(exchange=>
      this.liveEnvironment.exchanges.some(venue=>venue.exchange===exchange&&venue.supported&&venue.credentialsConfigured));
  }
  private fundingVerificationPriorities(candidates:readonly FundingCandidate[],now:number){
    return buildFundingVerificationPriorities(candidates,{config:this.config,opportunities:this.opportunities??[],
      prefer:candidate=>this.canObserveTradingCandidate(candidate),
      ready:opportunity=>(opportunity.eligible||opportunity.entryReady===true)&&
        quoteIsFresh(this.snapshot(opportunity.longExchange,opportunity.base),this.config,now)&&
        quoteIsFresh(this.snapshot(opportunity.shortExchange,opportunity.base),this.config,now)});
  }
  private publicFundingMonitor():PublicFundingMonitor {
    this.publicMonitor??=new PublicFundingMonitor({config:()=>this.config,candidates:()=>this.fundingCandidates(),snapshots:()=>this.snapshots,
      protectedBases:()=>this.publicProtectedBases(),
      readyBases:()=>new Set(this.opportunities.filter(opportunity=>opportunity.eligible||opportunity.entryReady===true).map(opportunity=>opportunity.base)),
      prefer:candidate=>this.canObserveTradingCandidate(candidate),
      verificationPriorities:(candidates,now)=>this.fundingVerificationPriorities(candidates,now),
      adapters:this.options.publicMonitoringAdapterFactory??createPublicMonitoringAdapters,deadlineMs:this.options.publicSnapshotDeadlineMs,
      publish:async(quotes,config)=>{
        if(this.stopping||this.config!==config)return;
        const now=Date.now(),protectedBases=this.publicProtectedBases();let changed=false;
        for(const quote of quotes){
          this.adapters.find(a=>a.id===quote.exchange)?.seedRealtimeSnapshot?.(quote);
          // Main position/watch reads have their own clients and always win. The
          // scanner cannot resurrect a stale batch or replace a newer quote.
          if(protectedBases.has(quote.base)||!quoteIsFresh(quote,config,now))continue;
          const prior=this.snapshot(quote.exchange,quote.base);if(prior&&quoteObservedAt(prior)>=quoteObservedAt(quote))continue;
          this.snapshots=this.snapshots.filter(snapshot=>snapshot.exchange!==quote.exchange||snapshot.base!==quote.base).concat(quote);
          this.unavailableSnapshots.delete(this.snapshotKey(quote.exchange,quote.base));changed=true;
          const health=this.health.find(venue=>venue.exchange===quote.exchange);
          if(health){health.lastSuccess=Math.max(health.lastSuccess,quoteObservedAt(quote));if(health.status==='offline'||health.status==='connecting')health.status='degraded';}
        }
        if(changed){this.recordSpreadObservations(now);this.pruneSnapshots(now);this.opportunities=this.detailedOpportunities(now);this.updateRealtimeFocus();void this.refreshEntryContractPreviews().catch(error=>this.tickFailed(error));}
      }});
    return this.publicMonitor;
  }
  autoVerificationStatus():FundingAutoVerification|undefined {
    if(!this.usesFundingStatistics())return undefined;
    return {...this.publicFundingMonitor().status(),enabled:this.running&&!this.stopping};
  }
  private fundingWatchDurationMs(manual=false){
    // A tick includes the market read as well as the configured poll delay. Give slow,
    // valid feeds time to reach the historical sample count before rotating the coin.
    const requested=this.options.publicSnapshotDeadlineMs;
    const readMs=Math.min(requested!==undefined&&Number.isFinite(requested)&&requested>0?requested:10000,this.config.maxSnapshotAgeMs/2);
    if(this.config.entryPolicy==='aligned'&&!manual)return Math.max(15000,2*(this.config.pollIntervalMs+readMs));
    return Math.max(manual?180000:30000,this.config.spreadMinSpanSec*1000,
      (this.config.spreadMinSamples+1)*(this.config.spreadSampleIntervalSec*1000+this.config.pollIntervalMs+readMs));
  }
  private detailedPlan(now:number):Map<ExchangeId,string[]>{
    const plan=new Map(this.adapters.map(a=>[a.id,[] as string[]]));
    const add=(exchange:ExchangeId,base:string)=>{const bases=plan.get(exchange);if(bases&&!bases.includes(base))bases.push(base);};
    // Native account holdings need current public funding/books even without a local strategy record or execution permission.
    // Observation only: adding a market never revives a historical record or grants position management.
    for(const position of this.actualPositionMarkets())add(position.exchange,position.base);
    if(!this.usesFundingStatistics()){
      for(const a of this.adapters)for(const base of this.config.symbols)add(a.id,base);
      return plan;
    }
    const occupied=this.coinExclusions(),activeBases=new Set(occupied.map(p=>p.base));
    // Existing exposure always takes priority and is never evicted by a new funding candidate.
    for(const p of this.activePositions())for(const leg of [p.long,p.short])add(leg.exchange,p.base);
    for(const coin of occupied)for(const exchange of coin.exchanges??[])add(exchange,coin.base);
    const candidates=this.fundingCandidates(now);
    const canExecute=(candidate:FundingCandidate)=>this.canObserveTradingCandidate(candidate);
    const watchMs=this.fundingWatchDurationMs();
    // Public observation is independent of account authorization and existing
    // holdings. Execution availability later prevents duplicate or unauthorized entries.
    const venuesByBase=new Map<string,Set<ExchangeId>>();
    for(const candidate of candidates){
      const venues=venuesByBase.get(candidate.base)??new Set<ExchangeId>();
      venues.add(candidate.longExchange);venues.add(candidate.shortExchange);venuesByBase.set(candidate.base,venues);
    }
    const venues=(c:FundingCandidate)=>[...new Set([c.longExchange,c.shortExchange,...(venuesByBase.get(c.base)??[])])];
    const addCandidate=(c:FundingCandidate)=>{for(const exchange of venues(c))add(exchange,c.base);};
    // Holdings already own their actual venue legs above. Expanding an occupied
    // coin to every venue wastes public reads and cannot create another entry.
    // Income rank owns four slots; two other coins rotate for discovery. Fairness
    // timestamps must not send fee-negative routes ahead of profitable funding.
    const scheduled=scheduleFundingWatches({candidates,watched:this.fundingWatch,checked:this.fundingChecked,
      excludedBases:activeBases,now,durationMs:watchMs,limit:FUNDING_WATCH_LIMIT,discoverySlots:2,
      ranking:this.config.mode==='live'||this.config.entryPolicy==='aligned'?'gross-funding':'after-fees',preferCore:canExecute,
      verificationPriorities:this.fundingVerificationPriorities(candidates,now),
      readyBases:new Set((this.opportunities??[]).filter(opportunity=>(opportunity.eligible||opportunity.entryReady===true)&&
        quoteIsFresh(this.snapshot(opportunity.longExchange,opportunity.base),this.config,now)&&quoteIsFresh(this.snapshot(opportunity.shortExchange,opportunity.base),this.config,now)).map(opportunity=>opportunity.base)),
      canFit:(candidate,selected)=>venues(candidate).every(exchange=>{
        const held=plan.get(exchange);if(!held)return false;
        // The six discovery places are separate from existing exposure. Seven
        // held coins must not starve all six new-opportunity observation places.
        const bases=new Set<string>();
        for(const watch of selected.values())if(venues(watch.candidate).includes(exchange))bases.add(watch.candidate.base);
        return bases.has(candidate.base)||bases.size<FUNDING_WATCH_LIMIT;
      })});
    this.fundingWatch=scheduled.watched;this.fundingChecked=scheduled.checked;
    for(const watch of this.fundingWatch.values())addCandidate(watch.candidate);
    // These are only fairness timestamps, not historical market data.
    if(this.fundingChecked.size>20000)for(const [id,at] of this.fundingChecked)if(now-at>3600000)this.fundingChecked.delete(id);
    // An unused venue still gets one real public quote for connection health, within the same budget.
    for(const a of this.adapters)if(!plan.get(a.id)!.length&&this.config.symbols[0])add(a.id,this.config.symbols[0]);
    return plan;
  }
  private async acquireSnapshots(adapter:ExchangeAdapter,bases:string[]):Promise<MarketSnapshot[]>{
    if(this.config.dataSource!=='public')return adapter.fetchSnapshots(bases);
    // Cancel this logical public read at its original deadline. Until the native
    // work actually settles, further ticks still skip it instead of overlapping.
    if(this.publicSnapshotRequests.has(adapter.id))throw new PublicSnapshotBusy();
    const symbols=[...bases];
    const configured=this.options.publicSnapshotDeadlineMs;
    const requested=configured!==undefined&&Number.isFinite(configured)&&configured>0?configured:10000;
    const deadline=Math.max(1,Math.min(requested,this.config.maxSnapshotAgeMs/2));
    const controller=new AbortController(),context={deadlineAt:Date.now()+deadline,signal:controller.signal};
    const request=Promise.resolve().then(()=>adapter.fetchSnapshots(symbols,context));
    this.publicSnapshotRequests.set(adapter.id,request);
    const clearRequest=()=>{if(this.publicSnapshotRequests.get(adapter.id)===request)this.publicSnapshotRequests.delete(adapter.id);};
    void request.then(clearRequest,clearRequest);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      // Only the winner is returned to tick; a late batch can never publish stale quotes.
      return await Promise.race([request,new Promise<MarketSnapshot[]>((_,reject)=>{
        timer=setTimeout(()=>{controller.abort();reject(new PublicSnapshotTimeout());},deadline);
      })]);
    }finally{if(timer)clearTimeout(timer);}
  }
  /** Bound reads only; a timed-out financial write is never retried by this helper. */
  private async boundedPrivateRead<T>(a:ExchangeAdapter,kind:string,read:(context:PrivateReadContext)=>Promise<T>):Promise<T>{
    let requests=this.privateReadRequests.get(a);
    if(!requests){requests=new Map();this.privateReadRequests.set(a,requests);}
    if(requests.has(kind))throw kind==='account'?new AccountReadPending(a.id):new Error('该交易所上次只读请求尚未结束，保留结果未知并等待重试');
    const configured=this.options.privateReadDeadlineMs??8000,timeout=Number.isFinite(configured)&&configured>0?Math.min(configured,8000):8000;
    const context:PrivateReadContext={deadlineAt:Date.now()+timeout};
    const accountConfig=this.config,accountGeneration=this.startGeneration;
    const raw=Promise.resolve().then(async()=>{
      const requestedAt=Date.now(),value=await read(context);
      if(kind==='account'&&value&&typeof value==='object'&&!Array.isArray(value)){
        this.accountReadAt.set(value,requestedAt);
        this.accountReadSources?.set(value,{adapter:a,config:accountConfig,generation:accountGeneration});
      }
      return value;
    });requests.set(kind,raw);
    const clear=()=>{if(requests!.get(kind)===raw)requests!.delete(kind);};
    void raw.then(clear,clear);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([raw,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(kind==='account'?new PrivateReadTimeout(a.id):new Error('交易所只读请求超时，本轮已跳过；迟到结果不会更新账户或资金费')),timeout);})]);}
    finally{if(timer)clearTimeout(timer);}
  }
  private async readTradingAccount(a:ExchangeAdapter):Promise<AccountState>{
    const account=await this.boundedPrivateRead(a,'account',context=>a.fetchAccount(context));
    if(!accountCoins(account))throw new Error(`${a.id} 账户余额或持仓币种数据不完整`);
    const now=Date.now(),readAt=this.accountReadAt.get(account);
    if(readAt!==undefined&&(readAt>now||now-readAt>this.config.maxSnapshotAgeMs))throw new Error(`${a.id} 账户读取结果已过期，请等待新的只读核对`);
    return account;
  }
  /** Keep ownership through the actual native GET, including a logical deadline.
   * Late data is discarded by the original reader; it never extends a risk proof. */
  private async drainRiskRead<T>(adapter:ExchangeAdapter,key:string,call:()=>Promise<T>):Promise<T>{
    const operation=call(),raw=this.privateReadRequests.get(adapter)?.get(key);
    try{return await operation;}finally{if(raw)await raw.then(()=>undefined,()=>undefined);}
  }
  /** Scoped recovery waits for an existing poll, discards it, then requires its own fresh GET. */
  private async readScopedTradingAccount(a:ExchangeAdapter,ensure:()=>void):Promise<AccountState>{
    ensure();const pending=this.privateReadRequests.get(a)?.get('account');
    if(pending){
      const configured=this.options.privateReadDeadlineMs??8000,
        timeout=Number.isFinite(configured)&&configured>0?Math.min(configured,8000):8000;
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        await Promise.race([pending.then(()=>undefined,()=>undefined),new Promise<never>((_,reject)=>{
          timer=setTimeout(()=>reject(new Error('原账户只读请求仍未结束，未启动重叠读取或恢复管理')),timeout);
        })]);
      }finally{if(timer)clearTimeout(timer);}
      ensure();
    }
    const account=await this.readTradingAccount(a);ensure();return account;
  }
  private cacheAccount(exchange:ExchangeId,account:AccountState){
    const health=this.health.find(h=>h.exchange===exchange);
    const now=Date.now(),readAt=this.accountReadAt.get(account)??now;
    // Waiting for a financial queue does not refresh an earlier account proof.
    // A slower old read also cannot replace a newer accepted balance/holding snapshot.
    if(health?.accountUpdatedAt!==undefined&&readAt<health.accountUpdatedAt)return false;
    if(readAt>now||now-readAt>this.config.maxSnapshotAgeMs){this.accountReadFailed(exchange);return false;}
    this.accounts.set(exchange,account);
    this.accountCacheRevision.set(exchange,(this.accountCacheRevision.get(exchange)??0)+1);
    if(health){health.accountStatus='ready';health.accountError=undefined;health.accountUpdatedAt=readAt;health.balanceUsd=account.freeUsd;}
    this.confirmOperationAccounts(now);
    return true;
  }
  private accountReadFailed(exchange:ExchangeId,error?:unknown){
    this.accounts.delete(exchange);
    const health=this.health.find(h=>h.exchange===exchange);
    if(health){
      const reason=error===undefined?'':`；${accountReadDiagnostic(exchange,error,health.route==='proxy')}`;
      const message=`账户只读检查暂不可用，该所暂停新开仓；有效盘口仍可用于已确认仓位减仓${reason}`;
      const changed=health.accountStatus!=='error'||health.accountError!==message;
      delete health.balanceUsd;health.accountStatus='error';health.accountError=message;
      if(changed&&error!==undefined)this.persistObservation(()=>this.store.log('warn',`${exchange}：${message}`));
    }
  }
  private async refreshAdapter(a:ExchangeAdapter,bases:string[],includeAccount=true):Promise<boolean>{
    if(!bases.length&&(!includeAccount||this.config.mode!=='live'))return true;
    const config=this.config,generation=this.startGeneration,started=Date.now(),health=this.health.find(h=>h.exchange===a.id)!;
    // Start independent reads together. A private account error must never discard a valid book.
    const accountRead=includeAccount&&this.config.mode==='live'&&this.hasLiveAccess(a.id)?
      this.readTradingAccount(a).then(account=>({account,error:undefined}),error=>({account:undefined,error})):undefined;
    let marketReady=true;
    if(bases.length){
      try{
        const quotes=(await this.acquireSnapshots(a,bases)).filter(s=>s.exchange===a.id&&bases.includes(s.base));
        if(this.stopping||this.config!==config||this.startGeneration!==generation||!this.adapters.includes(a))return false;
        if(!quotes.length)throw new Error('EmptyMarketResponse');
        const received=new Set(quotes.map(s=>s.base));
        for(const base of bases){const key=this.snapshotKey(a.id,base);if(received.has(base))this.unavailableSnapshots.delete(key);else this.unavailableSnapshots.add(key);}
        this.snapshots=this.snapshots.filter(s=>s.exchange!==a.id||!received.has(s.base)).concat(quotes.map(quote=>{
          a.seedRealtimeSnapshot?.(quote);return a.getExecutionSnapshot?.(quote.base)??quote;
        }));
        const diagnostics=a.getDiagnostics?.()??[];
        health.status=received.size===bases.length&&!diagnostics.length?'online':'degraded';health.latencyMs=Date.now()-started;health.lastSuccess=Date.now();
        health.error=diagnostics.length?diagnostics.slice(0,3).map(d=>`${d.symbol}: ${d.message}`).join('；'):received.size===bases.length?undefined:'部分币种行情不可用';
        health.errorCode=undefined;health.retryAt=undefined;
        Object.assign(health,a.getNetworkStatus?.());
        this.errors.set(a.id,0);
        marketReady=bases.every(base=>!this.unavailableSnapshots.has(this.snapshotKey(a.id,base)));
      }catch(error){
        if(this.stopping||this.config!==config||this.startGeneration!==generation||!this.adapters.includes(a))return false;
        marketReady=false;
        for(const base of bases)if(!a.getExecutionSnapshot?.(base))this.unavailableSnapshots.add(this.snapshotKey(a.id,base));
        if(error instanceof PublicSnapshotBusy){
          // Waiting for one existing read is not a network failure or a reason
          // to reconnect. Never start a second request for the same client.
          health.errorCode='READ_IN_PROGRESS';health.error='上一批公共盘口读取尚未完成，正在等待；不会重复请求或重连';
        }else{
        const count=(this.errors.get(a.id)??0)+1;this.errors.set(a.id,count);
        const othersReady=this.snapshots.some(s=>s.exchange===a.id&&!bases.includes(s.base)&&
          !this.unavailableSnapshots.has(this.snapshotKey(a.id,s.base))&&quoteIsFresh(s,this.config));
        // A failed metadata batch cannot make a genuinely current requested WS
        // book offline. Its original book/funding clocks and later order guards still apply.
        const requestedBookReady=bases.some(base=>{const quote=a.getExecutionSnapshot?.(base);return quote?.exchange===a.id&&
          quote.base===base&&quote.bookTransport==='websocket'&&quoteIsFresh(quote,this.config);});
        health.status=othersReady||requestedBookReady?'degraded':'offline';health.latencyMs=Date.now()-started;
        const network=a.getNetworkStatus?.();Object.assign(health,network);
        const code=error instanceof PublicSnapshotTimeout?'TIMEOUT':network?.errorCode??classifyNetworkError(error,network?.route==='proxy');health.errorCode=code;
        // A logical batch deadline does not prove a socket reconnect. Only fixed
        // diagnostic templates are exposed; the original raw request still owns its read.
        health.error=error instanceof PublicSnapshotTimeout?'本轮公共行情读取预算已用完，等待原请求结束后自动重试':
          networkMessage(code as any)?.replace('自动重连','自动重试')??'公共行情读取失败，具体原因未确认';
        if(count===1)this.persistObservation(()=>this.store.log('warn',`${a.id}：${health.error}；本次请求的币种暂停新开仓`));
        // A public-quote outage must not flip healthy positions to 'attention': that state suspends exit management
        // until someone reconciles by hand. Stale or missing quotes already block entries and are handled per position
        // in managePositions, which resumes by itself when the feed recovers.
        if(count===this.config.maxApiErrors&&this.activePositions().some(p=>bases.includes(p.base)&&(p.long.exchange===a.id||p.short.exchange===a.id)))
          this.persistObservation(()=>this.store.log('warn',`${a.id} 连续 ${count} 次行情失败：持仓仍保留，行情恢复前不会执行依赖盘口的退出或开仓`));
        }
      }
    }
    if(accountRead){
      const result=await accountRead;
      if(this.stopping||this.config!==config||this.startGeneration!==generation||!this.adapters.includes(a))return false;
      if(result.account){if(this.cacheAccount(a.id,result.account))this.checkAccount(a.id,result.account);}
      else this.accountReadFailed(a.id,result.error);
    }else if(this.config.mode==='paper')health.balanceUsd=this.paperBalance(a.id);
    else if(includeAccount&&!this.hasLiveAccess(a.id))delete health.balanceUsd;
    return marketReady;
  }
  private async refreshExecutionSnapshots(base:string,exchanges:string[],requireNativeFees=true):Promise<void>{
    if(this.config.mode!=='live')return;
    const config=this.config,generation=this.startGeneration;
    const failureOf=(results:PromiseSettledResult<unknown>[])=>results.find(result=>result.status==='rejected'&&this.isPersistenceFailure(result.reason))??
      results.find(result=>result.status==='rejected');
    const preparations=await Promise.allSettled([...new Set(exchanges)].map(async exchange=>{
      this.assertLiveAccess(exchange as ExchangeId);
      const adapter=this.adapter(exchange);
      const ensureCurrent=()=>{
        if(this.stopping||this.credentialUpdatePending||this.config!==config||this.startGeneration!==generation||
          !this.adapters.includes(adapter)||!this.hasLiveAccess(adapter.id))
          throw new Error('执行读取会话已变化，本轮未更新旧账户或盘口');
      };
      const feeSymbol=this.snapshot(exchange,base)?.symbol;
      const feeRead=requireNativeFees&&feeSymbol?this.refreshTradingFee(adapter,feeSymbol):Promise.resolve();
      let reads=0;
      const readPublic=()=>{reads++;return this.boundedPrivateRead(adapter,`execution-book:${base}`,context=>adapter.fetchExecutionSnapshots!([base],context)).catch(error=>{
        if(selectedPublicBookReason(error)||error instanceof ExchangeNetworkError||this.isPersistenceFailure(error))throw error;
        // This public callsite also owns its read deadline/busy refusal, never an inferred raw cause.
        throw new SelectedPublicBookError(adapter.id,'read-failed');
      });};
      const publicRead=adapter.fetchExecutionSnapshots?readPublic().then(quotes=>({quotes,
        freshAtRead:quotes.find(s=>s.exchange===adapter.id&&s.base===base&&quoteIsFresh(s,config))}))
        :this.refreshAdapter(adapter,[base],false).then(ready=>({quotes:ready?[this.snapshot(adapter.id,base)!].filter(Boolean):[],
          freshAtRead:ready?this.snapshot(adapter.id,base):undefined}));
      const results=await Promise.allSettled([feeRead,publicRead]);
      const failure=failureOf(results);if(failure?.status==='rejected')throw failure.reason;
      const initial=(results[1] as PromiseFulfilledResult<{quotes:MarketSnapshot[];freshAtRead?:MarketSnapshot}>).value;
      ensureCurrent();
      let quote=initial.quotes.find(s=>s.exchange===adapter.id&&s.base===base);
      if(!quote||!initial.freshAtRead)throw new SelectedPublicBookError(adapter.id,quote?'not-fresh':'missing');
      const rules={symbol:quote.symbol,contractSize:quote.contractSize,quantityStep:quote.quantityStep,minQuantity:quote.minQuantity,minNotional:quote.minNotional};
      const sameRules=(current:MarketSnapshot)=>current.exchange===adapter.id&&current.base===base&&current.symbol===rules.symbol&&
        current.contractSize===rules.contractSize&&current.quantityStep===rules.quantityStep&&
        current.minQuantity===rules.minQuantity&&current.minNotional===rules.minNotional;
      const checkRules=(current:MarketSnapshot)=>{
        if(!sameRules(current))throw new Error('提交前合约或合法下单数量已变化，停止提交');
      };
      if(requireNativeFees){
        if(feeSymbol!==undefined&&quote.symbol!==feeSymbol)throw new Error('提交前合约或合法下单数量已变化，停止提交');
        if(feeSymbol===undefined)await this.refreshTradingFee(adapter,quote.symbol);
      }
      const currentQuote=()=>{
        ensureCurrent();
        const current=adapter.getExecutionSnapshot?.(base);
        if(current&&current.exchange===adapter.id&&current.base===base){checkRules(current);if(quoteIsFresh(current,config))return current;}
        if(quote){checkRules(quote);if(quoteIsFresh(quote,config))return quote;}
      };
      return {adapter,currentQuote,recover:async()=>{
        if(currentQuote())return;
        // Only an originally valid selected book may use one extra public GET.
        // Join first so fee waits and a slow sibling share the same recovery budget.
        if(!adapter.fetchExecutionSnapshots||reads>=2)throw new SelectedPublicBookError(adapter.id,'not-fresh');
        const quotes=await readPublic();ensureCurrent();quote=quotes.find(s=>s.exchange===adapter.id&&s.base===base);
        if(!quote)throw new SelectedPublicBookError(adapter.id,'missing');
        checkRules(quote);
        if(!currentQuote())throw new SelectedPublicBookError(adapter.id,'not-fresh');
      }};
    }));
    const failure=failureOf(preparations);if(failure?.status==='rejected')throw failure.reason;
    const prepared=preparations.map(result=>(result as PromiseFulfilledResult<{
      adapter:ExchangeAdapter;currentQuote:()=>MarketSnapshot|undefined;recover:()=>Promise<void>}>).value);
    const recovered=await Promise.allSettled(prepared.map(selection=>selection.recover()));
    const recoveryFailure=failureOf(recovered);if(recoveryFailure?.status==='rejected')throw recoveryFailure.reason;
    // A recovery can itself wait behind the other venue. Recheck both at the same
    // final boundary; do not chase stale books with a third read or renew evidence.
    const final=prepared.map(selection=>{
      const quote=selection.currentQuote();if(!quote)throw new SelectedPublicBookError(selection.adapter.id,'not-fresh');return quote;
    });
    for(const quote of final){
      this.snapshots=this.snapshots.filter(s=>s.exchange!==quote.exchange||s.base!==base).concat(quote);
      this.unavailableSnapshots.delete(this.snapshotKey(quote.exchange,base));
    }
    this.recordSpreadObservations(Date.now());
  }
  private recordSpreadObservations(now:number){
    this.spreadHistory.observe(this.snapshots.filter(s=>!this.unavailableSnapshots.has(this.snapshotKey(s.exchange,s.base))),this.config,now);
    this.store.data.spreadObservations=this.spreadHistory.serialize();
  }
  private accountMatchesPosition(p:Position):boolean{
    const scoped=this.realtimeProfitAccountProof(p);
    return [p.long,p.short].every(leg=>{
      if(leg.quantity===0&&!this.hasLiveAccess(leg.exchange))return true;
      const account=scoped?.accounts.get(leg.exchange)??this.accounts.get(leg.exchange);
      if(!account)return false;
      if(account.positions.some(actual=>actual.symbol===leg.symbol&&actual.quantity>0&&actual.side!==leg.side))return false;
      const rows=account.positions.filter(actual=>actual.symbol===leg.symbol&&actual.side===leg.side&&actual.quantity>0);
      if(rows.length>1)return false;
      const actual=rows[0]?.quantity??0,tolerance=(this.snapshot(leg.exchange,p.base)?.quantityStep??1e-10)*.1;
      return Number.isFinite(actual)&&Math.abs(actual-leg.quantity)<=tolerance;
    });
  }
  /** A terminal local receipt cannot replace a fresh, post-order read of both actual holdings. */
  private canResumeConditionalHolding(p:Position):boolean {
    if(this.config.mode!=='live')return true;
    if(!this.accountMatchesPosition(p))return false;
    const now=Date.now(),latestActivity=Math.max(p.openedAt,p.closeRequestedAt??0,p.closeAttemptedAt??0,
      ...this.store.data.orders.filter(order=>order.positionId===p.id).map(order=>Math.max(order.createdAt,order.result?.timestamp??0)));
    return [p.long,p.short].every(leg=>{
      const health=this.health.find(row=>row.exchange===leg.exchange),at=health?.accountUpdatedAt;
      return this.hasLiveAccess(leg.exchange)&&health?.accountStatus==='ready'&&Number.isFinite(at)&&
        at!>latestActivity&&at!<=now&&now-at!<=this.config.maxSnapshotAgeMs;
    });
  }
  private async continueClosing(p:Position,reason:string,options?:{pricing?:'best-opposite'|'depth';requireProfit?:boolean;operationKind?:BeginTradingOperation['kind']},makerPreparation?:MakerClosePreparation){
    if(p.manualCloseOnly)throw new Error('该手动退出记录需按当前账户数量重新确认，不能由普通策略接续减仓');
    const exit=currentExitStrategyPosition(p,this.config);
    this.financialEpoch++;
    // A continuation keeps the original intent. A manual close or emergency stop
    // explicitly overrides an automatic economic wait; neither is inferred from the reason text.
    const profitCapture=options?.requireProfit??(p.closeProfitRequired===true||p.closeRequestedAt===undefined&&
      (p.holdDecision?.exitSignal==='profit'||p.holdDecision?.exitSignal==='funding-loss')&&
      (exit.entryPolicy==='aligned'||p.profitExitPolicy!==undefined)&&reason===p.holdDecision.reason);
    const pricing=options?.pricing??p.closePricing??(p.closeRequestedAt===undefined?'best-opposite':'depth');
    const priorSuspensions=p.automaticCloseHistory?.length??0;
    let result:boolean|undefined,closeValidationReason:string|undefined;
    try{
      if(this.execution.hasPendingMakerCloseTail(p)){
        if(this.config.mode==='live'&&(!this.liveUnlocked||this.store.data.killSwitch||
          ![p.long.exchange,p.short.exchange].every(exchange=>this.hasLiveAccess(exchange))||
          !this.closeAccountsFresh(p)||!this.accountMatchesPosition(p)))return false;
        if(this.running){const dispatched=this.execution.dispatchMakerCloseTail(p);return dispatched;}
        const repaired=await this.execution.continueMakerCloseTail(p);
        if(repaired&&this.matchedQuantities(p))this.scheduleRealtimeProfitExits(p,50);
        return repaired;
      }
      if(profitCapture&&pricing==='best-opposite'&&this.execution.requiresMakerProfitClose(p)){
        const long=this.snapshot(p.long.exchange,p.base),short=this.snapshot(p.short.exchange,p.base);
        const maker=planMakerClose(this.economicsPosition(p),long,short,this.config);
        const originalProfitPass=alignedExitProfitsPass(p,assessBestOppositeProfitExit(this.economicsPosition(p),long,short,this.config),this.config);
        if(originalProfitPass){
          if(this.execution.makerCloseRetryAfter(p)>Date.now()||!this.execution.canUseMakerClose(p)||!maker?.submissionAllowed){
            if(p.holdDecision)p.holdDecision={...p.holdDecision,action:'wait',exitSignal:undefined,
              reason:this.makerRouteBlockReason(p,long,short)??'本批 Maker 挂单价格、数量或重新报价间隔尚未满足，等待新鲜条件；未改用宽盘口腿 IOC'};
            return false;
          }
          // Running automatic managers only commit prepared intents here; venue waits belong to per-position workers.
          if(this.running&&!makerPreparation){this.scheduleRealtimeProfitExits(p);return false;}
          const started=await this.execution.startMakerClose(p,reason,makerPreparation);
          if(started===false&&p.holdDecision)p.holdDecision={...p.holdDecision,action:'wait',exitSignal:undefined,
            reason:'提交前原对手价1收益、费用或 Maker 挂单条件已变化，等待重新核验；未改用宽盘口腿 IOC'};
          return started;
        }
        if(p.holdDecision?.exitSignal!=='funding-loss')return false;
      }
      const validateProfitExit:CloseProfitValidation|undefined=profitCapture?(longPrice,shortPrice,batchQuantity)=>{
        const long=this.snapshot(p.long.exchange,p.base),short=this.snapshot(p.short.exchange,p.base),now=Date.now();
        if(exit.entryPolicy==='aligned'){
          const profit=pricing==='best-opposite'
            ?assessBestOppositeProfitExit(this.economicsPosition(p),long,short,this.config,now,batchQuantity,{longPrice,shortPrice})
            :assessProfitExit(this.economicsPosition(p),long,short,this.config,now,true,{longPrice,shortPrice});
          if(alignedExitProfitsPass(p,profit,this.config)){
            if(pricing==='best-opposite'&&this.execution.requiresMakerProfitClose(p)){
              closeValidationReason='原 IOC 限价复核已达到盈利门槛，按 Maker 退出规则停止宽盘口腿 IOC，等待重新准备 Maker 挂单';
              return false;
            }
            closeValidationReason=undefined;
            const exitProfit={spreadPnlUsd:profit!.spreadPnlUsd,totalFeesUsd:profit!.totalFeesUsd,
              fundingAfterFeesUsd:profit!.fundingAfterFeesUsd,spreadAfterFeesUsd:profit!.spreadAfterFeesUsd,netPnlUsd:profit!.netPnlUsd,
              closingFeesUsd:profit!.closingFeesUsd,spreadAfterClosingFeesUsd:profit!.spreadAfterClosingFeesUsd,
              ...(profit!.estimatedFeeRebateUsd!==undefined?{estimatedFeeRebateUsd:profit!.estimatedFeeRebateUsd,
                bookedFeeRebateUsd:profit!.bookedFeeRebateUsd,grossTotalFeesUsd:profit!.grossTotalFeesUsd,grossClosingFeesUsd:profit!.grossClosingFeesUsd}:{})};
            p.holdDecision={...(p.holdDecision??evaluateHoldingDecision(this.economicsPosition(p),long,short,this.config,now)),action:'close',exitSignal:'profit',
              exitProfit,fundingLossExit:undefined,
              reason:`实际提交限价下累计资金费与价格损益扣除全部开平手续费及成本后净收益 $${profit!.netPnlUsd.toFixed(4)} 超过原开仓单腿本金的 ${this.config.minExitProfitBps??10} bps（$${exitProfitThresholdUsd(p,this.config).toFixed(4)}），继续分批盈利退出`};
            return true;
          }
          const assessment=assessAlignedExit(this.economicsPosition(p),long,short,this.config,now,pricing==='depth',{longPrice,shortPrice},
            pricing==='best-opposite'?{pricing,batchQuantity}:undefined);
          const stability=this.fundingExitStability.evaluate(this.economicsPosition(p),long,short,assessment,this.config,now);
          const {passes,...evidence}=stability;
          closeValidationReason=assessment?.passes!==true
            ?assessment?.reason??'当前平仓价格、费用或到账证据尚未完整核验，等待再次复核'
            :!passes?stability.reason:undefined;
          if(p.holdDecision)p.holdDecision={...p.holdDecision,fundingExitStability:evidence,fundingLossExit:assessment?.fundingLossExit,
            ...(assessment?.profit?{exitProfit:assessment.profit}:{}),
            ...(closeValidationReason?{action:['positive','neutral','projection-wait'].includes(evidence.status)?'hold' as const:'wait' as const,
              exitSignal:undefined,reason:closeValidationReason}: {})};
          // A new losing batch still needs current funding evidence; each profit batch was checked above.
          // Execution's already-filled imbalance compensation remains independent of this callback.
          return assessment?.exitSignal==='funding-loss'&&assessment.passes&&passes;
        }
        return bothExitProfitsPass(p,pricing==='best-opposite'
            ?assessBestOppositeProfitExit(this.economicsPosition(p),long,short,this.config,now,batchQuantity,{longPrice,shortPrice})
            :assessProfitExit(this.economicsPosition(p),long,short,this.config,now,true,{longPrice,shortPrice}));
      }:undefined;
      if(profitCapture&&pricing==='best-opposite'&&this.config.mode==='live'&&this.config.profitExitExecutionMode==='ioc')
        result=this.execution.dispatchIocProfitClose(p,reason,validateProfitExit,
          p.holdDecision?.exitSignal==='funding-loss'?'funding-loss':'profit');
      else {
        this.diagnostic(()=>{
          const previous=this.store.operations.current(p.id);
          if(previous&&previous.kind!=='entry')return;
          const kind=options?.operationKind??(options?.requireProfit===false?'manual-close':
            p.holdDecision?.exitSignal==='funding-loss'?'funding-exit':p.holdDecision?.exitSignal==='profit'?'profit-exit':'close');
          const operationId=this.beginOperation({positionId:p.id,base:p.base,origin:kind==='manual-close'||kind==='emergency-close'?'manual':'automatic',
            kind,protocol:'ioc',target:{long:p.long.quantity,short:p.short.quantity}});
          if(operationId)this.store.operations.stage(operationId,'preparationStartedAt');
        });
        result=await this.execution.close(p,reason,validateProfitExit,{pricing,requireProfit:profitCapture});
      }
    }catch(error){
      if(!profitCapture||p.closeRequestedAt!==undefined)throw error;
      result=false;
    }finally{
      this.financialEpoch++;
      if(p.closeRequestedAt!==undefined)this.continuingClosePositions.add(p.id);
      else {this.continuingClosePositions.delete(p.id);this.pendingCloseChecks.delete(p.id);
        if((p.automaticCloseHistory?.length??0)>priorSuspensions){
          this.holdingSamples.delete(p.id);this.feeExitPreviewSamples.delete(p.id);this.fundingExitStability.forget(p.id);
        }
      }
    }
    if(result===false){
      const status=p.holdDecision?.fundingExitStability?.status;
      p.holdDecision={...p.holdDecision!,action:status&&['positive','neutral','projection-wait'].includes(status)?'hold':'wait',exitSignal:undefined,exitProfit:undefined,
        reason:closeValidationReason??'自动退出盘口或执行条件已变化，等待资金费与退出成本再次满足'};this.holdingSamples.delete(p.id);
    }
    return result;
  }
  private detailedOpportunities(now:number,ignorePositionId?:string,requireNativeFees=false):Opportunity[]{
    // A scanner can refresh the adapter's funding seed while a newer pushed book
    // keeps the stored quote unchanged. Calculate and confirm with one snapshot
    // per existing market so those two cache versions cannot erase valid history.
    const currentSnapshots=new Map<string,MarketSnapshot>();
    const adaptersByExchange=new Map(this.adapters.map(adapter=>[adapter.id,adapter]));
    for(const stored of this.snapshots){
      const key=this.snapshotKey(stored.exchange,stored.base);if(currentSnapshots.has(key))continue;
      const current=adaptersByExchange.get(stored.exchange)?.getExecutionSnapshot?.(stored.base)??stored;
      if(current.exchange!==stored.exchange||current.base!==stored.base)continue;
      this.overlayNativeSnapshotFee(current);currentSnapshots.set(key,current);
    }
    const opportunities=calculateOpportunities([...currentSnapshots.values()],this.config,now,this.spreadHistory,requireNativeFees);
    this.fundingEntryStability.invalidateMissing(opportunities,now);
    for(const opportunity of opportunities)opportunity.fundingEntryStability=this.fundingEntryStability.evaluate(opportunity,
      currentSnapshots.get(this.snapshotKey(opportunity.longExchange,opportunity.base)),
      currentSnapshots.get(this.snapshotKey(opportunity.shortExchange,opportunity.base)),this.config,now);
    // Statistics prove that this CURRENT coin/venue pair exists. Exact direction
    // and funding profitability are evaluated using its actual common coin quantity.
    const allowed=this.usesFundingStatistics()?new Set(this.fundingCandidates(now).map(fundingPairKey)):undefined;
    const excluded=new Map(this.coinExclusions(ignorePositionId).map(item=>[item.base,item]));
    const previewAccounts=this.previewAccounts(now);
    const executing=ignorePositionId?this.store.data.positions.find(position=>position.id===ignorePositionId):undefined;
    return opportunities.map(o=>applyEntryAvailability(o,{
      stopped:this.store.data.killSwitch,
      authorized:this.config.mode!=='live'||this.liveUnlocked&&[o.longExchange,o.shortExchange].every(x=>this.hasLiveAccess(x)),
      accountsReady:this.config.mode!=='live'?true:[o.longExchange,o.shortExchange].every(exchange=>
        this.liveEnvironment.exchanges.some(item=>item.exchange===exchange&&item.credentialsConfigured&&item.supported))
        ?[o.longExchange,o.shortExchange].every(exchange=>previewAccounts.has(exchange))?true:null:false,
      balances:[o.longExchange,o.shortExchange].map(exchange=>{
        const ownEntry=executing?.entryPolicy==='aligned'&&executing.entryExecution&&executing.base===o.base&&
          executing.long.exchange===o.longExchange&&executing.short.exchange===o.shortExchange;
        const leg=exchange===o.longExchange?executing?.long:executing?.short;
        const quantity=ownEntry?Math.max(0,executing!.entryExecution!.targetQuantity-leg!.quantity):exchange===o.longExchange?o.longQuantity:o.shortQuantity;
        const snapshot=this.snapshot(exchange,o.base);
        const top=o.entryPolicy==='aligned'&&snapshot?bestOppositeLevel(snapshot,exchange===o.longExchange?'buy':'sell')?.price:undefined;
        // Reserve the upper buy bound as well; an IOC buffer must never approve insufficient margin.
        const price=top!==undefined&&exchange===o.longExchange?top*(1+(this.config.entryIocBufferBps??8)/10000):top;
        const value=quantity*(price??snapshot?.markPrice??NaN);
        return {exchange,availableUsd:this.config.mode==='live'?previewAccounts.get(exchange)?.freeUsd:this.paperBalance(exchange),requiredUsd:this.requiredMarginUsd(exchange,value,o.base)};
      }),
      coinReasons:excluded.get(coinBase(o.base)!)?.reasons??[],
      cooldownUntil:this.entryCooldowns.get(coinBase(o.base)!)??0,
      candidateCurrent:!allowed||allowed.has(fundingPairKey(o)),
      marketAvailable:![o.longExchange,o.shortExchange].some(x=>this.unavailableSnapshots.has(this.snapshotKey(x,o.base)))
      ,...(this.config.mode==='live'&&this.observedPortfolio?{contracts:[o.longExchange,o.shortExchange].map(exchange=>{
        const symbol=this.snapshot(exchange,o.base)?.symbol,adapter=this.adapter(exchange);
        if(!adapter.inspectTrading)return {exchange,status:'failed' as const,reason:`${exchange} 不支持该合约只读执行检查`};
        const preview=symbol?this.entryContractPreviews.get(this.contractPreviewKey(exchange,symbol)):undefined;
        const fresh=preview&&now-preview.at<=(preview.status==='failed'?15000:120000);
        return {exchange,status:fresh?preview.status:'pending' as const,...(fresh&&preview.reason?{reason:preview.reason}:{})};
      })}:{})
    },now));
  }
  currentOpportunities():Opportunity[]{return this.detailedOpportunities(Date.now());}
  private assertAutomaticFundingEntryStability(p:Position):FundingEntryConfirmationEvidence|undefined {
    const scope=this.automaticEntryScopes.get(p);
    if(!this.autoEnabled||this.stopping||!scope||scope.generation!==this.startGeneration||scope.config!==this.config)
      throw new Error('自动开仓已暂停或原提交会话已变化，未提交新订单');
    const long=this.snapshot(p.long.exchange,p.base),short=this.snapshot(p.short.exchange,p.base);
    if(!quoteIsFresh(long,this.config)||!quoteIsFresh(short,this.config)||
      long.symbol!==p.long.symbol||short.symbol!==p.short.symbol||
      this.config.mode==='live'&&(nativeTakerFeeRate(long)===undefined||nativeTakerFeeRate(short)===undefined))
      throw new Error('自动开仓提交前双腿盘口或实际账户费率已失效，未提交新订单');
    const now=Date.now(),opportunity=this.detailedOpportunities(now,p.id,this.config.mode==='live').find(o=>
      o.base===p.base&&o.longExchange===p.long.exchange&&o.shortExchange===p.short.exchange);
    if(!opportunity)throw new Error('自动开仓资金费方向已变化，等待当前有效资金费机会');
    const mechanicalFailures=(opportunity.checks??[]).filter(check=>check.pass===false&&check.group==='market');
    if(mechanicalFailures.length)throw new Error(mechanicalFailures.map(check=>check.reason).join('；'));
    return this.assertAutomaticFundingOpportunity(opportunity);
  }
  private assertAutomaticFundingOpportunity(opportunity:Opportunity):FundingEntryConfirmationEvidence|undefined {
    const assessment=automaticEntryAssessment(opportunity);if(!assessment.passes)throw new Error(assessment.reason);
    const stability=opportunity.fundingEntryStability;
    if(stability?.status!=='confirmed'||stability.passes!==true)
      throw new Error(stability?.reason??'自动开仓当前资金费数据尚未核验通过，未提交新订单');
    return stability.evidence;
  }
  private contractPreviewKey(exchange:ExchangeId,symbol:string){return `${exchange}:${symbol}:${this.config.leverage}`;}
  private automaticProductRouteKey(base:string,longExchange:ExchangeId,longSymbol:string,shortExchange:ExchangeId,shortSymbol:string){
    return JSON.stringify([base,longExchange,longSymbol,shortExchange,shortSymbol]);
  }
  private automaticProductRejectionUntil(o:Opportunity,now=Date.now()):number {
    const long=this.snapshot(o.longExchange,o.base),short=this.snapshot(o.shortExchange,o.base);if(!long||!short)return 0;
    const key=this.automaticProductRouteKey(o.base,o.longExchange,long.symbol,o.shortExchange,short.symbol),cached=this.automaticProductRejections.get(key);
    if(!cached)return 0;
    if(now>=cached.until||cached.generation!==this.startGeneration||cached.config!==this.config||
      cached.adapters[0]!==this.adapters.find(a=>a.id===o.longExchange)||cached.adapters[1]!==this.adapters.find(a=>a.id===o.shortExchange)){
      this.automaticProductRejections.delete(key);return 0;
    }
    return cached.until;
  }
  private rememberAutomaticProductRejection(p:Position,error:unknown,opportunityId:string):boolean {
    const scope=this.automaticEntryScopes.get(p);
    if(!p.automaticEntry||!scope||scope.generation!==this.startGeneration||scope.config!==this.config||
      !(error instanceof OrderNotSubmittedError)||error.rejectionCode!=='UNVERIFIED_PRODUCT_ACCESS'||
      p.long.quantity!==0||p.short.quantity!==0||this.store.data.orders.some(order=>order.positionId===p.id))return false;
    const key=this.automaticProductRouteKey(p.base,p.long.exchange,p.long.symbol,p.short.exchange,p.short.symbol);
    this.automaticProductRejections.delete(key);
    if(this.automaticProductRejections.size>=128)this.automaticProductRejections.delete(this.automaticProductRejections.keys().next().value!);
    this.automaticProductRejections.set(key,{until:Date.now()+300000,generation:scope.generation,config:scope.config,
      adapters:[this.adapter(p.long.exchange),this.adapter(p.short.exchange)]});
    this.realtimePrepared.delete(opportunityId);
    return true;
  }
  private async refreshTradingFee(adapter:ExchangeAdapter,symbol:string){
    if(!adapter.fetchTradingFee)return;
    try{await this.boundedPrivateRead(adapter,`trading-fee:${symbol}`,()=>adapter.fetchTradingFee!(symbol));}
    catch{/* A missing exchange fee remains unknown; never infer it from configured rates or past expenses. */}
  }

  private async refreshEntryContractPreviews(){
    if(this.config.mode!=='live'||!this.observedPortfolio||this.stopping||this.credentialUpdatePending||this.entryContractPreviewRunning)return;
    const accounts=this.previewAccounts(),config=this.config,now=Date.now();
    // Discovery checks contract readiness only. Local fee references do not create private fee traffic.
    const discoveryChecks=new Set(['两腿交易账户已授权','两腿合约只读检查就绪','两腿手续费已知',
      '资金费 + 价差扣四笔手续费后净收益达标','实际 IOC 限价净收益达标']);
    const candidates=this.detailedOpportunities(now).filter(opportunity=>!this.automaticProductRejectionUntil(opportunity,now)&&opportunity.checks?.every(check=>
      discoveryChecks.has(check.label)||check.pass===true));
    const work=new Map<string,{exchange:ExchangeId;symbol:string;adapter:ExchangeAdapter;inspect:boolean}>();
    previewSelection:for(const candidate of candidates)for(const exchange of [candidate.longExchange,candidate.shortExchange]){
      if(!accounts.has(exchange))continue;
      const symbol=this.snapshot(exchange,candidate.base)?.symbol,adapter=this.adapter(exchange);if(!symbol||!adapter.inspectTrading)continue;
      const key=this.contractPreviewKey(exchange,symbol),cached=this.entryContractPreviews.get(key);
      const inspect=!cached||now-cached.at>(cached.status==='failed'?15000:120000);
      if(!inspect)continue;
      work.set(key,{exchange,symbol,adapter,inspect});if(work.size>=8)break previewSelection;
    }
    const selected=[...work].slice(0,8);if(!selected.length)return;
    this.entryContractPreviewRunning=true;
    for(const [key,item] of selected)if(item.inspect)this.entryContractPreviews.set(key,{status:'pending',at:now});
    try{
      await Promise.all(selected.map(async([key,{exchange,symbol,adapter,inspect}])=>{
        let status:'ready'|'failed'='ready',reason:string|undefined;
        if(inspect){
          try{await this.boundedPrivateRead(adapter,`contract:${symbol}:${config.leverage}`,()=>adapter.inspectTrading!(symbol,config.leverage));}
          catch(error){status='failed';reason=safeMessage(tradingError(exchange,'合约检查',error));}
          if(this.config===config&&this.adapters.includes(adapter)&&!this.credentialUpdatePending&&!this.stopping)this.entryContractPreviews.set(key,{status,reason,at:Date.now()});
        }
      }));
    }finally{this.entryContractPreviewRunning=false;}
  }
  private pruneSnapshots(now:number){
    if(!this.usesFundingStatistics())return;
    const active=new Set([...this.activePositions().flatMap(p=>[this.snapshotKey(p.long.exchange,p.base),this.snapshotKey(p.short.exchange,p.base)]),...this.actualPositionMarkets().map(position=>this.snapshotKey(position.exchange,position.base))]);
    this.snapshots=this.snapshots.filter(s=>active.has(this.snapshotKey(s.exchange,s.base))||quoteIsFresh(s,this.config,now));
    const retained=new Set(this.snapshots.map(s=>this.snapshotKey(s.exchange,s.base)));
    for(const key of this.unavailableSnapshots)if(!retained.has(key))this.unavailableSnapshots.delete(key);
  }
  async tick(){
    try{
    const config=this.config,generation=this.startGeneration,previous=this.snapshots,plan=this.detailedPlan(Date.now());
    this.updateRealtimeFocus();
    // All routine GETs stay outside the financial queue. Crossing an order submission invalidates the older account proof.
    const accountEpoch=this.financialEpoch;
    const accountBusy=(exchange:ExchangeId)=>this.activePositions().some(p=>[p.long.exchange,p.short.exchange].includes(exchange)&&
      (p.status==='opening'||this.execution.hasMakerClose(p)||this.execution.hasIocProfitClose(p)||
        this.store.data.orders.some(order=>order.positionId===p.id&&isCurrentUnconfirmedOrder(order,this.store.data.positions)&&
          !this.execution.isNativeExitRecoveryOrder(p,order))));
    const busyAtRead=new Set(this.adapters.filter(adapter=>accountBusy(adapter.id)).map(adapter=>adapter.id));
    const accountWork=this.config.mode==='live'?this.adapters.filter(a=>this.hasLiveAccess(a.id)).map(async adapter=>{
      const requestedAt=Date.now();try{return {adapter,requestedAt,account:await this.readTradingAccount(adapter),error:undefined};}catch(error){return {adapter,requestedAt,account:undefined,error};}
    }):[];
    const fundingDue=this.config.mode==='live'&&this.liveUnlocked&&Date.now()-this.lastLedgerAt>15000;
    if(fundingDue)this.lastLedgerAt=Date.now();
    const [accountResults]=await Promise.all([Promise.all(accountWork),Promise.allSettled(this.adapters.map(a=>this.refreshAdapter(a,plan.get(a.id)??[],false))),fundingDue?this.accrueLiveFunding():undefined]);
    return await this.exclusive(async()=>{
    if(this.stopping||this.config!==config||this.startGeneration!==generation)return;
    if(this.config.mode==='live'&&!this.liveUnlocked)this.autoEnabled=false;
    if(accountEpoch===this.financialEpoch)for(const {adapter,account,requestedAt,error} of accountResults){
      if(!this.adapters.includes(adapter)||!this.hasLiveAccess(adapter.id)||busyAtRead.has(adapter.id)||accountBusy(adapter.id))continue;
      const activity=Math.max(0,...this.store.data.orders.filter(order=>order.exchange===adapter.id)
        .map(order=>Math.max(order.createdAt,order.result?.timestamp??0)));
      if(requestedAt<activity)continue;
      if(account){if(this.cacheAccount(adapter.id,account))this.checkAccount(adapter.id,account);}else this.accountReadFailed(adapter.id,error);
    }
    const current=Date.now();
    this.recordSpreadObservations(current);
    if(this.config.mode==='paper')this.accruePaperFunding(previous,current);
    await this.managePositions(current);
    this.pruneSnapshots(current);
    this.opportunities=this.detailedOpportunities(current);
    void this.refreshEntryContractPreviews().catch(error=>this.tickFailed(error));
    this.updateRealtimeFocus();this.scheduleRealtimeWarmup();
    if(this.autoEnabled&&!this.store.data.killSwitch&&!this.hasPriorityCloseWork()){
      for(const o of this.opportunities.filter(o=>automaticEntryCandidateReady(o)&&!this.automaticProductRejectionUntil(o))){
        if(!this.autoEnabled||this.store.data.killSwitch||this.hasPriorityCloseWork())break;
        if(this.activePositions().some(p=>p.base===o.base))continue;
        if(pendingManualEntryBases(this.store.data.manualEntryOperations??[]).has(o.base))continue;
        if(!this.automaticEntryAttempts.ready(o.base))continue;
        const proof=this.realtimePrepared.get(o.id),prepared=proof&&proof.generation===this.startGeneration&&proof.config===this.config&&proof.financialEpoch===this.financialEpoch&&
          proof.context.preflight&&Date.now()-proof.context.preflight.checkedAt<=8000?proof.context:undefined;
        try{await this.openInternal(o.id,true,prepared);}catch(e){this.store.log('warn',`跳过 ${o.base}：${safeMessage(e)}`);}
      }
    }
    if(current-this.lastEquityAt>=5000){const t=this.totals();this.store.data.equity.push({timestamp:current,netPnlUsd:t.netPnlUsd,fundingUsd:t.fundingUsd,feesUsd:t.feesUsd});this.store.data.equity=this.store.data.equity.slice(-3000);this.lastEquityAt=current;}
    this.persistObservation(()=>this.store.save());
    });
    }catch(error){this.tickFailed(error);}
  }
  private lastTickFailure={message:'',at:0};
  private readonly persistenceFailures=new Set<unknown>();
  /** Mark only a failed actual save/log boundary, including a plain Error without OS metadata. */
  private markPersistenceFailure(error:unknown):void {
    this.autoEnabled=false;this.store.data.killSwitch=true;
    if(this.persistenceFailures.size>=32)this.persistenceFailures.delete(this.persistenceFailures.values().next().value);
    this.persistenceFailures.add(error);
  }
  private persistObservation<T>(write:()=>T):T {
    try{return write();}catch(error){this.markPersistenceFailure(error);throw error;}
  }
  private isPersistenceFailure(error:unknown):boolean {
    // A network connect/getaddrinfo/read syscall must not masquerade as a ledger write.
    const own=(key:string)=>{try{return error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,key)?.value:undefined;}catch{return undefined;}};
    return this.persistenceFailures.has(error)||this.execution.isObservationPersistenceFailure(error)||
      ['write','writev','open','mkdir','rename','fsync','fdatasync'].includes(own('syscall'))&&
      ['EIO','ENOSPC','EDQUOT','EACCES','EPERM','EROFS','ENOENT','EMFILE','ENFILE'].includes(own('code'));
  }
  /** Unknown background faults pause entry; only an actual persistence failure stops all trading. */
  private tickFailed(e:unknown){
    this.autoEnabled=false;
    const persistence=this.isPersistenceFailure(e);
    if(persistence)this.store.data.killSwitch=true;
    let diagnosis:string;try{diagnosis=safeMessage(e);}catch{diagnosis='后台异常诊断不可用，请检查本地运行日志';}
    const message=`引擎暂停${persistence?'（无法写入状态文件，已触发全局停止）':'（自动开仓已暂停，持仓继续管理）'}：${diagnosis}`,now=Date.now();
    if(message===this.lastTickFailure.message&&now-this.lastTickFailure.at<60000)return;
    this.lastTickFailure={message,at:now};
    try{this.persistObservation(()=>this.store.log('error',message));}
    catch{try{console.error('Persistence unavailable: trading halted');}catch{/* The in-memory halt survives diagnostic output failure. */}}
  }
  activePositions(){return this.store.data.positions.filter(isPositionActive);}
  private readonly closureSamples=new Map<string,FlatAccountEvidence>();
  private readonly closureFailures=new Map<string,string>();
  private readonly orderObservationAt=new Map<string,number>();
  /** Resolve recorded order results from GET-only endpoints even when execution is locked.
   * An order fill is history, not proof that an externally closed position is still held. */
  private async observePendingReports(portfolio:LivePortfolio):Promise<void>{
    const now=Date.now(),pending=this.store.data.orders.filter(order=>isCurrentUnconfirmedOrder(order,this.store.data.positions));
    const observations=await Promise.allSettled(pending.slice(0,10).map(async journal=>{
      if(this.store.data.positions.some(position=>position.id===journal.positionId&&position.externalExposureReduction&&
        position.manualCloseSourcePositionId&&this.externalExposureWorkers.has(position.manualCloseSourcePositionId)))return;
      if(journal.makerReduction&&this.activePositions().some(position=>position.id===journal.positionId&&this.execution.hasMakerClose(position)))return;
      if(this.activePositions().some(position=>position.id===journal.positionId&&this.execution.hasIocProfitClose(position)&&
        this.execution.ownsActiveIocProfitIntent(position,journal)))return;
      const key=`${journal.exchange}:${journal.request.clientOrderId}`;
      if(now-(this.orderObservationAt.get(key)??0)<15000)return;
      const account=portfolio.exchanges.find(row=>row.exchange===journal.exchange);
      if(!account?.credentialsConfigured||account.status!=='ready'||!Number.isFinite(account.requestedAt)||
        account.requestedAt!<=journal.createdAt||account.requestedAt!>now||now-account.requestedAt!>portfolio.maxAgeMs)return;
      const adapter=this.adapter(journal.exchange);if(journal.makerReduction?!adapter.inspectMakerReduction:!adapter.inspectOrder)return;
      this.orderObservationAt.set(key,now);
      const before=JSON.stringify(journal),config=this.config,generation=this.startGeneration;
      const current=()=>!this.stopping&&!this.credentialUpdatePending&&this.config===config&&this.startGeneration===generation&&
        this.adapters.includes(adapter)&&this.store.data.orders.includes(journal)&&JSON.stringify(journal)===before;
      try{
        if(journal.makerReduction){
          const observation=await this.boundedPrivateRead(adapter,`maker-order:${journal.request.clientOrderId}`,
            ()=>adapter.inspectMakerReduction!(journal.request,journal.result?.id||undefined));
          if(!current())return;
          if(this.execution.applyObservedMakerTerminal(journal,observation))
            this.persistObservation(()=>this.store.log('info',`${journal.request.base} ${journal.exchange} 原 Maker 已只读核对终态及实际现金；未恢复挂单或补平权限`,journal.positionId));
          return;
        }
        const result=await this.boundedPrivateRead(adapter,`order:${journal.request.clientOrderId}`,
          ()=>adapter.inspectOrder!(journal.request,journal.result?.id||undefined));
        if(!current())return;
        if(this.execution.applyObservedOrder(journal,result))
          this.persistObservation(()=>this.store.log('info',`${journal.request.base} ${journal.exchange} 订单已自动只读核对：${result.filledQuantity} / ${journal.request.quantity}；未提交补单或平仓`,journal.positionId));
      }catch(error){
        // GET failures retain an unknown original. A filesystem failure while
        // saving its observation/cash must stop trading and remain visible.
        if(this.persistenceFailures.has(error)||this.execution.isObservationPersistenceFailure(error))throw error;
      }
    }));
    // Drain every original GET before propagating a local persistence failure.
    const failure=observations.find(observation=>observation.status==='rejected');
    if(failure?.status==='rejected')throw failure.reason;
    const keys=new Set(pending.map(order=>`${order.exchange}:${order.request.clientOrderId}`));
    for(const key of this.orderObservationAt.keys())if(!keys.has(key))this.orderObservationAt.delete(key);
  }
  /** Observe external/manual closures even while trading is locked. This path calls only account/order GETs,
   * never execution reconciliation, cancellation or placement, and never invents fills or closing PnL. */
  async observeAccountClosures(portfolio:LivePortfolio):Promise<void>{return this.exclusive(async()=>{
    if(this.config.mode!=='live'||this.stopping||this.credentialUpdatePending)return;
    const config=this.config,generation=this.startGeneration;
    const current=()=>!this.stopping&&!this.credentialUpdatePending&&this.config===config&&this.startGeneration===generation;
    this.observedPortfolio=structuredClone(portfolio);
    void this.refreshEntryContractPreviews().catch(error=>this.tickFailed(error));
    await this.observePendingReports(portfolio);
    if(!current()){this.closureSamples.clear();return;}
    for(const p of this.activePositions()){
      const evidence=flatAccountEvidence(p,this.store.data.orders,portfolio);
      if(!evidence){this.closureSamples.delete(p.id);continue;}
      const prior=this.closureSamples.get(p.id);this.closureSamples.set(p.id,evidence);
      if(!prior||prior.latestActivity!==evidence.latestActivity||evidence.longAt<=prior.longAt||evidence.shortAt<=prior.shortAt)continue;
      let archivePersistenceFailed=false;
      try{
        const legs=accountClosureLegs(p);
        // Drain every bounded read before reporting one venue's failure; a fast peer rejection
        // must not start the next observation while the other requested GET is still in flight.
        const orderReads=await Promise.allSettled(legs.map(async leg=>{
          const adapter=this.adapter(leg.exchange);
          if(!adapter.fetchOpenOrders)throw new Error(`${leg.exchange} 暂不支持完整挂单只读核对`);
          return this.boundedPrivateRead(adapter,`open-orders:${leg.symbol}`,()=>adapter.fetchOpenOrders!(leg.symbol));
        }));
        if(!current()){this.closureSamples.clear();return;}
        const orderFailure=orderReads.find(read=>read.status==='rejected');
        if(orderFailure?.status==='rejected')throw orderFailure.reason;
        const orders=orderReads.flatMap(read=>read.status==='fulfilled'?[read.value]:[]);
        if(orders.some(rows=>!Array.isArray(rows)||rows.length>0))continue;
        // Read again after checking orders, rather than archive from the earlier empty position snapshot alone.
        const exchanges=[...new Set(legs.map(leg=>leg.exchange))];
        const accountReads=await Promise.allSettled(exchanges.map(exchange=>this.readTradingAccount(this.adapter(exchange))));
        if(!current()){this.closureSamples.clear();return;}
        const accountFailure=accountReads.find(read=>read.status==='rejected');
        if(accountFailure?.status==='rejected')throw accountFailure.reason;
        const accounts=accountReads.flatMap(read=>read.status==='fulfilled'?[read.value]:[]);
        if(accounts.some((account,index)=>!accountCoins(account)||account.positions.some(actual=>actual.quantity>0&&
          (coinBase(actual.base)===coinBase(p.base)||legs.some(leg=>leg.exchange===exchanges[index]&&actual.symbol===leg.symbol)))))continue;
        const confirmedAt=Date.now();
        if(accounts.some(account=>{
          const readAt=this.accountReadAt.get(account);
          return readAt===undefined||readAt>confirmedAt||confirmedAt-readAt>config.maxSnapshotAgeMs;
        })){
          this.closureSamples.delete(p.id);
          throw new Error('最终账户核对已过期，等待新的独立空仓观察');
        }
        const historicalOrdersPending=this.store.data.orders.some(order=>order.positionId===p.id&&isUnconfirmedJournalOrder(order));
        const oldReasons=p.riskReasons;
        p.accountClosure={confirmedAt,reason:'交易所连续空仓且无未成交订单，旧成交记录归入历史',historicalOrdersPending};
        p.riskReasons=[];
        try{this.persistObservation(()=>this.store.log('info',`${p.base} ${exchanges.length===1?'所选交易所账户':'两侧账户'}已空仓且无挂单：原成交数量与历史订单保留，不再作为当前持仓`,p.id));}
        catch(error){
          delete p.accountClosure;p.riskReasons=oldReasons;
          archivePersistenceFailed=true;
          throw error;
        }
        accounts.forEach((account,index)=>this.cacheAccount(exchanges[index],account));
        this.continuingClosePositions.delete(p.id);this.pendingCloseChecks.delete(p.id);this.holdingSamples.delete(p.id);this.fundingExitStability.forget(p.id);
        this.closureSamples.delete(p.id);this.closureFailures.delete(p.id);
      }catch(error){
        if(archivePersistenceFailed){
          this.store.data.killSwitch=true;this.autoEnabled=false;
          // A one-off disk failure may allow the halt and rollback audit to be
          // persisted, but can never turn the failed archive into a success.
          try{this.store.log('error',`${p.base} 空仓归档保存失败：已撤回本轮归档并停止交易，保留原订单与真实现金`,p.id);}catch{}
          throw error;
        }
        if(!current()){this.closureSamples.clear();return;}
        const message=safeMessage(error);
        if(this.closureFailures.get(p.id)!==message){
          this.closureFailures.set(p.id,message);
          this.persistObservation(()=>this.store.log('warn',`${p.base} 当前空仓观察保留，挂单核对尚未完成：${message}`,p.id));
        }
      }
    }
  });}
  private coinAttention(base:string,reason:string){
    let changed=false;
    for(const p of this.activePositions().filter(p=>coinBase(p.base)===coinBase(base))){
      if(p.status!=='attention'||!p.riskReasons.includes(reason))changed=true;
      p.status='attention';p.riskReasons=[reason];
    }
    if(changed)this.store.log('warn',reason);
  }
  /** Refreshes liquidation distance and freezes only the coin whose exchange quantity does not match the ledger. */
  private checkAccount(exchange:ExchangeId,a:AccountState){
    const now=Date.now(),readStartedAt=this.accountReadAt.get(a),source=this.accountReadSources?.get(a),
      health=this.health.find(row=>row.exchange===exchange);
    const current=this.config.mode!=='live'||this.running&&!this.stopping&&!this.credentialUpdatePending&&!this.maintenanceTradingPending&&
      this.accounts.get(exchange)===a&&health?.accountStatus==='ready'&&health.accountUpdatedAt===readStartedAt&&
      source?.config===this.config&&source.generation===this.startGeneration&&this.adapters.includes(source.adapter)&&source.adapter.id===exchange;
    // A previous session/client's read cannot freeze a current position. A later post-activity read is still required.
    if(!current)return true;
    for(const p of this.activePositions())for(const leg of [p.long,p.short].filter(l=>l.exchange===exchange&&l.quantity>0)){
      const rows=a.positions.filter(x=>x.symbol===leg.symbol&&x.side===leg.side&&x.quantity>0);
      const actual=rows.length===1?rows[0]:undefined;
      if(actual)leg.liquidationDistancePct=actual.liquidationPrice>0?(leg.side==='long'?actual.markPrice-actual.liquidationPrice:actual.liquidationPrice-actual.markPrice)/actual.markPrice*100:null;
      const tolerance=(this.snapshot(leg.exchange,p.base)?.quantityStep??1e-10)*.1;
      const opposite=a.positions.some(x=>x.symbol===leg.symbol&&x.quantity>0&&x.side!==leg.side);
      if(p.status==='open'&&(opposite||!actual||Math.abs(actual.quantity-leg.quantity)>tolerance)){
        if(this.config.mode!=='live'){p.status='attention';p.riskReasons=['实际仓位与本地记录不一致，暂停该币种'];continue;}
        const lastActivity=Math.max(p.openedAt,p.closeRequestedAt??0,p.closeAttemptedAt??0,...this.store.data.orders
          .filter(order=>order.positionId===p.id).map(order=>Math.max(order.createdAt,order.result?.timestamp??0)));
        const busy=this.execution.hasMakerClose(p)||this.execution.hasIocProfitClose(p)||this.execution.hasPendingIocProfitTail(p)||
          this.execution.hasPendingMakerCloseTail(p)||this.execution.hasPendingEntryRollback(p);
        const incident=accountExposureIncident({position:p,exchange,account:a,now,readStartedAt:readStartedAt??NaN,
          maxAgeMs:this.config.maxSnapshotAgeMs,lastFinancialActivityAt:lastActivity,quantityTolerance:tolerance,
          sourceCurrent:current,sessionAuthorized:this.hasLiveAccess(exchange),executionBusy:busy,unconfirmed:this.pendingCoin(p.base)});
        if(!incident)continue;
        this.autoEnabled=false;p.status='attention';p.riskReasons=[accountExposureIncidentMessage(incident)];
        if(!p.accountExposureIncidents?.some(previous=>previous.id===incident.id)){
          p.accountExposureIncidents=[...(p.accountExposureIncidents??[]),incident];
          this.persistObservation(()=>this.store.log('error',p.riskReasons[0],p.id));
          this.externalExposureSources.add(p.id);
          this.scheduleExternalExposureReduction(p);
        }
      }
    }
    return true;
  }
  paperBalance(x:ExchangeId){
    let balance=this.config.initialBalanceUsd;
    for(const p of this.store.data.positions)for(const l of [p.long,p.short].filter(l=>l.exchange===x))balance+=(l.fundingUsd??0)+(l.realizedPnlUsd??0)-l.feesUsd-p.transferCostUsd/2-l.quantity*l.markPrice/this.config.leverage;
    return balance;
  }
  private accruePaperFunding(previous:MarketSnapshot[],now:number){
    for(const p of this.activePositions())for(const leg of [p.long,p.short]){
      if(leg.quantity<=0)continue;
      const old=previous.find(s=>s.exchange===leg.exchange&&s.base===p.base);
      if(!old||old.nextFundingTime<=p.openedAt||old.nextFundingTime>now||!quoteIsFresh(old,this.config,now))continue;
      const key=`paper:${leg.exchange}:${old.nextFundingTime}`;
      if(p.fundingEvents.includes(key))continue;
      const first=p.profitExitPolicy?.fundingChecks.find(check=>check.exchange===leg.exchange)?.timestamp;
      const previousEvent=old.nextFundingTime-old.intervalHours*3_600_000;
      const firstCovered=Number.isFinite(first)&&Math.abs(first!-old.nextFundingTime)<=1000;
      const contiguousCovered=Number.isFinite(previousEvent)&&old.intervalHours>0&&
        Number.isFinite(leg.fundingObservedSince)&&leg.fundingObservedSince!<=p.openedAt&&
        Number.isFinite(leg.fundingObservedAt)&&leg.fundingObservedAt!>=previousEvent&&
        Number.isFinite(leg.lastFundingAt)&&Math.abs(leg.lastFundingAt!-previousEvent)<=1000;
      const amount=leg.quantity*old.markPrice*old.fundingRate*(leg.side==='short'?1:-1);
      p.fundingUsd+=amount;leg.fundingUsd=(leg.fundingUsd??0)+amount;leg.lastFundingAt=Math.max(leg.lastFundingAt??0,old.nextFundingTime);p.fundingEvents.push(key);refreshPnl(p);
      // A simulator observes only the event crossed by a fresh snapshot. Missing offline events remain unknown.
      if(firstCovered||contiguousCovered){leg.fundingObservedSince=p.openedAt;leg.fundingObservedAt=now;}
      this.store.log('info',`${p.base} ${leg.exchange} 模拟资金费 ${amount>=0?'+':''}${amount.toFixed(4)} USDT`,p.id);
    }
  }
  private async accrueLiveFunding(){
    const config=this.config,generation=this.startGeneration;
    // Only open positions and recently closed ones can still receive a settlement. Querying from the oldest
    // position ever opened makes the ledger request grow forever and eventually exceed exchange retention windows.
    // A recent flat-account proof still allows invoices from this older cycle. Attribution requires its
    // confirmed fill history and never accepts settlements after the closed/flat-confirmed window.
    const relevant=fundingRecordsForRead(this.store.data.positions);if(!relevant.length)return;
    const observations=await Promise.allSettled(this.adapters.filter(a=>this.hasLiveAccess(a.id)).map(async a=>{
      // Each venue's archive window belongs to its own holdings, including recently closed ones.
      const venueRelevant=relevant.filter(p=>p.long.exchange===a.id||p.short.exchange===a.id);
      if(!venueRelevant.length)return;
      const since=Math.min(...venueRelevant.map(p=>p.openedAt));
      const attemptAt=Date.now();
      const clocks:FundingReadClock[]=venueRelevant.filter(isPositionActive).flatMap(p=>[p.long,p.short]
        .filter(leg=>leg.exchange===a.id&&leg.quantity>0).map(leg=>({key:`${p.id}:${leg.symbol}:${leg.side}`,
          nextFundingTime:this.snapshots.find(quote=>quote.exchange===a.id&&quote.symbol===leg.symbol&&quote.base===p.base&&quote.source===config.dataSource)?.nextFundingTime})));
      if(!this.fundingReadRetry.ready(a,attemptAt,clocks,this.privateReadRequests.get(a)?.has('funding')===true))return;
      let phase:FundingReadPhase='read';
      try{
        const fundingReadAt=Date.now();
        const entries=await this.boundedPrivateRead(a,'funding',context=>a.fetchFundingPayments(since,context));
        phase='attribute';
        if(this.stopping||this.credentialUpdatePending||this.config!==config||this.startGeneration!==generation||!this.adapters.includes(a)||!this.hasLiveAccess(a.id))return;
        const unassigned:FundingPayment[]=[];
        for(const f of entries){
          const key=`${a.id}:${f.id}`;if(this.store.data.fundingSeen.includes(key))continue;
          const selectedUnknownReductions=new Set(this.store.data.orders.filter(order=>venueRelevant.some(p=>
            this.execution.isNativeExitRecoveryOrder(p,order))));
          const owner=findFundingOwner(this.store.data.positions,this.store.data.orders,a.id,f,selectedUnknownReductions);
          if(!owner){unassigned.push(f);continue;}
          const {position:p,leg}=owner;
          p.fundingUsd+=f.amountUsd;leg.fundingUsd=(leg.fundingUsd??0)+f.amountUsd;leg.lastFundingAt=Math.max(leg.lastFundingAt??0,f.timestamp);p.fundingEvents.push(key);this.store.data.fundingSeen.push(key);refreshPnl(p);
          phase='save';this.persistObservation(()=>this.store.save());
          if(owner.quantityRange)this.persistObservation(()=>this.store.log('info',`${p.base} ${a.id} 资金费已按原生账单归属唯一持仓；历史未知减仓仍待核对，未推定其成交或费用`,p.id));
          phase='attribute';
        }
        for(const p of venueRelevant)for(const leg of [p.long,p.short].filter(leg=>leg.exchange===a.id)){
          const end=fundingWindowEnd(p);
          if(unassigned.some(f=>f.base===p.base&&p.openedAt<f.timestamp&&(end===undefined||f.timestamp<=end)&&
            (f.symbol===undefined||f.symbol===leg.symbol)&&(f.side===undefined||f.side===leg.side))){
            // Read successfully does not mean a same-symbol invoice has been attributed. Keep this leg's
            // settlement unknown until the delayed execution report can prove its ownership.
            delete leg.fundingObservedAt;delete leg.fundingObservedSince;continue;
          }
          leg.fundingObservedAt=fundingReadAt;leg.fundingObservedSince=since;
        }
        phase='save';this.persistObservation(()=>this.store.save());phase='attribute';
        if(this.fundingReadRetry.succeeded(a)){
          phase='save';this.persistObservation(()=>this.store.log('info',`${a.id} 资金费账单读取已恢复，继续按实际账单核对；未确认金额仍待核对`));phase='attribute';
        }
      }catch(error){
        if(phase==='save'){
          // Preserve the original failed write even if the diagnostic log also fails.
          this.markPersistenceFailure(error);
          const failure=this.fundingReadRetry.failed(a,error,a.id,Date.now(),'save');
          if(failure.log)try{this.persistObservation(()=>this.store.log('error',`${a.id} 资金费账单本地保存失败：已停止交易，保留已读取真实现金并等待核对`));}catch{}
          throw error;
        }
        if(this.stopping||this.credentialUpdatePending||this.config!==config||this.startGeneration!==generation||!this.adapters.includes(a)||!this.hasLiveAccess(a.id))return;
        const failure=this.fundingReadRetry.failed(a,error,a.id,Date.now(),phase);
        if(failure.log)this.persistObservation(()=>this.store.log('warn',`${a.id} 资金费账单暂不可用：${failure.reason}；已保留待核对状态，${failure.delayMs/1000} 秒后自动只读重试`));
      }
    }));
    // Finish every original bounded GET before surfacing an actual failed local write.
    const failure=observations.find(observation=>observation.status==='rejected');
    if(failure?.status==='rejected')throw failure.reason;
  }
  private async managePositions(now:number){
    // One position throwing must not stop exit management for every other position.
    for(const p of this.activePositions()){
      try{
        if(this.running&&this.realtimeProfitCandidate(p)&&
          (this.execution.requiresMakerProfitClose(p)||this.config.profitExitExecutionMode==='ioc')){
          for(const leg of [p.long,p.short]){const quote=this.snapshot(leg.exchange,p.base);if(quote)leg.markPrice=quote.markPrice;}
          refreshPnl(p);this.scheduleRealtimeProfitExits(p);continue;
        }
        await this.managePosition(p,now);
      }
      catch(error){
        if(this.persistenceFailures.has(error)||this.execution.isObservationPersistenceFailure(error))throw error;
        const message=safeMessage(error);
        if(this.manageFailures.get(p.id)!==message){this.manageFailures.set(p.id,message);this.persistObservation(()=>this.store.log('error',`${p.base} 持仓管理异常，本轮已跳过：${message}`,p.id));}
      }
    }
    for(const id of this.holdingSamples.keys())if(!this.activePositions().some(p=>p.id===id))this.holdingSamples.delete(id);
    for(const id of this.feeExitPreviewSamples.keys())if(!this.activePositions().some(p=>p.id===id))this.feeExitPreviewSamples.delete(id);
    for(const position of this.store.data.positions)if(!isPositionActive(position))this.fundingExitStability.forget(position.id);
    for(const id of this.continuingClosePositions)if(!this.activePositions().some(p=>p.id===id)){this.continuingClosePositions.delete(id);this.pendingCloseChecks.delete(id);}
    for(const id of this.realtimeProfitSignalAt.keys())if(!this.activePositions().some(p=>p.id===id)){
      this.realtimeProfitSignalAt.delete(id);this.realtimeProfitFeeRetryAt.delete(id);this.realtimeProfitSettled.delete(id);
      this.realtimeProfitPreparationFailureAt.delete(id);
    }
  }
  private readonly manageFailures=new Map<string,string>();
  /** Restore one explicitly named external-risk supervisor. This does not restore
   * the old strategy quantity, invent the external fill, or grant new entry. */
  async restoreSelectedExternalExposureManagement(request:SelectedExternalExposureRecoveryRequest){
    const position=await this.exclusive(async()=>{
      if(request.acknowledgement!=='RESTORE_SELECTED_EXTERNAL_EXPOSURE_MANAGEMENT'||
        !Number.isFinite(request.expiresAt)||request.expiresAt<=Date.now()||request.expiresAt>Date.now()+60_000||
        this.autoEnabled||!this.running||this.stopping||this.store.data.killSwitch||!this.liveUnlocked)
        throw new Error('外部单腿风险恢复需要暂停新开仓和有效的本轮限定确认');
      const p=this.store.data.positions.find(row=>row.id===request.positionId),expected=request.expected;
      if(!p||p.mode!=='live'||!isPositionActive(p)||p.accountClosure||p.manualCloseOnly||p.manualCloseAccountRecord||
        p.status!=='attention'||this.pendingCoin(p.base)||this.execution.hasMakerClose(p)||this.execution.hasIocProfitClose(p)||
        this.execution.hasPendingIocProfitTail(p)||this.execution.hasPendingMakerCloseTail(p)||this.execution.hasPendingEntryRollback(p)||
        this.continuingClosePositions.has(p.id)||this.pendingCloseReadWorkers.has(p.id)||this.holdingExitReadWorkers.has(p.id)||
        ![p.long.exchange,p.short.exchange].every(exchange=>this.hasLiveAccess(exchange)))
        throw new Error('所选风险仓位身份、原单或当前操作尚未核对，未恢复减仓');
      const actual={base:p.base,openedAt:p.openedAt,longExchange:p.long.exchange,longSymbol:p.long.symbol,longQuantity:p.long.quantity,
        shortExchange:p.short.exchange,shortSymbol:p.short.symbol,shortQuantity:p.short.quantity};
      if(!expected||Object.keys(actual).some(key=>actual[key as keyof typeof actual]!==expected[key as keyof typeof expected]))
        throw new Error('所选原策略身份或数量已变化，需重新核对');
      this.store.log('warn',`${p.base} 已接受限定外部单腿风险核验：只有双轮原生持仓和完整无挂单证明通过后，才按实际超额数量只减仓；不等待盈利门槛`,p.id);
      this.externalExposureSources.add(p.id);this.externalExposureRetryAt.delete(p.id);return p;
    });
    this.scheduleExternalExposureReduction(position);
    return {positionId:position.id,acceptedAt:Date.now(),autoEnabled:false};
  }
  private scheduleExternalExposureReduction(p:Position):void {
    if(!this.externalExposureSources.has(p.id)||this.externalExposureWorkers.has(p.id)||
      Date.now()<(this.externalExposureRetryAt.get(p.id)??0)||!this.running||this.stopping||this.store.data.killSwitch||
      !this.liveUnlocked||this.maintenanceTradingPending||this.credentialUpdatePending)return;
    if(!isPositionActive(p)){this.externalExposureSources.delete(p.id);return;}
    const config=this.config,environment=this.liveEnvironment,adapters=[p.long,p.short].map(leg=>this.adapter(leg.exchange));
    const ensure=()=>{
      if(!this.running||this.stopping||this.config!==config||this.liveEnvironment!==environment||
        this.store.data.killSwitch||!this.liveUnlocked||this.credentialUpdatePending||this.maintenanceTradingPending||
        !this.externalExposureSources.has(p.id)||!this.store.data.positions.includes(p)||!isPositionActive(p)||
        !adapters.every(adapter=>this.adapters.includes(adapter)&&this.hasLiveAccess(adapter.id)))
        throw new Error('外部风险处理的本轮权限或原持仓身份已变化');
    };
    // Launch after registering the worker; network waits never hold the financial queue.
    const task=Promise.resolve().then(()=>runExternalExposureReduction({store:this.store,source:p,config,
      adapter:exchange=>this.adapter(exchange),snapshot:(exchange,base)=>this.snapshot(exchange,base),
      readAccount:async exchange=>{const adapter=this.adapter(exchange),account=await this.drainRiskRead(adapter,'account',()=>this.readTradingAccount(adapter));
        const startedAt=this.accountReadAt.get(account);if(startedAt===undefined)throw new Error('风险账户缺少真实请求起始时间');
        return {account,startedAt};},
      read:(adapter,key,call)=>this.drainRiskRead(adapter,key,()=>this.boundedPrivateRead(adapter,key,call)),
      refreshBooks:async(base,exchanges)=>{
        const operation=this.refreshExecutionSnapshots(base,exchanges,false);
        // The selected quote reader can time out too. Retain its actual GET ownership
        // through the same final drain, including its optional second quote read.
        try{await operation;}finally{
          await Promise.allSettled(exchanges.flatMap(exchange=>{
            const adapter=adapters.find(value=>value.id===exchange),native=adapter&&this.privateReadRequests.get(adapter)?.get(`execution-book:${base}`),
              publicRead=this.publicSnapshotRequests.get(exchange as ExchangeId);
            return [native,publicRead].filter((value):value is Promise<unknown>=>value!==undefined);
          }));
        }
      },
      ensure,serialize:work=>this.exclusive(work),onFinancialActivity:journal=>{
        const previous=this.financialEpoch++;this.realtimePrepared.clear();this.makerFinancialScopeObserver?.(journal,previous);
      },
    })).then(outcome=>{
      if(this.store.data.positions.includes(p)&&isPositionActive(p)){
        p.riskReasons=[outcome.reason];delete p.holdDecision;this.store.save();
      }
      if(outcome.status==='closed')this.externalExposureSources.delete(p.id);
      this.externalExposureRetryAt.set(p.id,Date.now()+(outcome.status==='submitted'?250:2000));
    }).catch(error=>{
      this.externalExposureRetryAt.set(p.id,Date.now()+5000);
      const message=`外部单腿风险仍待处理：${safeMessage(error)}`;
      try{
        p.riskReasons=[message];delete p.holdDecision;this.store.save();
        if(this.manageFailures.get(p.id)!==message){this.manageFailures.set(p.id,message);this.store.log('error',`${p.base} ${message}`,p.id);}
      }catch{this.autoEnabled=false;this.store.data.killSwitch=true;}
    }).finally(()=>{
      this.externalExposureWorkers.delete(p.id);
      const previous=this.externalExposureRetryTimers.get(p.id);if(previous)clearTimeout(previous);
      this.externalExposureRetryTimers.delete(p.id);
      // Wake confirmed partials promptly without waiting for a full market/funding tick.
      // The timer is armed only after every real native request in this worker has settled.
      if(this.running&&!this.stopping&&!this.store.data.killSwitch&&this.externalExposureSources.has(p.id)){
        const timer=setTimeout(()=>{this.externalExposureRetryTimers.delete(p.id);this.scheduleExternalExposureReduction(p);},
          Math.max(0,(this.externalExposureRetryAt.get(p.id)??Date.now())-Date.now()));
        timer.unref?.();this.externalExposureRetryTimers.set(p.id,timer);
      }
    });
    this.externalExposureWorkers.set(p.id,task);
  }
  /** After an entry that sent orders but did not end as a held hedge (rollback, mismatch, unknown order), wait before
   *  trying the same coin again; otherwise the next tick re-qualifies the same quote and pays the fees again. */
  private readonly entryCooldowns=new Map<string,number>();
  /** The existing tracker always observes full actual holdings. Only the scoped planner
   * compares its exact new reductions; a book/fee refresh cannot manufacture history. */
  private confirmLotTailFundingExit(p:Position,assessment:AlignedExitAssessment,long:MarketSnapshot,short:MarketSnapshot,now:number):boolean {
    const available=![long,short].some(quote=>this.unavailableSnapshots.has(this.snapshotKey(quote.exchange,p.base))),
      stability=this.fundingExitStability.evaluate(this.economicsPosition(p),long,short,available?assessment:undefined,this.config,now);
    const {passes,...evidence}=stability;
    if(p.holdDecision)p.holdDecision={...p.holdDecision,fundingExitStability:evidence,
      fundingLossExit:assessment.fundingLossExit,...(assessment.profit?{exitProfit:assessment.profit}:{}),
      action:assessment.passes&&passes?'close':'wait',exitSignal:assessment.passes&&passes?'funding-loss':undefined,
      reason:`${assessment.reason}；${stability.reason}`};
    return passes;
  }
  /** Only a known original normal-strategy Maker sub-lot may ask the strict native
   * repair path for a new action. Reference fees discover a candidate, never permit it. */
  private scheduleConfirmedLotTailRestoration(p:Position,now:number):boolean {
    if(this.execution.hasNativeExitAuthority(p)||!this.running||!this.autoEnabled||!this.liveUnlocked||this.store.data.killSwitch||p.status!=='attention'||
      p.manualCloseOnly||p.manualCloseAccountRecord||p.accountClosure||p.closeProfitRequired!==true||
      p.closePricing!=='best-opposite'||p.closeRequestedAt===undefined||this.matchedQuantities(p)||
      this.execution.hasMakerClose(p)||this.execution.hasIocProfitClose(p)||this.pendingCoin(p.base)||this.confirmedLotTailPreparing.has(p.id))return false;
    const candidates=this.store.data.orders.filter(order=>order.positionId===p.id&&order.makerReduction?.activity==='terminal'&&
      order.makerReduction.bookedExecution===true&&!order.makerReduction.lotTailOriginalParentClientId&&
      order.result?.filledQuantity&&this.execution.canRepairConfirmedMakerLotTail(p,order));
    if(candidates.length!==1)return false;
    const parent=candidates[0],key=`${p.id}:${parent.request.clientOrderId}`;
    const long=this.snapshot(p.long.exchange,p.base),short=this.snapshot(p.short.exchange,p.base),
      plan=planConfirmedLotTailRestoration({position:p,parent,orders:this.store.data.orders,long,short,config:this.config,now,
        requireNativeFees:false,fundingExitQualified:(assessment,l,s,at)=>this.confirmLotTailFundingExit(p,assessment,l,s,at)});
    if(plan.status==='waiting'){
      p.riskReasons=[plan.funding&&p.holdDecision?`${plan.reason}；${p.holdDecision.fundingExitStability?.reason??''}`:plan.reason];
      if(p.holdDecision)p.holdDecision={...p.holdDecision,action:'wait',exitSignal:undefined,reason:p.riskReasons[0]};
      return true;
    }
    if(plan.status!=='reduce-peer'&&plan.status!=='augment-maker')return false;
    if(now-(this.confirmedLotTailRetryAt.get(key)??0)<60_000)return true;
    this.confirmedLotTailRetryAt.set(key,now);this.confirmedLotTailPreparing.add(p.id);
    const request:SelectedMakerCloseRepairRequest={acknowledgement:'REPAIR_SELECTED_MAKER_CLOSE_LOT_TAIL',expiresAt:Date.now()+60_000,
      positionId:p.id,parentClientOrderId:parent.request.clientOrderId,expected:{base:p.base,openedAt:p.openedAt,
        longExchange:p.long.exchange,longSymbol:p.long.symbol,longQuantity:p.long.quantity,
        shortExchange:p.short.exchange,shortSymbol:p.short.symbol,shortQuantity:p.short.quantity}};
    const generation=this.startGeneration;
    void this.repairSelectedMakerLotTail(request,true).catch(error=>{
      const reason=`所选最小共同尾差恢复未通过：${safeMessage(error)}；保留原 ID 与真实现金，等待下一轮复核`;
      try{
        if(this.startGeneration===generation&&this.running&&this.autoEnabled&&!this.stopping&&
          this.store.data.positions.find(position=>position.id===p.id)===p&&p.status==='attention'&&
          p.long.quantity===request.expected.longQuantity&&p.short.quantity===request.expected.shortQuantity){
          p.riskReasons=[reason];this.store.save();
        }
        this.store.log('warn',`${p.base} 最小共同尾差恢复未通过：${safeMessage(error)}；保留原 ID 与真实现金等待复核`,p.id);
      }catch{this.store.data.killSwitch=true;}
    }).finally(()=>this.confirmedLotTailPreparing.delete(p.id));
    return true;
  }
  /** A known ledger save failure blocks every pending POST, including errors without a syscall. */
  private saveCloseReadState():void {
    this.persistObservation(()=>this.store.save());
  }
  /** A pending original order owns only its coin's GET worker, never the financial queue. */
  private dispatchPendingCloseRead(p:Position):void {
    if(this.pendingCloseReadWorkers.has(p.id))return;
    const config=this.config,generation=this.startGeneration,requestedAt=p.closeRequestedAt;
    const current=()=>this.running&&!this.stopping&&!this.credentialUpdatePending&&!this.maintenanceTradingPending&&
      this.config===config&&this.startGeneration===generation&&this.store.data.positions.includes(p)&&
      this.continuingClosePositions.has(p.id)&&p.closeRequestedAt===requestedAt&&isPositionActive(p);
    const task=Promise.resolve().then(async()=>{
      if(!current())return;
      await this.execution.reconcilePendingConcurrent(p.id,current);
    }).catch(error=>this.exclusive(async()=>{
      if(!current())return;
      p.status='attention';p.riskReasons=['平仓未完成：存在未确认订单，等待订单对账，禁止重复下单'];this.saveCloseReadState();
    })).catch(error=>this.tickFailed(error)).finally(()=>{
      this.pendingCloseReadWorkers.delete(p.id);
      if(current())this.scheduleRealtimeProfitExits(p,50);
    }).catch(error=>this.tickFailed(error));
    this.pendingCloseReadWorkers.set(p.id,task);
  }
  /** Funding-qualified account fees and books are prepared outside unrelated coins' cash commits. */
  private dispatchHoldingExitReads(p:Position):void {
    if(this.holdingExitReadWorkers.has(p.id)||Date.now()<(this.realtimeProfitFeeRetryAt.get(p.id)??0))return;
    const config=this.config,generation=this.startGeneration,proof=this.profitExitFinancialProof(p);
    const current=()=>this.running&&!this.stopping&&!this.credentialUpdatePending&&!this.maintenanceTradingPending&&
      this.config===config&&this.startGeneration===generation&&this.store.data.positions.includes(p)&&
      isPositionActive(p)&&proof===this.profitExitFinancialProof(p);
    const task=Promise.resolve().then(async()=>{
      if(!current())return;
      let readFailed=false;
      try{await this.refreshExecutionSnapshots(p.base,[p.long.exchange,p.short.exchange]);}
      catch{readFailed=true;}
      await this.exclusive(async()=>{
        if(!current())return;
        if(readFailed||this.realtimeProfitFeesMissing(p).length)this.realtimeProfitFeeRetryAt.set(p.id,Date.now()+15000);
        else this.realtimeProfitFeeRetryAt.delete(p.id);
        if(readFailed){p.riskReasons=['自动退出账户手续费或盘口读取暂不可用，等待重新核验；未创建委托'];return;}
        // Recompute the current signal, funding window, native fees and exact quantities after the GETs.
        await this.managePosition(p,Date.now(),false,undefined,true);this.saveCloseReadState();
      });
    }).catch(error=>this.tickFailed(error)).finally(()=>{
      this.holdingExitReadWorkers.delete(p.id);
      if(current())this.scheduleRealtimeProfitExits(p,50);
    }).catch(error=>this.tickFailed(error));
    this.holdingExitReadWorkers.set(p.id,task);
  }
  private async managePosition(p:Position,now:number,realtimeProfitWake=false,makerPreparation?:MakerClosePreparation,nativeExitReadsPrepared=false){
    if(this.maintenanceTradingPending)return;
    if(this.externalExposureSources.has(p.id)){
      this.scheduleExternalExposureReduction(p);return;
    }
    const exit=currentExitStrategyPosition(p,this.config);
    for(const leg of [p.long,p.short]){
      const s=this.snapshot(leg.exchange,p.base);if(s)leg.markPrice=s.markPrice;
      if(this.config.mode==='paper'&&leg.quantity>0)leg.liquidationDistancePct=Math.max(0,(1/this.config.leverage-.005-(leg.side==='long'?leg.entryPrice-leg.markPrice:leg.markPrice-leg.entryPrice)/leg.entryPrice)*100);
    }
    refreshPnl(p);
    if(this.execution.hasMakerClose(p)||this.execution.hasIocProfitClose(p))return;
    if(this.pendingCloseReadWorkers.has(p.id)||this.holdingExitReadWorkers.has(p.id)&&!nativeExitReadsPrepared)return;
    if(p.status==='open'&&!makerPreparation)freezeProfitExitNotional(p,this.store.data.orders);
    // A manual reduction ledger is never an implicit strategy adoption, including after restart.
    if(p.manualCloseOnly)return;
    // This session's known IOC imbalance belongs to its own confirmed batch,
    // including when an older Maker parent remains in the native-exit audit.
    if(this.execution.hasPendingIocProfitTail(p)){
      if(this.config.mode==='live'&&(!this.liveUnlocked||this.store.data.killSwitch||
        ![p.long.exchange,p.short.exchange].every(exchange=>this.hasLiveAccess(exchange))))return;
      this.execution.dispatchIocProfitClose(p,p.closeReason??'继续补齐已确认 IOC 平仓尾差');return;
    }
    // A current Maker's known fill owns this tail even when a historical unknown
    // is retained under a separate native-exit audit. Never route it to an older parent.
    if(this.execution.hasPendingMakerCloseTail(p)){
      if(this.config.mode==='live'&&(!this.liveUnlocked||this.store.data.killSwitch||
        ![p.long.exchange,p.short.exchange].every(exchange=>this.hasLiveAccess(exchange))))return;
      if(!this.closeAccountsFresh(p,now)||!this.accountMatchesPosition(p)){
        p.riskReasons=['Maker 已确认尾差等待本批之后的新鲜账户数量核对；未新增共同减仓'];return;
      }
      if(this.continuingClosePositions.has(p.id)&&p.closeRequestedAt!==undefined)
        await this.continueClosing(p,p.closeReason??'继续处理已确认 Maker 对侧尾差',undefined,makerPreparation);
      return;
    }
    // Each selected native tail gets an independent worker. Its account and fee reads
    // cannot hold the queue needed by another coin's eligible Maker exit.
    if(this.execution.hasNativeExitAuthority(p)&&!this.matchedQuantities(p)){
      if(this.nativeExitTailPreparing.has(p.id)||this.exitPendingCoin(p))return;
      const audit=[...(p.nativeExitRecoveryAudit??[])].reverse().find(value=>value.revokedAt===undefined);
      if(!audit||this.stopping||this.store.data.killSwitch)return;
      const tailParentClientId=audit.confirmedTailParentClientOrderId??audit.parentClientOrderId;
      if(!this.execution.canRepairConfirmedMakerCloseTail(p,tailParentClientId))return;
      this.nativeExitTailPreparing.add(p.id);
      void this.execution.repairNativeConfirmedTail(p,tailParentClientId).then(()=>{
        if(this.execution.hasNativeExitAuthority(p)&&this.matchedQuantities(p))this.scheduleRealtimeProfitExits(p,50);
      }).catch(error=>{
        const message=`原生持仓尾差等待下一轮核验：${safeMessage(error)}`;
        try{
          if(this.execution.hasNativeExitAuthority(p)){p.riskReasons=[message];this.store.save();}
          if(this.manageFailures.get(p.id)!==message){this.manageFailures.set(p.id,message);this.store.log('warn',`${p.base} ${message}`,p.id);}
        }catch{this.autoEnabled=false;this.store.data.killSwitch=true;}
      }).finally(()=>this.nativeExitTailPreparing.delete(p.id));
      return;
    }
    if(this.nativeExitTailPreparing.has(p.id))return;
    if(this.scheduleConfirmedLotTailRestoration(p,now)||this.confirmedLotTailPreparing.has(p.id))return;
    // This process owns the continuation, but a completed order still needs a post-order
    // account read. A temporary attention state cannot turn a missing/stale cache into a
    // confirmed mismatch, and an old matching cache cannot authorize another batch.
    const currentClose=this.continuingClosePositions.has(p.id)&&p.closeRequestedAt!==undefined;
    if(currentClose&&this.config.mode==='live'&&!this.exitPendingCoin(p)){
      if(!this.closeAccountsFresh(p,now)){
        p.riskReasons=['平仓继续处理前等待新鲜账户数量核对；未新增减仓'];return;
      }
      if(!this.accountMatchesPosition(p)){
        p.status='attention';p.riskReasons=['平仓未完成：实际仓位尚未与成交记录核对一致'];return;
      }
      if(p.status==='attention'&&this.execution.canResumeConfirmedIocClose(p)){
        p.status='closing';p.riskReasons=[];
      }
    }
    let l=this.snapshot(p.long.exchange,p.base),s=this.snapshot(p.short.exchange,p.base);
    const makerBlock=this.makerRouteBlockReason(p,l,s);
    if(makerBlock&&this.liveUnlocked&&[p.long.exchange,p.short.exchange].every(exchange=>this.hasLiveAccess(exchange))&&
      exit.holdMode==='adaptive'&&alignedExitProfitsPass(p,
      assessBestOppositeProfitExit(this.economicsPosition(p),l,s,this.config,now,undefined,undefined,false),this.config)){
      p.holdDecision={...evaluateHoldingDecision(this.economicsPosition(p),l,s,this.config,now,false),action:'wait',exitSignal:undefined,reason:makerBlock};
      p.riskReasons=[makerBlock];return;
    }
    if(exit.holdMode==='adaptive'){
      const usable=(q:MarketSnapshot|undefined)=>q&&!this.unavailableSnapshots.has(this.snapshotKey(q.exchange,p.base))&&['online','degraded'].includes(this.health.find(h=>h.exchange===q.exchange)?.status??'')?q:undefined;
      let profitFeesPending=false;
      // Local costs identify an exit candidate only. A profit candidate immediately checks exact
      // account fees; a losing funding exit first needs its independent funding confirmation.
      const makerRoute=this.execution.requiresMakerProfitClose(p)&&this.execution.canUseMakerClose(p);
      const feesMissing=()=>{
        const makerSide=makerRoute?selectMakerCloseLeg(usable(l),usable(s)):undefined;
        return [l,s].some(quote=>nativeTakerFeeRate(quote,now)===undefined)||
          makerSide!==undefined&&nativeMakerFeeRate(makerSide==='long'?l:s,now)===undefined;
      };
      const currentProfitContinuation=['closing','attention'].includes(p.status)&&currentClose&&p.closeProfitRequired===true;
      if(this.config.mode==='live'&&(p.status==='open'||currentProfitContinuation)&&this.liveUnlocked&&[p.long.exchange,p.short.exchange].every(x=>this.hasLiveAccess(x))&&
        feesMissing()){
        const candidate=evaluateHoldingDecision(this.economicsPosition(p),usable(l),usable(s),this.config,now,false);
        if(candidate.action==='close'){
          const preview=exit.entryPolicy!=='aligned'?confirmHoldingDecision(candidate,this.feeExitPreviewSamples.get(p.id),l?quoteObservedAt(l):0,s?quoteObservedAt(s):0,this.config.adaptiveConfirmations??3):undefined;
          if(preview?.confirmation)this.feeExitPreviewSamples.set(p.id,preview.confirmation);
          const ready=exit.entryPolicy==='aligned'?candidate.exitSignal==='profit'||this.fundingExitStability.evaluate(this.economicsPosition(p),usable(l),usable(s),
            assessAlignedExit(this.economicsPosition(p),usable(l),usable(s),this.config,now,false,undefined,{pricing:'best-opposite',requireNativeFees:false}),this.config,now).passes:
            preview?.decision.action==='close';
          if(ready){
            if(this.running&&this.config.profitExitExecutionMode==='ioc'&&exit.entryPolicy==='aligned'&&!nativeExitReadsPrepared){
              this.dispatchHoldingExitReads(p);return;
            }
            if(!nativeExitReadsPrepared){
              try{await this.refreshExecutionSnapshots(p.base,[p.long.exchange,p.short.exchange]);}
              catch{/* No validated native fee/price means no new automatic close permission. */}
            }
            l=this.snapshot(p.long.exchange,p.base);s=this.snapshot(p.short.exchange,p.base);now=Date.now();
            if(candidate.exitSignal==='profit'&&feesMissing()){
              const reference=evaluateHoldingDecision(this.economicsPosition(p),usable(l),usable(s),this.config,now,false);
              profitFeesPending=reference.action==='close'&&reference.exitSignal==='profit';
            }
          }
        }else this.feeExitPreviewSamples.delete(p.id);
      }else this.feeExitPreviewSamples.delete(p.id);
      const raw=evaluateHoldingDecision(this.economicsPosition(p),usable(l),usable(s),this.config,now);
      if(exit.entryPolicy==='aligned'){
        const assessment=assessAlignedExit(this.economicsPosition(p),usable(l),usable(s),this.config,now);
        const stability=this.fundingExitStability.evaluate(this.economicsPosition(p),usable(l),usable(s),assessment,this.config,now);
        const {passes,...evidence}=stability;
        const profitClose=raw.action==='close'&&raw.exitSignal==='profit';
        const close=raw.action==='close'&&(profitClose||passes)&&!profitFeesPending;
        const action=close?'close':profitFeesPending?'wait':raw.action==='hold'||['positive','neutral','projection-wait'].includes(evidence.status)?'hold':'wait';
        p.holdDecision={...raw,action,fundingExitStability:evidence,exitSignal:close?raw.exitSignal:undefined,
          reason:profitFeesPending?'参考可平净收益已超过退出门槛，账户实际平仓手续费尚未确认，等待按需核对；本轮未提交自动平仓':
            profitClose||passes?raw.reason:`${evidence.reason}${assessment?.profit&&assessment.profit.netPnlUsd<=exitProfitThresholdUsd(p,this.config)?`；${raw.reason}`:''}`};
        this.holdingSamples.delete(p.id);
      }else{
        const result=confirmHoldingDecision(raw,this.holdingSamples.get(p.id),l?quoteObservedAt(l):0,s?quoteObservedAt(s):0,this.config.adaptiveConfirmations??3);
        p.holdDecision=result.decision;
        if(result.confirmation)this.holdingSamples.set(p.id,result.confirmation);else this.holdingSamples.delete(p.id);
      }
    }
    if(this.config.mode==='live'&&(!this.liveUnlocked||![p.long.exchange,p.short.exchange].every(x=>this.hasLiveAccess(x)))){
      p.riskReasons=['实盘只读锁定，仓位仅展示；未执行自动平仓或撤单'];return;
    }
    // Only a close owned by this process or an explicitly reconciled manager may resume holding.
    // Fresh matching accounts alone cannot release a historical attention record into automatic management.
    if((currentClose||this.reconciledPositions.has(p.id))&&exit.holdMode==='adaptive'&&
      p.closeProfitRequired===true&&p.closeRequestedAt!==undefined&&!this.store.data.killSwitch){
      let pauseReason=p.closePauseReason;
      if(!pauseReason&&exit.entryPolicy==='aligned'){
        const usable=(q:MarketSnapshot|undefined)=>q&&!this.unavailableSnapshots.has(this.snapshotKey(q.exchange,p.base))&&
          ['online','degraded'].includes(this.health.find(h=>h.exchange===q.exchange)?.status??'')?q:undefined;
        // Reference profit prevents carry alone from cancelling an eligible continuation. It cannot
        // authorize orders: every new batch still checks actual account fees and its exact IOC limits.
        const referenceProfit=assessBestOppositeProfitExit(this.economicsPosition(p),usable(l),usable(s),this.config,now,undefined,undefined,false);
        const assessment=assessAlignedExit(this.economicsPosition(p),usable(l),usable(s),this.config,now,false,undefined,{pricing:'best-opposite',requireNativeFees:false});
        const stability=this.fundingExitStability.evaluate(this.economicsPosition(p),usable(l),usable(s),assessment,this.config,now);
        if(!alignedExitProfitsPass(p,referenceProfit,this.config)&&['positive','neutral','projection-wait'].includes(stability.status)){
          pauseReason=stability.reason;
          const {passes,...evidence}=stability;
          if(p.holdDecision)p.holdDecision={...p.holdDecision,action:'hold',exitSignal:undefined,reason:pauseReason,fundingExitStability:evidence};
        }
      }else if(!pauseReason&&p.holdDecision?.action==='hold')pauseReason=p.holdDecision.reason;
      if(pauseReason){
        if(this.execution.suspendAutomaticClose(p,pauseReason)){
          this.continuingClosePositions.delete(p.id);this.pendingCloseChecks.delete(p.id);
          this.holdingSamples.delete(p.id);this.feeExitPreviewSamples.delete(p.id);this.fundingExitStability.forget(p.id);
        }
        // Unknown orders and unmatched tails still require the original reconciliation/repair path.
        if(p.closeRequestedAt===undefined||p.closePauseReason)return;
      }
    }
    // A current-session close request keeps managing confirmed residuals after the first IOC round.
    // Restarts and ordinary attention states never create an implicit financial action.
    if(this.continuingClosePositions.has(p.id)&&p.closeRequestedAt!==undefined){
      if(this.exitPendingCoin(p)){
        if(now-(this.pendingCloseChecks.get(p.id)??0)<this.config.pollIntervalMs)return;
        this.pendingCloseChecks.set(p.id,now);
        if(this.running){this.dispatchPendingCloseRead(p);return;}
        try{await this.execution.reconcilePending(p.id);}
        catch{p.status='attention';p.riskReasons=['平仓未完成：存在未确认订单，等待订单对账，禁止重复下单'];return;}
      }
      if(this.config.mode==='live'){
        if(!this.closeAccountsFresh(p,now)){p.riskReasons=['平仓继续处理前等待新鲜账户数量核对；未新增减仓'];return;}
        if(!this.accountMatchesPosition(p)){p.status='attention';p.riskReasons=['平仓未完成：实际仓位尚未与成交记录核对一致'];return;}
      }
      if(!realtimeProfitWake&&p.closeAttemptedAt!==undefined&&now-p.closeAttemptedAt<this.config.pollIntervalMs)return;
      try{await this.continueClosing(p,p.closeReason??'继续处理已确认平仓残余',undefined,makerPreparation);}
      catch{p.status='attention';p.riskReasons=['平仓未完成，等待有效盘口或订单核验'];}
      return;
    }
    // An entry submitted in this process may continue reducing its confirmed unmatched tail.
    // The execution registry is not restored from saved attention records and cannot expand a position.
    if(p.closeRequestedAt===undefined&&this.execution.hasPendingEntryRollback(p)){
      if(this.pendingCoin(p.base)||this.config.mode==='live'&&!this.canResumeConditionalHolding(p))return;
      this.financialEpoch++;
      try{await this.execution.continueEntryRollback(p);}
      finally{this.financialEpoch++;}
      return;
    }
    if(p.status!=='open')return;
    // Position policy: no automatic risk exits. A position leaves only through its hold mode (once: after the settlement;
    // adaptive: the holding decision) or by the user. Without fresh quotes on both legs no limit price can be built, so
    // management just waits for the next tick instead of freezing the coin as 'attention'.
    const unavailable=!quoteIsFresh(l,this.config,now)||!quoteIsFresh(s,this.config,now)||
      [p.long,p.short].some(leg=>this.unavailableSnapshots.has(this.snapshotKey(leg.exchange,p.base)));
    const disconnected=[p.long,p.short].some(leg=>this.unavailableSnapshots.has(this.snapshotKey(leg.exchange,p.base)));
    p.riskReasons=unavailable?[disconnected?'行情断连：本轮暂停管理，恢复后自动继续':'行情暂不可用：本轮暂停管理，行情恢复后自动继续']:[];
    if(unavailable)return;
    if(exit.holdMode==='adaptive'&&p.holdDecision?.action==='hold')p.plannedExitAt=p.holdDecision.targetFundingTime+this.config.exitDelaySec*1000;
    const scheduled=exit.holdMode==='once'&&now>=p.plannedExitAt;
    const adaptiveClose=exit.holdMode==='adaptive'&&p.holdDecision?.action==='close';
    if(scheduled||adaptiveClose){
      try{await this.continueClosing(p,scheduled?'单次资金费周期结束':p.holdDecision!.reason,undefined,makerPreparation);}
      catch{p.status='attention';this.halt(`${p.base} 自动平仓无法完成，需要核对订单或行情`,p.base);}
    }
  }
  async verifyFundingCandidate(id:string):Promise<Opportunity|undefined>{return this.exclusive(async()=>{
    if(!this.usesFundingStatistics())throw new Error('当前模式未接入全市场资金费率候选');
    const candidate=this.fundingCandidates().find(c=>c.id===id||`${c.base}-${c.shortExchange}-${c.longExchange}`===id);
    if(!candidate)throw new Error('资金费率候选不存在、来源不可用或已过期');
    const now=Date.now();
    if(!this.fundingWatch.has(candidate.base)&&this.fundingWatch.size>=FUNDING_WATCH_LIMIT){
      const oldest=[...this.fundingWatch.entries()].sort((a,b)=>Number(a[1].manual)-Number(b[1].manual)||a[1].selectedAt-b[1].selectedAt)[0];
      if(oldest)this.fundingWatch.delete(oldest[0]);
    }
    this.fundingWatch.set(candidate.base,{candidate,selectedAt:now,expiresAt:now+this.fundingWatchDurationMs(true),manual:true});this.fundingChecked.set(candidate.id,now);
    // Public data only. Verification never calls account preparation, order placement, or position management.
    const exchanges=[candidate.longExchange,candidate.shortExchange];
    const successful=await Promise.all(exchanges.map(x=>{
      const adapter=this.adapter(x),quote=adapter.getExecutionSnapshot?.(candidate.base);
      if(quote?.exchange===x&&quote.base===candidate.base&&quoteIsFresh(quote,this.config)){
        // A genuine current pushed book already has fresh contract/funding
        // metadata. A public lookup must not queue a redundant slow REST read.
        this.snapshots=this.snapshots.filter(s=>s.exchange!==x||s.base!==candidate.base).concat(quote);
        this.unavailableSnapshots.delete(this.snapshotKey(x,candidate.base));
        return true;
      }
      return this.refreshAdapter(adapter,[candidate.base],false);
    }));
    // Quotes older than maxSnapshotAgeMs are discarded below; remember which ones, so the user is told instead of seeing a blank result.
    const staleAfterFetch=exchanges.flatMap(x=>{const s=this.snapshot(x,candidate.base);return s&&!quoteIsFresh(s,this.config)?[`${x} 的 ${candidate.base} 盘口已超过 ${Math.round(this.config.maxSnapshotAgeMs/1000)} 秒未重新读取，请等待新盘口`]:[];});
    this.recordSpreadObservations(Date.now());
    this.pruneSnapshots(Date.now());this.opportunities=this.detailedOpportunities(Date.now());
    const fail=(message:string)=>{this.verifyFailures.set(id,{message,at:Date.now()});return undefined;};
    // Say WHY there is no detail instead of silently returning nothing: the screen otherwise looks like "not verified".
    if(!successful.every(Boolean)){
      const bad=exchanges.filter((_,i)=>!successful[i]);
      return fail(bad.map(x=>`${x} 没有取得 ${candidate.base} 的有效盘口：${this.health.find(h=>h.exchange===x)?.error??'该交易所可能没有此币种的 USDT 永续合约，或请求失败'}`).join('；'));
    }
    if(!this.fundingCandidates().some(c=>fundingPairKey(c)===fundingPairKey(candidate)))return fail('该组合已不在最新的全市场统计中，或统计已过期');
    const found=this.opportunities.find(o=>fundingPairKey(o)===fundingPairKey(candidate));
    if(!found)return fail(staleAfterFetch.length?staleAfterFetch.join('；'):'两腿盘口数据不完整，无法计算价差与收益');
    this.verifyFailures.delete(id);
    return found;
  });}
  private readonly verifyFailures=new Map<string,{message:string;at:number}>();
  /** Why the latest manual verification produced no detail (kept for 5 minutes). */
  verificationFailure(id:string):string|undefined{const f=this.verifyFailures.get(id);return f&&Date.now()-f.at<300000?f.message:undefined;}
  /** Compatibility path for in-process callers: a queued click still expires before any order submission. */
  async open(id:string){
    const createdAt=Date.now(),generation=this.startGeneration;
    const operationId=this.beginOperation({positionId:`entry-pending-${randomUUID()}`,base:manualEntryOpportunityBase(id)??id,
      origin:'manual',kind:'entry',protocol:this.config.entryExecutionMode??'ioc',target:{long:null,short:null}});
    return this.exclusive(async()=>{try{
      if(Date.now()-createdAt>=MANUAL_ENTRY_QUEUE_MS)throw new ManualEntryCancelled('排队超过 5 秒，本次开仓已取消，未提交订单');
      const context:ManualEntryContext={generation,operationId,ensure:()=>{if(Date.now()-createdAt>=MANUAL_ENTRY_DEADLINE_MS)throw new ManualEntryCancelled('本次开仓已过期，未提交订单');},stage:()=>{}};
      return await this.openInternal(id,false,context);
    }catch(error){this.operationPreflightFailed(operationId,error);throw error;}
    });
  }
  /** Immediate HTTP receipt. This is never awaited by the request handler or automatically retried. */
  requestManualEntry(id:string,operationId:string,expiresAt:number,acknowledgement?:'OPEN_LIVE_HEDGE'):ManualEntryOperation{
    const previous=this.manualEntries.get(operationId);
    if(previous){if(previous.opportunityId!==id)throw new Error('同一操作标识不能用于不同机会');return previous;}
    if(this.stopping)throw new Error('服务正在停止，未接收开仓请求');
    const base=manualEntryOpportunityBase(id)??id;
    const pending=this.store.data.manualEntryOperations?.find(operation=>(operation.result?.base??manualEntryOpportunityBase(operation.opportunityId))===base&&['queued','checking','preparing','submitting','reconciling'].includes(this.manualEntries.get(operation.id)?.state??''));
    if(pending)throw new Error(`该币种开仓请求正在处理，请查看原操作 ${pending.id}，不要重复点击`);
    const {operation,created}=this.manualEntries.create(operationId,id,expiresAt);
    if(!created||!operation.cancelable)return operation;
    const diagnosticId=this.beginOperation({id:operationId,positionId:`entry-pending-${operationId}`,base,
      origin:'manual',kind:'entry',protocol:this.config.entryExecutionMode??'ioc',target:{long:null,short:null}});
    const generation=this.startGeneration;
    const context:ManualEntryContext={generation,operationId:diagnosticId,ensure:()=>{this.manualEntries.ensure(operationId);if(generation!==this.startGeneration||this.stopping)throw new ManualEntryCancelled('本次开仓已取消，未提交订单');},
      stage:(state,message)=>this.manualEntries.stage(operationId,state,message),attachPosition:position=>this.manualEntries.attachPosition(operationId,position),commit:()=>{this.manualEntries.commit(operationId);this.pendingManualPermission=undefined;},reconciling:()=>this.manualEntries.reconciling(operationId),fail:(error,position)=>this.manualEntries.fail(operationId,error,position)};
    void this.exclusive(async()=>{
      let restorePermission:(()=>void)|undefined;
      try{
        this.manualEntries.begin(operationId);
        if(diagnosticId)this.diagnostic(()=>this.store.operations.stage(diagnosticId,'preparationStartedAt'));
        if(this.config.mode==='live'&&acknowledgement==='OPEN_LIVE_HEDGE')restorePermission=await this.activateManualEntry(id,context);
        const position=await this.openInternal(id,false,context);this.manualEntries.complete(operationId,position);
      }
      catch(error){this.operationPreflightFailed(diagnosticId,error);const recorded=this.manualEntries.get(operationId),position=this.store.data.positions.find(p=>p.id===recorded?.positionId);this.manualEntries.fail(operationId,safeMessage(error),position);}
      finally{if(restorePermission&&!this.manualEntries.get(operationId)?.ordersSubmitted)restorePermission();}
    }).catch(error=>this.tickFailed(error));
    return operation;
  }
  manualEntryOperation(id:string,renew=false){return this.manualEntries.get(id,renew);}
  cancelManualEntry(id:string){const result=this.manualEntries.cancel(id);if(result?.state==='cancelled')this.operationPreflightFailed(id,new ManualEntryCancelled(result.message));return result;}
  /** One explicit manual click authorizes only its two venues after fresh read-only checks. It never starts auto. */
  private async activateManualEntry(id:string,manual:ManualEntryContext):Promise<(()=>void)|undefined>{
    manual.ensure();this.assertCredentialsStable();
    const opportunity=this.detailedOpportunities(Date.now()).find(row=>row.id===id);
    if(!opportunity||!(opportunity.entryReady??opportunity.eligible))throw new Error(opportunity?.reasons.filter(reason=>!reason.includes('实盘执行锁定')).join('；')||'手动开仓条件尚未满足，请等待盘口与账户核验');
    const exchanges=[opportunity.longExchange,opportunity.shortExchange];
    if(exchanges.every(exchange=>this.hasLiveAccess(exchange)))return;
    const environment=inspectLiveEnvironment(this.options.liveEnvironment??process.env);
    if(exchanges.some(exchange=>!environment.exchanges.some(venue=>venue.exchange===exchange&&venue.supported&&venue.credentialsConfigured)))throw new Error('该机会两腿账户凭据尚未完整配置，未提交订单');
    if(this.store.data.killSwitch)throw new Error('已手动紧急停止，新开仓暂停');
    manual.stage('checking','手动开仓：正在并行读取所选两腿账户，自动策略保持原状态');
    const accounts=new Map<ExchangeId,AccountState>();
    await Promise.all(exchanges.map(async exchange=>{
      try{accounts.set(exchange,await this.readTradingAccount(this.adapter(exchange)));}
      catch(error){throw tradingError(exchange,'账户检查',error);}
    }));manual.ensure();
    for(const exchange of exchanges){
      const account=accounts.get(exchange)!;
      if(!this.cacheAccount(exchange,account))throw new Error(`${exchange} 账户核对结果已过期或已有更新结果，请重新核验`);
      this.checkAccount(exchange,account);
      const quantity=exchange===opportunity.longExchange?opportunity.longQuantity:opportunity.shortQuantity;
      if(account.freeUsd<this.requiredMarginUsd(exchange,quantity*this.snapshot(exchange,opportunity.base)!.markPrice,opportunity.base))throw new Error(`${exchange} 合约可用余额不足`);
    }
    const occupied=this.coinExclusions().find(coin=>coin.base===coinBase(opportunity.base));
    if(occupied)throw new Error(`${opportunity.base}：${occupied.reasons.join('；')}`);
    manual.stage('checking','手动开仓：正在并行核对所选两腿的具体合约，尚未修改杠杆或下单');
    const symbols=new Map<ExchangeId,string>();
    await Promise.all(exchanges.map(async exchange=>{
      const adapter=this.adapter(exchange),symbol=this.snapshot(exchange,opportunity.base)!.symbol;symbols.set(exchange,symbol);
      if(!adapter.inspectTrading)throw new Error(`${exchange} 不支持该合约只读执行检查`);
      try{await this.boundedPrivateRead(adapter,`manual-contract:${symbol}:${this.config.leverage}`,()=>adapter.inspectTrading!(symbol,this.config.leverage));}
      catch(error){throw tradingError(exchange,'合约检查',error);}
    }));manual.ensure();
    await Promise.all(exchanges.map(exchange=>this.refreshTradingFee(this.adapter(exchange),symbols.get(exchange)!)));manual.ensure();
    for(const exchange of exchanges){
      const snapshot=this.snapshot(exchange,opportunity.base)!,quantity=exchange===opportunity.longExchange?opportunity.longQuantity:opportunity.shortQuantity;
      if(nativeTakerFeeRate(snapshot)===undefined)throw new Error(`${exchange} 当前合约手续费仍在同步，未提交订单`);
      if(accounts.get(exchange)!.freeUsd<this.requiredMarginUsd(exchange,quantity*snapshot.markPrice,opportunity.base,true))throw new Error(`${exchange} 合约可用余额不足`);
    }
    if(manual.generation!==this.startGeneration||this.store.data.killSwitch)throw new ManualEntryCancelled('本次手动开仓已取消，未提交订单');
    const previousPermission=this.sessionLivePermission,previousExchanges=this.sessionExchanges,previousEnvironment=this.liveEnvironment;
    const existing=this.liveUnlocked?this.liveVenues().map(venue=>venue.exchange):[];
    const grantedExchanges=new Set([...existing,...exchanges]);
    this.liveEnvironment=environment;this.sessionExchanges=grantedExchanges;this.sessionLivePermission=true;
    const restore=()=>{
      // A stale pre-submission failure cannot overwrite a newer pause/revoke/credential change.
      if(this.startGeneration!==manual.generation||!this.sessionLivePermission||this.sessionExchanges!==grantedExchanges||this.liveEnvironment!==environment){
        if(this.pendingManualPermission?.restore===restore)this.pendingManualPermission=undefined;return;
      }
      this.sessionLivePermission=previousPermission;this.sessionExchanges=previousExchanges;this.liveEnvironment=previousEnvironment;
      if(this.pendingManualPermission?.restore===restore)this.pendingManualPermission=undefined;
    };
    try{this.store.log('info',`${opportunity.base} 手动开仓已完成两腿账户和合约核验：仅授权 ${exchanges.join(' / ')}；自动开仓未因此启动`);}
    catch(error){restore();throw error;}
    manual.preflight={accounts,checkedAt:Date.now(),symbols};
    this.pendingManualPermission={restore};
    for(const exchange of exchanges)this.entryContractPreviews.set(this.contractPreviewKey(exchange,symbols.get(exchange)!),{status:'ready',at:Date.now()});
    return restore;
  }
  private async openInternal(id:string,automatic=false,manual?:ManualEntryContext){
    let operationId=manual?.operationId;
    try{
    this.assertCredentialsStable();
    const generation=manual?.generation??this.startGeneration;
    const ensureClick=()=>{manual?.ensure();if(generation!==this.startGeneration||this.stopping||automatic&&!this.autoEnabled)throw new ManualEntryCancelled('本次开仓已取消，未提交订单');};
    ensureClick();
    this.assertLiveAccess();
    if(this.store.data.killSwitch)throw new Error('风险开关已触发，请先处理风险');
    if(this.config.mode==='live'&&!this.liveUnlocked)throw new Error('实盘未解锁');
    const o=this.detailedOpportunities(Date.now()).find(o=>o.id===id);
    if(!o||!o.eligible)throw new Error(o?.reasons.join('；')||o?.spreadAdvantage?.reason||'机会已过期');
    if(automatic){if(pendingManualEntryBases(this.store.data.manualEntryOperations??[]).has(o.base))throw new Error('该币种已有手动开仓请求，等待原操作完成');
      if(this.automaticProductRejectionUntil(o))throw new Error('该自动路线产品准入仍在冷却，等待到期后重新完整核验；未提交订单');
      this.assertAutomaticFundingOpportunity(o);
      if(!this.automaticEntryAttempts.claim(o.base))throw new Error('该币种自动入场仍在重试间隔，未提交订单');}
    if(this.activePositions().some(p=>p.base===o.base))throw new Error('同币种已有持仓或待处理订单');
    operationId??=this.beginOperation({positionId:`entry-pending-${randomUUID()}`,base:o.base,origin:automatic?'automatic':'manual',
      kind:'entry',protocol:this.config.entryExecutionMode??'ioc',target:{long:o.longQuantity,short:o.shortQuantity}});
    if(operationId)this.diagnostic(()=>this.store.operations.stage(operationId!,'preparationStartedAt'));
    const exchanges=[o.longExchange,o.shortExchange];
    const balances=new Map<ExchangeId,number>();
    for(const x of exchanges){
      if(this.config.mode==='live')this.assertLiveAccess(x);
      else balances.set(x,this.paperBalance(x));
    }
    if(this.config.mode==='live'){
      manual?.stage('checking','正在并行核对两腿账户和余额，尚未提交订单');ensureClick();
      // Account reads are independent; wait for both before publishing their results or preparing trading.
      const prepared=manual?.preflight;
      const reusable=prepared&&Date.now()-prepared.checkedAt<=8000&&exchanges.every(exchange=>prepared.accounts.has(exchange)&&prepared.symbols.get(exchange)===this.snapshot(exchange,o.base)?.symbol);
      const reads=await Promise.allSettled(exchanges.map(x=>reusable?Promise.resolve(prepared!.accounts.get(x)!):this.readTradingAccount(this.adapter(x))));
      ensureClick();
      for(let i=0;i<reads.length;i++)if(reads[i].status==='rejected')this.accountReadFailed(exchanges[i]);
      for(let i=0;i<reads.length;i++){
        const result=reads[i],x=exchanges[i];
        if(result.status==='rejected')throw tradingError(x,'账户检查',result.reason);
      }
      for(let i=0;i<reads.length;i++){
        const a=(reads[i] as PromiseFulfilledResult<AccountState>).value,x=exchanges[i];
        if(!this.cacheAccount(x,a))throw new Error(`${x} 账户核对结果已过期或已有更新结果，请重新核验`);
        this.checkAccount(x,a);balances.set(x,a.freeUsd);
      }
      if(this.store.data.killSwitch)throw new Error('账户对账未通过');
      const exclusion=this.coinExclusions().find(item=>item.base===coinBase(o.base));
      if(exclusion)throw new Error(`${o.base}：${exclusion.reasons.join('；')}`);
    }
    ensureClick();
    if(this.config.mode==='live'){
      manual?.stage('checking','正在并行核对两腿合约、持仓模式及挂单，尚未提交订单');ensureClick();
      // Complete both legs' read-only mode/position/order checks before the first leverage write.
      const exactPreflight=manual?.preflight&&Date.now()-manual.preflight.checkedAt<=8000&&
        exchanges.every(exchange=>manual.preflight!.symbols.get(exchange)===this.snapshot(exchange,o.base)?.symbol);
      if(!exactPreflight)await Promise.all([o.longExchange,o.shortExchange].map(async x=>{
        try{await this.adapter(x).inspectTrading?.(this.snapshot(x,o.base)!.symbol,this.config.leverage);}
        catch(error){throw tradingError(x,'合约检查',error);}
      }));
      await Promise.all(exchanges.map(exchange=>this.refreshTradingFee(this.adapter(exchange),this.snapshot(exchange,o.base)!.symbol)));
      ensureClick();
    }
    for(const x of exchanges){
      const balance=balances.get(x)!;
      const snapshot=this.snapshot(x,o.base)!,legQuantity=x===o.longExchange?o.longQuantity:o.shortQuantity;
      if(this.config.mode==='live'&&nativeTakerFeeRate(snapshot)===undefined)throw new Error(`${x} 当前合约手续费仍在同步，未提交订单`);
      if(balance<this.requiredMarginUsd(x,legQuantity*snapshot.markPrice,o.base,true))throw new Error(`${x} 合约可用余额不足`);
    }
    if(this.config.mode==='live'&&!(manual?.tradingPrepared&&manual.preflight&&Date.now()-manual.preflight.checkedAt<=8000)){
      manual?.stage('preparing','正在并行准备两腿合约参数，尚未提交订单');ensureClick();
      // The venues are independent. Both read-only checks already passed; await BOTH preparations even if one fails.
      // An early rejection must not release the execution queue while the other venue is still preparing its parameters.
      const preparations=await Promise.allSettled(exchanges.map(async x=>{
        ensureClick();
        try{await this.adapter(x).prepareTrading(this.snapshot(x,o.base)!.symbol,this.config.leverage);}
        catch(error){throw tradingError(x,'杠杆准备',error);}
      }));
      ensureClick();
      for(const result of preparations)if(result.status==='rejected')throw result.reason;
    }
    // Freshness checked again after private account calls, before either leg is submitted.
    if(this.store.data.killSwitch)throw new Error('下单前风险开关已触发');
    manual?.stage('preparing','正在刷新两腿盘口并完成提交前复核，尚未提交订单');ensureClick();
    if(this.config.mode==='live')await this.refreshExecutionSnapshots(o.base,exchanges);
    ensureClick();
    const refreshed=this.detailedOpportunities(Date.now(),undefined,this.config.mode==='live').find(x=>x.id===id);
    if(!refreshed?.eligible)throw new Error(`下单前复核未通过：${refreshed?.reasons.join('；')||'机会或多空方向已变化'}`);
    if(automatic)this.assertAutomaticFundingOpportunity(refreshed);
    const l=this.snapshot(o.longExchange,o.base)!,s=this.snapshot(o.shortExchange,o.base)!;
    const p:Position={id:randomUUID(),base:o.base,status:'opening',mode:this.config.mode,automaticEntry:automatic,paperFeeOnly:this.config.mode==='paper'&&this.paperFeeOnly(),feeOnly:this.config.feeOnly===true,entryPolicy:refreshed.entryPolicy??this.config.entryPolicy??'dual',
      long:{exchange:l.exchange,symbol:l.symbol,side:'long',quantity:0,entryPrice:0,markPrice:l.markPrice,feesUsd:0,liquidationDistancePct:null},
      short:{exchange:s.exchange,symbol:s.symbol,side:'short',quantity:0,entryPrice:0,markPrice:s.markPrice,feesUsd:0,liquidationDistancePct:null},
      openedAt:Date.now(),plannedExitAt:o.exitTime,holdMode:this.config.holdMode,fundingUsd:0,feesUsd:0,transferCostUsd:o.transferCostUsd,
      spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
    const automaticAssessment=automaticEntryAssessment(refreshed);
    p.executionEvidence={version:1,method:p.entryPolicy==='aligned'?(this.config.entryExecutionMode??'ioc'):'ioc',entryPath:automatic?(automaticAssessment.route??'legacy'):'manual',
      ...(automatic&&refreshed.fundingEntryStability?.evidence?{fundingEntryStability:structuredClone(refreshed.fundingEntryStability.evidence)}:{}),
      prediction:{fundingUsd:refreshed.expectedFundingUsd,singleCycleNetUsd:refreshed.combinedExpectedNetUsd??refreshed.expectedNetUsd,
        ...(Number.isFinite(refreshed.entryPriceEdgeBps)?{rawOppositeEdgeBps:refreshed.entryPriceEdgeBps!}:{})}};
    manual?.attachPosition?.(p);this.store.data.positions.unshift(p);this.store.save();
    if(operationId)this.diagnostic(()=>this.store.operations.attach(operationId!,p.id,{long:o.longQuantity,short:o.shortQuantity}));
    if(automatic)this.automaticEntryScopes.set(p,{generation,config:this.config});
    try{await this.execution.open(p,o.longQuantity,o.shortQuantity,async(phase,batchQuantities)=>{
      if(phase!=='supplement')ensureClick();
      if(generation!==this.startGeneration||automatic&&!this.autoEnabled||this.store.data.killSwitch)throw new Error('本次开仓已取消');
      const latest=this.detailedOpportunities(Date.now(),p.id,this.config.mode==='live').find(next=>next.id===id);
      if(!latest)throw new Error('最终行情已改变资金费优势或多空方向');
      // New automatic expansion must qualify again. Completing an already-filled
      // counterpart remains subject to the existing hedge-repair checks below.
      if(automatic&&phase!=='supplement'){
        this.assertAutomaticFundingOpportunity(latest);
      }
      // Initial entry evaluates the whole hypothetical pair; a supplement instead evaluates the
      // already-filled prices plus its actual limit in Execution. Only mechanical checks apply here.
      const fundingRepair=phase==='supplement'&&(p.entryPolicy??'dual')==='funding';
      const alignedRepair=(phase==='supplement'||phase==='batch')&&p.entryPolicy==='aligned';
      // These rows describe a hypothetical new FULL pair. The actual supplementary IOC size,
      // matched closing depth, fees and profit are checked independently by Execution before it journals an order.
      const fullPairChecks=new Set(['四边开平仓盘口够成交整笔数量','当前开平仓盘口可估算往返成本','数量达到交易所最小下单量','实际 IOC 限价净收益达标']);
      // Timing selects a NEW hedge. Once an opening intent exists, it must never block
      // completing the already-filled hedge or independently checked committed batches.
      const alignedFullPairChecks=new Set(['双腿开仓盘口够成交整笔数量','数量达到交易所最小下单量','开多均价低于开空均价','实际 IOC 开仓价格优势达标','异步资金费入场时点合适']);
      const failures=phase==='supplement'||phase==='batch'?(latest.checks??[]).filter(check=>check.pass===false&&
        ['market','timing','account','execution'].includes(check.group)&&!(fundingRepair&&fullPairChecks.has(check.label))&&
        !(alignedRepair&&(alignedFullPairChecks.has(check.label)||check.label==='两腿保证金可用'))).map(check=>check.reason):latest.reasons;
      if(failures.length)throw new Error(failures.join('；'));
      if((latest.entryPolicy??'dual')!==p.entryPolicy)throw new Error('入场算法已改变，停止继续开仓');
      if(phase==='supplement'&&!fundingRepair&&!alignedRepair&&latest.spreadAdvantage?.status!=='ready')throw new Error('补单等待有效退出盘口估算');
      if(this.snapshot(latest.longExchange,p.base)?.symbol!==p.long.symbol||this.snapshot(latest.shortExchange,p.base)?.symbol!==p.short.symbol)throw new Error('最终合约与准备合约不一致');
      for(const exchange of [latest.longExchange,latest.shortExchange]){
        const leg=exchange===latest.longExchange?p.long:p.short;
        // The original budget is frozen when entry commits. Index-price drift never grows that goal.
        // Subsequent batches need margin only for remaining expansion, not another complete pair.
        const scopedQuantity=exchange===latest.longExchange?batchQuantities?.longQuantity:batchQuantities?.shortQuantity;
        const quantity=p.entryPolicy==='aligned'&&scopedQuantity!==undefined?scopedQuantity:p.entryPolicy==='aligned'&&p.entryExecution?Math.max(0,p.entryExecution.targetQuantity-leg.quantity):
          exchange===latest.longExchange?latest.longQuantity:latest.shortQuantity;
        if(!Number.isFinite(quantity)||quantity<0)throw new Error('本批保证金核验数量无效');
        if(quantity===0)continue; // The opposite leg is already confirmed filled; it needs no new opening margin.
        const top=p.entryPolicy==='aligned'?bestOppositeLevel(this.snapshot(exchange,p.base)!,leg.side==='long'?'buy':'sell')?.price:undefined;
        const price=top!==undefined?top*(leg.side==='long'?1+(this.config.entryIocBufferBps??8)/10000:1):
          exchange===latest.longExchange?latest.spreadAdvantage?.longEntryPrice:latest.spreadAdvantage?.shortEntryPrice;
        const notional=quantity*(price??this.snapshot(exchange,p.base)!.markPrice);
        const required=this.requiredMarginUsd(exchange,notional,p.base,true);
        const available=this.config.mode==='live'?this.accounts.get(exchange)?.freeUsd:this.paperBalance(exchange);
        if(available===undefined||!Number.isFinite(available)||available<required)throw new Error(`${exchange} 最终盘口数量对应的可用余额不足`);
      }
      return latest;
    },()=>{ensureClick();manual?.commit?.();},()=>manual?.reconciling?.());}catch(error){
      this.operationPreflightFailed(operationId,error);
      const hasIntent=this.store.data.orders.some(order=>order.positionId===p.id);
      if(!hasIntent&&p.long.quantity===0&&p.short.quantity===0){p.status='closed';p.closedAt=Date.now();p.riskReasons=[];
        const productRejected=this.rememberAutomaticProductRejection(p,error,id);
        this.store.log('warn',`${p.base} 双腿下单前校验失败，未提交订单：${safeMessage(error)}${productRejected?'；仅此自动路线冷却 5 分钟，到期后重新完整核验':''}`,p.id);}
      else{p.status='attention';this.halt(`${p.base} 执行异常，请检查残余仓位`,p.base);}
      manual?.fail?.(safeMessage(error),p);
    }finally{this.automaticEntryScopes.delete(p);}
    if(p.closeRequestedAt!==undefined)this.continuingClosePositions.add(p.id);
    if(p.status!=='open'&&this.store.data.orders.some(order=>order.positionId===p.id))this.entryCooldowns.set(coinBase(p.base)!,Date.now()+ENTRY_RETRY_COOLDOWN_MS);
    return p;
    }catch(error){this.operationPreflightFailed(operationId,error);throw error;}
  }
  async close(id:string,request?:ManualCloseRequest){
    if(request)return this.requestScopedClose(request,id);
    return this.exclusive(async()=>{this.assertLiveAccess();const p=this.store.data.positions.find(p=>p.id===id);if(!p)throw new Error('仓位不存在');
      if(p.manualCloseOnly)throw new Error('该记录仅允许按当前账户数量明确确认后平仓');
      for(const leg of [p.long,p.short].filter(l=>l.quantity>0))this.assertLiveAccess(leg.exchange);await this.continueClosing(p,'手动平仓',{requireProfit:false});return p;});
  }
  async closeAccountPosition(request:ManualCloseRequest){return this.requestScopedClose(request);}
  private requestScopedClose(request:ManualCloseRequest,sourceId?:string):Promise<Position>{
    if(!request||!/^[-\w]{8,80}$/.test(request.operationId)||request.acknowledgement!==(sourceId?'CLOSE_SELECTED_POSITION':'CLOSE_SELECTED_ACCOUNT_POSITION')||
      !Number.isFinite(request.expiresAt)||!Array.isArray(request.legs)||request.legs.length<1||request.legs.length>2)
      return Promise.reject(new Error('缺少有效的单次平仓确认，请刷新后重新选择'));
    // Canonicalized selection is persisted before the queue. Replaying a click never sends another order.
    const selection=JSON.stringify({sourceId:sourceId??null,base:request.base,acknowledgement:request.acknowledgement,
      legs:request.legs.map(leg=>({exchange:leg.exchange,symbol:leg.symbol,side:leg.side,quantity:leg.quantity,accountPositionKey:leg.accountPositionKey,
        positionOpenedAt:leg.positionOpenedAt??null})).sort((a,b)=>`${a.exchange}:${a.symbol}:${a.side}`.localeCompare(`${b.exchange}:${b.symbol}:${b.side}`))});
    const records=this.store.data.manualCloseOperations??= [],old=records.find(record=>record.id===request.operationId);
    if(old){
      if(old.selection!==selection)return Promise.reject(new Error('平仓操作编号已用于另一项选择，请刷新重新确认'));
      const pending=this.manualCloseRequests.get(old.id);if(pending)return pending;
      const position=old.positionId&&this.store.data.positions.find(row=>row.id===old.positionId);
      if(position)return Promise.resolve(position);
      return Promise.reject(new Error(old.error??'该平仓请求已处理或被中断，请刷新账户后重新选择'));
    }
    if(request.expiresAt<=Date.now()||request.expiresAt>Date.now()+60_000)return Promise.reject(new Error('平仓确认已过期，请按最新数量重新确认'));
    this.assertCredentialsStable();
    const record:ManualCloseOperation={id:request.operationId,selection,createdAt:Date.now(),expiresAt:request.expiresAt,state:'checking',...(sourceId?{sourcePositionId:sourceId}:{})};
    const config=this.config,generation=this.startGeneration;
    records.push(record);this.store.save();
    const operationId=this.beginOperation({id:request.operationId,positionId:`close-pending-${request.operationId}`,base:request.base,
      origin:'manual',kind:'manual-close',protocol:'ioc',target:{long:null,short:null}});
    if(sourceId)this.diagnostic(()=>{
      const previous=this.store.operations.current(sourceId);
      if(previous?.origin==='automatic')this.store.operations.intervene(previous.id,'user-retry',request.operationId);
    });
    const task=this.exclusive(async()=>{
      const ensure=()=>{
        if(this.stopping||this.credentialUpdatePending||this.config!==config||this.startGeneration!==generation)throw new Error('运行状态或账户配置已变化，本次平仓已停止');
        if(Date.now()>request.expiresAt)throw new Error('本次平仓确认已过期，未确认残余请刷新后重新选择');
        if(config.mode!=='live')throw new Error('单次账户平仓仅适用于实盘账户');
      };
      try{
        if(operationId)this.diagnostic(()=>this.store.operations.stage(operationId,'preparationStartedAt'));
        ensure();const source=sourceId?this.store.data.positions.find(row=>row.id===sourceId):undefined;
        if(sourceId&&(!source||source.base!==request.base||request.legs.some(target=>![source.long,source.short].some(leg=>leg.exchange===target.exchange&&leg.symbol===target.symbol&&leg.side===target.side))))throw new Error('所选账户行与原策略记录不一致');
        const exchanges=[...new Set(request.legs.map(leg=>leg.exchange))];
        const available=new Set(liveEligibleExchanges(this.liveEnvironment,config.exchanges).map(row=>row.exchange));
        if(exchanges.some(exchange=>!available.has(exchange)))throw new Error('所选交易所尚未配置完整交易凭据');
        // Only inspect old orders. Never cancel, repeat or adopt unrelated execution on this path.
        const relevantOrders=this.store.data.orders.filter(order=>request.legs.some(target=>target.exchange===order.exchange&&target.symbol===order.request.symbol)&&isCurrentUnconfirmedOrder(order,this.store.data.positions));
        for(const journal of relevantOrders){
          const adapter=this.adapter(journal.exchange);if(!adapter.inspectOrder)throw new Error('所选合约存在未确认订单，需先完成原订单核对');
          const result=await this.boundedPrivateRead(adapter,`manual-close-inspect:${journal.request.clientOrderId}`,()=>adapter.inspectOrder!(journal.request,journal.result?.id||undefined));ensure();
          this.execution.applyObservedOrder(journal,result);
        }
        if(relevantOrders.some(order=>isCurrentUnconfirmedOrder(order,this.store.data.positions)))throw new Error('所选合约仍有未确认订单，暂不重复平仓');
        const reads=await Promise.all(exchanges.map(async exchange=>({exchange,account:await this.readTradingAccount(this.adapter(exchange))})));ensure();
        const accounts=new Map(reads.map(row=>[row.exchange,row.account]));
        for(const {exchange,account} of reads)this.cacheAccount(exchange,account);
        const nativeSlots=new Map<string,AccountPosition[]>(),allowNativeSplit=new Set<ExchangeId>();
        for(const target of request.legs){
          const adapter=this.adapter(target.exchange);
          if(!adapter.fetchOpenOrders)throw new Error(`${target.exchange} 无法完整读取所选合约挂单`);
          const open=await this.boundedPrivateRead(adapter,`manual-close-open:${target.symbol}`,()=>adapter.fetchOpenOrders!(target.symbol));ensure();
          if(!Array.isArray(open)||open.some(order=>order.symbol===target.symbol))throw new Error(`${target.exchange} 所选合约仍有挂单，请先处理原挂单`);
          if(target.exchange==='gate'){
            if(!adapter.fetchClosePositions)throw new Error('Gate 原生分仓读取尚不可用');
            const accountRows=accounts.get(target.exchange)!.positions.filter(row=>row.symbol===target.symbol&&row.side===target.side&&row.quantity>0);
            if(accountRows.length===1){
              const raw=await this.boundedPrivateRead(adapter,`manual-close-initial-slots:${target.symbol}`,()=>adapter.fetchClosePositions!(target.symbol));ensure();
              nativeSlots.set(manualCloseLegKey(target.exchange,accountRows[0]),verifyCloseSlots(accountRows[0],raw));allowNativeSplit.add('gate');
            }
          }
        }
        const selected=selectManualCloseLegs(request.base,request.legs,accounts,{allowNativeSplit});ensure();
        const tolerance=(quantity:number)=>Math.max(1e-12,Math.abs(quantity)*Number.EPSILON*8);
        // Reuse the old ledger only when its live quantities and current opening cycle still agree.
        const reusable=source&&isPositionActive(source)&&!source.accountClosure&&[source.long,source.short].every(leg=>{
          const row=selected.find(item=>item.exchange===leg.exchange&&item.position.symbol===leg.symbol&&item.position.side===leg.side)?.position;
          return Math.abs((row?.quantity??0)-leg.quantity)<=tolerance(leg.quantity)&&(!row?.positionOpenedAt||row.positionOpenedAt<=source.openedAt+5000);
        });
        const position=reusable?source!:this.createManualClosePosition(request,selected,sourceId);
        position.manualCloseOnly=true;position.manualCloseOperationId=request.operationId;
        this.continuingClosePositions.delete(position.id);this.pendingCloseChecks.delete(position.id);
        record.positionId=position.id;record.state='closing';this.store.save();ensure();this.financialEpoch++;
        if(operationId)this.diagnostic(()=>this.store.operations.attach(operationId,position.id,
          {long:selected.find(row=>row.position.side==='long')?.position.quantity??0,
            short:selected.find(row=>row.position.side==='short')?.position.quantity??0}));
        if(selected.length)await executeScopedManualClose({store:this.store,config,position,selected,nativeSlots,
          adapter:exchange=>this.adapter(exchange),read:(adapter,key,call)=>this.boundedPrivateRead(adapter,key,call),ensure,message:safeMessage});
        else {position.status='closed';position.closedAt=Date.now();position.closeReason='所选方向账户已空仓，未提交订单';this.store.save();
          if(operationId)this.diagnostic(()=>this.store.operations.end(operationId,'cancelled',
            {code:'selected-already-flat',text:'所选账户方向已无持仓，本次没有成交动作'}));}
        record.state='completed';
        if(position.status==='closed')delete record.error;else record.error=position.riskReasons.join('；')||'本次平仓已结束，剩余数量或订单待核对';
        this.store.save();this.financialEpoch++;
        this.store.log(position.status==='closed'?'info':'warn',`${request.base} 单次手动平仓处理结束：${position.status==='closed'?'所选数量已平仓':`剩余多 ${position.long.quantity} / 空 ${position.short.quantity}，请核对后重新确认`}；自动策略状态保持原值`,position.id);
        return position;
      }catch(error){
        this.operationPreflightFailed(operationId,error);
        record.error=safeMessage(error);
        const position=record.positionId&&this.store.data.positions.find(row=>row.id===record.positionId);
        if(position){
          if(position.status!=='closed'){position.status='attention';position.riskReasons=[record.error];}
          record.state='completed';this.store.save();return position;
        }
        record.state='failed';this.store.save();throw new Error(record.error);
      }
    });
    this.manualCloseRequests.set(request.operationId,task);
    void task.then(()=>this.manualCloseRequests.delete(request.operationId),()=>this.manualCloseRequests.delete(request.operationId));
    return task;
  }
  private createManualClosePosition(request:ManualCloseRequest,selected:SelectedManualCloseLeg[],sourceId?:string):Position{
    const now=Date.now(),leg=(side:'long'|'short'):PositionLeg=>{
      const item=selected.find(row=>row.position.side===side),target=request.legs.find(row=>row.side===side)??request.legs[0],row=item?.position;
      if(row&&(!(Number.isFinite(row.entryPrice)&&row.entryPrice!>0)||!(Number.isFinite(row.markPrice)&&row.markPrice>0)))throw new Error(`${item!.exchange} 缺少所选仓位有效开仓价或标记价`);
      return {exchange:item?.exchange??target.exchange,symbol:row?.symbol??`${target.symbol}#display-absent-${side}`,side,quantity:row?.quantity??0,
        entryPrice:row?.entryPrice??0,markPrice:row?.markPrice??0,feesUsd:0,fundingUsd:0,liquidationDistancePct:null};
    };
    const position:Position={id:`manual-close-${request.operationId}`,base:request.base,mode:'live',status:selected.length?'attention':'closed',
      manualCloseOnly:true,manualCloseAccountRecord:true,manualCloseOperationId:request.operationId,...(sourceId?{manualCloseSourcePositionId:sourceId}:{}),
      long:leg('long'),short:leg('short'),openedAt:now,plannedExitAt:now,holdMode:'continuous',fundingUsd:0,feesUsd:0,transferCostUsd:0,
      spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
    refreshPnl(position);this.store.data.positions.push(position);return position;
  }
  private async refreshControlAccounts(){
    if(this.config.mode!=='live')return;
    await Promise.allSettled(this.adapters.filter(a=>this.hasLiveAccess(a.id)).map(async a=>{
      try{const account=await this.readTradingAccount(a);if(this.cacheAccount(a.id,account))this.checkAccount(a.id,account);}
      catch{this.accountReadFailed(a.id);}
    }));
  }
  private pendingCoin(base:string){return this.store.data.orders.some(o=>isCurrentUnconfirmedOrder(o,this.store.data.positions)&&unresolvedCoin(o,this.store.data.positions)===coinBase(base));}
  /** The exemption belongs only to this process's exact selected old records.
   * Global entry exclusions and every other unknown remain unchanged. */
  private exitPendingCoin(p:Position):boolean {
    const audit=this.execution.hasNativeExitAuthority(p)?[...(p.nativeExitRecoveryAudit??[])].reverse().find(value=>value.revokedAt===undefined):undefined;
    return this.store.data.orders.some(order=>isCurrentUnconfirmedOrder(order,this.store.data.positions)&&
      (!unresolvedCoin(order,this.store.data.positions)||order.positionId===p.id||unresolvedCoin(order,this.store.data.positions)===coinBase(p.base)||
        [p.long,p.short].some(leg=>order.exchange===leg.exchange&&order.request.symbol===leg.symbol))&&
      !(audit&&order.positionId===p.id&&audit.unknownClientOrderIds.includes(order.request.clientOrderId)));
  }
  private markReconciledPositions():number{
    let confirmed=0;
    for(const p of this.activePositions()){
      this.reconciledPositions.delete(p.id);refreshPnl(p);
      if(this.pendingCoin(p.base)||this.config.mode==='live'&&!this.accountMatchesPosition(p)){p.status='attention';p.riskReasons=['该币种订单或账户对账未完成'];continue;}
      if(p.long.quantity<1e-12&&p.short.quantity<1e-12){p.status='closed';p.closedAt=Math.max(p.openedAt,...this.store.data.orders.filter(o=>o.positionId===p.id&&o.request.reduceOnly).map(o=>o.result?.timestamp??p.openedAt));p.riskReasons=[];confirmed++;}
      else if(p.long.quantity>0&&p.short.quantity>0&&this.matchedQuantities(p)){
        this.reconciledPositions.add(p.id);p.status=this.store.data.killSwitch?'attention':'open';p.riskReasons=this.store.data.killSwitch?['对账完成，等待手动恢复或平仓']:[];confirmed++;
      }else{p.status='attention';p.riskReasons=['已确认残余单腿或两腿币数量不匹配，请核对或平仓'];}
    }
    return confirmed;
  }
  async control(action:string){
    if(action==='pause'){this.pendingManualPermission?.restore();this.startGeneration++;this.autoEnabled=false;this.store.log('info','自动开仓已暂停；现有持仓继续按持仓模式管理');return;}
    if(action==='kill'){
      const cancelledTemporary=this.pendingManualPermission!==undefined;this.pendingManualPermission?.restore();this.startGeneration++;this.halt('用户触发紧急停止');
      if(cancelledTemporary&&!this.liveUnlocked&&!this.activePositions().length)return;
      this.assertLiveAccess();return this.exclusive(async()=>{for(const p of this.activePositions())try{for(const leg of [p.long,p.short].filter(l=>l.quantity>0))this.assertLiveAccess(leg.exchange);await this.continueClosing(p,'紧急停止',{pricing:'depth',requireProfit:false,operationKind:'emergency-close'});}catch{p.status='attention';this.store.save();}});
    }
    if(action==='startAuto')this.assertCredentialsStable();
    return this.exclusive(async()=>{
      if(action==='startAuto')this.assertCredentialsStable();
      this.assertLiveAccess();
      if(action==='reconcile'){
        const pending=[...new Set(this.store.data.orders.filter(o=>isCurrentUnconfirmedOrder(o,this.store.data.positions)).map(o=>o.positionId))];
        for(const positionId of pending)try{await this.execution.reconcilePending(positionId);}catch{this.store.log('warn','部分币种订单仍待核对，继续检查其他币种');}
        await this.refreshControlAccounts();const confirmed=this.markReconciledPositions();
        this.store.log('info',`已核对 ${confirmed} 个仓位；未确认的币种保留限制，风险开关保持原状态`);
      }else if(action==='resume'){
        if(this.unidentifiedOrder())throw new Error('未确认订单缺少币种，无法划定影响范围，须先核对');
        await this.refreshControlAccounts();
        const excluded=new Set(this.coinExclusions().map(c=>c.base));
        const entryCoins=[...this.config.symbols,...this.fundingCandidates().map(c=>c.base)];
        const readyAccounts=this.liveVenues().filter(v=>this.accounts.has(v.exchange)&&['online','degraded'].includes(this.health.find(h=>h.exchange===v.exchange)?.status??'')).length;
        const healthyEntry=this.config.mode==='live'&&readyAccounts>=2&&entryCoins.some(base=>!excluded.has(coinBase(base)!));
        const healthyManaged=this.activePositions().some(p=>this.reconciledPositions.has(p.id)&&!this.pendingCoin(p.base)&&
          (this.config.mode!=='live'||this.accountMatchesPosition(p)));
        if(!healthyEntry&&!healthyManaged&&(this.activePositions().some(p=>p.status==='attention')||this.coinExclusions().length||this.store.data.orders.some(o=>isCurrentUnconfirmedOrder(o,this.store.data.positions))))throw new Error('当前币种仍待账户或订单对账；未解除风险开关');
        if(this.config.mode==='live'&&readyAccounts===0)throw new Error('账户对账未完成，请重新检查连接');
        if(this.config.mode==='paper'&&this.health.some(h=>h.status==='offline'))throw new Error('交易所仍处于断连状态');
        this.store.data.killSwitch=false;
        this.autoEnabled=false;
        for(const p of this.activePositions().filter(p=>this.reconciledPositions.has(p.id)&&!this.pendingCoin(p.base)&&(this.config.mode!=='live'||this.accountMatchesPosition(p)))){p.status='open';p.riskReasons=[];}
        this.reconciledPositions.clear();this.store.log('info','风险开关已解除，自动开仓仍需手动启动');
      }else if(action==='startAuto'){
        if(this.store.data.killSwitch)throw new Error('风险开关未解除');
        if(this.config.mode==='live'&&!this.liveUnlocked)throw new Error('实盘未解锁');
        if([...this.externalExposureSources].some(id=>this.activePositions().some(p=>p.id===id)))
          throw new Error('外部单腿风险尚未核验完成，自动新开仓继续暂停');
        this.autoEnabled=true;this.maintenanceTradingPending=false;this.store.log('info','自动开仓已启动');
      }else throw new Error('未知控制命令');
    });
  }
  private matchedQuantities(p:Position){
    const long=p.long.quantity,short=p.short.quantity;
    const steps=[p.long,p.short].map(leg=>this.snapshot(leg.exchange,p.base)?.quantityStep??1e-8).filter(step=>Number.isFinite(step)&&step>0);
    const tolerance=Math.max(1e-12,Math.min(...steps)*.1);
    return Number.isFinite(long)&&Number.isFinite(short)&&long>0&&short>0&&Math.abs(long-short)<=tolerance;
  }
  /** The caller validates the credential payload first. Saving shares the execution queue, so no account can be
   * replaced between an order's durable intent and its final reconciliation. Failure never restores permission. */
  async updateCredentials<T>(save:()=>T|Promise<T>,precheck?:()=>void,targetExchange?:ExchangeId):Promise<T>{
    if(this.config.mode!=='live')throw new Error('请先进入实盘准备模式再配置账户');
    this.assertCredentialsStable();
    this.pendingManualPermission?.restore();this.credentialUpdatePending=true;this.startGeneration++;
    try{return await this.exclusive(async()=>{
      if(this.stopping)throw new Error('服务正在停止，不能更新账户凭据');
      const blocker=credentialUpdateBlocker(this.store.data.positions,this.store.data.orders,this.accounts,targetExchange);
      if(blocker)throw new Error(blocker);
      precheck?.();
      this.autoEnabled=false;
      if(targetExchange){
        this.observedPortfolio=undefined;
        for(const key of this.entryContractPreviews.keys())if(key.startsWith(`${targetExchange}:`))this.entryContractPreviews.delete(key);
        // Preserve existing account clients and management permission on all other venues.
        if(this.liveUnlocked){
          this.sessionExchanges??=new Set(this.liveVenues().map(x=>x.exchange));
          this.sessionLivePermission=true;
        }
        this.sessionExchanges?.delete(targetExchange);this.environmentPermissionRevoked=true;this.fundingEntryStability.clear();
        this.snapshots=this.snapshots.filter(s=>s.exchange!==targetExchange);
        this.opportunities=this.opportunities.filter(o=>o.longExchange!==targetExchange&&o.shortExchange!==targetExchange);
        this.accounts.delete(targetExchange);this.errors.delete(targetExchange);
        for(const [base,watch] of this.fundingWatch)if(watch.candidate.longExchange===targetExchange||watch.candidate.shortExchange===targetExchange)this.fundingWatch.delete(base);
        for(const key of this.unavailableSnapshots)if(key.startsWith(`${targetExchange}:`))this.unavailableSnapshots.delete(key);
        this.publicSnapshotRequests.delete(targetExchange);
        this.health=this.health.map(h=>h.exchange===targetExchange?{exchange:h.exchange,status:'connecting',lastSuccess:0,latencyMs:0}:h);
        const previous=this.adapters.filter(a=>a.id===targetExchange);
        previous.forEach(adapter=>this.fundingReadRetry.forget(adapter));
        this.adapters=this.adapters.filter(a=>a.id!==targetExchange);
        await Promise.allSettled(previous.map(a=>a.close()));
        let result:T;
        try{result=await save();}finally{this.liveEnvironment=inspectLiveEnvironment(this.options.liveEnvironment??process.env);}
        if(this.config.exchanges.includes(targetExchange))this.adapters.push(...(this.options.adapterFactory??createAdapters)({...this.config,exchanges:[targetExchange]}));
        if(this.running){this.bindRealtime();this.updateRealtimeFocus();}
        this.store.log('info',`${targetExchange} 凭据已更新，该所交易许可已撤销；其他账户持仓管理保留，重新检查后可启动新开仓`);
        return result;
      }
      this.revokeExecutionPermission();
      this.fundingReadRetry.clear();
      this.observedPortfolio=undefined;
      this.entryContractPreviews.clear();
      this.snapshots=[];this.opportunities=[];this.accounts.clear();this.errors.clear();this.fundingWatch.clear();this.fundingChecked.clear();
      this.unavailableSnapshots.clear();this.holdingSamples.clear();this.feeExitPreviewSamples.clear();this.fundingExitStability.clear();this.fundingEntryStability.clear();this.reconciledPositions.clear();this.publicSnapshotRequests.clear();
      this.lastLedgerAt=0;this.lastEquityAt=0;
      this.health=this.config.exchanges.map(exchange=>({exchange,status:'connecting',lastSuccess:0,latencyMs:0}));
      // Revoke before persistence: even a disk/adapter construction failure leaves the process read-only.
      const result=await save();
      this.liveEnvironment=inspectLiveEnvironment(this.options.liveEnvironment??process.env);
      const previous=this.adapters;this.adapters=[];
      await Promise.allSettled(previous.map(a=>a.close()));
      this.adapters=(this.options.adapterFactory??createAdapters)(this.config);
      if(this.running){this.bindRealtime();this.updateRealtimeFocus();}
      this.store.log('info','账户凭据已更新；实盘执行许可已撤销，请重新检查并启动策略');
      return result;
    });}finally{this.credentialUpdatePending=false;}
  }
  async updateConfig(partial:Partial<AppConfig>,expectedConfig?:AppConfig){return this.exclusive(async()=>{
    if(expectedConfig!==undefined&&configConcurrencyKey(expectedConfig)!==configConcurrencyKey(this.config))
      throw Object.assign(new Error('设置已在其他页面更新，请刷新后重新核对再保存'),{code:'CONFIG_CONFLICT'});
    if('mode' in partial&&partial.mode!==this.config.mode)throw new Error('交易模式只能通过本机启动配置切换');
    const next=validateConfig({...this.config,...partial,takerFees:{...this.config.takerFees,...partial.takerFees},autoEnabled:false});
    const policy=configUpdatePolicy(this.config,next);
    if(!policy.changedFields.length)return this.config;
    if(policy.changedFields.includes('profitExitExecutionMode')&&(this.pendingCloseReadWorkers.size>0||this.holdingExitReadWorkers.size>0||
      this.nativeExitTailPreparing.size>0||this.confirmedLotTailPreparing.size>0||
      this.activePositions().some(p=>this.execution.hasMakerClose(p)||this.execution.hasIocProfitClose(p)||
        this.execution.hasPendingMakerCloseTail(p)||this.execution.hasPendingIocProfitTail(p))))
      throw new Error('原平仓动作或已确认尾差仍在处理，须核对完成后再切换退出执行方式');
    if(policy.changedFields.includes('profitExitExecutionMode')&&this.activePositions().some(p=>this.execution.hasNativeExitAuthority(p)))
      throw new Error('当前会话已有原生退出授权，须在重启后、恢复原生管理前保存退出执行方式，再用新原生证据重新授权');
    if(policy.entryOnly){
      const previousConfig=this.config;
      this.store.data.config=next;
      try{this.store.save();}catch(error){this.store.data.config=previousConfig;throw error;}
      this.startGeneration++;this.autoEnabled=false;this.fundingEntryStability.clear();this.fundingWatch.clear();this.fundingChecked.clear();
      this.fundingReadRetry.clear();
      const holdingChanged=policy.changedFields.some(field=>field==='exitWeakFundingBps'||field==='minExitProfitUsd'||field==='minExitProfitBps'||field==='feeRebatePct'||field==='profitExitExecutionMode');
      if(holdingChanged){this.holdingSamples.clear();this.feeExitPreviewSamples.clear();this.fundingExitStability.clear();this.fundingEntryStability.clear();for(const position of this.activePositions())if(position.holdMode==='adaptive')position.holdDecision=undefined;}
      this.store.log('info',holdingChanged?'退出参数已保存，持仓决策重新等待独立资金费及成交证据确认；自动开仓已暂停，账户许可保留':'新开仓参数已保存，自动开仓已暂停；现有仓位管理及账户许可保留');return next;
    }
    if(this.activePositions().length)throw new Error(`参数 ${policy.criticalFields.join('、')} 会影响已有仓位或交易客户端，请先处理持仓后再修改；新开仓收益门槛可直接保存`);
    if(this.store.data.orders.some(o=>isCurrentUnconfirmedOrder(o,this.store.data.positions)))throw new Error(`参数 ${policy.criticalFields.join('、')} 会影响订单执行，请先处理未确认订单；新开仓收益门槛可直接保存`);
    this.startGeneration++;this.revokeExecutionPermission();const previous=this.adapters;this.adapters=[];await Promise.allSettled(previous.map(a=>a.close()));this.store.data.config=next;
    this.fundingReadRetry.clear();
    this.liveEnvironment=inspectLiveEnvironment(this.options.liveEnvironment??process.env);this.adapters=(this.options.adapterFactory??createAdapters)(next);
    if(this.running){this.bindRealtime();this.updateRealtimeFocus();}
    this.entryContractPreviews.clear();
    this.snapshots=[];this.opportunities=[];this.accounts.clear();this.errors.clear();this.fundingWatch.clear();this.fundingChecked.clear();this.unavailableSnapshots.clear();this.holdingSamples.clear();this.feeExitPreviewSamples.clear();this.fundingExitStability.clear();this.fundingEntryStability.clear();
    this.health=next.exchanges.map(exchange=>({exchange,status:'connecting',lastSuccess:0,latencyMs:0}));this.store.log('info','配置已保存，自动开仓已暂停');return next;
  });}
  totals():AppState['totals']{
    const ps=this.store.data.positions.filter(position=>!position.manualCloseAccountRecord);
    const liveVenues=this.liveVenues(),liveBalance=this.liveUnlocked&&liveVenues.length>=2&&liveVenues.every(x=>this.accounts.has(x.exchange)&&['online','degraded'].includes(this.health.find(h=>h.exchange===x.exchange)?.status??''))?
      liveVenues.reduce((n,x)=>n+this.accounts.get(x.exchange)!.freeUsd,0):null;
    const spread=(p:Position)=>p.accountClosure?p.realizedSpreadPnlUsd:p.spreadPnlUsd;
    const netPnlUsd=ps.reduce((n,p)=>n+(p.accountClosure?p.fundingUsd+spread(p)-p.feesUsd-p.transferCostUsd:p.netPnlUsd),0);
    const rebates=ps.map(p=>projectPositionFeeRebate(p,this.store.data.orders,this.config));
    const estimatedFeeRebateUsd=rebates.every(value=>value!==undefined)?rebates.reduce<number>((sum,value)=>sum+value!,0):null;
    return {fundingUsd:ps.reduce((n,p)=>n+p.fundingUsd,0),feesUsd:ps.reduce((n,p)=>n+p.feesUsd,0),spreadPnlUsd:ps.reduce((n,p)=>n+spread(p),0),netPnlUsd,
      estimatedFeeRebateUsd,estimatedNetPnlAfterRebateUsd:estimatedFeeRebateUsd===null?null:netPnlUsd+estimatedFeeRebateUsd,
      grossExposureUsd:this.activePositions().reduce((n,p)=>n+p.long.quantity*p.long.markPrice+p.short.quantity*p.short.markPrice,0),
      availableBalanceUsd:this.config.mode==='paper'?this.config.exchanges.reduce((n,x)=>n+this.paperBalance(x),0):liveBalance,openPositions:this.activePositions().length};
  }
  /** Local current-policy economics never changes historical entry rules or actual cash. */
  private economicsPosition(p:Position):Position {
    const actual=this.store.data.positions.find(position=>position.id===p.id);
    // Current IOC intents contain no booked cash. Execution can identify only its
    // own exact pair so the final rebate recheck does not treat it as an old unknown.
    if(actual===p&&this.execution.hasIocProfitClose(actual))
      return currentExitStrategyPosition(this.execution.iocProfitExitEconomics(p),this.config);
    const audit=actual&&this.execution.hasNativeExitAuthority(actual)?[...(actual.nativeExitRecoveryAudit??[])].reverse().find(value=>value.revokedAt===undefined):undefined;
    p=currentExitStrategyPosition(p,this.config);
    if(audit)p={...p,transferCostUsd:p.transferCostUsd+audit.feeReserveUsd+audit.lossReserveUsd};
    if([p.long,p.short].some(leg=>feeRebatePct(leg.exchange,this.config)>0))
      p={...p,estimatedFeeRebateUsd:projectPositionFeeRebate(p,audit?this.store.data.orders.filter(order=>
        !(order.positionId===actual!.id&&audit.unknownClientOrderIds.includes(order.request.clientOrderId))):this.store.data.orders,this.config)??null};
    return p;
  }
  state():AppState{
    const observedAt=Date.now();
    this.confirmOperationAccounts(observedAt);
    const operations=this.diagnostic(()=>this.store.operations.snapshot(observedAt));
    const operationByPosition=new Map<string,NonNullable<typeof operations>['rows'][number]>();
    for(const operation of operations?.rows??[]){
      const previous=operationByPosition.get(operation.positionId);
      if(!previous||operation.startedAt>previous.startedAt||operation.startedAt===previous.startedAt&&operation.updatedAt>=previous.updatedAt)
        operationByPosition.set(operation.positionId,operation);
    }
    const reasons=[...new Set(this.activePositions().flatMap(p=>p.riskReasons))];
    if(this.health.some(h=>h.status==='offline'))reasons.push('部分交易所离线');
    if(this.store.data.killSwitch)reasons.unshift('执行停止，新开仓已暂停');
    const liveReadiness=this.config.mode==='live'?this.liveReadiness():undefined;
    if(liveReadiness&&!liveReadiness.ready)reasons.push(...liveReadiness.reasons);
    return {timestamp:observedAt,config:this.config,running:this.running,autoEnabled:this.autoEnabled,killSwitch:this.store.data.killSwitch,
      realtime:{enabled:this.config.dataSource==='public'&&process.env.FUNDING_WS_ENABLED!=='0',eventTriggered:this.autoEnabled&&this.liveUnlocked,
        streams:this.adapters.flatMap(a=>a.realtimeStatus?.()??[]),books:this.snapshots.filter(s=>s.bookTransport==='websocket'&&quoteIsFresh(s,this.config)).length,
        lastQuoteAt:this.lastRealtimeQuoteAt,lastSignalAt:this.lastRealtimeSignalAt,latency:this.realtimeLatency.status()},
      opportunities:this.currentOpportunities(),snapshots:this.snapshots,exchanges:this.health,positions:this.store.data.positions.map(p=>{
        const rebate=projectPositionFeeRebate(p,this.store.data.orders,this.config);
        const grossNet=p.accountClosure?p.fundingUsd+p.realizedSpreadPnlUsd-p.feesUsd-p.transferCostUsd:p.netPnlUsd;
        return {...p,...(operationByPosition.has(p.id)?{operationProgress:operationByPosition.get(p.id)}:{}),estimatedFeeRebateUsd:rebate??null,estimatedNetPnlAfterRebateUsd:rebate===undefined?null:grossNet+rebate};
      }),logs:this.store.data.logs,equity:this.store.data.equity,totals:this.totals(),
      performance:performanceSummary(this.store.data.positions,this.store.data.orders,Date.now(),this.config),
      executionStatistics:{...executionStatistics(this.store.data.positions,this.store.data.orders),...(operations?{operations}:{})},
      manualCloseOperations:(this.store.data.manualCloseOperations??[]).filter((record,index,rows)=>index>=rows.length-100||record.state==='checking'||record.state==='closing').map(record=>({id:record.id,state:record.state,createdAt:record.createdAt,...(record.positionId?{positionId:record.positionId}:{}),...(record.error?{error:record.error}:{})})),
      unconfirmedOrders:this.store.data.orders.filter(isUnconfirmedJournalOrder).map(order=>({positionId:order.positionId,exchange:order.exchange,...(isHistoricalJournalOrder(order,this.store.data.positions)?{historical:true}:{})})),
      risk:{status:this.store.data.killSwitch?'halted':reasons.length?'warning':'healthy',reasons},liveUnlocked:this.liveUnlocked,...(liveReadiness?{liveReadiness}:{})};
  }
}
export function safeMessage(e:unknown):string{
  const publicBookReason=selectedPublicBookReason(e);if(publicBookReason)return publicBookReason;
  const bookReason=preparedBookChangedReason(e);if(bookReason)return bookReason;
  if(e instanceof ManualEntryCancelled)return e.message;
  if(e instanceof TradingError)return e.message;
  if(e instanceof OrderNotSubmittedError)return `${e.rejectionReason} (${e.rejectionCode})`.slice(0,200);
  const known=gateReadError(e)??bitgetAccountReadError(e);if(known)return known;
  if(!(e instanceof Error))return '请求失败';
  if(e.constructor.name!=='Error'||(e as any).url||/https?:|api[-_ ]?key|signature|secret|password|passphrase|headers|retCode|authorization|bearer|token|\{/i.test(e.message))return '接口请求失败，请检查连接、权限和账户配置';
  return e.message.slice(0,200);
}
