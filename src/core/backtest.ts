import type { AppConfig, BacktestResult, ExchangeId, HistoricalRow } from '../shared/types.js';
import { fundingCount } from './strategy.js';
import { isFeeOnly } from '../shared/strategy-profile.js';

type Observation = HistoricalRow & { priceTimestamp?: number; openInterestUsd?: number; volume24hUsd?: number };
interface Leg { exchange: ExchangeId; quantity: number; entry: number; reference: number; margin: number }
interface Trade {
  base: string; openedAt: number; exitAt: number; long: Leg; short: Leg;
  funding: number; fees: number; costs: number; received: Set<string>;
}
const HOUR = 3_600_000;
const key = (exchange: ExchangeId, base: string) => `${exchange}:${base}`;

/** Chronological event replay. A settled rate is credited before the same row becomes a signal. */
export function runBacktest(input: HistoricalRow[], config: AppConfig, source = '导入历史数据'): BacktestResult {
  if(config.dualAdvantageEnabled)throw new Error('资金费与价差双优势策略需要历史双腿深度盘口及数量精度；当前 funding/价格回放不能验证该入场策略。可使用录制盘口的隔离执行验证，或明确关闭双优势后回测原策略。');
  if(config.holdMode==='adaptive')throw new Error('自主判断持仓暂不支持仅 funding/价格历史回测：缺少逐时点双腿平仓盘口与连续新鲜观测，不能可靠重放增量退出成本和确认过程。请选择 once 或 continuous；此限制不会静默改用其他策略。');
  const feeOnly=isFeeOnly(config);
  const warnings = new Set<string>([
    '历史回放按输入记录的观察时间处理；数据提供方必须保证 fundingRate 在该时间已知。',
    config.feeOnly?'没有历史完整盘口时，成交采用记录的买卖报价；缺少报价时退回标记价格，不追加滑点预算，也不能验证真实成交深度或部分成交。':'没有历史完整盘口时，成交采用买卖报价加固定滑点，不能验证真实成交深度、部分成交或交易所故障。',
    '回测没有历史强平规则、自动减仓和逐时保证金档位，不能作为实盘收益保证。',
  ]);
  if(feeOnly)warnings.add('当前为仅扣手续费筛选：入场仅比较预计资金费与双腿开平手续费；回放成交价差和实际手续费仍计入最终损益。');
  const result: BacktestResult = { source, start: 0, end: 0, trades: 0, winRatePct: 0, fundingUsd: 0, feesUsd: 0, spreadPnlUsd: 0, netPnlUsd: 0, maxDrawdownUsd: 0, equity: [], warnings: [], closedTrades: [] };
  if (!input.length) return { ...result, warnings: ['历史数据为空。'] };
  if (!(Number.isFinite(config.leverage)&&config.leverage > 0 && (config.feeOnly||config.leverage <= config.maxLeverage))) throw new Error('回测杠杆超过限制或无效');
  const rows = [...input] as Observation[];
  for (const row of rows) {
    if (![row.timestamp, row.markPrice, row.fundingRate, row.nextFundingTime, row.intervalHours].every(Number.isFinite) || row.markPrice <= 0 || row.intervalHours <= 0) throw new Error('历史数据包含无效价格、时间、费率或结算周期');
    if (row.settledFundingRate !== undefined && !Number.isFinite(row.settledFundingRate)) throw new Error('历史结算费率无效');
    if (row.priceTimestamp !== undefined && (!Number.isFinite(row.priceTimestamp) || row.priceTimestamp > row.timestamp)) throw new Error('价格时间晚于观察时间，存在前视数据');
    if (!(row.exchange in config.takerFees)) throw new Error(`不支持的交易所：${row.exchange}`);
  }
  rows.sort((a, b) => a.timestamp - b.timestamp || key(a.exchange, a.base).localeCompare(key(b.exchange, b.base)));
  result.start = rows[0].timestamp; result.end = rows.at(-1)!.timestamp;
  const latest = new Map<string, Observation>();
  const open: Trade[] = [];
  const balances = Object.fromEntries(config.exchanges.map(e => [e, config.initialBalanceUsd])) as Record<ExchangeId, number>;
  const settled = new Set<string>();
  let cashPnl = 0, peak = 0;
  const slip = config.feeOnly?0:config.exitSlippageBps / 10_000;
  const quote = (row: Observation, side: 'buy' | 'sell') => (side === 'buy' ? row.askPrice ?? row.markPrice : row.bidPrice ?? row.markPrice) * (side === 'buy' ? 1 + slip : 1 - slip);
  const fresh = (row: Observation | undefined, now: number): row is Observation => !!row && now - row.timestamp <= config.maxSnapshotAgeMs && now - (row.priceTimestamp ?? row.timestamp) <= config.maxSnapshotAgeMs;
  const get = (t: Trade, leg: Leg) => latest.get(key(leg.exchange, t.base));
  const unrealized = (t: Trade) => t.long.quantity * ((get(t, t.long)?.markPrice ?? t.long.reference) - t.long.entry) + t.short.quantity * (t.short.entry - (get(t, t.short)?.markPrice ?? t.short.reference));
  const gross = (t: Trade) => t.long.quantity * (get(t, t.long)?.markPrice ?? t.long.reference) + t.short.quantity * (get(t, t.short)?.markPrice ?? t.short.reference);
  const sample = (timestamp: number) => {
    const equity = cashPnl + open.reduce((sum, t) => sum + unrealized(t), 0);
    peak = Math.max(peak, equity); result.maxDrawdownUsd = Math.max(result.maxDrawdownUsd, peak - equity);
    result.equity.push({ timestamp, netPnlUsd: equity, fundingUsd: result.fundingUsd, feesUsd: result.feesUsd });
  };
  const close = (trade: Trade, now: number, reason: string) => {
    const longRow = get(trade, trade.long), shortRow = get(trade, trade.short);
    if (!longRow || !shortRow) throw new Error('内部错误：持仓缺少开仓行情');
    if (!fresh(longRow, now) || !fresh(shortRow, now)) warnings.add('有持仓使用过期的最后已知价格退出；该笔结果不代表当时可成交价格。');
    const longExit = quote(longRow, 'sell'), shortExit = quote(shortRow, 'buy');
    const longPnl = trade.long.quantity * (longExit - trade.long.entry), shortPnl = trade.short.quantity * (trade.short.entry - shortExit);
    const longFee = trade.long.quantity * longExit * config.takerFees[trade.long.exchange], shortFee = trade.short.quantity * shortExit * config.takerFees[trade.short.exchange];
    const pnl = longPnl + shortPnl, fee = longFee + shortFee;
    balances[trade.long.exchange] += longPnl - longFee; balances[trade.short.exchange] += shortPnl - shortFee;
    cashPnl += pnl - fee; result.spreadPnlUsd += pnl; result.feesUsd += fee; trade.fees += fee;
    result.closedTrades.push({ base: trade.base, openedAt: trade.openedAt, closedAt: now, netPnlUsd: trade.funding + pnl - trade.fees - trade.costs });
    if (reason === 'missing-settlement') warnings.add('部分预定结算缺少已实现费率，未补造资金费收益，已退出相关持仓。');
    open.splice(open.indexOf(trade), 1);
  };
  for (let cursor = 0; cursor < rows.length;) {
    const now = rows[cursor].timestamp, group: Observation[] = [];
    while (cursor < rows.length && rows[cursor].timestamp === now) group.push(rows[cursor++]);
    // Settlement uses only a position held strictly before the event, never a same-timestamp entry.
    for (const row of group) {
      if (row.settledFundingRate === undefined) continue;
      const event = `${key(row.exchange, row.base)}:${now}`;
      if (settled.has(event)) { warnings.add('重复资金费结算记录已去重。'); continue; }
      settled.add(event);
      for (const t of open.filter(t => t.base === row.base && t.openedAt < now)) {
        for (const [leg, sign] of [[t.long, -1], [t.short, 1]] as const) {
          if (leg.exchange !== row.exchange) continue;
          if (now - (row.priceTimestamp ?? row.timestamp) > config.maxSnapshotAgeMs) { warnings.add('结算记录价格过期，该笔资金费未计入；请补充结算标记价格。'); continue; }
          const amount = sign * leg.quantity * row.markPrice * row.settledFundingRate;
          t.funding += amount; t.received.add(row.exchange); balances[leg.exchange] += amount;
          cashPnl += amount; result.fundingUsd += amount;
        }
      }
    }
    for (const row of group) latest.set(key(row.exchange, row.base), row);
    for (const t of [...open]) {
      const l = get(t, t.long), s = get(t, t.short);
      if (!fresh(l, now) || !fresh(s, now)) { close(t, now, 'stale'); continue; }
      const basis = Math.abs(s.markPrice - l.markPrice) / ((s.markPrice + l.markPrice) / 2) * 10_000;
      const delta = Math.abs(t.long.quantity - t.short.quantity) * ((l.markPrice + s.markPrice) / 2);
      const adverseLong = Math.max(0, (t.long.entry - l.markPrice) / t.long.entry), adverseShort = Math.max(0, (s.markPrice - t.short.entry) / t.short.entry);
      const approximateMarginDistance = 100 * (1 / config.leverage - Math.max(adverseLong, adverseShort));
      if ((!feeOnly&&(basis > config.maxBasisBps || approximateMarginDistance <= config.minLiquidationDistancePct)) || (!config.feeOnly&&delta > config.maxDeltaUsd) || now - t.openedAt >= config.maxHoldHours * HOUR) { close(t, now, 'risk'); continue; }
      if (config.holdMode === 'once' && now >= t.exitAt) { close(t, now, t.received.size < 2 ? 'missing-settlement' : 'funded'); continue; }
      if (!feeOnly && config.holdMode === 'continuous' && s.fundingRate / s.intervalHours - l.fundingRate / l.intervalHours <= 0) close(t, now, 'rate-flip');
    }
    // Rank only information observed by now. No future rows or settled rates are consulted.
    const candidates: Array<{ base: string; l: Observation; s: Observation; lq: number; sq: number; edge: number; costs: number }> = [];
    for (const base of config.symbols) {
      if (open.some(t => t.base === base)) continue;
      const available = config.exchanges.map(e => latest.get(key(e, base))).filter(r => fresh(r, now));
      for (const l of available) for (const s of available) {
        if (l.exchange === s.exchange) continue;
        if (l.nextFundingTime <= now || s.nextFundingTime <= now || (!feeOnly&&Math.max(l.nextFundingTime, s.nextFundingTime) - now > config.entryWindowSec * 1000)) continue;
        if (!feeOnly&&(Math.abs(l.nextFundingTime - s.nextFundingTime) > config.maxSettlementSkewSec * 1000 || Math.abs(l.intervalHours - s.intervalHours) > 1e-9)) continue;
        const average = (l.markPrice + s.markPrice) / 2, basis = Math.abs(s.markPrice - l.markPrice) / average * 10_000;
        if (!feeOnly&&basis > config.maxBasisBps) continue;
        const lq = config.orderNotionalUsd / (config.hedgeMode === 'base' ? average : l.markPrice), sq = config.orderNotionalUsd / (config.hedgeMode === 'base' ? average : s.markPrice);
        if (!config.feeOnly&&Math.abs(lq - sq) * average > config.maxDeltaUsd) continue;
        if (!feeOnly&&[l, s].some(r => r.openInterestUsd !== undefined && r.openInterestUsd < config.minOpenInterestUsd || r.volume24hUsd !== undefined && r.volume24hUsd < config.minVolume24hUsd)) continue;
        if (!feeOnly&&[l, s].some(r => r.openInterestUsd === undefined || r.volume24hUsd === undefined)) warnings.add('数据缺少历史 OI 或成交量，回测未验证相应流动性门槛；实盘机会仍需满足门槛。');
        const entryL = quote(l, 'buy'), entryS = quote(s, 'sell');
        const entrySlipBps = Math.max((entryL / l.markPrice - 1) * 10_000, (1 - entryS / s.markPrice) * 10_000);
        if (!feeOnly&&entrySlipBps > config.maxSlippageBps) continue;
        const nominalL = lq * l.markPrice, nominalS = sq * s.markPrice;
        const horizon = config.holdMode === 'continuous' ? now + config.maxHoldHours * HOUR
          : Math.min(Math.max(l.nextFundingTime, s.nextFundingTime) + config.exitDelaySec * 1000, now + config.maxHoldHours * HOUR);
        if (horizon < Math.max(l.nextFundingTime, s.nextFundingTime)) continue;
        const predicted = nominalS * s.fundingRate * fundingCount(s, horizon, now) - nominalL * l.fundingRate * fundingCount(l, horizon, now);
        const conservative = predicted >= 0 ? predicted * config.fundingSafetyFactor : predicted / config.fundingSafetyFactor;
        const fee = 2 * (nominalL * config.takerFees[l.exchange] + nominalS * config.takerFees[s.exchange]);
        const executionCost = lq * (entryL - quote(l, 'sell')) + sq * (quote(s, 'buy') - entryS);
        const costs = feeOnly?0:config.transferCostUsd + config.rebalanceCostUsd;
        const edge = feeOnly?predicted-fee:conservative - fee - executionCost - costs - config.orderNotionalUsd * config.basisStressBps / 10_000;
        if (feeOnly?edge<=0:predicted / config.orderNotionalUsd * 10_000 < config.minNetRateBps || edge < config.minNetProfitUsd) continue;
        candidates.push({ base, l, s, lq, sq, edge, costs });
      }
    }
    candidates.sort((a, b) => b.edge - a.edge);
    for (const c of candidates) {
      if (now === result.end || open.some(t => t.base === c.base)) continue;
      const exposure = c.lq * c.l.markPrice + c.sq * c.s.markPrice;
      if (!config.feeOnly&&(exposure > config.maxPositionPerCoinUsd || exposure + open.reduce((sum, t) => sum + gross(t), 0) > config.maxTotalPositionUsd)) continue;
      const le = quote(c.l, 'buy'), se = quote(c.s, 'sell');
      const lf = c.lq * le * config.takerFees[c.l.exchange], sf = c.sq * se * config.takerFees[c.s.exchange];
      const lm = c.lq * le / config.leverage, sm = c.sq * se / config.leverage;
      const free = (exchange: ExchangeId) => balances[exchange] - open.reduce((sum, t) => sum + (t.long.exchange === exchange ? t.long.margin : 0) + (t.short.exchange === exchange ? t.short.margin : 0), 0);
      if (free(c.l.exchange) < lm + lf + c.costs / 2 || free(c.s.exchange) < sm + sf + c.costs / 2) continue;
      balances[c.l.exchange] -= lf + c.costs / 2; balances[c.s.exchange] -= sf + c.costs / 2;
      cashPnl -= lf + sf + c.costs; result.feesUsd += lf + sf;
      open.push({ base: c.base, openedAt: now, exitAt: Math.max(c.l.nextFundingTime, c.s.nextFundingTime) + config.exitDelaySec * 1000,
        long: { exchange: c.l.exchange, quantity: c.lq, entry: le, reference: c.l.markPrice, margin: lm },
        short: { exchange: c.s.exchange, quantity: c.sq, entry: se, reference: c.s.markPrice, margin: sm }, funding: 0, fees: lf + sf, costs: c.costs, received: new Set() });
    }
    sample(now);
  }
  for (const t of [...open]) close(t, result.end, 'end-of-data');
  sample(result.end);
  result.trades = result.closedTrades.length;
  result.winRatePct = result.trades ? 100 * result.closedTrades.filter(t => t.netPnlUsd > 0).length / result.trades : 0;
  result.netPnlUsd = cashPnl; result.warnings = [...warnings];
  return result;
}

