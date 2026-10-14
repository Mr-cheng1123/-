import type {FundingSchedule} from './funding-schedule.js';
import type {FundingEntryStabilityDto} from './funding-entry-stability.js';
export const EXCHANGES = ['binance','bybit','okx','gate','bitget'] as const;
export type ExchangeId = typeof EXCHANGES[number];
export type Side = 'buy'|'sell';
export interface BookLevel { price:number; quantity:number }
/** Account-specific native contract fee, observed through a signed GET. Never a configured/public fee. */
export interface TradingFeeMetadata {takerFeeRate:number;takerFeeAt:number;takerFeeSource:'exchange';
  makerFeeRate?:number;makerFeeAt?:number;makerFeeSource?:'exchange'|'simulation'}
/** A saved exact-account rate for estimates; it never grants fresh execution fee evidence. */
export interface TradingFeeReference {source:'account-reference';takerRate:number;makerRate?:number;observedAt:number}
/** Exact native contracts returned by an official bulk account-fee GET. */
export interface TradingFeeObservation extends TradingFeeMetadata {base:string;symbol:string}
export interface MarketSnapshot extends Partial<TradingFeeMetadata> {
  exchange:ExchangeId; base:string; symbol:string; timestamp:number;
  feeReference?:TradingFeeReference;
  feeProfile?:'standard'|'innovation'|'pre-market'|'unknown';
  /** When this process finished fetching the quote. `timestamp` is the exchange's event time, which for quiet books can be many
   *  seconds old even though the REST answer is current; cross-venue skew must be judged on fetch time, not event time. */
  observedAt?:number;
  /** Streaming books retain the independently observed funding/index metadata age. */
  bookTransport?:'rest'|'websocket';bookGeneration?:number;fundingObservedAt?:number;
  markPrice:number; indexPrice:number; fundingRate:number; nextFundingTime:number; intervalHours:number;
  predictedFundingRate?:number; fundingHistory:number[];
  bids:BookLevel[]; asks:BookLevel[]; openInterestUsd:number; volume24hUsd:number;
  quantityStep:number; minQuantity:number; minNotional:number; contractSize:number;
  source:'demo'|'public';
}
export interface ExchangeHealth { exchange:ExchangeId; status:'online'|'degraded'|'offline'|'connecting'; latencyMs:number; lastSuccess:number; error?:string; balanceUsd?:number; route?:'proxy'|'direct';endpoint?:string;errorCode?:string;retryAt?:number;accountStatus?:'ready'|'error';accountError?:string;accountUpdatedAt?:number }
export interface AppConfig {
  /** Funding carry uses observable round-trip book costs; dual additionally requires historical spread profit. */
  entryPolicy?:'aligned'|'funding'|'dual';
  mode:'paper'|'live'; dataSource:'demo'|'public'; fundingStatsSource:'auto'|'exchanges'|'coinglass'; paperFeeOnly:boolean; feeOnly:boolean; exchanges:ExchangeId[]; symbols:string[];
  pollIntervalMs:number; orderNotionalUsd:number; hedgeMode:'base'|'notional'; holdMode:'once'|'continuous'|'adaptive';
  adaptiveMinNetUsd:number; adaptiveConfirmations:number; adaptiveSettlementGraceSec:number;
  minEntryIocEdgeBps:number; exitWeakFundingBps:number; minExitProfitUsd:number;
  /** Net lifetime profit / frozen original one-leg opening notional. Defaults to 10 bps. */
  minExitProfitBps?:number;
  /** Automatic aligned exits use Maker when absent; IOC takes both current opposite-1 prices without resting. */
  profitExitExecutionMode?:'maker'|'ioc';
  dualAdvantageEnabled:boolean; spreadLookbackMinutes:number; spreadMinSamples:number;
  spreadMinSpanSec:number; spreadSampleIntervalSec:number; minSpreadAdvantageBps:number;
  /** Versioned defaults, or explicit custom settings that must survive a restart. */
  spreadWarmupProfile?:'responsive-v1'|'custom';
  minCombinedNetUsd:number; minEntryLeadSec:number; minSpreadNetUsd:number;
  minNetProfitUsd:number; minNetRateBps:number; maxBasisBps:number; maxSlippageBps:number;
  minOpenInterestUsd:number; minVolume24hUsd:number; maxSettlementSkewSec:number;
  entryWindowSec:number; exitDelaySec:number; maxSnapshotAgeMs:number; maxPositionPerCoinUsd:number;
  maxTotalPositionUsd:number; leverage:number; maxLeverage:number; maxDeltaUsd:number;
  /** New-entry contract margin preference. Absent legacy settings retain the venue's original preparation policy. */
  marginMode?:'crossed'|'isolated';
  bitgetNewSymbolMarginMode:'crossed'|'isolated';
  minLiquidationDistancePct:number; maxHoldHours:number; fundingSafetyFactor:number;
  transferCostUsd:number; rebalanceCostUsd:number; exitSlippageBps:number; basisStressBps:number;
  takerFees:Record<ExchangeId,number>;
  /** User-confirmed automatic rebate percentage, for estimates only. Missing venues receive no rebate. */
  feeRebatePct?:Partial<Record<ExchangeId,number>>;
  initialBalanceUsd:number; demoSettlementSec:number;
  maxOrderRetries:number; maxApiErrors:number; autoEnabled:boolean;
  /** New aligned entries complete their frozen target in at most this many best-price batches. */
  maxEntryBatches?:number;
  /** Visible IOC limit concession per leg; absent saved fields use 8 bps without changing saved policy. */
  entryIocBufferBps?:number;
  /** IOC remains the compatible default. Maker trial posts one bounded first-leg order, then hedges confirmed fills. */
  entryExecutionMode?:'ioc'|'maker-ioc';
  /** New aligned hedges enter the first small receiving cycle or last small paying cycle.
   * `last-payment` is the compatible saved key; absent old fields use this directional timing. */
  asyncFundingEntryTiming?:'last-payment'|'anytime';
  /** Both legs' quotes must be fetched within this window, otherwise the "spread" may be two different moments. */
  maxQuoteSkewMs:number;
}
/** One entry condition as shown on screen. `pass:null` = not a failed check; market/history data still waits,
 * while account balances are confirmed immediately before submission. `reason` equals the failing/waiting text. */
