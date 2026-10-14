import { randomUUID } from 'node:crypto';
import type { AppConfig, ExchangeAdapter, JournalOrder, MakerReductionObservation, MarketSnapshot, Opportunity, NativeExitRecoveryAudit, OrderRequest, OrderResult, Position, PositionLeg, Side } from '../shared/types.js';
import {confirmedIocOrderProof,planConfirmedIocTail} from './confirmed-ioc-tail.js';
import {iocReductionReceiptLog} from './ioc-receipt-log.js';
import type {IocSubmissionVetoCode,OrderExecutionEvidence} from '../shared/execution-statistics.js';
import {instrumentIdentityBlockReason} from '../shared/instrument-identity.js';
import {currentExitStrategyPosition} from '../shared/current-exit-strategy.js';
import {TradingError,tradingError} from './trading-errors.js';
import {selectedPublicBookReason} from './selected-public-book-error.js';
import {ExchangeNetworkError} from '../adapters/network.js';
import {conflictingNativeOrderReceipts,hasBoundedOrderQuantity,hasOrderReceiptIdentity,isTerminalOrderReceipt,normalizeOrderReceipt,orderQuantityTolerance,safeOrderConfirmation,orderConfirmationText} from '../shared/order-receipt-validity.js';
import { commonStep, floorQuantity, fundingCount, quoteSkewMs, sweep } from './strategy.js';
import {quantityGrid,quantitySubtract,quantitySubtractOnStep,quantityAdd,isLegalQuantity} from './order-quantity.js';
import {alignedEntryIocEdgeBps,alignedEntryPricesFavorable,bookIsUncrossedWhenObserved,estimateAlignedEntryFees,minimumEntryIocEdgeBps,sweepBook} from './funding-carry.js';
import { Store } from './store.js';
import { isFeeOnly } from '../shared/strategy-profile.js';
import {profitExitPolicy,assessBestOppositeProfitExit,alignedExitProfitsPass,type AlignedExitAssessment} from './profit-exit.js';
import {evaluateTradeEconomics} from './trade-economics.js';
import {quoteIsFresh} from './market-validity.js';
import {isPositionActive,isCurrentUnconfirmedOrder,isUnconfirmedJournalOrder} from '../shared/ledger-lifecycle.js';
import {nativeMakerFeeRate,nativeTakerFeeRate,takerFeeRate} from '../shared/trading-fees.js';
import {effectiveFeeRate,feeRebatePct} from '../shared/fee-rebates.js';
import {projectPositionFeeRebate} from '../shared/position-fee-rebates.js';
import {bestOppositeLevel,planBestPriceEntryBatch,planBufferedLongEntry,MAX_BEST_PRICE_ENTRY_BATCHES,MAX_ENTRY_EXPANSION_MS} from './entry-batch.js';
import {compareEntryCompensation} from './entry-compensation.js';
import {bestCloseOppositeLevel,planBestPriceCloseBatch,planBestPriceReduction,planScopedFullCloseBatch,planScopedFullReduction,MAX_BEST_PRICE_CLOSE_BATCHES,MAX_BEST_PRICE_CLOSE_MS,CLOSE_REPAIR_BUFFER_BPS} from './close-batch.js';
import {automaticEntryAssessment,AUTO_ENTRY_MIN_OPPOSITE_EDGE_BPS,AUTO_ENTRY_PRICE_ROUTE_MIN_OPPOSITE_EDGE_BPS,AUTO_ENTRY_PRICE_ROUTE_MIN_IOC_EDGE_BPS} from '../shared/automatic-entry-policy.js';
import {planMakerClose,selectMakerCloseLeg,canRestConfirmedMakerClose} from './maker-close-plan.js';
import {freezeProfitExitNotional} from './exit-profit-threshold.js';
import {MakerCloseSupervisor,MAKER_CLOSE_TIMEOUT_MS} from './maker-close-supervisor.js';
import {createMakerCloseComparison,updateMakerCloseComparison} from '../shared/maker-close-comparison.js';
import type {FundingEntryConfirmationEvidence} from '../shared/funding-entry-stability.js';
import {planConfirmedLotTailRestoration} from './confirmed-lot-tail.js';
import {coinBase,unresolvedCoin} from './coin-exclusions.js';
import {operationConfigDigest} from './operation-config-digest.js';
import {runtimeSourceVersion} from './runtime-source-version.js';
import type {TradingOperationKind,TradingOperationProtocol} from '../shared/trading-operations.js';
export class UncertainOrderError extends Error {}
/** Only a pre-intent book failure may be recovered inside a scoped manual click. */
class PreparedBookChangedError extends Error {}
/** Only these locally generated book failures may bypass the private-error redaction. */
export function preparedBookChangedReason(error:unknown):string|undefined {
  if(!(error instanceof PreparedBookChangedError))return;
  const message=Object.getOwnPropertyDescriptor(error,'message')?.value;
  if(message==='提交前盘口已过期，停止提交'||message==='提交前首档盘口已变化，原限价或首档数量已不可成交')return message;
}
/** requireProfit is the persisted compatibility name for mandatory automatic economics validation. */
export type CloseExecutionOptions={pricing:'best-opposite'|'depth';requireProfit?:boolean};
export type CloseProfitValidation=(longLimit:number,shortLimit:number,quantity?:number)=>boolean;
export type IocExitQualification='profit'|'funding-loss';
export type ExecutionTrace={positionId:string;base:string;phase:'first-submit'|'first-confirmed'|'hedge-submit'|'hedge-confirmed'|'matched'|'finished';at:number;batch?:number};
export type ExecutionContext={config:()=>AppConfig;snapshot:(exchange:string,base:string)=>MarketSnapshot|undefined;adapter:(exchange:string)=>ExchangeAdapter;liveUnlocked:()=>boolean;allowEntry?:(position:Position)=>boolean;assertAutomaticEntryStability?:(position:Position)=>void;canUseSnapshot?:(exchange:string,base:string)=>boolean;refreshSnapshots?:(base:string,exchanges:string[])=>Promise<void>;refreshReductionSnapshots?:(base:string,exchanges:string[])=>Promise<void>;fundingExitQualified?:(position:Position,assessment:AlignedExitAssessment,long:MarketSnapshot,short:MarketSnapshot,now:number)=>boolean;confirmCloseSuspension?:(position:Position)=>boolean;prepareReduction?:(leg:PositionLeg,quantity:number)=>{quantity:number;closePosition?:OrderRequest['closePosition']};closeOrderStartIndex?:number;scopedFullClose?:boolean;trace?:(event:ExecutionTrace)=>void;serialize?:<T>(fn:()=>Promise<T>)=>Promise<T>;makerActionsAllowed?:()=>boolean;makerCloseSettled?:(position:Position)=>void;iocProfitCloseSettled?:(position:Position)=>void;makerFinancialActivity?:(journal?:JournalOrder)=>void;makerCloseSignalAt?:(position:Position)=>number|undefined;halt:(reason:string,base?:string)=>void};
const MAKER_CLOSE_ZERO_ATTEMPTS=3,MAKER_CLOSE_RETRY_COOLDOWN_MS=500;
interface IocBookRules {leg:PositionLeg;exchange:PositionLeg['exchange'];base:string;symbol:string;contractSize:number;quantityStep:number;closePosition:string|undefined}
interface IocProfitBatch {position:Position;legs:[PositionLeg,PositionLeg];config:AppConfig;orders:JournalOrder[];requests:string[];bookRules:IocBookRules[];expected:string;invalid:boolean;nativeStartedAt:number;nativeReady:boolean;
  configProof:string;tailCheckpoint?:string;profitCommitted:boolean;qualification:IocExitQualification;validateProfitExit?:CloseProfitValidation;longLimit?:number;shortLimit?:number;quantity?:number}
interface IocProfitBatchResult {results:PromiseSettledResult<OrderResult>[];tailCheckpoint:string;configProof:string}
interface IocProfitTail {position:Position;legs:[PositionLeg,PositionLeg];leg:PositionLeg;remainingBudget:number;
  config:AppConfig;configProof:string;requestedAt:number;proof:string;orders:Array<{order:JournalOrder;proof:string}>}
type IocProfitPhase='book-refresh'|'planning'|'native-validation'|'native-proof'|'post-native-book'|'intent-save'|'native-submit'|'receipt-save'|'completion-save'|'preflight-wait-save';
const iocProfitPhaseText:Record<IocProfitPhase,string>={'book-refresh':'盘口读取',planning:'数量与报价准备','native-validation':'原生参数核验',
  'native-proof':'账户及挂单核验','post-native-book':'原生核验后盘口复核','intent-save':'退出意图保存','native-submit':'原生提交','receipt-save':'成交现金保存',
  'completion-save':'余仓状态保存','preflight-wait-save':'准备等待状态保存'};
interface MakerCloseFlow {config:AppConfig;closeRequestedAt?:number;cycleId:string;startedAt:number;attempts:number;
  noProgress:number;retryAfter:number;lastClientOrderId?:string;lastStopReason?:string}
interface PreparedOrder { leg:PositionLeg;request:OrderRequest;snapshot:MarketSnapshot;contractSize:number;pricing?:'best-opposite';entryBatch?:number;role?:'entry'|'hedge'|'entry-tail'|'exit'|'exit-tail';makerReduction?:boolean;makerCloseParentClientId?:string;makerCloseLotTailOriginalParentClientId?:string;makerCloseLotTailParentClientIds?:string[] }
export class MakerClosePreflightError extends Error {
  constructor(readonly exchange:Position['long']['exchange'],readonly preflight:'maker-native'|'peer-native'|'maker-book'|'peer-book',error:unknown){
    const reason=preparedBookChangedReason(error)??tradingError(exchange,'合约检查',error).message;
    const phase={'maker-native':'Maker 原生预检','peer-native':'对侧减仓原生预检','maker-book':'Maker 提交前盘口复核','peer-book':'对侧减仓提交前盘口复核'}[preflight];
    super(`${exchange} ${phase}：${reason}`);
    this.name='MakerClosePreflightError';
  }
}
export interface MakerClosePreparation {position:Position;config:AppConfig;proof:string;notionalUsd?:number;
  prepared:PreparedOrder;peerPrepared:PreparedOrder;plan:NonNullable<ReturnType<typeof planMakerClose>>}
