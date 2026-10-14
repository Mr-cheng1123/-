import ccxt from 'ccxt';
import { EXCHANGES, type ExchangeId } from '../shared/types.js';
import { fundingCellIsFresh, type FundingStatsCell, type FundingStatsDataset } from '../shared/funding-statistics.js';
import { bitgetMarket, fundingClock, isEligibleMarket, milliseconds, number } from '../adapters/normalization.js';
import { classifyNetworkError, configureExchangeTransport, getExchangeNetworkStatus, networkMessage, withExchangeRequestContext, type NetworkCode } from '../adapters/network.js';

export interface ExchangeFundingStatisticsOptions {
  exchanges?: ExchangeId[];
  /** Injected public clients are useful for tests; no credentials are read by this service. */
  clients?: Partial<Record<ExchangeId, any>>;
  refreshIntervalMs?: number;
  deadlineMs?: number;
  maxAgeMs?: number;
  now?: () => number;
}
interface IntervalCache { at: number; values: Map<string, number> }
interface RequestContext { expired: boolean; controller: AbortController; generation: number; metadataLoad?: unknown }
interface VenueState {
  id: ExchangeId;
  client: any;
  cells: Map<string, FundingStatsCell>;
  metadataAt?: number;
  intervals?: IntervalCache;
  bybitMarkets?: Record<string, any>;
  inFlight?: Promise<void>;
  context?: RequestContext;
  generation: number;
  failures: number;
  nextAttemptAt: number;
  lastSuccess: number;
  error?: string;
}
class StatisticsTimeout extends Error { constructor() { super('Public funding statistics timeout'); } }

function publicClient(id: ExchangeId): any {
  const Constructor = (ccxt as any)[id === 'binance' ? 'binanceusdm' : id];
  const client = new Constructor({
    enableRateLimit: true, has: { fetchCurrencies: false },
    options: {
      defaultType: 'swap', defaultSubType: 'linear', defaultSettle: 'USDT', adjustForTimeDifference: false,
      fetchMarkets: { types: ['binance', 'bybit'].includes(id) ? ['linear'] : ['swap'] },
      ...(id === 'gate' ? { unifiedAccount: false, swap: { fetchMarkets: { settlementCurrencies: ['usdt'] } } } : {}),
    },
  });
  configureExchangeTransport(client, id);
  if (id === 'bitget') client.fetchMarkets = async () => {
    const response = await client.publicMixGetV2MixMarketContracts({ productType: 'USDT-FUTURES' });
    if (!Array.isArray(response.data)) throw new Error('Invalid contract metadata');
    return response.data.map(bitgetMarket).filter(Boolean);
  };
  return client;
}

const validInterval = (value: number): number | null => Number.isFinite(value) && value > 0 && value <= 24 ? value : null;

/** Trading-only native metadata avoids CCXT's extra PreLaunch query for this display feed. */
async function bybitTradingMarkets(client: any, ensureActive: () => void): Promise<Record<string, any>> {
  const markets: Record<string, any> = {}, cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 64; page++) {
    ensureActive();
    const response = await client.publicGetV5MarketInstrumentsInfo({ category: 'linear', status: 'Trading', limit: 1000, ...(cursor ? { cursor } : {}) });
    ensureActive();
    const data = response?.result;
    if (response?.retCode !== 0 || data?.category !== 'linear' || !Array.isArray(data.list)) throw new Error('Invalid Bybit trading metadata');
    for (const raw of data.list) {
      if (raw?.status !== 'Trading' || raw?.contractType !== 'LinearPerpetual' || raw?.quoteCoin !== 'USDT' || raw?.settleCoin !== 'USDT' || typeof raw?.baseCoin !== 'string' || !raw.baseCoin || typeof raw?.symbol !== 'string' || !raw.symbol) continue;
      const base = typeof client.safeCurrencyCode === 'function' ? client.safeCurrencyCode(raw.baseCoin) : raw.baseCoin;
      if (typeof base !== 'string' || !base) continue;
      const symbol = `${base}/USDT:USDT`;
      // Keep native IDs until rates are joined. Two IDs sharing a base are ambiguous
      // and must reach duplicate filtering instead of overwriting at market discovery.
      markets[raw.symbol] = { id: raw.symbol, symbol, base, active: true, swap: true, linear: true, quote: 'USDT', settle: 'USDT', contractSize: 1, info: raw };
    }
    const next = data.nextPageCursor;
    if (next === undefined || next === null || next === '') {
      if (!Object.keys(markets).length) throw new Error('No valid Bybit trading metadata');
      return markets;
    }
    if (typeof next !== 'string' || cursors.has(next)) throw new Error('Invalid Bybit metadata pagination');
    cursors.add(next); cursor = next;
  }
  throw new Error('Bybit metadata pagination did not terminate');
}