export interface EntryCheck {
  group:'funding'|'spread'|'timing'|'market'|'account'|'execution'; label:string; pass:boolean|null; reason:string; actual?:string; required?:string;
}
/** Conditional unchanged-basis round trip for one identical base-coin quantity on both venues.
 * Book costs are positive USD deductions; fees are separate and unknown account fees stay null.
 * Each spread half is measured against that venue's own best bid/ask midpoint, never a cross-venue basis. */
export interface RoundTripBookCost {
  quantity:number;longObservedAt:number;shortObservedAt:number;
  longOpenPrice:number;longClosePrice:number;shortOpenPrice:number;shortClosePrice:number;
  openingSpreadCostUsd:number;openingDepthImpactUsd:number;closingSpreadCostUsd:number;closingDepthImpactUsd:number;
  openingCostUsd:number;closingCostUsd:number;roundTripBookLossUsd:number;feesUsd:number|null;
}
export interface Opportunity {
  fundingSchedule?:FundingSchedule;
  /** Independent funding observations authorize automatic expansion only; manual readiness is unchanged. */
  fundingEntryStability?:FundingEntryStabilityDto;
  /** Reference fees qualify estimates only; financial execution still requires fresh exact-account rates. */
  feesSource?:'exchange'|'reference'|'simulation'|'pending';
  /** Ready after an explicit start, independently of the session's permission to submit. */
  entryReady?:boolean;
  /** Executable short-sale minus long-purchase prices; this is an entry advantage, not realized PnL. */
  entryPriceEdgeBps?:number|null;entryLimitPriceEdgeBps?:number|null;
  /** Current first batch only. Goal quantities and funding forecasts still describe the full target. */
  entryBatch?:{pricing:'best-opposite';targetQuantity:number;batchQuantity:number;longLimitPrice:number;shortLimitPrice:number;
    longBestPrice?:number;shortBestPrice?:number;longPriceBufferBps?:number;shortPriceBufferBps?:number;
    bookCost?:RoundTripBookCost;expectedFundingUsd?:number;expectedNetUsd?:number|null};
  /** Full target estimate; the first executable batch has an independently swept cost below. */
  bookCost?:RoundTripBookCost;
  longObservedAt?:number;shortObservedAt?:number;
  /** Aligned: repeated funding rounds to cover four trading fees; a conditional reference only. */
  breakEvenRounds?:number|null;
  /** Aligned: funding minus four fees at IOC opening limits and mark-based closing notionals.
   * Funding: funding plus unchanged-basis round-trip P&L after four fees. */
  entryLimitNetUsd?:number|null;
  entryPolicy?:'aligned'|'funding'|'dual';historicalSpreadAdvantage?:SpreadAdvantage;
  id:string; base:string; longExchange:ExchangeId; shortExchange:ExchangeId;
  longRate:number; shortRate:number; longIntervalHours:number; shortIntervalHours:number;
  longQuantity:number; shortQuantity:number; notionalUsd:number; grossExposureUsd:number;
  netRateBps:number; normalized8hBps:number; aprPct:number; capitalAprPct:number;
  expectedFundingUsd:number; feesUsd:number; slippageUsd:number; transferCostUsd:number; bookImpactUsd?:number;
  basisStressUsd:number; expectedNetUsd:number; basisBps:number; deltaUsd:number;
  nextFundingTime:number; exitTime:number; settlementSkewSec:number; liquidityUsd:number;
  eligible:boolean; reasons:string[]; checks?:EntryCheck[]; risk:'low'|'medium'|'high'; confidence:number;
  fundingAfterFeesUsd?:number; spreadAfterFeesUsd?:number|null; entryLimitSpreadAfterFeesUsd?:number|null;
  /** Aligned: funding after four fees, excluding book loss and unrealized basis income.
   * Other policies include their selected spread forecast. */
  combinedExpectedNetUsd?:number|null; spreadAdvantage?:SpreadAdvantage;
}
export interface SpreadObservation {
  base:string;longExchange:ExchangeId;shortExchange:ExchangeId;longSymbol:string;shortSymbol:string;
  source:MarketSnapshot['source'];notionalUsd:number;timestamp:number;longAt:number;shortAt:number;exitSpreadBps:number;
}
export interface SpreadAdvantage {
  estimateMethod?:'current-book'|'historical-median';
  status:'warming'|'ready';samples:number;requiredSamples:number;observedSpanSec:number;requiredSpanSec:number;
  longEntryPrice:number;shortEntryPrice:number;entrySpreadBps:number;
  expectedExitSpreadBps:number|null;spreadAdvantageBps:number|null;expectedSpreadPnlUsd:number|null;
  baselineUpdatedAt?:number;reason?:string;
}
export interface SpreadHistoryProvider {
  assess(long:MarketSnapshot,short:MarketSnapshot,quantity:number,config:AppConfig,now:number):SpreadAdvantage;
}
/** Exact native slot selected by a fresh account read; valid only for supported reduce-only routes. */
export interface ClosePositionSelector { side:'long'|'short';marginMode?:'isolated'|'crossed';positionId?:string;positionOpenedAt?:number }
export interface OrderRequest { clientOrderId:string; base:string; symbol:string; side:Side; quantity:number; limitPrice:number; reduceOnly:boolean;
  closePosition?:ClosePositionSelector;postOnly?:boolean }
