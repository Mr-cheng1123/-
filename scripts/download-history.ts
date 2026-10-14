import 'dotenv/config';
import ccxt from 'ccxt';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXCHANGES, type ExchangeId, type HistoricalRow } from '../src/shared/types.js';
import { configureExchangeTransport } from '../src/adapters/network.js';

export interface SettledRate { timestamp: number; rate: number }
export interface ClosedPrice { timestamp: number; price: number }

interface FundingHistoryClient {
  fetchFundingRateHistory(symbol: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<Array<{ timestamp?: number; fundingRate?: number }>>;
}

/** Bitget V2 has page numbers rather than time bounds. Never let a local `since` filter hide older page boundaries. */
export async function downloadBitgetFunding(client: FundingHistoryClient, symbol: string, from: number, to: number, budget: () => void): Promise<SettledRate[]> {
  const found = new Map<number, SettledRate>();
  let previousOldest = Infinity;
  for (let pageNo = 1; ; pageNo++) {
    budget();
    const page = await client.fetchFundingRateHistory(symbol, undefined, 100, { pageNo: String(pageNo), uta: false });
    if (!page.length) break;
    const valid = page.filter(r => Number.isFinite(r.timestamp) && Number.isFinite(r.fundingRate));
    if (!valid.length) throw new Error('Bitget 资金费历史页缺少有效时间或费率');
    const oldest = Math.min(...valid.map(r => r.timestamp!));
    if (oldest >= previousOldest) throw new Error('Bitget 资金费历史分页没有向过去前进');
    for (const row of valid) if (row.timestamp! >= from && row.timestamp! <= to) found.set(row.timestamp!, { timestamp: row.timestamp!, rate: row.fundingRate! });
    if (oldest <= from || page.length < 100) break;
    previousOldest = oldest;
  }
  return [...found.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** Prices become visible only after the candle has closed; rates only after their settlement. */
export function mergeHistory(exchange: ExchangeId, base: string, prices: ClosedPrice[], rates: SettledRate[], from: number, to: number, intervalHours: number): HistoricalRow[] {
  const out: HistoricalRow[] = [];
  const priceMap = new Map(prices.map(p => [p.timestamp, p]));
  const rateMap = new Map(rates.map(r => [r.timestamp, r]));
  const times = [...new Set([...priceMap.keys(), ...rateMap.keys()])].filter(t => t <= to).sort((a, b) => a - b);
  let price: ClosedPrice | undefined, rate: SettledRate | undefined;
  for (const timestamp of times) {
    price = priceMap.get(timestamp) ?? price;
    const realized = rateMap.get(timestamp);
    rate = realized ?? rate;
    if (timestamp < from || !price || !rate) continue;
    const nextFundingTime = rate.timestamp + intervalHours * 3_600_000;
    // A missing settlement is not extrapolated indefinitely into an invented later schedule.
    if (nextFundingTime <= timestamp && !realized) continue;
    out.push({ timestamp, exchange, base, markPrice: price.price, priceTimestamp: price.timestamp,
      fundingRate: rate.rate, nextFundingTime, intervalHours,
      ...(realized ? { settledFundingRate: realized.rate } : {}) });
  }
  return out;
}

function parameters(exchange: ExchangeId, from: number, to: number): Record<string, number | string> {
  if (exchange === 'okx') return { before: String(from - 1), after: String(to + 1) };
  if (exchange === 'gate') return { from: Math.floor(from / 1000), to: Math.floor(to / 1000) };
  return { endTime: to };
}
function parseArgs(args: string[]): Map<string, string> {
  const opts = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || !args[i + 1]) throw new Error(`参数需要 --名称 值：${args[i]}`);
    opts.set(args[i].slice(2), args[i + 1]);
  }
  const allowed = new Set(['from', 'to', 'exchanges', 'symbols', 'out', 'interval-hours', 'max-pages']);
  for (const name of opts.keys()) if (!allowed.has(name)) throw new Error(`未知参数：${name}`);
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const from = Date.parse(opts.get('from') ?? ''), to = Date.parse(opts.get('to') ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to > Date.now() || to - from > 31 * 86_400_000) throw new Error('必须提供 UTC --from 和 --to；范围须为过去的 1 至 31 天（也可少于一天）');
  const ids = (opts.get('exchanges') ?? EXCHANGES.join(',')).split(',') as ExchangeId[];
  if (!ids.length || ids.some(e => !EXCHANGES.includes(e))) throw new Error(`交易所支持 ${EXCHANGES.join(',')}`);
  const symbols = (opts.get('symbols') ?? 'BTC,ETH').split(',').map(x => x.trim().toUpperCase());
  if (!symbols.length || symbols.length > 10 || symbols.some(s => !/^[A-Z0-9]{2,20}$/.test(s))) throw new Error('币种应为 BTC,ETH 等基础币代码，最多 10 个');
  const interval = Number(opts.get('interval-hours') ?? 8), maxPages = Number(opts.get('max-pages') ?? 500);
  if (!Number.isFinite(interval) || interval < 1 || interval > 24 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 2000) throw new Error('interval-hours 应在 1–24，max-pages 应为 1–2000 整数');
  const output = resolve(opts.get('out') ?? 'data/history.json');
  const records: HistoricalRow[] = [], warnings: string[] = [
    '价格是永续合约 1 分钟已收盘 OHLCV 的收盘价代理，不是历史标记价；不会提前使用未收盘 K 线。',
    'fundingRate 使用最后已结算费率作下一次预测，是延迟一周期的持续性模型，不是交易所当时发布的预测费率。',
    `历史结算周期按用户假设 ${interval} 小时构造；如期间调频，请分段下载或用实际记录修正 nextFundingTime 和 intervalHours。`,
    '没有历史盘口、OI 和逐笔成交；回测不能验证流动性过滤。建议 maxSnapshotAgeMs 至少 90000 以容纳 1 分钟 K 线。',
  ];
  let requests = 0;
  const budget = () => { if (++requests > maxPages) throw new Error(`请求页数超过 --max-pages ${maxPages}，请缩短区间或增加上限`); };
  for (const id of ids) {
    const constructors = { binance: ccxt.binanceusdm, bybit: ccxt.bybit, okx: ccxt.okx, gate: ccxt.gate, bitget: ccxt.bitget };
    const exchange = new constructors[id]({ enableRateLimit: true, timeout: 20_000, options: { defaultType: 'swap', defaultSubType: 'linear' } });
    try {
      await configureExchangeTransport(exchange, id);
      budget(); await exchange.loadMarkets();
      for (const base of symbols) {
        const symbol = `${base}/USDT:USDT`, market = exchange.markets?.[symbol];
        if (!market?.swap || !market.linear || market.settle !== 'USDT') { warnings.push(`${id} ${base} 无支持的线性 USDT 永续，跳过。`); continue; }
        const rates: SettledRate[] = [], prices: ClosedPrice[] = [];
        const warmup = from - Math.max(24, interval * 2) * 3_600_000;
        if (id === 'bitget') rates.push(...await downloadBitgetFunding(exchange, symbol, warmup, to, budget));
        // At most 24 hourly settlements per window: comfortably below each venue's page limit.
        else for (let cursor = warmup; cursor < to; cursor += 86_400_000) {
          const end = Math.min(to, cursor + 86_400_000 - 1);
          budget();
          const page = await exchange.fetchFundingRateHistory(symbol, cursor, 200, parameters(id, cursor, end));
          for (const row of page) {
            const timestamp = Number(row.timestamp);
            const info = row.info as Record<string, unknown> | undefined;
            // OKX may expose both a predicted and a realized historical rate.
            const rate = Number(id === 'okx' && info?.realizedRate !== undefined && info.realizedRate !== '' ? info.realizedRate : row.fundingRate);
            if (Number.isFinite(timestamp) && Number.isFinite(rate) && timestamp >= cursor && timestamp <= end) rates.push({ timestamp, rate });
          }
        }
        for (let cursor = warmup; cursor < to;) {
          budget();
          const page = await exchange.fetchOHLCV(symbol, '1m', cursor, id === 'bitget' ? 200 : 1000, id === 'bitget' ? { useHistoryEndpoint: true, uta: false } : {});
          if (!page.length) break;
          let last = cursor - 1;
          for (const candle of page) {
            const openTime = Number(candle[0]), price = Number(candle[4]);
            if (!Number.isFinite(openTime) || !Number.isFinite(price) || price <= 0) continue;
            last = Math.max(last, openTime);
            const closedAt = openTime + 60_000;
            if (closedAt <= to && closedAt <= Date.now()) prices.push({ timestamp: closedAt, price });
          }
          if (last < cursor) { warnings.push(`${id} ${base} K 线分页没有前进，已停止。`); break; }
          cursor = last + 60_000;
        }
        const merged = mergeHistory(id, base, prices, rates, from, to, interval);
        if (!merged.length) warnings.push(`${id} ${base} 未得到可用重叠数据，可能超出交易所历史保存范围。`);
        if (prices.some((p, i) => i > 0 && p.timestamp - prices[i - 1].timestamp > 120_000)) warnings.push(`${id} ${base} K 线有缺口；回测按 priceTimestamp 检测过期价格。`);
        records.push(...merged);
        console.log(`${id} ${base}: ${rates.length} 次结算, ${prices.length} 个已收盘价格, ${merged.length} 行`);
      }
    } catch (error) {
      warnings.push(`${id} 下载失败：${error instanceof Error ? error.message : String(error)}`);
      console.error(warnings.at(-1));
    } finally { await exchange.close(); }
  }
  if (!records.length) throw new Error('所有交易所均无可用历史数据；未生成空结果');
  records.sort((a, b) => a.timestamp - b.timestamp);
  await mkdir(dirname(output), { recursive: true });
  // Plain array imports directly into the dashboard; provenance stays alongside it.
  await writeFile(output, JSON.stringify(records), 'utf8');
  await writeFile(`${output}.meta.json`, JSON.stringify({ source: 'exchange-public-history', generatedAt: new Date().toISOString(), from, to, exchanges: ids, symbols, requests, intervalHoursAssumption: interval, rows: records.length, warnings }, null, 2), 'utf8');
  console.log(`已保存 ${records.length} 行：${output}\n说明：${output}.meta.json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
