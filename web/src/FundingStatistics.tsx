import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowDownRight, ArrowLeftRight, ArrowUp, ArrowUpRight, ChevronLeft, ChevronRight, CircleHelp, Clock3, Database, ExternalLink, LoaderCircle, Radio, RefreshCw, Search, ShieldAlert, X } from 'lucide-react';
import { EXCHANGES, type ExchangeId } from '../../src/shared/types';
import { comparableRate, fundingCellIsFresh, summarizeFundingRow, type FundingRange, type FundingStatsCell, type FundingStatsResponse, type FundingStatsRow } from '../../src/shared/funding-statistics';
import { nextFundingStatisticsTransition } from './funding-statistics-clock';
import { displayPollInterval, listenForForeground } from './display-polling';
import { useBoundedPage } from './use-bounded-page';
import { fundingStatisticsExchanges, scopeFundingStatistics } from './funding-statistics-scope';
import './funding-statistics.css';

type SourceChoice = 'auto' | 'exchanges' | 'coinglass';
type RateBasis = 'native' | '8h';
type SortKey = 'base' | 'gap' | 'apr' | ExchangeId;
const names: Record<ExchangeId, string> = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX', gate: 'Gate', bitget: 'Bitget' };
const marks: Record<ExchangeId, string> = { binance: 'B', bybit: 'By', okx: 'OK', gate: 'G', bitget: 'Bt' };
const ranges: { key: FundingRange; label: string }[] = [{ key: 'current', label: '当前费率' }, { key: '1d', label: '1 天累计' }, { key: '7d', label: '7 天累计' }, { key: '30d', label: '30 天累计' }, { key: '365d', label: '365 天累计' }];
const rateFormats = new Map<number, Intl.NumberFormat>();
const rateFormat = (decimals: number) => {
  let formatter = rateFormats.get(decimals);
  if (!formatter) { formatter = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }); rateFormats.set(decimals, formatter); }
  return formatter;
};
const countFormat = new Intl.NumberFormat('en-US');
const compactFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const aprFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const formatRate = (value: number | null, decimals = 4) => value === null ? '—' : `${value > 0 ? '+' : ''}${rateFormat(decimals).format(value * 100)}%`;
const date = (timestamp: number | null) => timestamp ? dateFormat.format(timestamp) : '—';
const age = (timestamp: number, now: number) => !timestamp ? '尚未收到' : now - timestamp < 60000 ? `${Math.max(0, Math.floor((now - timestamp) / 1000))} 秒前` : now - timestamp < 3600000 ? `${Math.floor((now - timestamp) / 60000)} 分钟前` : `${Math.floor((now - timestamp) / 3600000)} 小时前`;
const signClass = (rate: number | null) => rate === null || rate === 0 ? '' : rate > 0 ? 'positive' : 'negative';
const sourceName = (source?: FundingStatsResponse['source'], exchangeCount: number = EXCHANGES.length) => source === 'coinglass' ? 'CoinGlass 官方 API' : source === 'exchanges' ? exchangeCount === EXCHANGES.length ? '五所官方接口' : '已接入交易所官方接口' : source === 'demo' ? '合成演示数据' : '正在确认数据来源';
const dollar = (value?: number) => value === undefined || !Number.isFinite(value) ? '—' : `$${compactFormat.format(value)}`;
const freshnessLimit = (milliseconds: number) => milliseconds >= 3600000 ? `${(milliseconds / 3600000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 小时` : `${Math.ceil(milliseconds / 1000)} 秒`;
const PAGE_SIZE = 50;