/** Fixed confirmation diagnostics; an unknown result remains unknown regardless of this evidence. */
export interface OrderConfirmationDiagnostic {
  stage:'pre-submit'|'create'|'order-read'|'receipt';
  reason:'pre-submit-failed'|'request-failed'|'acknowledgement-missing'|'not-found'|'identity-mismatch'|'invalid-execution'|'nonterminal'|'fee-unverified'|'malformed-response';
  apiCode?:string;
  /** Bounded and redacted native business text; never proof of zero execution. */
  apiMessage?:string;
  observedAt?:number;
}
export interface OrderResult {
  id:string; clientOrderId:string; status:'filled'|'partial'|'cancelled'|'unknown';
  filledQuantity:number; averagePrice:number; feeUsd:number; timestamp:number;
  /** True only when complete, identity-matched individual fills establish the weighted price.
   * False preserves a confirmed order summary while declaring its price precision unverified. */
  averagePriceVerified?:boolean;
  /** Fixed, sanitized rejection details; never an original private exchange response. */
  rejectionReason?:string; rejectionCode?:string;
  /** Safe phase/reason only, never a raw private response or proof of zero execution. */
  confirmation?:OrderConfirmationDiagnostic;
  /** First create failure, independent of the latest original-order GET observation. */
  originalConfirmation?:OrderConfirmationDiagnostic;
  /** Local GET observation time. The native execution timestamp remains unchanged. */
  orderReadAt?:number;
}
/** Dedicated Maker reduction evidence. An active order remains unknown to legacy IOC receipt guards. */
export interface MakerReductionObservation {
  activity:'active'|'terminal'|'unknown';
  /** Complete identity-matched cumulative native fills, average price and actual USDT cash fees. */
  executionVerified:boolean;
  result:OrderResult;
  observedAt:number;
}
/** Fresh read-only observation of an active order, including untriggered conditional orders.
 * Quantities are base coins. Zero quantity may represent an exchange's close-all conditional order;
 * its presence still prevents declaring the symbol free of pending orders. */