async function bybitBulkRates(client: any, ensureActive: () => void): Promise<any[]> {
  ensureActive();
  const response = await client.publicGetV5MarketTickers({ category: 'linear' });
  ensureActive();
  if (response?.retCode !== 0 || response?.result?.category !== 'linear' || !Array.isArray(response.result.list)) throw new Error('Invalid Bybit funding tickers');
  return response.result.list.map((raw: any) => ({ id: raw.symbol, fundingRate: raw.fundingRate, fundingTimestamp: raw.nextFundingTime, timestamp: response.time, info: raw }));
}

function retryDelay(code: NetworkCode, failures: number, refreshIntervalMs: number): number {
  if (code === 'REGION_BLOCKED' || code === 'ACCESS_DENIED') return 60_000;
  if (code === 'RATE_LIMITED') return Math.min(60_000, 10_000 * 2 ** Math.min(failures - 1, 3));
  if (code === 'API_ERROR') return refreshIntervalMs;
  return Math.min(refreshIntervalMs, 3000 * 2 ** Math.min(failures - 1, 4));
}

function cellFor(id: ExchangeId, rate: any, market: any, receivedAt: number, intervals?: IntervalCache): FundingStatsCell | null {
  const fundingRate = number(rate.fundingRate);
  if (!Number.isFinite(fundingRate)) return null;
  const raw = rate.info ?? {};
  let funding = rate;
  if (id === 'binance' && !rate.interval && intervals && receivedAt - intervals.at < 120000) {
    // Binance's successfully fetched fundingInfo enumerates exceptions to its documented 8h default.
    funding = { ...rate, interval: `${intervals.values.get(market.id) ?? 8}h` };
  }
  const nextRaw = id === 'okx' ? raw.fundingTime ?? funding.fundingTimestamp
    : funding.fundingTimestamp ?? raw.nextFundingTime ?? raw.nextUpdate ?? raw.funding_next_apply ?? raw.next_funding_time ?? funding.nextFundingTimestamp;
  const nextValue = milliseconds(nextRaw);
  let nextFundingTime = Number.isFinite(nextValue) && nextValue > 0 ? nextValue : null;
  let intervalHours: number | null = null;
  try {
    const clock = fundingClock(id, funding, market, [], receivedAt);
    nextFundingTime = clock.nextFundingTime; intervalHours = clock.intervalHours;
  } catch {
    // Statistics can still show the actual rate when one clock field is absent. Never infer a cycle from a default.
    const match = /^(\d+(?:\.\d+)?)([hm])$/.exec(String(funding.interval ?? ''));
    let interval = id === 'bybit' && number(raw.fundingIntervalHour) > 0 ? number(raw.fundingIntervalHour)
      : match ? Number(match[1]) / (match[2] === 'm' ? 60 : 1) : NaN;
    if (!(interval > 0)) {
      if (id === 'okx' && nextFundingTime !== null) interval = (milliseconds(raw.nextFundingTime ?? funding.nextFundingTimestamp) - nextFundingTime) / 3600000;
      if (id === 'bybit') interval = number(market.info?.fundingInterval) / 60;
      if (id === 'gate') interval = number(raw.funding_interval ?? market.info?.funding_interval) / 3600;
      if (id === 'binance') interval = number(raw.fundingIntervalHours ?? market.info?.fundingIntervalHours);
      if (id === 'bitget') interval = number(raw.fundingRateInterval ?? raw.ratePeriod ?? market.info?.fundInterval);
    }
    intervalHours = validInterval(interval);
  }
  // fundingTimestamp describes a future settlement, never the quote's observation time.
  const observed = milliseconds(funding.timestamp ?? (id === 'binance' ? raw.time : raw.ts));
  const hasObservation = Number.isFinite(observed) && observed > 0;
  const cell: FundingStatsCell = {
    exchange: id, rate: fundingRate, intervalHours, nextFundingTime,
    updatedAt: hasObservation ? observed : receivedAt, timestampKind: hasObservation ? 'exchange' : 'received',
    available: true,
  };
  const predicted = number(funding.nextFundingRate);
  if (Number.isFinite(predicted)) cell.predictedRate = predicted;
  if (id === 'gate') {
    const oi = number(raw.position_size) * number(market.contractSize) * number(funding.markPrice ?? raw.mark_price);
    if (Number.isFinite(oi) && oi >= 0) cell.openInterestUsd = oi;
  }
  if (id === 'bybit') {
    // Current Bybit distinguishes single-side OI from both-side OI. Do not mix their weighting bases.
    const oi = number(raw.singleOpenInterestValue);
    if (Number.isFinite(oi) && oi >= 0) cell.openInterestUsd = oi;
    const volume = number(raw.turnover24h);
    if (Number.isFinite(volume) && volume >= 0) cell.volume24hUsd = volume;
  }
  return cell;
}