function AgeLabel({ timestamp }: { timestamp: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <>{age(timestamp, now)}</>;
}

function useStatistics(source: SourceChoice, range: FundingRange) {
  const [data, setData] = useState<FundingStatsResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    let disposed = false, inFlight = false, received = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: AbortController | undefined;
    setData(null);
    setError('');
    const poll = async (foreground = false) => {
      if (disposed || inFlight) return;
      inFlight = true;
      if (!received || foreground) setLoading(true);
      const controller = new AbortController();
      active = controller;
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`/api/funding-statistics?source=${source}&range=${range}`, { signal: controller.signal, cache: 'no-store' });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `统计接口返回 ${response.status}`);
        if (!result || !Array.isArray(result.rows) || !['coinglass', 'exchanges', 'demo'].includes(result.source)) throw new Error('统计接口返回了无效数据');
        if (!disposed) { received = true; setData(result as FundingStatsResponse); setError(''); }
      } catch (err) {
        if (!disposed) setError((err as Error).name === 'AbortError' ? '统计请求超过 8 秒，已取消并等待重试。现有数据会保留，过期值不参与排行。' : (err as Error).message);
      } finally {
        clearTimeout(timeout);
        inFlight = false;
        if (!disposed) { setLoading(false); timer = setTimeout(() => void poll(), displayPollInterval(5000)); }
      }
    };
    reload.current = () => { if (!inFlight) { clearTimeout(timer); void poll(true); } };
    const stopListening = listenForForeground(() => { reload.current(); });
    void poll();
    return () => { disposed = true; active?.abort(); clearTimeout(timer); stopListening(); reload.current = () => {}; };
  }, [source, range]);
  return { data, error, loading, reload: () => reload.current() };
}

function Venue({ exchange }: { exchange: ExchangeId }) {
  return <span className="venue"><span className={`venue-mark ${exchange}`}>{marks[exchange]}</span>{names[exchange]}</span>;
}

function selectedRow(row: FundingStatsRow, predicted: boolean): FundingStatsRow {
  if (!predicted) return row;
  return { base: row.base, cells: Object.fromEntries(Object.entries(row.cells).map(([exchange, cell]) => [exchange, { ...cell, rate: cell!.predictedRate ?? Number.NaN, available: cell!.available && typeof cell!.predictedRate === 'number' }])) };
}