export interface AccountOpenOrder {
  id:string;clientOrderId?:string;base:string;symbol:string;side?:Side;
  quantity:number;remainingQuantity:number;reduceOnly?:boolean;kind:'regular'|'conditional';
}
export interface AccountPosition extends Partial<TradingFeeMetadata> { base:string; symbol:string; side:'long'|'short'; quantity:number; markPrice:number; liquidationPrice:number; leverage:number;
  feeReference?:TradingFeeReference;
  /** Native split-position identity when the exchange supplies it as an exact string. */
  positionId?:string;
  /** Read-only aggregate of identified native positions; never an order-routing identity. */
  splitPositionCount?:number;positionMetricReason?:string;
  entryPrice?:number;unrealizedPnlUsd?:number;realizedPnlUsd?:number;fundingUsd?:number;feesUsd?:number;cashFlowAt?:number;cashFlowSince?:number;marginMode?:'crossed'|'isolated';
  /** Read-only bill evidence. Missing actual cash remains unknown; this does not describe contract fee-rate queries. */
  cashFlowStatus?:'loading'|'ready'|'incomplete'|'error'|'unavailable'|'stale';cashFlowReason?:string;
  /** Explicit venue meaning; numeric zero does not establish a real liquidation price. */
  liquidationStatus?:'price'|'not_liquidatable'|'unavailable';liquidationReason?:string;
  /** Current opening-cycle timestamps only when supplied unambiguously by the exchange. */
  positionOpenedAt?:number;positionUpdatedAt?:number }
export interface LivePortfolioExchange {
  exchange:ExchangeId;credentialsConfigured:boolean;status:'not_configured'|'loading'|'ready'|'error'|'stale';
  requestedAt?:number;receivedAt?:number;lastSuccessAt?:number;message?:string;
  positions:AccountPosition[];freeUsd?:number;equityUsd?:number;
}
export interface LivePortfolio {timestamp:number;pollIntervalMs:number;maxAgeMs:number;exchanges:LivePortfolioExchange[]}
export interface AccountState { freeUsd:number; equityUsd:number; positions:AccountPosition[]; positionMode?:string }
/** Read-only display values. Never use this overview as a live order budget or mode approval. */
export interface AccountOverview {
  freeUsd:number; equityUsd:number; positionCount:number; balanceScope?:'usdt_futures'|'unified_usdt';
  accountType?:'classic'|'unified';accountMode?:string;positionMode?:string;executionSupported?:boolean;
  usdtAvailableUsd?:number;marginAvailableUsd?:number;
  isolatedAvailableUsd?:number; spotAvailableUsd?:number; spotStatus?:'available'|'unavailable'; warnings?:string[];
}
export interface FundingPayment { id:string; timestamp:number; base:string; amountUsd:number;
  /** Optional native receipt ownership evidence. Quantity is in base coins, never raw contracts. */
  symbol?:string;side?:'long'|'short';quantity?:number }