/** A display-only, all-symbol feed. It never supplies execution quotes or requests order books/private APIs. */
export class ExchangeFundingStatistics {
  private readonly venues: VenueState[];
  private readonly now: () => number;
  private readonly refreshIntervalMs: number;
  private readonly deadlineMs: number;
  private readonly maxAgeMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private lastAttemptAt = 0;

  constructor(options: ExchangeFundingStatisticsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.refreshIntervalMs = Math.max(1000, options.refreshIntervalMs ?? 20000);
    this.deadlineMs = Math.min(10000, Math.max(1, options.deadlineMs ?? 10000));
    // Bulk funding endpoints can return published rates older than a polling interval.
    // This display-only cache keeps their original timestamps; execution still enforces its own 30s limit.
    this.maxAgeMs = options.maxAgeMs ?? 120000;
    this.venues = [...new Set(options.exchanges ?? EXCHANGES)].map(id => ({
      id, client: options.clients?.[id] ?? publicClient(id), cells: new Map(), lastSuccess: 0, generation: 0, failures: 0, nextAttemptAt: 0,
    }));
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.refresh();
    this.timer = setInterval(() => {
      // Each venue owns its retry time. A ten-second outage cannot hold healthy venues
      // or delay another venue's recovery until the next global twenty-second batch.
      void this.refresh(false);
    }, 1000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const venue of this.venues) if (venue.context) { venue.context.expired = true; venue.context.controller.abort(); }
    await Promise.allSettled(this.venues.map(venue => venue.client.close?.()));
  }