/** Reproducible artificial observations; intentionally not an exchange performance history. */
export function generateDemoHistory(): HistoricalRow[] {
  const rows: HistoricalRow[] = [];
  const start = Date.UTC(2026, 0, 1), interval = 8 * HOUR, step = 30_000;
  for (let cycle = 0; cycle < 18; cycle++) {
    const settlement = start + (cycle + 1) * interval;
    // Sparse windows keep the fixture small while providing observations before each settlement.
    for (let offset = -5 * 60_000; offset <= 60_000; offset += step) {
      const time = settlement + offset;
      for (const [index, exchange] of (['binance', 'bybit', 'okx', 'gate'] as ExchangeId[]).entries()) {
        const regime = Math.floor(cycle / 6) % 2;
        const rate = (index === (regime ? 0 : 1) ? 0.0065 : 0.00008) + Math.sin(cycle + index) * 0.00003;
        const mark = 90_000 + cycle * 110 + Math.sin(offset / 80_000) * 30 + index * 3;
        rows.push({ timestamp: time, exchange, base: 'BTC', markPrice: mark, fundingRate: rate,
          nextFundingTime: offset < 0 ? settlement : settlement + interval, intervalHours: 8,
          ...(offset === 0 ? { settledFundingRate: rate } : {}), bidPrice: mark * 0.99999, askPrice: mark * 1.00001 });
      }
    }
  }
  return rows;
}
