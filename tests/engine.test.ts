import test from 'node:test';
import { ReadyHistory } from './ready-history.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Engine, safeMessage, type EngineOptions } from '../src/core/engine.js';
import { ExchangeNetworkError } from '../src/adapters/network.js';
import { Store } from '../src/core/store.js';
import { defaultConfig } from './legacy-config.js';
import type { AccountState, ExchangeAdapter, ExchangeId, MarketSnapshot, Position } from '../src/shared/types.js';
import type { FundingStatsDataset } from '../src/shared/funding-statistics.js';

const ids: ExchangeId[] = ['binance', 'bybit'];
const permittedLiveEnvironment={ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',BINANCE_API_KEY:'test-key-a',BINANCE_API_SECRET:'test-secret-a',BYBIT_API_KEY:'test-key-b',BYBIT_API_SECRET:'test-secret-b'};
function snapshot(exchange: ExchangeId, now: number, changes: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return { exchange, base: 'BTC', symbol: 'BTC/USDT:USDT', timestamp: now, markPrice: 100, indexPrice: 100,
    fundingRate: exchange === 'binance' ? .001 : .01, intervalHours: 8, nextFundingTime: now + 3_600_000, fundingHistory: [],
    bids: [{ price: 100, quantity: 100 }], asks: [{ price: 100, quantity: 100 }], openInterestUsd: 1e9, volume24hUsd: 1e9,
    quantityStep: .01, minQuantity: .01, minNotional: 1, contractSize: 1, source: 'demo',
    takerFeeRate:exchange==='bybit'?.00055:.0005,takerFeeAt:now,takerFeeSource:'exchange',...changes };
}
function position(now: number, mode: 'paper' | 'live' = 'paper'): Position {
  return { id: 'p1', base: 'BTC', mode, status: 'open', openedAt: now - 1000, plannedExitAt: now + 3_600_000, holdMode: 'continuous',
    long: { exchange: 'binance', symbol: 'BTC/USDT:USDT', side: 'long', quantity: 10, entryPrice: 100, markPrice: 100, feesUsd: 0, liquidationDistancePct: 50 },
    short: { exchange: 'bybit', symbol: 'BTC/USDT:USDT', side: 'short', quantity: 10, entryPrice: 100, markPrice: 100, feesUsd: 0, liquidationDistancePct: 50 },
    fundingUsd: 0, feesUsd: 0, transferCostUsd: 0, spreadPnlUsd: 0, realizedSpreadPnlUsd: 0, netPnlUsd: 0, deltaUsd: 0, fundingEvents: [], riskReasons: [] };
}
function setup(mode: 'paper' | 'live' = 'paper', options: EngineOptions = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'funding-engine-'));
  const store = new Store(path.join(directory, 'state.json'), { ...defaultConfig, exchanges: ids, symbols: ['BTC'], mode, dataSource: mode === 'paper' ? 'demo' : 'public' });
  const engine = new Engine(store, mode === 'live', {liveEnvironment:permittedLiveEnvironment,spreadHistory:new ReadyHistory(),...options});
  let submitted = 0;
  const accounts = new Map<ExchangeId, AccountState>(ids.map(id => [id, { freeUsd: 10000, equityUsd: 10000, positions: [] }]));
  engine.adapters = ids.map(id => ({ id,
    fetchSnapshots: async () => [snapshot(id, Date.now(), { markPrice: 110, indexPrice: 110 })],
    fetchAccount: async () => accounts.get(id)!, fetchFundingPayments: async () => [], close: async () => {},
    prepareTrading: async () => {}, cancelOrder: async () => {}, reconcileOrder: async () => { throw new Error('Unexpected reconciliation'); },
    placeOrder: async () => { submitted++; throw new Error('Unexpected real order attempt'); },
  }) as ExchangeAdapter);
  engine.health = ids.map(exchange => ({ exchange, status: 'online', latencyMs: 0, lastSuccess: Date.now() }));
  return { store, engine, accounts, submitted: () => submitted, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('adaptive positions need distinct paired samples, then hold or close without any real orders',async()=>{
  const s=setup();try{
    const now=Date.now(),p=position(now);p.holdMode='adaptive';s.store.data.positions.push(p);
    s.store.data.config.holdMode='adaptive';
    const quotes=(at:number,rate:number)=>{s.engine.snapshots=[snapshot('binance',at,{markPrice:100,fundingRate:0,nextFundingTime:now+60_000}),snapshot('bybit',at,{markPrice:100,fundingRate:rate,nextFundingTime:now+60_000})];};
    quotes(now,.01);
    await (s.engine as any).managePositions(now);await (s.engine as any).managePositions(now);await (s.engine as any).managePositions(now);
    assert.equal(p.holdDecision?.action,'wait');assert.equal(p.status,'open');
    quotes(now+1,.01);await (s.engine as any).managePositions(now+1);
    quotes(now+2,.01);await (s.engine as any).managePositions(now+2);
    assert.equal(p.holdDecision?.action,'hold');assert.equal(p.plannedExitAt,now+70_000);
    for(let step=3;step<=5;step++){quotes(now+step,0);await (s.engine as any).managePositions(now+step);if(step<5)assert.equal(p.status,'open');}
    assert.equal(p.holdDecision?.action,'close');assert.equal(p.status,'closed');assert.equal(s.submitted(),0);
  }finally{s.cleanup();}
});

test('a holding-time cap does not close an adaptive position by itself',async()=>{
  const s=setup();try{
    const now=Date.now(),p=position(now);p.holdMode='adaptive';p.openedAt=now-3_600_000;s.store.data.positions.push(p);
    s.store.data.config.maxHoldHours=1;s.store.data.config.adaptiveConfirmations=20;
    s.engine.snapshots=ids.map(id=>snapshot(id,now,{markPrice:100,fundingRate:.01,nextFundingTime:now+60_000}));
    await (s.engine as any).managePositions(now);
    assert.equal(p.status,'open');assert.notEqual(p.holdDecision?.action,'close');assert.equal(s.submitted(),0);
  }finally{s.cleanup();}
});

test('adaptive waits locally after settlement clock grace expires instead of manufacturing a close',async()=>{
  const s=setup();try{
    const now=Date.now(),event=now-1000,p=position(now);p.holdMode='adaptive';p.openedAt=event-60_000;p.plannedExitAt=event+10_000;
    s.store.data.positions.push(p);s.store.data.config.adaptiveSettlementGraceSec=5;s.store.data.config.adaptiveConfirmations=20;
    s.engine.snapshots=ids.map(id=>snapshot(id,now,{markPrice:100,nextFundingTime:event}));
    await (s.engine as any).managePositions(now);
    assert.equal(p.holdDecision?.action,'wait');assert.equal(p.status,'open');
    await (s.engine as any).managePositions(event+5000);
    assert.equal(p.holdDecision?.action,'wait');assert.match(p.holdDecision!.reason,/等待结算时钟/);
    assert.equal(p.status,'open');assert.equal(s.submitted(),0);assert.equal(s.store.data.killSwitch,false);
  }finally{s.cleanup();}
});

test('locked live adaptive decisions are display-only even when they recommend closing',async()=>{
  const s=setup('live',{liveEnvironment:{}});try{
    const now=Date.now(),p=position(now,'live');p.holdMode='adaptive';s.store.data.positions.push(p);s.store.data.config.adaptiveConfirmations=1;
    s.engine.snapshots=ids.map(id=>snapshot(id,now,{fundingRate:0,markPrice:100}));
    s.engine.execution.close=async()=>{throw new Error('Locked live close must never run');};
    await (s.engine as any).managePositions(now);
    assert.equal(p.holdDecision?.action,'close');assert.equal(p.status,'open');assert.match(p.riskReasons[0],/只读锁定/);assert.equal(s.submitted(),0);
  }finally{s.cleanup();}
});

test('rebuilding adapters refreshes configured credential presence without changing startup permission',async()=>{
  const environment:Record<string,string|undefined>={},s=setup('live',{liveEnvironment:environment});try{
    assert.equal(s.engine.liveReadiness().exchanges.find(x=>x.exchange==='binance')!.credentialsConfigured,false);
    Object.assign(environment,{BINANCE_API_KEY:'test-local-presence',BINANCE_API_SECRET:'test-local-presence'});
    await s.engine.updateConfig({bitgetNewSymbolMarginMode:'crossed'});
    assert.equal(s.engine.liveReadiness().exchanges.find(x=>x.exchange==='binance')!.credentialsConfigured,true);
    assert.equal(s.engine.liveUnlocked,false);assert.equal(s.submitted(),0);
    await s.engine.stop();
  }finally{s.cleanup();}
});

test('paper settlement uses the prior known price and rate, once per exchange', async () => {
  const s = setup(); try {
    const now = Date.now(), p = position(now); s.store.data.positions.push(p);
    s.engine.snapshots = ids.map(id => snapshot(id, now - 1000, { nextFundingTime: now - 500 }));
    await s.engine.tick(); await s.engine.tick();
    assert.equal(p.fundingUsd, 9); assert.equal(p.fundingEvents.length, 2); assert.equal(p.status, 'open');
  } finally { s.cleanup(); }
});

test('live liquidation distance preserves the dangerous side of the threshold',async()=>{
  const s=setup('live');try{
    s.engine.running=true;
    const p=position(Date.now(),'live');p.status='attention';s.store.data.positions.push(p);
    for(const [id,side] of [['binance','long'],['bybit','short']] as const)s.accounts.get(id)!.positions.push({base:'BTC',symbol:'BTC/USDT:USDT',side,quantity:10,markPrice:100,liquidationPrice:side==='long'?110:90,leverage:2});
    await s.engine.tick();assert.equal(p.long.liquidationDistancePct,-10);assert.equal(p.short.liquidationDistancePct,-10);
  }finally{await s.engine.stop();s.cleanup();}
});

test('read-only recovery leaves reconciled positions frozen until explicit resume',async()=>{
  const s=setup('live');try{
    const p=position(Date.now(),'live');p.status='attention';s.store.data.positions.push(p);s.store.data.killSwitch=true;
    for(const [id,side] of [['binance','long'],['bybit','short']] as const)s.accounts.get(id)!.positions.push({base:'BTC',symbol:'BTC/USDT:USDT',side,quantity:10,markPrice:100,liquidationPrice:side==='long'?50:150,leverage:2});
    await s.engine.control('reconcile');await s.engine.tick();assert.equal(p.status,'attention');assert.equal(s.submitted(),0);assert.equal(s.store.data.killSwitch,true);
    await s.engine.control('resume');assert.equal(p.status,'open');assert.equal(s.store.data.killSwitch,false);assert.equal(s.engine.autoEnabled,false);
  }finally{s.cleanup();}
});

test('paper positions opened at or after settlement cannot collect that event', async () => {
  const s = setup(); try {
    const now = Date.now(), event = now - 500, p = position(now); p.openedAt = event; s.store.data.positions.push(p);
    s.engine.snapshots = ids.map(id => snapshot(id, now - 1000, { nextFundingTime: event }));
    await s.engine.tick(); assert.equal(p.fundingUsd, 0); assert.equal(p.fundingEvents.length, 0);
  } finally { s.cleanup(); }
});

test('stale pre-settlement quotes do not invent missed paper funding', async () => {
  const s = setup(); try {
    const now = Date.now(), p = position(now); s.store.data.positions.push(p);
    s.engine.snapshots = ids.map(id => snapshot(id, now - 60_000, { nextFundingTime: now - 500 }));
    await s.engine.tick(); assert.equal(p.fundingUsd, 0);
  } finally { s.cleanup(); }
});

test('resume cannot clear a failed live reconciliation with an unknown external position', async () => {
  const s = setup('live'); try {
    s.store.data.killSwitch = true;
    s.accounts.get('binance')!.positions.push({ base: 'BTC', symbol: 'BTC/USDT:USDT', side: 'long', quantity: 1, markPrice: 100, liquidationPrice: 50, leverage: 2 });
    await assert.rejects(() => s.engine.control('resume'), /对账/);
    assert.equal(s.store.data.killSwitch, true); assert.equal(s.engine.autoEnabled, false); assert.equal(s.submitted(), 0);
  } finally { s.cleanup(); }
});

test('live account quantity mismatch retains attention and does not trade against an untrusted ledger', async () => {
  const s = setup('live'); try {
    s.engine.running=true;
    const p = position(Date.now(), 'live'); s.store.data.positions.push(p);
    for (const [id, side] of [['binance', 'long'], ['bybit', 'short']] as const) s.accounts.get(id)!.positions.push({ base: 'BTC', symbol: 'BTC/USDT:USDT', side, quantity: id === 'binance' ? 11 : 10, markPrice: 100, liquidationPrice: side === 'long' ? 50 : 150, leverage: 2 });
    await s.engine.tick(); assert.equal(p.status, 'attention'); assert.equal(s.store.data.killSwitch, false); assert.equal(s.submitted(), 0);
    assert.equal(p.long.quantity, 10); // keep the local discrepancy for audit instead of overwriting it.
  } finally { await s.engine.stop();s.cleanup(); }
});

test('restored live positions are marked attention and never silently resume automation', () => {
  const s = setup('live'); try {
    const p = position(Date.now(), 'live'); s.store.data.positions.push(p); s.store.data.config.autoEnabled = true;
    const restored = new Engine(s.store, true);
    // Scoped restriction only: BTC is excluded, but no persisted global stop locks the whole application.
    assert.equal(p.status, 'attention'); assert.equal(restored.autoEnabled, false); assert.equal(s.store.data.killSwitch, false);
    assert(restored.liveReadiness().excludedCoins?.some(item => item.base === 'BTC'));
    assert.equal(restored.liveUnlocked, false);
  } finally { s.cleanup(); }
});

test('a deep negative quote does not auto-close a position', async () => {
  const s = setup('paper'); try {
    const now = Date.now(), p = position(now); s.store.data.positions.push(p);
    for (let i = 0; i < 6; i++) {
      s.engine.snapshots = [snapshot('binance', now + i, { markPrice: 100, bids: [{ price: 90, quantity: 100 }] }), snapshot('bybit', now + i, { markPrice: 100 })];
      await (s.engine as any).managePositions(now + i);
    }
    assert.equal(p.status, 'open'); assert.equal(s.submitted(), 0);
  } finally { s.cleanup(); }
});

test('a public-quote outage keeps positions open and resumes management without manual reconciliation', async () => {
  const s = setup('paper'); try {
    const now = Date.now(), p = position(now); s.store.data.positions.push(p);
    s.engine.adapters = ids.map(id => ({ id, fetchSnapshots: async () => { throw new Error('boom'); }, fetchAccount: async () => ({ freeUsd: 1, equityUsd: 1, positions: [] }),
      fetchFundingPayments: async () => [], close: async () => {}, prepareTrading: async () => {}, cancelOrder: async () => {}, reconcileOrder: async () => { throw new Error('x'); }, placeOrder: async () => { throw new Error('x'); } }) as ExchangeAdapter);
    s.engine.snapshots = ids.map(id => snapshot(id, now));
    for (let i = 0; i < s.store.data.config.maxApiErrors + 2; i++) await s.engine.tick();
    assert.equal(p.status, 'open'); assert.equal(s.store.data.killSwitch, false);
  } finally { s.cleanup(); }
});

test('an unexpected tick failure pauses entries without a persisted global stop, and one bad position cannot block the others', async () => {
  const s = setup('paper'); try {
    const now = Date.now(), bad = position(now), good = { ...position(now), id: 'p2', base: 'ETH' } as Position;
    good.long = { ...good.long, symbol: 'ETH/USDT:USDT' }; good.short = { ...good.short, symbol: 'ETH/USDT:USDT' };
    s.store.data.positions.push(bad, good); s.engine.autoEnabled = true;
    const original = s.engine.snapshot.bind(s.engine);
    s.engine.snapshot = ((exchange: string, base: string) => { if (base === 'BTC') throw new Error('broken quote'); return original(exchange, base); }) as typeof s.engine.snapshot;
    s.engine.snapshots = ids.map(id => snapshot(id, now, { base: 'ETH', symbol: 'ETH/USDT:USDT', markPrice: 123 }));
    await (s.engine as any).managePositions(now);
    assert(s.store.data.logs.some(log => /BTC 持仓管理异常/.test(log.message)));
    assert.equal(good.long.markPrice, 123); assert.equal(s.store.data.killSwitch, false);
    (s.engine as any).tickFailed(new Error('calc bug')); assert.equal(s.engine.autoEnabled, false); assert.equal(s.store.data.killSwitch, false);
    (s.engine as any).tickFailed(Object.assign(new Error('disk'), { code: 'ENOSPC', syscall: 'write' })); assert.equal(s.store.data.killSwitch, true);
  } finally { s.cleanup(); }
});

async function within<T>(operation: Promise<T>, timeoutMs = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Engine operation remained blocked by public market data')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

test('a stuck public venue cannot block healthy updates or queued controls, and is never fetched concurrently', async () => {
  const s = setup('paper', { publicSnapshotDeadlineMs: 1000 }); try {
    s.store.data.config.dataSource = 'public';
    // The acquisition deadline must also respect half the configured quote age.
    s.store.data.config.maxSnapshotAgeMs = 80;
    let stuckCalls = 0, healthyCalls = 0;
    s.engine.adapter('binance').fetchSnapshots = () => { stuckCalls++; return new Promise(() => {}); };
    s.engine.adapter('bybit').fetchSnapshots = async () => [snapshot('bybit', Date.now(), { source: 'public', markPrice: 110 + healthyCalls++ })];
    await within(Promise.all([s.engine.tick(), s.engine.control('startAuto')]), 500);
    assert.equal(s.engine.snapshot('bybit', 'BTC')?.markPrice, 110);
    assert.equal(s.engine.health.find(h => h.exchange === 'binance')?.errorCode, 'TIMEOUT');
    assert.equal(s.engine.autoEnabled, true);
    await s.engine.control('pause');
    await within(s.engine.tick(), 500);
    assert.equal(stuckCalls, 1);
    assert.equal(healthyCalls, 2);
    assert.equal(s.engine.snapshot('bybit', 'BTC')?.markPrice, 111);
    assert.equal(s.submitted(), 0);
  } finally { s.cleanup(); }
});

test('an expired public batch is discarded and the venue can recover after its original request settles', async () => {
  const s = setup('paper', { publicSnapshotDeadlineMs: 10 }); try {
    s.store.data.config.dataSource = 'public';
    s.engine.snapshots = [snapshot('binance', Date.now(), { source: 'public', markPrice: 90 })];
    let resolveLate!: (quotes: MarketSnapshot[]) => void, calls = 0;
    const late = new Promise<MarketSnapshot[]>(resolve => { resolveLate = resolve; });
    s.engine.adapter('binance').fetchSnapshots = async () => {
      calls++;
      return calls === 1 ? late : [snapshot('binance', Date.now(), { source: 'public', markPrice: 120 })];
    };
    await within(s.engine.tick());
    assert.equal(s.engine.snapshot('binance', 'BTC')?.markPrice, 90);
    assert.equal(s.engine.health.find(h => h.exchange === 'binance')?.status, 'offline');
    resolveLate([snapshot('binance', Date.now(), { source: 'public', markPrice: 999 })]);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(s.engine.snapshot('binance', 'BTC')?.markPrice, 90);
    assert.equal(s.engine.health.find(h => h.exchange === 'binance')?.status, 'offline');
    await within(s.engine.tick());
    assert.equal(calls, 2);
    assert.equal(s.engine.snapshot('binance', 'BTC')?.markPrice, 120);
    assert.equal(s.engine.health.find(h => h.exchange === 'binance')?.status, 'online');
  } finally { s.cleanup(); }
});

function fundingDataset(bases: string[], now = Date.now()): FundingStatsDataset {
  return { source: 'exchanges', range: 'current', status: 'ready', receivedAt: now, lastAttemptAt: now, nextRefreshAt: now + 20000,
    maxAgeMs: 60000, sourceUrl: 'https://example.test/public', marginScope: 'USDT perpetual',
    rows: bases.map((base, index) => ({ base, cells: Object.fromEntries(ids.map(exchange => [exchange, {
      exchange, rate: exchange === 'binance' ? .001 : .02 - index * .001,
      intervalHours: 8, nextFundingTime: now + 600000, updatedAt: now, timestampKind: 'received', available: true,
      openInterestUsd: 1e9, volume24hUsd: 1e9,
    }])) })),
  };
}
function fundingMocks(s: ReturnType<typeof setup>, provider: () => FundingStatsDataset, history = true) {
  const requests: { exchange: ExchangeId; bases: string[] }[] = [];
  for (const adapter of s.engine.adapters) adapter.fetchSnapshots = async bases => {
    requests.push({ exchange: adapter.id, bases: [...bases] });
    return bases.map(base => {
      const cell = provider().rows.find(row => row.base === base)?.cells[adapter.id];
      const rate = cell?.rate ?? (adapter.id === 'binance' ? .001 : .01);
      return snapshot(adapter.id, Date.now(), { base, symbol: `${base}/USDT:USDT`, source: 'public', fundingRate: rate,
        fundingHistory: history ? [rate, rate, rate] : [], nextFundingTime: cell?.nextFundingTime ?? Date.now() + 600000 });
    });
  };
  s.store.data.config.dataSource = 'public';
  return requests;
}

test('whole-market candidates outside configured symbols receive bounded, retained detailed verification', async () => {
  const data = fundingDataset(['DOGE', 'XPL', 'SUI', 'TIA', 'NEAR', 'AVAX']);
  const s = setup('paper', { fundingStatistics: () => data }); try {
    const requests = fundingMocks(s, () => data);
    assert.deepEqual(s.engine.config.symbols, ['BTC']);
    await s.engine.tick();
    assert.deepEqual(requests[0].bases, ['DOGE', 'XPL', 'SUI', 'TIA', 'NEAR', 'AVAX']);
    assert.ok(s.engine.opportunities.some(o => o.base === 'DOGE' && o.eligible));
    await s.engine.tick();
    assert.deepEqual(new Set(requests[2].bases),new Set(requests[0].bases),'all six income/discovery baselines retain their continuous observation window');
    assert.ok(requests.every(request => request.bases.length <= 6));
    assert.equal(s.store.data.positions.length, 0); assert.equal(s.store.data.orders.length, 0);
  } finally { s.cleanup(); }
});

test('a venue outside selected pairs receives one real baseline quote instead of being marked disconnected', async () => {
  const data = fundingDataset(['DOGE']);
  const s = setup('paper', { fundingStatistics: () => data }); try {
    s.store.data.config.exchanges = [...ids, 'gate'];
    s.store.data.config.symbols = ['BTC', 'ETH', 'SOL', 'XRP', 'AVAX', 'DOGE'];
    s.engine.adapters.push({ ...s.engine.adapters[0], id: 'gate' });
    s.engine.health.push({ exchange: 'gate', status: 'connecting', latencyMs: 0, lastSuccess: 0 });
    const requests = fundingMocks(s, () => data);
    await s.engine.tick();
    assert.deepEqual(requests.find(request => request.exchange === 'gate')?.bases, ['BTC']);
    assert.equal(s.engine.snapshot('gate', 'BTC')?.source, 'public');
    assert.equal(s.engine.health.find(h => h.exchange === 'gate')?.status, 'online');
  } finally { s.cleanup(); }
});

test('active-position coins are always requested first and survive targeted manual verification', async () => {
  const data = fundingDataset(['DOGE', 'XPL', 'SUI', 'TIA']);
  const s = setup('paper', { fundingStatistics: () => data }); try {
    const p = position(Date.now()); p.base = 'LEGACY'; p.status = 'attention';
    p.long.symbol = p.short.symbol = 'LEGACY/USDT:USDT'; s.store.data.positions.push(p);
    const requests = fundingMocks(s, () => data);
    await s.engine.tick(); assert.ok(requests.every(request => request.bases[0] === 'LEGACY'));
    assert.ok(requests.every(request => request.bases.length <= 6));
    const before = s.engine.snapshot('binance', 'LEGACY');
    await s.engine.verifyFundingCandidate('TIA-binance-bybit');
    assert.equal(s.engine.snapshot('binance', 'LEGACY'), before);
    assert.equal(p.status, 'attention'); assert.equal(s.store.data.orders.length, 0);
    requests.length = 0; await s.engine.tick();
    assert.ok(requests.every(request => request.bases[0] === 'LEGACY'));
    assert.ok(s.engine.snapshot('bybit', 'LEGACY'));
  } finally { s.cleanup(); }
});

test('manual verification accepts a present blocked candidate, reports actual risk, and never creates orders', async () => {
  const data = fundingDataset(['DOGE']);
  for (const cell of Object.values(data.rows[0].cells)) cell.nextFundingTime = Date.now() + 3600000;
  const s = setup('paper', { fundingStatistics: () => data }); try {
    const requests = fundingMocks(s, () => data);
    await assert.rejects(s.engine.verifyFundingCandidate('ARBITRARY-binance-bybit'), /不存在/);
    assert.equal(requests.length, 0);
    for (const cell of Object.values(data.rows[0].cells)) cell.nextFundingTime = Date.now() + 1000;
    const result = await s.engine.verifyFundingCandidate('DOGE-binance-bybit');
    assert.ok(result); assert.equal(result.eligible, false); assert.ok(result.reasons.some(reason => reason.includes('结算')));
    assert.deepEqual(requests.map(request => request.bases), [['DOGE'], ['DOGE']]);
    assert.equal(s.store.data.positions.length, 0); assert.equal(s.store.data.orders.length, 0); assert.equal(s.submitted(), 0);
  } finally { s.cleanup(); }
});

test('statistics and historical verification alone cannot bypass automatic best-price gates; manual entry stays independent', async () => {
  const data = fundingDataset(['DOGE']);
  const { SpreadHistory } = await import('../src/core/spread-history.js');
  const s = setup('paper', { fundingStatistics: () => data, spreadHistory: new SpreadHistory() }); try {
    fundingMocks(s, () => data, false); s.engine.autoEnabled = true;
    await s.engine.tick(); assert.equal(s.store.data.positions.length, 0);
    assert.equal(s.engine.opportunities[0].checks!.find(check=>check.label==='价差历史样本充足')!.pass,null);
    assert.equal(s.engine.opportunities[0].eligible,false);
    (s.engine as unknown as { spreadHistory: ReadyHistory }).spreadHistory = new ReadyHistory();
    await s.engine.tick();
    assert.equal(s.store.data.positions.length,0);
    assert.equal(s.engine.opportunities[0].eligible,true,'original manual verification remains valid');
    await s.engine.open(s.engine.opportunities[0].id);
    assert.equal(s.store.data.positions.length, 1); assert.equal(s.store.data.positions[0].base, 'DOGE');
    assert.equal(s.store.data.positions[0].status, 'open'); assert.equal(s.submitted(), 0);
  } finally { s.cleanup(); }
});

test('expired or disconnected statistics prevent new auto and manual entries despite fresh detailed quotes', async () => {
  let data = fundingDataset(['DOGE']);
  const s = setup('paper', { fundingStatistics: () => data }); try {
    const requests = fundingMocks(s, () => data);
    assert.equal((await s.engine.verifyFundingCandidate('DOGE-binance-bybit'))?.eligible, true);
    data = { ...data, status: 'error' };
    assert.equal(s.engine.currentOpportunities()[0].eligible, false);
    await assert.rejects(s.engine.open('DOGE-binance-bybit'), /全市场/);
    s.engine.autoEnabled = true; await s.engine.tick(); assert.equal(s.store.data.positions.length, 0);
    data = { ...data, status: 'ready', receivedAt: Date.now() - 120000 };
    const before = requests.length;
    await assert.rejects(s.engine.verifyFundingCandidate('DOGE-binance-bybit'), /过期/);
    assert.equal(requests.length, before); await s.engine.tick(); assert.equal(s.store.data.orders.length, 0);
  } finally { s.cleanup(); }
});

test('provider loss during public acquisition blocks an otherwise eligible auto entry', async () => {
  const data = fundingDataset(['DOGE']);
  const s = setup('paper', { fundingStatistics: () => data }); try {
    fundingMocks(s, () => data); const original = s.engine.adapter('bybit').fetchSnapshots;
    s.engine.adapter('bybit').fetchSnapshots = async bases => { const quotes = await original(bases); data.status = 'error'; return quotes; };
    s.engine.autoEnabled = true; await s.engine.tick();
    assert.equal(s.store.data.positions.length, 0); assert.equal(s.store.data.orders.length, 0);
    assert.ok(s.engine.opportunities.every(o => !o.eligible));
  } finally { s.cleanup(); }
});

test('a failed candidate refresh cannot reuse its old quote after another coin restores venue health', async () => {
  const data = fundingDataset(['DOGE', 'XPL']);
  const s = setup('paper', { fundingStatistics: () => data }); try {
    fundingMocks(s, () => data); await s.engine.verifyFundingCandidate('DOGE-binance-bybit');
    const original = s.engine.adapter('binance').fetchSnapshots;
    s.engine.adapter('binance').fetchSnapshots = async bases => {
      if (bases.includes('DOGE')) throw new Error('Temporary market-data failure');
      return original(bases);
    };
    assert.equal(await s.engine.verifyFundingCandidate('DOGE-binance-bybit'), undefined);
    await s.engine.verifyFundingCandidate('XPL-binance-bybit');
    assert.equal(s.engine.health.find(h => h.exchange === 'binance')?.status, 'online');
    const old = s.engine.currentOpportunities().find(o => o.base === 'DOGE');
    assert.equal(old?.eligible, false); assert.ok(old?.reasons.some(reason => reason.includes('详细行情核验失败')));
    await assert.rejects(s.engine.open('DOGE-binance-bybit'), /核验失败/); assert.equal(s.store.data.orders.length, 0);
  } finally { s.cleanup(); }
});

test('manual verification shares the public single-flight guard and does not resend a pending request', async () => {
  const data = fundingDataset(['DOGE']);
  const s = setup('paper', { fundingStatistics: () => data, publicSnapshotDeadlineMs: 10 }); try {
    fundingMocks(s, () => data); let calls = 0;
    s.engine.adapter('binance').fetchSnapshots = () => { calls++; return new Promise(() => {}); };
    assert.equal(await within(s.engine.verifyFundingCandidate('DOGE-binance-bybit')), undefined);
    assert.equal(await within(s.engine.verifyFundingCandidate('DOGE-binance-bybit')), undefined);
    assert.equal(calls, 1); assert.equal(s.store.data.orders.length, 0);
  } finally { s.cleanup(); }
});

test('paper fee-only positions ignore basis, funding reversals and liquidation estimates until their planned exit',async()=>{
  const s=setup();try{
    s.store.data.config.paperFeeOnly=true;s.store.data.config.minLiquidationDistancePct=60;
    const p=position(Date.now());p.paperFeeOnly=true;s.store.data.positions.push(p);
    for(const adapter of s.engine.adapters)adapter.fetchSnapshots=async()=>[snapshot(adapter.id,Date.now(),{
      markPrice:adapter.id==='binance'?90:110,indexPrice:100,fundingRate:adapter.id==='binance'?.01:.001,
    })];
    await s.engine.tick();
    assert.equal(p.status,'open');assert.equal(p.fundingUsd,0);assert.equal(s.store.data.orders.length,0);
    assert.ok((p.long.liquidationDistancePct??100)<60);assert.deepEqual(p.riskReasons,[]);
    p.plannedExitAt=Date.now()-1;p.holdMode='once';await s.engine.tick();
    assert.equal(p.status,'closed');assert.equal(p.fundingUsd,0);assert.equal(s.store.data.orders.length,2);
  }finally{s.cleanup();}
});

test('a wide basis or a funding flip does not auto-close an open paper position',async()=>{
  const s=setup();try{
    const p=position(Date.now());s.store.data.positions.push(p);
    for(const adapter of s.engine.adapters)adapter.fetchSnapshots=async()=>[snapshot(adapter.id,Date.now(),{
      markPrice:adapter.id==='binance'?90:110,indexPrice:100,fundingRate:adapter.id==='binance'?.01:.001,
    })];
    await s.engine.tick();assert.equal(p.status,'open');assert.equal(s.store.data.orders.length,0);
  }finally{s.cleanup();}
});

test('paper fee-only scheduled exits wait for both real quotes after a disconnect without consuming cached books',async()=>{
  const s=setup();try{
    s.store.data.config.paperFeeOnly=true;s.store.data.config.dataSource='public';
    const p=position(Date.now());p.paperFeeOnly=true;p.holdMode='once';p.plannedExitAt=Date.now()-1;s.store.data.positions.push(p);
    s.engine.snapshots=ids.map(id=>snapshot(id,Date.now(),{source:'public'}));
    s.engine.adapter('binance').fetchSnapshots=async()=>{throw new Error('network unavailable');};
    s.engine.adapter('bybit').fetchSnapshots=async()=>[snapshot('bybit',Date.now(),{source:'public'})];
    await s.engine.tick();
    assert.equal(p.status,'open');assert.equal(p.long.quantity,10);assert.equal(p.short.quantity,10);
    assert.equal(s.store.data.orders.length,0);assert.ok(p.riskReasons.some(reason=>reason.includes('断连')));
    s.engine.adapter('binance').fetchSnapshots=async()=>[snapshot('binance',Date.now(),{source:'public'})];
    await s.engine.tick();assert.equal(p.status,'closed');assert.equal(s.store.data.orders.length,2);assert.equal(p.fundingUsd,0);
  }finally{s.cleanup();}
});

test('quantity drift and a long hold do not auto-close a paper position',async()=>{
  for(const reason of ['delta','time']){
    const s=setup();try{
      s.store.data.config.paperFeeOnly=true;const p=position(Date.now());p.paperFeeOnly=true;s.store.data.positions.push(p);
      if(reason==='delta')p.long.quantity=11;else p.openedAt=Date.now()-s.engine.config.maxHoldHours*3600000-1000;
      await s.engine.tick();assert.equal(p.status,'open');assert.equal(s.store.data.orders.length,0);
    }finally{s.cleanup();}
  }
});

test('an explicit 100 USDT paper fee-only entry is marked and earns no funding before settlement',async()=>{
  const data=fundingDataset(['DOGE']);const s=setup('paper',{fundingStatistics:()=>data});try{
    s.store.data.config.paperFeeOnly=true;s.store.data.config.orderNotionalUsd=100;
    fundingMocks(s,()=>data,false);
    for(const adapter of s.engine.adapters){const original=adapter.fetchSnapshots;adapter.fetchSnapshots=async bases=>(await original(bases)).map(quote=>({...quote,asks:[{price:100.2,quantity:100}],bids:[{price:99.8,quantity:100}]}));}
    const verified=await s.engine.verifyFundingCandidate('DOGE-binance-bybit');assert.equal(verified?.eligible,true);
    const p=await s.engine.open('DOGE-binance-bybit');
    assert.equal(p.status,'open');assert.equal(p.paperFeeOnly,true);assert.equal(p.long.quantity,1);assert.equal(p.short.quantity,1);
    assert.equal(p.long.entryPrice,100.2);assert.equal(p.short.entryPrice,99.8);assert.equal(p.fundingUsd,0);assert.equal(p.fundingEvents.length,0);
    assert.equal(s.engine.autoEnabled,false);assert.equal(s.submitted(),0);
  }finally{s.cleanup();}
});

test('both live legs finish read-only trading checks before any leverage preparation or order intent',async()=>{
  const data=fundingDataset(['DOGE']),s=setup('live',{fundingStatistics:()=>data});
  try{
    s.store.data.config.feeOnly=true;s.store.data.config.orderNotionalUsd=100;fundingMocks(s,()=>data);
    const events:string[]=[];
    for(const a of s.engine.adapters){
      a.inspectTrading=async()=>{events.push(`inspect:${a.id}`);if(a.id==='bybit')throw new Error('fixture unsupported mode');};
      a.prepareTrading=async()=>{events.push(`prepare:${a.id}`);};
    }
    assert.equal((await s.engine.verifyFundingCandidate('DOGE-binance-bybit'))?.eligible,true);
    await assert.rejects(s.engine.open('DOGE-binance-bybit'),/Bybit.*合约检查/);
    assert.deepEqual(events,['inspect:binance','inspect:bybit']);
    assert.equal(s.store.data.orders.length,0);assert.equal(s.store.data.positions.length,0);assert.equal(s.submitted(),0);
  }finally{s.cleanup();}
});

test('pre-order failures report exact venue and phase without leaking exchange payloads or recording fictitious orders',async()=>{
  for(const [method,stage] of [['fetchAccount','账户检查'],['inspectTrading','合约检查'],['prepareTrading','杠杆准备']] as const){
    const data=fundingDataset(['DOGE']),s=setup('live',{fundingStatistics:()=>data});
    try{
      s.store.data.config.feeOnly=true;s.store.data.config.orderNotionalUsd=100;fundingMocks(s,()=>data);
      assert.equal((await s.engine.verifyFundingCandidate('DOGE-binance-bybit'))?.eligible,true);
      const adapter=s.engine.adapter('bybit');
      adapter[method]=async()=>{throw new ExchangeNetworkError('TIMEOUT');};
      await assert.rejects(s.engine.open('DOGE-binance-bybit'),(error:unknown)=>{
        const message=safeMessage(error);assert.match(message,/Bybit/);assert.ok(message.includes(stage));assert.match(message,/超时/);return true;
      });
      assert.equal(s.store.data.orders.length,0);assert.equal(s.store.data.positions.length,0);assert.equal(s.submitted(),0);
    }finally{s.cleanup();}
  }
});

test('pause while a live read-only leg check is pending cancels entry before any preparation',async()=>{
  const data=fundingDataset(['DOGE']),s=setup('live',{fundingStatistics:()=>data});
  try{
    s.store.data.config.feeOnly=true;s.store.data.config.orderNotionalUsd=100;fundingMocks(s,()=>data);
    let entered!:()=>void,release!:()=>void,preparations=0;
    const started=new Promise<void>(r=>{entered=r;}),waiting=new Promise<void>(r=>{release=r;});
    for(const a of s.engine.adapters){a.inspectTrading=async()=>{if(a.id==='bybit'){entered();await waiting;}};a.prepareTrading=async()=>{preparations++;};}
    assert.equal((await s.engine.verifyFundingCandidate('DOGE-binance-bybit'))?.eligible,true);
    const opening=s.engine.open('DOGE-binance-bybit');await started;await s.engine.control('pause');release();
    await assert.rejects(opening,/取消/);assert.equal(preparations,0);assert.equal(s.store.data.orders.length,0);assert.equal(s.submitted(),0);
  }finally{s.cleanup();}
});

test('locked live startup retains public quotes with no account, funding, preparation or execution calls',async()=>{
  const s=setup('live',{liveEnvironment:{}});try{
    let privateCalls=0;
    for(const a of s.engine.adapters){
      a.fetchSnapshots=async()=>[snapshot(a.id,Date.now(),{source:'public'})];
      a.fetchAccount=async()=>{privateCalls++;throw new Error('Private access forbidden');};
      a.fetchFundingPayments=async()=>{privateCalls++;throw new Error('Private access forbidden');};
      a.prepareTrading=async()=>{privateCalls++;};a.cancelOrder=async()=>{privateCalls++;};
      a.reconcileOrder=async()=>{privateCalls++;throw new Error('Private access forbidden');};
      a.placeOrder=async()=>{privateCalls++;throw new Error('Private access forbidden');};
    }
    const p=position(Date.now(),'live');p.holdMode='once';p.plannedExitAt=Date.now()-1;s.store.data.positions.push(p);
    s.engine.autoEnabled=true;await s.engine.tick();
    const state=s.engine.state();assert.equal(state.liveUnlocked,false);assert.equal(state.liveReadiness?.ready,false);
    assert.equal(state.autoEnabled,false);assert.equal(state.totals.availableBalanceUsd,null);
    assert.ok(state.exchanges.every(x=>x.status==='online'&&x.balanceUsd===undefined));
    assert.equal(state.snapshots.length,2);assert.equal(privateCalls,0);assert.equal(p.long.quantity,10);assert.equal(p.short.quantity,10);
    assert.equal(s.store.data.orders.length,0);assert.ok(p.riskReasons.some(r=>r.includes('只读锁定')));
  }finally{s.cleanup();}
});

test('locked live mutation controls and direct pending-order reconciliation cannot reach private APIs',async()=>{
  const s=setup('live',{liveEnvironment:{}});try{
    const p=position(Date.now(),'live');s.store.data.positions.push(p);
    s.store.data.orders.push({positionId:p.id,exchange:'binance',createdAt:Date.now(),request:{clientOrderId:'pending-read-only',base:'BTC',symbol:p.long.symbol,side:'buy',quantity:1,limitPrice:100,reduceOnly:false}});
    let privateCalls=0;for(const a of s.engine.adapters)a.reconcileOrder=async()=>{privateCalls++;throw new Error('Must not reconcile or cancel');};
    for(const action of ['startAuto','resume','reconcile','kill'])await assert.rejects(s.engine.control(action),/只读锁定/);
    await assert.rejects(s.engine.open('BTC-binance-bybit'),/只读锁定/);
    await assert.rejects(s.engine.close(p.id),/只读锁定/);
    await assert.rejects(s.engine.execution.reconcilePending(),/只读锁定/);
    await s.engine.control('pause');assert.equal(s.store.data.killSwitch,true);assert.equal(s.engine.autoEnabled,false);
    assert.equal(p.status,'open');assert.equal(privateCalls,0);assert.equal(s.store.data.orders.length,1);
  }finally{s.cleanup();}
});

test('a constructor flag or one configured venue cannot unlock live trading',async()=>{
  for(const env of [{}, {...permittedLiveEnvironment,ALLOW_LIVE_TRADING:'false'}, {...permittedLiveEnvironment,BYBIT_API_SECRET:''}]){
    const s=setup('live',{liveEnvironment:env});try{
      assert.equal(s.engine.liveUnlocked,false);await assert.rejects(s.engine.control('startAuto'),/只读锁定/);
    }finally{s.cleanup();}
  }
});

test('unlocked live readiness waits for account responses, while unconfigured venues remain public only',async()=>{
  const s=setup('live');try{
    s.store.data.config.exchanges=[...ids,'bitget'];
    let unconfiguredPrivateCalls=0;
    s.engine.adapters.push({...s.engine.adapters[0],id:'bitget',fetchSnapshots:async()=>[snapshot('bitget',Date.now(),{source:'public'})],fetchAccount:async()=>{unconfiguredPrivateCalls++;throw new Error('Unconfigured private account');}});
    s.engine.health.push({exchange:'bitget',status:'connecting',latencyMs:0,lastSuccess:0});
    assert.equal(s.engine.liveUnlocked,true);assert.equal(s.engine.liveReadiness().ready,false);assert.equal(s.engine.totals().availableBalanceUsd,null);
    await s.engine.tick();const state=s.engine.state();
    assert.equal(state.liveReadiness?.ready,true);assert.equal(state.totals.availableBalanceUsd,20000);
    assert.equal(state.liveReadiness?.exchanges.find(x=>x.exchange==='bitget')?.supported,true);
    assert.equal(state.liveReadiness?.exchanges.find(x=>x.exchange==='bitget')?.credentialsConfigured,false);assert.equal(unconfiguredPrivateCalls,0);
    assert.equal(state.exchanges.find(x=>x.exchange==='bitget')?.status,'online');
    assert.ok(!JSON.stringify(state).includes('test-secret'));assert.ok(!JSON.stringify(state).includes('test-key'));
  }finally{s.cleanup();}
});

test('locked live public candidate verification remains available without pretending it can execute',async()=>{
  const data=fundingDataset(['DOGE']),s=setup('live',{liveEnvironment:{},fundingStatistics:()=>data});try{
    fundingMocks(s,()=>data);let accountCalls=0;
    for(const a of s.engine.adapters)a.fetchAccount=async()=>{accountCalls++;throw new Error('No private reads');};
    const result=await s.engine.verifyFundingCandidate('DOGE-binance-bybit');
    assert.ok(result);assert.equal(result.eligible,false);assert.ok(result.reasons.some(r=>r.includes('实盘执行锁定')));
    assert.equal(accountCalls,0);assert.equal(s.store.data.orders.length,0);
  }finally{s.cleanup();}
});

test('an unavailable live account clears its old displayed balance even after public quotes recover',async()=>{
  const data=fundingDataset(['DOGE']),s=setup('live',{fundingStatistics:()=>data});try{
    fundingMocks(s,()=>data);await s.engine.tick();assert.equal(s.engine.totals().availableBalanceUsd,20000);
    s.engine.adapter('binance').fetchAccount=async()=>{throw new Error('Account temporarily unavailable');};
    await s.engine.tick();assert.equal(s.engine.totals().availableBalanceUsd,null);
    assert.equal(s.engine.health.find(x=>x.exchange==='binance')?.balanceUsd,undefined);
    await s.engine.verifyFundingCandidate('DOGE-binance-bybit');
    assert.equal(s.engine.health.find(x=>x.exchange==='binance')?.status,'online');
    assert.equal(s.engine.liveReadiness().ready,false);assert.equal(s.engine.totals().availableBalanceUsd,null);
  }finally{s.cleanup();}
});

test('a legacy depth residual close continues next tick with a fresh book while entries remain paused',async()=>{
  const s=setup('live');try{
    const p=position(Date.now(),'live');s.store.data.positions.push(p);s.store.data.config.feeOnly=true;s.store.data.config.maxOrderRetries=0;
    let shortAttempts=0;const calls:Array<{exchange:string;price:number;quantity:number;reduceOnly:boolean}>=[];
    for(const adapter of s.engine.adapters){
      const side=adapter.id==='binance'?'long':'short';
      s.accounts.get(adapter.id)!.positions=[{base:p.base,symbol:p.long.symbol,side,quantity:10,markPrice:100,liquidationPrice:side==='long'?50:150,leverage:2}];
      adapter.fetchSnapshots=async()=>[snapshot(adapter.id,Date.now(),{markPrice:100,bids:[{price:100,quantity:100}],asks:[{price:shortAttempts?120:100,quantity:100}]})];
      adapter.placeOrder=async request=>{
        calls.push({exchange:adapter.id,price:request.limitPrice,quantity:request.quantity,reduceOnly:request.reduceOnly});
        const cancelled=adapter.id==='bybit'&&shortAttempts++===0;
        if(!cancelled)s.accounts.get(adapter.id)!.positions=[];
        return {id:`mock-${calls.length}`,clientOrderId:request.clientOrderId,status:cancelled?'cancelled':'filled',filledQuantity:cancelled?0:request.quantity,averagePrice:cancelled?0:request.limitPrice,feeUsd:0,timestamp:Date.now()};
      };
    }
    await (s.engine as any).continueClosing(p,'明确深度平仓',{pricing:'depth',requireProfit:false});assert.equal(p.status,'attention');assert.equal(p.long.quantity,0);assert.equal(p.short.quantity,10);
    assert(p.closeRequestedAt!==undefined);assert.equal(s.store.data.killSwitch,false);
    p.closeAttemptedAt=Date.now()-s.store.data.config.pollIntervalMs-1;
    await s.engine.tick();
    assert.equal(p.status,'closed');assert.equal(p.short.quantity,0);assert.equal(calls.length,3);
    assert.deepEqual(calls.filter(c=>c.exchange==='bybit').map(c=>c.price),[100,120]);
    assert(calls.every(c=>c.reduceOnly));assert.equal(s.engine.autoEnabled,false);assert.equal(s.store.data.killSwitch,false);
  }finally{s.cleanup();}
});

test('legacy depth residual management refuses changed account quantities and missing account reads',async()=>{
  for(const failedRead of [false,true]){
    const s=setup('live');try{
      const p=position(Date.now(),'live');s.store.data.positions.push(p);s.store.data.config.feeOnly=true;s.store.data.config.maxOrderRetries=0;
      let attempts=0;
      for(const adapter of s.engine.adapters){
        const side=adapter.id==='binance'?'long':'short';
        s.accounts.get(adapter.id)!.positions=[{base:p.base,symbol:p.long.symbol,side,quantity:10,markPrice:100,liquidationPrice:side==='long'?50:150,leverage:2}];
        adapter.placeOrder=async request=>{attempts++;const cancelled=adapter.id==='bybit';if(!cancelled)s.accounts.get(adapter.id)!.positions=[];
          return {id:'mock-close',clientOrderId:request.clientOrderId,status:cancelled?'cancelled':'filled',filledQuantity:cancelled?0:request.quantity,averagePrice:cancelled?0:request.limitPrice,feeUsd:0,timestamp:Date.now()};};
      }
      await (s.engine as any).continueClosing(p,'明确深度平仓',{pricing:'depth',requireProfit:false});assert.equal(attempts,2);p.closeAttemptedAt=Date.now()-s.store.data.config.pollIntervalMs-1;
      if(failedRead)s.engine.adapter('bybit').fetchAccount=async()=>{throw new Error('Mock unavailable account');};
      else s.accounts.get('bybit')!.positions[0].quantity=11;
      await s.engine.tick();assert.equal(attempts,2);assert.equal(p.short.quantity,10);assert.equal(p.status,'attention');
    }finally{s.cleanup();}
  }
});

test('a frozen entry switch from another pair does not liquidate a healthy hedged position',async()=>{
  const s=setup();try{
    const p=position(Date.now());s.store.data.positions.push(p);s.store.data.config.feeOnly=true;
    s.engine.halt('OTHER 配对订单未知，冻结新开仓');
    await s.engine.tick();assert.equal(p.status,'open');assert.equal(p.long.quantity,10);assert.equal(p.short.quantity,10);
    assert.equal(s.store.data.orders.length,0);assert.equal(s.engine.autoEnabled,false);
    await s.engine.control('kill');assert.equal(p.status,'closed');assert.equal(s.store.data.orders.length,2);
  }finally{s.cleanup();}
});

test('a current-session close with an unknown order queries its original id and never repeats its creation',async()=>{
  const s=setup('live');try{
    const p=position(Date.now(),'live');s.store.data.positions.push(p);s.store.data.config.feeOnly=true;
    const request={clientOrderId:'unknown-original',base:p.base,symbol:p.short.symbol,side:'sell' as const,quantity:10,limitPrice:100,reduceOnly:false};
    s.store.data.orders.push({positionId:p.id,exchange:'bybit',request,createdAt:Date.now(),result:{id:'original-id',clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()}});
    let queries=0;s.engine.adapter('bybit').reconcileOrder=async(req,id)=>{queries++;assert.equal(req.clientOrderId,'unknown-original');assert.equal(id,'original-id');
      return {id:id!,clientOrderId:req.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()};};
    await assert.rejects(s.engine.close(p.id),/未确认订单/);
    for(const [exchange,side] of [['binance','long'],['bybit','short']] as const)s.accounts.get(exchange)!.positions=[{base:p.base,symbol:p.long.symbol,side,quantity:10,markPrice:100,liquidationPrice:side==='long'?50:150,leverage:2}];
    await s.engine.tick();assert.equal(queries,1);assert.equal(s.submitted(),0);assert.equal(s.store.data.orders.length,1);assert.equal(p.status,'attention');
    assert(p.riskReasons.some(reason=>reason.includes('禁止重复下单')));
  }finally{s.cleanup();}
});

test('locked restart display preserves an unknown leg independently of overwritten risk messages',async()=>{
  const s=setup('live',{liveEnvironment:{}});try{
    const p=position(Date.now(),'live');p.status='attention';p.short.quantity=0;s.store.data.positions.push(p);
    const request={clientOrderId:'unknown-before-restart',base:p.base,symbol:p.short.symbol,side:'sell' as const,quantity:10,limitPrice:100,reduceOnly:false};
    s.store.data.orders.push({positionId:p.id,exchange:'bybit',request,createdAt:Date.now(),result:{id:'',clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()}});
    await s.engine.tick();assert(p.riskReasons.every(reason=>!reason.includes('订单状态未知')));
    assert.deepEqual(s.engine.state().unconfirmedOrders,[{positionId:p.id,exchange:'bybit'}]);
    assert.equal(s.store.data.orders[0].result!.status,'unknown');assert.equal(s.engine.liveUnlocked,false);assert.equal(s.submitted(),0);
  }finally{s.cleanup();}
});

test('generic authentication failures redact credential markers regardless of letter case',()=>{
  for(const message of ['AUTH FAILURE API_KEY=OFFLINE_PRIVATE_CANARY API_SECRET=OFFLINE_PRIVATE_CANARY',
    'Authentication failed Authorization: Bearer OFFLINE_PRIVATE_CANARY',
    'request HEADER contains Token=OFFLINE_PRIVATE_CANARY',
    'invalid API-Key OFFLINE_PRIVATE_CANARY',
    'transport SIGNATURE=OFFLINE_PRIVATE_CANARY']){
    const safe=safeMessage(new Error(message));assert.doesNotMatch(safe,/OFFLINE_PRIVATE_CANARY/);
    assert.equal(safe,'接口请求失败，请检查连接、权限和账户配置');
  }
  assert.equal(safeMessage(new Error('设置已在其他页面更新，请刷新后重新核对再保存')),'设置已在其他页面更新，请刷新后重新核对再保存');
  assert.equal(safeMessage(new Error('合约可用保证金不足')),'合约可用保证金不足');
});

test('legacy terminal receipts with foreign identity remain visible as current pending evidence',()=>{
  const s=setup('live',{liveEnvironment:{}});try{
    const p=position(Date.now(),'live');s.store.data.positions.push(p);
    const request={clientOrderId:'original-history',base:p.base,symbol:p.short.symbol,side:'sell' as const,quantity:10,limitPrice:100,reduceOnly:false};
    const row={positionId:p.id,exchange:'bybit' as const,request,createdAt:Date.now(),
      result:{id:'native-history',clientOrderId:'foreign-history',status:'filled' as const,filledQuantity:10,averagePrice:100,feeUsd:.1,timestamp:Date.now()}};
    s.store.data.orders.push(row);
    assert.deepEqual(s.engine.state().unconfirmedOrders,[{positionId:p.id,exchange:'bybit'}]);assert.equal(s.submitted(),0);
    p.accountClosure={confirmedAt:row.createdAt+1,reason:'independent flat account proof',historicalOrdersPending:true};
    assert.deepEqual(s.engine.state().unconfirmedOrders,[{positionId:p.id,exchange:'bybit',historical:true}]);assert.equal(s.submitted(),0);
  }finally{s.cleanup();}
});