type ReductionScope={quantity:number;closePosition?:OrderRequest['closePosition']};
type EntryValidation=(phase?:'initial'|'batch'|'supplement',quantities?:{longQuantity:number;shortQuantity:number})=>Promise<Opportunity>;
const sameQuantity=(a:number,b:number)=>Math.abs(a-b)<=Math.max(Math.abs(a),Math.abs(b))*Number.EPSILON*8;
/** Largest hedge reachable by valid reductions, including fills that are not order-lot multiples. */
function matchedReductionQuantity(long:PositionLeg,short:PositionLeg,longBook:MarketSnapshot,shortBook:MarketSnapshot):number|null {
  if(sameQuantity(long.quantity,short.quantity))return Math.min(long.quantity,short.quantity);
  const values=[long.quantity,short.quantity,longBook.quantityStep,shortBook.quantityStep,longBook.minQuantity,shortBook.minQuantity];
  if(!values.every(value=>Number.isFinite(value)&&value>=0&&value<1e21)||longBook.quantityStep<=0||shortBook.quantityStep<=0)return null;
  // Integer arithmetic solves qLong-target = n*longStep and qShort-target = m*shortStep.
  // Flooring each excess independently cannot ensure the two retained quantities are equal.
  const grid=quantityGrid(values);if(!grid)return null;
  const [left,right,a,b,longMinimum,shortMinimum]=grid.units;
  if(a<=0n||b<=0n)return null;
  const extendedGcd=(x:bigint,y:bigint):[bigint,bigint,bigint]=>{
    if(y===0n)return [x,1n,0n];
    const [g,s,t]=extendedGcd(y,x%y);return [g,t,s-(x/y)*t];
  };
  const mod=(value:bigint,base:bigint)=>((value%base)+base)%base;
  const [g,inverse]=extendedGcd(a,b),difference=right-left;
  if(difference%g!==0n)return null;
  const period=a/g*b,residue=mod(left+a*mod(difference/g*inverse,b/g),period);
  const minimums=[longMinimum>a?longMinimum:a,shortMinimum>b?shortMinimum:b];
  let ceiling=left<right?left:right;
  for(let attempt=0;attempt<3;attempt++){
    if(ceiling<residue)return null;
    const target=residue+(ceiling-residue)/period*period;
    let nextCeiling=ceiling;
    for(const [quantity,minimum] of [[left,minimums[0]],[right,minimums[1]]]){
      const reduction=quantity-target;
      if(reduction>0n&&reduction<minimum)nextCeiling=nextCeiling<quantity-minimum?nextCeiling:quantity-minimum;
    }
    if(nextCeiling===ceiling)return grid.toNumber(target);
    ceiling=nextCeiling;
  }
  return null;
}
/** A cancelled short must not be followed by a long. CT lost money when the long filled and the Bybit IOC did not. */
function shortSoldNothing(position:Position):boolean{return position.short.quantity<=0;}
/** Retry new quotes for terminal no-liquidity cancellations, never a known parameter/permission rejection. */
function canRetryZeroEntry(result:OrderResult):boolean{
  return result.status==='cancelled'&&result.filledQuantity===0&&(!result.rejectionCode||
    ['BYBIT_CANCELLED_ZERO_FILL','BYBIT_EXPIRED_ZERO_FILL','EC_NoImmediateQtyToFill','EC_NoEnoughQtyToFill','EC_CancelForNoFullFill'].includes(result.rejectionCode));
}
function canRetryCloseReceipt(result:OrderResult,postOnly=false):boolean {
  if(postOnly&&result.status==='cancelled'&&result.filledQuantity===0&&result.feeUsd===0&&
    ['EC_PostOnlyWillTakeLiquidity','MAKER_POST_ONLY_WOULD_TAKE','GATE_MAKER_POST_ONLY_WOULD_TAKE'].includes(result.rejectionCode??''))return true;
  return !result.rejectionCode||['BYBIT_CANCELLED_ZERO_FILL','BYBIT_EXPIRED_ZERO_FILL','EC_NoImmediateQtyToFill',
    'EC_NoEnoughQtyToFill','EC_CancelForNoFullFill','MAKER_REDUCTION_PERMISSION_CHANGED','ORDER_SUBMISSION_PERMISSION_CHANGED','IOC_REDUCTION_PERMISSION_CHANGED'].includes(result.rejectionCode);
}
/** A verified, booked original Maker canceled by our own request is a quote change, not a new-order rejection. */
function isControlledBybitMakerCancellation(journal:JournalOrder):boolean {
  const result=journal.result,metadata=journal.makerReduction,evidence=journal.executionEvidence;
  if(journal.exchange!=='bybit'||journal.request.reduceOnly!==true||journal.request.postOnly!==true||
    !result?.id||result.rejectionCode!=='EC_PerCancelRequest'||result.averagePriceVerified!==true||
    !isTerminalOrderReceipt(journal.request,result)||metadata?.activity!=='terminal'||metadata.bookedExecution!==true||
    evidence?.method!=='maker'||evidence.role!=='exit'||!Number.isFinite(result.feeUsd)||evidence.bookedFeeUsd!==result.feeUsd)return false;
  if(result.filledQuantity===0){
    if(result.status!=='cancelled'||result.averagePrice!==0||result.feeUsd!==0)return false;
  }else if(!['partial','filled'].includes(result.status)||!Number.isFinite(result.averagePrice)||result.averagePrice<=0)return false;
  const submittedAt=metadata.submittedAt,cancelAt=metadata.cancelRequestedAt,observedAt=metadata.lastObservedAt,now=Date.now();
  return Number.isFinite(submittedAt)&&submittedAt!>=journal.createdAt&&Number.isFinite(cancelAt)&&cancelAt!>=submittedAt!&&
    Number.isFinite(observedAt)&&observedAt!>=cancelAt!&&observedAt!<=now;
}
export class Execution {
  private readonly makerCloseSupervisor=new MakerCloseSupervisor();
  private readonly iocProfitWorkers=new Map<string,Promise<void>>();
  private readonly iocProfitBatches=new Map<string,IocProfitBatch>();
  private readonly pendingIocProfitTails=new Map<string,IocProfitTail>();
  private readonly stoppedIocProfitWorkers=new Set<string>();
  private readonly iocProfitPhases=new Map<string,IocProfitPhase>();
  private readonly iocProfitReadWaits=new Map<string,{position:Position;config:AppConfig;requestedAt?:number;retryAfter:number;message:string;loggedByMessage:Map<string,number>}>();
  private readonly makerCloseFlows=new Map<string,MakerCloseFlow>();
  private readonly makerTailWorkers=new Map<string,Promise<void>>();
  private readonly stoppedMakerTailWorkers=new Set<string>();
  // Only this process's confirmed Maker cash can continue a peer tail automatically.
  private readonly pendingMakerCloseTails=new Map<string,{position:Position;journal:JournalOrder;config:AppConfig;
    requestedAt:number;signature:string;retryAfter:number}>();
  private readonly unknownDiagnosticLoggedAt=new Map<string,number>();
  private readonly concurrentReconciliationReads=new Map<JournalOrder,Promise<unknown>>();
  private readonly concurrentReconciliationCommits=new Set<JournalOrder>();
  // A financial continuation belongs only to an entry committed in this process.
  // Persisted attention records do not acquire permission after a restart.
  private readonly pendingEntryRollbacks=new Map<string,{position:Position;previousMatched:number;lastAttemptAt:number;
    intents:Array<{journal:JournalOrder;signature:string}>}>();
  private readonly openingRollbackFloors=new Map<string,number>();
  private readonly blockedEntryRollbacks=new Set<string>();
  // A terminal receipt is still a financial boundary when its local processing
  // fails. A successful later save is not permission to continue this operation.
  private readonly interruptedOrderProcessing=new Set<string>();
  private readonly lotTailRepairs=new Set<string>();
  private readonly nativeExitAuthorities=new Map<string,{position:Position;config:AppConfig;audit:NativeExitRecoveryAudit;
    identity:string;orders:Array<{order:JournalOrder;proof:string}>;tailParent?:{order:JournalOrder;proof:string};auditProof:string;guard:(pending?:JournalOrder)=>boolean}>();
  private readonly nativeExitWorkers=new Map<string,Promise<boolean>>();
  private readonly activeMakerIntents=new Map<string,{journal:JournalOrder;proof:string}>();
  constructor(readonly store:Store,readonly context:ExecutionContext){}
  /** Diagnostic failures have no authority over financial execution. */
  private operation(p:Position,action:(id:string)=>void):void {
    try{const current=this.store.operations.current(p.id);if(current)action(current.id);}catch{/* Read-only telemetry. */}
  }
  private beginOperation(p:Position,kind:TradingOperationKind,protocol:TradingOperationProtocol,
    target={long:p.long.quantity,short:p.short.quantity}):void {
    try{
      const current=this.store.operations.current(p.id);
      if(current&&(kind==='entry'?current.kind==='entry':current.kind!=='entry'))return;
      this.store.operations.begin({positionId:p.id,base:p.base,mode:p.mode,
        origin:kind==='entry'?(p.automaticEntry?'automatic':'manual'):
          p.manualCloseOnly||kind==='manual-close'?'manual':'automatic',kind,protocol,target,
        configDigest:operationConfigDigest(this.context.config()),runtimeVersion:runtimeSourceVersion()});
      this.operation(p,id=>this.store.operations.stage(id,'preparationStartedAt'));
    }catch{/* Telemetry must never stop an order or grant permission to send one. */}
  }
  private operationSubmitted(p:Position,journal:JournalOrder):void {
    try{
      this.operation(p,id=>this.store.operations.stage(id,'preparationCompletedAt'));
      this.store.operations.orderSubmitted(p,journal);
    }catch{/* Local adapter invocation only; no claim of an exchange POST. */}
  }
  private operationObserved(p:Position):void {
    try{this.store.operations.observe(p,this.store.data.orders);}catch{/* The financial ledger remains authoritative. */}
  }
  private nativeExitOrderProof(order:JournalOrder):string {
    const r=order.result;
    return JSON.stringify([order.positionId,order.exchange,order.createdAt,order.request,
      r&&[r.id,r.clientOrderId,r.status,r.filledQuantity,r.averagePrice,r.averagePriceVerified,r.feeUsd,r.timestamp],
      order.executionEvidence?.bookedFeeUsd,order.executionEvidence?.method,order.executionEvidence?.makerCloseParentClientId]);
  }
  private nativeExitIdentity(p:Position):string {
    return JSON.stringify([p.id,p.base,p.mode,p.entryPolicy,p.profitExitNotionalUsd,p.manualCloseOnly,
      [p.long,p.short].map(leg=>[leg.exchange,leg.symbol,leg.side,leg.entryPrice])]);
  }
  private nativeExitAuditProof(audit:NativeExitRecoveryAudit):string {
    const {lateEvidence,revokedAt,revocationReason,...authority}=audit;return JSON.stringify(authority);
  }
  /** Only the selected API's fresh account evidence creates process-local exit authority. */
  installNativeExitAuthority(p:Position,audit:NativeExitRecoveryAudit,guard:(pending?:JournalOrder)=>boolean):void {
    if(this.context.config().mode!=='live'||p.mode!=='live'||!this.context.liveUnlocked()||this.store.data.killSwitch||
      !this.store.data.positions.includes(p)||!p.nativeExitRecoveryAudit?.includes(audit)||audit.revokedAt!==undefined||
      !audit.id||!audit.unknownClientOrderIds.length||new Set(audit.unknownClientOrderIds).size!==audit.unknownClientOrderIds.length||
      ![audit.feeReserveUsd,audit.lossReserveUsd,audit.originalRemainingBudget].every(value=>Number.isFinite(value)&&value>=0)||
      this.nativeExitAuthorities.has(p.id))throw new Error('原生持仓退出授权缺少有效本轮证据');
    const orders=audit.unknownClientOrderIds.map(id=>{
      const matches=this.store.data.orders.filter(order=>order.positionId===p.id&&order.request.clientOrderId===id);
      if(matches.length!==1||!isCurrentUnconfirmedOrder(matches[0],this.store.data.positions)||
        matches[0].request.reduceOnly!==true||matches[0].request.postOnly||matches[0].executionEvidence?.method!=='ioc'||
        matches[0].executionEvidence?.makerCloseParentClientId!==audit.parentClientOrderId)
        throw new Error('原生退出授权不属于所选历史未知补腿');
      return {order:matches[0],proof:this.nativeExitOrderProof(matches[0])};
    });
    let tailParent:{order:JournalOrder;proof:string}|undefined;
    if(audit.confirmedTailParentClientOrderId!==undefined){
      const matches=this.store.data.orders.filter(order=>order.request.clientOrderId===audit.confirmedTailParentClientOrderId);
      const order=matches[0];
      if(matches.length!==1||!order||order.positionId!==p.id||order.request.clientOrderId===audit.parentClientOrderId||
        audit.originalRemainingBudget!==0||!Number.isFinite(audit.confirmedTailRemainingBudget)||audit.confirmedTailRemainingBudget!<=0||
        !audit.confirmedTailParentFingerprint||order.request.reduceOnly!==true||order.request.postOnly!==true||
        order.makerReduction?.activity!=='terminal'||order.makerReduction.bookedExecution!==true||
        order.executionEvidence?.method!=='maker'||order.executionEvidence.role!=='exit'||!order.result?.id||
        order.result.id===order.request.clientOrderId||order.result.filledQuantity<=0||order.result.averagePriceVerified!==true||
        !isTerminalOrderReceipt(order.request,order.result)||!Number.isFinite(order.result.feeUsd)||
        order.executionEvidence.bookedFeeUsd!==order.result.feeUsd)throw new Error('新 Maker 尾差缺少明确的原生确认预算');
      tailParent={order,proof:this.nativeExitOrderProof(order)};
    }
    this.nativeExitAuthorities.set(p.id,{position:p,config:this.context.config(),audit,guard,orders,tailParent,
      identity:this.nativeExitIdentity(p),auditProof:this.nativeExitAuditProof(audit)});
  }
  hasNativeExitAuthority(p:Position):boolean {
    const authority=this.nativeExitAuthorities.get(p.id);
    return !!authority&&authority.position===p&&this.store.data.positions.includes(p)&&
      authority.config===this.context.config()&&this.context.liveUnlocked()&&!this.store.data.killSwitch&&
      !this.interruptedOrderProcessing.has(p.id)&&p.nativeExitRecoveryAudit?.includes(authority.audit)===true&&
      authority.audit.revokedAt===undefined&&authority.identity===this.nativeExitIdentity(p)&&
      authority.auditProof===this.nativeExitAuditProof(authority.audit)&&
      (!authority.tailParent||this.store.data.orders.includes(authority.tailParent.order)&&
        this.store.data.orders.filter(order=>order.request.clientOrderId===authority.tailParent!.order.request.clientOrderId).length===1&&
        authority.tailParent.proof===this.nativeExitOrderProof(authority.tailParent.order))&&
      authority.orders.every(({order,proof})=>this.store.data.orders.includes(order)&&
        this.store.data.orders.filter(other=>other.request.clientOrderId===order.request.clientOrderId).length===1&&
        proof===this.nativeExitOrderProof(order));
  }
  private nativeExitSubmissionAllowed(p:Position,pending?:JournalOrder):boolean {
    if(!this.nativeExitAuthorities.has(p.id))return !this.historicalNativeExitAudit(p);
    try{return this.hasNativeExitAuthority(p)&&this.nativeExitAuthorities.get(p.id)!.guard(pending)&&
      !this.store.data.orders.some(order=>isCurrentUnconfirmedOrder(order,this.store.data.positions)&&
        (order.positionId===p.id||!unresolvedCoin(order,this.store.data.positions)||unresolvedCoin(order,this.store.data.positions)===coinBase(p.base)||
          [p.long,p.short].some(leg=>leg.exchange===order.exchange&&leg.symbol===order.request.symbol))&&
        !this.isNativeExitAuditOrder(p,order)&&order!==pending&&
        !this.ownsActiveMakerIntent(p,order)&&!this.ownsActiveIocProfitIntent(p,order));}
    catch{return false;}
  }
  private isNativeExitAuditOrder(p:Position,order:JournalOrder):boolean {
    return this.hasNativeExitAuthority(p)&&this.nativeExitAuthorities.get(p.id)!.orders.some(value=>value.order===order);
  }
  /** Only the exact unchanged historical IOC selected by this process's native recovery.
   * Used for read-side bookkeeping; it never grants a new order or resolves its cash. */
  isNativeExitRecoveryOrder(p:Position,order:JournalOrder):boolean {
    return this.isNativeExitAuditOrder(p,order)&&this.nativeExitSubmissionAllowed(p);
  }
  private ownsActiveMakerIntent(p:Position,order:JournalOrder):boolean {
    const owned=this.activeMakerIntents.get(p.id);
    return !!owned&&owned.journal===order&&this.makerCloseSupervisor.has(p.id)&&order.positionId===p.id&&
      !!order.makerReduction&&order.makerReduction.activity!=='terminal'&&
      owned.proof===JSON.stringify([order.positionId,order.exchange,order.createdAt,order.request]);
  }
  private historicalNativeExitAudit(p:Position,order?:JournalOrder):NativeExitRecoveryAudit|undefined {
    return p.nativeExitRecoveryAudit&&[...p.nativeExitRecoveryAudit].reverse().find(audit=>!order||audit.unknownClientOrderIds.includes(order.request.clientOrderId));
  }
  private blockingExitOrder(p:Position,order:JournalOrder):boolean {
    return isCurrentUnconfirmedOrder(order,this.store.data.positions)&&!this.isNativeExitAuditOrder(p,order);
  }
  private exitJournalProof(p:Position,orders:readonly JournalOrder[]):string {
    return JSON.stringify(orders.map(order=>this.isNativeExitAuditOrder(p,order)?
      {nativeExitFinancialProof:this.nativeExitOrderProof(order)}:order));
  }
  revokeNativeExitAuthority(p:Position,reason:string):void {
    const authority=this.nativeExitAuthorities.get(p.id),audit=authority?.audit??p.nativeExitRecoveryAudit?.at(-1);
    if(audit&&audit.revokedAt===undefined){audit.revokedAt=Date.now();audit.revocationReason=reason;}
    this.nativeExitAuthorities.delete(p.id);this.pendingMakerCloseTails.delete(p.id);this.pendingIocProfitTails.delete(p.id);
    this.stoppedMakerTailWorkers.add(p.id);this.makerCloseSupervisor.requestStop(p.id,reason);
    p.status='attention';p.riskReasons=[reason];
    try{this.store.save();this.store.log('warn',`${p.base} 原生持仓退出授权暂停：${reason}`,p.id);}
    catch(error){this.interruptedOrderProcessing.add(p.id);this.store.data.killSwitch=true;throw error;}
  }
  async repairNativeConfirmedTail(p:Position,parentClientId:string):Promise<boolean> {
    const authority=this.nativeExitAuthorities.get(p.id);
    if(!authority||this.nativeExitWorkers.has(p.id)||(authority.audit.confirmedTailParentClientOrderId??authority.audit.parentClientOrderId)!==parentClientId||!this.nativeExitSubmissionAllowed(p))return false;
    this.stoppedMakerTailWorkers.delete(p.id);
    const task=this.repairConfirmedMakerCloseTail(p,parentClientId,[],pending=>this.nativeExitSubmissionAllowed(p,pending));
    this.nativeExitWorkers.set(p.id,task);
    try{return await task;}finally{this.nativeExitWorkers.delete(p.id);}
  }
  /** Fresh exposure/open-order reads are confined to the explicitly restored groups' actual actions. */
  private async verifyNativeExitBeforeSubmit(p:Position,pending?:JournalOrder):Promise<boolean> {
    const authority=this.nativeExitAuthorities.get(p.id);if(!authority)return !this.historicalNativeExitAudit(p);
    if(!this.nativeExitSubmissionAllowed(p,pending)||this.stoppedMakerTailWorkers.has(p.id))return false;
    const quantities=[p.long.quantity,p.short.quantity],readStarted=Date.now();let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const reads=Promise.all([p.long,p.short].map(async leg=>{
        const adapter=this.context.adapter(leg.exchange);if(!adapter.fetchOpenOrders)throw new Error('缺少完整原生挂单核验');
        const [account,open]=await Promise.all([adapter.fetchAccount(),adapter.fetchOpenOrders(leg.symbol)]);
        return {leg,account,open};
      }));
      const rows=await Promise.race([reads,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('原生退出前核验超时')),8000);})]);
      if(Date.now()-readStarted>8000||this.nativeExitAuthorities.get(p.id)!==authority||
        !this.nativeExitSubmissionAllowed(p,pending)||this.stoppedMakerTailWorkers.has(p.id)||
        p.long.quantity!==quantities[0]||p.short.quantity!==quantities[1])return false;
      for(const {leg,account,open} of rows){
        const actual=account.positions.filter(row=>row.symbol===leg.symbol&&row.quantity>0),
          evidence=authority.audit.nativeReadEvidence.find(row=>row.exchange===leg.exchange&&row.symbol===leg.symbol&&row.side===leg.side);
        if(leg.quantity===0){if(actual.length)return false;}
        else if(!evidence||actual.length!==1||actual[0].side!==leg.side||actual[0].splitPositionCount&&actual[0].splitPositionCount!==1||
          !Number.isFinite(actual[0].quantity)||!sameQuantity(actual[0].quantity,leg.quantity)||
          evidence.positionId!==undefined&&actual[0].positionId!==evidence.positionId||
          evidence.positionOpenedAt!==undefined&&actual[0].positionOpenedAt!==evidence.positionOpenedAt||
          evidence.entryPrice!==undefined&&actual[0].entryPrice!==evidence.entryPrice||
          evidence.marginMode!==undefined&&actual[0].marginMode!==evidence.marginMode)return false;
        if(open.some(row=>!this.store.data.orders.some(order=>order!==pending&&order.positionId===p.id&&
          this.ownsActiveMakerIntent(p,order)&&order.makerReduction?.activity==='active'&&order.result?.id===row.id&&
          order.exchange===leg.exchange&&order.request.symbol===row.symbol&&order.request.postOnly===true&&order.request.reduceOnly===true&&
          row.reduceOnly===true&&row.kind==='regular'&&row.side===order.request.side)))return false;
      }
      return true;
    }catch{return false;}finally{if(timer)clearTimeout(timer);}
  }
  private entryConfig(p:Position):AppConfig {
    const c=this.context.config();
    return p.automaticEntry&&p.executionEvidence?.entryPath==='price-100'?{...c,minEntryIocEdgeBps:Math.max(c.minEntryIocEdgeBps,AUTO_ENTRY_PRICE_ROUTE_MIN_IOC_EDGE_BPS)}:c;
  }
  private paperFeeOnly(p:Position){const c=this.context.config();return c.mode===p.mode&&isFeeOnly(c);}
  private trace(p:Position,phase:ExecutionTrace['phase'],batch?:number){
    try{this.context.trace?.({positionId:p.id,base:p.base,phase,at:Date.now(),...(batch===undefined?{}:{batch})});}
    catch{/* Timing observers cannot interrupt submission or confirmed-fill handling. */}
  }
  private freshSnapshot(p:Position,leg:PositionLeg){
    const c=this.context.config();
    const adapter=c.mode==='live'?this.context.adapter(leg.exchange) as ExchangeAdapter&{getExecutionSnapshot?:(base:string)=>MarketSnapshot|undefined}:undefined;
    // A realtime book must be a complete, symbol-specific snapshot. Economics still requires
    // fresh native fees/funding; an incomplete stream observation cannot borrow old account facts.
    const s=adapter?.getExecutionSnapshot?.(p.base)??this.context.snapshot(leg.exchange,p.base);
    const now=Date.now();
    return s&&quoteIsFresh(s,c,now)&&this.context.canUseSnapshot?.(leg.exchange,p.base)!==false?s:undefined;
  }
  private makerSnapshot(p:Position,leg:PositionLeg){
    // The engine selects the realtime book and overlays the current native fee cache.
    // Reading the adapter book directly can leave a prior fee on the final POST guard.
    const s=this.context.snapshot(leg.exchange,p.base),c=this.context.config();
    return s&&quoteIsFresh(s,c,Date.now())&&this.context.canUseSnapshot?.(leg.exchange,p.base)!==false?s:undefined;
  }
  private buildOrder(p:Position,leg:PositionLeg,side:Side,quantity:number,reduceOnly:boolean):PreparedOrder{
    const c=this.context.config(),s=this.freshSnapshot(p,leg);
    if(!reduceOnly&&this.context.allowEntry?.(p)===false)throw new Error('该币种开仓已被冻结');
    if(!s)throw new Error('行情过期，无法确定限价');
    if(s.exchange!==leg.exchange||s.base!==p.base||s.symbol!==leg.symbol)throw new Error('盘口与待交易合约不一致');
    if(c.mode==='live'&&!this.context.liveUnlocked())throw new Error('实盘执行开关未解锁');
    if(!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(s.quantityStep)||s.quantityStep<=0)throw new Error('下单数量或合约精度无效');
    const reduction=reduceOnly?this.context.prepareReduction?.(leg,quantity):undefined;
    if(reduction){
      if(!Number.isFinite(reduction.quantity)||reduction.quantity<=0||reduction.quantity>quantity)throw new Error('手动减仓数量超出已确认范围');
      quantity=reduction.quantity;
    }
    quantity=floorQuantity(quantity,s.quantityStep);
    if(quantity<s.minQuantity||quantity<=0)throw new Error('剩余数量低于交易所最小下单量，需要人工处理');
    const observedLevels=this.observedLevels(s,side);
    // A live reduction is bounded by currently displayed depth, never an unbounded market order.
    if(c.mode==='live'&&reduceOnly){
      quantity=floorQuantity(Math.min(quantity,observedLevels.reduce((total,level)=>total+level.quantity,0)),s.quantityStep);
      if(quantity<s.minQuantity||quantity<=0)throw new Error('当前盘口可成交数量不足，保留残余仓位等待新盘口');
    }
    // Use only the displayed book. Legacy slippage budgets and mark-price fallbacks cannot manufacture a limit.
    let remaining=quantity,worst:number|undefined;
    for(const level of observedLevels){
      if(remaining<=0)break;
      worst=worst===undefined?level.price:side==='buy'?Math.max(worst,level.price):Math.min(worst,level.price);
      remaining-=Math.min(remaining,level.quantity);
    }
    if(worst===undefined)throw new Error('当前盘口没有可成交报价');
    if(!reduceOnly&&remaining>quantity*1e-9)throw new Error('当前盘口不足以成交整笔开仓数量');
    const limitPrice=worst;
    const req:OrderRequest={clientOrderId:`fa${randomUUID().replaceAll('-','').slice(0,26)}`,base:p.base,symbol:leg.symbol,side,quantity,limitPrice,reduceOnly,
      ...(reduction?.closePosition?{closePosition:reduction.closePosition}:{})};
    if(!Number.isFinite(req.limitPrice)||req.limitPrice<=0)throw new Error('当前盘口限价无效');
    if(!reduceOnly&&(!Number.isFinite(s.minNotional)||s.minNotional<0||req.quantity*req.limitPrice<s.minNotional))
      throw new Error('实际下单金额低于交易所最小下单额');
    return {leg,request:req,snapshot:s,contractSize:s.contractSize};
  }
  private observedLevels(s:MarketSnapshot,side:Side){
    return (side==='buy'?s.asks:s.bids).filter(level=>Number.isFinite(level.price)&&level.price>0&&Number.isFinite(level.quantity)&&level.quantity>0)
      .sort((a,b)=>side==='buy'?a.price-b.price:b.price-a.price);
  }
  /** Validate the original IOC bound against current contents, not a WS object's identity. */
  private checkPreparedOrder(p:Position,prepared:PreparedOrder){
    const {leg,request}=prepared,current=prepared.makerReduction?this.makerSnapshot(p,leg):this.freshSnapshot(p,leg);
    if(!current)throw new PreparedBookChangedError('提交前盘口已过期，停止提交');
    if(current.exchange!==leg.exchange||current.base!==p.base||current.symbol!==leg.symbol||
      current.contractSize!==prepared.contractSize||!Number.isFinite(current.quantityStep)||current.quantityStep<=0||
      !sameQuantity(floorQuantity(request.quantity,current.quantityStep),request.quantity)||
      !Number.isFinite(current.minQuantity)||request.quantity<current.minQuantity||
      !request.reduceOnly&&(!Number.isFinite(current.minNotional)||current.minNotional<0||request.quantity*request.limitPrice<current.minNotional))
      throw new Error('提交前合约或合法下单数量已变化，停止提交');
    if(request.postOnly){
      const bid=bestOppositeLevel(current,'sell'),ask=bestOppositeLevel(current,'buy');
      const maker=nativeMakerFeeRate(current),taker=takerFeeRate(current,this.context.config());
      if(request.reduceOnly&&!prepared.makerReduction||!bid||!ask||!(bid.price<ask.price)||
        (request.side==='buy'?request.limitPrice>=ask.price:request.limitPrice<=bid.price))
        throw new Error('Maker 首腿已可能吃单，未提交本次挂单');
      if(maker===undefined||!prepared.makerReduction&&(taker===undefined||!(maker<taker)))throw new Error('提交前官方 Maker 费率已缺失或不再省费，未提交挂单');
    }else if(prepared.pricing==='best-opposite'){
      const top=request.reduceOnly?bestCloseOppositeLevel(current,leg.side):bestOppositeLevel(current,request.side);
      if(!top||request.quantity>top.quantity+Math.max(1e-12,Math.abs(top.quantity)*Number.EPSILON*8)||
        (request.side==='buy'?top.price>request.limitPrice:top.price<request.limitPrice))
        throw new PreparedBookChangedError('提交前首档盘口已变化，原限价或首档数量已不可成交');
    }else{
      const levels=this.observedLevels(current,request.side),available=levels.filter(level=>request.side==='buy'?level.price<=request.limitPrice:level.price>=request.limitPrice)
        .reduce((quantity,level)=>quantity+level.quantity,0);
      const simulatedPartialClose=request.reduceOnly&&this.context.config().mode==='paper';
      if(!(available>0)||!simulatedPartialClose&&request.quantity>available+Math.max(1e-12,Math.abs(available)*Number.EPSILON*8))
        throw new Error('提交前盘口已变化，原限价内数量不足');
      if(!request.reduceOnly&&(p.entryPolicy??'dual')!=='aligned'){
        // Historical dual/funding policies keep their pre-existing exact executable-price guard.
        // A new WS object with the same book passes; an in-place price mutation cannot hide it.
        let remaining=request.quantity,worst:number|undefined;
        for(const level of levels){if(remaining<=0)break;worst=level.price;remaining-=Math.min(remaining,level.quantity);}
        if(worst!==request.limitPrice)throw new Error('提交前盘口已变化，原策略下单价格已改变');
      }
    }
    // Keep the request/ID unchanged. A favorable book update allows that conservative bound,
    // and freshness at submission must refer to the latest observation rather than the old object.
    prepared.snapshot=current;
  }
  private async validateOrders(orders:PreparedOrder[]){
    if(this.context.config().mode==='live')await Promise.all(orders.map(order=>this.context.adapter(order.leg.exchange).validateOrder?.(order.request)));
  }
  private async refresh(p:Position,legs:PositionLeg[]){
    if(this.context.config().mode==='live')await this.context.refreshSnapshots?.(p.base,[...new Set(legs.map(leg=>leg.exchange))]);
  }
  private async refreshReduction(p:Position,legs:PositionLeg[]){
    if(this.context.config().mode!=='live')return;
    const refresh=this.context.refreshReductionSnapshots??this.context.refreshSnapshots;
    await refresh?.(p.base,[...new Set(legs.map(leg=>leg.exchange))]);
  }
  private makerPeerOrders(p:Position,journal:JournalOrder,legacyIds:readonly string[]=[]):JournalOrder[]|undefined {
    const state=journal.makerReduction,peer=state&&p[state.makerLeg==='long'?'short':'long'];
    const ids=[...new Set([...(state?.recoveredPeers?.clientOrderIds??[]),...legacyIds])];
    if(!peer||ids.length>20||ids.some(id=>!id||typeof id!=='string'))return;
    const orders=this.store.data.orders,linked=orders.filter(order=>order.positionId===p.id&&
      order.executionEvidence?.makerCloseParentClientId===journal.request.clientOrderId);
    for(const id of ids){
      const found=orders.filter(order=>order.request.clientOrderId===id);
      if(found.length!==1)return;
      const order=found[0];
      if(order.executionEvidence?.makerCloseParentClientId&&order.executionEvidence.makerCloseParentClientId!==journal.request.clientOrderId||
        orders.some(other=>other!==journal&&other.makerReduction?.recoveredPeers?.clientOrderIds.includes(id)))return;
      if(!linked.includes(order))linked.push(order);
    }
    // Audited historical unknowns retain their receipts; they consume no *confirmed* new tail budget.
    // Their possible old costs are reserved independently in the exit economics.
    const confirmedLinked=linked.filter(order=>!this.isNativeExitAuditOrder(p,order));
    const conflicts=conflictingNativeOrderReceipts(orders);
    if(conflicts.size||confirmedLinked.some(order=>order.positionId!==p.id||order.exchange!==peer.exchange||
      order.request.symbol!==peer.symbol||order.request.base!==p.base||!order.request.reduceOnly||order.request.postOnly||
      order.request.side!==(peer.side==='long'?'sell':'buy')||order.createdAt<journal.createdAt||
      !['exit','exit-tail'].includes(order.executionEvidence?.role??'')||order.executionEvidence?.method!=='ioc'||
      !order.result||!isTerminalOrderReceipt(order.request,order.result)||order.result.averagePriceVerified===false||
      order.result.filledQuantity>0&&(!(order.result.averagePrice>0)||!Number.isFinite(order.result.averagePrice))||
      !Number.isFinite(order.result.feeUsd)||!sameQuantity(order.executionEvidence.bookedFeeUsd??NaN,order.result.feeUsd)))return;
    return confirmedLinked;
  }
  private makerPeerBudget(p:Position,journal:JournalOrder,legacyIds:readonly string[]=[]):number|undefined {
    const result=journal.result,state=journal.makerReduction,peers=this.makerPeerOrders(p,journal,legacyIds);
    if(!state||!result||!state.bookedExecution||journal.positionId!==p.id||!this.store.data.orders.includes(journal)||
      this.store.data.orders.filter(order=>order.request.clientOrderId===journal.request.clientOrderId).length!==1||
      journal.exchange!==p[state.makerLeg].exchange||journal.request.symbol!==p[state.makerLeg].symbol||
      journal.request.base!==p.base||!journal.request.reduceOnly||journal.request.postOnly!==true||
      journal.request.side!==(state.makerLeg==='long'?'sell':'buy')||journal.executionEvidence?.method!=='maker'||
      !hasOrderReceiptIdentity(journal.request,result)||!hasBoundedOrderQuantity(journal.request,result)||
      !(result.timestamp>0)||!Number.isFinite(result.timestamp)||
      result.filledQuantity>0&&(!(result.averagePrice>0)||!Number.isFinite(result.averagePrice))||
      result.averagePriceVerified===false||!Number.isFinite(result.feeUsd)||
      !sameQuantity(journal.executionEvidence.bookedFeeUsd??NaN,result.feeUsd)||!peers)return;
    let used=0;for(const peer of peers)used=quantityAdd(used,peer.result!.filledQuantity);
    const budget=quantitySubtractOnStep(result.filledQuantity,used,state.quantityStep??NaN);
    return Number.isFinite(budget)&&budget>=0?budget:undefined;
  }
  private makerTailBudgetMatches(p:Position,excess:number,budget:number,step:number):boolean {
    // Off-grid fill cash stays exact; subtracting large retained quantities may differ by a few ulps.
    const tolerance=Math.min(step*1e-7,Number.EPSILON*Math.max(p.long.quantity,p.short.quantity,budget)*8);
    return Number.isFinite(excess)&&Number.isFinite(budget)&&Number.isFinite(tolerance)&&Math.abs(excess-budget)<=tolerance;
  }
  private saveMakerTail(p:Position):void {
    try{this.store.save();}catch(error){this.interruptedOrderProcessing.add(p.id);this.store.data.killSwitch=true;throw error;}
  }
  /** True only for the exact already-filled peer budget, never for a new common close batch. */
  canRepairConfirmedMakerCloseTail(p:Position,parentClientOrderId:string,legacyIds:string[]=[],workerOwned=false):boolean {
    const parents=this.store.data.orders.filter(order=>order.request.clientOrderId===parentClientOrderId);
    if(parents.length!==1||parents[0].positionId!==p.id)return false;
    const journal=parents[0];
    if(!journal?.makerReduction||journal.makerReduction.activity!=='terminal'||!journal.result||
      !isTerminalOrderReceipt(journal.request,journal.result)||this.context.config().mode!=='live'||p.mode!=='live'||
      !isPositionActive(p)||p.manualCloseOnly||p.closeRequestedAt===undefined||p.closeProfitRequired!==true||
      (this.makerCloseSupervisor.has(p.id)||!workerOwned&&this.makerTailWorkers.has(p.id))||this.interruptedOrderProcessing.has(p.id)||this.store.data.killSwitch||
      !this.context.liveUnlocked()||this.context.makerActionsAllowed?.()===false||this.closeRefusals(p).size||
      this.store.data.orders.some(order=>order.positionId===p.id&&this.blockingExitOrder(p,order)))return false;
    const maker=p[journal.makerReduction.makerLeg],peer=p[journal.makerReduction.makerLeg==='long'?'short':'long'];
    let book:MarketSnapshot|undefined;
    try{book=this.freshSnapshot(p,peer);}catch{return false;} // A revoked venue cannot throw out of a WS eligibility check.
    const step=book?.quantityStep??journal.makerReduction.peerQuantityStep??NaN,budget=this.makerPeerBudget(p,journal,legacyIds);
    const excess=quantitySubtractOnStep(peer.quantity,maker.quantity,step);
    return budget!==undefined&&excess>=0&&this.makerTailBudgetMatches(p,excess,budget,step);
  }
  async repairConfirmedMakerCloseTail(p:Position,parentClientOrderId:string,legacyIds:string[]=[],canSubmit?:(pending?:JournalOrder)=>boolean):Promise<boolean> {
    if(canSubmit?.()===false||!this.canRepairConfirmedMakerCloseTail(p,parentClientOrderId,legacyIds))return false;
    const journal=this.store.data.orders.find(order=>order.positionId===p.id&&order.request.clientOrderId===parentClientOrderId)!;
    try{await this.refreshReduction(p,[p.long,p.short]);}
    catch{return false;} // A missing public book grants no POST and keeps a session-owned tail retryable.
    if(canSubmit?.()===false||!this.canRepairConfirmedMakerCloseTail(p,parentClientOrderId,legacyIds))return false;
    if(legacyIds.length){
      journal.makerReduction!.recoveredPeers={verifiedAt:Date.now(),clientOrderIds:[...new Set([
        ...(journal.makerReduction!.recoveredPeers?.clientOrderIds??[]),...legacyIds])]};
      try{this.updateMakerComparisons(journal);this.store.save();}catch(error){
        this.interruptedOrderProcessing.add(p.id);this.store.data.killSwitch=true;throw error;
      }
    }
    const peer=p[journal.makerReduction!.makerLeg==='long'?'short':'long'],config=this.context.config(),start=this.store.data.orders.length;
    const reason=await this.hedgeMakerExcess(p,journal,peer,canSubmit,this.hasNativeExitAuthority(p)&&!!this.context.serialize);
    if(reason){
      const book=this.freshSnapshot(p,peer),excess=quantitySubtractOnStep(peer.quantity,p[journal.makerReduction!.makerLeg].quantity,book?.quantityStep??NaN);
      const committed=this.store.data.orders.slice(start).some(order=>order.positionId===p.id&&
        order.executionEvidence?.makerCloseParentClientId===parentClientOrderId);
      if(committed&&this.context.config()===config&&book&&isLegalQuantity(excess,book.quantityStep,book.minQuantity)&&
        this.canRepairConfirmedMakerCloseTail(p,parentClientOrderId)){
        this.pendingMakerCloseTails.set(p.id,{position:p,journal,config,requestedAt:p.closeRequestedAt!,
          signature:JSON.stringify([journal.positionId,journal.exchange,journal.request]),retryAfter:Date.now()+MAKER_CLOSE_RETRY_COOLDOWN_MS});
        p.status='closing';p.riskReasons=['限定修复已确认减仓结果；原 Maker 对侧剩余合法预算等待新盘口后续处理'];
      }else{p.status='attention';p.riskReasons=[reason];}
      refreshPnl(p);this.saveMakerTail(p);return false;
    }
    this.pendingMakerCloseTails.delete(p.id);
    try{
      const finish=()=>this.finishBestClose(p,'已确认 Maker 成交的对侧尾差已补齐；等待最新双账户核对',this.closeRefusals(p));
      if(this.hasNativeExitAuthority(p)&&this.context.serialize)await this.context.serialize(async()=>finish());else finish();
    }
    catch(error){this.interruptedOrderProcessing.add(p.id);this.store.data.killSwitch=true;throw error;}
    return sameQuantity(p.long.quantity,p.short.quantity);
  }
  /** Local cash eligibility only. New finer reductions need current automatic economics and native guards. */
  canRepairConfirmedMakerLotTail(p:Position,parent:JournalOrder):boolean {
    if(this.context.config().mode!=='live'||!this.context.liveUnlocked()||this.store.data.killSwitch||
      this.interruptedOrderProcessing.has(p.id)||this.hasMakerClose(p)||this.lotTailRepairs.has(p.id)||
      p.closeRequestedAt===undefined||p.closeProfitRequired!==true||this.closeRefusals(p).size||
      this.store.data.orders.some(order=>order.positionId===p.id&&isCurrentUnconfirmedOrder(order,this.store.data.positions)))return false;
    const plan=planConfirmedLotTailRestoration({position:p,parent,orders:this.store.data.orders,
      long:this.context.snapshot(p.long.exchange,p.base),short:this.context.snapshot(p.short.exchange,p.base),config:this.context.config(),
      fundingExitQualified:(assessment,long,short,now)=>this.context.fundingExitQualified?.(p,assessment,long,short,now)===true});
    return plan.status!=='blocked';
  }
  /** Explicitly scoped minimum common reduction. Original cash is untouched; only terminal
   * new Maker cash can enlarge its peer budget. It never buys back a reduced holding. */
  async repairConfirmedMakerLotTail(p:Position,parent:JournalOrder,ensure:()=>void,
    verifyAccounts:(previousQuantities?:{long:number;short:number})=>Promise<void>):Promise<boolean> {
    ensure();if(!this.canRepairConfirmedMakerLotTail(p,parent))return false;
    const config=this.context.config(),parentId=parent.request.clientOrderId;
    this.lotTailRepairs.add(p.id);
    const check=()=>{
      ensure();if(this.context.config()!==config||!this.context.liveUnlocked()||this.context.makerActionsAllowed?.()===false||
        this.store.data.killSwitch||this.interruptedOrderProcessing.has(p.id)||!this.store.data.positions.includes(p)||
        !this.store.data.orders.includes(parent)||parent.request.clientOrderId!==parentId||this.closeRefusals(p).size)
        throw new Error('所选最小共同尾差恢复范围、许可或原现金已变化');
    };
    const plan=(excluded?:JournalOrder)=>planConfirmedLotTailRestoration({position:p,parent,
      orders:excluded?this.store.data.orders.filter(order=>order!==excluded):this.store.data.orders,
      long:this.context.snapshot(p.long.exchange,p.base),short:this.context.snapshot(p.short.exchange,p.base),config,
      fundingExitQualified:(assessment,long,short,now)=>this.context.fundingExitQualified?.(p,assessment,long,short,now)===true});
    const persist=()=>this.saveMakerTail(p);
    try{
      for(let attempt=0;attempt<3;attempt++){
        check();await this.refreshReduction(p,[p.long,p.short]);check();let ready=plan();
        // Already confirmed peer cash needs prices/quantity guards only. New finer
        // reduction permission still requires fresh actual account fees and economics.
        if(ready.status!=='reduce-peer'&&ready.status!=='matched'){
          await this.refresh(p,[p.long,p.short]);check();ready=plan();
        }
        if(ready.status==='matched')return true;
        if(ready.status==='blocked'||ready.status==='waiting'){
          p.status='attention';p.riskReasons=[ready.reason];persist();return false;
        }
        const prior={long:p.long.quantity,short:p.short.quantity};
        if(ready.status==='reduce-peer'){
          const leg=p[ready.peerLeg!],prepared=this.bestCloseOrder(p,leg,ready.peerReductionQuantity!);
          prepared.role='exit-tail';prepared.makerCloseLotTailOriginalParentClientId=parentId;
          prepared.makerCloseLotTailParentClientIds=[...ready.parentClientIds!];
          const originalRequest=JSON.stringify(prepared.request);
          const permission=(own?:JournalOrder)=>{
            check();const current=plan(own);
            return JSON.stringify(prepared.request)===originalRequest&&(!own||own.request===prepared.request)&&
              current.status==='reduce-peer'&&current.proof===ready.proof&&
              sameQuantity(current.peerReductionQuantity!,prepared.request.quantity);
          };
          await this.validateOrders([prepared]);check();this.checkPreparedOrder(p,prepared);
          const result=await this.submitOrder(p,prepared,permission);
          if(!canRetryCloseReceipt(result))return false;
          await verifyAccounts(prior);check();return plan().status==='matched';
        }
        const leg=p[ready.makerLeg!],peer=p[ready.peerLeg!],book=this.makerSnapshot(p,leg),adapter=this.context.adapter(leg.exchange);
        if(!book||adapter.supportsMakerReduction?.()!==true||!adapter.validateMakerReduction||!adapter.submitMakerReduction||
          !adapter.inspectMakerReduction||!adapter.cancelMakerReduction)return false;
        const scope=this.closeReductionScope(leg,ready.augmentationQuantity!);
        if(scope&&!sameQuantity(scope.quantity,ready.augmentationQuantity!))return false;
        const prepared:PreparedOrder={leg,snapshot:book,contractSize:book.contractSize,makerReduction:true,role:'exit',request:{
          clientOrderId:`fa${randomUUID().replaceAll('-','').slice(0,26)}`,base:p.base,symbol:leg.symbol,
          side:leg.side==='long'?'sell':'buy',quantity:ready.augmentationQuantity!,limitPrice:ready.makerLimitPrice!,reduceOnly:true,postOnly:true,
          ...(scope?.closePosition?{closePosition:scope.closePosition}:{})}};
        await adapter.validateMakerReduction(prepared.request);check();this.checkPreparedOrder(p,prepared);
        if(plan().proof!==ready.proof||plan().status!=='augment-maker')return false;
        const at=Date.now(),request=prepared.request,originalRequest=JSON.stringify(request),journal:JournalOrder={positionId:p.id,exchange:leg.exchange,request,createdAt:at,result:this.unknown(request),
          makerReduction:{activity:'unknown',makerLeg:ready.makerLeg!,deadlineAt:at+MAKER_CLOSE_TIMEOUT_MS,
            quantityStep:book.quantityStep,peerQuantityStep:this.context.snapshot(peer.exchange,p.base)!.quantityStep,
            lotTailOriginalParentClientId:parentId,bookedExecution:false},
          executionEvidence:{version:1,method:'maker',role:'exit',batchId:`${p.id}:lot-tail:${parentId}:${attempt}`,bookedFeeUsd:0,
            referencePrice:bestCloseOppositeLevel(book,leg.side)?.price,referenceObservedAt:book.observedAt??book.timestamp,
            nativeTakerFeeRate:nativeTakerFeeRate(book),nativeMakerFeeRate:nativeMakerFeeRate(book),feeObservedAt:book.makerFeeAt}};
        this.store.data.orders.push(journal);persist();let terminal=false;
        const permission=()=>{
          try{check();this.checkPreparedOrder(p,prepared);
            if(!this.store.data.orders.includes(journal)||journal.request!==request||JSON.stringify(request)!==originalRequest||
              journal.makerReduction?.lotTailOriginalParentClientId!==parentId||journal.result?.filledQuantity!==0||journal.result.id||
              Date.now()>=journal.makerReduction!.deadlineAt)return false;
            const current=plan(journal);
            if(current.status!=='augment-maker'||current.proof!==ready.proof||!sameQuantity(current.augmentationQuantity!,request.quantity))return false;
            journal.executionEvidence!.submittedAt=Date.now();journal.makerReduction!.submittedAt=Date.now();persist();return true;
          }catch{return false;}
        };
        const started=this.makerCloseSupervisor.start(p.id,journal.makerReduction!.deadlineAt,{
          submit:async()=>{this.operationSubmitted(p,journal);return adapter.submitMakerReduction!(request,permission);},
          acknowledge:async ack=>{
            if(ack?.clientOrderId===request.clientOrderId&&ack.id){journal.result={...journal.result!,id:ack.id};journal.makerReduction!.acknowledgedAt=Date.now();}
            else if(ack&&isTerminalOrderReceipt(request,ack)&&ack.filledQuantity===0&&ack.averagePrice===0&&ack.feeUsd===0){
              if(!this.applyObservedMakerTerminal(journal,{activity:'terminal',executionVerified:true,result:ack,observedAt:Date.now()}))throw new Error('新增 Maker 本地否决现金未确认');
              terminal=true;
            }
            persist();this.operationObserved(p);
          },
          inspect:async()=>terminal?{activity:'terminal',executionVerified:true,result:journal.result!,observedAt:Date.now()}:
            adapter.inspectMakerReduction!(request,journal.result?.id||undefined),
          observe:async observation=>{
            if(terminal)return {terminal:true};
            const receipt=observation.result,priorObservation=journal.makerReduction!.lotTailObservedExecution,
              validation={...receipt,status:receipt.filledQuantity>=request.quantity?'filled' as const:receipt.filledQuantity>0?'partial' as const:'cancelled' as const};
            if(!observation.executionVerified||!isTerminalOrderReceipt(request,validation)||
              journal.result?.id&&receipt.id!==journal.result.id||!Number.isFinite(receipt.feeUsd)||receipt.averagePriceVerified===false||
              receipt.filledQuantity>0&&(!(receipt.averagePrice>0)||!Number.isFinite(receipt.averagePrice))||
              priorObservation&&receipt.filledQuantity<priorObservation.filledQuantity-orderQuantityTolerance(priorObservation.filledQuantity))
              return {terminal:false,stopReason:'新增 Maker 累计真实现金未确认或低于原已见下界；保留原 ID'};
            journal.makerReduction!.lotTailObservedExecution=structuredClone(receipt);persist();
            if(observation.activity!=='terminal')return {terminal:false};
            if(!this.applyObservedMakerTerminal(journal,observation))throw new Error('新增 Maker 终态现金无法入账，未提交粗腿');
            terminal=true;return {terminal:true};
          },
          canRest:async()=>{
            try{check();this.checkPreparedOrder(p,prepared);const current=plan(journal);
              return current.status==='augment-maker'&&current.proof===ready.proof;
            }catch{return false;}
          },
          cancel:async()=>{
            if(journal.result?.id&&!terminal){
              journal.makerReduction!.cancelRequestedAt=Date.now();
              try{persist();}finally{await adapter.cancelMakerReduction!(request,journal.result.id);}
            }
          },
          finish:async reason=>{if(!terminal){p.status='attention';p.riskReasons=[reason];persist();}},
          failed:()=>{this.interruptedOrderProcessing.add(p.id);this.store.data.killSwitch=true;},
        });
        if(!started)throw new Error('原 Maker 会话仍在活动，未授权新增尾差恢复');
        await this.makerCloseSupervisor.settled(p.id);
        if(!terminal||isCurrentUnconfirmedOrder(journal,this.store.data.positions)||
          !canRetryCloseReceipt(journal.result!,true)&&!isControlledBybitMakerCancellation(journal))return false;
        await verifyAccounts(prior);check();
      }
      p.status='attention';p.riskReasons=['最小共同尾差本次有限尝试已结束，保留真实累计确认预算等待再次核验'];persist();return false;
    }catch(error){
      p.status='attention';p.riskReasons=['最小共同尾差恢复未完成，保留所有原 ID 与真实现金，禁止重放未知原单'];
      try{persist();}catch{/* The original persistence guard has already frozen risk. */}
      throw error;
    }finally{this.lotTailRepairs.delete(p.id);}
  }
  hasPendingMakerCloseTail(p:Position):boolean {
    const pending=this.pendingMakerCloseTails.get(p.id);
    if(!pending||pending.position!==p||this.context.config()!==pending.config||p.closeRequestedAt!==pending.requestedAt||
      JSON.stringify([pending.journal.positionId,pending.journal.exchange,pending.journal.request])!==pending.signature)return false;
    return !sameQuantity(p.long.quantity,p.short.quantity)&&
      this.canRepairConfirmedMakerCloseTail(p,pending.journal.request.clientOrderId);
  }
  makerCloseTailRetryAfter(p:Position):number {
    return this.hasPendingMakerCloseTail(p)?this.pendingMakerCloseTails.get(p.id)!.retryAfter:0;
  }
  async continueMakerCloseTail(p:Position):Promise<boolean> {
    if(!this.hasPendingMakerCloseTail(p))return false;
    const pending=this.pendingMakerCloseTails.get(p.id)!;
    if(Date.now()<pending.retryAfter)return false;
    pending.retryAfter=Date.now()+MAKER_CLOSE_RETRY_COOLDOWN_MS;
    pending.journal.makerReduction!.tailRetryAt=Date.now();
    const result=await this.repairConfirmedMakerCloseTail(p,pending.journal.request.clientOrderId);
    if(!result&&this.canRepairConfirmedMakerCloseTail(p,pending.journal.request.clientOrderId)){
      p.status='closing';p.riskReasons=['原 Maker 已确认成交的对侧尾差等待新盘口；未扩大共同平仓量'];this.saveMakerTail(p);
    }
    return result;
  }
  /** Dispatch only this process's original confirmed budget; another symbol's network waits never hold its cash queue. */
  dispatchMakerCloseTail(p:Position):boolean {
    if(this.hasMakerClose(p)||!this.hasPendingMakerCloseTail(p)||!this.context.serialize)return false;
    const pending=this.pendingMakerCloseTails.get(p.id)!;
    if(Date.now()<pending.retryAfter)return false;
    pending.retryAfter=Date.now()+MAKER_CLOSE_RETRY_COOLDOWN_MS;
    pending.journal.makerReduction!.tailRetryAt=Date.now();this.stoppedMakerTailWorkers.delete(p.id);
    const allowed=()=>!this.stoppedMakerTailWorkers.has(p.id)&&this.context.config()===pending.config&&
      this.context.makerActionsAllowed?.()!==false&&this.context.liveUnlocked()&&!this.store.data.killSwitch&&
      !this.interruptedOrderProcessing.has(p.id)&&p.closeRequestedAt===pending.requestedAt&&this.store.data.positions.includes(p)&&
      JSON.stringify([pending.journal.positionId,pending.journal.exchange,pending.journal.request])===pending.signature;
    const task=Promise.resolve().then(async()=>{
      if(!allowed())return;
      const peer=p[pending.journal.makerReduction!.makerLeg==='long'?'short':'long'];
      // Fresh WS/native metadata is sufficient. A missing book requires only this peer's public refresh.
      let book:MarketSnapshot|undefined;try{book=this.freshSnapshot(p,peer);}catch{return;}
      if(!book)try{await this.refreshReduction(p,[peer]);}catch{return;}
      if(!allowed()||!this.canRepairConfirmedMakerCloseTail(p,pending.journal.request.clientOrderId,[],true))return;
      const reason=await this.hedgeMakerExcess(p,pending.journal,peer,allowed,true);
      await this.context.serialize!(async()=>{
        if(!allowed())return;
        if(!reason&&sameQuantity(p.long.quantity,p.short.quantity)){
          this.pendingMakerCloseTails.delete(p.id);
          this.finishBestClose(p,'原 Maker 已确认成交的对侧尾差已补齐；等待最新账户核对',this.closeRefusals(p));
        }else{
          const book=this.freshSnapshot(p,peer),budget=this.makerPeerBudget(p,pending.journal),
            excess=quantitySubtractOnStep(peer.quantity,p[pending.journal.makerReduction!.makerLeg].quantity,book?.quantityStep??NaN);
          if(book&&budget!==undefined&&this.makerTailBudgetMatches(p,excess,budget,book.quantityStep)&&
            isLegalQuantity(excess,book.quantityStep,book.minQuantity)&&
            this.canRepairConfirmedMakerCloseTail(p,pending.journal.request.clientOrderId,[],true)){
            pending.retryAfter=Date.now()+MAKER_CLOSE_RETRY_COOLDOWN_MS;p.status='closing';
            p.riskReasons=['原 Maker 已确认成交的对侧合法余量等待最新盘口；当前批次预算未扩大'];
          }else{this.pendingMakerCloseTails.delete(p.id);p.status='attention';p.riskReasons=[reason??'原 Maker 对侧预算等待账本核对'];}
        }
        refreshPnl(p);this.saveMakerTail(p);
      });
    }).catch(()=>{
      this.interruptedOrderProcessing.add(p.id);this.store.data.killSwitch=true;
      p.status='attention';p.riskReasons=['对侧尾差处理或保存中断；保留原 ID 和真实成交，停止新交易'];
      try{this.context.halt(p.riskReasons[0]);}catch{/* Keep stop in memory on persistence failure. */}
    }).finally(()=>{this.makerTailWorkers.delete(p.id);this.stoppedMakerTailWorkers.delete(p.id);this.context.makerCloseSettled?.(p);});
    this.makerTailWorkers.set(p.id,task);return true;
  }
  hasPendingEntryRollback(p:Position):boolean {
    return this.pendingEntryRollbacks.get(p.id)?.position===p&&!this.blockedEntryRollbacks.has(p.id)&&
      this.context.config().mode==='live'&&p.mode==='live'&&p.status==='attention'&&p.closeRequestedAt===undefined&&!p.manualCloseOnly;
  }
  /** Engine first requires post-order account evidence. Never opens a replacement leg. */
  async continueEntryRollback(p:Position):Promise<void> {
    const journalStart=this.store.data.orders.length;
    try{return await this.executeEntryRollback(p);}
    catch(error){
      if(!(error instanceof UncertainOrderError)&&this.store.data.orders.slice(journalStart).some(order=>order.positionId===p.id)){
        this.interruptedOrderProcessing.add(p.id);this.blockedEntryRollbacks.add(p.id);
        this.pauseInterruptedExecution(p);
      }
      throw error;
    }
  }
  private async executeEntryRollback(p:Position):Promise<void> {
    if(!this.hasPendingEntryRollback(p)||!this.context.liveUnlocked())return;
    const pending=this.pendingEntryRollbacks.get(p.id)!,now=Date.now(),c=this.context.config();
    if(pending.intents.some(intent=>!this.store.data.orders.includes(intent.journal)||
      JSON.stringify([intent.journal.positionId,intent.journal.exchange,intent.journal.request,intent.journal.createdAt])!==intent.signature)){
      this.blockedEntryRollbacks.add(p.id);p.riskReasons=['原入场订单意图已缺失或改变，暂停尾差续处理并等待账本核对'];this.store.save();return;
    }
    if(now-pending.lastAttemptAt<Math.max(1000,c.pollIntervalMs))return;
    if(this.pauseBatchEntry(p,'入场尾差原订单仍待核对，禁止补单或猜测撤回'))return;
    pending.lastAttemptAt=now;
    if(!await this.trimBatchTail(p,pending.previousMatched))return;
    if(p.entryExecution)p.entryExecution.matchedQuantity=Math.min(p.long.quantity,p.short.quantity);
    const comparison=p.executionEvidence?.compensations?.at(-1);
    if(comparison?.outcome==='unresolved'){
      const reductions=this.store.data.orders.filter(order=>order.positionId===p.id&&order.createdAt>=comparison.observedAt&&
        order.executionEvidence?.role==='entry-tail'&&order.request.reduceOnly&&order.result&&order.result.status!=='unknown');
      comparison.reducedLongQuantity=reductions.filter(order=>order.exchange===p.long.exchange).reduce((sum,order)=>sum+order.result!.filledQuantity,0);
      comparison.reducedShortQuantity=reductions.filter(order=>order.exchange===p.short.exchange).reduce((sum,order)=>sum+order.result!.filledQuantity,0);
      comparison.outcome=reductions.some(order=>order.result!.filledQuantity>0)?'rollback':'hedged';
    }
    p.status=p.long.quantity>0?'open':'closed';p.riskReasons=[];
    if(p.status==='closed'){p.closedAt=now;p.closeReason='入场未匹配尾差已按原意图撤回';}
    this.store.save();this.pendingEntryRollbacks.delete(p.id);
    this.store.log('info',`${p.base} 入场尾差续处理完成：双腿各 ${p.long.quantity}，先前对冲保留`,p.id);
  }
  /** Buy only the quantity the short has already filled, rounded down to the long venue's lot. */
  private sizedLongEntry(p:Position,longOrder:PreparedOrder):PreparedOrder{
    const book=this.freshSnapshot(p,p.long),short=this.freshSnapshot(p,p.short);
    if(!book||!short)throw new Error('多腿盘口已失效');
    const quantity=floorQuantity(Math.min(longOrder.request.quantity,p.short.quantity),book.quantityStep);
    if(!(quantity>0)||quantity<book.minQuantity)throw new Error('空腿成交数量低于多腿最小下单量');
    // Rebuild after the short fill. The limit prepared before that fill can already be off the book.
    const sized=this.buildOrder(p,p.long,'buy',quantity,false);
    if(p.entryPolicy==='aligned'){
      if(!(p.short.entryPrice>0)||!alignedEntryPricesFavorable(sized.request.limitPrice,p.short.entryPrice,book,short,this.entryConfig(p)))
        throw new Error('多腿限价相对空腿成交价已没有入场优势');
    }
    return sized;
  }
  /** Price only the hedgeable part; a venue lot can leave a small confirmed short excess to reduce. */
  private validateMissingLegProfit(p:Position,o:Opportunity,request:OrderRequest){
    const long=this.freshSnapshot(p,p.long);
    if(!long)throw new Error('补腿缺少最新多腿盘口');
    const projectedLong=p.long.quantity+request.quantity;
    const legalLong=request.side==='buy'&&request.symbol===p.long.symbol&&!request.reduceOnly&&
      sameQuantity(projectedLong,floorQuantity(p.short.quantity,long.quantityStep));
    const economicPosition=legalLong&&projectedLong<p.short.quantity?
      {...p,short:{...p.short,quantity:projectedLong}}:p;
    this.validateSupplementProfit(economicPosition,o,request);
  }
  private abandonUnopened(p:Position,reason:string){
    p.status='closed';p.closedAt=Date.now();p.closeReason=reason;p.riskReasons=[];
    refreshPnl(p);this.store.save();
  }
  private pauseUnconfirmedEntry(p:Position,reason:string,nativeExit=false):boolean{
    if(!this.store.data.orders.some(order=>order.positionId===p.id&&isCurrentUnconfirmedOrder(order,this.store.data.positions)&&
      (!nativeExit||!this.isNativeExitAuditOrder(p,order))))return false;
    const alreadyPaused=p.status==='attention';
    p.status='attention';p.riskReasons=[reason];
    if(!alreadyPaused)this.context.halt(`${p.base} ${reason}，仅暂停该币种新开仓`,p.base);
    this.store.save();return true;
  }
  private pauseInterruptedExecution(p:Position):boolean {
    if(!this.interruptedOrderProcessing.has(p.id))return false;
    const already=p.status==='attention';p.status='attention';
    p.riskReasons=['订单成交记录处理或保存中断，保留原回执和实际成交；先核对原订单及账户，未提交额外补偿或后续订单'];
    if(!already)this.context.halt(`${p.base} ${p.riskReasons[0]}`,p.base);
    refreshPnl(p);this.store.save();return true;
  }
  async order(p:Position,leg:PositionLeg,side:Side,quantity:number,reduceOnly:boolean,validateAdditionalEntry?:(request?:OrderRequest)=>Promise<void>):Promise<OrderResult>{
    if(this.pauseInterruptedExecution(p))throw new Error('原订单处理已中断，请先核对账本及账户');
    if(this.blockedEntryRollbacks.has(p.id))throw new Error('本次入场尾差执行已暂停，请先核对原订单及账户');
    if(this.store.data.orders.some(order=>order.positionId===p.id&&isCurrentUnconfirmedOrder(order,this.store.data.positions)))
      throw new UncertainOrderError('存在未确认订单，请先核对原订单，禁止创建补单或减仓订单');
    const prepared=this.buildOrder(p,leg,side,quantity,reduceOnly);
    await this.validateOrders([prepared]);
    if(validateAdditionalEntry){
      await validateAdditionalEntry(prepared.request);
    }
    this.checkPreparedOrder(p,prepared);
    return this.submitOrder(p,prepared);
  }
  /** A separately verified external exposure budget may only reduce this independent
   * risk record. Native reads and the POST stay outside the shared cash queue. */
  async reduceExternalRisk(p:Position,leg:PositionLeg,quantity:number,guard:(journal?:JournalOrder)=>boolean):Promise<OrderResult>{
    const serial=this.context.serialize;
    if(!serial||!p.manualCloseOnly||!p.manualCloseAccountRecord||!p.manualCloseSourcePositionId||
      p.externalExposureReduction?.sourcePositionId!==p.manualCloseSourcePositionId||
      !this.store.data.positions.includes(p)||!isPositionActive(p)||leg!==p.long&&leg!==p.short||
      this.context.config().mode!=='live'||!this.context.liveUnlocked()||this.store.data.killSwitch||
      this.store.data.orders.some(order=>order.positionId===p.id&&isUnconfirmedJournalOrder(order))||
      this.interruptedOrderProcessing.has(p.id)||!guard())throw new Error('外部单腿风险减仓缺少有效限定证明');
    const config=this.context.config(),prepared=this.bestCloseOrder(p,leg,quantity),request=prepared.request,
      requestProof=JSON.stringify(request),quantityStep=prepared.snapshot.quantityStep;
    if(!request.reduceOnly||request.postOnly||!sameQuantity(request.quantity,quantity)||quantity>leg.quantity)
      throw new Error('外部风险减仓数量超出已确认预算');
    await this.validateOrders([prepared]);
    this.checkPreparedOrder(p,prepared);
    let journal:JournalOrder|undefined,localVeto=false;
    const permitted=()=>{
      try{
        const allowed=this.context.config()===config&&this.context.liveUnlocked()&&!this.store.data.killSwitch&&
          this.context.makerActionsAllowed?.()!==false&&!this.interruptedOrderProcessing.has(p.id)&&
          this.store.data.positions.includes(p)&&isPositionActive(p)&&!p.accountClosure&&
          (leg===p.long||leg===p.short)&&leg.quantity>=quantity&&JSON.stringify(request)===requestProof&&
          (!journal||this.store.data.orders.includes(journal)&&journal.result===undefined)&&
          !this.store.data.orders.some(order=>order!==journal&&order.positionId===p.id&&isUnconfirmedJournalOrder(order))&&guard(journal);
        if(!allowed){localVeto=true;return false;}
        this.checkPreparedOrder(p,prepared);return true;
      }catch{localVeto=true;return false;}
    };
    await serial(async()=>{
      if(!permitted())throw new Error('外部风险减仓提交前账户、盘口或限定权限已变化');
      const now=Date.now(),bookObservedAt=prepared.snapshot.observedAt??prepared.snapshot.timestamp;
      journal={positionId:p.id,exchange:leg.exchange,request,createdAt:now,
        execution:{bookObservedAt,quoteAgeMs:Math.max(0,now-bookObservedAt),bookTransport:prepared.snapshot.bookTransport??'rest'},
        executionEvidence:{version:1,method:'ioc',role:'exit-tail',batchId:`${p.id}:external-risk:${randomUUID()}`,
          referencePrice:request.limitPrice,referenceObservedAt:bookObservedAt,closeFeeRebatePct:feeRebatePct(leg.exchange,config)}};
      this.store.data.orders.push(journal);
      try{this.store.save();this.context.makerFinancialActivity?.(journal);}
      catch(error){this.interruptedOrderProcessing.add(p.id);this.store.data.killSwitch=true;throw error;}
    });
    const own=journal!,originalRequest=structuredClone(request),originalLeg=structuredClone(leg),
      positionId=p.id,exchange=leg.exchange,originalQuantity=leg.quantity,
      adapter=this.context.adapter(exchange);let result:OrderResult;
    // The original durable ID is inspected after a failed request; no POST is retried.
    try{result=await adapter.placeOrder(request,permitted);}
    catch{try{result=await adapter.reconcileOrder(originalRequest);}catch{result=this.unknown(originalRequest);}}
    if(localVeto&&result.id===''&&result.clientOrderId===request.clientOrderId&&result.status==='cancelled'&&
      result.filledQuantity===0&&result.averagePrice===0&&result.feeUsd===0&&result.rejectionCode==='ORDER_SUBMISSION_PERMISSION_CHANGED')
      result={...result,rejectionCode:'IOC_REDUCTION_PERMISSION_CHANGED',rejectionReason:'外部单腿风险减仓最终核验变化，本次未发送创建请求'};
    if(!localVeto&&result.rejectionCode==='IOC_REDUCTION_PERMISSION_CHANGED'&&result.id===''&&result.status==='cancelled'&&
      result.filledQuantity===0&&result.averagePrice===0&&result.feeUsd===0)result=this.unknown(request);
    result=this.receipt({...p,id:positionId},originalLeg,originalRequest,result);
    return serial(async()=>{
      try{
        if(!this.store.data.orders.includes(own)||own.positionId!==positionId||own.exchange!==exchange||
          JSON.stringify(own.request)!==requestProof||!this.store.data.positions.includes(p)||p.id!==positionId||
          leg!==p.long&&leg!==p.short||leg.exchange!==exchange||leg.symbol!==originalLeg.symbol||
          leg.side!==originalLeg.side||!sameQuantity(leg.quantity,originalQuantity)){
          // Preserve the real receipt even if an in-flight edit removed its intent or owner.
          // Applying it to a changed record could double-book or lose the only trade evidence.
          (this.store.data.unappliedRiskReceipts??=[]).push({positionId,exchange,request:originalRequest,
            result:structuredClone(result),observedAt:Date.now(),reason:'financial-owner-changed'});
          this.store.data.killSwitch=true;p.status='attention';
          p.riskReasons=['风险减仓原生回执已隔离保存，原订单或持仓身份发生变化，需核对后入账'];
          this.store.save();throw new Error('风险减仓原订单或持仓身份已改变，已保存未入账回执并停止交易');
        }
        this.assertUncommittedReceipt(p,own);
        this.retainOriginalConfirmation(own,result);own.result=result;
        own.execution!.confirmedAt=Date.now();own.execution!.confirmationMs=own.execution!.confirmedAt-own.createdAt;
        if(!this.store.data.positions.includes(p)||leg!==p.long&&leg!==p.short){
          own.executionEvidence!.bookedFeeUsd=0;own.error='风险减仓原生回执已保留，持仓身份已变化，待核对真实现金';
          this.store.data.killSwitch=true;this.store.save();throw new Error('风险减仓原持仓身份已改变');
        }
        if(result.filledQuantity>0||Number.isFinite(result.feeUsd)&&result.feeUsd!==0)
          this.applyFill(p,leg,request.side,result,true,quantityStep);
        own.executionEvidence!.bookedFeeUsd=Number.isFinite(result.feeUsd)?result.feeUsd:0;
        if(result.status==='unknown'){
          p.status='attention';own.error='风险减仓原订单未知，保留原 ID，禁止重发';p.riskReasons=[own.error];
        }else if(p.long.quantity===0&&p.short.quantity===0){p.status='closed';p.closedAt=Date.now();p.closeReason='外部单腿风险已按限定数量减仓';p.riskReasons=[];}
        else {p.status='attention';p.riskReasons=['外部单腿风险仍有确认余量，等待新鲜双账户与原单核验'];}
        refreshPnl(p);this.store.save();this.context.makerFinancialActivity?.(own);
        this.store.log(result.status==='unknown'?'error':result.filledQuantity>0?'info':'warn',
          `${p.base} 外部单腿风险处理：${iocReductionReceiptLog(own,localVeto)}`,p.id);
        return result;
      }catch(error){this.interruptedOrderProcessing.add(p.id);this.store.data.killSwitch=true;throw error;}
    });
  }
  private async submitOrder(p:Position,prepared:PreparedOrder,additionalReductionGuard?:(journal?:JournalOrder)=>boolean):Promise<OrderResult>{
    let journalCreated=false;
    try{
    if(this.interruptedOrderProcessing.has(p.id))throw new Error('原订单处理已中断，禁止继续本次下单');
    if(this.blockedEntryRollbacks.has(p.id))throw new Error('本次入场尾差执行已暂停，禁止继续本次下单');
    if(additionalReductionGuard?.()===false)throw new Error('限定确认尾差预算已变化，未创建减仓意图');
    const {leg,request:req}=prepared,c=this.context.config(),{side,quantity,reduceOnly}=req;
    // Only the first leg creates new directional risk. A confirmed counterpart and
    // reductions retain their existing hedge/rollback guards when forecasts change.
    const automaticExpansion=p.automaticEntry===true&&!reduceOnly&&leg===p.short&&
      prepared.role!=='hedge'&&prepared.role!=='entry-tail';
    const assertFundingStability=()=>{
      if(!automaticExpansion)return;
      if(!this.context.assertAutomaticEntryStability)throw new Error('自动开仓缺少资金费持续优势确认守卫');
      return this.context.assertAutomaticEntryStability(p);
    };
    const fundingEntryStability=assertFundingStability() as FundingEntryConfirmationEvidence|undefined;
    // Both requests are constructed and validated before either order is journalled/submitted.
    if(!reduceOnly&&this.context.allowEntry?.(p)===false)throw new Error('该币种开仓已被冻结');
    this.checkPreparedOrder(p,prepared);
    const s=prepared.snapshot,submittedQuantityStep=s.quantityStep;
    if(c.mode==='live'&&!this.context.liveUnlocked())throw new Error('实盘执行开关未解锁');
    if(!reduceOnly)this.trace(p,leg===p.short?'first-submit':'hedge-submit',prepared.entryBatch);
    const journal={positionId:p.id,exchange:leg.exchange,request:req,createdAt:Date.now()} as JournalOrder;
    const bookObservedAt=s.observedAt??s.timestamp;
    if(Number.isFinite(bookObservedAt))journal.execution={bookObservedAt,quoteAgeMs:Math.max(0,journal.createdAt-bookObservedAt),bookTransport:s.bookTransport??'rest'};
    const reference=bestOppositeLevel(s,side),fee=takerFeeRate(s,c),makerFee=nativeMakerFeeRate(s);
    journal.executionEvidence={version:1,method:req.postOnly?'maker':'ioc',role:prepared.role??(reduceOnly?(p.status==='opening'?'entry-tail':'exit'):(leg===p.short?'entry':'hedge')),
      ...(fundingEntryStability?{fundingEntryStability:structuredClone(fundingEntryStability)}:{}),
      batchId:`${p.id}:${prepared.entryBatch??'standalone'}`,
      ...(prepared.makerCloseParentClientId?{makerCloseParentClientId:prepared.makerCloseParentClientId}:{}),
      ...(prepared.makerCloseLotTailOriginalParentClientId?{makerCloseLotTailOriginalParentClientId:prepared.makerCloseLotTailOriginalParentClientId,
        makerCloseLotTailParentClientIds:[...(prepared.makerCloseLotTailParentClientIds??[])]}:{}),
      ...(reference?{referencePrice:reference.price,referenceObservedAt:bookObservedAt}:{}),
      ...(fee!==undefined?{nativeTakerFeeRate:fee,feeObservedAt:s.takerFeeAt??journal.createdAt}:{}),
      ...(makerFee!==undefined?{nativeMakerFeeRate:makerFee}:{})};
    this.store.data.orders.push(journal);journalCreated=true;this.store.save(); // durable intent before any external side effect
    let result:OrderResult,knownFeeUsd:number|undefined;
    // The intent is already durable. This is the local adapter-call start, not an exchange receive/fill clock.
    journal.executionEvidence.submittedAt=Date.now();
    if(c.mode==='paper'){
      this.operationSubmitted(p,journal);
      const levels=this.observedLevels(s,side).filter(x=>side==='buy'?x.price<=req.limitPrice:x.price>=req.limitPrice);
      const fill=sweep(levels,quantity),filled=floorQuantity(fill.filled,s.quantityStep),actual=sweep(levels,filled);
      result={id:req.clientOrderId,clientOrderId:req.clientOrderId,status:filled>=quantity*(1-1e-9)?'filled':filled>0?'partial':'cancelled',filledQuantity:filled,averagePrice:actual.average,feeUsd:actual.value*c.takerFees[leg.exchange],timestamp:Date.now()};
    }else{
      const adapter=this.context.adapter(leg.exchange);
      let automaticEntryVeto=false;
      const finalFundingPermission=automaticExpansion||additionalReductionGuard?()=>{
        try{const submissionEvidence=assertFundingStability() as FundingEntryConfirmationEvidence|undefined;this.checkPreparedOrder(p,prepared);
          const allowed=this.context.config()===c&&this.context.liveUnlocked()&&(!automaticExpansion||this.context.allowEntry?.(p)!==false)&&
            additionalReductionGuard?.(journal)!==false;
          if(allowed&&submissionEvidence){
            if(!journal.executionEvidence||!this.store.data.orders.includes(journal))throw new Error('自动开仓原提交意图已变化');
            journal.executionEvidence.submissionFundingEntryStability=structuredClone(submissionEvidence);
            try{this.store.save();}catch(error){this.store.data.killSwitch=true;this.interruptedOrderProcessing.add(p.id);throw error;}
          }
          automaticEntryVeto=!allowed;return allowed;
        }catch{automaticEntryVeto=true;return false;}
      }:undefined;
      this.operationSubmitted(p,journal);
      try{result=await adapter.placeOrder(req,finalFundingPermission);}catch{
        try{result=await adapter.reconcileOrder(req);}catch{result=this.unknown(req);}
      }
      this.assertUncommittedReceipt(p,journal);
      // Only this operation's own native no-send witness can prove the explicit
      // entry or confirmed-budget guard veto; a diagnostic code alone is insufficient.
      if(automaticEntryVeto&&result.id===''&&result.clientOrderId===req.clientOrderId&&result.status==='cancelled'&&
        result.filledQuantity===0&&result.averagePrice===0&&result.feeUsd===0&&result.rejectionCode==='ORDER_SUBMISSION_PERMISSION_CHANGED')
        result={...result,rejectionCode:automaticExpansion?'AUTOMATIC_ENTRY_PERMISSION_CHANGED':'MAKER_REDUCTION_PERMISSION_CHANGED'};
      result=this.receipt(p,leg,req,result);
      if(this.retainOriginalConfirmation(journal,result))this.store.save();
      if(Number.isFinite(result.feeUsd))knownFeeUsd=result.feeUsd;
      if(result.status==='unknown'){
        try{result=this.receipt(p,leg,req,await adapter.reconcileOrder(req,result.id||undefined),result);}catch{ /* retain trusted unknown lower bound; never resubmit */ }
      }
    }
    this.assertUncommittedReceipt(p,journal);
    result=this.receipt(p,leg,req,result);
    if(Number.isFinite(result.feeUsd))knownFeeUsd=result.feeUsd;
    this.retainOriginalConfirmation(journal,result);
    journal.result=result;
    if(journal.execution){journal.execution.confirmedAt=Date.now();journal.execution.confirmationMs=journal.execution.confirmedAt-journal.createdAt;}
    if(result.filledQuantity>0||knownFeeUsd!==undefined&&knownFeeUsd!==0)
      this.applyFill(p,leg,side,{...result,feeUsd:knownFeeUsd??NaN},reduceOnly,submittedQuantityStep);
    journal.executionEvidence.bookedFeeUsd=knownFeeUsd??0;
    this.updateMakerComparisons(journal);
    if(!reduceOnly&&result.status!=='unknown'&&result.filledQuantity>0)this.trace(p,leg===p.short?'first-confirmed':'hedge-confirmed',prepared.entryBatch);
    this.store.save();
    if(result.status==='unknown'){
      this.operationObserved(p);
      const detail=orderConfirmationText(result.confirmation);
      journal.error=`订单状态未知；${detail?`${detail}；`:''}禁止重发`;p.status='attention';p.riskReasons.push(`${leg.exchange} 订单状态未知${detail?`：${detail}`:''}`);
      this.store.save();
      if(detail){this.store.log('warn',`${p.base} ${leg.exchange} 订单未确认：${detail}；保留原操作等待查单，禁止重发`,p.id);
        this.unknownDiagnosticLoggedAt.set(req.clientOrderId,Date.now());}
      this.context.halt(`${p.base} 订单状态未知：仅冻结该币种新开仓，需要交易所对账`,p.base);
      throw new UncertainOrderError('订单状态未知，未重发订单');
    }
    this.operationObserved(p);
    const rejected=result.rejectionReason?`；${result.rejectionReason}${result.rejectionCode?` (${result.rejectionCode})`:''}`:'';
    this.store.log(result.status==='filled'?'info':'warn',`${p.base} ${leg.exchange} ${reduceOnly?'减仓':'开仓'} ${side==='buy'?'买入':'卖出'} ${result.filledQuantity} / ${quantity}${rejected}`,p.id);
    return result;
    }catch(error){
      if(journalCreated&&!(error instanceof UncertainOrderError)){
        this.blockedEntryRollbacks.add(p.id);this.interruptedOrderProcessing.add(p.id);
      }
      throw error;
    }
  }
  /** A competing observation must never be replaced or booked twice by a late submit response. */
  private assertUncommittedReceipt(p:Position,journal:JournalOrder,expected?:OrderResult):void {
    if(journal.result===expected)return;
    this.retainOriginalConfirmation(journal);p.status='attention';
    p.riskReasons.push('提交等待期间原订单记录已变化，保留已有回执及现金，等待原单核对');
    this.store.save();
    this.context.halt(`${p.base} 提交等待期间原订单记录已变化，禁止覆盖或重发`,p.base);
    throw new UncertainOrderError('原订单已有观察记录，未覆盖回执或重复入账');
  }
  private unknown(r:OrderRequest):OrderResult{return {id:'',clientOrderId:r.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()};}
  /** Only the confirmed Maker peer uses split intent/network/cash commits. Unknown original IDs are never replayed. */
  private async submitMakerPeer(p:Position,prepared:PreparedOrder,parent:JournalOrder,canSubmit:(pending?:JournalOrder)=>boolean):Promise<OrderResult>{
    const serial=this.context.serialize!,{leg,request:req}=prepared,config=this.context.config();
    let journal:JournalOrder|undefined,journalCreated=false;
    try{
      await serial(async()=>{
        if(!canSubmit()||this.interruptedOrderProcessing.has(p.id)||this.store.data.killSwitch||
          this.context.config()!==config||this.context.makerActionsAllowed?.()===false||!this.context.liveUnlocked())
          throw new Error('提交前已确认 Maker 对侧减仓许可已变化');
        this.checkPreparedOrder(p,prepared);
        const s=prepared.snapshot,at=Date.now(),bookObservedAt=s.observedAt??s.timestamp,
          reference=bestOppositeLevel(s,req.side),fee=takerFeeRate(s,config),makerFee=nativeMakerFeeRate(s);
        journal={positionId:p.id,exchange:leg.exchange,request:req,createdAt:at,
          execution:{bookObservedAt,quoteAgeMs:Math.max(0,at-bookObservedAt),bookTransport:s.bookTransport??'rest'},
          executionEvidence:{version:1,method:'ioc',role:'exit-tail',batchId:`${p.id}:standalone`,
            makerCloseParentClientId:parent.request.clientOrderId,
            ...(reference?{referencePrice:reference.price,referenceObservedAt:bookObservedAt}:{}),
            ...(fee!==undefined?{nativeTakerFeeRate:fee,feeObservedAt:s.takerFeeAt??at}:{}),
            ...(makerFee!==undefined?{nativeMakerFeeRate:makerFee}:{})}};
        this.store.data.orders.push(journal);journalCreated=true;this.store.save();
        parent.makerReduction!.peerAdapterStartedAt=Date.now();journal.executionEvidence!.submittedAt=Date.now();
        this.context.makerFinancialActivity?.();
      });
      const intent=journal!,nativeProofStartedAt=Date.now();
      parent.makerReduction!.peerNativeCheckStartedAt=nativeProofStartedAt;
      const nativeReady=this.nativeExitAuthorities.has(p.id)?await this.verifyNativeExitBeforeSubmit(p,journal):!this.historicalNativeExitAudit(p);
      parent.makerReduction!.peerNativeCheckCompletedAt=Date.now();
      parent.makerReduction!.peerPermissionVetoReason=undefined;
      const scope=()=>JSON.stringify([p.closeRequestedAt,p.closeProfitRequired,p.manualCloseOnly,p.status,
        [p.long,p.short].map(value=>[value.exchange,value.symbol,value.side,value.quantity]),parent.positionId,parent.exchange,parent.createdAt,parent.request,
        parent.makerReduction?.makerLeg,parent.makerReduction?.quantityStep,parent.makerReduction?.peerQuantityStep,
        parent.result,parent.makerReduction?.bookedExecution,parent.executionEvidence?.bookedFeeUsd]),scopeProof=scope(),
        priorPeers=()=>this.exitJournalProof(p,this.store.data.orders.filter(order=>order!==intent&&order!==parent&&order.positionId===p.id)),
        priorPeerProof=priorPeers(),
        requestProof=JSON.stringify(req),adapter=this.context.adapter(leg.exchange);
      const finalPermission=()=>{
        const veto=(reason:NonNullable<JournalOrder['makerReduction']>['peerPermissionVetoReason'])=>{parent.makerReduction!.peerPermissionVetoReason=reason;return false;};
        if(!nativeReady)return veto('native-proof');
        if(this.nativeExitAuthorities.has(p.id)&&(Date.now()<nativeProofStartedAt||Date.now()-nativeProofStartedAt>8000))return veto('proof-age');
        if(this.context.config()!==config||this.context.makerActionsAllowed?.()===false||!this.context.liveUnlocked()||this.store.data.killSwitch||
          this.interruptedOrderProcessing.has(p.id)||this.stoppedMakerTailWorkers.has(p.id)||p.manualCloseOnly||p.status!=='closing')return veto('authorization');
        if(!this.store.data.positions.includes(p)||!this.store.data.orders.includes(intent)||!this.store.data.orders.includes(parent)||
          this.store.data.orders.filter(order=>order.request.clientOrderId===parent.request.clientOrderId).length!==1||
          intent.result!==undefined||JSON.stringify(req)!==requestProof||scope()!==scopeProof||priorPeers()!==priorPeerProof||
          this.store.data.orders.some(order=>order!==parent&&order!==intent&&(order.positionId===p.id||
            order.exchange===leg.exchange&&order.request.symbol===leg.symbol)&&
            this.blockingExitOrder(p,order)))return veto('scope');
        if(!canSubmit(intent))return veto('budget');
        if(!this.nativeExitSubmissionAllowed(p,intent))return veto('authorization');
        // Native mode/position GETs may take time. This final synchronous guard uses the newest book.
        try{this.checkPreparedOrder(p,prepared);return true;}catch{return veto('book');}
      };
      let nativePermissionVeto=false;
      const guardedPermission=()=>{
        let allowed=false;try{allowed=finalPermission();}catch{/* The current native check may only veto its own unsent intent. */}
        if(!allowed)nativePermissionVeto=true;return allowed;
      };
      let result:OrderResult;
      this.operationSubmitted(p,intent);
      try{result=await adapter.placeOrder(req,guardedPermission);}catch{
        try{result=await adapter.reconcileOrder(req);}catch{result=this.unknown(req);}
      }
      // Match submitOrder's operation-local witness; the generic code alone cannot resolve old unknowns.
      if(nativePermissionVeto&&result.id===''&&result.clientOrderId===req.clientOrderId&&result.status==='cancelled'&&
        result.filledQuantity===0&&result.averagePrice===0&&result.feeUsd===0&&result.rejectionCode==='ORDER_SUBMISSION_PERMISSION_CHANGED')
        result={...result,rejectionCode:'MAKER_REDUCTION_PERMISSION_CHANGED',rejectionReason:
          `对侧提交前${({ 'native-proof':'真实持仓或挂单核验未通过','proof-age':'原生证明已过期',scope:'原订单范围已变化',
            budget:'确认预算或限定许可已变化',book:'盘口已变化',authorization:'交易许可已变化'} as const)[parent.makerReduction!.peerPermissionVetoReason??'authorization']}；本次未发送创建请求`};
      result=this.receipt(p,leg,req,result);
      let knownFeeUsd=Number.isFinite(result.feeUsd)?result.feeUsd:undefined;
      // The adapter has already queried its original order. Commit any trusted
      // unknown lower bound together with its cash before background GET-only
      // observations can use it as the booked baseline; never stage unbooked fills.
      return await serial(async()=>{
        this.assertUncommittedReceipt(p,intent);
        result=this.receipt(p,leg,req,result);if(Number.isFinite(result.feeUsd))knownFeeUsd=result.feeUsd;
        this.retainOriginalConfirmation(intent,result);intent.result=result;
        intent.execution!.confirmedAt=Date.now();intent.execution!.confirmationMs=intent.execution!.confirmedAt-intent.createdAt;
        if(result.filledQuantity>0||knownFeeUsd!==undefined&&knownFeeUsd!==0)
          this.applyFill(p,leg,req.side,{...result,feeUsd:knownFeeUsd??NaN},true,prepared.snapshot.quantityStep);
        intent.executionEvidence!.bookedFeeUsd=knownFeeUsd??0;
        this.updateMakerComparisons(intent);this.store.save();this.operationObserved(p);
        if(result.status==='unknown'){
          const detail=orderConfirmationText(result.confirmation);
          intent.error=`订单状态未知；${detail?`${detail}；`:''}禁止重发`;p.status='attention';
          p.riskReasons.push(`${leg.exchange} 订单状态未知${detail?`：${detail}`:''}`);this.store.save();
          this.context.halt(`${p.base} 对侧原订单未知：仅冻结该币种，保留原 ID 查单，禁止重发`,p.base);
          throw new UncertainOrderError('订单状态未知，未重发订单');
        }
        const rejected=result.rejectionReason?`；${result.rejectionReason}${result.rejectionCode?` (${result.rejectionCode})`:''}`:'';
        this.store.log(result.status==='filled'?'info':'warn',`${p.base} ${leg.exchange} 减仓 ${req.side==='buy'?'买入':'卖出'} ${result.filledQuantity} / ${req.quantity}${rejected}`,p.id);
        return result;
      });
    }catch(error){
      if(journalCreated&&!(error instanceof UncertainOrderError)){
        this.interruptedOrderProcessing.add(p.id);this.store.data.killSwitch=true;
      }
      throw error;
    }
  }
  /** Audit evidence stays separate from the latest query diagnostic and confirmed financial receipt. */
  private retainOriginalConfirmation(journal:JournalOrder,current=journal.result):boolean {
    if(journal.originalConfirmation!==undefined||!current||current.clientOrderId!==journal.request.clientOrderId)return false;
    const prior=journal.result?.status==='unknown'&&journal.result.clientOrderId===journal.request.clientOrderId?journal.result:undefined;
    const diagnostic=safeOrderConfirmation(current.originalConfirmation)??safeOrderConfirmation(prior?.originalConfirmation)??
      safeOrderConfirmation(prior?.confirmation)??
      (current.status==='unknown'?safeOrderConfirmation(current.confirmation):undefined);if(!diagnostic)return false;
    journal.originalConfirmation=diagnostic;return true;
  }
  private receipt(p:Position,leg:PositionLeg,request:OrderRequest,result:OrderResult|undefined,prior?:OrderResult):OrderResult {
    const normalized=normalizeOrderReceipt(request,result,Date.now(),prior);
    const conflict=normalized.id&&this.store.data.orders.some(order=>order.exchange===leg.exchange&&order.request?.symbol===leg.symbol&&
      order.result?.id===normalized.id&&(order.positionId!==p.id||order.request.clientOrderId!==request.clientOrderId));
    if(conflict)return normalizeOrderReceipt(request,undefined,Date.now(),prior);
    return isUnconfirmedJournalOrder({positionId:p.id,exchange:leg.exchange,request,result:normalized,createdAt:Date.now()})?
      {...normalized,status:'unknown'}:normalized;
  }
  /** Record a GET-only observation. Unknown reads may retain native identity and diagnostics, never financial facts. */
  private readonly observationPersistenceFailures=new Set<unknown>();
  isObservationPersistenceFailure(error:unknown):boolean {return this.observationPersistenceFailures.has(error);}
  private persistReconciliationObservation<T>(journal:JournalOrder,write:()=>T,_concurrent=false):T {
    try{return write();}
    catch(error){
      if(this.observationPersistenceFailures.size>=32)this.observationPersistenceFailures.delete(this.observationPersistenceFailures.values().next().value);
      this.observationPersistenceFailures.add(error);
      this.interruptedOrderProcessing.add(journal.positionId);this.store.data.killSwitch=true;
      try{this.context.halt('原订单真实回执或核验观察无法保存，已停止交易并保留原账本');}catch{/* The in-memory stop survives a permanent disk failure. */}
      throw error;
    }
  }
  applyObservedOrder(journal:JournalOrder,current:OrderResult):boolean {
    if(!this.store.data.orders.includes(journal)||!isCurrentUnconfirmedOrder(journal,this.store.data.positions))return false;
    if(journal.makerReduction)return false;
    const p=this.store.data.positions.find(position=>position.id===journal.positionId);
    if(p&&this.historicalNativeExitAudit(p,journal)&&this.quarantineNativeExitReceipt(p,journal,current))return false;
    if(current.status==='unknown'){
      const diagnostic=current.clientOrderId===journal.request.clientOrderId?safeOrderConfirmation(current.confirmation):undefined;
      if(!diagnostic)return false;
      const retained=this.retainOriginalConfirmation(journal);
      const readAt=current.orderReadAt,priorReadAt=journal.result?.orderReadAt;
      const newRead=typeof readAt==='number'&&Number.isFinite(readAt)&&readAt>0&&readAt<=Date.now()+5000&&readAt>=(priorReadAt??0)&&readAt!==priorReadAt;
      const original=journal.result;
      if(original?.id===''&&original.status==='unknown'&&original.filledQuantity===0&&newRead&&
        diagnostic.stage==='receipt'&&diagnostic.reason==='nonterminal'&&hasOrderReceiptIdentity(journal.request,current)&&
        hasBoundedOrderQuantity(journal.request,current)&&current.id&&current.id!==journal.request.clientOrderId&&
        Number.isFinite(current.timestamp)&&current.timestamp>0&&current.timestamp<=Date.now()+5000&&
        !p?.nativeExitRecoveryAudit?.some(audit=>audit.unknownClientOrderIds.includes(journal.request.clientOrderId))&&
        !this.store.data.orders.some(order=>order!==journal&&order.exchange===journal.exchange&&
          order.request.symbol===journal.request.symbol&&order.result?.id===current.id))
        original.id=current.id;
      // Advancing an observation timestamp is not a new business failure or a reason to repeat the warning.
      if(JSON.stringify({...diagnostic,observedAt:undefined})===
        JSON.stringify({...safeOrderConfirmation(journal.result?.confirmation),observedAt:undefined})){
        if(journal.result&&newRead){journal.result.confirmation=diagnostic;journal.result.orderReadAt=readAt;}
        if(retained||newRead)this.persistReconciliationObservation(journal,()=>this.store.save());return false;
      }
      if(journal.result){journal.result.confirmation=diagnostic;if(newRead)journal.result.orderReadAt=readAt;}
      const detail=orderConfirmationText(diagnostic)!;
      journal.error=`订单状态未知；${detail}；禁止重发`;this.persistReconciliationObservation(journal,()=>this.store.save());
      this.persistReconciliationObservation(journal,()=>this.store.log('warn',`${journal.request.base} ${journal.exchange} 原订单仍未确认：${detail}；未重发、未改成交及现金`,journal.positionId));
      this.unknownDiagnosticLoggedAt.set(journal.request.clientOrderId,Date.now());
      return false;
    }
    return this.applyConfirmedOrder(journal,current);
  }
  /** Native continuation already uses the current exposure; old cash is never applied a second time. */
  private quarantineNativeExitReceipt(p:Position,journal:JournalOrder,current:OrderResult):boolean {
    const audit=this.historicalNativeExitAudit(p,journal);if(!audit)return false;
    const old=audit.originalUnknowns.find(value=>value.clientOrderId===journal.request.clientOrderId)?.originalResult;
    if(!old)return true;
    const changed=current.clientOrderId===journal.request.clientOrderId&&(current.status!=='unknown'||
      current.id!==old.id&&!!current.id||current.filledQuantity!==old.filledQuantity||
      current.averagePrice!==old.averagePrice||current.feeUsd!==old.feeUsd);
    if(!changed)return false;
    const proof=this.nativeExitOrderProof({...journal,result:current});
    if(!audit.lateEvidence?.some(value=>this.nativeExitOrderProof({...journal,result:value.result})===proof)){
      audit.lateEvidence??=[];audit.lateEvidence.push({clientOrderId:journal.request.clientOrderId,observedAt:Date.now(),result:structuredClone(current)});
      this.revokeNativeExitAuthority(p,'历史未知原单出现新成交或身份回执；保留当前真实现金，暂停退出并核对历史差额');
    }
    return true;
  }
  /** Restart/observation is GET-only: terminal cash is reconciled without adopting a trading session. */
  applyObservedMakerTerminal(journal:JournalOrder,observation:MakerReductionObservation):boolean {
    if(!journal.makerReduction||!this.store.data.orders.includes(journal)||
      !isCurrentUnconfirmedOrder(journal,this.store.data.positions)||observation.activity!=='terminal'||!observation.executionVerified)return false;
    if(!isTerminalOrderReceipt(journal.request,observation.result)||observation.result.averagePriceVerified===false)return false;
    const lower=journal.makerReduction.lotTailObservedExecution;
    if(lower){
      const validation={...lower,status:lower.filledQuantity>=journal.request.quantity?'filled' as const:lower.filledQuantity>0?'partial' as const:'cancelled' as const};
      if(!isTerminalOrderReceipt(journal.request,validation)||observation.result.id!==lower.id||
        observation.result.filledQuantity<lower.filledQuantity-orderQuantityTolerance(lower.filledQuantity))return false;
    }
    this.applyConfirmedOrder(journal,observation.result);
    journal.makerReduction.activity='terminal';journal.makerReduction.bookedExecution=true;
    journal.makerReduction.lastObservedAt=observation.observedAt;this.updateMakerComparisons(journal);
    this.persistReconciliationObservation(journal,()=>this.store.save());return true;
  }
  private updateMakerComparisons(journal:JournalOrder):void{
    if(journal.makerCloseComparison)updateMakerCloseComparison(journal,this.store.data.orders);
    const parent=journal.executionEvidence?.makerCloseParentClientId;
    if(parent){const maker=this.store.data.orders.find(order=>order.positionId===journal.positionId&&order.request.clientOrderId===parent&&order.makerCloseComparison);
      if(maker)updateMakerCloseComparison(maker,this.store.data.orders);}
  }
  /** The scoped recovery owner has already verified fresh native accounts and the entire original peer budget. */
  reconcileConfirmedMakerPeerFee(journal:JournalOrder,current:OrderResult,expectedBookedFeeUsd:number):boolean {
    const p=this.store.data.positions.find(position=>position.id===journal.positionId),old=journal.result,now=Date.now();
    if(this.context.config().mode!=='live'||!this.context.liveUnlocked()||!this.store.data.orders.includes(journal)||
      !p||p.mode!=='live'||!['attention','closing'].includes(p.status)||p.closeRequestedAt===undefined||
      p.closeProfitRequired!==true||p.closePricing!=='best-opposite'||p.manualCloseOnly||p.accountClosure||
      !sameQuantity(p.long.quantity,p.short.quantity)||!Number.isFinite(p.long.quantity)||p.long.quantity<=0||
      journal.exchange!=='bitget'||journal.makerReduction||!journal.request.reduceOnly||journal.request.postOnly===true||
      !journal.executionEvidence?.makerCloseParentClientId||!old?.id||!isTerminalOrderReceipt(journal.request,old)||
      !isTerminalOrderReceipt(journal.request,current)||current.averagePriceVerified!==true||old.averagePriceVerified===false||
      current.id!==old.id||current.clientOrderId!==old.clientOrderId||current.status!==old.status||
      current.filledQuantity!==old.filledQuantity||current.filledQuantity<=0||current.averagePrice!==old.averagePrice||
      !Number.isFinite(current.averagePrice)||current.averagePrice<=0||
      !Number.isFinite(current.timestamp)||current.timestamp<=0||current.timestamp>now+5000||
      !Number.isFinite(current.orderReadAt)||current.orderReadAt!<=0||current.orderReadAt!>now||
      now-current.orderReadAt!>this.context.config().maxSnapshotAgeMs||
      ![expectedBookedFeeUsd,old.feeUsd,current.feeUsd].every(Number.isFinite)||old.feeUsd!==expectedBookedFeeUsd||
      journal.executionEvidence.bookedFeeUsd!==expectedBookedFeeUsd||
      conflictingNativeOrderReceipts(this.store.data.orders).has(journal))
      throw new Error('已确认对侧费用更正缺少原身份、完整新鲜现金或精确原入账金额');
    const parent=this.store.data.orders.find(order=>order.positionId===p.id&&
      order.request.clientOrderId===journal.executionEvidence!.makerCloseParentClientId);
    const legs=[p.long,p.short].filter(leg=>leg.exchange===journal.exchange&&leg.symbol===journal.request.symbol&&
      journal.request.side===(leg.side==='long'?'sell':'buy'));
    if(!parent?.makerReduction||parent.makerReduction.activity!=='terminal'||parent.makerReduction.bookedExecution!==true||
      !parent.result?.id||!isTerminalOrderReceipt(parent.request,parent.result)||parent.result.filledQuantity<=0||
      parent.result.averagePriceVerified!==true||parent.request.reduceOnly!==true||parent.request.postOnly!==true||
      parent.executionEvidence?.bookedFeeUsd!==parent.result.feeUsd||
      legs.length!==1||parent.exchange===journal.exchange||journal.request.base!==p.base||journal.createdAt<parent.createdAt)
      throw new Error('已确认费用更正不属于原 Maker 的完整对侧成交');
    const leg=legs[0],delta=current.feeUsd-expectedBookedFeeUsd;
    if(![p.feesUsd,leg.feesUsd,p.feesUsd+delta,leg.feesUsd+delta,delta].every(Number.isFinite))
      throw new Error('原手续费现金基准无效，不能更正');
    if(delta===0)return false;
    const audit={verifiedAt:current.orderReadAt!,previousBookedFeeUsd:expectedBookedFeeUsd,feeDeltaUsd:delta,
      originalResult:structuredClone(old),nativeResult:structuredClone(current)};
    p.feesUsd+=delta;leg.feesUsd+=delta;
    // Only the verified fee changes; original quantity, average and native execution timestamp remain exact.
    journal.result={...old,feeUsd:current.feeUsd};journal.executionEvidence.bookedFeeUsd=current.feeUsd;
    (journal.confirmedPeerFeeCorrections??=[]).push(audit);
    refreshPnl(p);this.updateMakerComparisons(journal);
    try{this.store.save();}
    catch(error){this.interruptedOrderProcessing.add(p.id);throw error;}
    return true;
  }
  /** Only the dedicated native Maker observer may book complete verified active-order executions. */
  private applyConfirmedOrder(journal:JournalOrder,current:OrderResult,activeMaker=false):boolean {
    const p=this.store.data.positions.find(position=>position.id===journal.positionId);
    if(!p)throw new Error('订单缺少对应仓位，无法自动对账');
    if(this.quarantineNativeExitReceipt(p,journal,current))return false;
    const old=journal.result??this.unknown(journal.request);
    if(!hasOrderReceiptIdentity(journal.request,old)||!hasBoundedOrderQuantity(journal.request,old)||
      old.filledQuantity>0&&!(Number.isFinite(old.averagePrice)&&old.averagePrice>0))
      throw new Error('旧订单成交基准无效，需先核对本地账本');
    const observed={...journal,result:current};
    const validationReceipt=activeMaker?{...current,status:current.filledQuantity>=journal.request.quantity?'filled' as const:current.filledQuantity>0?'partial' as const:'cancelled' as const}:current;
    if(conflictingNativeOrderReceipts([...this.store.data.orders.filter(order=>order!==journal),observed]).has(observed)||!isTerminalOrderReceipt(journal.request,validationReceipt)||
      old.id&&current.id!==old.id||!Number.isFinite(current.timestamp)||current.timestamp<=0||current.timestamp>Date.now()+5000||
      current.filledQuantity<old.filledQuantity-orderQuantityTolerance(old.filledQuantity)||
      !Number.isFinite(current.feeUsd)||current.filledQuantity>0&&
        (!(Number.isFinite(current.averagePrice)&&current.averagePrice>0)||current.averagePriceVerified===false))
      throw new Error('交易所返回的累计成交数据不一致');
    const matches=[p.long,p.short].filter(leg=>leg.exchange===journal.exchange&&leg.symbol===journal.request.symbol&&
      journal.request.side===(leg.side==='long'?(journal.request.reduceOnly?'sell':'buy'):(journal.request.reduceOnly?'buy':'sell')));
    if(matches.length!==1||p.base!==journal.request.base)
      throw new Error('订单与仓位方向不一致');
    const leg=matches[0];
    if(!Number.isFinite(leg.quantity)||leg.quantity<0||!journal.request.reduceOnly&&
      old.filledQuantity>leg.quantity+orderQuantityTolerance(leg.quantity))
      throw new Error('旧订单已入账数量与仓位不一致，需先核对本地账本');
    if(![p.feesUsd,leg.feesUsd,p.realizedSpreadPnlUsd,leg.entryPrice].every(Number.isFinite)||
      leg.quantity>0&&leg.entryPrice<=0||leg.realizedPnlUsd!==undefined&&!Number.isFinite(leg.realizedPnlUsd))
      throw new Error('旧订单本地账本现金基准未知，无法自动校正');
    const bookedFee=journal.executionEvidence?.bookedFeeUsd??(Number.isFinite(old.feeUsd)?old.feeUsd:NaN);
    if(!Number.isFinite(bookedFee))throw new Error('旧订单已入账手续费未知，需先核对本地账本');
    const delta=Math.max(0,current.filledQuantity-old.filledQuantity),fee=current.feeUsd-bookedFee;
    // No-fill receipts have no meaningful average. In particular, 0 * NaN must never
    // alter the existing entry basis or realized cash when only an actual fee is learned.
    const correction=old.filledQuantity>0?old.filledQuantity*(current.averagePrice-old.averagePrice):0;
    if(!Number.isFinite(fee)||!Number.isFinite(correction))throw new Error('累计成交现金无效，无法自动对账');
    if(![p.feesUsd+fee,leg.feesUsd+fee].every(Number.isFinite))throw new Error('累计手续费现金无效，无法自动对账');
    if(journal.request.reduceOnly&&delta>leg.quantity+orderQuantityTolerance(leg.quantity))
      throw new Error('累计减仓数量超过已入账剩余仓位，需先核对本地账本');
    if(!journal.request.reduceOnly&&leg.quantity+delta>0){
      const basis=(leg.entryPrice*leg.quantity+(delta>0?current.averagePrice*delta:0)+correction)/(leg.quantity+delta);
      if(!(Number.isFinite(basis)&&basis>0))throw new Error('累计开仓均价与本地账本不一致，无法自动对账');
    }else if(journal.request.reduceOnly){
      const pnl=((delta>0?delta*(current.averagePrice-leg.entryPrice):0)+correction)*(leg.side==='long'?1:-1);
      if(![p.realizedSpreadPnlUsd+pnl,(leg.realizedPnlUsd??0)+pnl].every(Number.isFinite))
        throw new Error('累计已实现现金无效，无法自动对账');
    }
    let mutated=false;
    try{
    if(delta>0){
      if(old.filledQuantity>0&&old.averagePriceVerified===false){
        // The original quantity was trusted, but its price was provisional. New native
        // cumulative cash corrects those coins as well as adding the newly filled coins;
        // their difference is not evidence of a standalone incremental fill price.
        mutated=true;this.applyFill(p,leg,journal.request.side,{...current,filledQuantity:delta,feeUsd:fee},journal.request.reduceOnly,journal.makerReduction?.quantityStep,!!journal.makerReduction);
        if(journal.request.reduceOnly){const pnl=correction*(leg.side==='long'?1:-1);p.realizedSpreadPnlUsd+=pnl;leg.realizedPnlUsd=(leg.realizedPnlUsd??0)+pnl;}
        else leg.entryPrice+=correction/leg.quantity;
        refreshPnl(p);
      }else{
        const oldCash=old.filledQuantity>0?old.averagePrice*old.filledQuantity:0,
          cash=current.averagePrice*current.filledQuantity-oldCash,price=cash/delta,limitCash=delta*journal.request.limitPrice,
          cashTolerance=Math.max(1e-12,Math.max(Math.abs(oldCash),Math.abs(current.averagePrice*current.filledQuantity),Math.abs(limitCash))*Number.EPSILON*16);
        if(!(Number.isFinite(price)&&price>0)||!Number.isFinite(limitCash)||
          (journal.request.side==='buy'?cash>limitCash+cashTolerance:cash<limitCash-cashTolerance))
          throw new Error('增量成交价格无效或超出原订单限价，无法自动对账');
        mutated=true;this.applyFill(p,leg,journal.request.side,{...current,filledQuantity:delta,averagePrice:price,feeUsd:fee},journal.request.reduceOnly,journal.makerReduction?.quantityStep,!!journal.makerReduction);
      }
    }else{
      mutated=true;
      if(journal.request.reduceOnly){const pnl=correction*(leg.side==='long'?1:-1);p.realizedSpreadPnlUsd+=pnl;leg.realizedPnlUsd=(leg.realizedPnlUsd??0)+pnl;}
      else if(leg.quantity>0)leg.entryPrice+=correction/leg.quantity;
      leg.feesUsd+=fee;p.feesUsd+=fee;refreshPnl(p);
    }
    this.retainOriginalConfirmation(journal,current);
    journal.result=current;
    if(journal.executionEvidence)journal.executionEvidence.bookedFeeUsd=current.feeUsd;
    this.updateMakerComparisons(journal);
    journal.error=undefined;this.persistReconciliationObservation(journal,()=>this.store.save());
    this.operationObserved(p);
    if(journal.makerReduction&&(delta>0||fee!==0||correction!==0))this.context.makerFinancialActivity?.(journal);
    return true;
    }catch(error){
      if(mutated){this.blockedEntryRollbacks.add(p.id);this.interruptedOrderProcessing.add(p.id);}
      throw error;
    }
  }
  /** Existing-order GETs never occupy the financial queue; applying native cash still does. */
  async reconcilePendingConcurrent(positionId:string,canRead:()=>boolean):Promise<void>{
    const serial=this.context.serialize,config=this.context.config();
    if(config.mode!=='live'||!serial||!canRead())return;
    const journals=this.store.data.orders.filter(order=>order.positionId===positionId&&isCurrentUnconfirmedOrder(order,this.store.data.positions));
    for(const journal of journals){
      if(this.context.config()!==config||!canRead())return;
      if(this.concurrentReconciliationReads.has(journal))throw new UncertainOrderError('原订单只读核验仍未结束，保留原 ID 等待，未重复查单');
      const p=this.store.data.positions.find(position=>position.id===positionId);
      if(!p)throw new UncertainOrderError('原订单缺少对应仓位，未启动自动核验');
      const legs=[p.long,p.short],leg=legs.find(value=>value.exchange===journal.exchange&&value.symbol===journal.request.symbol);
      if(!leg||!this.store.data.orders.includes(journal)||conflictingNativeOrderReceipts(this.store.data.orders).has(journal))
        throw new UncertainOrderError('原订单身份或对应合约不唯一，保留账本等待核对');
      if(journal.makerReduction&&this.hasMakerClose(p))throw new UncertainOrderError('原 Maker 仍由监督器处理，未启动重复查单');
      const adapter=this.context.adapter(journal.exchange),requestObject=journal.request,request=structuredClone(requestObject),
        exchange=journal.exchange,createdAt=journal.createdAt,signature=JSON.stringify(request),
        scope=()=>JSON.stringify([this.iocProfitScope(p),p.openedAt,p.holdMode,p.closeAttemptedAt,p.closePauseReason]),proof=scope(),
        old=structuredClone(journal.result??this.unknown(request)),known=this.receipt(p,leg,request,hasOrderReceiptIdentity(request,old)?old:undefined);
      const unchanged=()=>{
        try{return canRead()&&this.context.config()===config&&this.context.adapter(exchange)===adapter&&
          this.store.data.positions.includes(p)&&p.long===legs[0]&&p.short===legs[1]&&this.store.data.orders.includes(journal)&&
          journal.positionId===positionId&&journal.exchange===exchange&&journal.createdAt===createdAt&&journal.request===requestObject&&
          JSON.stringify(journal.request)===signature&&scope()===proof&&isCurrentUnconfirmedOrder(journal,this.store.data.positions)&&
          !conflictingNativeOrderReceipts(this.store.data.orders).has(journal)&&(!journal.makerReduction||!this.hasMakerClose(p));}
        catch{return false;}
      };
      const retain=(result:OrderResult,reason:'scope-changed'|'late-read'|'unapplied-receipt')=>{
        const matches=this.store.data.orders.filter(order=>order.positionId===positionId&&order.exchange===exchange&&JSON.stringify(order.request)===signature);
        const target=this.store.data.orders.includes(journal)?journal:matches.length===1?matches[0]:undefined;
        if(!target||matches.length>1)return;
        const safe:OrderResult={id:result.id,clientOrderId:result.clientOrderId,status:result.status,filledQuantity:result.filledQuantity,
          averagePrice:result.averagePrice,feeUsd:result.feeUsd,timestamp:result.timestamp,
          ...(result.averagePriceVerified!==undefined?{averagePriceVerified:result.averagePriceVerified}:{}),
          ...(safeOrderConfirmation(result.confirmation)?{confirmation:safeOrderConfirmation(result.confirmation)}:{}),
          ...(safeOrderConfirmation(result.originalConfirmation)?{originalConfirmation:safeOrderConfirmation(result.originalConfirmation)}:{}),
          ...(result.orderReadAt!==undefined?{orderReadAt:result.orderReadAt}:{})};
        const entries=target.reconciliationEvidence??=[],last=entries.at(-1);
        if(last?.reason===reason&&JSON.stringify(last.request)===signature&&JSON.stringify(last.result)===JSON.stringify(safe))return;
        target.reconciliationEvidence=[...entries,{observedAt:Date.now(),reason,positionId,exchange,request:structuredClone(request),result:safe}].slice(-8);
        this.persistReconciliationObservation(target,()=>this.store.save(),true);
      };
      if(journal.makerReduction&&!adapter.inspectMakerReduction||!journal.makerReduction&&!adapter.inspectOrder)
        throw new UncertainOrderError('原订单只读接口缺失，保留未知；未回落到撤单或重新提交');
      const raw=Promise.resolve().then(async()=>{
        if(!unchanged())throw new UncertainOrderError('原订单范围已变化，未启动新的只读核验');
        try{
        if(journal.makerReduction){
          const observation=await adapter.inspectMakerReduction!(request,known.id||undefined);
          return {observation,result:this.receipt(p,leg,request,observation.result,known)};
        }
        return {observation:undefined,result:this.receipt(p,leg,request,await adapter.inspectOrder!(request,known.id||undefined),known)};
        }catch(error){
          if(error instanceof UncertainOrderError)throw error;
          // An adapter GET socket syscall is not a filesystem ledger failure.
          throw new UncertainOrderError(`${exchange} 原订单只读核验暂不可用：${tradingError(exchange,'合约检查',error).message}；保留原 ID 等待`);
        }
      });
      this.concurrentReconciliationReads.set(journal,raw);
      let timedOut=false,timer:ReturnType<typeof setTimeout>|undefined;
      const clear=()=>{if(this.concurrentReconciliationReads.get(journal)===raw)this.concurrentReconciliationReads.delete(journal);};
      void raw.then(value=>{
        clear();if(!timedOut)return;
        void serial(async()=>retain(value.result,'late-read')).catch(()=>{
          this.store.data.killSwitch=true;
          try{this.context.halt('原订单迟到只读观察无法保存，已停止交易并保留原账本');}catch{/* Keep the in-memory stop if persistence remains unavailable. */}
        });
      },clear);
      let value:Awaited<typeof raw>;
      try{value=await Promise.race([raw,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
        timedOut=true;reject(new UncertainOrderError('原订单只读核验超时；保留原 ID，迟到观察不会自动入账或重复提交'));
      },8000);})]);}
      finally{if(timer)clearTimeout(timer);}
      await serial(async()=>{
        this.concurrentReconciliationCommits.add(journal);
        try{
        if(!unchanged()){
          retain(value.result,'scope-changed');throw new UncertainOrderError('原订单等待期间身份、现金或数量已变化；已保留只读观察，未自动入账');
        }
        let applied=false;
        try{
          if(value.observation){
            if(value.observation.activity!=='terminal'||!value.observation.executionVerified){
              retain(value.result,'unapplied-receipt');throw new UncertainOrderError('原 Maker 尚无可信终态，保留原 ID 等待');
            }
            applied=this.applyObservedMakerTerminal(journal,{...value.observation,result:value.result});
          }else applied=this.applyObservedOrder(journal,value.result);
        }catch(error){retain(value.result,'unapplied-receipt');throw error;}
        if(applied&&!journal.makerReduction)this.context.makerFinancialActivity?.(journal);
        if(value.result.status==='unknown'||value.observation&&!applied||isCurrentUnconfirmedOrder(journal,this.store.data.positions))
          throw new UncertainOrderError('原订单仍待核对，未重复提交或推定零成交');
        }finally{this.concurrentReconciliationCommits.delete(journal);}
      });
    }
  }
  async reconcilePending(positionId?:string):Promise<void>{
    if(this.context.config().mode!=='live')return;
    for(const journal of this.store.data.orders.filter(o=>(positionId===undefined||o.positionId===positionId)&&isCurrentUnconfirmedOrder(o,this.store.data.positions))){
      const p=this.store.data.positions.find(p=>p.id===journal.positionId);
      if(!p)throw new Error('订单缺少对应仓位，无法自动对账');
      const old=journal.result??this.unknown(journal.request);
      if(conflictingNativeOrderReceipts(this.store.data.orders).has(journal))throw new UncertainOrderError('原订单身份被多条记录复用，请先核对账本，禁止重复入账');
      const leg=[p.long,p.short].find(candidate=>candidate.exchange===journal.exchange&&candidate.symbol===journal.request.symbol);
      if(!leg)throw new Error('原订单缺少对应合约，无法自动对账');
      const known=this.receipt(p,leg,journal.request,hasOrderReceiptIdentity(journal.request,old)?old:undefined);
      if(journal.makerReduction){
        if(this.hasMakerClose(p))throw new UncertainOrderError('原 Maker 挂单由本轮监督器处理，禁止通用对账重复撤单或减仓');
        const adapter=this.context.adapter(journal.exchange),observation=await adapter.inspectMakerReduction?.(journal.request,known.id||undefined);
        if(!observation||observation.activity!=='terminal'||!observation.executionVerified)
          throw new UncertainOrderError('原 Maker 订单尚未取得可信终态；仅核对原 ID，不恢复挂单或交易权限');
        this.applyObservedMakerTerminal(journal,observation);continue;
      }
      const adapter=this.context.adapter(journal.exchange),quarantined=this.historicalNativeExitAudit(p,journal);
      if(quarantined&&!adapter.inspectOrder)throw new UncertainOrderError('历史原单只允许 GET 核验，当前接口缺失');
      const current=this.receipt(p,leg,journal.request,await (quarantined?adapter.inspectOrder!(journal.request,known.id||undefined):adapter.reconcileOrder(journal.request,known.id||undefined)),known);
      if(current.status==='unknown'){
        this.applyObservedOrder(journal,current);
        throw new UncertainOrderError('仍有未知订单，请等待交易所可查询后再次对账');
      }
      this.applyObservedOrder(journal,current);
    }
  }
  private applyFill(p:Position,l:PositionLeg,_side:Side,r:OrderResult,reduce:boolean,confirmedStep?:number,verifiedMakerCash=false){
    const q=r.filledQuantity;
    if(q>0&&reduce){
      const actual=Math.min(q,l.quantity);
      const pnl=actual*(r.averagePrice-l.entryPrice)*(l.side==='long'?1:-1);
      p.realizedSpreadPnlUsd+=pnl;l.realizedPnlUsd=(l.realizedPnlUsd??0)+pnl;
      const step=r.status!=='unknown'||verifiedMakerCash?confirmedStep??NaN:NaN;
      // Only confirmed reductions of two nonzero, legal native lot quantities can remove binary arithmetic noise.
      // The immutable receipt and realized cash still use the actual reported fill; real off-grid dust stays visible.
      l.quantity=Math.max(0,quantitySubtractOnStep(l.quantity,actual,step));
    }else if(q>0){
      const totalQuantity=quantityAdd(l.quantity,q);
      l.entryPrice=(l.entryPrice*l.quantity+r.averagePrice*q)/totalQuantity;l.quantity=totalQuantity;
    }
    if(q>0)l.markPrice=r.averagePrice;
    if(Number.isFinite(r.feeUsd)){l.feesUsd+=r.feeUsd;p.feesUsd+=r.feeUsd;}
    refreshPnl(p);
  }
  private validateEntryPolicy(p:Position,o:Opportunity){
    // Persisted positions without this field use the old dual model even if the global setting changes.
    if((p.entryPolicy??'dual')!==(o.entryPolicy??'dual'))throw new Error('入场收益模型已变化，未提交订单');
  }
  private economicsPosition(p:Position,ownedUnsentOrders:readonly JournalOrder[]=[]):Position {
    const config=this.context.config();
    const canonical=this.nativeExitAuthorities.get(p.id)?.position,
      reserve=canonical&&this.hasNativeExitAuthority(canonical)?this.nativeExitAuthorities.get(p.id)!.audit:undefined;
    if(!reserve&&![p.long,p.short].some(leg=>feeRebatePct(leg.exchange,config)>0))return p;
    const orders=this.store.data.orders.filter(order=>!ownedUnsentOrders.includes(order)&&(!reserve||!this.isNativeExitAuditOrder(canonical!,order)));
    return {...p,estimatedFeeRebateUsd:projectPositionFeeRebate(p,orders,config)??null,
      transferCostUsd:p.transferCostUsd+(reserve?.feeReserveUsd??0)+(reserve?.lossReserveUsd??0)};
  }
  private currentFundingContext(p:Position,long:MarketSnapshot,short:MarketSnapshot,longQuantity:number,shortQuantity:number,exitTime:number){
    const identityReason=instrumentIdentityBlockReason(p.base,long.exchange,short.exchange);
    if(identityReason)throw new Error(identityReason);
    const c=this.context.config(),now=Date.now(),longFee=takerFeeRate(long,c,now)??NaN,shortFee=takerFeeRate(short,c,now)??NaN;
    if(long.base!==p.base||short.base!==p.base||long.symbol!==p.long.symbol||short.symbol!==p.short.symbol||
      long.exchange!==p.long.exchange||short.exchange!==p.short.exchange||long.source!==short.source||
      !bookIsUncrossedWhenObserved(long)||!bookIsUncrossedWhenObserved(short)||
      quoteSkewMs(long,short)>c.maxQuoteSkewMs||![longFee,shortFee].every(value=>Number.isFinite(value)&&value>=0)||
      ![longQuantity,shortQuantity,long.markPrice,short.markPrice,long.intervalHours,short.intervalHours].every(value=>Number.isFinite(value)&&value>0)||
      ![long.fundingRate,short.fundingRate,exitTime,long.nextFundingTime,short.nextFundingTime].every(Number.isFinite)||
      long.nextFundingTime<=now+3000||short.nextFundingTime<=now+3000||exitTime<=now)
      throw new Error('资金费收益复核缺少有效同币盘口、手续费或结算时间');
    // A committed hedge uses the same paired funding window as discovery; a mechanical
    // exit delay cannot create another predicted hourly payment.
    const fundingEnd=p.entryPolicy==='aligned'?Math.max(long.nextFundingTime,short.nextFundingTime):exitTime;
    return {longFee:effectiveFeeRate(long.exchange,longFee,c)!,shortFee:effectiveFeeRate(short.exchange,shortFee,c)!,fundingUsd:shortQuantity*short.markPrice*short.fundingRate*fundingCount(short,fundingEnd,now)-
      longQuantity*long.markPrice*long.fundingRate*fundingCount(long,fundingEnd,now)};
  }
  private fundingClosingCosts(p:Position,long:MarketSnapshot,short:MarketSnapshot,longQuantity:number,shortQuantity:number,exitTime:number){
    const context=this.currentFundingContext(p,long,short,longQuantity,shortQuantity,exitTime);
    const longClose=sweepBook(long,'bids',longQuantity),shortClose=sweepBook(short,'asks',shortQuantity);
    if(longClose.filled<longQuantity*(1-1e-9)||shortClose.filled<shortQuantity*(1-1e-9)||
      ![longClose.value,shortClose.value].every(value=>Number.isFinite(value)&&value>0))
      throw new Error('资金费收益复核缺少整笔平仓盘口，未扩大仓位');
    return {...context,longClose,shortClose,feesUsd:longClose.value*context.longFee+shortClose.value*context.shortFee};
  }
  private validateAlignedEntry(p:Position,o:Opportunity,prepared:PreparedOrder[]){
    const long=this.freshSnapshot(p,p.long),short=this.freshSnapshot(p,p.short);
    if(!long||!short)throw new Error('价格与资金费入场复核缺少最新双腿盘口');
    const longRequest=prepared.find(order=>order.leg===p.long)!.request,shortRequest=prepared.find(order=>order.leg===p.short)!.request;
    if(longRequest.reduceOnly||shortRequest.reduceOnly||longRequest.side!=='buy'||shortRequest.side!=='sell'||
      Math.abs(longRequest.quantity-shortRequest.quantity)>commonStep(long.quantityStep,short.quantityStep)*.1)
      throw new Error('价格与资金费入场数量或方向不一致');
    const context=this.currentFundingContext(p,long,short,longRequest.quantity,shortRequest.quantity,o.exitTime);
    if(!(context.fundingUsd>0)||!alignedEntryPricesFavorable(longRequest.limitPrice,shortRequest.limitPrice,long,short,this.context.config()))
      throw new Error(`实际 IOC 开仓价格优势须大于 ${minimumEntryIocEdgeBps(this.context.config())} bps，或下一轮资金费优势已消失，未提交订单`);
    if(p.automaticEntry){
      const buy=bestOppositeLevel(long,'buy'),sell=bestOppositeLevel(short,'sell');
      const rawEdge=buy&&sell?alignedEntryIocEdgeBps(buy.price,sell.price,long.indexPrice,short.indexPrice):NaN;
      if(!Number.isFinite(rawEdge)||rawEdge<=AUTO_ENTRY_MIN_OPPOSITE_EDGE_BPS+1e-9)
        throw new Error('自动开仓要求当前本批对手价1价格优势严格大于 20 bps，未提交订单');
      const limitEdge=alignedEntryIocEdgeBps(longRequest.limitPrice,shortRequest.limitPrice,long.indexPrice,short.indexPrice);
      const assessment=automaticEntryAssessment({...o,entryPriceEdgeBps:rawEdge,entryLimitPriceEdgeBps:limitEdge,expectedFundingUsd:context.fundingUsd});
      if(!assessment.passes)throw new Error(assessment.reason??'自动开仓收益或本批对手价1条件未满足');
      if(!sameQuantity(longRequest.quantity,shortRequest.quantity))throw new Error('自动开仓本批两腿数量必须一致');
      const quantity=longRequest.quantity,c=this.context.config();
      // Recheck this actual batch after private validation. Opening fees use its submitted IOC
      // bounds; closing fees use current mark notionals. Price advantage remains an independent gate.
      const fees=estimateAlignedEntryFees(long,short,quantity,c,
        {longOpenPrice:longRequest.limitPrice,shortOpenPrice:shortRequest.limitPrice});
      const net=context.fundingUsd-fees;
      if(![fees,net].every(Number.isFinite))throw new Error('自动开仓本批收益及真实手续费待核验');
      const priceRoute=rawEdge>AUTO_ENTRY_PRICE_ROUTE_MIN_OPPOSITE_EDGE_BPS+1e-9&&limitEdge>AUTO_ENTRY_PRICE_ROUTE_MIN_IOC_EDGE_BPS+1e-9&&context.fundingUsd>0;
      const singleRoute=(o.combinedExpectedNetUsd??NaN)>0&&rawEdge>AUTO_ENTRY_MIN_OPPOSITE_EDGE_BPS+1e-9&&net>0;
      const pathCommitted=this.store.data.orders.some(order=>order.positionId===p.id&&!order.request.reduceOnly);
      if(pathCommitted&&p.executionEvidence?.entryPath==='price-100'&&!priceRoute)
        throw new Error('价差路径每个新批次都须保持对手价1 >100 bps、实际 IOC >80 bps、净资金费为正');
      if(pathCommitted&&p.executionEvidence?.entryPath==='single-cycle'&&!singleRoute)
        throw new Error('单轮收益路径后续本批单轮净收益大于 0 才扩仓；已确认对冲保留，不切换路径继续扩仓');
      if(!singleRoute&&!priceRoute)
        throw new Error('自动开仓要求实际 IOC 限价对应的本批单轮净收益大于 0，未提交订单');
      // Freeze the path when it first authorizes a real batch. Never let prior matched profits subsidize an adverse new batch.
      if(!pathCommitted&&p.executionEvidence)p.executionEvidence.entryPath=singleRoute?'single-cycle':'price-100';
    }
  }
  private validateFundingEntryProfit(p:Position,o:Opportunity,prepared:PreparedOrder[]){
    const c=this.context.config(),long=this.freshSnapshot(p,p.long),short=this.freshSnapshot(p,p.short);
    if(!long||!short)throw new Error('资金费入场收益复核缺少最新双腿盘口');
    const longRequest=prepared.find(order=>order.leg===p.long)!.request,shortRequest=prepared.find(order=>order.leg===p.short)!.request;
    if(longRequest.reduceOnly||shortRequest.reduceOnly||longRequest.side!=='buy'||shortRequest.side!=='sell'||
      Math.abs(longRequest.quantity-shortRequest.quantity)>commonStep(long.quantityStep,short.quantityStep)*.1)
      throw new Error('资金费入场准备数量或方向不一致');
    const close=this.fundingClosingCosts(p,long,short,longRequest.quantity,shortRequest.quantity,o.exitTime);
    // IOC permits every unit to fill at its limit, so evaluate that bound rather than the displayed VWAP.
    const longCost=longRequest.quantity*longRequest.limitPrice,shortCost=shortRequest.quantity*shortRequest.limitPrice;
    const economics=evaluateTradeEconomics({fundingUsd:close.fundingUsd,
      spreadUsd:shortCost-longCost+close.longClose.value-close.shortClose.value,
      feesUsd:longCost*close.longFee+shortCost*close.shortFee+close.feesUsd,
      minCombinedNetUsd:c.minCombinedNetUsd,requireSpreadPositive:false});
    if(!economics.eligible)throw new Error('开仓 IOC 限价允许的资金费扣开平成本后收益不足，未提交订单');
  }
  private validateSupplementProfit(p:Position,o:Opportunity,request:OrderRequest){
    const c=this.context.config(),long=this.freshSnapshot(p,p.long),short=this.freshSnapshot(p,p.short),now=Date.now();
    this.validateEntryPolicy(p,o);
    // A rounded order-summary price is not evidence of the actual filled basis. Bitget marks
    // this explicitly until all trade rows are available; never enlarge using that approximation.
    if([p.long,p.short].some(leg=>leg.quantity>0&&this.store.data.orders.some(order=>order.positionId===p.id&&order.exchange===leg.exchange&&
      !order.request.reduceOnly&&(order.result?.filledQuantity??0)>0&&order.result?.averagePriceVerified===false)))
      throw new Error('已成交均价尚未取得完整成交明细核实，暂不扩大补腿，保留已确认对冲');
    const fundingPolicy=p.entryPolicy==='funding',alignedPolicy=p.entryPolicy==='aligned';
    if(!long||!short||(!(fundingPolicy||alignedPolicy)&&(o.spreadAdvantage?.status!=='ready'||!Number.isFinite(o.spreadAdvantage.expectedExitSpreadBps))))throw new Error('补单缺少最新双腿盘口或退出价差依据');
    const leg=request.symbol===p.long.symbol&&request.side==='buy'?p.long:p.short;
    if(request.reduceOnly||request.symbol!==leg.symbol||request.side!==(leg.side==='long'?'buy':'sell'))throw new Error('补单方向或合约不一致');
    const longQuantity=p.long.quantity+(leg===p.long?request.quantity:0),shortQuantity=p.short.quantity+(leg===p.short?request.quantity:0);
    if(![longQuantity,shortQuantity,request.quantity,request.limitPrice].every(v=>Number.isFinite(v)&&v>0)||Math.abs(longQuantity-shortQuantity)>commonStep(long.quantityStep,short.quantityStep)*.1)throw new Error('补单后币数量仍不能匹配');
    const longCost=p.long.quantity*p.long.entryPrice+(leg===p.long?request.quantity*request.limitPrice:0);
    const shortCost=p.short.quantity*p.short.entryPrice+(leg===p.short?request.quantity*request.limitPrice:0);
    if(alignedPolicy){
      const context=this.currentFundingContext(p,long,short,longQuantity,shortQuantity,o.exitTime);
      // Existing profitable matched units cannot subsidize an unfavorable new missing leg.
      // Price only the outstanding coins against their already-filled opposite leg first.
      const repairLongPrice=leg===p.long?request.limitPrice:p.long.entryPrice;
      const repairShortPrice=leg===p.short?request.limitPrice:p.short.entryPrice;
      if(![longCost,shortCost].every(value=>Number.isFinite(value)&&value>0)||!(context.fundingUsd>0)||
        !alignedEntryPricesFavorable(repairLongPrice,repairShortPrice,long,short,this.entryConfig(p))||
        !alignedEntryPricesFavorable(longCost/longQuantity,shortCost/shortQuantity,long,short,this.entryConfig(p)))
        throw new Error(`实际成交均价与补单限价的 IOC 优势须大于 ${minimumEntryIocEdgeBps(this.entryConfig(p))} bps，或下一轮资金费不为正，回撤未配对敞口`);
      return;
    }
    const close=fundingPolicy?this.fundingClosingCosts(p,long,short,longQuantity,shortQuantity,o.exitTime):undefined;
    const longFee=effectiveFeeRate(long.exchange,takerFeeRate(long,c,now),c)??NaN,
      shortFee=effectiveFeeRate(short.exchange,takerFeeRate(short,c,now),c)??NaN,
      paidRebate=projectPositionFeeRebate(p,this.store.data.orders,c);
    const fees=p.feesUsd-(paidRebate??NaN)+request.quantity*request.limitPrice*(leg===p.long?longFee:shortFee)+(close?.feesUsd??
      (longQuantity*long.markPrice*longFee+shortQuantity*short.markPrice*shortFee));
    const funding=close?.fundingUsd??(shortQuantity*short.markPrice*short.fundingRate*fundingCount(short,o.exitTime,now)-longQuantity*long.markPrice*long.fundingRate*fundingCount(long,o.exitTime,now));
    const spread=shortCost-longCost+(close?close.longClose.value-close.shortClose.value:
      -longQuantity*(long.indexPrice+short.indexPrice)/2*o.spreadAdvantage!.expectedExitSpreadBps!/10000);
    const economics=evaluateTradeEconomics({fundingUsd:funding,spreadUsd:spread,feesUsd:fees,minCombinedNetUsd:c.minCombinedNetUsd,requireSpreadPositive:!fundingPolicy});
    if(![longCost,shortCost].every(Number.isFinite)||!economics.eligible)
      throw new Error('已成交均价与补单限价对应的资金费、价差或合计扣费收益不足，回撤未配对敞口');
  }
  private checkBatchOpportunity(p:Position,o:Opportunity){
    this.validateEntryPolicy(p,o);
    if(o.base!==p.base||o.longExchange!==p.long.exchange||o.shortExchange!==p.short.exchange)
      throw new Error('分批提交前合约方向已变化，停止扩大仓位');
  }
  private pauseBatchEntry(p:Position,reason:string):boolean{
    if(!this.store.data.orders.some(order=>order.positionId===p.id&&isCurrentUnconfirmedOrder(order,this.store.data.positions)))return false;
    if(p.entryExecution){p.entryExecution.matchedQuantity=Math.min(p.long.quantity,p.short.quantity);p.entryExecution.stopReason=reason;}
    return this.pauseUnconfirmedEntry(p,reason);
  }
  private bestPriceOrder(p:Position,leg:PositionLeg,side:Side,quantity:number,permittedLimitPrice?:number):PreparedOrder{
    const book=this.freshSnapshot(p,leg),top=book&&bestOppositeLevel(book,side);
    if(!book)throw new Error('行情过期，无法确定最优对手价');
    if(!top||quantity>top.quantity+Math.max(1e-12,Math.abs(top.quantity)*Number.EPSILON*8))throw new Error('当前最优对手价数量不足，停止扩大仓位');
    const prepared=this.buildOrder(p,leg,side,quantity,false);
    if(prepared.request.quantity!==quantity||prepared.request.limitPrice!==top.price)
      throw new Error('首档限价或下单数量已变化，停止扩大仓位');
    if(permittedLimitPrice!==undefined){
      const visible=(side==='buy'?book.asks:book.bids).some(level=>level.price===permittedLimitPrice&&level.quantity>0&&Number.isFinite(level.quantity));
      if(!visible||!Number.isFinite(permittedLimitPrice)||permittedLimitPrice<=0||
        (side==='buy'?permittedLimitPrice<top.price:permittedLimitPrice>top.price)||quantity*permittedLimitPrice<book.minNotional)
        throw new Error('IOC 缓冲限价不在可见盘口内或不满足最小金额');
      prepared.request.limitPrice=permittedLimitPrice;
    }
    prepared.pricing='best-opposite';
    return prepared;
  }
  private checkBestPriceOrder(p:Position,prepared:PreparedOrder){
    this.checkPreparedOrder(p,prepared);
  }
  /** IOC economics are still checked on both legs before choosing this optional passive first leg. */
  private makerFirstOrder(p:Position,ioc:PreparedOrder):PreparedOrder {
    if((p.executionEvidence?.method??this.context.config().entryExecutionMode??'ioc')!=='maker-ioc')return ioc;
    const s=this.freshSnapshot(p,ioc.leg),ask=s&&bestOppositeLevel(s,'buy'),bid=s&&bestOppositeLevel(s,'sell');
    if(ioc.leg!==p.short||ioc.request.side!=='sell'||ioc.request.reduceOnly||!s||!ask||!bid||!(bid.price<ask.price))
      throw new Error('Maker 首腿需要明确空腿卖1及未交叉的新鲜盘口');
    const maker=nativeMakerFeeRate(s),taker=takerFeeRate(s,this.context.config());
    if(maker===undefined||taker===undefined||!(maker<taker))throw new Error('Maker 首腿等待官方 Maker/Taker 费率确认，且 Maker 费率须更低');
    if(ioc.request.quantity*ask.price<s.minNotional)throw new Error('Maker 首腿金额低于交易所最小下单额');
    if(p.mode==='live'&&!['gate','bybit','bitget'].includes(ioc.leg.exchange))throw new Error('当前交易所未验证 Maker 首腿执行适配');
    if(p.executionEvidence?.prediction){const config=this.context.config();
      p.executionEvidence.prediction.makerFeeSavingUsd=ioc.request.quantity*ask.price*(effectiveFeeRate(s.exchange,taker,config)!-effectiveFeeRate(s.exchange,maker,config)!);}
    return {...ioc,snapshot:s,pricing:undefined,request:{...ioc.request,limitPrice:ask.price,postOnly:true}};
  }
  /** Each batch has its own filled basis; prior matched profits never approve an adverse new leg. */
  private batchFilledBasis(p:Position,leg:PositionLeg,journalStart:number){
    let quantity=0,value=0,verified=true;
    for(const order of this.store.data.orders.slice(journalStart)){
      if(order.positionId!==p.id||order.exchange!==leg.exchange||order.request.reduceOnly||!order.result||order.result.status==='unknown')continue;
      const result=order.result;
      if(result.filledQuantity>0){quantity+=result.filledQuantity;value+=result.filledQuantity*result.averagePrice;verified&&=result.averagePriceVerified!==false;}
    }
    return {quantity,averagePrice:quantity>0?value/quantity:0,verified};
  }
  private checkBatchLong(p:Position,o:Opportunity,order:PreparedOrder,journalStart:number){
    this.checkBatchOpportunity(p,o);
    const long=this.freshSnapshot(p,p.long),short=this.freshSnapshot(p,p.short);
    const sold=this.batchFilledBasis(p,p.short,journalStart),bought=this.batchFilledBasis(p,p.long,journalStart);
    if(!long||!short||!sold.verified||!bought.verified||!(sold.quantity>0)||
      order.request.quantity>sold.quantity-bought.quantity+1e-10)
      throw new Error('本批成交均价尚未核实或补腿超过已成交数量，停止扩大仓位');
    const paired=bought.quantity+order.request.quantity;
    const funding=this.currentFundingContext(p,long,short,paired,paired,o.exitTime);
    if(!(funding.fundingUsd>0)||!alignedEntryPricesFavorable(order.request.limitPrice,sold.averagePrice,long,short,this.entryConfig(p)))
      throw new Error(`本批实际成交均价与最优买价的 IOC 优势须大于 ${minimumEntryIocEdgeBps(this.entryConfig(p))} bps，且资金费须有优势`);
  }
  /** Compare a still-budgeted missing-leg hedge with rollback, then reduce only this batch's tail. */
  private async trimBatchTail(p:Position,previousMatched:number,compensation?:{
    journalStart:number;batch:number;opportunity:Opportunity;validateEntry:EntryValidation;
  }):Promise<boolean>{
    if(this.pauseInterruptedExecution(p))return false;
    if(this.blockedEntryRollbacks.has(p.id)){p.status='attention';p.riskReasons=['本次入场尾差执行已暂停，先核对原订单及账户'];this.store.save();return false;}
    const c=this.context.config();
    let recorded:ReturnType<typeof compareEntryCompensation>['evidence']|undefined;
    const compensationJournalStart=this.store.data.orders.length;
    const outcome=(value:'hedged'|'rollback'|'unresolved')=>{
      if(!recorded)return;
      const completed=this.store.data.orders.slice(compensationJournalStart).filter(order=>order.positionId===p.id&&
        !!order.result&&order.result.status!=='unknown'&&Number.isFinite(order.result.filledQuantity)&&order.result.filledQuantity>=0);
      recorded.outcome=value;
      recorded.hedgeFilledQuantity=completed.filter(order=>!order.request.reduceOnly).reduce((sum,order)=>sum+order.result!.filledQuantity,0);
      recorded.reducedLongQuantity=completed.filter(order=>order.request.reduceOnly&&order.exchange===p.long.exchange).reduce((sum,order)=>sum+order.result!.filledQuantity,0);
      recorded.reducedShortQuantity=completed.filter(order=>order.request.reduceOnly&&order.exchange===p.short.exchange).reduce((sum,order)=>sum+order.result!.filledQuantity,0);
      this.store.save();
    };
    if(compensation&&p.entryPolicy==='aligned'&&!sameQuantity(p.long.quantity,p.short.quantity)){
      const record=(evidence:NonNullable<typeof recorded>)=>{
        const prior=recorded;
        recorded=evidence;
        if(p.executionEvidence){
          const comparisons=p.executionEvidence.compensations??=[],index=prior?comparisons.indexOf(prior):-1;
          if(index>=0)comparisons[index]=evidence;else comparisons.push(evidence);
          this.store.save();
        }
      };
      try{
        if(this.pauseBatchEntry(p,'补偿比较前原订单待核对，禁止猜测补齐或撤回'))return false;
        await this.refresh(p,[p.long,p.short]);
        const long=this.freshSnapshot(p,p.long),short=this.freshSnapshot(p,p.short);
        if(long&&short){
          const orders=this.store.data.orders.slice(compensation.journalStart).filter(order=>order.positionId===p.id),
            sold=this.batchFilledBasis(p,p.short,compensation.journalStart),bought=this.batchFilledBasis(p,p.long,compensation.journalStart),
            shortTail=p.short.quantity>p.long.quantity,missing=Math.abs(p.short.quantity-p.long.quantity),
            basis=shortTail?sold:bought;
          const confirmed=orders.every(order=>!!order.result&&['filled','partial','cancelled'].includes(order.result.status)&&
            order.result.clientOrderId===order.request.clientOrderId)&&sold.verified&&bought.verified&&
            sameQuantity(Math.abs(sold.quantity-bought.quantity),missing);
          const openingLongOrders=orders.filter(order=>order.exchange===p.long.exchange&&!order.request.reduceOnly),
            budget=c.mode==='live'&&c.maxOrderRetries>0?c.maxOrderRetries+2:1,
            refused=openingLongOrders.some(order=>!!order.result&&order.result.filledQuantity===0&&!canRetryZeroEntry(order.result));
          const pricePlan=shortTail?planBufferedLongEntry(long,short,missing,basis.averagePrice,
            {bufferBps:c.entryIocBufferBps??8,minEdgeBps:minimumEntryIocEdgeBps(this.entryConfig(p))}):undefined;
          const compare=(longBook:MarketSnapshot,shortBook:MarketSnapshot,hedgeLimitPrice:number|undefined,opportunity:Opportunity)=>{
            let funding:number|undefined;
            try{funding=this.currentFundingContext(p,longBook,shortBook,missing,missing,opportunity.exitTime).fundingUsd;}catch{/* Preserve a conditional unknown. */}
            return compareEntryCompensation({observedAt:Date.now(),batchId:`${p.id}:${compensation.batch}`,long:longBook,short:shortBook,
              longQuantity:p.long.quantity,shortQuantity:p.short.quantity,previousMatched,frozenTarget:p.entryExecution?.targetQuantity??NaN,
              unmatchedEntryPrice:basis.averagePrice,averagePriceVerified:basis.verified,originalIntentsConfirmed:confirmed,
              longTakerFeeRate:takerFeeRate(longBook,c),shortTakerFeeRate:takerFeeRate(shortBook,c),feeRebatePct:c.feeRebatePct,hedgeLimitPrice,
              minimumPriceEdgeBps:minimumEntryIocEdgeBps(this.entryConfig(p)),predictedFundingUsd:funding,
              projectionUntil:Math.max(longBook.nextFundingTime,shortBook.nextFundingTime)});
          };
          const plan=compare(long,short,pricePlan&&sameQuantity(pricePlan.quantity,missing)?pricePlan.limitPrice:undefined,compensation.opportunity);
          const constraint=!shortTail?'no-supported-hedge':refused?'explicit-rejection':openingLongOrders.length>=budget?'retry-budget':
            c.mode==='live'&&!this.context.refreshSnapshots?'no-fresh-refresh':undefined;
          if(constraint){plan.evidence.constraint=constraint;plan.evidence.decision=plan.evidence.rollback?'rollback':'wait';}
          record(plan.evidence);
          if(plan.evidence.decision==='hedge'){
            const prepared=this.bestPriceOrder(p,p.long,'buy',missing,plan.evidence.hedge!.limitPrice);
            prepared.entryBatch=compensation.batch;
            await this.validateOrders([prepared]);
            const opportunity=await compensation.validateEntry('supplement',{longQuantity:prepared.request.quantity,shortQuantity:0});
            if(this.pauseBatchEntry(p,'本批补偿提交前原订单待核对，禁止猜测补齐或撤回')){outcome('unresolved');return false;}
            this.checkBestPriceOrder(p,prepared);this.checkBatchLong(p,opportunity,prepared,compensation.journalStart);
            const currentLong=this.freshSnapshot(p,p.long),currentShort=this.freshSnapshot(p,p.short);
            if(!currentLong||!currentShort)throw new Error('本批补偿提交前缺少新鲜双腿盘口');
            const final=compare(currentLong,currentShort,prepared.request.limitPrice,opportunity);
            if(final.evidence.decision!=='hedge'){record(final.evidence);}
            else{
              record(final.evidence);
              this.store.log('info',`${p.base} 本批尾差 ${missing}：按本周期末盘口不变条件，补齐预计成本 ${final.evidence.hedge!.costUsd.toFixed(6)}，撤回 ${final.evidence.rollback?.costUsd.toFixed(6)??'无法精确下单'}；仅补本批缺腿`,p.id);
              await this.submitOrder(p,prepared);
              if(this.pauseBatchEntry(p,'本批受控补齐状态待核对，禁止猜测撤回')){outcome('unresolved');return false;}
            }
          }
        }
      }catch(error){
        if(this.pauseBatchEntry(p,'本批受控补齐状态待核对，禁止补发或猜测撤回')||error instanceof UncertainOrderError){outcome('unresolved');return false;}
        if(recorded){
          recorded.constraint='validation-failed';
          // A confirmed reply can already be applied when local saving/logging throws. Preserve
          // the actual attempted choice; only pre-submission refusal changes it to rollback/wait.
          const attempted=this.store.data.orders.slice(compensationJournalStart).some(order=>order.positionId===p.id&&!order.request.reduceOnly);
          if(!attempted)recorded.decision=recorded.rollback?'rollback':'wait';
          this.store.save();
        }
        // No replacement order is retried here. The existing exact reduction path remains the fallback.
      }
    }
    if(this.blockedEntryRollbacks.has(p.id)){
      outcome(sameQuantity(p.long.quantity,p.short.quantity)?'hedged':'unresolved');
      p.status='attention';p.riskReasons=['原入场成交处理或保存中断，暂停尾差续处理，先核对账本及账户'];this.store.save();return false;
    }
    let reductionFailure:string|undefined;
    for(let retry=0;!sameQuantity(p.long.quantity,p.short.quantity)&&retry<=c.maxOrderRetries;retry++){
      if(retry>0&&c.mode==='live'&&!this.context.refreshReductionSnapshots&&!this.context.refreshSnapshots)break;
      if(this.pauseBatchEntry(p,'本批撤回前原订单待核对，禁止新增减仓')){outcome('unresolved');return false;}
      let stage='盘口刷新';
      const journalStart=this.store.data.orders.length;
      try{
        const larger=p.long.quantity>p.short.quantity?p.long:p.short;
        // Closing confirmed excess never depends on the venue that filled nothing.
        await this.refreshReduction(p,[larger]);
        let long=this.freshSnapshot(p,p.long),short=this.freshSnapshot(p,p.short);
        const book=larger===p.long?long:short;
        if(!book)throw new Error('待减仓腿盘口暂不可用');
        stage='合法数量与减仓限价';
        const difference=Math.abs(p.long.quantity-p.short.quantity),other=larger===p.long?p.short:p.long;
        const exactExcess=floorQuantity(difference,book.quantityStep);
        let reductions:PreparedOrder[];
        if(sameQuantity(exactExcess,difference)&&exactExcess>=book.minQuantity&&
          other.quantity>=previousMatched-1e-10){
          reductions=[this.buildOrder(p,larger,larger.side==='long'?'sell':'buy',exactExcess,true)];
        }else{
          // Incompatible lots can require reductions on both actual holdings. Only
          // then fetch the other venue; an empty peer is never a rollback dependency.
          if(other.quantity>previousMatched){
            stage='共同合法余量的盘口刷新';await this.refreshReduction(p,[other]);
            long=this.freshSnapshot(p,p.long);short=this.freshSnapshot(p,p.short);
          }
          const target=long&&short?matchedReductionQuantity(p.long,p.short,long,short):null;
          stage='合法数量与减仓限价';
          if(target!==null&&target>=previousMatched-1e-10){
            reductions=[p.long,p.short].filter(leg=>!sameQuantity(leg.quantity,target)).map(leg=>
              this.buildOrder(p,leg,leg.side==='long'?'sell':'buy',leg.quantity-target,true));
          }else{
            const excess=floorQuantity(Math.min(difference,larger.quantity-previousMatched),book.quantityStep);
            if(!(excess>0)||excess<book.minQuantity){reductionFailure='尾差低于合法减仓数量，未扩大减仓范围';break;}
            reductions=[this.buildOrder(p,larger,larger.side==='long'?'sell':'buy',excess,true)];
          }
        }
        if(!reductions.length)break;
        reductions.forEach(order=>{order.role='entry-tail';order.entryBatch=compensation?.batch;});
        stage='原生数量与仓位槽位核验';
        await this.validateOrders(reductions);
        if(this.pauseBatchEntry(p,'本批撤回提交前原订单待核对，禁止新增减仓')){outcome('unresolved');return false;}
        stage='提交前盘口复核';
        // Finish every local check before either of a two-venue reduction is sent.
        reductions.forEach(order=>this.checkPreparedOrder(p,order));
        stage='订单记录与成交确认';
        const results=await Promise.allSettled(reductions.map(order=>this.submitOrder(p,order)));
        if(this.pauseBatchEntry(p,'本批减尾差订单状态待核对，禁止补发或猜测撤回')){outcome('unresolved');return false;}
        if(results.some(result=>result.status==='rejected')){
          this.blockedEntryRollbacks.add(p.id);reductionFailure='减仓记录或处理已中断，先核对原账本，未继续新增金融动作';break;
        }
        if(results.some(result=>result.status==='fulfilled'&&!canRetryCloseReceipt(result.value))){
          this.blockedEntryRollbacks.add(p.id);reductionFailure='交易所明确拒绝减仓，保留原回执，等待核对后处理';break;
        }
        reductionFailure=sameQuantity(p.long.quantity,p.short.quantity)?undefined:'减仓未完全成交，等待新盘口续处理已确认余量';
      }catch{
        if(this.pauseBatchEntry(p,'本批减尾差订单状态待核对，禁止补发或猜测撤回')){outcome('unresolved');return false;}
        reductionFailure=`入场尾差撤回的${stage}未完成，保留真实余量等待核对`;
        if(this.store.data.orders.length>journalStart){this.blockedEntryRollbacks.add(p.id);break;}
        // A refusal before journalling is not an unknown financial request. Refresh
        // within the existing retry budget instead of leaving a silent one-leg position.
      }
    }
    refreshPnl(p);
    if(this.blockedEntryRollbacks.has(p.id)){
      // Confirmed matched coins remain a fact even though a local write failure
      // prevents granting another financial continuation.
      const matched=sameQuantity(p.long.quantity,p.short.quantity)&&!this.store.data.orders.some(order=>
        order.positionId===p.id&&isCurrentUnconfirmedOrder(order,this.store.data.positions));
      const reduced=this.store.data.orders.slice(compensationJournalStart).some(order=>order.positionId===p.id&&order.request.reduceOnly&&
        order.result?.status!=='unknown'&&(order.result?.filledQuantity??0)>0);
      outcome(matched?(reduced?'rollback':'hedged'):'unresolved');p.status='attention';p.riskReasons=[reductionFailure??'入场成交记录或处理已中断，保留已确认成交并等待账本核对'];
      this.store.save();return false;
    }
    if(sameQuantity(p.long.quantity,p.short.quantity)&&p.long.quantity>=previousMatched-1e-10){
      const reduced=this.store.data.orders.slice(compensationJournalStart).some(order=>order.positionId===p.id&&order.request.reduceOnly&&
        order.result?.status!=='unknown'&&(order.result?.filledQuantity??0)>0);
      outcome(reduced?'rollback':'hedged');return true;
    }
    outcome('unresolved');
    p.status='attention';p.riskReasons=[`本批尾差调整未完成：多 ${p.long.quantity} / 空 ${p.short.quantity}；先前对冲保留`,
      ...(reductionFailure?[reductionFailure]:[])];
    if(reductionFailure)this.store.log('warn',`${p.base} ${reductionFailure}；仅处理本批未匹配敞口`,p.id);
    this.context.halt(`${p.base} 本批尾差待核对，仅暂停该币种新开仓`,p.base);this.store.save();return false;
  }
  private async openBestPriceBatches(p:Position,longQuantity:number,shortQuantity:number,validateEntry:EntryValidation,
    beforeInitialSubmit?:()=>void,onEntryProgress?:(phase:'reconciling')=>void){
    if(this.pauseBatchEntry(p,'现有原订单状态待核对，禁止重新开始分批入场'))return;
    const startedAt=Date.now(),c=this.context.config();
    await this.refresh(p,[p.long,p.short]);
    let latest=await validateEntry();this.checkBatchOpportunity(p,latest);
    if(!latest.eligible)throw new Error('最优对手价首批入场条件未满足，未提交订单');
    longQuantity=latest.longQuantity;shortQuantity=latest.shortQuantity;
    p.executionEvidence??={version:1,method:c.entryExecutionMode??'ioc',entryPath:p.automaticEntry?(automaticEntryAssessment(latest).route??'legacy'):'manual',
      prediction:{fundingUsd:latest.expectedFundingUsd,singleCycleNetUsd:latest.combinedExpectedNetUsd??latest.expectedNetUsd,
        ...(Number.isFinite(latest.entryPriceEdgeBps)?{rawOppositeEdgeBps:latest.entryPriceEdgeBps!}:{})}};
    if(![longQuantity,shortQuantity].every(quantity=>Number.isFinite(quantity)&&quantity>0)||!sameQuantity(longQuantity,shortQuantity)||
      p.long.quantity!==0||p.short.quantity!==0)throw new Error('分批入场目标数量无效或已有未完成成交');
    const target=longQuantity,maxBatches=Number.isInteger(c.maxEntryBatches)&&c.maxEntryBatches!>0?Math.min(c.maxEntryBatches!,32):MAX_BEST_PRICE_ENTRY_BATCHES;
    const retries=c.mode==='live'&&c.maxOrderRetries>0?c.maxOrderRetries+1:0;
    p.plannedExitAt=latest.exitTime;p.transferCostUsd=latest.transferCostUsd;
    p.entryExecution={pricing:'best-opposite',targetQuantity:target,matchedQuantity:0,completedBatches:0};
    let committed=false,stopReason='目标数量已完成';
    for(let batch=0;batch<maxBatches;batch++){
      const previousMatched=Math.min(p.long.quantity,p.short.quantity),remaining=target-previousMatched;
      if(remaining<=1e-10)break;
      if(Date.now()-startedAt>=MAX_ENTRY_EXPANSION_MS){stopReason='扩仓时间已到，保留已匹配数量';break;}
      if(batch>0&&c.mode==='live'&&!this.context.refreshSnapshots){stopReason='缺少新盘口刷新，保留已匹配数量';break;}
      const journalStart=this.store.data.orders.length;
      // Preserve the previous completed hedge floor, not a later unknown-fill lower bound.
      this.openingRollbackFloors.set(p.id,previousMatched);
      let sold=false,batchRequestQuantity=0,batchStop:string|undefined;
      for(let attempt=0;attempt<=retries;attempt++){
        if(attempt>0&&(c.mode==='live'&&!this.context.refreshSnapshots||Date.now()-startedAt>=MAX_ENTRY_EXPANSION_MS))break;
        try{
          if(batch>0||attempt>0)await this.refresh(p,[p.long,p.short]);
          const long=this.freshSnapshot(p,p.long),short=this.freshSnapshot(p,p.short);
          const plan=long&&short&&planBestPriceEntryBatch(long,short,remaining,
            {bufferBps:c.entryIocBufferBps??8,minEdgeBps:minimumEntryIocEdgeBps(c)});
          if(!plan)throw new Error('最优对手价首档不足共同最小下单量或金额');
          const prepared=[this.bestPriceOrder(p,p.long,'buy',plan.quantity,plan.longLimitPrice),this.bestPriceOrder(p,p.short,'sell',plan.quantity,plan.shortLimitPrice)];
          prepared.forEach(order=>{order.entryBatch=batch+1;});
          this.validateAlignedEntry(p,latest,prepared);
          const firstOrder=this.makerFirstOrder(p,prepared[1]);
          await this.validateOrders([prepared[0],firstOrder]);
          // One final scoped check after native parameter validation covers every new batch.
          // Repeating the same account/policy callback before those local checks adds hedge latency.
          const final=await validateEntry(committed?'batch':'initial',{longQuantity:plan.quantity,shortQuantity:plan.quantity});this.checkBatchOpportunity(p,final);
          if(!committed&&(!final.eligible||!sameQuantity(final.longQuantity,target)||!sameQuantity(final.shortQuantity,target)))
            throw new Error('首次提交前入场目标或资格已变化，未提交订单');
          prepared.forEach(order=>this.checkBestPriceOrder(p,order));this.validateAlignedEntry(p,final,prepared);
          this.checkPreparedOrder(p,firstOrder);
          if(Date.now()-startedAt>=MAX_ENTRY_EXPANSION_MS)throw new Error('扩仓时间已到，未提交新批次');
          latest=final;batchRequestQuantity=plan.quantity;
          if(!committed){
            if(p.holdMode==='adaptive')p.profitExitPolicy=profitExitPolicy(prepared[0].snapshot,prepared[1].snapshot,{...c,minCombinedNetUsd:0});
            // No awaited work remains between the one manual commit and the first durable intent.
            beforeInitialSubmit?.();committed=true;
          }
          const receipt=await this.submitOrder(p,firstOrder);
          if(this.pauseBatchEntry(p,'本批空腿订单状态待核对，禁止补发'))return;
          sold=this.batchFilledBasis(p,p.short,journalStart).quantity>0;
          if(sold)break;
          if(firstOrder.request.postOnly){batchStop='Maker 首腿未成交，已确认撤单；未提交多腿，等待下一次新机会';break;}
          batchStop=`${p.short.exchange} 卖出未成交，${p.long.exchange} 未提交本批多腿（最优卖价 IOC）`;
          if(!canRetryZeroEntry(receipt)){batchStop=receipt.rejectionReason??'交易所明确拒绝本批空腿，停止重复尝试';break;}
        }catch(error){
          if(this.pauseBatchEntry(p,'本批空腿状态待核对，禁止重复下单')||error instanceof UncertainOrderError)return;
          sold=this.batchFilledBasis(p,p.short,journalStart).quantity>0;
          if(sold){batchStop=error instanceof Error?error.message:'本批空腿处理异常';break;}
          if(!committed)throw error;
          batchStop=error instanceof Error?error.message:'新批次提交停止';break;
        }
      }
      if(!sold){stopReason=batchStop??'空腿未成交，保留先前对冲';break;}
      try{onEntryProgress?.('reconciling');}catch{/* Progress observers cannot interrupt a confirmed fill. */}
      let stopGrowth=!!batchStop;
      for(let attempt=0;attempt<=retries;attempt++){
        const shortFill=this.batchFilledBasis(p,p.short,journalStart),longFill=this.batchFilledBasis(p,p.long,journalStart);
        if(sameQuantity(shortFill.quantity,longFill.quantity))break;
        if(attempt>0&&c.mode==='live'&&!this.context.refreshSnapshots){batchStop='缺少新盘口刷新，停止补腿';stopGrowth=true;break;}
        try{
          await this.refresh(p,[p.long,p.short]);
          const long=this.freshSnapshot(p,p.long),short=this.freshSnapshot(p,p.short),top=long&&bestOppositeLevel(long,'buy');
          if(!long||!short||!top)throw new Error('本批补多缺少最新最优买价');
          const missing=shortFill.quantity-longFill.quantity;
          const quantity=floorQuantity(Math.min(missing,top.quantity),long.quantityStep);
          if(quantity<=0||quantity<long.minQuantity){
            batchStop='本批尾差低于多腿合法下单量，仅减多余空腿';
            if(floorQuantity(missing,long.quantityStep)>0)stopGrowth=true;
            break;
          }
          const plan=planBufferedLongEntry(long,short,quantity,shortFill.averagePrice,
            {bufferBps:c.entryIocBufferBps??8,minEdgeBps:minimumEntryIocEdgeBps(this.entryConfig(p))});
          if(!plan)throw new Error(!Number.isFinite(shortFill.averagePrice)||shortFill.averagePrice<=0?
            '本批补多缺少有效的已确认空腿成交均价':quantity*top.price<long.minNotional?
            '本批补多尾差名义金额低于多腿最小开仓金额，停止补开并按原规则核对尾差':
            '本批补多盘口数量或合约规则未满足，停止补开并保留已确认空腿成交均价');
          const prepared=this.bestPriceOrder(p,p.long,'buy',plan.quantity,plan.limitPrice);
          prepared.entryBatch=batch+1;
          await this.validateOrders([prepared]);
          const opportunity=await validateEntry('supplement',{longQuantity:prepared.request.quantity,shortQuantity:0});
          this.checkBestPriceOrder(p,prepared);this.checkBatchLong(p,opportunity,prepared,journalStart);
          const receipt=await this.submitOrder(p,prepared);
          if(this.pauseBatchEntry(p,'本批多腿订单状态待核对，禁止补发或猜测撤回'))return;
          if(receipt.filledQuantity===0&&!canRetryZeroEntry(receipt)){
            batchStop=receipt.rejectionReason??'交易所明确拒绝本批多腿，停止重复尝试';stopGrowth=true;break;
          }
        }catch(error){
          if(this.pauseBatchEntry(p,'本批多腿状态待核对，禁止补发或猜测撤回')||error instanceof UncertainOrderError)return;
          batchStop=error instanceof Error?error.message:'本批补多条件失败';stopGrowth=true;break;
        }
      }
      const beforeTrimShort=this.batchFilledBasis(p,p.short,journalStart),beforeTrimLong=this.batchFilledBasis(p,p.long,journalStart);
      if(!sameQuantity(beforeTrimShort.quantity,beforeTrimLong.quantity)&&!batchStop){batchStop='本批补多次数已到，仅减未匹配尾差';stopGrowth=true;}
      if(!await this.trimBatchTail(p,previousMatched,{journalStart,batch:batch+1,opportunity:latest,validateEntry})){p.entryExecution.stopReason=batchStop??'本批尾差未确认';return;}
      const matched=Math.min(p.long.quantity,p.short.quantity);
      p.entryExecution.matchedQuantity=matched;
      if(matched>previousMatched+1e-10)p.entryExecution.completedBatches++;
      this.store.save();
      if(matched>previousMatched+1e-10)this.trace(p,'matched',batch+1);
      if(!(matched>previousMatched+1e-10)){stopReason=batchStop??'本批未形成新对冲，保留先前对冲';break;}
      if(stopGrowth){stopReason=batchStop??'本批入场优势已消失，保留已匹配数量';break;}
      if(batch===maxBatches-1&&matched<target-1e-10)stopReason='分批次数已到，保留已匹配数量';
      if(batchRequestQuantity<=0)break;
    }
    refreshPnl(p);p.entryExecution.matchedQuantity=Math.min(p.long.quantity,p.short.quantity);p.entryExecution.stopReason=stopReason;
    if(this.pauseBatchEntry(p,'分批入场订单尚未确认，禁止宣告完整对冲'))return;
    if(!sameQuantity(p.long.quantity,p.short.quantity)){
      p.status='attention';p.riskReasons=['分批入场存在未匹配尾差，先前对冲保留'];this.context.halt(`${p.base} 尾差待核对，仅暂停该币种`,p.base);
    }else if(p.long.quantity>0){p.status='open';p.riskReasons=[];}
    else {p.status='closed';p.closedAt=Date.now();p.closeReason=stopReason;p.riskReasons=[];}
    this.store.log(p.status==='open'?'info':'warn',`${p.base} 最优对手价分批入场结束：已配平入场数量 ${p.entryExecution.matchedQuantity}，原计划 ${target}；${stopReason}`,p.id);
    this.store.save();
  }
  async open(p:Position,longQuantity:number,shortQuantity:number,validateEntry?:EntryValidation,beforeInitialSubmit?:()=>void,onEntryProgress?:(phase:'reconciling')=>void){
    this.beginOperation(p,'entry',p.executionEvidence?.method??'ioc',{long:longQuantity,short:shortQuantity});
    const journalStart=this.store.data.orders.length;
    try{
    if(this.pauseInterruptedExecution(p))return;
    if(this.blockedEntryRollbacks.has(p.id)){p.status='attention';p.riskReasons=['本次入场尾差执行已暂停，先核对原订单及账户'];this.store.save();return;}
    if(this.pauseUnconfirmedEntry(p,'存在未确认订单，请先核对原订单，禁止重复开仓'))return;
    if(p.automaticEntry&&p.entryPolicy!=='aligned')throw new Error('自动开仓需要可核验的对手价1共同批次，未提交订单');
    if((p.executionEvidence?.method??this.context.config().entryExecutionMode)==='maker-ioc'&&p.entryPolicy!=='aligned')
      throw new Error('Maker 首腿试运行仅支持资金费与价格同向的分批入场，未提交订单');
    if(p.entryPolicy==='aligned'){
      if(!validateEntry)throw new Error('价格与资金费入场缺少最终收益复核，未提交订单');
      return await this.openBestPriceBatches(p,longQuantity,shortQuantity,validateEntry,beforeInitialSubmit,onEntryProgress);
    }
    return await this.openLegacy(p,longQuantity,shortQuantity,validateEntry,beforeInitialSubmit,onEntryProgress);
    }catch(error){
      this.operation(p,id=>{
        if(!this.store.data.orders.slice(journalStart).some(order=>order.positionId===p.id)){
          this.store.operations.attemptNotSent(id,'entry-preparation-failed','入场准备未通过，本轮未调用下单适配器');
          this.store.operations.end(id,'failed',{code:'entry-preparation-failed',text:'入场准备未通过，未产生本次订单'});
        }
      });
      if(!(error instanceof UncertainOrderError)){
        this.blockedEntryRollbacks.add(p.id);
        if(this.store.data.orders.slice(journalStart).some(order=>order.positionId===p.id)){
          this.interruptedOrderProcessing.add(p.id);this.pauseInterruptedExecution(p);
        }
      }
      throw error;
    }finally{
      if(p.mode==='live'&&p.entryPolicy==='aligned'&&p.entryExecution&&p.status==='attention'&&
        p.closeRequestedAt===undefined&&!p.manualCloseOnly&&!this.blockedEntryRollbacks.has(p.id)&&
        this.store.data.orders.some(order=>order.positionId===p.id&&!order.request.reduceOnly)){
        const previousMatched=this.openingRollbackFloors.get(p.id);
        if(previousMatched!==undefined){
          const intents=this.store.data.orders.filter(order=>order.positionId===p.id).map(journal=>({journal,
            signature:JSON.stringify([journal.positionId,journal.exchange,journal.request,journal.createdAt])}));
          this.pendingEntryRollbacks.set(p.id,{position:p,previousMatched,lastAttemptAt:Date.now(),intents});
        }
      }
      this.openingRollbackFloors.delete(p.id);
      this.trace(p,'finished');
      this.operationObserved(p);
      this.operation(p,id=>{
        const current=this.store.operations.current(p.id);
        if(!current||current.attempts.unknown||current.attempts.pending||current.stages.pairedAt!==undefined)return;
        if(this.pendingEntryRollbacks.has(p.id))this.store.operations.wait(id,'entry-recovery','入场尾差仍在核对与回撤，本次操作尚未结束');
        else this.store.operations.end(id,(current.confirmed.long??0)>0||(current.confirmed.short??0)>0?'partial':current.attempts.submitted?'failed':'cancelled',
          {code:'entry-processing-ended',text:'本轮入场处理已结束，未达到完整目标'});
      });
    }
  }
  private async openLegacy(p:Position,longQuantity:number,shortQuantity:number,validateEntry?:EntryValidation,beforeInitialSubmit?:()=>void,onEntryProgress?:(phase:'reconciling')=>void){
    await this.refresh(p,[p.long,p.short]);
    if(p.entryPolicy==='aligned'&&!validateEntry)throw new Error('价格与资金费入场缺少最终收益复核，未提交订单');
    if(p.entryPolicy==='funding'&&!validateEntry)throw new Error('资金费入场缺少最终收益复核，未提交订单');
    if(this.context.config().dualAdvantageEnabled&&!validateEntry)throw new Error('双优势入场缺少最终收益复核，未提交订单');
    let latest:Opportunity|undefined;
    if(validateEntry){
      latest=await validateEntry();this.validateEntryPolicy(p,latest);
      if(!latest.eligible||latest.base!==p.base||latest.longExchange!==p.long.exchange||latest.shortExchange!==p.short.exchange)throw new Error('最终入场方向或收益资格无效');
      longQuantity=latest.longQuantity;shortQuantity=latest.shortQuantity;p.plannedExitAt=latest.exitTime;p.transferCostUsd=latest.transferCostUsd;
    }
    const prepared=[this.buildOrder(p,p.long,'buy',longQuantity,false),this.buildOrder(p,p.short,'sell',shortQuantity,false)];
    if(p.entryPolicy==='aligned')this.validateAlignedEntry(p,latest!,prepared);
    if(p.entryPolicy==='funding')this.validateFundingEntryProfit(p,latest!,prepared);
    await this.validateOrders(prepared);
    if(validateEntry){
      const final=await validateEntry();this.validateEntryPolicy(p,final);
      if(!final.eligible||final.base!==p.base||final.longExchange!==p.long.exchange||final.shortExchange!==p.short.exchange||
        final.longQuantity!==longQuantity||final.shortQuantity!==shortQuantity)
        throw new Error('提交前行情、数量或入场条件已变化，未提交订单');
      prepared.forEach(order=>this.checkPreparedOrder(p,order));
      if(p.entryPolicy==='funding')this.validateFundingEntryProfit(p,final,prepared);
      if(p.entryPolicy==='aligned')this.validateAlignedEntry(p,final,prepared);
      if((p.entryPolicy==='aligned'||this.context.config().dualAdvantageEnabled)&&p.holdMode==='adaptive'){
        const policyConfig=p.entryPolicy==='aligned'?{...this.context.config(),minCombinedNetUsd:0}:this.context.config();
        p.profitExitPolicy=profitExitPolicy(prepared[0].snapshot,prepared[1].snapshot,policyConfig);
      }
    }
    // The manual-operation lease commits at this final synchronous boundary, before either durable intent.
    beforeInitialSubmit?.();
    const longPrepared=prepared.find(order=>order.leg===p.long)!,shortPrepared=prepared.find(order=>order.leg===p.short)!;
    // The short bid is the entry edge. Submit it alone first. A zero fill never sends the long,
    // so a missing Bybit bid cannot leave a filled long that has to be sold back at a loss.
    try{await this.submitOrder(p,shortPrepared);}catch(e){
      if(e instanceof UncertainOrderError)return;
      if(this.pauseUnconfirmedEntry(p,'空腿提交状态待核对，禁止重复下单'))return;
      if(p.short.quantity>0){await this.close(p,'空腿提交处理中断，撤回已确认的单腿敞口');return;}
      throw e;
    }
    try{onEntryProgress?.('reconciling');}catch{ /* UI progress must never interrupt confirmed-order handling. */ }
    const c=this.context.config();
    // A zero short can be retried from a fresh book. The long stays unsent until one of those sells fills.
    const shortRetries=c.mode==='live'&&c.maxOrderRetries>0?c.maxOrderRetries+(p.entryPolicy==='aligned'?1:0):0;
    for(let retry=0;retry<shortRetries&&p.short.quantity<=0;retry++){
      if(!this.context.refreshSnapshots)break;
      try{
        await this.refresh(p,[p.long,p.short]);
        let latest:Opportunity|undefined;
        if(validateEntry){
          latest=await validateEntry();
          this.validateEntryPolicy(p,latest);
          if(!latest.eligible||latest.base!==p.base||latest.longExchange!==p.long.exchange||latest.shortExchange!==p.short.exchange||
            latest.longQuantity!==longQuantity||latest.shortQuantity!==shortQuantity)
            throw new Error('空腿重试前入场条件已变化');
        }
        const again=this.buildOrder(p,p.short,'sell',shortQuantity,false);
        if(latest&&p.entryPolicy==='aligned')this.validateAlignedEntry(p,latest,[this.buildOrder(p,p.long,'buy',longQuantity,false),again]);
        if(latest&&p.entryPolicy==='funding')this.validateFundingEntryProfit(p,latest,[this.buildOrder(p,p.long,'buy',longQuantity,false),again]);
        await this.validateOrders([again]);
        // Private parameter checks can await network I/O. Recheck both books and economics afterwards.
        this.checkPreparedOrder(p,again);
        if(validateEntry){
          const final=await validateEntry();this.validateEntryPolicy(p,final);
          if(!final.eligible||final.base!==p.base||final.longExchange!==p.long.exchange||final.shortExchange!==p.short.exchange||
            final.longQuantity!==longQuantity||final.shortQuantity!==shortQuantity)
            throw new Error('空腿重试提交前入场条件已变化');
          const both=[this.buildOrder(p,p.long,'buy',longQuantity,false),again];
          if(p.entryPolicy==='aligned')this.validateAlignedEntry(p,final,both);
          if(p.entryPolicy==='funding')this.validateFundingEntryProfit(p,final,both);
        }
        this.checkPreparedOrder(p,again);
        await this.submitOrder(p,again);
      }catch(e){
        if(e instanceof UncertainOrderError)return;
        if(this.pauseUnconfirmedEntry(p,'空腿重试状态待核对，禁止补发或猜测未成交'))return;
        break;
      }
    }
    if(shortSoldNothing(p)){
      this.store.log('warn',`${p.base} ${p.short.exchange} 卖出未成交，${p.long.exchange} 未提交`,p.id);
      this.abandonUnopened(p,`${p.short.exchange} 卖出未成交，${p.long.exchange} 未提交`);
      return;
    }
    let longEntry:PreparedOrder;
    try{
      if(c.mode==='live')await this.refresh(p,[p.long,p.short]);
      longEntry=this.sizedLongEntry(p,longPrepared);
      await this.validateOrders([longEntry]);
      if(validateEntry){
        const latest=await validateEntry('supplement');
        if(latest.base!==p.base||latest.longExchange!==p.long.exchange||latest.shortExchange!==p.short.exchange||
          latest.longQuantity!==longQuantity||latest.shortQuantity!==shortQuantity)
          throw new Error('多腿提交前合约方向或目标数量已变化');
        if(p.entryPolicy==='aligned'||p.entryPolicy==='funding'||c.dualAdvantageEnabled)
          this.validateMissingLegProfit(p,latest,longEntry.request);
      }
      this.checkPreparedOrder(p,longEntry);
    }catch(e){
      if(e instanceof UncertainOrderError)return;
      this.store.log('warn',`${p.base} 多腿未按空腿成交数量提交：${e instanceof Error?e.message:''}`,p.id);
      await this.close(p,'多腿无法按空腿成交数量下单，撤回已确认的空腿');
      return;
    }
    try{await this.submitOrder(p,longEntry);}catch(e){
      if(e instanceof UncertainOrderError)return;
      this.store.log('warn',`${p.base} 多腿提交中断：${e instanceof Error?e.message:''}`,p.id);
      if(this.pauseUnconfirmedEntry(p,'多腿提交状态待核对，禁止补发或撤回尚未确认的订单'))return;
      if(p.long.quantity<=0){await this.close(p,'多腿提交中断，撤回已确认的空腿');return;}
    }
    // Confirmed IOC residuals are cancelled by the venue. Only confirmed shortfalls may be supplemented.
    const supplementAttempts=c.maxOrderRetries>0?c.maxOrderRetries+(p.entryPolicy==='aligned'?1:0):0;
    if(c.mode==='live')for(let retry=0;retry<supplementAttempts;retry++){
      if(!this.context.refreshSnapshots)break;
      const lr=p.long.quantity/longQuantity,sr=p.short.quantity/shortQuantity;
      if(Math.abs(lr-sr)<1e-8)break;
      const leg=lr<sr?p.long:p.short,target=lr<sr?longQuantity*sr:shortQuantity*lr;
      try{
        const validateAdditionalEntry=(p.entryPolicy==='aligned'||p.entryPolicy==='funding'||c.dualAdvantageEnabled)&&validateEntry?async(request?:OrderRequest)=>{
          const latest=await validateEntry('supplement');
          if(latest.base!==p.base||latest.longExchange!==p.long.exchange||latest.shortExchange!==p.short.exchange||latest.longQuantity!==longQuantity||latest.shortQuantity!==shortQuantity)throw new Error('补单前合约方向或目标数量已变化，回撤未配对敞口');
          this.validateMissingLegProfit(p,latest,request??this.buildOrder(p,leg,leg.side==='long'?'buy':'sell',target-leg.quantity,false).request);
        }:undefined;
        await this.refresh(p,validateAdditionalEntry?[p.long,p.short]:[leg]);
        await this.order(p,leg,leg.side==='long'?'buy':'sell',target-leg.quantity,false,validateAdditionalEntry);
      }catch(e){
        if(e instanceof UncertainOrderError)return;
        if(this.pauseUnconfirmedEntry(p,'补腿提交状态待核对，禁止补发或猜测撤回'))return;
        this.store.log('warn',`${p.base} 补腿条件未通过，停止扩大仓位，改为保留可匹配的已成交数量`,p.id);break;
      }
    }
    // With no confirmed opposite leg, unwind only that known naked exposure.
    if(p.long.quantity===0||p.short.quantity===0){await this.close(p,'另一腿未成交，撤回已确认的单腿敞口');return;}
    // Failed supplementation does not invalidate the hedge already filled. Trim to the largest
    // exactly reachable quantity on BOTH venues instead of rounding one leg then closing the pair.
    for(let retry=0;!sameQuantity(p.long.quantity,p.short.quantity)&&retry<=c.maxOrderRetries;retry++){
      if(retry>0&&c.mode==='live'&&!this.context.refreshSnapshots)break;
      try{
        await this.refresh(p,[p.long,p.short]);
        const longBook=this.freshSnapshot(p,p.long),shortBook=this.freshSnapshot(p,p.short);
        if(!longBook||!shortBook)break;
        const target=matchedReductionQuantity(p.long,p.short,longBook,shortBook);
        let reductions:PreparedOrder[];
        if(target!==null&&target>0){
          const smaller=Math.min(p.long.quantity,p.short.quantity);
          if(!sameQuantity(target,smaller))this.store.log('info',`${p.base} 较小腿已成交 ${smaller}；两所减仓步长 ${p.long.exchange} ${longBook.quantityStep} / ${p.short.exchange} ${shortBook.quantityStep}、最小量 ${longBook.minQuantity} / ${shortBook.minQuantity} 不允许精确保留该数量，最大合法共同持仓为 ${target}，分别仅减多余数量`,p.id);
          reductions=([p.long,p.short] as PositionLeg[]).filter(leg=>!sameQuantity(leg.quantity,target)).map(leg=>
            this.buildOrder(p,leg,leg.side==='long'?'sell':'buy',leg.quantity-target,true));
        }else{
          // Incompatible fill residues or an undersized hedge: remove only executable excess,
          // preserving the opposing fills. Untradeable dust remains visible for reconciliation.
          const larger=p.long.quantity>p.short.quantity?p.long:p.short,book=larger===p.long?longBook:shortBook;
          const excess=floorQuantity(Math.abs(p.long.quantity-p.short.quantity),book.quantityStep);
          if(excess<book.minQuantity||excess<=0)break;
          reductions=[this.buildOrder(p,larger,larger.side==='long'?'sell':'buy',excess,true)];
        }
        if(!reductions.length)break;
        await this.validateOrders(reductions);
        const reduced=await Promise.allSettled(reductions.map(order=>this.submitOrder(p,order)));
        if(reduced.some(result=>result.status==='rejected'&&result.reason instanceof UncertainOrderError))return;
        if(reduced.some(result=>result.status==='rejected'))break;
      }catch(e){if(e instanceof UncertainOrderError)return;break;}
    }
    refreshPnl(p);
    if(this.pauseUnconfirmedEntry(p,'开仓调整订单状态待核对，禁止将未确认成交下界视为完整对冲'))return;
    if(!sameQuantity(p.long.quantity,p.short.quantity)){
      p.status='attention';p.riskReasons=[`开仓数量调整未完成：多腿 ${p.long.quantity} / 空腿 ${p.short.quantity}；保留已成交对冲，待核对剩余敞口`];
      this.store.log('warn',`${p.base} 已成交对冲未整体平仓；数量调整未完成，多 ${p.long.quantity} / 空 ${p.short.quantity}`,p.id);
      this.context.halt(`${p.base} 数量调整未完成，仅暂停该币种新开仓，保留已确认仓位待核对`,p.base);
      this.store.save();return;
    }
    if(p.long.quantity<longQuantity||p.short.quantity<shortQuantity)this.store.log('info',`${p.base} 保留已匹配部分仓位：双腿各 ${p.long.quantity}，未整体撤回`,p.id);
    p.status='open';this.store.save();this.trace(p,'matched');
  }
  private closeReductionScope(leg:PositionLeg,quantity:number):ReductionScope|undefined {
    const scope=this.context.prepareReduction?.(leg,quantity);
    if(scope&&(!Number.isFinite(scope.quantity)||scope.quantity<=0||scope.quantity>quantity))
      throw new Error('所选分仓可减数量无效或超过已确认范围');
    return scope;
  }
  hasIocProfitClose(p:Position):boolean{return this.iocProfitWorkers.has(p.id);}
  iocProfitCloseRetryAfter(p:Position):number {
    const wait=this.iocProfitReadWaits.get(p.id);
    return wait?.position===p&&wait.config===this.context.config()&&wait.requestedAt===p.closeRequestedAt?wait.retryAfter:0;
  }
  private async waitIocPreflight(p:Position,phase:IocProfitPhase,error:unknown):Promise<void> {
    // This helper handles pre-intent preparation only. Adapter connect/getaddrinfo
    // syscalls are read failures; real intent/cash writes keep their explicit stop paths.
    const fileFailure=error as NodeJS.ErrnoException;
    if(['write','writev','open','mkdir','rename','fsync','fdatasync'].includes(fileFailure?.syscall??'')&&
      ['EIO','ENOSPC','EROFS','EACCES','EPERM','EMFILE','ENFILE'].includes(fileFailure?.code??''))throw error;
    const venue=error instanceof ExchangeNetworkError?error.exchange:undefined;
    const diagnostic=error instanceof TradingError?error:tradingError(venue??p.long.exchange,'合约检查',error);
    const reason=selectedPublicBookReason(error)??preparedBookChangedReason(error)??(!venue&&!(error instanceof TradingError)&&diagnostic.message.includes('未能确认执行条件')?
      '未能确认执行条件，请检查所选交易所账户、合约设置和接口状态':diagnostic.message),
      message=`${p.base} 对手价1 IOC ${iocProfitPhaseText[phase]}未通过：${reason}；本轮未创建委托，等待重新核验`;
    await this.context.serialize!(async()=>{
      if(!this.store.data.positions.includes(p)||this.store.data.killSwitch||this.interruptedOrderProcessing.has(p.id))return;
      const prior=this.iocProfitReadWaits.get(p.id),now=Date.now(),config=this.context.config();this.iocProfitPhases.set(p.id,'preflight-wait-save');
      p.riskReasons=[message];this.store.save();
      this.operation(p,id=>this.store.operations.attemptNotSent(id,`ioc-preflight-${phase}`,message));
      const loggedByMessage=prior?.position===p&&prior.config===config&&prior.requestedAt===p.closeRequestedAt?prior.loggedByMessage:new Map<string,number>();
      this.iocProfitReadWaits.set(p.id,{position:p,config,requestedAt:p.closeRequestedAt,
        retryAfter:now+(this.hasPendingIocProfitTail(p)?500:1500),message,
        loggedByMessage});
      const loggedAt=loggedByMessage.get(message);
      if(loggedAt===undefined||now<loggedAt||now-loggedAt>=15000){
        this.store.log('warn',message,p.id);
        if(!loggedByMessage.has(message)&&loggedByMessage.size>=16)loggedByMessage.delete(loggedByMessage.keys().next().value!);
        loggedByMessage.set(message,now);
      }
    });
  }
  /** Unsent owned intents have no paid cash; unrelated unknowns keep their original fee uncertainty. */
  iocProfitExitEconomics(p:Position):Position {
    const batch=this.iocProfitBatches.get(p.id);
    const sameCash=batch&&JSON.stringify([p.fundingUsd,p.feesUsd,p.realizedSpreadPnlUsd,p.transferCostUsd,
      [p.long,p.short].map(leg=>[leg.exchange,leg.symbol,leg.side,leg.quantity,leg.entryPrice,leg.feesUsd])])===
      JSON.stringify([batch.position.fundingUsd,batch.position.feesUsd,batch.position.realizedSpreadPnlUsd,batch.position.transferCostUsd,
        [batch.position.long,batch.position.short].map(leg=>[leg.exchange,leg.symbol,leg.side,leg.quantity,leg.entryPrice,leg.feesUsd])]);
    const ignored=batch&&sameCash&&!batch.invalid&&this.iocProfitScope(batch.position)===batch.expected?batch.orders.filter(order=>
      this.ownsActiveIocProfitIntent(batch.position,order)||order.result?.filledQuantity===0&&order.result.feeUsd===0&&
        isTerminalOrderReceipt(order.request,order.result)):[];
    return this.economicsPosition(p,ignored);
  }
  /** Only this worker's exact durable, still unsent pair may share one native proof. */
  ownsActiveIocProfitIntent(p:Position,order:JournalOrder):boolean {
    const batch=this.iocProfitBatches.get(p.id),index=batch?.orders.indexOf(order)??-1;
    return !!batch&&batch.position===p&&!batch.invalid&&this.hasIocProfitClose(p)&&index>=0&&
      this.store.data.orders.includes(order)&&order.result===undefined&&batch.requests[index]===JSON.stringify(order.request)&&
      order.request.reduceOnly===true&&order.request.postOnly!==true&&order.executionEvidence?.method==='ioc';
  }
  private iocProfitScope(p:Position):string {
    return JSON.stringify([this.nativeExitIdentity(p),p.status,p.closeRequestedAt,p.closeProfitRequired,p.closePricing,p.closeReason,
      p.fundingUsd,p.fundingEvents,p.feesUsd,p.realizedSpreadPnlUsd,p.transferCostUsd,p.profitExitPolicy,p.accountClosure,p.manualCloseAccountRecord,
      [p.long,p.short].map(leg=>[leg.quantity,leg.entryPrice,leg.feesUsd,leg.realizedPnlUsd,leg.fundingUsd]),
      this.exitJournalProof(p,this.store.data.orders.filter(order=>order.positionId===p.id||
        [p.long,p.short].some(leg=>leg.exchange===order.exchange&&leg.symbol===order.request.symbol)))]);
  }
  /** Timing observations and independently booked funding never consume confirmed IOC fill quantity. */
  private iocProfitTailOrderProof(order:JournalOrder):string {
    const {execution,originalConfirmation,reconciliationEvidence,result,...identity}=order;
    const {orderReadAt,confirmation,...cash}=result??{};
    const {observedAt:originalObservedAt,...originalDiagnostic}=originalConfirmation??{};
    const {observedAt,...diagnostic}=confirmation??{};
    return JSON.stringify({...identity,...(originalConfirmation?{originalConfirmation:originalDiagnostic}:{}),
      ...(reconciliationEvidence?{reconciliationEvidence:reconciliationEvidence.map(({observedAt,result,...row})=>{
        const {orderReadAt,confirmation,...receipt}=result,{observedAt:receiptObservedAt,...detail}=confirmation??{};
        return {...row,result:{...receipt,...(confirmation?{confirmation:detail}:{})}};
      })}:{}),
      ...(result?{result:{...cash,...(confirmation?{confirmation:diagnostic}:{})}}:{})});
  }
  private iocProfitTailScope(p:Position):string {
    return JSON.stringify([this.nativeExitIdentity(p),p.status,p.closeRequestedAt,p.closeProfitRequired,p.closePricing,p.closeReason,
      p.feesUsd,p.realizedSpreadPnlUsd,p.transferCostUsd,p.profitExitPolicy,p.accountClosure,p.manualCloseAccountRecord,
      [p.long,p.short].map(leg=>[leg.quantity,leg.entryPrice,leg.feesUsd,leg.realizedPnlUsd]),
      this.store.data.orders.filter(order=>order.positionId===p.id||
        [p.long,p.short].some(leg=>leg.exchange===order.exchange&&leg.symbol===order.request.symbol)).map(order=>
        this.isNativeExitAuditOrder(p,order)?this.nativeExitOrderProof(order):this.iocProfitTailOrderProof(order))]);
  }
  private iocBlockingScopeOrder(p:Position,order:JournalOrder):boolean {
    return this.blockingExitOrder(p,order)&&!this.ownsActiveIocProfitIntent(p,order)&&
      (order.positionId===p.id||!unresolvedCoin(order,this.store.data.positions)||unresolvedCoin(order,this.store.data.positions)===coinBase(p.base)||
        [p.long,p.short].some(leg=>leg.exchange===order.exchange&&leg.symbol===order.request.symbol));
  }
  private async verifyIocProfitAccounts(p:Position):Promise<boolean> {
    if(this.nativeExitAuthorities.has(p.id)||this.historicalNativeExitAudit(p))return this.verifyNativeExitBeforeSubmit(p);
    const proof=this.iocProfitScope(p),started=Date.now(),readContext={deadlineAt:started+8000};let timer:ReturnType<typeof setTimeout>|undefined;
    const isFileFailure=(result:PromiseSettledResult<unknown>):result is PromiseRejectedResult=>{
      if(result.status!=='rejected')return false;
      const failure=result.reason as NodeJS.ErrnoException;
      return ['write','writev','open','mkdir','rename','fsync','fdatasync'].includes(failure?.syscall??'')&&
        ['EIO','ENOSPC','EROFS','EACCES','EPERM','EMFILE','ENFILE'].includes(failure?.code??'');
    };
    // Keep ownership of every original GET until both legs really finish. An early
    // refusal or logical deadline must not let the same coin start overlapping reads.
    const reads=Promise.allSettled([p.long,p.short].map(async leg=>{
        const adapter=this.context.adapter(leg.exchange);if(!adapter.fetchOpenOrders)throw new Error('缺少完整原生挂单核验');
        let account:Awaited<ReturnType<ExchangeAdapter['fetchAccount']>>,open:Awaited<ReturnType<NonNullable<ExchangeAdapter['fetchOpenOrders']>>>;
        try{
          const results=await Promise.allSettled([
            Promise.resolve().then(()=>adapter.fetchAccount(readContext)),Promise.resolve().then(()=>adapter.fetchOpenOrders!(leg.symbol,readContext))]);
          const failure=results.find(isFileFailure)??results.find(result=>result.status==='rejected');
          if(failure?.status==='rejected')throw failure.reason;
          account=(results[0] as PromiseFulfilledResult<typeof account>).value;
          open=(results[1] as PromiseFulfilledResult<typeof open>).value;
        }
        catch(error){
          const fileFailure=error as NodeJS.ErrnoException;
          if(['write','writev','open','mkdir','rename','fsync','fdatasync'].includes(fileFailure?.syscall??'')&&
            ['EIO','ENOSPC','EROFS','EACCES','EPERM','EMFILE','ENFILE'].includes(fileFailure?.code??''))throw error;
          throw error instanceof TradingError?error:tradingError(leg.exchange,'账户检查',error);
        }
        return {leg,account,open};
      }));
    try{
      const results=await Promise.race([reads,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('IOC 双腿原生核验超时')),8000);})]);
      const failure=results.find(isFileFailure)??results.find(result=>result.status==='rejected');
      if(failure?.status==='rejected')throw failure.reason;
      const rows=results.map(result=>(result as PromiseFulfilledResult<{leg:PositionLeg;account:Awaited<ReturnType<ExchangeAdapter['fetchAccount']>>;
        open:Awaited<ReturnType<NonNullable<ExchangeAdapter['fetchOpenOrders']>>>}>).value);
      if(Date.now()<started||Date.now()-started>8000||this.iocProfitScope(p)!==proof)return false;
      return rows.every(({leg,account,open})=>{
        if(!Array.isArray(open)||open.length)return false;
        const actual=account.positions.filter(row=>row.symbol===leg.symbol&&row.quantity>0);
        return leg.quantity===0?actual.length===0:actual.length===1&&actual[0].side===leg.side&&
          !(actual[0].splitPositionCount&&actual[0].splitPositionCount!==1)&&Number.isFinite(actual[0].quantity)&&
          sameQuantity(actual[0].quantity,leg.quantity);
      });
    }finally{
      if(timer)clearTimeout(timer);
      const settled=await reads;
      const failure=settled.find(isFileFailure);
      if(failure)throw failure.reason;
    }
  }
  hasPendingIocProfitTail(p:Position):boolean {
    const tail=this.pendingIocProfitTails.get(p.id);
    return !!tail&&tail.position===p&&tail.config===this.context.config()&&tail.requestedAt===p.closeRequestedAt&&
      tail.configProof===JSON.stringify(this.context.config())&&
      tail.legs[0]===p.long&&tail.legs[1]===p.short&&tail.leg===(p.long.quantity>p.short.quantity?p.long:p.short)&&
      Number.isFinite(tail.remainingBudget)&&tail.remainingBudget>0&&
      sameQuantity(tail.remainingBudget,Math.abs(quantitySubtract(p.long.quantity,p.short.quantity)))&&
      tail.orders.length>0&&tail.orders.every(({order,proof})=>this.store.data.orders.includes(order)&&
        this.store.data.orders.filter(value=>value.request.clientOrderId===order.request.clientOrderId).length===1&&
        order.positionId===p.id&&[p.long,p.short].some(leg=>order.exchange===leg.exchange&&order.request.base===p.base&&
          order.request.symbol===leg.symbol&&order.request.side===(leg.side==='long'?'sell':'buy'))&&
        order.request.reduceOnly===true&&order.request.postOnly!==true&&order.executionEvidence?.method==='ioc'&&
        !!order.result&&isTerminalOrderReceipt(order.request,order.result)&&Number.isFinite(order.result.feeUsd)&&
        order.executionEvidence.bookedFeeUsd===order.result.feeUsd&&proof===this.iocProfitTailOrderProof(order))&&
      sameQuantity(tail.remainingBudget,quantitySubtract(
        tail.orders.filter(({order})=>order.exchange===(tail.leg===p.long?p.short:p.long).exchange)
          .reduce((sum,{order})=>quantityAdd(sum,order.result!.filledQuantity),0),
        tail.orders.filter(({order})=>order.exchange===tail.leg.exchange)
          .reduce((sum,{order})=>quantityAdd(sum,order.result!.filledQuantity),0)))&&
      p.status==='closing'&&!sameQuantity(p.long.quantity,p.short.quantity)&&!this.interruptedOrderProcessing.has(p.id)&&
      tail.proof===this.iocProfitTailScope(p)&&!this.store.data.orders.some(order=>order.positionId===p.id&&this.blockingExitOrder(p,order));
  }
  /** Explicit current-session native recovery only; saved audits are never adopted at startup. */
  installVerifiedIocTail(p:Position,audit:NativeExitRecoveryAudit):void {
    const config=this.context.config(),plan=planConfirmedIocTail(p,this.store.data.orders,audit.confirmedIocBatchId??'');
    const now=Date.now(),fresh=(at:number)=>Number.isFinite(at)&&at<=now&&now-at<=8000,
      accountsValid=[p.long,p.short].every(leg=>{
        const rows=audit.nativeReadEvidence.filter(row=>row.exchange===leg.exchange&&row.symbol===leg.symbol&&row.side===leg.side),
          empty=audit.noOpenOrders.filter(row=>row.exchange===leg.exchange&&row.symbol===leg.symbol);
        return rows.length===2&&rows.every(row=>row.quantity===leg.quantity&&fresh(row.requestedAt))&&
          JSON.stringify({...rows[0],requestedAt:0})===JSON.stringify({...rows[1],requestedAt:0})&&
          empty.length===1&&fresh(empty[0].checkedAt);
      });
    if(!this.hasNativeExitAuthority(p)||!this.nativeExitSubmissionAllowed(p)||
      this.nativeExitAuthorities.get(p.id)?.audit!==audit||!accountsValid||
      !p.nativeExitRecoveryAudit?.includes(audit)||audit.revokedAt!==undefined||audit.originalRemainingBudget!==0||
      audit.confirmedTailParentClientOrderId!==undefined||audit.confirmedIocRemainingBudget!==plan.quantity||
      config.mode!=='live'||config.profitExitExecutionMode!=='ioc'||p.status!=='closing'||
      !this.canResumeConfirmedIocClose(p)||!audit.confirmedIocOrders||audit.confirmedIocOrders.length!==2||
      Date.now()<audit.authorizedAt||Date.now()-audit.authorizedAt>8000||
      plan.orders.some(order=>{
        const evidence=audit.confirmedIocOrders!.filter(value=>value.clientOrderId===order.request.clientOrderId);
        return evidence.length!==1||evidence[0].financialFingerprint!==confirmedIocOrderProof(order)||
          (order.result!.id===''?evidence[0].localNoSend!==true||evidence[0].nativeObservedAt!==undefined:
            evidence[0].localNoSend!==undefined||!Number.isFinite(evidence[0].nativeObservedAt)||
            evidence[0].nativeObservedAt!>Date.now()||Date.now()-evidence[0].nativeObservedAt!>8000);
      }))throw new Error('所选 IOC 尾差缺少本会话原生完整现金与准确差量授权');
    this.pendingIocProfitTails.set(p.id,{position:p,legs:[p.long,p.short],leg:plan.leg,remainingBudget:plan.quantity,
      config,configProof:JSON.stringify(config),requestedAt:p.closeRequestedAt!,proof:this.iocProfitTailScope(p),
      orders:plan.orders.map(order=>({order,proof:this.iocProfitTailOrderProof(order)}))});
    if(!this.hasPendingIocProfitTail(p)){this.pendingIocProfitTails.delete(p.id);throw new Error('所选 IOC 尾差在授权安装前发生变化');}
  }
  /** The engine supplies current-session ownership and fresh matching accounts before resuming. */
  canResumeConfirmedIocClose(p:Position):boolean {
    const config=this.context.config(),exit=currentExitStrategyPosition(p,config);
    return config.mode==='live'&&config.profitExitExecutionMode==='ioc'&&p.mode==='live'&&this.context.liveUnlocked()&&
      !this.store.data.killSwitch&&this.context.makerActionsAllowed?.()!==false&&
      exit.entryPolicy==='aligned'&&exit.holdMode==='adaptive'&&p.closeProfitRequired===true&&p.closePricing==='best-opposite'&&
      p.closeRequestedAt!==undefined&&!p.closePauseReason&&!p.manualCloseOnly&&!p.manualCloseAccountRecord&&!p.accountClosure&&
      !this.interruptedOrderProcessing.has(p.id)&&this.closeRefusals(p).size===0&&!this.hasMakerClose(p)&&!this.hasIocProfitClose(p)&&
      !this.store.data.orders.some(order=>this.iocBlockingScopeOrder(p,order))&&this.nativeExitSubmissionAllowed(p);
  }
  async waitIocProfitClose(p:Position):Promise<void>{await this.iocProfitWorkers.get(p.id);}
  async drainIocProfitCloses():Promise<void>{
    for(const id of this.iocProfitWorkers.keys())this.stoppedIocProfitWorkers.add(id);
    this.pendingIocProfitTails.clear();
    await Promise.allSettled([...this.iocProfitWorkers.values()]);
  }
  /** Dispatch immediately; only intent/cash commits enter the financial queue. */
  dispatchIocProfitClose(p:Position,reason:string,validateProfitExit?:CloseProfitValidation,qualification:IocExitQualification='profit'):boolean {
    const config=this.context.config(),exit=currentExitStrategyPosition(p,config),tail=this.hasPendingIocProfitTail(p);
    if(config.profitExitExecutionMode!=='ioc'||config.mode!=='live'||p.mode!=='live'||!this.context.serialize||
      exit.entryPolicy!=='aligned'||exit.holdMode!=='adaptive'||p.manualCloseOnly||p.manualCloseAccountRecord||p.accountClosure||
      !isPositionActive(p)||!['open','closing'].includes(p.status)||this.hasMakerClose(p)||this.hasIocProfitClose(p)||
      this.store.data.killSwitch||!this.context.liveUnlocked()||this.context.makerActionsAllowed?.()===false||
      this.interruptedOrderProcessing.has(p.id)||this.closeRefusals(p).size||
      Date.now()<this.iocProfitCloseRetryAfter(p)||
      this.store.data.orders.some(order=>this.iocBlockingScopeOrder(p,order))||
      !this.nativeExitSubmissionAllowed(p)||!tail&&(!validateProfitExit||!sameQuantity(p.long.quantity,p.short.quantity)))return false;
    this.stoppedIocProfitWorkers.delete(p.id);
    this.beginOperation(p,qualification==='funding-loss'?'funding-exit':'profit-exit','ioc');
    const task=Promise.resolve().then(()=>this.runIocProfitClose(p,reason,config,validateProfitExit,tail,qualification)).catch(error=>{
      if(error instanceof UncertainOrderError)return;
      this.interruptedOrderProcessing.add(p.id);this.store.data.killSwitch=true;p.status='attention';
      p.riskReasons=[`${p.base} 对手价1 IOC ${iocProfitPhaseText[this.iocProfitPhases.get(p.id)??'completion-save']}处理中断；保留原 ID 和真实现金，停止新交易`];
      try{this.context.halt(p.riskReasons[0]);this.store.save();}catch{/* The in-memory stop survives save failure. */}
    }).finally(()=>{
      this.operationObserved(p);
      this.operation(p,id=>{
        const current=this.store.operations.current(p.id);
        if(current?.attempts.unknown)return;
        if(current?.stages.pairedAt===undefined)this.store.operations.wait(id,'ioc-continuation',p.riskReasons[0]??'等待下一次核验，继续处理原退出操作');
      });
      this.iocProfitBatches.delete(p.id);this.iocProfitWorkers.delete(p.id);this.stoppedIocProfitWorkers.delete(p.id);
      this.iocProfitPhases.delete(p.id);
      this.context.iocProfitCloseSettled?.(p);
    });
    this.iocProfitWorkers.set(p.id,task);return true;
  }
  private iocProfitAllowed(p:Position,config:AppConfig):boolean {
    return this.store.data.positions.includes(p)&&isPositionActive(p)&&['open','closing'].includes(p.status)&&
      this.context.config()===config&&config.profitExitExecutionMode==='ioc'&&this.context.liveUnlocked()&&
      !this.store.data.killSwitch&&!this.stoppedIocProfitWorkers.has(p.id)&&!this.interruptedOrderProcessing.has(p.id)&&
      this.context.makerActionsAllowed?.()!==false&&!p.manualCloseOnly&&!p.manualCloseAccountRecord&&!p.accountClosure;
  }
  /** A pre-intent price replan cannot adopt a different contract unit, step, leg or native selector. */
  private checkIocProfitPreparedOrder(p:Position,order:PreparedOrder,rules:IocBookRules):void {
    const current=this.freshSnapshot(p,order.leg);
    if(order.leg!==rules.leg||JSON.stringify(order.request.closePosition)!==rules.closePosition||current&&
      (current.exchange!==rules.exchange||current.base!==rules.base||current.symbol!==rules.symbol||
        current.contractSize!==rules.contractSize||current.quantityStep!==rules.quantityStep))
      throw new Error('提交前合约或合法下单数量已变化，停止提交');
    this.checkPreparedOrder(p,order);
  }
  private async runIocProfitBatch(p:Position,prepared:PreparedOrder[],config:AppConfig,reason:string,
    validateProfitExit:CloseProfitValidation|undefined,qualification:IocExitQualification):Promise<IocProfitBatchResult|undefined> {
    const serial=this.context.serialize!,preparationProof=this.iocProfitScope(p),configProof=JSON.stringify(config),
      originalQuantities=prepared.map(order=>order.request.quantity),bookRules=prepared.map(order=>({leg:order.leg,exchange:order.leg.exchange,
        base:p.base,symbol:order.request.symbol,contractSize:order.contractSize,quantityStep:order.snapshot.quantityStep,
        closePosition:JSON.stringify(order.request.closePosition)}));
    // Drain the selected GETs before another attempt and retain the actual failing venue.
    // The generic/manual validator keeps its original behavior.
    const validatePrepared=async()=>{
    this.iocProfitPhases.set(p.id,'native-validation');
    const validations=await Promise.allSettled(prepared.map(async order=>{
      try{await this.context.adapter(order.leg.exchange).validateOrder?.(order.request);}
      catch(error){
        const fileFailure=error as NodeJS.ErrnoException;
        if(['write','writev','open','mkdir','rename','fsync','fdatasync'].includes(fileFailure?.syscall??'')&&
          ['EIO','ENOSPC','EROFS','EACCES','EPERM','EMFILE','ENFILE'].includes(fileFailure?.code??''))throw error;
        throw error instanceof TradingError?error:tradingError(order.leg.exchange,'合约检查',error);
      }
    }));
    const validationFailure=validations.find(result=>result.status==='rejected'&&typeof (result.reason as NodeJS.ErrnoException)?.syscall==='string')??
      validations.find(result=>result.status==='rejected');
    if(validationFailure?.status==='rejected')throw validationFailure.reason;
    };
    await validatePrepared();
    this.iocProfitPhases.set(p.id,'native-proof');
    const nativeStartedAt=Date.now(),nativeReady=await this.verifyIocProfitAccounts(p);
    const nativeProofCurrent=()=>nativeReady&&Date.now()>=nativeStartedAt&&Date.now()-nativeStartedAt<=8000&&
      this.iocProfitAllowed(p,config)&&JSON.stringify(config)===configProof&&this.iocProfitScope(p)===preparationProof;
    const checkPrepared=()=>prepared.forEach((order,index)=>this.checkIocProfitPreparedOrder(p,order,bookRules[index]));
    let replans=0,refreshed=false;
    for(;;){
      if(!nativeProofCurrent())return;
      this.iocProfitPhases.set(p.id,'post-native-book');
      try{checkPrepared();break;}
      catch(error){
        if(!(error instanceof PreparedBookChangedError))throw error;
        let changed=error;
        if(prepared.some(order=>!this.freshSnapshot(p,order.leg))){
          if(refreshed||!this.context.refreshReductionSnapshots)throw changed;
          refreshed=true;
          await this.context.refreshReductionSnapshots(p.base,[...new Set(prepared.map(order=>order.leg.exchange))]);
          if(!nativeProofCurrent())return;
          try{checkPrepared();break;}catch(failure){if(!(failure instanceof PreparedBookChangedError))throw failure;changed=failure;}
        }
        // At most two new, never-persisted plans. New requests get their exact native
        // validation, while the original account clock, quantity ceiling and cash scope stay fixed.
        if(replans>=2)throw changed;
        let replacement:PreparedOrder[]|undefined;
        if(prepared.length===2){
          const pair=this.bestClosePair(p),ceiling=Math.min(...originalQuantities);
          if(pair){const quantity=Math.min(pair[0].request.quantity,ceiling);
            replacement=pair.map(order=>sameQuantity(order.request.quantity,quantity)?order:this.bestCloseOrder(p,order.leg,quantity));
            if(replacement.some(order=>!sameQuantity(order.request.quantity,quantity)))replacement=undefined;
          }
        }else if(this.hasPendingIocProfitTail(p)){
          const leg=bookRules[0].leg,other=leg===p.long?p.short:p.long,tail=this.pendingIocProfitTails.get(p.id)!;
          const quantity=Math.min(originalQuantities[0],tail.remainingBudget,quantitySubtract(leg.quantity,other.quantity));
          if(quantity>0)replacement=[this.bestCloseOrder(p,leg,quantity)];
        }
        if(!replacement||replacement.length!==prepared.length||replacement.some((order,index)=>
          order.request.quantity>originalQuantities[index]+orderQuantityTolerance(originalQuantities[index])))throw changed;
        replacement.forEach((order,index)=>this.checkIocProfitPreparedOrder(p,order,bookRules[index]));
        if(replacement.length===2&&(!validateProfitExit||[p.long,p.short].some(leg=>nativeTakerFeeRate(this.makerSnapshot(p,leg))===undefined)||
          qualification==='profit'&&!this.makerIocTriggerPass(p,this.makerSnapshot(p,p.long),this.makerSnapshot(p,p.short),config,replacement[0].request.quantity)||
          !validateProfitExit(replacement[0].request.limitPrice,replacement[1].request.limitPrice,replacement[0].request.quantity)))return;
        prepared=replacement;replans++;
        if(!nativeProofCurrent())return;
        await validatePrepared();
      }
    }
    if(!nativeProofCurrent())return;
    let batch:IocProfitBatch|undefined;
    await serial(async()=>{
      if(!nativeProofCurrent()||!this.nativeExitSubmissionAllowed(p))return;
      if(prepared.some(order=>order.leg!==p.long&&order.leg!==p.short))return;
      checkPrepared();
      const paired=prepared.length===2;
      if(paired&&(!validateProfitExit||[p.long,p.short].some(leg=>nativeTakerFeeRate(this.makerSnapshot(p,leg))===undefined)||
        qualification==='profit'&&!this.makerIocTriggerPass(p,this.makerSnapshot(p,p.long),this.makerSnapshot(p,p.short),config,prepared[0].request.quantity)||
        !validateProfitExit(prepared[0].request.limitPrice,prepared[1].request.limitPrice,prepared[0].request.quantity)))return;
      if(!paired){
        if(!this.hasPendingIocProfitTail(p))return;
        const other=prepared[0].leg===p.long?p.short:p.long;
        if(prepared[0].request.quantity>quantitySubtract(prepared[0].leg.quantity,other.quantity)+1e-10)return;
      }
      this.iocProfitPhases.set(p.id,'intent-save');
      try{freezeProfitExitNotional(p,this.store.data.orders);this.commitClose(p,reason,'best-opposite',true);}
      catch(error){this.interruptedOrderProcessing.add(p.id);this.store.data.killSwitch=true;throw error;}
      p.closeAttemptedAt=Date.now();
      const batchId=`${p.id}:ioc-close:${randomUUID()}`,orders=prepared.map(order=>{
        const s=order.snapshot,feeBook=this.makerSnapshot(p,order.leg),at=Date.now(),bookObservedAt=s.observedAt??s.timestamp,
          reference=bestOppositeLevel(s,order.request.side),fee=nativeTakerFeeRate(feeBook,at);
        return {positionId:p.id,exchange:order.leg.exchange,request:order.request,createdAt:at,
          execution:{bookObservedAt,quoteAgeMs:Math.max(0,at-bookObservedAt),bookTransport:s.bookTransport??'rest'},
          executionEvidence:{version:1,method:'ioc',role:paired?'exit':'exit-tail',batchId,
            closeFeeRebatePct:feeRebatePct(order.leg.exchange,config),
            ...(reference?{referencePrice:reference.price,referenceObservedAt:bookObservedAt}:{}),
            ...(fee!==undefined?{nativeTakerFeeRate:fee,referenceTakerFeeRate:fee,feeObservedAt:feeBook!.takerFeeAt??at}:{})}} as JournalOrder;
      });
      batch={position:p,legs:[p.long,p.short],config,orders,requests:orders.map(order=>JSON.stringify(order.request)),bookRules,expected:'',invalid:false,nativeStartedAt,nativeReady,
        configProof,profitCommitted:false,qualification,validateProfitExit,...(paired?{longLimit:prepared[0].request.limitPrice,shortLimit:prepared[1].request.limitPrice,quantity:prepared[0].request.quantity}:{})};
      this.iocProfitBatches.set(p.id,batch);this.store.data.orders.push(...orders);
      this.store.save();this.pendingIocProfitTails.delete(p.id);this.context.makerFinancialActivity?.();batch.expected=this.iocProfitScope(p);
      if(this.iocProfitReadWaits.delete(p.id))this.store.log('info',`${p.base} 对手价1 IOC 准备核验已恢复，按当前盘口、数量与原生账户证明继续执行`,p.id);
    });
    if(!batch)return;
    const ownBatch=batch;
    const results=await Promise.allSettled(prepared.map((order,index)=>this.submitIocProfitOrder(p,order,ownBatch,index)));
    this.iocProfitBatches.delete(p.id);
    return {results,tailCheckpoint:ownBatch.tailCheckpoint??'',configProof:ownBatch.configProof};
  }
  private async submitIocProfitOrder(p:Position,prepared:PreparedOrder,batch:IocProfitBatch,index:number):Promise<OrderResult> {
    try{
    const {leg,request}=prepared,journal=batch.orders[index],serial=this.context.serialize!;
    let localVeto=false,vetoEvidence:OrderExecutionEvidence['iocSubmissionVeto'];
    const deny=(code:IocSubmissionVetoCode)=>{
      localVeto=true;const at=Date.now();let book:MarketSnapshot|undefined,reference:ReturnType<typeof bestOppositeLevel>;
      try{book=this.makerSnapshot(p,leg);reference=book&&bestOppositeLevel(book,request.side);}catch{/* Diagnostics cannot turn a no-send into a thrown callback. */}
      vetoEvidence={code,observedAt:at,nativeProofAgeMs:at-batch.nativeStartedAt,requestedLimitPrice:request.limitPrice,
        ...(book?{bookObservedAt:book.observedAt??book.timestamp}:{}),...(reference?{bestOppositePrice:reference.price}:{})};return false;
    };
    const permitted=(sealEconomics=false)=>{
      try{
        if(!this.iocProfitAllowed(p,batch.config))return deny('runtime-permission');
        if(JSON.stringify(batch.config)!==batch.configProof)return deny('configuration');
        if(batch.invalid||this.iocProfitBatches.get(p.id)!==batch||p.long!==batch.legs[0]||p.short!==batch.legs[1]||
          leg!==p.long&&leg!==p.short)return deny('batch-identity');
        if(!this.store.data.orders.includes(journal)||journal.result!==undefined||JSON.stringify(request)!==batch.requests[index])return deny('order-identity');
        if(this.iocProfitScope(p)!==batch.expected)return deny('cash-scope');
        if(!this.nativeExitSubmissionAllowed(p,journal))return deny('native-authority');
        if(this.store.data.orders.some(order=>this.iocBlockingScopeOrder(p,order)))return deny('unresolved-order');
        if(Date.now()<batch.nativeStartedAt||Date.now()-batch.nativeStartedAt>8000)return deny('native-proof-age');
        this.checkIocProfitPreparedOrder(p,prepared,batch.bookRules[index]);
        if(batch.orders.length===2&&!batch.profitCommitted){
          const economics=this.economicsPosition(p,batch.orders.filter(order=>order.result===undefined||order.result.filledQuantity===0&&order.result.feeUsd===0));
          if([p.long,p.short].some(value=>nativeTakerFeeRate(this.makerSnapshot(p,value))===undefined))return deny('native-fee');
          if(batch.qualification==='profit'&&!this.makerIocTriggerPass(p,this.makerSnapshot(p,p.long),this.makerSnapshot(p,p.short),batch.config,batch.quantity,economics))return deny('profit-threshold');
          if(!batch.validateProfitExit?.(batch.longLimit!,batch.shortLimit!,batch.quantity))return deny('exit-condition');
          // The first actual adapter POST boundary commits only this exact pair;
          // its second leg still consumes that same frozen reduce-only scope.
          if(sealEconomics)batch.profitCommitted=true;
        }
        return true;
      }catch(error){return deny(error instanceof PreparedBookChangedError?'book':'local-validation');}
    };
    const adapter=this.context.adapter(leg.exchange);
    let result:OrderResult;
    if(!permitted())result={id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,
      timestamp:Date.now(),rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED'};
    else{
      await serial(async()=>{
        if(this.iocProfitScope(p)!==batch.expected||!this.iocProfitAllowed(p,batch.config)){batch.invalid=true;return;}
        this.iocProfitPhases.set(p.id,'intent-save');
        journal.executionEvidence!.submittedAt=Date.now();this.store.save();batch.expected=this.iocProfitScope(p);
      });
      this.iocProfitPhases.set(p.id,'native-submit');
      this.operationSubmitted(p,journal);
      try{result=await adapter.placeOrder(request,()=>permitted(true));}catch{
        try{result=await adapter.reconcileOrder(request);}catch{result=this.unknown(request);}
      }
    }
    if(localVeto&&result.id===''&&result.clientOrderId===request.clientOrderId&&result.status==='cancelled'&&
      result.filledQuantity===0&&result.averagePrice===0&&result.feeUsd===0&&result.rejectionCode==='ORDER_SUBMISSION_PERMISSION_CHANGED')
      result={...result,rejectionCode:'IOC_REDUCTION_PERMISSION_CHANGED',rejectionReason:'对手价1 IOC 提交前盘口、数量或许可已变化；本次未发送创建请求'};
    if(!localVeto&&result.rejectionCode==='IOC_REDUCTION_PERMISSION_CHANGED'&&result.id===''&&result.status==='cancelled'&&
      result.filledQuantity===0&&result.averagePrice===0&&result.feeUsd===0)result=this.unknown(request);
    result=this.receipt(p,leg,request,result);
    return await serial(async()=>{
      this.iocProfitPhases.set(p.id,'receipt-save');
      this.assertUncommittedReceipt(p,journal);
      if(p.long!==batch.legs[0]||p.short!==batch.legs[1]||leg!==p.long&&leg!==p.short){
        // Preserve the actual native receipt, but never apply it to an orphaned
        // leg or guess how an externally replaced holding incorporates it.
        this.retainOriginalConfirmation(journal,result);journal.result=result;
        journal.execution!.confirmedAt=Date.now();journal.executionEvidence!.bookedFeeUsd=0;
        journal.error='原生IOC回执已保留；持仓腿对象已变化，真实现金未自动记入替换记录，等待核账';
        batch.invalid=true;this.interruptedOrderProcessing.add(p.id);this.store.data.killSwitch=true;
        p.status='attention';p.riskReasons=['IOC等待期间持仓身份已改变，保留原生回执并停止交易，等待现金和账户核对'];
        this.store.save();throw new Error('IOC持仓身份变更，未猜测替换记录的现金或数量');
      }
      const ownScopeUnchanged=this.iocProfitScope(p)===batch.expected;
      result=this.receipt(p,leg,request,result);this.retainOriginalConfirmation(journal,result);journal.result=result;
      if(localVeto&&vetoEvidence)journal.executionEvidence!.iocSubmissionVeto=vetoEvidence;
      journal.execution!.confirmedAt=Date.now();journal.execution!.confirmationMs=journal.execution!.confirmedAt-journal.createdAt;
      if(result.filledQuantity>0||Number.isFinite(result.feeUsd)&&result.feeUsd!==0)
        this.applyFill(p,leg,request.side,result,true,prepared.snapshot.quantityStep);
      journal.executionEvidence!.bookedFeeUsd=Number.isFinite(result.feeUsd)?result.feeUsd:0;
      this.store.save();this.operationObserved(p);this.context.makerFinancialActivity?.();
      if(!ownScopeUnchanged){batch.invalid=true;p.status='attention';p.riskReasons=['IOC 等待期间本组现金或订单范围已变化，保留实际成交并暂停新减仓'];this.store.save();}
      batch.expected=this.iocProfitScope(p);
      if(result.status==='unknown'){
        batch.invalid=true;this.pendingIocProfitTails.delete(p.id);journal.error='订单状态未知；保留原 ID 查单，禁止重发';
        p.status='attention';p.riskReasons=[`${leg.exchange} IOC 平仓原订单待核对，禁止使用成交下界再发新单`];this.store.save();
        this.context.halt(`${p.base} IOC 原订单未知：仅冻结该币种，保留原 ID 查单`,p.base);
        throw new UncertainOrderError('IOC 原订单状态未知，未重发');
      }
      this.store.log(result.status==='filled'?'info':'warn',iocReductionReceiptLog(journal,localVeto),p.id);
      batch.tailCheckpoint=this.iocProfitTailScope(p);
      return result;
    });
    }catch(error){
      if(!(error instanceof UncertainOrderError)){this.interruptedOrderProcessing.add(p.id);this.store.data.killSwitch=true;}
      throw error;
    }
  }
  private async runIocProfitClose(p:Position,reason:string,config:AppConfig,validateProfitExit:CloseProfitValidation|undefined,tailOnly:boolean,qualification:IocExitQualification):Promise<void> {
    const serial=this.context.serialize!,startedAt=Date.now();let zeroRounds=0;
    for(let round=0;round<MAX_BEST_PRICE_CLOSE_BATCHES&&Date.now()-startedAt<MAX_BEST_PRICE_CLOSE_MS;round++){
      if(!this.iocProfitAllowed(p,config)||this.store.data.orders.some(order=>this.iocBlockingScopeOrder(p,order)))break;
      if(p.long.quantity===0&&p.short.quantity===0)break;
      const confirmedTailLeg=this.hasPendingIocProfitTail(p)
        ?(p.long.quantity>p.short.quantity?p.long:p.short):undefined;
      this.iocProfitPhases.set(p.id,'book-refresh');
      try{await this.refresh(p,confirmedTailLeg?[confirmedTailLeg]:[p.long,p.short].filter(leg=>leg.quantity>0));}
      catch(error){await this.waitIocPreflight(p,'book-refresh',error);break;}
      if(confirmedTailLeg&&!this.hasPendingIocProfitTail(p))break;
      const tail=!sameQuantity(p.long.quantity,p.short.quantity);
      let prepared:PreparedOrder[]|undefined;
      this.iocProfitPhases.set(p.id,'planning');
      try{if(tail){
        if(!this.hasPendingIocProfitTail(p))break;
        const leg=p.long.quantity>p.short.quantity?p.long:p.short,book=this.freshSnapshot(p,leg),other=leg===p.long?p.short:p.long;
        const plan=book&&planBestPriceReduction(book,leg.side,quantitySubtractOnStep(leg.quantity,other.quantity,book.quantityStep));
        if(plan)prepared=[this.bestCloseOrder(p,leg,plan.quantity)];
      }else{
        if(tailOnly||!validateProfitExit)break;
        prepared=this.bestClosePair(p);
      }}catch(error){await this.waitIocPreflight(p,'planning',error);break;}
      if(!prepared)break;
      const before=[p.long.quantity,p.short.quantity],beforeOrders=this.store.data.orders.length,
        previousTail=tail?this.pendingIocProfitTails.get(p.id):undefined;let outcome:IocProfitBatchResult|undefined;
      try{outcome=await this.runIocProfitBatch(p,prepared,config,reason,tail?undefined:validateProfitExit,qualification);}
      catch(error){
        if(this.store.data.killSwitch||this.interruptedOrderProcessing.has(p.id))throw error;
        if(this.store.data.orders.some(order=>order.positionId===p.id&&this.blockingExitOrder(p,order)))throw error;
        // Pure pre-intent book changes grant no order and can wait for a new observation.
        if(this.store.data.orders.slice(beforeOrders).every(order=>order.positionId!==p.id)){
          await this.waitIocPreflight(p,this.iocProfitPhases.get(p.id)??'native-validation',error);break;
        }
        throw error;
      }
      if(!outcome)break;
      const {results}=outcome;
      if(results.some(result=>result.status==='rejected')){
        if(results.some(result=>result.status==='rejected'&&!(result.reason instanceof UncertainOrderError)))throw new Error('IOC 平仓原单处理或持久化中断');
        return;
      }
      if(!this.iocProfitAllowed(p,config))return;
      if(outcome.tailCheckpoint!==this.iocProfitTailScope(p)||outcome.configProof!==JSON.stringify(config)){
        await serial(async()=>{this.pendingIocProfitTails.delete(p.id);p.status='attention';
          p.riskReasons=['IOC 回执提交后现金、配置或订单范围已变化，未重新绑定已确认尾差授权'];this.store.save();});return;
      }
      if(this.closeRefusals(p).size){await serial(async()=>this.finishBestClose(p,'交易所明确拒绝本次IOC减仓，停止重复提交',this.closeRefusals(p)));return;}
      if(!sameQuantity(p.long.quantity,p.short.quantity)){
        const source=[...(previousTail?.orders.map(value=>value.order)??[]),
          ...this.store.data.orders.slice(beforeOrders).filter(order=>order.positionId===p.id)];
        this.pendingIocProfitTails.set(p.id,{position:p,legs:[p.long,p.short],leg:p.long.quantity>p.short.quantity?p.long:p.short,
          remainingBudget:Math.abs(quantitySubtract(p.long.quantity,p.short.quantity)),config,configProof:JSON.stringify(config),requestedAt:p.closeRequestedAt!,
          proof:this.iocProfitTailScope(p),orders:source.map(order=>({order,proof:this.iocProfitTailOrderProof(order)}))});
      }
      else this.pendingIocProfitTails.delete(p.id);
      const changed=!sameQuantity(before[0],p.long.quantity)||!sameQuantity(before[1],p.short.quantity);zeroRounds=changed?0:zeroRounds+1;
      if(zeroRounds>=3)break;
    }
    await serial(async()=>{
      this.iocProfitPhases.set(p.id,'completion-save');
      if(!isPositionActive(p)||p.status==='attention')return;
      if(p.long.quantity===0&&p.short.quantity===0){p.status='closed';p.closedAt=Date.now();p.riskReasons=[];this.pendingIocProfitTails.delete(p.id);}
      else if(this.hasPendingIocProfitTail(p)){p.status='closing';p.riskReasons=['IOC 已确认部分成交，继续仅减真实尾差；未扩大共同批次'];}
      else if(p.closeRequestedAt!==undefined&&sameQuantity(p.long.quantity,p.short.quantity)){
        p.status='closing';p.riskReasons=[qualification==='funding-loss'?
          '对手价1 IOC 首档或资金费劣势条件暂未满足，保留同量余仓等待下一次核验':
          '对手价1 IOC 首档或返佣后10bps条件暂未满足，保留同量余仓等待下一次核验'];
      }
      refreshPnl(p);this.store.save();
    });
  }
  hasMakerClose(p:Position):boolean{return this.makerCloseSupervisor.has(p.id)||this.makerTailWorkers.has(p.id)||this.nativeExitWorkers.has(p.id);}
  makerCloseRetryAfter(p:Position):number{
    const flow=this.makerCloseFlows.get(p.id);
    if(!flow)return 0;
    if(flow.config!==this.context.config()||flow.closeRequestedAt!==p.closeRequestedAt||p.closeProfitRequired!==true||
      !isPositionActive(p)||p.status==='attention'){
      this.makerCloseFlows.delete(p.id);return 0;
    }
    return flow.retryAfter;
  }
  requiresMakerProfitClose(p:Position):boolean {
    const config=this.context.config(),exit=currentExitStrategyPosition(p,config);
    return config.profitExitExecutionMode!=='ioc'&&config.mode==='live'&&exit.entryPolicy==='aligned'&&exit.holdMode==='adaptive'&&
      !p.manualCloseOnly&&!p.manualCloseAccountRecord&&!p.accountClosure;
  }
  async drainMakerCloses():Promise<void>{for(const id of [...this.makerTailWorkers.keys(),...this.nativeExitWorkers.keys()])this.stoppedMakerTailWorkers.add(id);await this.makerCloseSupervisor.drain();await Promise.allSettled([...this.makerTailWorkers.values(),...this.nativeExitWorkers.values()]);}
  async waitMakerClose(p:Position):Promise<void>{await this.makerCloseSupervisor.settled(p.id);await this.makerTailWorkers.get(p.id);}
  requestMakerCloseStop(p:Position,reason:string):void{this.stoppedMakerTailWorkers.add(p.id);this.makerCloseSupervisor.requestStop(p.id,reason);}
  canUseMakerClose(p:Position):boolean {
    const config=this.context.config(),exit=currentExitStrategyPosition(p,config);
    if(config.profitExitExecutionMode==='ioc'||config.mode!=='live'||exit.entryPolicy!=='aligned'||exit.holdMode!=='adaptive'||
      p.manualCloseOnly||!this.context.serialize||!this.context.liveUnlocked())return false;
    const long=this.makerSnapshot(p,p.long),short=this.makerSnapshot(p,p.short);
    if(!long||!short)return false;
    const selected=selectMakerCloseLeg(long,short);
    if(!selected)return false;
    const adapter=this.context.adapter(p[selected].exchange);
    return adapter.supportsMakerReduction?.()===true&&!!adapter.submitMakerReduction&&!!adapter.inspectMakerReduction&&
      !!adapter.validateMakerReduction&&!!adapter.cancelMakerReduction;
  }
  private makerIocTriggerPass(p:Position,long:MarketSnapshot|undefined,short:MarketSnapshot|undefined,c:AppConfig,quantity?:number,economics=this.economicsPosition(p)):boolean {
    return alignedExitProfitsPass(p,assessBestOppositeProfitExit(economics,long,short,c,Date.now(),quantity),c);
  }
  private makerPreparationProof(p:Position):string {
    const instruments=[p.long,p.short];
    return JSON.stringify([p.id,p.base,p.mode,p.status,p.entryPolicy,p.holdMode,p.profitExitPolicy,p.manualCloseOnly,
      p.profitExitNotionalUsd,p.closeRequestedAt,p.closeProfitRequired,p.closePauseReason,p.closeReason,
      p.feesUsd,p.fundingUsd,p.realizedSpreadPnlUsd,p.transferCostUsd,
      instruments.map(leg=>[leg.exchange,leg.symbol,leg.side,leg.entryPrice,leg.feesUsd,leg.quantity]),
      this.exitJournalProof(p,this.store.data.orders.filter(order=>order.positionId===p.id||instruments.some(leg=>leg.exchange===order.exchange&&leg.symbol===order.request.symbol)))]);
  }
  /** Network preparation cannot occupy the financial commit queue. A changed own proof grants no intent. */
  async prepareMakerClose(p:Position):Promise<MakerClosePreparation|undefined>{
    if(this.hasMakerClose(p)||Date.now()<this.makerCloseRetryAfter(p))return;
    if(!this.canUseMakerClose(p)||!isPositionActive(p)||!sameQuantity(p.long.quantity,p.short.quantity)||
      this.store.data.killSwitch||this.closeRefusals(p).size||this.context.makerActionsAllowed?.()===false||
      this.store.data.orders.some(order=>order.positionId===p.id&&this.blockingExitOrder(p,order)))return;
    const config=this.context.config(),proof=this.makerPreparationProof(p),preview={...p,long:{...p.long},short:{...p.short}};
    freezeProfitExitNotional(preview,this.store.data.orders);
    await this.refresh(p,[p.long,p.short]);
    let long=this.makerSnapshot(p,p.long),short=this.makerSnapshot(p,p.short);
    let plan=planMakerClose(this.economicsPosition(preview),long,short,config,Date.now());
    if(!plan?.submissionAllowed||!this.makerIocTriggerPass(preview,long,short,config))return;
    const iocBatch=assessBestOppositeProfitExit(this.economicsPosition(preview),long,short,config)!.batch;
    plan=planMakerClose(this.economicsPosition(preview),long,short,config,Date.now(),{makerLeg:plan.makerLeg,batchQuantity:Math.min(plan.quantity,iocBatch.quantity)});
    if(!plan?.submissionAllowed)return;
    const makerLeg=p[plan.makerLeg],peerLeg=makerLeg===p.long?p.short:p.long;
    const makerScope=this.closeReductionScope(makerLeg,plan.quantity),peerScope=this.closeReductionScope(peerLeg,plan.quantity);
    const scopedQuantity=Math.min(plan.quantity,makerScope?.quantity??plan.quantity,peerScope?.quantity??plan.quantity);
    plan=planMakerClose(this.economicsPosition(preview),long,short,config,Date.now(),{makerLeg:plan.makerLeg,batchQuantity:scopedQuantity});
    if(!plan?.submissionAllowed)return;
    const adapter=this.context.adapter(makerLeg.exchange),makerBook=plan.makerLeg==='long'?long!:short!;
    const prepared:PreparedOrder={leg:makerLeg,snapshot:makerBook,contractSize:makerBook.contractSize,makerReduction:true,role:'exit',request:{
      clientOrderId:`fa${randomUUID().replaceAll('-','').slice(0,26)}`,base:p.base,symbol:makerLeg.symbol,
      side:makerLeg.side==='long'?'sell':'buy',quantity:plan.quantity,limitPrice:plan.makerLimitPrice,reduceOnly:true,postOnly:true,
      ...(makerScope?.closePosition?{closePosition:makerScope.closePosition}:{})}};
    const peerPrepared=this.bestCloseOrder(p,peerLeg,plan.quantity,peerScope);
    if(!sameQuantity(peerPrepared.request.quantity,plan.quantity))return;
    const preflights=await Promise.allSettled([
      Promise.resolve().then(()=>adapter.validateMakerReduction!(prepared.request)).catch(error=>{
        if(typeof (error as NodeJS.ErrnoException)?.syscall==='string')throw error;
        throw new MakerClosePreflightError(makerLeg.exchange,'maker-native',error);
      }),
      Promise.resolve().then(()=>this.validateOrders([peerPrepared])).catch(error=>{
        if(typeof (error as NodeJS.ErrnoException)?.syscall==='string')throw error;
        throw new MakerClosePreflightError(peerLeg.exchange,'peer-native',error);
      })]);
    // Drain both independent native reads before another preparation can start for this position.
    for(const preflight of preflights)if(preflight.status==='rejected'&&typeof (preflight.reason as NodeJS.ErrnoException)?.syscall==='string')throw preflight.reason;
    for(const preflight of preflights)if(preflight.status==='rejected')throw preflight.reason;
    for(const [order,phase] of [[prepared,'maker-book'],[peerPrepared,'peer-book']] as const){
      try{this.checkPreparedOrder(p,order);}
      catch(error){
        // Other local conditions and persistence failures retain their existing diagnostic path.
        if(!preparedBookChangedReason(error))throw error;
        throw new MakerClosePreflightError(order.leg.exchange,phase,error);
      }
    }
    long=this.makerSnapshot(p,p.long);short=this.makerSnapshot(p,p.short);
    const limits=makerLeg===p.long?{longPrice:prepared.request.limitPrice,shortPrice:peerPrepared.request.limitPrice}:
      {longPrice:peerPrepared.request.limitPrice,shortPrice:prepared.request.limitPrice};
    plan=planMakerClose(this.economicsPosition(preview),long,short,config,Date.now(),{makerLeg:plan.makerLeg,batchQuantity:prepared.request.quantity,limits});
    if(!plan?.submissionAllowed||!this.makerIocTriggerPass(preview,long,short,config,prepared.request.quantity)||
      this.context.config()!==config||this.context.makerActionsAllowed?.()===false||this.makerPreparationProof(p)!==proof)return;
    return {position:p,config,proof,notionalUsd:preview.profitExitNotionalUsd,prepared,peerPrepared,plan};
  }
  /** A prepared live path only commits its own durable intent here; all network waits run outside serialize. */
  async startMakerClose(p:Position,reason:string,preparation?:MakerClosePreparation):Promise<boolean>{
    if(this.hasMakerClose(p))return true;
    const ready=preparation??await this.prepareMakerClose(p);
    if(!ready||ready.position!==p||ready.config!==this.context.config()||ready.proof!==this.makerPreparationProof(p)||!this.nativeExitSubmissionAllowed(p)||
      this.context.makerActionsAllowed?.()===false||this.store.data.killSwitch||!this.context.liveUnlocked())return false;
    this.beginOperation(p,'profit-exit','maker-ioc');
    const {config,prepared,peerPrepared,plan}=ready,makerLeg=prepared.leg,peerLeg=peerPrepared.leg,
      adapter=this.context.adapter(makerLeg.exchange);
    this.stoppedMakerTailWorkers.delete(p.id);
    this.checkPreparedOrder(p,prepared);this.checkPreparedOrder(p,peerPrepared);
    const preview={...p,profitExitNotionalUsd:ready.notionalUsd};
    if(!this.makerIocTriggerPass(preview,this.makerSnapshot(p,p.long),this.makerSnapshot(p,p.short),config,prepared.request.quantity))return false;
    p.profitExitNotionalUsd=ready.notionalUsd;
    // Reuse only this pre-intent cash proof during the dedicated original submission. The durable
    // placeholder is not a native fill; any other journal/cash/quantity change invalidates the proof.
    const submissionEconomics=this.economicsPosition(p),cashProof=()=>JSON.stringify([p.id,p.base,p.entryPolicy,p.holdMode,p.profitExitPolicy,
      p.profitExitNotionalUsd,p.feesUsd,[p.long,p.short].map(leg=>[leg.exchange,leg.symbol,leg.side,leg.entryPrice,leg.feesUsd,leg.quantity]),
      p.fundingUsd,p.realizedSpreadPnlUsd,p.transferCostUsd]),originalCashProof=cashProof(),
      originalJournals=this.exitJournalProof(p,this.store.data.orders.filter(order=>order.positionId===p.id));
    const collateralJournals=()=>JSON.stringify(this.store.data.orders.filter(order=>order.positionId!==p.id&&
      [p.long,p.short].some(leg=>leg.exchange===order.exchange&&leg.symbol===order.request.symbol))),originalCollateral=collateralJournals();
    const at=Date.now(),request=prepared.request,book=prepared.snapshot,reference=bestOppositeLevel(book,request.side);
    let flow=this.makerCloseFlows.get(p.id);
    if(!flow||flow.config!==config||flow.closeRequestedAt!==p.closeRequestedAt){
      flow={config,closeRequestedAt:p.closeRequestedAt,cycleId:randomUUID(),startedAt:at,attempts:0,noProgress:0,retryAfter:0};
      this.makerCloseFlows.set(p.id,flow);
    }
    const activeFlow=flow,matchedBefore=Math.min(p.long.quantity,p.short.quantity);
    const journal:JournalOrder={positionId:p.id,exchange:makerLeg.exchange,request,createdAt:at,result:this.unknown(request),
      makerReduction:{activity:'unknown',makerLeg:plan.makerLeg,quantityStep:book.quantityStep,
        peerQuantityStep:peerPrepared.snapshot.quantityStep,peerMinQuantity:peerPrepared.snapshot.minQuantity,
        cycleId:flow.cycleId,attempt:++flow.attempts,previousClientOrderId:flow.lastClientOrderId,retryReason:flow.lastStopReason,
        signalObservedAt:this.context.makerCloseSignalAt?.(p),deadlineAt:at+MAKER_CLOSE_TIMEOUT_MS},
      execution:{bookObservedAt:book.observedAt??book.timestamp,quoteAgeMs:Math.max(0,at-(book.observedAt??book.timestamp)),bookTransport:book.bookTransport??'rest'},
      executionEvidence:{version:1,method:'maker',role:'exit',batchId:`${p.id}:maker-close:${request.clientOrderId}`,
        nativeMakerFeeRate:plan.makerFeeRate,feeObservedAt:book.makerFeeAt,bookedFeeUsd:0,
        ...(reference?{referencePrice:reference.price,referenceObservedAt:book.observedAt??book.timestamp}:{})}};
    // Empty initial acknowledgement is not execution evidence; booked zero is an explicit local baseline.
    journal.result!.feeUsd=0;
    const intentProof=()=>JSON.stringify([journal.positionId,journal.exchange,journal.createdAt,journal.request]),originalIntentProof=intentProof();
    const submissionPosition=():Position=>{
      const conflicts=conflictingNativeOrderReceipts(this.store.data.orders);
      return {...p,transferCostUsd:submissionEconomics.transferCostUsd,estimatedFeeRebateUsd:cashProof()===originalCashProof&&intentProof()===originalIntentProof&&
        !this.store.data.orders.some(order=>order.positionId===p.id&&conflicts.has(order))&&
        this.exitJournalProof(p,this.store.data.orders.filter(order=>order.positionId===p.id&&order!==journal))===originalJournals?
        submissionEconomics.estimatedFeeRebateUsd:null};
    };
    const serial=this.context.serialize!;
    let processingFailed=false;
    const persist=()=>{
      try{this.store.save();}
      catch(error){processingFailed=true;this.interruptedOrderProcessing.add(p.id);this.store.data.killSwitch=true;throw error;}
    };
    try{this.store.data.orders.push(journal);this.commitClose(p,reason,'best-opposite',true);activeFlow.closeRequestedAt=p.closeRequestedAt;p.closeAttemptedAt=at;persist();
      this.activeMakerIntents.set(p.id,{journal,proof:originalIntentProof});}
    catch(error){processingFailed=true;this.interruptedOrderProcessing.add(p.id);this.store.data.killSwitch=true;throw error;}
    this.makerCloseSupervisor.start(p.id,journal.makerReduction!.deadlineAt,{
      submit:async()=>{
        let nativeProofStartedAt:number|undefined;
        // Check the final books/permission again after yielding out of the financial queue, before POST.
        const authorization=await serial(async()=>{
          const canSubmit=()=>{
            if(this.context.config()!==config||this.context.makerActionsAllowed?.()===false||!this.context.liveUnlocked()||this.store.data.killSwitch||
              Date.now()>=journal.makerReduction!.deadlineAt||journal.makerReduction!.cancelRequestedAt!==undefined||this.interruptedOrderProcessing.has(p.id)||
              !this.store.data.positions.includes(p)||!this.store.data.orders.includes(journal)||p.status!=='closing'||p.manualCloseOnly||
              this.stoppedMakerTailWorkers.has(p.id)||!this.nativeExitSubmissionAllowed(p,journal)||
              this.nativeExitAuthorities.has(p.id)&&(nativeProofStartedAt===undefined||Date.now()<nativeProofStartedAt||Date.now()-nativeProofStartedAt>8000)||
              p.closeProfitRequired!==true||p.closeRequestedAt!==activeFlow.closeRequestedAt||p.closePauseReason||
              cashProof()!==originalCashProof||intentProof()!==originalIntentProof||collateralJournals()!==originalCollateral)return false;
            try{this.checkPreparedOrder(p,prepared);}catch(error){
              journal.makerReduction!.localVetoReason=error instanceof Error?error.message:'盘口已变化，未提交原 Maker';return false;
            }
            const l=this.makerSnapshot(p,p.long),s=this.makerSnapshot(p,p.short);if(!l||!s)return false;
            const peerTop=bestCloseOppositeLevel(peerLeg===p.long?l:s,peerLeg.side);if(!peerTop)return false;
            const submittedLimits=makerLeg===p.long?{longPrice:request.limitPrice,shortPrice:peerTop.price}:{longPrice:peerTop.price,shortPrice:request.limitPrice};
            const economics=submissionPosition();
            if(!this.makerIocTriggerPass(p,l,s,config,request.quantity,economics)||
              !planMakerClose(economics,l,s,config,Date.now(),{makerLeg:journal.makerReduction!.makerLeg,batchQuantity:request.quantity,limits:submittedLimits})?.submissionAllowed)return false;
            const longTop=bestCloseOppositeLevel(l,'long')!,shortTop=bestCloseOppositeLevel(s,'short')!;
            journal.makerCloseComparison=createMakerCloseComparison({timestamp:Date.now(),makerLeg:journal.makerReduction!.makerLeg,
              feeRebatePct:{maker:feeRebatePct(makerLeg.exchange,config),peer:feeRebatePct(peerLeg.exchange,config)},
              longOppositePrice:longTop.price,shortOppositePrice:shortTop.price,longTakerFeeRate:nativeTakerFeeRate(l)!,shortTakerFeeRate:nativeTakerFeeRate(s)!,
              originalOneLegNotionalUsd:p.profitExitNotionalUsd!,peer:{exchange:peerLeg.exchange,symbol:peerLeg.symbol}});
            journal.executionEvidence!.referencePrice=makerLeg===p.long?longTop.price:shortTop.price;
            journal.executionEvidence!.nativeTakerFeeRate=nativeTakerFeeRate(makerLeg===p.long?l:s);
            journal.executionEvidence!.nativeMakerFeeRate=nativeMakerFeeRate(makerLeg===p.long?l:s);
            journal.executionEvidence!.feeObservedAt=(makerLeg===p.long?l:s).makerFeeAt;
            journal.executionEvidence!.referenceObservedAt=makerLeg===p.long?(l.observedAt??l.timestamp):(s.observedAt??s.timestamp);
            journal.executionEvidence!.submittedAt=Date.now();
            journal.makerReduction!.submittedAt=journal.executionEvidence!.submittedAt;
            persist();this.context.makerFinancialActivity?.();return true;
          };
          const notSubmitted=():OrderResult=>({id:request.clientOrderId,clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()});
          if(this.context.config()!==config||this.context.makerActionsAllowed?.()===false||this.store.data.killSwitch||
            Date.now()>=journal.makerReduction!.deadlineAt||journal.makerReduction!.cancelRequestedAt!==undefined||
            this.interruptedOrderProcessing.has(p.id))return notSubmitted();
          try{this.checkPreparedOrder(p,prepared);}catch(error){
            journal.makerReduction!.localVetoReason=error instanceof Error?error.message:'盘口已变化，未提交原 Maker';
            return notSubmitted();
          }
          const l=this.makerSnapshot(p,p.long),s=this.makerSnapshot(p,p.short);if(!l||!s)return notSubmitted();
          const currentPeer=bestCloseOppositeLevel(peerLeg===p.long?l:s,peerLeg.side);if(!currentPeer)return notSubmitted();
          const latestLimits=makerLeg===p.long?{longPrice:request.limitPrice,shortPrice:currentPeer.price}:{longPrice:currentPeer.price,shortPrice:request.limitPrice};
          const economics=submissionPosition(),eligible=planMakerClose(economics,l,s,config,Date.now(),{makerLeg:journal.makerReduction!.makerLeg,batchQuantity:request.quantity,limits:latestLimits});
          if(!eligible?.submissionAllowed||!this.makerIocTriggerPass(p,l,s,config,request.quantity,economics))return notSubmitted();
          const longTop=bestCloseOppositeLevel(l,'long')!,shortTop=bestCloseOppositeLevel(s,'short')!;
          journal.makerCloseComparison=createMakerCloseComparison({timestamp:Date.now(),makerLeg:journal.makerReduction!.makerLeg,
            feeRebatePct:{maker:feeRebatePct(makerLeg.exchange,config),peer:feeRebatePct(peerLeg.exchange,config)},
            longOppositePrice:longTop.price,shortOppositePrice:shortTop.price,longTakerFeeRate:nativeTakerFeeRate(l)!,shortTakerFeeRate:nativeTakerFeeRate(s)!,
            originalOneLegNotionalUsd:p.profitExitNotionalUsd!,peer:{exchange:peerLeg.exchange,symbol:peerLeg.symbol}});
          journal.executionEvidence!.referencePrice=makerLeg===p.long?longTop.price:shortTop.price;
          journal.executionEvidence!.nativeTakerFeeRate=nativeTakerFeeRate(makerLeg===p.long?l:s);
          journal.executionEvidence!.referenceObservedAt=makerLeg===p.long?(l.observedAt??l.timestamp):(s.observedAt??s.timestamp);
          persist();
          return canSubmit;
        });
        if(typeof authorization!=='function')return authorization;
        if(this.nativeExitAuthorities.has(p.id)){
          nativeProofStartedAt=Date.now();
          if(!await this.verifyNativeExitBeforeSubmit(p,journal))return {id:request.clientOrderId,clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()};
        }
        this.operationSubmitted(p,journal);
        return adapter.submitMakerReduction!(request,authorization);
      },
      acknowledge:async ack=>{
        journal.makerReduction!.acknowledgedAt=Date.now();
        if(ack&&ack.clientOrderId===request.clientOrderId){
          if(ack.status==='cancelled'&&ack.filledQuantity===0&&Number.isFinite(ack.feeUsd)&&!journal.executionEvidence!.submittedAt){
            journal.result=ack;journal.makerReduction!.activity='terminal';
          }else if(ack.status==='cancelled'&&!ack.id&&ack.filledQuantity===0&&ack.feeUsd===0&&ack.rejectionCode&&ack.rejectionReason){
            journal.result=ack;journal.makerReduction!.activity='terminal';
          }else if(ack.id){journal.result={...journal.result!,id:ack.id,status:'unknown'};}
        }
        persist();
        if(ack?.id&&ack.status==='unknown')this.store.log('info',`${p.base} ${makerLeg.exchange} 原 Maker 已取得交易所 ACK；继续按原 ID 核对累计成交`,p.id);
        this.operationObserved(p);
      },
      inspect:async()=>{
        if(journal.makerReduction!.activity==='terminal')return {activity:'terminal',executionVerified:true,result:journal.result!,observedAt:Date.now()};
        return adapter.inspectMakerReduction!(request,journal.result?.id||undefined);
      },
      observe:async observation=>{
        journal.makerReduction!.observationQueuedAt=Date.now();
        const outcome=await serial(async()=>{
        journal.makerReduction!.observationCommitStartedAt=Date.now();
        if(!this.store.data.orders.includes(journal)||!this.store.data.positions.includes(p))throw new Error('原 Maker 账本身份已变化');
        if(this.interruptedOrderProcessing.has(p.id))throw new Error('原成交保存已中断，先核对账本，禁止再次应用或补偿');
        const state=journal.makerReduction!,current=observation.result;
        const previousFilled=journal.result?.filledQuantity??0;
        const priorObservedAt=state.lastObservedAt;
        if(!Number.isFinite(observation.observedAt)||observation.observedAt>Date.now()+5000||
          observation.observedAt<(priorObservedAt??0)||observation.activity==='unknown'||!observation.executionVerified){
          state.activity='unknown';persist();return {terminal:false,stopReason:'Maker 活动状态或完整成交现金未确认，撤销余单后核对原订单'};
        }
        if(!hasOrderReceiptIdentity(request,current)||!hasBoundedOrderQuantity(request,current)||
          journal.result?.id&&current.id!==journal.result.id||current.averagePriceVerified===false||!Number.isFinite(current.feeUsd))
          throw new Error('Maker 原订单身份、数量或现金证据不一致');
        if(observation.activity==='terminal'&&!isTerminalOrderReceipt(request,current))throw new Error('Maker 终态未核验');
        if(observation.activity==='active'&&current.status!=='unknown')throw new Error('活动 Maker 订单不能被当作终态');
        state.lastObservedAt=observation.observedAt;
        state.bookedExecution=true;
        if(isCurrentUnconfirmedOrder(journal,this.store.data.positions))try{
          this.applyConfirmedOrder(journal,current,observation.activity==='active');
        }catch(error){
          if(this.interruptedOrderProcessing.has(p.id)){processingFailed=true;this.store.data.killSwitch=true;}
          throw error;
        }
        else if(current.filledQuantity!==journal.result?.filledQuantity)throw new Error('Maker 已确认终态出现不同成交数量，等待账本核对');
        if(current.filledQuantity>previousFilled){state.firstFillObservedAt??=observation.observedAt;state.lastFillObservedAt=observation.observedAt;}
        state.activity=observation.activity;journal.error=undefined;state.observationCommittedAt=Date.now();
        this.updateMakerComparisons(journal);persist();this.operationObserved(p);
        return {terminal:observation.activity==='terminal',stopReason:undefined as string|undefined};
        });
        if(outcome.stopReason)return outcome;
        const hedgeReason=await this.hedgeMakerExcess(p,journal,peerLeg,undefined,true);
        if(hedgeReason)await serial(async()=>{processingFailed=true;journal.makerReduction!.stopReason=hedgeReason;persist();});
        return {...outcome,...(hedgeReason?{stopReason:hedgeReason}:{})};
      },
      // This synchronous check only decides whether the original Maker may keep resting.
      // It neither books cash nor grants a new POST, so it need not queue behind unrelated IO.
      // Verified observations and peer reductions still commit through serialize below.
      canRest:async()=>{
        if(processingFailed||this.interruptedOrderProcessing.has(p.id)||this.context.config()!==config||this.context.makerActionsAllowed?.()===false||
          this.store.data.killSwitch||!isPositionActive(p)||p.closeProfitRequired!==true||p.closePauseReason)return false;
        const remaining=quantitySubtractOnStep(request.quantity,journal.result?.filledQuantity??0,journal.makerReduction!.quantityStep??NaN);
        if(!(remaining>0))return false;
        const l=this.makerSnapshot(p,p.long),s=this.makerSnapshot(p,p.short);if(!l||!s)return false;
        const currentMaker=bestOppositeLevel(makerLeg===p.long?l:s,makerLeg===p.long?'buy':'sell');
        if(currentMaker&&(makerLeg===p.long?currentMaker.price<request.limitPrice:currentMaker.price>request.limitPrice)){
          journal.makerReduction!.stopReason='宽盘口腿最优挂单价已移动，确认原单撤销后按新盘口重挂';return false;
        }
        if(!sameQuantity(p.long.quantity,p.short.quantity))return canRestConfirmedMakerClose(this.economicsPosition(p),journal,l,s,config);
        const peerTop=bestCloseOppositeLevel(peerLeg===p.long?l:s,peerLeg.side);if(!peerTop)return false;
        const currentLimits=makerLeg===p.long?{longPrice:request.limitPrice,shortPrice:peerTop.price}:{longPrice:peerTop.price,shortPrice:request.limitPrice};
        // A native ACK has no fill cash yet. Only this session's unchanged zero placeholder may
        // wait for its first original-ID GET; this exception cannot authorize another POST.
        const firstInspection=journal.makerReduction!.lastObservedAt===undefined&&journal.makerReduction!.bookedExecution!==true&&
          !!journal.result?.id&&journal.result.status==='unknown'&&journal.result.filledQuantity===0&&journal.result.averagePrice===0&&
          journal.result.feeUsd===0&&journal.executionEvidence?.bookedFeeUsd===0&&
          journal.makerReduction!.submittedAt!==undefined&&journal.makerReduction!.acknowledgedAt!==undefined;
        const economics=firstInspection?submissionPosition():this.economicsPosition(p);
        return this.makerIocTriggerPass(p,l,s,config,remaining,economics)&&planMakerClose(economics,l,s,config,Date.now(),{makerLeg:journal.makerReduction!.makerLeg,batchQuantity:remaining,limits:currentLimits})?.submissionAllowed===true;
      },
      cancel:async()=>{
        const terminal=()=>journal.makerReduction!.activity==='terminal';
        if(terminal())return;
        // This session owns only its original cancel metadata. No cash or quantity mutation runs outside serialize.
        // Cancellation must not wait behind another position's network request on the financial queue.
        journal.makerReduction!.cancelRequestedAt??=Date.now();
        let saveFailed=false;try{persist();}catch{saveFailed=true;}
        let id=journal.result?.id;
        if(!id){
          const lookup=await adapter.inspectMakerReduction!(request);
          if(hasOrderReceiptIdentity(request,lookup.result)&&hasBoundedOrderQuantity(request,lookup.result)&&lookup.result.id){
            id=lookup.result.id;journal.result={...journal.result!,id};try{persist();}catch{saveFailed=true;}
          }
        }
        if(id&&!terminal())await adapter.cancelMakerReduction!(request,id);
        if(saveFailed)throw new Error('撤单记录保存失败；原 ID 的取消已尝试，停止新增订单');
      },
      finish:reason=>serial(async()=>{
        this.activeMakerIntents.delete(p.id);
        journal.makerReduction!.stopReason??=reason;
        journal.makerReduction!.finishedAt=Date.now();
        this.updateMakerComparisons(journal);
        const peerBook=this.freshSnapshot(p,peerLeg),peerStep=peerBook?.quantityStep??peerPrepared.snapshot.quantityStep,
          peerMinimum=peerBook?.minQuantity??peerPrepared.snapshot.minQuantity,tail=quantitySubtractOnStep(peerLeg.quantity,makerLeg.quantity,peerStep);
        const budget=this.makerPeerBudget(p,journal);
        const retryableTail=journal.makerReduction!.activity==='terminal'&&!!journal.result&&isTerminalOrderReceipt(request,journal.result)&&
          !this.interruptedOrderProcessing.has(p.id)&&!this.store.data.killSwitch&&p.closeProfitRequired===true&&p.closeRequestedAt!==undefined&&
          !this.closeRefusals(p).size&&!this.store.data.orders.some(order=>order.positionId===p.id&&this.blockingExitOrder(p,order))&&
          budget!==undefined&&tail>0&&this.makerTailBudgetMatches(p,tail,budget,peerStep)&&isLegalQuantity(tail,peerStep,peerMinimum);
        if(retryableTail){
          this.pendingMakerCloseTails.set(p.id,{position:p,journal,config,requestedAt:p.closeRequestedAt!,
            signature:JSON.stringify([journal.positionId,journal.exchange,journal.request]),retryAfter:Date.now()+MAKER_CLOSE_RETRY_COOLDOWN_MS});
          p.status='closing';p.riskReasons=['原 Maker 已确认成交，对侧合法尾差等待新盘口后继续补齐；未扩大共同平仓量'];
        }else if(journal.makerReduction!.activity!=='terminal'||isCurrentUnconfirmedOrder(journal,this.store.data.positions)||processingFailed||this.interruptedOrderProcessing.has(p.id)||
          this.store.data.orders.some(order=>order!==journal&&order.positionId===p.id&&this.blockingExitOrder(p,order))){
          p.status='attention';p.riskReasons=[journal.makerReduction!.stopReason??reason];this.context.halt(`${p.base} Maker 平仓待核对，禁止重挂或重复减仓`,p.base);
        }else {
          this.finishBestClose(p,reason,this.closeRefusals(p));
          if(p.status==='closing'&&sameQuantity(p.long.quantity,p.short.quantity)){
            const progress=Math.min(p.long.quantity,p.short.quantity)<matchedBefore&&!sameQuantity(Math.min(p.long.quantity,p.short.quantity),matchedBefore);
            activeFlow.noProgress=progress?0:activeFlow.noProgress+1;
            if(progress)activeFlow.startedAt=Date.now();
            activeFlow.retryAfter=activeFlow.noProgress>=MAKER_CLOSE_ZERO_ATTEMPTS?Date.now()+MAKER_CLOSE_RETRY_COOLDOWN_MS:0;
            if(activeFlow.retryAfter)activeFlow.noProgress=0;
            activeFlow.lastClientOrderId=request.clientOrderId;activeFlow.lastStopReason=journal.makerReduction!.stopReason;
          }else this.makerCloseFlows.delete(p.id);
        }
        refreshPnl(p);persist();
      }),
      settled:()=>this.context.makerCloseSettled?.(p),
      failed:()=>{
        this.interruptedOrderProcessing.add(p.id);this.store.data.killSwitch=true;
        p.status='attention';p.riskReasons=['Maker 平仓账本保存失败，已停止新交易；保留原订单和已确认成交等待核对'];
        try{this.context.halt(p.riskReasons[0]);}catch{/* Preserve the in-memory stop when disk persistence itself failed. */}
      },
    });
    try{this.store.log('info',`${p.base} ${makerLeg.exchange} 已记录 PostOnly 平仓意图 ${request.side} ${request.quantity}，等待提交前核验及交易所 ACK；确认成交后立即减 ${peerLeg.exchange} 对侧`,p.id);}
    catch(error){processingFailed=true;this.interruptedOrderProcessing.add(p.id);this.store.data.killSwitch=true;this.requestMakerCloseStop(p,'平仓日志保存失败，撤销原挂单并停止新交易');throw error;}
    return true;
  }
  /** A Maker's verified cumulative fill is the only budget for its peer's incremental reduction. */
  private async hedgeMakerExcess(p:Position,journal:JournalOrder,peer:PositionLeg,canSubmit?:(pending?:JournalOrder)=>boolean,asyncCommit=false):Promise<string|undefined>{
    const maker=p[journal.makerReduction!.makerLeg],config=this.context.config(),requestedAt=p.closeRequestedAt;
    const hadExcess=!sameQuantity(maker.quantity,peer.quantity);
    if(this.interruptedOrderProcessing.has(p.id))return '原成交保存中断，先核对账本，禁止新增对侧减仓';
    for(let attempt=0;attempt<3&&!sameQuantity(maker.quantity,peer.quantity);attempt++){
      if(peer.quantity<maker.quantity)return '对侧减仓超过原 Maker 已确认成交，停止本轮并核对原账本';
      if(this.store.data.killSwitch||this.context.makerActionsAllowed?.()===false||!this.context.liveUnlocked()||
        this.context.config()!==config||p.closeRequestedAt!==requestedAt||p.closeProfitRequired!==true)
        return '交易许可已变化，保留已确认尾差等待授权核对';
      if(!this.nativeExitSubmissionAllowed(p)||this.store.data.orders.some(order=>order!==journal&&order.positionId===p.id&&this.blockingExitOrder(p,order)))
        return '对侧原订单待核对，禁止重复减仓';
      const book=this.freshSnapshot(p,peer),excess=quantitySubtractOnStep(peer.quantity,maker.quantity,book?.quantityStep??NaN);
      const budget=this.makerPeerBudget(p,journal);
      if(budget===undefined||!this.makerTailBudgetMatches(p,excess,budget,book?.quantityStep??journal.makerReduction!.peerQuantityStep??NaN))
        return '真实尾差与原 Maker 已确认成交预算不一致，停止补单等待账本核对';
      if(!book)return '对侧盘口未确认，撤 Maker 余单并保留真实尾差待处理';
      const legalBudget=floorQuantity(excess,book.quantityStep);
      if(!isLegalQuantity(legalBudget,book.quantityStep,book.minQuantity)){
        if(canRestConfirmedMakerClose(this.economicsPosition(p),journal,this.makerSnapshot(p,p.long),this.makerSnapshot(p,p.short),this.context.config()))return undefined;
        return 'Maker 部分成交暂不足对侧合法减仓量，撤余单并保留真实尾差待处理';
      }
      let prepared:PreparedOrder|undefined;
      let stage:'book'|'validation'|'permission'|'submission'|'confirmation'='book';
      try{
        if(canSubmit?.()===false)return '限定尾差修复许可已变化，未新增减仓';
        journal.makerReduction!.peerPreparationStartedAt=Date.now();
        prepared=attempt===0?this.bestCloseOrder(p,peer,legalBudget):this.bufferedCloseTail(p,peer,legalBudget);
        if(!prepared)return '对侧首档或尾差允许范围内暂无合法减仓数量，撤 Maker 余单后等待盘口';
        prepared.role='exit-tail';prepared.makerCloseParentClientId=journal.request.clientOrderId;
        stage='validation';
        const adapter=this.context.adapter(peer.exchange);
        if(asyncCommit&&adapter.validateOrderLocally)await adapter.validateOrderLocally(prepared.request);
        else await this.validateOrders([prepared]);
        this.checkPreparedOrder(p,prepared);journal.makerReduction!.peerPreparationCompletedAt=Date.now();
        stage='permission';
        if(canSubmit?.()===false||this.context.makerActionsAllowed?.()===false||this.store.data.killSwitch||
          !this.context.liveUnlocked()||this.context.config()!==config||p.closeRequestedAt!==requestedAt||
          p.closeProfitRequired!==true||this.makerPeerBudget(p,journal)!==budget)
          return '提交前限定尾差修复许可或已确认预算已变化，未新增减仓';
        journal.makerReduction!.hedgeStartedAt??=Date.now();
        p.closeAttemptedAt=Date.now();
        try{this.store.save();}catch(error){
          this.interruptedOrderProcessing.add(p.id);this.store.data.killSwitch=true;throw error;
        }
        stage='submission';
        // The worker owns this one timing marker written while saving its new intent. It is not cash.
        const peerScopeProof=(pending?:JournalOrder)=>this.exitJournalProof(p,this.store.data.orders.filter(order=>order.positionId===p.id&&order!==pending)
          .map(order=>order===journal?{...order,makerReduction:{...order.makerReduction!,peerAdapterStartedAt:undefined,
            peerNativeCheckStartedAt:undefined,peerNativeCheckCompletedAt:undefined,peerPermissionVetoReason:undefined}}:order));
        const priorOrders=peerScopeProof(),
          priorQuantities=[p.long.quantity,p.short.quantity];
        // A final native callback owns only its new unsent intent; any other order/cash change revokes the original budget.
        const permission=(pending?:JournalOrder)=>canSubmit?.(pending)!==false&&this.context.config()===config&&p.closeRequestedAt===requestedAt&&
          p.closeProfitRequired===true&&this.context.makerActionsAllowed?.()!==false&&
          (pending?this.store.data.orders.includes(pending)&&pending.positionId===p.id&&pending.request===prepared!.request&&pending.result===undefined&&
            pending.executionEvidence?.makerCloseParentClientId===journal.request.clientOrderId&&
            p.long.quantity===priorQuantities[0]&&p.short.quantity===priorQuantities[1]&&
            peerScopeProof(pending)===priorOrders:
            this.makerPeerBudget(p,journal)===budget);
        const result=await (asyncCommit?this.submitMakerPeer(p,prepared,journal,permission):this.submitOrder(p,prepared,permission));
        stage='confirmation';
        if(result.rejectionCode==='MAKER_REDUCTION_PERMISSION_CHANGED')
          return '原生末检查已撤回本次对侧减仓许可，保留已确认尾差，未重新创建意图';
        if(!canRetryCloseReceipt(result))return '交易所明确拒绝对侧减仓，停止挂单并核对';
      }catch(error){
        journal.makerReduction!.peerLastFailureStage=stage;
        if(this.interruptedOrderProcessing.has(p.id))this.store.data.killSwitch=true;
        // A pure pre-intent quote change proves no create was sent; retry the current bounded book immediately.
        if(error instanceof PreparedBookChangedError&&!this.interruptedOrderProcessing.has(p.id))continue;
        return `对侧减仓在${stage==='validation'?'数量与盘口核验':stage==='permission'?'许可核验':stage==='submission'?'原订单提交或核对':stage==='confirmation'?'成交核对':'盘口准备'}阶段未完成；保留原成交，禁止重发未知原单`;
      }
    }
    if(sameQuantity(maker.quantity,peer.quantity)){
      if(hadExcess)journal.makerReduction!.hedgeCompletedAt=Date.now();
      return undefined;
    }
    return '对侧部分成交尚有真实尾差，停止 Maker 余单后继续核对';
  }
  /** Construct a reduce-only order at bid/ask 1, without opening notional limits or a depth sweep. */
  private bestCloseOrder(p:Position,leg:PositionLeg,quantity:number,scope?:ReductionScope):PreparedOrder {
    const book=this.freshSnapshot(p,leg);
    if(!book||book.exchange!==leg.exchange||book.base!==p.base||book.symbol!==leg.symbol)
      throw new Error('待减仓合约缺少新鲜一致盘口');
    if(this.context.config().mode==='live'&&!this.context.liveUnlocked())throw new Error('实盘执行开关未解锁');
    const native=scope??this.closeReductionScope(leg,quantity),plan=planBestPriceReduction(book,leg.side,Math.min(quantity,native?.quantity??quantity));
    if(!plan||plan.quantity>leg.quantity+1e-10)throw new Error('首档缺少合法减仓数量，等待新盘口');
    return {leg,snapshot:book,contractSize:book.contractSize,pricing:'best-opposite',request:{
      clientOrderId:`fa${randomUUID().replaceAll('-','').slice(0,26)}`,base:p.base,symbol:leg.symbol,
      side:leg.side==='long'?'sell':'buy',quantity:plan.quantity,limitPrice:plan.limitPrice,reduceOnly:true,
      ...(native?.closePosition?{closePosition:native.closePosition}:{})}};
  }
  private bestClosePair(p:Position,scopedFullClose=false):PreparedOrder[]|undefined {
    const long=this.freshSnapshot(p,p.long),short=this.freshSnapshot(p,p.short);
    if(!long||!short||quoteSkewMs(long,short)>this.context.config().maxQuoteSkewMs)return;
    if(scopedFullClose){
      const left=this.closeReductionScope(p.long,p.long.quantity),right=this.closeReductionScope(p.short,p.short.quantity);
      const assessment=planScopedFullCloseBatch(long,short,Math.min(p.long.quantity,left?.quantity??p.long.quantity),
        Math.min(p.short.quantity,right?.quantity??p.short.quantity));
      if(assessment.status!=='paired')return;
      const prepared=[this.bestCloseOrder(p,p.long,assessment.plan.quantity,left),this.bestCloseOrder(p,p.short,assessment.plan.quantity,right)];
      return prepared.every(order=>sameQuantity(order.request.quantity,assessment.plan.quantity))?prepared:undefined;
    }
    const initial=planBestPriceCloseBatch(long,short,p.long.quantity,p.short.quantity);if(!initial)return;
    const left=this.closeReductionScope(p.long,initial.quantity),right=this.closeReductionScope(p.short,initial.quantity);
    const plan=planBestPriceCloseBatch(long,short,Math.min(initial.quantity,left?.quantity??initial.quantity),
      Math.min(initial.quantity,right?.quantity??initial.quantity));
    if(!plan)return;
    const prepared=[this.bestCloseOrder(p,p.long,plan.quantity,left),this.bestCloseOrder(p,p.short,plan.quantity,right)];
    if(prepared.some(order=>!sameQuantity(order.request.quantity,plan.quantity)))return;
    return prepared;
  }
  private scopedFullCloseOrder(p:Position,leg:PositionLeg):PreparedOrder {
    const book=this.freshSnapshot(p,leg),scope=this.closeReductionScope(leg,leg.quantity);
    const plan=book&&planScopedFullReduction(book,leg.side,leg.quantity,scope?.quantity??leg.quantity);
    if(!plan)throw new Error('首档暂不足可完成合法余仓的减仓数量，等待新盘口或核对最小量');
    const prepared=this.bestCloseOrder(p,leg,plan.quantity,scope);
    if(!sameQuantity(prepared.request.quantity,plan.quantity))throw new Error('所选分仓合法减仓数量已变化，停止提交');
    return prepared;
  }
  /** Only already confirmed excess can use a small visible-depth allowance; matched holdings are untouched. */
  private bufferedCloseTail(p:Position,leg:PositionLeg,quantity:number):PreparedOrder|undefined {
    const book=this.freshSnapshot(p,leg),top=book&&bestCloseOppositeLevel(book,leg.side);if(!book||!top)return;
    const side=leg.side==='long'?'sell':'buy',levels=this.observedLevels(book,side).filter(level=>
      (side==='buy'?level.price-top.price:top.price-level.price)/top.price*10000<=CLOSE_REPAIR_BUFFER_BPS+1e-9);
    const scope=this.closeReductionScope(leg,quantity),bounded=floorQuantity(Math.min(quantity,scope?.quantity??quantity,
      levels.reduce((total,level)=>total+level.quantity,0)),book.quantityStep);
    if(!(bounded>0)||bounded<book.minQuantity||bounded>quantity+1e-10)return;
    const fill=sweep(levels,bounded);if(fill.filled<bounded*(1-1e-9)||!Number.isFinite(fill.worstPrice)||fill.worstPrice<=0)return;
    const prepared=this.buildOrder(p,leg,side,bounded,true);
    if(prepared.request.quantity>bounded+1e-10)return;
    // checkPreparedOrder verifies all current visible quantity inside this bounded limit before submission.
    prepared.request.limitPrice=fill.worstPrice;return prepared;
  }
  private closeRefusals(p:Position):Set<string> {
    return new Set(this.store.data.orders.slice(this.context.closeOrderStartIndex??0).filter(order=>order.positionId===p.id&&order.request.reduceOnly&&
      p.closeRequestedAt!==undefined&&order.createdAt>=p.closeRequestedAt&&order.result&&order.result.status!=='unknown'&&
      !canRetryCloseReceipt(order.result,order.request.postOnly===true)&&!isControlledBybitMakerCancellation(order)).map(order=>order.exchange));
  }
  private commitClose(p:Position,reason:string,pricing:'best-opposite'|'depth',requireProfit:boolean) {
    if(p.closeRequestedAt===undefined){p.closeRequestedAt=Date.now();p.closePricing=pricing;p.closeProfitRequired=requireProfit;}
    if(!requireProfit)delete p.closePauseReason;
    p.closeReason=reason;p.status='closing';this.store.save();
  }
  /** Release only a conditional automatic intent. Terminal fills and all actual cash remain untouched. */
  suspendAutomaticClose(p:Position,reason:string):boolean {
    const exit=currentExitStrategyPosition(p,this.context.config());
    if(!isPositionActive(p)||p.manualCloseOnly||exit.holdMode!=='adaptive'||p.closeProfitRequired!==true||
      p.closeRequestedAt===undefined||this.store.data.killSwitch||
      ![p.long.quantity,p.short.quantity].every(value=>Number.isFinite(value)&&value>1e-12)||
      !sameQuantity(p.long.quantity,p.short.quantity)||this.closeRefusals(p).size||
      this.store.data.orders.some(order=>order.positionId===p.id&&isCurrentUnconfirmedOrder(order,this.store.data.positions)))return false;
    p.closePauseReason=reason;
    if(this.context.confirmCloseSuspension?.(p)===false){
      p.status='attention';p.riskReasons=['自动退出条件已变化，订单均已确认；等待最新账户数量核对后恢复持有'];
      this.store.save();return false;
    }
    (p.automaticCloseHistory??=[]).push({requestedAt:p.closeRequestedAt,attemptedAt:p.closeAttemptedAt,
      suspendedAt:Date.now(),reason:p.closeReason,suspensionReason:reason,pricing:p.closePricing,
      longQuantity:p.long.quantity,shortQuantity:p.short.quantity});
    delete p.closeRequestedAt;delete p.closeAttemptedAt;delete p.closePricing;delete p.closeProfitRequired;
    delete p.closeReason;delete p.closePauseReason;p.status='open';p.riskReasons=[];
    this.makerCloseFlows.delete(p.id);
    this.store.save();return true;
  }
  /** Restore equality by reducing only the larger confirmed remainder, never buying back closed coins. */
  private async repairBestCloseTail(p:Position,startedAt:number,blocked:Set<string>):Promise<boolean> {
    const c=this.context.config(),attempts=Math.max(2,Math.min(5,c.maxOrderRetries+2));
    for(let attempt=0;attempt<attempts&&!sameQuantity(p.long.quantity,p.short.quantity);attempt++){
      const leg=p.long.quantity>p.short.quantity?p.long:p.short;
      if(blocked.has(leg.exchange)||attempt>0&&(c.mode==='live'&&!this.context.refreshSnapshots||Date.now()-startedAt>=MAX_BEST_PRICE_CLOSE_MS))break;
      try{
        await this.refresh(p,[p.long,p.short].filter(item=>item.quantity>0));
        const book=this.freshSnapshot(p,leg),other=leg===p.long?p.short:p.long;
        const excess=quantitySubtractOnStep(leg.quantity,other.quantity,book?.quantityStep??NaN);
        const plan=book&&planBestPriceReduction(book,leg.side,excess);
        const prepared=attempt>0||!plan?this.bufferedCloseTail(p,leg,excess):this.bestCloseOrder(p,leg,plan.quantity);
        if(!prepared)break;
        await this.validateOrders([prepared]);this.checkPreparedOrder(p,prepared);
        p.closeAttemptedAt=Date.now();this.store.save();
        const result=await this.submitOrder(p,prepared);
        if(this.pauseUnconfirmedEntry(p,'平仓补齐减仓订单待核对，禁止重复提交'))return false;
        if(!canRetryCloseReceipt(result)){blocked.add(leg.exchange);break;}
      }catch(error){
        if(this.pauseUnconfirmedEntry(p,'平仓补齐减仓订单待核对，禁止将成交下界当作最终结果')||error instanceof UncertainOrderError)return false;
        break;
      }
    }
    return sameQuantity(p.long.quantity,p.short.quantity);
  }
  private finishBestClose(p:Position,stopReason:string,blocked:Set<string>):boolean {
    if(this.pauseUnconfirmedEntry(p,'平仓订单待核对，禁止重复提交或提前认定已平仓',true)){refreshPnl(p);this.store.save();return false;}
    if(p.long.quantity===0&&p.short.quantity===0){p.status='closed';p.closedAt=Date.now();p.riskReasons=[];}
    else if(sameQuantity(p.long.quantity,p.short.quantity)&&!blocked.size){
      p.status='closing';p.riskReasons=[stopReason||'对手价1分批平仓，保留同量剩余仓位等待新盘口'];
    }else{
      const already=p.status==='attention';p.status='attention';p.riskReasons=[blocked.size?
        `交易所明确拒绝本次减仓，未重发：${[...blocked].join(' / ')}；保留已确认剩余仓位等待核验`:
        `平仓尾差尚未完成：多 ${p.long.quantity} / 空 ${p.short.quantity}；仅继续核验已确认剩余敞口`];
      if(!already)this.context.halt(`${p.base} ${p.riskReasons[0]}`,p.base);
    }
    refreshPnl(p);this.store.save();return true;
  }
  private async closeBestPriceBatches(p:Position,reason:string,validateProfitExit:CloseProfitValidation|undefined,requireProfit:boolean):Promise<boolean> {
    const c=this.context.config(),startedAt=Date.now(),pairedIntent=p.long.quantity>0&&p.short.quantity>0||p.long.entryPrice>0&&p.short.entryPrice>0;
    // Only a newly confirmed, quantity-scoped manual exit authorizes reducing
    // both unequal actual holdings. Automatic exits retain their hedge-first rule.
    const scopedFullClose=this.context.scopedFullClose===true&&p.manualCloseOnly===true&&!requireProfit;
    const blocked=this.closeRefusals(p);
    if(blocked.size)return this.finishBestClose(p,'交易所明确拒绝减仓，等待核验',blocked);
    if(!requireProfit||p.closeRequestedAt!==undefined)this.commitClose(p,reason,'best-opposite',requireProfit);
    let zeroRounds=0,economicStop=false,stopReason='对手价1分批轮数已到，等待新盘口继续处理同量剩余仓位';
    batches: for(let batch=0;batch<MAX_BEST_PRICE_CLOSE_BATCHES;batch++){
      if(p.long.quantity===0&&p.short.quantity===0)break;
      if(batch>0&&(c.mode==='live'&&!this.context.refreshSnapshots||Date.now()-startedAt>=MAX_BEST_PRICE_CLOSE_MS))break;
      if(pairedIntent&&!scopedFullClose&&!sameQuantity(p.long.quantity,p.short.quantity)){
        if(p.closeRequestedAt===undefined)this.commitClose(p,reason,'best-opposite',requireProfit);
        if(!await this.repairBestCloseTail(p,startedAt,blocked))break;
        if(p.long.quantity===0&&p.short.quantity===0)break;
      }
      let prepared:PreparedOrder[];
      try{
        const remaining=[p.long,p.short].filter(leg=>leg.quantity>0);
        await this.refresh(p,remaining);
        if(Date.now()-startedAt>=MAX_BEST_PRICE_CLOSE_MS){stopReason='平仓批次时间已到，等待新盘口继续处理';break;}
        const preparationOrderCount=this.store.data.orders.length;
        for(let attempt=0;;attempt++){
          if(pairedIntent){
            const pair=remaining.length===2?this.bestClosePair(p,scopedFullClose):undefined;
            if(pair)prepared=pair;
            else if(scopedFullClose){
              if(remaining.length===2){
                const long=this.freshSnapshot(p,p.long),short=this.freshSnapshot(p,p.short);
                if(!long||!short)throw new Error('所选两腿缺少有效盘口，未拆分平仓');
                const left=this.closeReductionScope(p.long,p.long.quantity),right=this.closeReductionScope(p.short,p.short.quantity);
                const assessment=planScopedFullCloseBatch(long,short,Math.min(p.long.quantity,left?.quantity??p.long.quantity),
                  Math.min(p.short.quantity,right?.quantity??p.short.quantity));
                if(assessment.status!=='independent'){
                  stopReason='所选余仓共同减仓的数量或首档条件暂未满足，等待新盘口或核对合约规则';break batches;
                }
              }
              // Prefer shared lots; if no shared lot remains, close only each
              // selected native slot's own legal remainder at its opposite 1.
              prepared=remaining.map(leg=>this.scopedFullCloseOrder(p,leg));
            }else {stopReason='首档暂不足合法共同减仓数量，等待新盘口';break batches;}
          }else{
            const leg=remaining[0],book=leg&&this.freshSnapshot(p,leg),plan=book&&planBestPriceReduction(book,leg.side,leg.quantity);
            if(!plan){stopReason='首档暂不足合法减仓数量，等待新盘口';break batches;}
            prepared=[scopedFullClose?this.scopedFullCloseOrder(p,leg):this.bestCloseOrder(p,leg,plan.quantity)];
          }
          await this.validateOrders(prepared);
          const checkBooks=()=>{
            prepared.forEach(order=>this.checkPreparedOrder(p,order));
            if(prepared.length===2&&quoteSkewMs(prepared[0].snapshot,prepared[1].snapshot)>c.maxQuoteSkewMs)
              throw new PreparedBookChangedError('提交前两腿盘口时刻已不一致，停止新共同平仓批次');
          };
          try{checkBooks();}
          catch(error){
            if(!scopedFullClose||c.mode!=='live'||!this.context.refreshReductionSnapshots||
              !(error instanceof PreparedBookChangedError)||this.store.data.orders.length!==preparationOrderCount||
              Date.now()-startedAt>=MAX_BEST_PRICE_CLOSE_MS)throw error;
            // Native slot validation may outlive a WS observation. Refresh only the chosen
            // public books; keep the same unsubmitted ID, quantity and conservative limit
            // when they still work. This hook cannot renew the click's original authority.
            await this.refreshReduction(p,remaining);
            if(Date.now()-startedAt>=MAX_BEST_PRICE_CLOSE_MS)throw new Error('本次手动平仓处理窗口已结束，请刷新账户后重新确认剩余数量');
            try{checkBooks();}
            catch(updatedError){
              // Rebuild at the newly observed opposite 1 only before any intent exists,
              // then repeat native validation. At most two replans per batch; never replay
              // a submitted pair, broaden its frozen quantity budget or reset zero rounds.
              if(updatedError instanceof PreparedBookChangedError&&attempt<2&&
                this.store.data.orders.length===preparationOrderCount)continue;
              throw updatedError;
            }
          }
          break;
        }
        // Native validation may await the network; every new shared batch gets its own final profit check.
        if(pairedIntent&&requireProfit&&(!validateProfitExit||
          !validateProfitExit(prepared[0].request.limitPrice,prepared[1].request.limitPrice,prepared[0].request.quantity))){
          economicStop=!!validateProfitExit;
          stopReason='当前自动退出条件已变化，停止新共同平仓批次并保留同量剩余仓位';break;
        }
        if(Date.now()-startedAt>=MAX_BEST_PRICE_CLOSE_MS){stopReason='平仓提交窗口已到，等待新盘口继续处理';break;}
        this.commitClose(p,reason,'best-opposite',requireProfit);p.closeAttemptedAt=Date.now();this.store.save();
      }catch(error){
        if(this.pauseUnconfirmedEntry(p,'平仓订单待核对，禁止重复提交')||error instanceof UncertainOrderError)return false;
        stopReason=error instanceof Error?error.message:'等待有效盘口和减仓参数';break;
      }
      const beforeLong=p.long.quantity,beforeShort=p.short.quantity;
      const results=await Promise.allSettled(prepared.map(order=>this.submitOrder(p,order)));
      if(this.pauseUnconfirmedEntry(p,'平仓订单状态待核对，禁止重复提交或使用成交下界继续平仓')){refreshPnl(p);this.store.save();return false;}
      if(results.some((result,index)=>result.status==='rejected'&&this.store.data.orders.some(order=>
        order.positionId===p.id&&order.request.clientOrderId===prepared[index].request.clientOrderId))){
        // A post-intent persistence/logging exception must settle before any compensation is sent.
        // Retain known native receipts; do not invent an unknown result or replay their quantities.
        const already=p.status==='attention';p.status='attention';p.riskReasons=['平仓成交记录保存中断，先核对原订单及账户，未提交额外补偿订单'];
        if(!already)this.context.halt(`${p.base} ${p.riskReasons[0]}`,p.base);
        refreshPnl(p);this.store.save();return false;
      }
      for(let index=0;index<results.length;index++){
        const result=results[index];if(result.status==='fulfilled'&&!canRetryCloseReceipt(result.value))blocked.add(prepared[index].leg.exchange);
      }
      if(results.some(result=>result.status==='rejected'&&result.reason instanceof UncertainOrderError))return false;
      if(pairedIntent&&!scopedFullClose&&!sameQuantity(p.long.quantity,p.short.quantity)&&!await this.repairBestCloseTail(p,startedAt,blocked))break;
      if(blocked.size){stopReason='交易所明确拒绝减仓，停止重复提交';break;}
      if(results.some(result=>result.status==='rejected')&&!(scopedFullClose&&c.mode==='live'&&this.context.refreshReductionSnapshots&&
        results.every((result,index)=>result.status==='fulfilled'||result.reason instanceof PreparedBookChangedError&&
          !this.store.data.orders.some(order=>order.positionId===p.id&&order.request.clientOrderId===prepared[index].request.clientOrderId)))){
        stopReason='提交前条件变化，保留已确认剩余仓位等待新盘口';break;
      }
      const changed=!sameQuantity(beforeLong,p.long.quantity)||!sameQuantity(beforeShort,p.short.quantity);
      zeroRounds=changed?0:zeroRounds+1;
      if(zeroRounds>=Math.max(1,Math.min(3,c.maxOrderRetries+1))){stopReason='本轮首档IOC未成交，等待新盘口后继续';break;}
    }
    if(p.closeRequestedAt===undefined)return false;
    if(economicStop){
      if(this.suspendAutomaticClose(p,stopReason))return false;
      if(p.closePauseReason)return false;
    }
    if(!pairedIntent&&p.long.quantity+p.short.quantity>0&&!blocked.size){
      p.status='closing';p.riskReasons=[stopReason];refreshPnl(p);this.store.save();return true;
    }
    return this.finishBestClose(p,stopReason,blocked);
  }
  async close(p:Position,reason:string,validateProfitExit?:CloseProfitValidation,options?:CloseExecutionOptions){
    if(!isPositionActive(p))return;
    this.beginOperation(p,options?.requireProfit===false?'manual-close':'close','ioc');
    try{return await this.closeOperation(p,reason,validateProfitExit,options);}
    catch(error){
      this.operation(p,id=>this.store.operations.wait(id,error instanceof UncertainOrderError?'original-order-reconciliation':'close-preparation',
        error instanceof UncertainOrderError?'原订单结果待核对，禁止重复提交':p.riskReasons[0]??'本轮减仓准备未通过，等待按原守卫重新核验'));
      throw error;
    }finally{this.operationObserved(p);}
  }
  private async closeOperation(p:Position,reason:string,validateProfitExit?:CloseProfitValidation,options?:CloseExecutionOptions){
    if(!isPositionActive(p))return;
    if(this.hasMakerClose(p)){
      if(options?.requireProfit===false){
        p.closeRequestedAt??=Date.now();p.closePricing=options.pricing;p.closeProfitRequired=false;p.closeReason=reason;
        this.store.save();this.requestMakerCloseStop(p,'用户减仓请求已到，先撤销原 Maker 余单并核对最终成交');
      }
      throw new UncertainOrderError('原 Maker 平仓仍在处理，先核对撤单和最终成交，禁止重复减仓');
    }
    const pricing=options?.pricing??p.closePricing??'depth',requireProfit=options?.requireProfit??p.closeProfitRequired??!!validateProfitExit;
    if(this.store.data.orders.some(o=>o.positionId===p.id&&isCurrentUnconfirmedOrder(o,this.store.data.positions)&&
      !(requireProfit&&pricing==='best-opposite'&&this.isNativeExitAuditOrder(p,o)))){
      // An explicit manual/emergency close must survive the outstanding original order so the
      // engine can reconcile its ID before reducing any confirmed residual. No new order is sent.
      // A new automatic profit signal does not create an unvalidated close intent.
      if(p.closeRequestedAt!==undefined||!requireProfit){
        p.closeRequestedAt??=Date.now();p.closePricing=pricing;p.closeProfitRequired=requireProfit;p.closeReason=reason;
        p.status='attention';p.riskReasons=['已记录平仓请求：原订单状态待核对，禁止重复提交'];this.store.save();
      }
      throw new UncertainOrderError('存在未确认订单，请先在交易所对账');
    }
    if(p.closeRequestedAt!==undefined&&(options?.pricing!==undefined||options?.requireProfit!==undefined)){
      p.closePricing=pricing;p.closeProfitRequired=requireProfit;this.store.save();
    }
    if(pricing==='best-opposite')return this.closeBestPriceBatches(p,reason,validateProfitExit,requireProfit);
    const pairedProfitIntent=requireProfit&&(p.long.quantity>0&&p.short.quantity>0||p.long.entryPrice>0&&p.short.entryPrice>0);
    if(pairedProfitIntent&&!validateProfitExit&&(p.closeRequestedAt===undefined||sameQuantity(p.long.quantity,p.short.quantity)))return false;
    let initialPrepared:PreparedOrder[]|undefined;
    if(validateProfitExit&&p.closeRequestedAt===undefined){
      // Before any durable close intent, both fresh books and the permitted IOC prices must still profit.
      await this.refresh(p,[p.long,p.short]);
      initialPrepared=[p.long,p.short].map(leg=>this.buildOrder(p,leg,leg.side==='long'?'sell':'buy',leg.quantity,true));
      await this.validateOrders(initialPrepared);
      if(initialPrepared.some(order=>order.request.quantity!==order.leg.quantity))return false;
      try{initialPrepared.forEach(order=>this.checkPreparedOrder(p,order));}catch{return false;}
      if(!validateProfitExit(initialPrepared[0].request.limitPrice,initialPrepared[1].request.limitPrice))return false;
    }
    // A close request survives unavailable books or unknown orders. The engine may resume reductions
    // only after fresh account reconciliation confirms the remaining quantities and all orders are terminal.
    if(p.closeRequestedAt===undefined){p.closeRequestedAt=Date.now();p.closePricing='depth';p.closeProfitRequired=requireProfit;}
    p.closeReason=reason;this.store.save();
    if(this.store.data.orders.some(o=>o.positionId===p.id&&isCurrentUnconfirmedOrder(o,this.store.data.positions)))throw new UncertainOrderError('存在未确认订单，请先在交易所对账');
    if(this.context.config().mode==='paper'&&this.paperFeeOnly(p)&&[p.long,p.short].some(leg=>leg.quantity>0&&!this.freshSnapshot(p,leg)))throw new Error('仓位缺少两侧最新可用盘口，等待更新后才能提交平仓');
    p.status='closing';this.store.save();
    let profitWait=false,economicStop=false;
    const closeStartedAt=Date.now(),blocked=this.closeRefusals(p);
    for(let retry=0;retry<=this.context.config().maxOrderRetries;retry++){
      // A saved profit intent is not permission to liquidate matched holdings after carry changes.
      // Already confirmed imbalance is repaired separately before attempting another common batch.
      if(pairedProfitIntent&&!sameQuantity(p.long.quantity,p.short.quantity)&&
        !await this.repairBestCloseTail(p,closeStartedAt,blocked))break;
      const remaining=[p.long,p.short].filter(l=>l.quantity>0);
      if(!remaining.length)break;
      if(retry>0&&this.context.config().mode==='live'&&!this.context.refreshSnapshots)break;
      p.closeAttemptedAt=Date.now();this.store.save();
      let prepared:PreparedOrder[];
      try{
        // Every confirmed residual gets a new quote before a new client order id is created.
        // Failed refreshes must reject; falling back to an older cached limit is forbidden.
        if(retry===0&&initialPrepared)prepared=initialPrepared;
        else{
          await this.refresh(p,remaining);
          prepared=remaining.map(leg=>this.buildOrder(p,leg,leg.side==='long'?'sell':'buy',leg.quantity,true));
          await this.validateOrders(prepared);
        }
        prepared.forEach(order=>this.checkPreparedOrder(p,order));
        if(pairedProfitIntent){
          const matched=prepared.length===2&&prepared.every(order=>sameQuantity(order.request.quantity,order.leg.quantity));
          if(!matched||!validateProfitExit?.(prepared[0].request.limitPrice,prepared[1].request.limitPrice)){
            profitWait=true;economicStop=matched&&!!validateProfitExit;break;
          }
        }
      }catch{break;}
      const results=await Promise.allSettled(prepared.map(order=>this.submitOrder(p,order)));
      // A result can include a confirmed fill lower bound while the order remains unknown.
      // In particular, persistence failures may throw before submitOrder marks that state itself.
      // Never resend a residual or declare flat before the original native order is terminal.
      if(this.pauseUnconfirmedEntry(p,'平仓订单状态待核对，禁止重复下单或将成交下界视为已平仓')){refreshPnl(p);this.store.save();return false;}
      if(results.some(r=>r.status==='rejected'&&r.reason instanceof UncertainOrderError))break;
      if(pairedProfitIntent&&results.some((result,index)=>result.status==='rejected'&&this.store.data.orders.some(order=>
        order.positionId===p.id&&order.request.clientOrderId===prepared[index].request.clientOrderId))){
        p.status='attention';p.riskReasons=['平仓成交记录保存中断，先核对原订单及账户，未提交额外补偿订单'];
        refreshPnl(p);this.store.save();return false;
      }
      if(pairedProfitIntent&&!sameQuantity(p.long.quantity,p.short.quantity)&&
        !await this.repairBestCloseTail(p,closeStartedAt,blocked))break;
      if(this.context.config().mode==='paper')break;
    }
    if(this.pauseUnconfirmedEntry(p,'平仓订单状态待核对，禁止将未确认成交下界视为已平仓')){refreshPnl(p);this.store.save();return false;}
    if(economicStop){
      if(this.suspendAutomaticClose(p,'资金费或当前允许成交价格不再满足自动退出条件，保留同量剩余仓位'))return false;
      if(p.closePauseReason)return false;
    }
    if(p.long.quantity===0&&p.short.quantity===0){p.status='closed';p.closedAt=Date.now();p.riskReasons=[];}
    else if(profitWait&&sameQuantity(p.long.quantity,p.short.quantity)){
      p.status='closing';p.riskReasons=['资金费或当前允许成交价格不再满足盈利条件，保留同量剩余仓位继续观察'];
    }
    else {p.status='attention';p.riskReasons=['平仓未完成，仍有实际敞口'];this.context.halt(`${p.base} 平仓未完成，请检查残余敞口`,p.base);}
    refreshPnl(p);this.store.save();
    return true;
  }
}
export function refreshPnl(p:Position){
  const floating=p.long.quantity*(p.long.markPrice-p.long.entryPrice)+p.short.quantity*(p.short.entryPrice-p.short.markPrice);
  p.spreadPnlUsd=p.realizedSpreadPnlUsd+floating;
  p.netPnlUsd=p.fundingUsd+p.spreadPnlUsd-p.feesUsd-p.transferCostUsd;
  p.deltaUsd=(p.long.quantity-p.short.quantity)*(p.long.markPrice+p.short.markPrice)/2;
}