  refresh(force = true): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return Promise.allSettled(this.venues.filter(venue => force || this.now() >= venue.nextAttemptAt).map(venue => this.refreshVenue(venue))).then(() => undefined);
  }

  get(): FundingStatsDataset {
    const byBase = new Map<string, FundingStatsDataset['rows'][number]>();
    for (const venue of this.venues) for (const [base, cell] of venue.cells) {
      const row = byBase.get(base) ?? { base, cells: {} };
      row.cells[venue.id] = { ...cell }; byBase.set(base, row);
    }
    const dataset: FundingStatsDataset = {
      source: 'exchanges', range: 'current', status: 'loading',
      rows: [...byBase.values()].sort((a, b) => a.base.localeCompare(b.base)),
      receivedAt: Math.max(0, ...this.venues.map(venue => venue.lastSuccess)),
      lastAttemptAt: this.lastAttemptAt, nextRefreshAt: this.timer && !this.stopped && this.venues.length ? Math.min(...this.venues.map(venue => venue.nextAttemptAt)) : 0, maxAgeMs: this.maxAgeMs,
      sourceUrl: 'https://docs.ccxt.com/#/README?id=exchanges',
      marginScope: '五家交易所公开接口 · 仅有效 USDT 本位线性永续 · 保留合约基础币名称',
    };
    const now = this.now();
    let fresh = 0;
    for (const row of dataset.rows) for (const cell of Object.values(row.cells)) {
      cell.available = fundingCellIsFresh(cell, dataset, now); if (cell.available) fresh++;
    }
    const failures = this.venues.filter(venue => venue.error).map(venue => `${venue.id}: ${venue.error}`);
    dataset.status = fresh ? 'ready' : dataset.rows.length ? 'stale' : failures.length ? 'error' : 'loading';
    if (failures.length) dataset.message = `部分数据暂不可用；保留的旧值不参与统计。${failures.join('；')}`;
    else if (dataset.status === 'stale') dataset.message = '资金费率统计已过期，等待公开接口更新';
    else if (dataset.status === 'loading') dataset.message = '正在同步五家交易所的全部有效 USDT 永续资金费率';
    return dataset;
  }

  private refreshVenue(venue: VenueState): Promise<void> {
    if (venue.inFlight) return venue.inFlight;
    const context: RequestContext = { expired: false, controller: new AbortController(), generation: ++venue.generation };
    venue.context = context; this.lastAttemptAt = this.now(); venue.nextAttemptAt = this.now() + this.deadlineMs;
    const operation = this.runVenue(venue, context);
    venue.inFlight = operation;
    void operation.then(() => { if (venue.inFlight === operation) { venue.inFlight = undefined; venue.context = undefined; } });
    return operation;
  }

  private async runVenue(venue: VenueState, context: RequestContext): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: (() => void) | undefined;
    try {
      const request = withExchangeRequestContext(venue.client, { signal: context.controller.signal, deadlineAt: Date.now() + this.deadlineMs }, () => this.acquire(venue, context));
      const cells = await Promise.race([request, new Promise<Map<string, FundingStatsCell>>((_, reject) => {
        rejectAbort = () => reject(new StatisticsTimeout());
        context.controller.signal.addEventListener('abort', rejectAbort, { once: true });
        timer = setTimeout(() => { context.expired = true; context.controller.abort(); reject(new StatisticsTimeout()); }, this.deadlineMs);
      })]);
      if (this.stopped || context.expired || venue.generation !== context.generation) return;
      // Publish each successful venue immediately; another venue's timeout cannot delay these cells.
      for (const cell of venue.cells.values()) cell.available = false;
      for (const [base, cell] of cells) venue.cells.set(base, cell);
      venue.lastSuccess = this.now(); venue.error = undefined; venue.failures = 0; venue.nextAttemptAt = this.now() + this.refreshIntervalMs;
    } catch (error) {
      context.expired = true; context.controller.abort();
      // CCXT retains a rejected/aborted marketsLoading promise. Clearing only this
      // generation's loader lets the next attempt recover without recreating clients.
      if (context.metadataLoad && venue.client.marketsLoading === context.metadataLoad) { venue.client.marketsLoading = undefined; venue.client.reloadingMarkets = false; }
      if (this.stopped || venue.generation !== context.generation) return;
      for (const cell of venue.cells.values()) cell.available = false;
      const network = getExchangeNetworkStatus(venue.client);
      const code = error instanceof StatisticsTimeout ? 'TIMEOUT' : classifyNetworkError(error, network?.route === 'proxy');
      venue.error = networkMessage(code);
      venue.failures++;
      venue.nextAttemptAt = this.now() + Math.max(retryDelay(code, venue.failures, this.refreshIntervalMs), (network?.retryAt ?? 0) - Date.now());
    } finally { if (timer) clearTimeout(timer); if (rejectAbort) context.controller.signal.removeEventListener('abort', rejectAbort); }
  }

  private async acquire(venue: VenueState, context: RequestContext): Promise<Map<string, FundingStatsCell>> {
    const ensureActive = () => { if (context.expired || this.stopped || venue.generation !== context.generation) throw new StatisticsTimeout(); };
    const reload = venue.metadataAt !== undefined && this.now() - venue.metadataAt >= 3600000;
    const nativeBybit = venue.id === 'bybit' && typeof venue.client.publicGetV5MarketInstrumentsInfo === 'function' && typeof venue.client.publicGetV5MarketTickers === 'function';
    if (nativeBybit) {
      // Two bulk public calls can start together on cold load; subsequent rounds use
      // one ticker request. No PreLaunch products or per-symbol funding requests.
      const [markets, rates] = await Promise.all([
        venue.bybitMarkets && !reload ? Promise.resolve(venue.bybitMarkets) : bybitTradingMarkets(venue.client, ensureActive),
        bybitBulkRates(venue.client, ensureActive),
      ]);
      ensureActive();
      venue.bybitMarkets = markets;
      if (venue.metadataAt === undefined || reload) venue.metadataAt = this.now();
      const byId = new Map(Object.values(markets).map(market => [market.id, market]));
      const cells = new Map<string, FundingStatsCell>(), duplicates = new Set<string>(), receivedAt = this.now();
      for (const rate of rates) {
        const market = byId.get(rate.id); if (!market) continue;
        const cell = cellFor(venue.id, rate, market, receivedAt); if (!cell) continue;
        if (cells.has(market.base)) duplicates.add(market.base);
        cells.set(market.base, cell);
      }
      for (const base of duplicates) cells.delete(base);
      if (!cells.size) throw new Error('No valid USDT perpetual funding statistics');
      return cells;
    }
    const loading = venue.client.loadMarkets(reload);
    context.metadataLoad = venue.client.marketsLoading ?? loading;
    const markets = await loading;
    ensureActive(); if (venue.metadataAt === undefined || reload) venue.metadataAt = this.now();
    const params = venue.id === 'bitget' ? { method: 'publicMixGetV2MixMarketCurrentFundRate', productType: 'USDT-FUTURES' }
      : venue.id === 'gate' ? { settle: 'usdt' } : venue.id === 'bybit' ? { category: 'linear' } : {};
    // At most two bulk requests after metadata; no per-symbol polling, history, or order-book requests.
    const [ratesResult] = await Promise.allSettled([
      venue.client.fetchFundingRates(undefined, params),
      this.refreshIntervals(venue, context),
    ]);
    ensureActive();
    if (ratesResult.status === 'rejected') throw ratesResult.reason;
    const rates = ratesResult.value;
    if (!rates || typeof rates !== 'object' || Array.isArray(rates)) throw new Error('Invalid funding statistics response');
    const cells = new Map<string, FundingStatsCell>(), duplicates = new Set<string>(), receivedAt = this.now();
    for (const [key, funding] of Object.entries(rates) as [string, any][]) {
      const market = markets?.[funding?.symbol ?? key];
      if (!isEligibleMarket(market) || typeof market.base !== 'string' || !market.base) continue;
      const cell = cellFor(venue.id, funding, market, receivedAt, venue.intervals);
      if (!cell) continue;
      if (cells.has(market.base)) duplicates.add(market.base);
      cells.set(market.base, cell);
    }
    for (const base of duplicates) cells.delete(base); // ambiguous same-venue contracts must not silently overwrite one another.
    if (!cells.size) throw new Error('No valid USDT perpetual funding statistics');
    return cells;
  }

  private async refreshIntervals(venue: VenueState, context: RequestContext): Promise<void> {
    if (venue.id !== 'binance' || typeof venue.client.fapiPublicGetFundingInfo !== 'function') return;
    if (venue.intervals && this.now() - venue.intervals.at < 60000) return;
    const rows = await venue.client.fapiPublicGetFundingInfo();
    if (!Array.isArray(rows)) throw new Error('Invalid funding interval metadata');
    const values = new Map<string, number>();
    for (const row of rows) {
      const interval = validInterval(number(row.fundingIntervalHours));
      if (typeof row.symbol !== 'string' || !row.symbol || interval === null) throw new Error('Invalid funding interval metadata');
      values.set(row.symbol, interval);
    }
    if (!context.expired && !this.stopped) venue.intervals = { at: this.now(), values };
  }
}
