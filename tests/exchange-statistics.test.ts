import test from 'node:test';
import assert from 'node:assert/strict';
import { ExchangeFundingStatistics } from '../src/data/exchange-funding-statistics.js';
import { comparableRate, fundingCellIsFresh } from '../src/shared/funding-statistics.js';
import { EXCHANGES, type ExchangeId } from '../src/shared/types.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
function market(base = 'BTC', changes: Record<string, unknown> = {}) {
  return { id: `${base}USDT`, symbol: `${base}/USDT:USDT`, base, active: true, swap: true,
    linear: true, quote: 'USDT', settle: 'USDT', contractSize: 1, info: {}, ...changes };
}
function rate(base = 'BTC', changes: Record<string, unknown> = {}) {
  return { symbol: `${base}/USDT:USDT`, fundingRate: .0001, fundingTimestamp: NOW + HOUR,
    interval: '8h', info: {}, ...changes };
}
function client(markets: any[] = [market()], rates: any[] = [rate()]) {
  const calls: { symbols: unknown; params: any }[] = [], reloads: boolean[] = [];
  return { calls, reloads,
    loadMarkets: async (reload: boolean) => { reloads.push(reload); return Object.fromEntries(markets.map(m => [m.symbol, m])); },
    fetchFundingRates: async (symbols?: unknown, params?: any) => { calls.push({ symbols, params }); return Object.fromEntries(rates.map(r => [r.symbol, r])); },
    close: async () => {},
  };
}
async function within<T>(operation: Promise<T>, timeoutMs = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Funding statistics remained blocked')), timeoutMs);
  })]); } finally { if (timer) clearTimeout(timer); }
}

test('five-venue bulk rates preserve decimal units, actual intervals, and next settlement semantics', async () => {
  const clients: Partial<Record<ExchangeId, any>> = {
    binance: { ...client([market()], [rate('BTC', { interval: undefined, fundingRate: -.0001, timestamp: NOW })]), fapiPublicGetFundingInfo: async () => [] },
    bybit: client([market('BTC', { info: { fundingInterval: 480 } })], [rate('BTC', { info: { fundingIntervalHour: '4', singleOpenInterestValue: '100', openInterestValue: '200', turnover24h: '2000' } })]),
    okx: client([market()], [rate('BTC', { interval: undefined, nextFundingRate: .0002, info: { fundingTime: NOW + HOUR, nextFundingTime: NOW + 5 * HOUR, ts: NOW } })]),
    gate: client([market('BTC', { contractSize: .001 })], [rate('BTC', { interval: undefined, markPrice: 30000, info: { funding_interval: 3600, position_size: 100 } })]),
    bitget: client([market()], [rate('BTC', { interval: undefined, fundingTimestamp: undefined, info: { fundingRateInterval: '2', nextUpdate: NOW + 2 * HOUR } })]),
  };
  const feed = new ExchangeFundingStatistics({ clients, now: () => NOW });
  try {
    await feed.refresh();
    const data = feed.get(), cells = data.rows[0].cells;
    assert.equal(data.source, 'exchanges'); assert.equal(data.status, 'ready'); assert.equal(data.rows.length, 1);
    assert.equal(cells.binance?.rate, -.0001); assert.equal(cells.binance?.intervalHours, 8);
    assert.equal(cells.bybit?.intervalHours, 4); assert.equal(comparableRate(cells.bybit!, 'current', '8h'), .0002);
    assert.equal(cells.bybit?.openInterestUsd, 100); assert.equal(cells.bybit?.volume24hUsd, 2000);
    assert.equal(cells.okx?.nextFundingTime, NOW + HOUR); assert.equal(cells.okx?.intervalHours, 4); assert.equal(cells.okx?.predictedRate, .0002);
    assert.equal(cells.gate?.intervalHours, 1); assert.equal(cells.gate?.openInterestUsd, 3000);
    assert.equal(cells.bitget?.intervalHours, 2); assert.equal(cells.bitget?.nextFundingTime, NOW + 2 * HOUR);
    assert.equal(cells.okx?.timestampKind, 'exchange'); assert.equal(cells.gate?.timestampKind, 'received');
    for (const id of EXCHANGES) { assert.equal(clients[id].calls.length, 1); assert.equal(clients[id].calls[0].symbols, undefined); }
    assert.deepEqual(clients.bitget.calls[0].params, { method: 'publicMixGetV2MixMarketCurrentFundRate', productType: 'USDT-FUTURES' });
    assert.equal(cells.bitget?.openInterestUsd, undefined);
  } finally { await feed.stop(); }
});