/** Absolute logical-read budget; adapters must not restart it per page or retry. */
export interface ExchangeReadContext {deadlineAt?:number;signal?:AbortSignal}
export type PrivateReadContext=ExchangeReadContext;
export interface ExchangeAdapter {
  id:ExchangeId;
  getDiagnostics?():{symbol:string;code:string;message:string}[];
  getNetworkStatus?():{route:'proxy'|'direct';endpoint?:string;errorCode?:string;retryAt?:number}|undefined;
  fetchSnapshots(bases:string[],context?:ExchangeReadContext):Promise<MarketSnapshot[]>;
  /** Read-only streams. Starting them never prepares leverage or authorizes execution. */
  startRealtime?(publish:(snapshot:MarketSnapshot)=>void):void;
  seedRealtimeSnapshot?(snapshot:MarketSnapshot):void;
  setRealtimeBases?(bases:string[]):void;
  getExecutionSnapshot?(base:string):MarketSnapshot|undefined;
  fetchExecutionSnapshots?(bases:string[],context?:PrivateReadContext):Promise<MarketSnapshot[]>;
  /** Bounded public metadata renewal for realtime focus; genuine WS depth is reused, never relabeled ticker data. */
  refreshRealtimeMetadata?(bases:string[]):Promise<MarketSnapshot[]>;
  realtimeStatus?():import('./realtime.js').RealtimeStreamStatus[];
  fetchAccount(context?:PrivateReadContext):Promise<AccountState>;
  fetchPortfolioAccount?():Promise<AccountState>;
  /** Read native, unaggregated positions for an exact contract before manual slot reduction. GET only. */
  fetchClosePositions?(symbol:string):Promise<AccountPosition[]>;
  /** Account-specific fee for this exact USDT perpetual, GET only; priority promotes a queued read without bypassing cache/retry windows. */
  fetchTradingFee?(symbol:string,priority?:boolean):Promise<TradingFeeMetadata|undefined>;
  /** Bulk exact-contract observations, GET only; unsupported APIs return no observations. */
  fetchTradingFees?():Promise<TradingFeeObservation[]>;
  /** Real request-start timestamp of the last still-valid complete bulk table, including a successful empty table. */
  tradingFeeCatalogAt?():number|undefined;
  /** Fresh native fee cache only. Does not make a private request. */
  cachedTradingFee?(symbol:string):TradingFeeMetadata|undefined;
  /** Saved exact-account reference only. Never makes a request or establishes fresh execution evidence. */
  referenceTradingFee?(symbol:string):TradingFeeReference|undefined;
  fetchAccountOverview?():Promise<AccountOverview>;
  /** Read all current orders for one exact USDT perpetual symbol. GET only; throw when incomplete or unsupported. */
  fetchOpenOrders?(symbol:string,context?:PrivateReadContext):Promise<AccountOpenOrder[]>;
  /** Observe an existing order using GET only. Unlike reconcileOrder, never cancels an open order. */
  inspectOrder?(request:OrderRequest,orderId?:string):Promise<OrderResult>;
  /** Complete GET-only fill evidence for precise valuation; never prepares or cancels an order. */
  verifyOrderExecution?(request:OrderRequest,orderId?:string):Promise<OrderResult>;
  /** Explicit historical native opening cash proof; reads only and never prepares or sends an entry. */
  verifyOpeningExecution?(request:OrderRequest,orderId:string):Promise<OrderResult>;
  /** Read-only validation of a concrete symbol before either leg changes leverage or submits an order. */
  inspectTrading?(symbol:string,leverage:number):Promise<void>;
  /** Validate a concrete request without leverage changes or financial writes. */
  validateOrder?(request:OrderRequest):Promise<void>;
  /** Local metadata/quantity checks; native submission still validates actual reduction identity. */
  validateOrderLocally?(request:OrderRequest):Promise<void>;
  /** Separate, supervised PostOnly reduction route. Other entry/IOC routes retain their existing selectors. */
  supportsMakerReduction?():boolean;
  validateMakerReduction?(request:OrderRequest):Promise<void>;
  /** Submit once and return its ACK only; never waits for execution, cancels, or replays an uncertain create. */
  submitMakerReduction?(request:OrderRequest,canSubmit?:()=>boolean):Promise<OrderResult>;
  /** GET only. Active verified cumulative fills stay status unknown; terminal receipts alone become partial/filled/cancelled. */
  inspectMakerReduction?(request:OrderRequest,orderId?:string):Promise<MakerReductionObservation>;
  /** Cancel the exact acknowledged native ID. The ACK is not evidence that the order is inactive. */
  cancelMakerReduction?(request:OrderRequest,orderId:string):Promise<void>;
  prepareTrading(symbol:string,leverage:number):Promise<void>;
  placeOrder(request:OrderRequest,canSubmit?:()=>boolean):Promise<OrderResult>;
  reconcileOrder(request:OrderRequest,orderId?:string):Promise<OrderResult>;
  cancelOrder(symbol:string,orderId:string):Promise<void>;
  fetchFundingPayments(since:number,context?:PrivateReadContext):Promise<FundingPayment[]>;
  close():Promise<void>;
}
export interface PositionLeg { exchange:ExchangeId; symbol:string; side:'long'|'short'; quantity:number; entryPrice:number; markPrice:number; feesUsd:number; fundingUsd?:number; lastFundingAt?:number; fundingObservedAt?:number; fundingObservedSince?:number; realizedPnlUsd?:number; liquidationDistancePct:number|null;
  /** Exact account-row identity used only by read-only portfolio projections. */
  accountPositionKey?:string }
export interface ExitProfit { spreadPnlUsd:number; totalFeesUsd:number; fundingAfterFeesUsd:number; spreadAfterFeesUsd:number; netPnlUsd:number;
  /** Estimated automatic rebates are never actual booked funding, fees or cash. */
  estimatedFeeRebateUsd?:number;bookedFeeRebateUsd?:number;grossTotalFeesUsd?:number;grossClosingFeesUsd?:number }