export default function FundingStatistics({ source, onSourceChange, sourceBusy = false, onViewOpportunities, exchanges }: { source: SourceChoice; onSourceChange: (source: SourceChoice) => Promise<void>; sourceBusy?: boolean; onViewOpportunities?: (base?: string) => void; exchanges?: readonly ExchangeId[] }) {
  const [range, setRange] = useState<FundingRange>('current');
  const [basis, setBasis] = useState<RateBasis>('8h');
  const [predicted, setPredicted] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'comparable' | 'negative'>('all');
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'gap', direction: 'desc' });
  const [expiryRevision, setExpiryRevision] = useState(0);
  const [selection, setSelection] = useState<{ base: string; exchange: ExchangeId } | null>(null);
  const { data: unscopedData, error, loading, reload } = useStatistics(source, range);
  const exchangeScopeKey = fundingStatisticsExchanges(exchanges).join(',');
  const visibleExchanges = useMemo(() => fundingStatisticsExchanges(exchanges), [exchangeScopeKey]);
  const data = useMemo(() => unscopedData ? scopeFundingStatistics(unscopedData, visibleExchanges) : null, [unscopedData, visibleExchanges]);
  const now = useMemo(() => Date.now(), [data, expiryRevision]);
  useEffect(() => {
    const deadline = nextFundingStatisticsTransition(data, now);
    if (deadline === undefined) return;
    const timer = setTimeout(() => setExpiryRevision(value => value + 1), Math.min(2_147_483_647, Math.max(1, deadline - Date.now())));
    return () => clearTimeout(timer);
  }, [data, now]);
  useEffect(() => { setPage(1); setSelection(null); }, [source, range, basis, predicted, search, filter, sort]);
  useEffect(() => {
    setPage(1);
    setSelection(previous => previous && visibleExchanges.includes(previous.exchange) ? previous : null);
    setSort(previous => previous.key === 'base' || previous.key === 'gap' || previous.key === 'apr' || visibleExchanges.includes(previous.key) ? previous : { key: 'gap', direction: 'desc' });
  }, [visibleExchanges]);
  const cumulative = range !== 'current';
  const selectedPredicted = !cumulative && predicted;
  const historicalAvailable = source !== 'exchanges' && !!data?.coinglassConfigured;
  const viewLabel = cumulative ? ranges.find(r => r.key === range)!.label : selectedPredicted ? basis === '8h' ? '预测费率 · 8h 归一' : '预测费率 · 原周期' : basis === '8h' ? '当前费率 · 8h 归一' : '当前费率 · 原周期';

  const result = useMemo(() => {
    if (!data) return { rows: [], high: null, low: null, largestGap: null, freshCells: 0, staleCells: 0 };
    const filtered = data.rows.filter(row => row.base.toLowerCase().includes(search.trim().toLowerCase())).map(row => {
      const summary = summarizeFundingRow(selectedRow(row, selectedPredicted), data, now);
      const cellValues = visibleExchanges.flatMap(exchange => {
        const cell = row.cells[exchange];
        if (!cell || !fundingCellIsFresh(cell, data, now)) return [];
        const value = comparableRate(cell, range, basis, selectedPredicted);
        return value === null ? [] : [{ base: row.base, exchange, cell, value }];
      });
      return { row, summary, cellValues };
    }).filter(item => filter === 'comparable' ? item.summary.gap !== null : filter === 'negative' ? item.cellValues.some(c => c.value < 0) : true);
    const values = filtered.flatMap(item => item.cellValues);
    let high: typeof values[number] | null = null, low: typeof values[number] | null = null;
    for (const value of values) { if (!high || value.value > high.value) high = value; if (!low || value.value < low.value) low = value; }
    const largestGap = [...filtered].filter(item => item.summary.gap !== null).sort((a, b) => b.summary.gap! - a.summary.gap!)[0] || null;
    filtered.sort((a, b) => {
      if (sort.key === 'base') return a.row.base.localeCompare(b.row.base) * (sort.direction === 'asc' ? 1 : -1);
      const valueFor = (item: typeof a) => sort.key === 'gap' ? item.summary.gap : sort.key === 'apr' ? item.summary.aprPct : item.cellValues.find(c => c.exchange === sort.key)?.value ?? null;
      const left = valueFor(a), right = valueFor(b);
      if (left === null && right === null) return a.row.base.localeCompare(b.row.base);
      if (left === null) return 1;
      if (right === null) return -1;
      return (left - right) * (sort.direction === 'asc' ? 1 : -1) || a.row.base.localeCompare(b.row.base);
    });
    const allCells = data.rows.flatMap(row => Object.values(row.cells)).filter((cell): cell is FundingStatsCell => !!cell);
    return { rows: filtered, high, low, largestGap, freshCells: allCells.filter(cell => fundingCellIsFresh(cell, data, now)).length, staleCells: allCells.filter(cell => !fundingCellIsFresh(cell, data, now)).length };
  }, [data, now, search, filter, sort, range, basis, selectedPredicted, visibleExchanges]);

  const pageCount = Math.max(1, Math.ceil(result.rows.length / PAGE_SIZE));
  const [visiblePage, setPage] = useBoundedPage(pageCount);
  const shown = result.rows.slice((visiblePage - 1) * PAGE_SIZE, visiblePage * PAGE_SIZE);
  const selectedCell = selection && visibleExchanges.includes(selection.exchange) && data?.rows.find(row => row.base === selection.base)?.cells[selection.exchange];
  const selectedSummary = selection && data ? summarizeFundingRow(selectedRow(data.rows.find(row => row.base === selection.base) || { base: selection.base, cells: {} }, selectedPredicted), data, now) : null;
  const selectedWeightCoverage = (field: 'openInterestUsd' | 'volume24hUsd') => selection && data ? Object.values(selectedRow(data.rows.find(row => row.base === selection.base) || { base: selection.base, cells: {} }, selectedPredicted).cells).filter((cell): cell is FundingStatsCell => !!cell && fundingCellIsFresh(cell, data, now) && comparableRate(cell, range, '8h') !== null && Number.isFinite(cell[field]) && (cell[field] ?? 0) > 0).length : 0;
  const sortBy = (key: SortKey) => setSort(old => ({ key, direction: old.key === key ? old.direction === 'asc' ? 'desc' : 'asc' : key === 'base' ? 'asc' : 'desc' }));
  const SortIcon = ({ column }: { column: SortKey }) => sort.key !== column ? <ArrowDown size={11} className="sort-idle"/> : sort.direction === 'desc' ? <ArrowDown size={11}/> : <ArrowUp size={11}/>;
  const changeRange = (next: FundingRange) => { setRange(next); if (next !== 'current') { setPredicted(false); if (sort.key === 'apr') setSort({ key: 'gap', direction: 'desc' }); } };
  const selectSource = async (next: SourceChoice) => { try { await onSourceChange(next); if (next === 'exchanges' && cumulative) setRange('current'); } catch {} };
  const datasetWarning = data && ['error', 'stale', 'unsupported', 'not_configured'].includes(data.status);
  const emptyTitle = !visibleExchanges.length ? '尚无已接入的交易账户' : error ? '统计接口暂不可用' : data?.status === 'not_configured' ? 'CoinGlass 尚未连接' : data?.status === 'unsupported' ? '当前来源不支持这个累计区间' : data?.status === 'error' ? '数据来源暂不可用' : loading || data?.status === 'loading' ? '正在采集资金费率统计' : search || filter !== 'all' ? '没有符合筛选条件的币种' : '暂未收到可显示的费率';

  return <div className="funding-statistics">
    <section className="panel funding-source-panel">
      <div className="funding-source-heading"><div><span className="funding-source-icon"><Database size={20}/></span><div><h2>{sourceName(data?.source, visibleExchanges.length)}</h2><p>{data?.marginScope || (visibleExchanges.length === EXCHANGES.length ? '同一币种横向对比五所永续合约资金费率' : '同一币种横向对比已接入交易所永续合约资金费率')}</p></div></div><div className="funding-source-controls">{onViewOpportunities && <button className="btn funding-go-opportunities" onClick={() => onViewOpportunities(search.trim().toUpperCase() || undefined)}><ArrowLeftRight size={14}/>查看套利机会</button>}<label><span>数据来源</span><select aria-label="统计数据来源" value={source} disabled={sourceBusy} onChange={event => void selectSource(event.target.value as SourceChoice)}><option value="auto">自动选择</option><option value="exchanges">{visibleExchanges.length === EXCHANGES.length ? '五所官方接口' : '交易所官方接口'}</option><option value="coinglass">CoinGlass 官方 API</option></select></label><button className="btn" onClick={reload} disabled={loading} aria-label="刷新资金费率统计"><RefreshCw size={14} className={loading ? 'spin' : ''}/>{loading ? '更新中' : '刷新'}</button></div></div>
      <div className="funding-source-meta"><span><Radio size={12}/>{data ? data.status === 'ready' ? '数据已同步' : data.status === 'loading' ? '后台采集中' : data.status === 'stale' ? '缓存已过期' : data.status === 'not_configured' ? '来源未配置' : data.status === 'unsupported' ? '区间不支持' : '采集异常' : '等待接口响应'}</span><span><Clock3 size={12}/>最近收到：{data?.receivedAt ? <>{date(data.receivedAt)}（<AgeLabel timestamp={data.receivedAt}/>）</> : '—'}</span><span>{data?.source === 'coinglass' && !cumulative ? 'CoinGlass 当前费率约 20 秒更新' : cumulative ? '已发生费率累计，非当前费率外推' : '与套利机会使用同一统计来源'}</span>{data && <span>统计时效上限 {freshnessLimit(data.maxAgeMs)}</span>}{data?.sourceUrl && <a href={data.sourceUrl} target="_blank" rel="noreferrer">来源说明 <ExternalLink size={11}/></a>}</div>
      {data && !data.coinglassConfigured && <div className="coinglass-connection-note"><span className="status-dot"/><b>CoinGlass 未连接</b><span>在项目本地 <code>.env</code> 设置 <code>COINGLASS_API_KEY</code> 后重启服务。{data.source === 'exchanges' ? visibleExchanges.length === EXCHANGES.length ? '当前显示五所官方数据。' : '当前只显示已接入交易所数据。' : ''}</span><a href="https://docs.coinglass.com/reference/fr-exchange-list" target="_blank" rel="noreferrer">接入文档 <ExternalLink size={11}/></a></div>}
    </section>

    {(error || datasetWarning || data?.message) && <div className={`funding-message ${error || datasetWarning ? 'warning' : ''}`}><ShieldAlert size={16}/><div>{error && <p>{error}</p>}{data?.message && <p>{data.message}</p>}{datasetWarning && data.rows.length > 0 && <p>保留最后收到的数据供查阅；过期或不可用数据不参与最高、最低及费差排行。</p>}</div></div>}

    <section className="funding-view-controls">
      <div className="funding-range-tabs" role="group" aria-label="统计时间区间">{ranges.map(item => <button key={item.key} className={range === item.key ? 'active' : ''} disabled={item.key !== 'current' && !historicalAvailable} title={item.key !== 'current' && !historicalAvailable ? '真实累计费率需要已连接的 CoinGlass 来源；五所直连仅提供当前统计' : undefined} onClick={() => changeRange(item.key)}>{item.label}</button>)}</div>
      {!cumulative && <div className="funding-rate-toggles"><div className="funding-basis-toggle" role="group" aria-label="费率计算口径"><button className={basis === '8h' ? 'active' : ''} onClick={() => setBasis('8h')}>8h 归一</button><button className={basis === 'native' ? 'active' : ''} onClick={() => setBasis('native')}>原结算周期</button></div><label className="check-label"><input type="checkbox" checked={predicted} onChange={event => setPredicted(event.target.checked)}/>预测费率</label></div>}
    </section>

    <div className="metrics-grid funding-stats-cards">
      <div className="metric-card"><div className="metric-label">最高{cumulative ? '累计' : selectedPredicted ? '预测' : ''}费率 <ArrowUpRight size={17}/></div><div className={`metric-value ${signClass(result.high?.value ?? null)}`}>{formatRate(result.high?.value ?? null)}</div><div className="metric-caption">{result.high ? `${result.high.base} · ${names[result.high.exchange]}${!cumulative && basis === 'native' ? ` · ${result.high.cell.intervalHours ?? '未知'}h` : ''}` : '暂无新鲜可比数据'}</div></div>
      <div className="metric-card"><div className="metric-label">最低{cumulative ? '累计' : selectedPredicted ? '预测' : ''}费率 <ArrowDownRight size={17}/></div><div className={`metric-value ${signClass(result.low?.value ?? null)}`}>{formatRate(result.low?.value ?? null)}</div><div className="metric-caption">{result.low ? `${result.low.base} · ${names[result.low.exchange]}${!cumulative && basis === 'native' ? ` · ${result.low.cell.intervalHours ?? '未知'}h` : ''}` : '暂无新鲜可比数据'}</div></div>
      <div className="metric-card"><div className="metric-label">最大{cumulative ? '区间累计' : '8h'}费率差 <ArrowLeftRight size={17}/></div><div className="metric-value positive">{formatRate(result.largestGap?.summary.gap ?? null)}</div><div className="metric-caption">{result.largestGap ? `${result.largestGap.row.base} · ${names[result.largestGap.summary.low!]} → ${names[result.largestGap.summary.high!]}` : '至少需要两所新鲜、可比的费率'}</div></div>
      <div className="metric-card"><div className="metric-label">统计币种 <Database size={17}/></div><div className="metric-value">{data ? countFormat.format(data.rows.length) : '—'}<small>币种</small></div><div className="metric-caption">{result.freshCells} 个新鲜市场{result.staleCells ? ` · ${result.staleCells} 个过期或不可用` : ''}</div></div>
    </div>

    <section className="panel funding-matrix-panel">
      <div className="section-title"><div><h2>资金费率矩阵 <span className="badge">{viewLabel}</span></h2><p>{cumulative ? '每个单元格为所选区间已发生资金费率的累计值；不做年化外推。' : basis === '8h' ? '统一到 8 小时：原始费率 × 8 ÷ 原结算小时数。缺失周期的数据不参与归一。' : '保留各所实际结算周期；跨所费差与参考 APR 仍使用 8h 归一口径。'}</p></div><span className="funding-row-count">{result.rows.length} 个符合筛选</span></div>
      <div className="funding-matrix-filters"><label className="search"><Search size={15}/><input aria-label="搜索资金费率币种" placeholder="搜索币种，如 BTC、LINK" value={search} onChange={event => setSearch(event.target.value)}/>{search && <button className="icon-btn" aria-label="清空币种搜索" onClick={() => setSearch('')}><X size={12}/></button>}</label><select aria-label="资金费率过滤条件" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="all">全部币种</option><option value="comparable">至少两所可比较</option><option value="negative">含负费率的币种</option></select><span>点击列名排序 · 点击费率查看详情</span></div>
      <div className="table-scroll funding-matrix-scroll"><table className="funding-matrix"><thead><tr><th><button onClick={() => sortBy('base')}>币种 <SortIcon column="base"/></button></th>{visibleExchanges.map(exchange => <th key={exchange}><button onClick={() => sortBy(exchange)}><Venue exchange={exchange}/><SortIcon column={exchange}/></button></th>)}<th><button onClick={() => sortBy('gap')}>{cumulative ? '累计费率差' : '8h 费率差'} <SortIcon column="gap"/></button><span className="th-note">同币种最高 − 最低</span></th><th><button onClick={() => sortBy('apr')} disabled={cumulative}>参考 APR <SortIcon column="apr"/></button><span className="th-note">{cumulative ? '累计区间不外推' : '费前 · 当前费差外推'}</span></th></tr></thead><tbody>{shown.map(({ row, summary }) => <tr key={row.base}><td><b>{row.base}</b><span className="cell-caption">{summary.available} 所数据可用</span></td>{visibleExchanges.map(exchange => {
        const cell = row.cells[exchange];
        const value = cell ? comparableRate(cell, range, basis, selectedPredicted) : null;
        const fresh = !!cell && !!data && fundingCellIsFresh(cell, data, now);
        return <td key={exchange}>{cell ? <button className={`funding-cell ${fresh ? signClass(value) : 'stale'}`} onClick={() => setSelection({ base: row.base, exchange })} title={`${names[exchange]} · ${row.base}\n${cumulative ? '区间累计' : `原周期 ${cell.intervalHours ?? '未知'}h`}\n下次结算：${date(cell.nextFundingTime)}\n${cell.timestampKind === 'received' ? '接收时间' : '交易所时间'}：${date(cell.updatedAt)}\n${fresh ? '时效合格' : '已过期或不可用，不参与排行'}`}><b>{formatRate(value)}</b><span>{!fresh ? '过期 / 不可用' : selectedPredicted && cell.predictedRate === undefined ? '未提供预测值' : cumulative ? '已发生累计' : `${cell.intervalHours ?? '—'}h 周期`}</span></button> : <span className="funding-cell-missing">—</span>}</td>;
      })}<td><b className={summary.gap === null ? '' : 'positive'}>{formatRate(summary.gap)}</b><span className="cell-caption">{summary.low && summary.high && summary.gap !== null ? `${names[summary.low]} → ${names[summary.high]}` : '缺少可比数据'}</span></td><td>{summary.aprPct === null ? <span className="funding-cell-missing">—</span> : <span className="funding-apr">{aprFormat.format(summary.aprPct)}%</span>}</td></tr>)}</tbody></table></div>
      {!shown.length && <div className="empty"><span className="empty-icon">{loading || data?.status === 'loading' ? <LoaderCircle size={27} className="spin"/> : <Database size={27}/>}</span><strong>{emptyTitle}</strong><p>{!visibleExchanges.length ? '连接交易账户后，显示对应交易所的资金费率。' : data?.status === 'not_configured' ? '配置本地 CoinGlass API Key 后重新启动；也可选择交易所官方接口查看当前真实费率。' : data?.status === 'unsupported' ? '请选择当前费率，或连接 CoinGlass 后查看真实累计区间。' : selectedPredicted ? '仅展示来源明确提供的预测值；缺失值不会用当前费率代替。' : '统计独立于套利下单流程，接入数据后会自动更新。'}</p></div>}
      <div className="funding-pagination"><span>每页 {PAGE_SIZE} 行{result.rows.length ? ` · ${(visiblePage - 1) * PAGE_SIZE + 1}–${Math.min(visiblePage * PAGE_SIZE, result.rows.length)} / ${result.rows.length}` : ''}</span><div><button className="btn small-btn" disabled={visiblePage === 1} onClick={() => setPage(visiblePage - 1)} aria-label="上一页费率"><ChevronLeft size={13}/>上一页</button><span>{visiblePage} / {pageCount}</span><button className="btn small-btn" disabled={visiblePage >= pageCount} onClick={() => setPage(visiblePage + 1)} aria-label="下一页费率">下一页<ChevronRight size={13}/></button></div></div>
      <div className="data-footnote"><CircleHelp size={13}/>{cumulative ? '累计费率不等于实际到账收益；实际金额取决于每次结算时的仓位价值与持仓方向。' : '仅用于筛选；参考 APR 为费前费差外推。入场模型、整笔可成交价格和原始费率请在对应套利机会核对；已有持仓继续监测。预测缺失显示 —，过期值不参与排行。'}</div>
    </section>

    {selection && selectedCell && data && <div className="funding-detail-backdrop" onClick={() => setSelection(null)}><section className="panel funding-cell-detail" role="dialog" aria-modal="true" aria-label={`${selection.base} ${names[selection.exchange]} 费率详情`} onClick={event => event.stopPropagation()}><div className="section-title"><div><h2>{selection.base} · <Venue exchange={selection.exchange}/></h2><p>{sourceName(data.source, visibleExchanges.length)} · {viewLabel}</p></div><button className="icon-btn" onClick={() => setSelection(null)} aria-label="关闭费率详情"><X size={17}/></button></div><div className="funding-detail-grid"><dl><div><dt>{cumulative ? '区间累计费率' : '原周期当前费率'}</dt><dd>{formatRate(selectedCell.rate, 6)}</dd></div><div><dt>来源提供的预测费率</dt><dd>{cumulative ? '不适用于累计区间' : selectedCell.predictedRate === undefined ? '— 未提供' : formatRate(selectedCell.predictedRate, 6)}</dd></div><div><dt>原结算周期</dt><dd>{selectedCell.intervalHours === null ? '— 未提供' : `${selectedCell.intervalHours} 小时`}</dd></div><div><dt>下次结算</dt><dd>{cumulative ? '不适用于累计区间' : date(selectedCell.nextFundingTime)}</dd></div></dl><dl><div><dt>更新时间</dt><dd>{date(selectedCell.updatedAt)} · {<AgeLabel timestamp={selectedCell.updatedAt}/>}</dd></div><div><dt>时间依据</dt><dd>{selectedCell.timestampKind === 'exchange' ? '交易所时间' : '服务端收到数据的时间'}</dd></div><div><dt>时效状态</dt><dd>{fundingCellIsFresh(selectedCell, data, now) ? '时效合格' : '过期或不可用，已排除排行'}</dd></div><div><dt>未平仓量 / 24h 成交额</dt><dd>{dollar(selectedCell.openInterestUsd)} / {dollar(selectedCell.volume24hUsd)}</dd></div></dl>{selectedSummary && !cumulative && <div className="funding-weighted-note">同币种 8h 归一加权费率：OI 加权 {formatRate(selectedSummary.oiWeighted8h)}（{selectedWeightCoverage('openInterestUsd')} 所） · 成交额加权 {formatRate(selectedSummary.volumeWeighted8h)}（{selectedWeightCoverage('volume24hUsd')} 所）。仅使用当前来源提供权重且时效合格的市场；不是全市场加权结果。</div>}</div>{onViewOpportunities&&<div className="funding-detail-actions"><button className="btn primary" onClick={()=>{const base=selection.base;setSelection(null);onViewOpportunities(base);}}><ArrowLeftRight size={14}/>查看 {selection.base} 套利机会</button></div>}</section></div>}
  </div>;
}