test('only exact active linear USDT perpetual identities are grouped; multiplier tokens stay distinct', async () => {
  const markets = [market(), market('PEPE'), market('1000PEPE'), market('DEAD', { active: false }), market('SPOT', { swap: false }), market('INVERSE', { linear: false }), market('USDC', { settle: 'USDC' })];
  const bybit = client(markets, [...markets.map(m => rate(m.base)), rate('UNLISTED')]);
  const gate = client([market('PEPE')], [rate('PEPE', { fundingRate: -.0003 })]);
  const feed = new ExchangeFundingStatistics({ exchanges: ['bybit', 'gate'], clients: { bybit, gate }, now: () => NOW });
  try {
    await feed.refresh(); const rows = feed.get().rows;
    assert.deepEqual(rows.map(r => r.base), ['1000PEPE', 'BTC', 'PEPE']);
    assert.deepEqual(Object.keys(rows.find(r => r.base === 'PEPE')!.cells).sort(), ['bybit', 'gate']);
    assert.deepEqual(Object.keys(rows.find(r => r.base === '1000PEPE')!.cells), ['bybit']);
  } finally { await feed.stop(); }
});

test('missing interval metadata is null and does not become an invented 8h rate', async () => {
  const binance = client([market(), market('ETH')], [rate('BTC', { interval: undefined }), rate('ETH', { interval: undefined, fundingTimestamp: undefined })]);
  const feed = new ExchangeFundingStatistics({ exchanges: ['binance'], clients: { binance }, now: () => NOW });
  try {
    await feed.refresh(); const rows = feed.get().rows;
    for (const row of rows) { assert.equal(row.cells.binance?.intervalHours, null); assert.equal(comparableRate(row.cells.binance!, 'current', '8h'), null); }
    assert.equal(rows.find(r => r.base === 'BTC')!.cells.binance?.nextFundingTime, NOW + HOUR);
    assert.equal(rows.find(r => r.base === 'ETH')!.cells.binance?.nextFundingTime, null);
  } finally { await feed.stop(); }
});

test('Binance interval exceptions are cached and expired metadata cannot assert an 8h default', async () => {
  let now = NOW, intervalCalls = 0, fail = false;
  const binance = { ...client([market(), market('ETH')], [rate('BTC', { interval: undefined }), rate('ETH', { interval: undefined })]),
    fapiPublicGetFundingInfo: async () => { intervalCalls++; if (fail) throw new Error('metadata unavailable'); return [{ symbol: 'ETHUSDT', fundingIntervalHours: 4 }]; },
  };
  const feed = new ExchangeFundingStatistics({ exchanges: ['binance'], clients: { binance }, now: () => now });
  try {
    await feed.refresh(); await feed.refresh(); assert.equal(intervalCalls, 1);
    assert.equal(feed.get().rows.find(r => r.base === 'ETH')!.cells.binance?.intervalHours, 4);
    now += 121000; fail = true; await feed.refresh();
    assert.equal(intervalCalls, 2); assert.equal(feed.get().rows[0].cells.binance?.intervalHours, null);
  } finally { await feed.stop(); }
});

test('failed venues keep unavailable prior cells while healthy venues publish fresh rates', async () => {
  let now = NOW;
  const binance = client(), bybit = client();
  const feed = new ExchangeFundingStatistics({ exchanges: ['binance', 'bybit'], clients: { binance, bybit }, now: () => now });
  try {
    await feed.refresh(); now += 1000;
    binance.fetchFundingRates = async () => { throw new Error('https://secret:password@host?api_key=private'); };
    bybit.fetchFundingRates = async () => ({ 'BTC/USDT:USDT': rate('BTC', { fundingRate: .0007 }) });
    await feed.refresh(); const data = feed.get(), cells = data.rows[0].cells;
    assert.equal(data.status, 'ready'); assert.equal(cells.binance?.rate, .0001); assert.equal(cells.binance?.available, false);
    assert.equal(cells.binance?.updatedAt, NOW); assert.equal(cells.bybit?.rate, .0007); assert.equal(cells.bybit?.available, true);
    assert.doesNotMatch(data.message ?? '', /secret|password|api_key|https/);
    now += 121000; assert.equal(feed.get().status, 'stale');
  } finally { await feed.stop(); }
});