export interface ProfitExitPolicy { firstFundingTime:number; earliestExitAt:number; minSpreadNetUsd:number; minCombinedNetUsd:number; fundingChecks:Array<{exchange:ExchangeId;timestamp:number}> }
/** Funding-only evidence. Future-rate projections never become booked cash or fill guarantees. */
export interface FundingExitStabilityDto {
  status:'positive'|'neutral'|'observing'|'confirmed'|'projection-wait'|'unavailable';reason:string;
  latestBps?:number;medianBps?:number;observedNextNetUsd?:number;projectedNetUsd?:number;
  neutralBandBps?:number;
  sampleCount:number;requiredSamples:number;observedSpanMs:number;requiredSpanMs:number;
  nextPaymentAt?:number;lastObservedAt?:number;
}
export interface HoldingDecision {
  fundingSchedule?:FundingSchedule;
  fundingExitStability?:FundingExitStabilityDto;
  action:'hold'|'close'|'wait';reason:string;expectedFundingUsd:number;incrementalCostUsd:number;expectedNetUsd:number;
  nextReviewAt:number;targetFundingTime:number;
  exitSignal?:'profit'|'funding-loss';exitProfit?:ExitProfit;
  fundingLossExit?:FundingLossExit;
}
/** Remaining exposure only; current-price forecasts do not prove future cash or full fills. */
export interface FundingLossExit {
  quantity:number;expectedFundingLossUsd:number;closingFeesUsd:number;spreadCostUsd:number;
  exitCostAllowanceUsd:number;minimumSavingsUsd:number;expectedSavingsUsd:number;
  nextPaymentAt?:number;paymentWindowOpen:boolean;
}
export interface EntryExecutionProgress {
  pricing:'best-opposite';targetQuantity:number;matchedQuantity:number;completedBatches:number;stopReason?:string;
}
/** Audits an explicit authority to reduce verified current exposure without resolving an old unknown IOC. */
export interface NativeExitRecoveryAudit {
  version:1;id:string;authorizedAt:number;parentClientOrderId:string;unknownClientOrderIds:string[];
  originalRemainingBudget:number;feeReserveUsd:number;lossReserveUsd:number;
  /** Explicit current filled Maker tail; historical unknowns still belong to parentClientOrderId. */
  confirmedTailParentClientOrderId?:string;confirmedTailParentFingerprint?:string;confirmedTailRemainingBudget?:number;
  /** Explicit original IOC pair; this persisted evidence never grants restart authority. */
  confirmedIocBatchId?:string;confirmedIocRemainingBudget?:number;
  confirmedIocOrders?:Array<{clientOrderId:string;financialFingerprint:string;nativeObservedAt?:number;localNoSend?:true}>;
  originalUnknowns:Array<{clientOrderId:string;financialFingerprint:string;originalResult:OrderResult}>;
  originalParentFingerprint:string;
  nativeReadEvidence:Array<{exchange:ExchangeId;requestedAt:number;symbol:string;side:'long'|'short';quantity:number;
    marginMode?:'crossed'|'isolated';positionId?:string;positionOpenedAt?:number;entryPrice?:number}>;
  noOpenOrders:Array<{exchange:ExchangeId;symbol:string;checkedAt:number}>;
  revokedAt?:number;revocationReason?:string;
  lateEvidence?:Array<{clientOrderId:string;observedAt:number;result:OrderResult}>;
}
export interface Position {
  /** Single fresh account anomalies pause entries; they never authorize orders or rewrite historical cash. */
  accountExposureIncidents?:import('../core/account-exposure-incident.js').AccountExposureIncident[];
  /** Independent confirmed external-exposure reductions do not replace the original position cash. */
  externalExposureReduction?:import('../core/external-exposure-reduction.js').ExternalExposureReduction;
  /** Evidence only: a restarted process must never adopt the recorded execution authority. */
  nativeExitRecoveryAudit?:NativeExitRecoveryAudit[];
  /** Explicit user-requested reductions, separate from automatic strategy management. */
  manualCloseOnly?:boolean;manualCloseOperationId?:string;manualCloseSourcePositionId?:string;
  /** Read-only diagnostic DTO, projected by Engine; never persisted on financial positions or used to authorize orders. */
  operationProgress?:import('./trading-operations.js').TradingOperation;
  /** Explicit, account-verified restoration preserves the finished manual intent as an independent audit. */
  currentManagementRestorationHistory?:import('../core/current-management-restoration.js').CurrentManagementRestorationAudit[];
  /** Imported reduction journal has no complete opening-fee/funding history; exclude from lifecycle totals. */
  manualCloseAccountRecord?:boolean;
  /** Frozen at entry; changing new-entry settings does not change a repair already in progress. */
  entryPolicy?:'aligned'|'funding'|'dual';
  /** New automatic entry only; absent historical/manual records retain their existing entry rules. */
  automaticEntry?:boolean;
  /** Frozen entry route, quote evidence and execution method; absent old records are not reconstructed guesses. */
  executionEvidence?:import('./execution-statistics.js').PositionExecutionEvidence;
  /** Execution progress, not an order receipt or a substitute for native current positions. */
  entryExecution?:EntryExecutionProgress;
  id:string; base:string; status:'opening'|'open'|'closing'|'closed'|'attention'; mode:'paper'|'live';
  paperFeeOnly?:boolean; feeOnly?:boolean;
  long:PositionLeg; short:PositionLeg; openedAt:number; closedAt?:number; plannedExitAt:number;
  holdMode:'once'|'continuous'|'adaptive';holdDecision?:HoldingDecision; fundingUsd:number; feesUsd:number; transferCostUsd:number;
  /** Read-only projection from confirmed positive order fees. Null means its rebate evidence is incomplete. */
  estimatedFeeRebateUsd?:number|null;
  estimatedNetPnlAfterRebateUsd?:number|null;
  /** Only newly opened joint adaptive positions opt into actual-profit capture. */
  profitExitPolicy?:ProfitExitPolicy;
  /** Average of both original leg opening notionals, frozen before the first profit reduction. */
  profitExitNotionalUsd?:number;
  spreadPnlUsd:number; realizedSpreadPnlUsd:number; netPnlUsd:number; deltaUsd:number;
  fundingEvents:string[]; riskReasons:string[]; closeReason?:string;
  closeRequestedAt?:number; closeAttemptedAt?:number;
  /** Close intent pricing and profit guard survive continuation; absent historical intents use depth. */
  closePricing?:'best-opposite'|'depth';
  /** Compatibility name: each new automatic batch must pass profit or funding-loss economics. */
  closeProfitRequired?:boolean;
  /** A cancelled economic signal waits for an independent account read before resuming held quantities. */
  closePauseReason?:string;
  /** Historical automatic reductions remain auditable after their active exit intent is suspended. */
  automaticCloseHistory?:Array<{requestedAt:number;attemptedAt?:number;suspendedAt:number;reason?:string;
    suspensionReason:string;pricing?:'best-opposite'|'depth';longQuantity:number;shortQuantity:number;
    /** Strict selected CURRENT recovery of a completed original IOC conditional intent; evidence only. */
    iocRestoration?:import('../core/current-ioc-close-restoration.js').CurrentIocCloseRestorationAudit;
    /** Original durable native terminal-zero observations reused only in an explicitly scoped recovery. */
    confirmedZeroOrders?:Array<{exchange:ExchangeId;symbol:string;clientOrderId:string;nativeOrderId:string;observedAt:number;committedAt:number}>}>;
  /** Current exposure independently confirmed flat; original fills and unresolved historical orders remain intact. */
  accountClosure?:{confirmedAt:number;reason:string;historicalOrdersPending:boolean};
}
export interface JournalOrder { positionId:string; exchange:ExchangeId; request:OrderRequest; result?:OrderResult; error?:string; createdAt:number;
  makerCloseComparison?:import('./maker-close-comparison.js').MakerCloseComparisonRecord;
  /** Active Maker reductions retain unknown receipt status; verified booked cash is independent of activity. */
  makerReduction?:{activity:'active'|'terminal'|'unknown';makerLeg:'long'|'short';deadlineAt:number;
    /** New minimal lot augmentation has its own order ID and retains the original terminal Maker budget. */
    lotTailOriginalParentClientId?:string;
    /** Verified cumulative observations do not grant a peer budget until the Maker is terminal and booked. */
    lotTailObservedExecution?:OrderResult;
    quantityStep?:number;peerQuantityStep?:number;peerMinQuantity?:number;cycleId?:string;attempt?:number;previousClientOrderId?:string;retryReason?:string;
    signalObservedAt?:number;submittedAt?:number;acknowledgedAt?:number;firstFillObservedAt?:number;
    lastFillObservedAt?:number;hedgeStartedAt?:number;hedgeCompletedAt?:number;finishedAt?:number;localVetoReason?:string;
    observationQueuedAt?:number;observationCommitStartedAt?:number;observationCommittedAt?:number;
    peerPreparationStartedAt?:number;peerPreparationCompletedAt?:number;peerAdapterStartedAt?:number;
    peerNativeCheckStartedAt?:number;peerNativeCheckCompletedAt?:number;
    peerPermissionVetoReason?:'native-proof'|'proof-age'|'scope'|'budget'|'book'|'authorization';
    peerLastFailureStage?:'book'|'validation'|'permission'|'submission'|'confirmation';
    /** Explicit native recheck links legacy peer cash without rewriting its original order evidence. */
    recoveredPeers?:{verifiedAt:number;clientOrderIds:string[]};
    tailRetryAt?:number;
    cancelRequestedAt?:number;lastObservedAt?:number;bookedExecution?:boolean;stopReason?:string};
  /** Earliest retained safe unknown diagnostic; old journals use only their existing evidence, never an inferred cause. */
  originalConfirmation?:OrderConfirmationDiagnostic;
  /** Read-only observations that could not be booked against their original unchanged scope. Never a fill or zero-execution proof. */
  reconciliationEvidence?:Array<{observedAt:number;reason:'scope-changed'|'late-read'|'unapplied-receipt';
    positionId:string;exchange:ExchangeId;request:OrderRequest;result:OrderResult}>;
  /** Explicit native cash correction preserves the original terminal receipt and its exact fee delta. */
  confirmedPeerFeeCorrections?:Array<{verifiedAt:number;previousBookedFeeUsd:number;feeDeltaUsd:number;
    originalResult:OrderResult;nativeResult:OrderResult}>;
  executionEvidence?:import('./execution-statistics.js').OrderExecutionEvidence;
  /** Local observation/confirmation timing, independent of exchange clock offsets. */
  execution?:{bookObservedAt:number;quoteAgeMs:number;bookTransport:'rest'|'websocket';confirmedAt?:number;confirmationMs?:number};
}
export interface LogEntry { id:string; timestamp:number; level:'info'|'warn'|'error'; message:string; context?:string }
export interface EquityPoint { timestamp:number; netPnlUsd:number; fundingUsd:number; feesUsd:number }
export interface LiveExchangeReadiness { exchange:ExchangeId; supported:boolean; credentialsConfigured:boolean;executionAuthorized?:boolean }
export interface LiveCoinExclusion { base:string; exchanges:ExchangeId[]; reasons:string[] }
export interface LiveReadiness { unlocked:boolean; ready:boolean; exchanges:LiveExchangeReadiness[]; reasons:string[]; excludedCoins?:LiveCoinExclusion[] }
/** Explicit account authorization check; no contract preparation, order submission or auto start. */
export interface LiveAuthorizationReport {
  checkedAt:number;autoEnabled:boolean;authorizedExchanges:ExchangeId[];
  accounts:Array<{exchange:ExchangeId;credentialsConfigured:boolean;executionAuthorized:boolean;
    status:'ready'|'insufficient'|'not_configured'|'disabled'|'error';freeUsd?:number;message:string}>;
}
export interface AppState {
  /** Sanitized progress receipts for explicit manual reductions, including failed preflights. */
  manualCloseOperations?:Array<{id:string;state:'checking'|'closing'|'completed'|'failed';positionId?:string;error?:string;createdAt:number}>;
  timestamp:number; config:AppConfig; running:boolean; autoEnabled:boolean; killSwitch:boolean;
  opportunities:Opportunity[]; snapshots:MarketSnapshot[]; exchanges:ExchangeHealth[];
  positions:Position[]; logs:LogEntry[]; equity:EquityPoint[];
  /** Read-only strategy evaluation; execution failures and incomplete cash histories remain separate. */
  performance?:import('./performance-types.js').PerformanceSummary;
  executionStatistics?:import('./execution-statistics.js').ExecutionStatisticsSummary;
  totals:{ fundingUsd:number; feesUsd:number; spreadPnlUsd:number; netPnlUsd:number; estimatedFeeRebateUsd?:number|null; estimatedNetPnlAfterRebateUsd?:number|null; grossExposureUsd:number; availableBalanceUsd:number|null; openPositions:number };
  risk:{status:'healthy'|'warning'|'halted'; reasons:string[]}; liveUnlocked:boolean; liveReadiness?:LiveReadiness;
  /** Unconfirmed journal entries remain visible even if general position reasons change. */
  unconfirmedOrders?:Array<{positionId:string;exchange:ExchangeId;historical?:boolean}>;
  /** Independent read-only exchange observations; never a trading budget or replacement for the order journal. */
  livePortfolio?:LivePortfolio;
  realtime?:import('./realtime.js').RealtimeStatus;
}
export interface HistoricalRow {
  timestamp:number; exchange:ExchangeId; base:string; markPrice:number; fundingRate:number;
  nextFundingTime:number; intervalHours:number; settledFundingRate?:number; bidPrice?:number; askPrice?:number;
  priceTimestamp?:number; openInterestUsd?:number; volume24hUsd?:number;
}
export interface BacktestResult { source:string; start:number; end:number; trades:number; winRatePct:number; fundingUsd:number; feesUsd:number; spreadPnlUsd:number; netPnlUsd:number; maxDrawdownUsd:number; equity:EquityPoint[]; warnings:string[]; closedTrades:Array<{base:string;openedAt:number;closedAt:number;netPnlUsd:number}> }