test('one stuck venue neither blocks publishing nor overlaps; timeout releases it and late expired results cannot overwrite recovery', async () => {
  const binance = client(), bybit = client();
  let resolveLate!: (rates: Record<string, any>) => void, requests = 0;
  const late = new Promise<Record<string, any>>(resolve => { resolveLate = resolve; });
  binance.fetchFundingRates = async () => { requests++; return requests === 1 ? late : { 'BTC/USDT:USDT': rate('BTC', { fundingRate: .0008 }) }; };
  const feed = new ExchangeFundingStatistics({ exchanges: ['binance', 'bybit'], clients: { binance, bybit }, now: () => NOW, deadlineMs: 30 });
  try {
    const first = feed.refresh(), concurrent = feed.refresh(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(feed.get().rows[0].cells.bybit?.available, true); // published before the other venue's deadline.
    assert.equal(requests, 1); // concurrent refreshes share the same active generation.
    await within(first); await within(concurrent);
    await within(feed.refresh()); assert.equal(requests, 2); assert.equal(feed.get().rows[0].cells.binance?.rate, .0008);
    resolveLate({ 'BTC/USDT:USDT': rate('BTC', { fundingRate: .99 }) });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(feed.get().rows[0].cells.binance?.rate, .0008);
    assert.equal(feed.get().rows[0].cells.binance?.available, true);
  } finally { await feed.stop(); }
});

test('a rejected CCXT marketsLoading cache is reset and the next generation can load metadata', async () => {
  let metadataCalls = 0;
  const binance = { ...client(), marketsLoading: undefined as Promise<Record<string, any>> | undefined, reloadingMarkets: false,
    loadMarkets() {
      if (!this.marketsLoading) {
        metadataCalls++;
        this.marketsLoading = metadataCalls === 1 ? Promise.reject(new Error('request timed out')) : Promise.resolve({ 'BTC/USDT:USDT': market() });
      }
      return this.marketsLoading;
    },
  };
  const feed = new ExchangeFundingStatistics({ exchanges: ['binance'], clients: { binance }, now: () => NOW });
  try {
    await feed.refresh(); assert.equal(feed.get().status, 'error'); assert.equal(binance.marketsLoading, undefined);
    await feed.refresh(); assert.equal(metadataCalls, 2); assert.equal(feed.get().rows[0].cells.binance?.available, true);
  } finally { await feed.stop(); }
});

test('scheduled retries are independent of healthy refresh intervals and respect rate-limit backoff', async () => {
  let now = NOW, failures = 0;
  const binance = client(), bybit = client();
  const fetch = binance.fetchFundingRates;
  binance.fetchFundingRates = async (...args) => { failures++; if (failures === 1) throw new Error('429 Too many requests'); return fetch(...args); };
  const feed = new ExchangeFundingStatistics({ exchanges: ['binance', 'bybit'], clients: { binance, bybit }, now: () => now });
  try {
    await feed.refresh(); assert.equal(failures, 1); assert.equal(bybit.calls.length, 1);
    now += 9999; await feed.refresh(false); assert.equal(failures, 1);
    now++; await feed.refresh(false); assert.equal(failures, 2); assert.equal(bybit.calls.length, 1);
    assert.equal(feed.get().rows[0].cells.binance?.available, true);
    now = NOW + 20_000; await feed.refresh(false); assert.equal(bybit.calls.length, 2); assert.equal(failures, 2);
  } finally { await feed.stop(); }
});

function bybitInstrument(base: string, changes: Record<string, unknown> = {}) {
  return { symbol: `${base}USDT`, baseCoin: base, quoteCoin: 'USDT', settleCoin: 'USDT', status: 'Trading', contractType: 'LinearPerpetual', fundingInterval: 480, ...changes };
}
function bybitTicker(base: string, changes: Record<string, unknown> = {}) {
  return { symbol: `${base}USDT`, fundingRate: '.0001', nextFundingTime: String(NOW + HOUR), fundingIntervalHour: '1', ...changes };
}
test('native Bybit discovery follows every Trading cursor and bulk tickers retain exact identities, live intervals and observation timestamps', async () => {
  const metadataCalls: any[] = [], tickerCalls: any[] = [];
  let now = NOW;
  const bybit = { ...client(),
    publicGetV5MarketInstrumentsInfo: async (params: any) => {
      metadataCalls.push(params);
      return { retCode: 0, result: { category: 'linear', nextPageCursor: params.cursor ? '' : 'second', list: params.cursor ? [bybitInstrument('1000PEPE'), bybitInstrument('PERPC', { quoteCoin: 'USDC', settleCoin: 'USDC' }), bybitInstrument('FUTURE', { contractType: 'LinearFutures' })] : [bybitInstrument('BTC'), bybitInstrument('PEPE'), bybitInstrument('PENDING', { status: 'PendingOpen' })] } };
    },
    publicGetV5MarketTickers: async (params: any) => {
      tickerCalls.push(params);
      return { retCode: 0, time: now - 500, result: { category: 'linear', list: [bybitTicker('BTC', { fundingRate: '-.001', fundingIntervalHour: '4', singleOpenInterestValue: '17', turnover24h: '123' }), bybitTicker('PEPE', { fundingRate: '0', fundingIntervalHour: undefined }), bybitTicker('1000PEPE'), bybitTicker('PENDING'), bybitTicker('PERPC'), bybitTicker('FUTURE')] } };
    },
  };
  const feed = new ExchangeFundingStatistics({ exchanges: ['bybit'], clients: { bybit }, now: () => now });
  try {
    await feed.refresh(); const rows = feed.get().rows;
    assert.deepEqual(rows.map(row => row.base), ['1000PEPE', 'BTC', 'PEPE']);
    assert.deepEqual(metadataCalls, [{ category: 'linear', status: 'Trading', limit: 1000 }, { category: 'linear', status: 'Trading', limit: 1000, cursor: 'second' }]);
    assert.equal(bybit.reloads.length, 0); assert.equal(bybit.calls.length, 0);
    const btc = rows.find(row => row.base === 'BTC')!.cells.bybit!, pepe = rows.find(row => row.base === 'PEPE')!.cells.bybit!;
    assert.equal(btc.rate, -.001); assert.equal(btc.intervalHours, 4); assert.equal(btc.updatedAt, NOW - 500); assert.equal(btc.timestampKind, 'exchange');
    assert.equal(btc.openInterestUsd, 17); assert.equal(btc.volume24hUsd, 123); assert.equal(pepe.rate, 0); assert.equal(pepe.intervalHours, 8);
    now += 20_000; await feed.refresh(); assert.equal(metadataCalls.length, 2); assert.equal(tickerCalls.length, 2);
    now += HOUR; await feed.refresh(); assert.equal(metadataCalls.length, 4); assert.equal(tickerCalls.length, 3);
  } finally { await feed.stop(); }
});

test('native Bybit repeating metadata cursor fails promptly, retains old values as unavailable and recovers without a poisoned cache', async () => {
  let broken = false, metadataCalls = 0, now = NOW;
  const bybit = { ...client(),
    publicGetV5MarketInstrumentsInfo: async () => { metadataCalls++; return { retCode: 0, result: { category: 'linear', nextPageCursor: broken ? 'repeat' : '', list: [bybitInstrument('BTC')] } }; },
    publicGetV5MarketTickers: async () => ({ retCode: 0, time: now, result: { category: 'linear', list: [bybitTicker('BTC', { nextFundingTime: String(now + HOUR) })] } }),
  };
  const feed = new ExchangeFundingStatistics({ exchanges: ['bybit'], clients: { bybit }, now: () => now, deadlineMs: 50 });
  try {
    await feed.refresh(); assert.equal(metadataCalls, 1);
    broken = true; now += HOUR; await within(feed.refresh()); assert.equal(metadataCalls, 3); assert.equal(feed.get().rows[0].cells.bybit?.available, false);
    broken = false; await feed.refresh(); assert.equal(metadataCalls, 4); assert.equal(feed.get().rows[0].cells.bybit?.available, true);
  } finally { await feed.stop(); }
});

test('native Bybit empty metadata does not become an hour-long cache and ambiguous same-base IDs are excluded', async () => {
  let metadataCalls = 0;
  const bybit = { ...client(),
    publicGetV5MarketInstrumentsInfo: async () => { metadataCalls++; return { retCode: 0, result: { category: 'linear', nextPageCursor: '', list: metadataCalls === 1 ? [] : [bybitInstrument('BTC'), bybitInstrument('PEPE'), bybitInstrument('PEPE', { symbol: 'PEPEALIASUSDT' })] } }; },
    publicGetV5MarketTickers: async () => ({ retCode: 0, time: NOW, result: { category: 'linear', list: [bybitTicker('BTC'), bybitTicker('PEPE'), bybitTicker('PEPE', { symbol: 'PEPEALIASUSDT' })] } }),
  };
  const feed = new ExchangeFundingStatistics({ exchanges: ['bybit'], clients: { bybit }, now: () => NOW });
  try {
    await feed.refresh(); assert.equal(feed.get().status, 'error');
    await feed.refresh(); assert.equal(metadataCalls, 2); assert.deepEqual(feed.get().rows.map(row => row.base), ['BTC']);
  } finally { await feed.stop(); }
});

test('a native Bybit timed-out first metadata page cannot start its old cursor after a new successful generation', async () => {
  let resolveOld!: (value: any) => void, metadataCalls = 0;
  const old = new Promise<any>(resolve => { resolveOld = resolve; });
  const bybit = { ...client(),
    publicGetV5MarketInstrumentsInfo: async () => { metadataCalls++; return metadataCalls === 1 ? old : { retCode: 0, result: { category: 'linear', nextPageCursor: '', list: [bybitInstrument('BTC')] } }; },
    publicGetV5MarketTickers: async () => ({ retCode: 0, time: NOW, result: { category: 'linear', list: [bybitTicker('BTC')] } }),
  };
  const feed = new ExchangeFundingStatistics({ exchanges: ['bybit'], clients: { bybit }, now: () => NOW, deadlineMs: 20 });
  try {
    await within(feed.refresh()); await within(feed.refresh()); assert.equal(metadataCalls, 2); assert.equal(feed.get().rows[0].cells.bybit?.available, true);
    resolveOld({ retCode: 0, result: { category: 'linear', nextPageCursor: 'outdated-cursor', list: [bybitInstrument('OLD')] } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(metadataCalls, 2); assert.deepEqual(feed.get().rows.map(row => row.base), ['BTC']);
  } finally { await feed.stop(); }
});

test('stop cancels an active statistics generation and its late data remains unpublished', async () => {
  let resolveLate!: (value: any) => void;
  const binance = client();
  binance.fetchFundingRates = () => new Promise(resolve => { resolveLate = resolve; });
  const feed = new ExchangeFundingStatistics({ exchanges: ['binance'], clients: { binance }, now: () => NOW, deadlineMs: 10_000 });
  const pending = feed.refresh();
  await new Promise<void>(resolve => setImmediate(resolve));
  await within(feed.stop()); await within(pending, 100);
  resolveLate({ 'BTC/USDT:USDT': rate() });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(feed.get().rows.length, 0);
});

test('settlement timestamps never act as observation times and past settlement cells are unavailable', async () => {
  const bybit = client([market(), market('ETH')], [rate(), rate('ETH', { fundingTimestamp: NOW - 1000 })]);
  const feed = new ExchangeFundingStatistics({ exchanges: ['bybit'], clients: { bybit }, now: () => NOW });
  try {
    await feed.refresh(); const data = feed.get(), btc = data.rows.find(r => r.base === 'BTC')!.cells.bybit!, eth = data.rows.find(r => r.base === 'ETH')!.cells.bybit!;
    assert.equal(btc.updatedAt, NOW); assert.equal(btc.timestampKind, 'received'); assert.equal(eth.available, false);
    assert.equal(fundingCellIsFresh(eth, data, NOW), false);
  } finally { await feed.stop(); }
});

test('metadata discovery reloads after one hour even with frequent refreshes', async () => {
  let now = NOW; const bybit = client();
  const feed = new ExchangeFundingStatistics({ exchanges: ['bybit'], clients: { bybit }, now: () => now });
  try {
    await feed.refresh(); now += HOUR / 2; await feed.refresh(); now += HOUR / 2; await feed.refresh();
    assert.deepEqual(bybit.reloads, [false, false, true]);
  } finally { await feed.stop(); }
});

test('display cache preserves upstream timestamps and expires after its own two-minute window', async () => {
  let now = NOW;
  const bybit = client([market()], [rate('BTC', { timestamp: NOW - 70_000 })]);
  const feed = new ExchangeFundingStatistics({ exchanges: ['bybit'], clients: { bybit }, now: () => now });
  try {
    await feed.refresh(); const first = feed.get();
    assert.equal(first.maxAgeMs, 120_000);assert.equal(first.rows[0].cells.bybit!.updatedAt, NOW - 70_000);
    assert.equal(first.rows[0].cells.bybit!.available, true);
    now += 50_001;const expired = feed.get();
    assert.equal(expired.rows[0].cells.bybit!.available, false);assert.equal(expired.status, 'stale');
  } finally { await feed.stop(); }
});
