import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowDownLeft, ArrowDownRight, ArrowLeftRight, ArrowRight, ArrowUpRight, Bell, BookOpen, Check, ChevronDown, ChevronRight, CircleHelp, Clock3, Download, FlaskConical, Gauge, LayoutDashboard, LoaderCircle, Pause, Play, Radio, Search, Settings2, Shield, ShieldAlert, SlidersHorizontal, Square, Upload, Wallet, X } from 'lucide-react';
import FundingStatistics from './FundingStatistics';
import FundingOpportunities from './FundingOpportunities';
import FundingScheduleView from './FundingSchedule';
import './funding-schedule.css';
import LiveReadiness, { liveOrdersLocked, liveEntriesLocked } from './LiveReadiness';
import AccountSettings from './AccountSettings';
import LiveStartDialog from './LiveStartDialog';
import { DualAdvantage } from './DualAdvantage';
import BookCostBreakdown from './BookCostBreakdown';
import { bookCostScope, bookPrice, opportunityBookLoss } from './book-cost-presentation';
import './book-cost-breakdown.css';
import { entryPolicy, entryPolicyLabel, entryExecutionReady, type EntryPolicy } from './entry-policy';
import EntryExecutionSelector from './EntryExecutionSelector';
import ProfitExitExecutionSelector from './ProfitExitExecutionSelector';
import { acceptSettingsSave, changeSettingsField, changeSettingsSymbols, initialSettingsDraft, observeSettingsConfig, restoreSettingsDraft, settingsConfigKey, settingsDraftForSave } from './settings-draft';
import {AUTOMATIC_ENTRY_MODE,AUTOMATIC_ENTRY_RULE} from './automatic-entry-presentation';
import AutomaticFundingEntryStatus from './AutomaticFundingEntryStatus';
import {alignedAdaptiveHoldingRule} from './holding-policy-presentation';
import Positions from './PositionLedger';
import ManualEntryProgress from './ManualEntryProgress';
import { useManualEntries } from './useManualEntries';
import { manualEntryStage } from './manual-entry';
import { portfolioPositionSummary } from './position-observation';
import OverviewPerformance from './OverviewPerformance';
import FeeRebateControls from './FeeRebateControls';
import {feeRebatePct} from '../../src/shared/fee-rebates';
import ExecutionStatistics from './ExecutionStatistics';
import './execution-statistics.css';
import './overview-performance.css';
import { nextPortfolioTransition } from './portfolio-clock';
import { currentCloseOperationInFlight, currentCloseOrdersUnknown, finishedManualClose, positionCloseAction } from './position-close-action';
import { displayPollInterval, listenForForeground } from './display-polling';
import { isFeeOnly } from '../../src/shared/strategy-profile';
import { filterOpportunityPairs, opportunityExchangeScope } from '../../src/shared/opportunity-exchange-scope';
import {groupFundingLogs,type FundingLogGroup} from './funding-log-groups';
import {formatIocReceiptLogMessage} from '../../src/shared/ioc-log-quantity';
import './funding-log-groups.css';
import type { AppConfig, AppState, BacktestResult, EquityPoint, ExchangeHealth, ExchangeId, HistoricalRow, MarketSnapshot, Opportunity, Position } from '../../src/shared/types';

type Page = 'overview' | 'funding' | 'opportunities' | 'positions' | 'backtest' | 'settings' | 'logs' | 'execution';
const venues: Record<ExchangeId, string> = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX', gate: 'Gate', bitget: 'Bitget' };
const venueMarks: Record<ExchangeId, string> = { binance: 'B', bybit: 'By', okx: 'OK', gate: 'G', bitget: 'Bt' };
const nav = [{ id: 'overview', label: '总览', icon: LayoutDashboard }, { id: 'funding', label: '资金费率统计', icon: Gauge }, { id: 'opportunities', label: '套利机会', icon: ArrowLeftRight }, { id: 'positions', label: '持仓管理', icon: Wallet }, { id: 'backtest', label: '策略回测', icon: FlaskConical }, { id: 'execution', label: '执行统计', icon: Gauge }, { id: 'logs', label: '运行日志', icon: BookOpen }, { id: 'settings', label: '策略设置', icon: Settings2 }] as const;
const numberFormats = new Map<number, Intl.NumberFormat>();
const numberFormat = (digits: number) => {
  let formatter = numberFormats.get(digits);
  if (!formatter) { formatter = new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }); numberFormats.set(digits, formatter); }
  return formatter;
};
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false });
const money = (n: number, signed = false, digits = 2) => !Number.isFinite(n) ? '—' : `${signed && n > 0 ? '+' : n < 0 ? '−' : ''}$${numberFormat(digits).format(Math.abs(n))}`;
const num = (n: number, digits = 2) => numberFormat(digits).format(n);
const pct = (n: number) => `${n > 0 ? '+' : ''}${num(n, 4)}%`;
const compact = (n: number) => n >= 1e9 ? `$${num(n / 1e9, 2)}B` : n >= 1e6 ? `$${num(n / 1e6, 1)}M` : n >= 1e3 ? `$${num(n / 1e3, 1)}K` : money(n);
const date = (n: number) => n ? dateFormat.format(n) : '—';
const time = (n: number) => n ? timeFormat.format(n) : '—';
const countdown = (n: number, now: number) => { const sec = Math.max(0, Math.round((n - now) / 1000)); return `${Math.floor(sec / 3600).toString().padStart(2, '0')}:${Math.floor(sec / 60 % 60).toString().padStart(2, '0')}:${(sec % 60).toString().padStart(2, '0')}`; };
const pnlClass = (n: number) => n < 0 ? 'negative' : n > 0 ? 'positive' : '';
const elapsed = (timestamp: number, now = Date.now()) => {
  if (!timestamp) return '尚未成功';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
};
const cleanError = (error?: string) => error?.replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[已隐藏]@').replace(/Bearer\s+[A-Za-z0-9_.~+\/-]+/gi, 'Bearer [已隐藏]').replace(/((?:api[_-]?key|secret|signature|passphrase|token|authorization)["']?\s*[:=]\s*["']?)[^\s,"'&}]+/gi, '$1[已隐藏]').slice(0, 500);
function manualCloseFeedback(position:Position):{text:string;error:boolean} {
  const long=position.long.quantity,short=position.short.quantity;
  if(position.status==='closed'&&long===0&&short===0)return {text:`${position.base} 本次平仓已完成，双腿剩余数量均为 0`,error:false};
  const quantity=(value:number)=>Number.isFinite(value)&&value>=0?String(value):'待核对';
  const reason=cleanError(position.riskReasons?.join('；')||position.closeReason)||'请等待账户更新后，按剩余数量重新确认；不会自动重试';
  return {text:`${position.base} 本次未完全平仓；剩余多腿 ${quantity(long)}、空腿 ${quantity(short)} ${position.base}。${reason}`,error:true};
}
const healthLabels: Record<ExchangeHealth['status'], string> = { online: '已连接', degraded: '部分异常', offline: '请求失败', connecting: '连接中' };
const networkLabels: Record<string, string> = { REGION_BLOCKED: '地区限制', ACCESS_DENIED: '访问被拒', PROXY_UNAVAILABLE: '代理不可用', RATE_LIMITED: '接口限流', TIMEOUT: '请求超时', DNS_ERROR: '域名解析失败', TLS_ERROR: '安全连接失败', NETWORK_ERROR: '网络中断', API_ERROR: '接口异常' };
const networkLabel = (exchange: ExchangeHealth) => exchange.status !== 'online' && exchange.errorCode ? networkLabels[exchange.errorCode] : undefined;
const endpointHost = (endpoint?: string) => {
  if (!endpoint) return '尚未报告';
  try { return new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`).hostname; } catch { return '地址未识别'; }
};
function marketHealth(exchange: ExchangeHealth, state: AppState, now = Date.now()) {
  const snapshots = state.snapshots.filter(s => s.exchange === exchange.exchange && s.source === state.config.dataSource);
  const latest = Math.max(0, ...snapshots.map(s => s.timestamp));
  const fresh = snapshots.filter(s => now - s.timestamp <= state.config.maxSnapshotAgeMs).length;
  const stale = latest > 0 && fresh === 0;
  return { latest, fresh, total: snapshots.length, stale, available: fresh > 0 && (exchange.status === 'online' || exchange.status === 'degraded') };
}

class ApiResponseError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
interface PendingOperation {
  key: string; label: string; financial: boolean; phase: 'pending' | 'accepted' | 'uncertain';
  startedAt: number; base?: string; positionId?: string;
}
const pendingStorageKey = 'funding-arb-unconfirmed-actions';
function restorePendingOperations(): PendingOperation[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(pendingStorageKey) || '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter((item): item is PendingOperation => item && typeof item.key === 'string' &&
      /^(entry:[A-Z0-9]{2,30}|close:[a-zA-Z0-9-]+|control:kill)$/.test(item.key) &&
      typeof item.label === 'string' && item.label.length < 100 && item.financial === true &&
      Number.isFinite(item.startedAt) && item.startedAt > 0 &&
      (item.base === undefined || typeof item.base === 'string' && /^[A-Z0-9]{2,30}$/.test(item.base)) &&
      (item.positionId === undefined || typeof item.positionId === 'string' && /^[a-zA-Z0-9-]+$/.test(item.positionId)))
      .map(item => ({ ...item, phase: 'uncertain' }));
  } catch { return []; }
}
async function api<T>(path: string, method = 'GET', body?: unknown, signal?:AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { signal, cache: method==='GET'?'no-store':undefined, method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'funding-arb' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new ApiResponseError(result.error || '请求未完成，请检查运行日志', response.status);
  return result as T;
}
function Venue({ id, small = false }: { id: ExchangeId; small?: boolean }) { return <span className={`venue ${small ? 'small' : ''}`}><span className={`venue-mark ${id}`}>{venueMarks[id]}</span>{venues[id]}</span>; }
function Empty({ title, text, icon = <Activity size={28} /> }: { title: string; text: string; icon?: ReactNode }) { return <div className="empty"><span className="empty-icon">{icon}</span><strong>{title}</strong><p>{text}</p></div>; }
function Badge({ children, kind = 'neutral' }: { children: ReactNode; kind?: 'neutral' | 'green' | 'orange' | 'red' }) { return <span className={`badge ${kind}`}>{children}</span>; }
function SectionTitle({ title, caption, action }: { title: string; caption?: string; action?: ReactNode }) { return <div className="section-title"><div><h2>{title}</h2>{caption && <p>{caption}</p>}</div>{action}</div>; }
function MiniStat({ label, value, caption, icon, tone }: { label: string; value: string; caption: string; icon: ReactNode; tone?: string }) { return <div className="metric-card"><div className="metric-label">{label}<span>{icon}</span></div><div className={`metric-value ${tone || ''}`}>{value}<small>USD</small></div><div className="metric-caption">{caption}</div></div>; }

// Display clocks belong to the parts that show age/countdowns. A clock tick must
// not rebuild every opportunity, chart, configuration form and log on the page.
function useDisplayClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return now;
}

function MarketConnectionPill({ state, connectionError }: { state: AppState | null; connectionError: string }) {
  const now = useDisplayClock();
  const observations = state?.exchanges.map(exchange => ({ exchange, health: marketHealth(exchange, state, now) })) ?? [];
  const available = observations.filter(item => item.health.available).length;
  const healthy = observations.length > 0 && observations.every(item => item.exchange.status === 'online' && item.health.fresh > 0 && !item.exchange.error);
  return <span className="connection-pill"><i className={connectionError ? 'offline' : healthy ? '' : 'degraded'}/>{connectionError ? '本地服务断连' : state ? `交易行情 ${available}/${state.exchanges.length} 所可用${healthy ? '' : ' · 需关注'}` : '正在连接'}</span>;
}

function ExchangeConnection({ exchange, state }: { exchange: ExchangeHealth; state: AppState }) {
  const now = useDisplayClock();
  const info = marketHealth(exchange, state, now);
  const status = exchange.status === 'offline' ? 'offline' : info.stale ? 'degraded' : exchange.status;
  const label = networkLabel(exchange) || (exchange.status === 'offline' ? healthLabels.offline : info.stale ? '行情过期' : healthLabels[exchange.status]);
  return <div className="exchange-connection" title={cleanError(exchange.error) || `最近成功：${date(exchange.lastSuccess)}；最新行情：${date(info.latest)}`}>
    <div className="connection-row"><Venue id={exchange.exchange} small/><span className={`connection-status ${status}`}>{label}<i/></span></div>
    <div className="connection-age"><span>{info.latest ? `行情 ${elapsed(info.latest)}` : '等待首份行情'}</span><span>{exchange.latencyMs > 0 ? `${Math.round(exchange.latencyMs)} ms` : '—'}</span></div>
  </div>;
}

function MarketDiagnostics({ state }: { state: AppState }) {
  useDisplayClock();
  const available = state.exchanges.filter(ex => marketHealth(ex, state).available).length;
  const allHealthy = state.exchanges.length > 0 && state.exchanges.every(ex => ex.status === 'online' && marketHealth(ex, state).fresh > 0 && !ex.error);
  return <details className={`market-diagnostics panel ${allHealthy ? '' : 'has-issues'}`}>
    <summary><div><Radio size={15}/><b>{state.config.dataSource === 'public' ? '实时行情连接' : '演示行情连接'}</b><span>{available} / {state.exchanges.length} 所行情可用</span></div><span>连接诊断 <ChevronDown size={13}/></span></summary>
    <div className="diagnostics-intro">{state.config.dataSource === 'public' ? '直接读取交易所公开接口。连接失败、部分失败与过期快照会如实展示；没有实时数据时，不会用演示数据替代。' : '当前为合成演示行情，不代表任何交易所实时市场；请在设置中切换公开实时行情。'}</div>
    <div className="diagnostics-grid">{state.exchanges.map(ex => {
      const info = marketHealth(ex, state);
      const status = networkLabel(ex) || (ex.status === 'offline' ? healthLabels.offline : info.stale ? '行情过期' : healthLabels[ex.status]);
      const error = cleanError(ex.error);
      const retryIn = ex.retryAt ? Math.max(0, Math.ceil((ex.retryAt - Date.now()) / 1000)) : 0;
      return <article className="diagnostic-card" key={ex.exchange}>
        <div className="diagnostic-title"><Venue id={ex.exchange}/><Badge kind={ex.status === 'offline' ? 'red' : ex.status === 'online' && !info.stale ? 'green' : 'orange'}>{status}</Badge></div>
        <dl><div><dt>有效 / 已缓存详细行情</dt><dd>{info.fresh} / {info.total}</dd></div><div><dt>最新行情</dt><dd>{info.latest ? elapsed(info.latest) : '尚未收到'}</dd></div><div><dt>最近采集成功</dt><dd>{elapsed(ex.lastSuccess)}</dd></div><div><dt>最近请求耗时</dt><dd>{ex.latencyMs > 0 ? `${num(ex.latencyMs, 0)} ms` : '尚未记录'}</dd></div></dl>
        <dl className="diagnostic-network"><div><dt>连接方式</dt><dd>{state.config.dataSource === 'demo' ? '本地合成' : ex.route === 'proxy' ? '代理连接' : ex.route === 'direct' ? '直接连接' : '尚未报告'}</dd></div>{state.config.dataSource === 'public' && <div className="diagnostic-endpoint"><dt>官方接口域名</dt><dd>{endpointHost(ex.endpoint)}</dd></div>}{ex.errorCode && <div><dt>异常分类</dt><dd title={ex.errorCode}>{networkLabels[ex.errorCode] || ex.errorCode}</dd></div>}{ex.retryAt && ex.errorCode ? <div><dt>自动重试</dt><dd title={`冷却结束：${date(ex.retryAt)}`}>{retryIn > 0 ? `${retryIn} 秒后` : '等待下轮采集'}</dd></div> : null}</dl>
        {error ? <p className="diagnostic-error"><ShieldAlert size={13}/><span>{error}</span></p> : <p className="diagnostic-info">{ex.status === 'connecting' ? '首轮采集进行中；尚无成功记录。' : info.stale ? '快照超过允许延迟，相关机会不可执行。' : info.fresh ? '仅时效合格的快照参与机会计算。' : '尚无可用于套利计算的市场快照。'}</p>}
      </article>;
    })}</div>
  </details>;
}

function EquityChart({ points, height = 205 }: { points: EquityPoint[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!points.length) return <Empty title="等待第一笔记录" text="运行后将记录账户净收益曲线。" />;
  const samples = points.length > 240 ? points.filter((_, i) => i % Math.ceil(points.length / 239) === 0 || i === points.length - 1) : points;
  const values = samples.map(p => p.netPnlUsd);
  const low = Math.min(0, ...values), high = Math.max(0, ...values), span = Math.max(1, high - low);
  const min = low - span * .17, max = high + span * .2;
  const width = 900, plotHeight = height - 32, x = (i: number) => 4 + i / Math.max(1, samples.length - 1) * 810, y = (v: number) => 10 + (max - v) / (max - min) * (plotHeight - 18);
  const line = samples.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.netPnlUsd)}`).join(' ');
  const selected = hover === null ? null : samples[hover];
  return <div className="equity-chart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="累计净收益曲线，单位美元" onMouseLeave={() => setHover(null)}><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#24a87c" stopOpacity=".16"/><stop offset="100%" stopColor="#24a87c" stopOpacity="0"/></linearGradient></defs>{Array.from({ length: 4 }, (_, i) => { const value = max - (max - min) * i / 3; return <g key={i}><line x1="4" x2="815" y1={y(value)} y2={y(value)} stroke="#e8ece8" strokeDasharray="3 5"/><text x="835" y={y(value) + 4} fontSize="11" fill="#929b95">{money(value)}</text></g>; })}<path d={`${line} L${x(samples.length - 1)},${plotHeight} L4,${plotHeight} Z`} fill="url(#chart-fill)"/><path d={line} fill="none" stroke="#1d9673" strokeWidth="2.7" strokeLinejoin="round"/><circle cx={x(samples.length - 1)} cy={y(values[values.length - 1])} r="4" fill="#1d9673"/>{[0, .25, .5, .75, 1].map((v, i) => <text key={i} x={4 + 810 * v} y={height - 2} fill="#919991" fontSize="11" textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}>{time(samples[Math.round((samples.length - 1) * v)].timestamp)}</text>)}{samples.map((p, i) => <rect key={`${p.timestamp}-${i}`} x={x(i) - 405 / Math.max(1, samples.length - 1)} y="0" width={Math.max(3, 810 / Math.max(1, samples.length - 1))} height={plotHeight} fill="transparent" onMouseMove={() => setHover(i)} />)}{selected && hover !== null && <g pointerEvents="none"><line x1={x(hover)} x2={x(hover)} y1="0" y2={plotHeight} stroke="#718077" strokeDasharray="4 4"/><circle cx={x(hover)} cy={y(selected.netPnlUsd)} r="5" fill="#17795c" stroke="white" strokeWidth="2"/></g>}</svg>{selected && <div className="chart-tooltip">{time(selected.timestamp)} · <b>{money(selected.netPnlUsd, true)}</b></div>}</div>;
}

function Opportunities({ state, preview = false, onOpen, onMore, busy, pendingBases }: { state: AppState; preview?: boolean; onOpen: (o: Opportunity) => void; onMore: () => void; busy: boolean; pendingBases?: ReadonlySet<string> }) {

  const [search, setSearch] = useState(''), [onlyEligible, setOnlyEligible] = useState(false), [selected, setSelected] = useState<string | null>(null);
  const dual = entryPolicy(state.config) === 'dual';
  const opportunityNet = (o:Opportunity) => o.combinedExpectedNetUsd ?? NaN;
  const expectedLabel = entryPolicy(state.config)==='aligned'?'单轮预计净收益（参考）':'合计预计净收益';
  const score = (o:Opportunity) => Number.isFinite(opportunityNet(o)) ? opportunityNet(o) : -Number.MAX_VALUE;
  const connectedOpportunities = filterOpportunityPairs(state.opportunities, opportunityExchangeScope(state));
  const list = connectedOpportunities.filter(o => (!onlyEligible || o.eligible) && `${o.base} ${o.longExchange} ${o.shortExchange}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
  const shown = preview ? list.slice(0, 5) : list;
  const detail = connectedOpportunities.find(o => o.id === selected);
  const eligible = connectedOpportunities.filter(o => o.eligible).length;
  return <section className="panel opportunities"><SectionTitle title="套利机会" caption={entryPolicy(state.config)==='aligned'?'资金费与全量开仓价格同向即可入场 · 可持有多轮':dual ? '按合计预计净收益排序 · 资金费与价差同时有利才入场' : '资金费覆盖单轮成本 · 不等待历史样本'} action={preview ? <button className="text-btn" onClick={onMore}>查看全部 <ArrowUpRight size={15}/></button> : <Badge kind="green">{eligible} 个满足条件</Badge>} />
    <div className="table-tools"><div className="table-filter"><button className={!onlyEligible ? 'selected' : ''} onClick={() => setOnlyEligible(false)}>全部机会 <span>{connectedOpportunities.length}</span></button><button className={onlyEligible ? 'selected' : ''} onClick={() => setOnlyEligible(true)}>可交易 <span>{eligible}</span></button></div><label className="search"><Search size={15}/><input placeholder="搜索币种或交易所" aria-label="搜索币种或交易所" value={search} onChange={e => setSearch(e.target.value)}/></label></div>
    <div className="table-scroll"><table><thead><tr><th>币种 / 对冲路径</th><th>净资金费率差 <span className="th-note">本轮</span></th><th>参考 APR <span className="th-note">费前</span></th><th>{expectedLabel} <span className="th-note">{entryPolicy(state.config)==='aligned'?'资金费 − 四笔手续费':dual ? '包含预计价差损益' : '含盘口开平损耗'}</span></th><th>结算倒计时</th><th>执行状态</th><th></th></tr></thead><tbody>{shown.map((o, i) => <tr key={o.id} className={selected === o.id ? 'row-selected' : ''} onClick={() => setSelected(selected === o.id ? null : o.id)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setSelected(selected === o.id ? null : o.id); }} aria-label={`查看 ${o.base} ${venues[o.longExchange]} 至 ${venues[o.shortExchange]} 的套利详情`}><td><div className="pair-name"><span className={`coin-mark coin-${o.base.toLowerCase()}`}>{o.base.slice(0, 1)}</span><div><b>{o.base}<small> / USDT</small></b><span className="pair-route"><span className="positive">多</span> {venues[o.longExchange]}<ArrowRight size={11}/><span className="negative">空</span> {venues[o.shortExchange]}</span></div>{i === 0 && o.eligible && <span className="rank-tag">TOP</span>}</div></td><td><b className={pnlClass(o.netRateBps)}>{o.netRateBps > 0 ? '+' : ''}{num(o.netRateBps / 100, 4)}%</b><span className="cell-caption">{o.longIntervalHours}h / {o.shortIntervalHours}h 周期</span></td><td><span className={pnlClass(o.aprPct)}>{num(o.aprPct)}%</span><span className="cell-caption">非保证收益</span></td><td><b className={pnlClass(opportunityNet(o))}>{money(opportunityNet(o), true)}</b><span className="cell-caption">每腿 {money(o.notionalUsd, false, 0)}</span></td><td className="tabular">{countdown(o.nextFundingTime, state.timestamp)}<span className="cell-caption">时间差 {o.settlementSkewSec}s</span></td><td><Badge kind={o.eligible ? 'green' : 'orange'}>{o.eligible ? '条件通过' : o.checks?.some(check => check.pass === null) ? '等待数据' : '条件不满足'}</Badge><AutomaticFundingEntryStatus opportunity={o}/></td><td><button className="icon-btn" title="展开详情" aria-label={`展开 ${o.base} 详情`} onClick={e => { e.stopPropagation(); setSelected(selected === o.id ? null : o.id); }}><ChevronRight className={selected === o.id ? 'rotated' : ''} size={16}/></button></td></tr>)}</tbody></table></div>
    {!shown.length && <Empty title={search ? '没有匹配的机会' : onlyEligible ? '暂无满足条件的机会' : '正在等待市场快照'} text={onlyEligible ? '可在全部机会中查看被过滤的原因，或在策略设置中调整阈值。' : '数据同步后将自动按币种配对交易所。'}/>}
    {detail && <OpportunityDetail busy={busy || !!pendingBases?.has(detail.base)} o={detail} state={state} onClose={() => setSelected(null)} onOpen={() => onOpen(detail)} />}
    {preview && list.length > 5 && <button className="table-footer" onClick={onMore}>查看其余 {list.length - 5} 个机会 <ArrowRight size={14}/></button>}
    <div className="data-footnote"><CircleHelp size={13}/> 净资金费率差按各腿本轮结算现金流计算；APR 为当前费率外推，未扣成本。</div>
  </section>;
}

function SnapshotDetails({ snap, label }: { snap?: MarketSnapshot; label: string }) {
  return <div className="snapshot-detail"><div className="snapshot-heading"><span>{label}</span>{snap && <Venue id={snap.exchange} small/>}</div>{snap ? <dl><div><dt>资金费率 / 周期</dt><dd>{pct(snap.fundingRate * 100)} / {snap.intervalHours}h</dd></div><div><dt>标记 / 指数价格</dt><dd>{bookPrice(snap.markPrice)} / {bookPrice(snap.indexPrice)}</dd></div><div><dt>买一 / 卖一</dt><dd>{snap.bids[0] ? bookPrice(snap.bids[0].price) : '—'} / {snap.asks[0] ? bookPrice(snap.asks[0].price) : '—'}</dd></div><div><dt>未平仓量 OI</dt><dd>{compact(snap.openInterestUsd)}</dd></div><div><dt>24h 成交额</dt><dd>{compact(snap.volume24hUsd)}</dd></div><div><dt>下次结算</dt><dd>{date(snap.nextFundingTime)}</dd></div><div><dt>更新于</dt><dd>{time(snap.timestamp)}</dd></div></dl> : <p>快照暂不可用</p>}</div>;
}
function OpportunityDetail({ o, state, onClose, onOpen, busy }: { o: Opportunity; state: AppState; onClose: () => void; onOpen: () => void; busy: boolean }) {

  const long = state.snapshots.find(s => s.base === o.base && s.exchange === o.longExchange), short = state.snapshots.find(s => s.base === o.base && s.exchange === o.shortExchange);
  const dual=entryPolicy(state.config,o)==='dual',aligned=entryPolicy(state.config,o)==='aligned',net=o.combinedExpectedNetUsd ?? NaN;
  const showRebates=feeRebatePct(o.longExchange,state.config)>0||feeRebatePct(o.shortExchange,state.config)>0;
  const bookLoss=opportunityBookLoss(o);
  return <div className="opportunity-detail"><div className="detail-top"><h3>{o.base} · 收益与执行详情</h3><button className="icon-btn" onClick={onClose} aria-label="关闭详情"><X size={17}/></button></div><div className="detail-columns"><div className="cost-breakdown"><AutomaticFundingEntryStatus opportunity={o} details/><DualAdvantage opportunity={o} config={state.config}/><FundingScheduleView schedule={o.fundingSchedule} forEntry/><div className="breakdown-total"><span>{aligned?'单轮资金费扣手续费（参考）':'合计预计净收益'}</span><strong className={pnlClass(net)}>{money(net, true)}</strong><small>{entryPolicy(state.config,o)==='aligned'?AUTOMATIC_ENTRY_RULE:dual?'合计为预测值；手续费只扣一次，历史不足时等待双腿盘口观察':'按基差不变估计；手续费只扣一次，不等待历史样本'}</small></div><dl><div><dt>预期资金费收入</dt><dd className={pnlClass(o.expectedFundingUsd)}>{money(o.expectedFundingUsd, true)}</dd></div><div><dt>{showRebates?'双边开平净手续费（返佣后估算）':'双边开仓 + 平仓手续费'}</dt><dd>−{money(o.feesUsd)}</dd></div>{!aligned&&<div><dt>{dual?'预计价差收益':`盘口开平损耗 · ${bookCostScope(o)}`}</dt><dd className={dual?pnlClass(o.spreadAdvantage?.expectedSpreadPnlUsd ?? NaN):bookLoss!==null&&bookLoss>0?'negative':''}>{dual?money(o.spreadAdvantage?.expectedSpreadPnlUsd ?? NaN, true):money(bookLoss ?? NaN)}</dd></div>}</dl>{!dual&&!aligned&&<BookCostBreakdown opportunity={o}/>}{showRebates&&<p>费用与净收益计入配置返佣：Gate {feeRebatePct('gate',state.config)}% / Bitget {feeRebatePct('bitget',state.config)}%。返佣仅估算，未核对到账；原账户费率核验保留。</p>}<div className="detail-inline"><span>基差 <b>{num(o.basisBps)} bps</b></span><span>Delta <b>{money(o.deltaUsd)}</b></span></div><div className="detail-inline"><span>做多数量 <b>{num(o.longQuantity, 6)}</b></span><span>做空数量 <b>{num(o.shortQuantity, 6)}</b></span></div><div className="detail-inline"><span>资金占用 APR <b>{num(o.capitalAprPct)}%</b></span><span>8h 归一费差 <b>{num(o.normalized8hBps)} bps</b></span></div><button className="btn primary full" onClick={onOpen} disabled={liveOrdersLocked(state) || !o.eligible || !entryExecutionReady(state.config,o) || state.killSwitch || busy || state.positions.some(p => p.base === o.base && p.status !== 'closed'&&!p.accountClosure)}>{liveOrdersLocked(state) ? '新开仓锁定' : state.config.mode === 'paper' ? '创建纸面对冲仓位' : '创建实盘对冲仓位'} <ArrowUpRight size={15}/></button></div><div className="snapshot-columns"><SnapshotDetails snap={long} label="做多 · 低费率"/><SnapshotDetails snap={short} label="做空 · 高费率"/><div className={`detail-risk ${o.eligible ? 'pass' : ''}`}><Shield size={17}/><div><b>{o.eligible ? '当前机会满足入场条件' : '当前执行条件未满足'}</b><p>{o.reasons.length ? o.reasons.join(' · ') : '下单前将重新核对收益、盘口、余额与数量精度。'}</p></div></div></div></div></div>;
}


function RepeatedFundingLog({group}:{group:FundingLogGroup}){
  const [expanded,setExpanded]=useState(false);
  return <details className="log-repeat" onToggle={event=>setExpanded(event.currentTarget.open)}>
    <summary><span className="log-repeat-count">重复 {group.entries.length} 次</span> · 展开原记录</summary>
    {expanded&&<ul>{group.entries.map(entry=><li key={entry.id} data-log-id={entry.id}><time>{date(entry.timestamp)}</time><span>{formatIocReceiptLogMessage(entry.message)}</span>{entry.context&&<pre>{entry.context}</pre>}</li>)}</ul>}
  </details>;
}
function Logs({ state, preview = false, onMore }: { state: AppState; preview?: boolean; onMore: () => void }) {
  const [level, setLevel] = useState('all');
  const logs=groupFundingLogs(state.logs).filter(group=>level==='all'||group.latest.level===level);
  return <section className="panel logs-panel"><SectionTitle title="运行日志" caption={preview ? undefined : '最新事件在前 · 相同资金费警告合并，可展开原记录'} action={preview ? <button className="text-btn" onClick={onMore}>全部 <ArrowUpRight size={14}/></button> : <select aria-label="日志级别" value={level} onChange={e => setLevel(e.target.value)}><option value="all">全部级别</option><option value="info">信息</option><option value="warn">警告</option><option value="error">错误</option></select>}/><div className="logs-list">{(preview ? logs.slice(0, 5) : logs).map(group=>{const l=group.latest;return <div className={`log-entry ${l.level}`} key={group.key} data-log-count={group.entries.length}><span className="log-dot"/><div><p>{formatIocReceiptLogMessage(l.message)}</p>{l.context && !preview && <pre>{l.context}</pre>}<time>{group.entries.length>1?`最近 ${date(l.timestamp)} · 首次 ${date(group.entries.at(-1)!.timestamp)}`:date(l.timestamp)}</time>{group.entries.length>1&&(!preview?<RepeatedFundingLog group={group}/>:<span className="log-repeat-count"> · 重复 {group.entries.length} 次</span>)}</div>{!preview && <Badge kind={l.level === 'error' ? 'red' : l.level === 'warn' ? 'orange' : 'neutral'}>{l.level.toUpperCase()}</Badge>}</div>;})}</div>{!logs.length && <Empty title="暂无运行日志" text="系统事件会自动记录在这里。"/>}</section>;
}

interface FieldSpec { key: keyof AppConfig; label: string; unit: string; hint: string; min?: number; max?: number; step?: number; }
const configGroups: { title: string; text: string; fields: FieldSpec[] }[] = [
  { title: '入场规则', text: '资金费优先模式按当前盘口估计开平损耗；双优势模式增加历史价差优势要求。', fields: [
    { key: 'minCombinedNetUsd', label: '最低合计净收益', unit: 'U', hint: '资金费 + 预计价差收益 − 四笔手续费，须高于此值', min: 0, max: 10000, step: .01 },
    { key: 'spreadLookbackMinutes', label: '价差历史回看区间', unit: '分钟', hint: '双优势模式：用这段时间内的退出盘口价差中位数作参考', min: 5, max: 1440 },
    { key: 'spreadMinSamples', label: '最少价差样本', unit: '个', hint: '双优势模式：攒够样本才能判断价差优势', min: 3, max: 240, step: 1 },
    { key: 'spreadMinSpanSec', label: '最短价差观察时长', unit: '秒', hint: '双优势模式：样本覆盖时长须小于回看区间', min: 30, max: 86400 },
    { key: 'spreadSampleIntervalSec', label: '价差采样间隔', unit: '秒', hint: '两次历史参考有效采样的最小间隔', min: 1, max: 300 }
  ]},
  { title: '开仓成交与分批', text: '两腿保持相同币数量；按盘口可成交数量分批完成单次开仓的完整目标。', fields: [
    { key: 'minEntryIocEdgeBps', label: '最低 IOC 开仓价格优势', unit: 'bps', hint: '普通可开仓默认 0 bps，价格优势须为正；IOC > 20 bps 另有独立筛选分区', min: 0, max: 10000, step: 1 },
    { key: 'entryIocBufferBps', label: 'IOC 成交缓冲上限', unit: 'bps', hint: '默认每腿最多 8 bps，只使用可见盘口；至少保留一半超出最低优势的余量，不扩大首档批量。空腿实际成交后补多仍最多 8 bps；设为 0 恢复精确对手价1', min: 0, max: 50, step: 1 },
    { key: 'maxEntryBatches', label: '对手价分批上限', unit: '批', hint: '按买一／卖一共同可成交数量分批完成原目标，限价可使用有限成交缓冲；每批重核价格与资金费优势，默认 8 批', min: 1, max: 32, step: 1 }
  ]},
  { title: '行情', text: '价差来自两个交易所的盘口，须足够新且采集时间接近。', fields: [
    { key: 'maxSnapshotAgeMs', label: '快照最大延迟', unit: '毫秒', hint: '超过此延迟视为过期', min: 1000 },
    { key: 'maxQuoteSkewMs', label: '两腿行情最大采集时间差', unit: '毫秒', hint: '两腿盘口须在此时间内取得；超出则不入场、也不计入价差历史', min: 200, max: 60000, step: 100 },
    { key: 'pollIntervalMs', label: '行情刷新间隔', unit: '毫秒', hint: '服务器公开行情轮询间隔', min: 1000 }
  ]},
  { title: '持仓与成交', text: '持仓按所选模式退出；资金费＋价格同向的自主判断模式在扣费净收益达标时优先分批获利退出，持续资金费劣势时另可受控亏损退出。', fields: [
    { key: 'maxHoldHours', label: '收益预测时长', unit: '小时', hint: '持续模式计算预计资金费的时间范围；不是强制平仓期限', min: .01, max: 168 },
    { key: 'adaptiveConfirmations', label: '连续新报价确认次数', unit: '次', hint: '历史持仓自主判断：两腿报价都更新才计一次，避免同一快照重复确认。资金费＋价格同向的获利退出不等待此确认，资金费劣势退出使用独立费率持续确认', min: 1, max: 20, step: 1 },
    { key: 'exitWeakFundingBps', label: '资金费劣势缓冲', unit: 'bps', hint: '可平净收益未达门槛时，正资金费续持；负资金费的绝对值未超过此缓冲时继续观察，超过后还须持续确认。获利达标优先退出；按两腿平均名义价值计算，默认 2 bps', min: 0, max: 10000, step: .1 },
    { key: 'minExitProfitBps', label: '盈利退出最低净收益率', unit: 'bps', hint: '按原开仓单腿名义本金固定计算，默认 10 bps：100U 对应净赚超过 0.10U。双腿对手价1计入预计返佣、扣全部开平手续费与成本后达标，再按所选方式分批平仓；分批后本金基数不降低，真实成交差量优先补齐', min: 0, max: 10000, step: 1 },
    { key: 'exitDelaySec', label: '结算后退出延迟', unit: '秒', hint: '单次模式结算后的等待时间', min: 0 },
    { key: 'maxOrderRetries', label: '补单重试上限', unit: '次', hint: '部分成交后补足缺口的最大重试次数', min: 0, max: 3, step: 1 }
  ]},
  { title: '纸面模拟', text: '模拟资金基数仅用于纸面交易；修改会影响余额口径，已有损益账本继续保留。', fields: [
    { key: 'initialBalanceUsd', label: '每所模拟资金基数', unit: 'USD', hint: '每所模拟资金基数；更改会影响余额口径', min: 1 }
  ]}
];
const entryPolicyDescription=(policy:EntryPolicy)=>policy==='aligned'?'资金费＋价格同向：预计资金费为正，IOC 最坏允许成交价格优势为正，可持有多轮。普通可开仓展示所有符合规则的机会，另有 IOC > 20 bps 分区。费用仅展示，不要求一轮净收益为正，不等待历史样本。':policy==='funding'?'资金费覆盖单轮成本：预计资金费为正，扣四笔手续费和盘口开平损耗后净收益达标；不等待历史样本。按基差不变估计，实际基差变化仍计入损益。':'历史价差双优势：预计资金费为正、开仓价差优于近期退出价差，两者合计扣一次四笔手续费后净收益达标。';
function EntryPolicySelector({config,onChange}:{config:AppConfig;onChange:(value:EntryPolicy)=>void}){
  return <label className="config-field"><span>入场模式</span><select aria-label="入场模式" value={entryPolicy(config)} onChange={e=>onChange(e.target.value as EntryPolicy)}><option value="aligned">{entryPolicyLabel('aligned')}</option><option value="funding">{entryPolicyLabel('funding')}</option><option value="dual">{entryPolicyLabel('dual')}</option></select><small>{entryPolicyDescription(entryPolicy(config))}</small></label>;
}
function AsyncFundingTimingSelector({config,onChange}:{config:AppConfig;onChange:(value:NonNullable<AppConfig['asyncFundingEntryTiming']>)=>void}){
  if(entryPolicy(config)!=='aligned')return null;
  return <label className="config-field"><span>异步资金费入场时点</span><select value={config.asyncFundingEntryTiming??'last-payment'} onChange={event=>onChange(event.target.value as NonNullable<AppConfig['asyncFundingEntryTiming']>)}><option value="last-payment">按小周期收付择时 · 收首轮／避末轮付款</option><option value="anytime">任意时点 · 按整轮合计判断</option></select><small>仅用于新建仓。两所结算周期和时钟能对齐时：小周期净收款，在共同结算后的首个小周期结算前开仓；小周期净付款，在共同结算前的最后一个小周期内开仓。窗口起点至少等待结算后 10 秒、截止比结算提前 10 秒，并重新检查资金费与 IOC 优势；错过首轮就等待下一共同周期。已有持仓保留续持与退出判断。</small></label>;
}
function OpeningTradingControls({ config, baselineLeverage, legacyMarginMode, onChange }: {
  config: AppConfig; baselineLeverage: number; legacyMarginMode: boolean;
  onChange: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => void;
}) {
  // Preserve a saved fractional leverage until the user changes that setting.
  const leverageStep = config.leverage === baselineLeverage && !Number.isInteger(baselineLeverage) ? 'any' : 1;
  return <section className="panel config-section" aria-labelledby="opening-trading-controls-title">
    <h3 id="opening-trading-controls-title">开仓金额与杠杆</h3>
    <p>单次开仓价值按每腿目标名义价值计算；双腿合计约为该金额的两倍，保证金另按杠杆计算。分批成交共同完成这一目标。</p>
    <div className="config-grid">
      <label className="config-field"><span>单次开仓价值（每腿）</span><div className="input-unit">
        <input aria-label="单次开仓价值（每腿）" name="orderNotionalUsd" type="number" required min={.01} max={1000000} step={.01} value={config.orderNotionalUsd} onChange={event => onChange('orderNotionalUsd', Number(event.target.value))}/><span>U</span>
      </div><small>例如填 100 U，每个交易所单腿目标约 100 U，双腿合计约 200 U；实际金额随价格及数量精度略有变化。</small></label>
      <label className="config-field"><span>交易所杠杆</span><div className="input-unit">
        <input aria-label="交易所杠杆" name="leverage" type="number" required min={1} max={20} step={leverageStep} value={config.leverage} onChange={event => onChange('leverage', Number(event.target.value))}/><span>倍</span>
      </div><small>后续开仓使用此杠杆，开仓前核验交易所实际设置。每腿保证金约为开仓价值 ÷ 杠杆，另留手续费。</small></label>
      <label className="config-field"><span>新开仓保证金模式</span>
        <select aria-label="新开仓保证金模式" name="marginMode" value={config.marginMode ?? 'legacy'} onChange={event => onChange('marginMode', event.target.value === 'legacy' ? undefined : event.target.value as AppConfig['marginMode'])}>
          {legacyMarginMode && <option value="legacy">沿用原交易所模式</option>}<option value="crossed">全仓（默认）</option><option value="isolated">逐仓</option>
        </select><small>仅用于后续新开仓，已有持仓不自动切换。全仓共享账户保证金；保存设置不会立即修改交易所账户。</small>
      </label>
    </div>
    <div className="settings-note"><Shield size={16}/><span>新开仓前核验保证金模式与杠杆。Bybit 账户模式不一致时，请在交易所调整账户保证金模式后再开仓；系统不会自动切换整个账户。</span></div>
  </section>;
}
export function Settings({ config, onSave, busy, readiness }: { config: AppConfig; onSave: (draft: AppConfig, expectedConfig: AppConfig) => Promise<AppConfig>; busy: boolean; readiness?: AppState['liveReadiness'] }) {
  const [session, setSession] = useState(() => initialSettingsDraft(config));
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const { draft, dirty, symbolsText } = session;
  const configKey = settingsConfigKey(config);
  useEffect(() => { setSession(previous => observeSettingsConfig(previous, config)); }, [configKey]);
  const change = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => setSession(previous => changeSettingsField(previous, key, value));
  const save = async () => {
    if (busy || savingRef.current) return;
    savingRef.current = true; setSaving(true);
    try { const accepted = await onSave(settingsDraftForSave(session), session.expectedConfig); setSession(previous => acceptSettingsSave(previous, session.editRevision, accepted)); }
    catch {} finally { savingRef.current = false; setSaving(false); }
  };
  const visibleGroups = configGroups.filter(group => (config.mode === 'paper' || group.title !== '纸面模拟')&&(entryPolicy(draft)!=='aligned'||group.title!=='入场规则')).map(group=>group.title==='入场规则'?{...group,text:entryPolicyDescription(entryPolicy(draft)),fields:entryPolicy(draft)==='funding'?group.fields.filter(field=>field.key==='minCombinedNetUsd'):group.fields}:group).map(group=>entryPolicy(draft)==='aligned'?{...group,fields:group.fields.filter(field=>field.key!=='exitWeakFundingBps')}:group);
  return <form className="settings-form" onSubmit={e => { e.preventDefault(); void save(); }}><div className="settings-intro"><div><h2>策略参数</h2><p>入场参数用于后续机会；保存变更后暂停新开仓。账户、杠杆及退出参数变更按相关持仓状态校验。</p></div><button className="btn primary" disabled={busy || saving || !dirty} type="submit">{busy || saving ? <LoaderCircle size={16} className="spin"/> : <Check size={16}/>} 保存配置{dirty ? ' · 未保存' : ''}</button></div><FeeRebateControls config={draft} onChange={change}/><OpeningTradingControls config={draft} baselineLeverage={session.expectedConfig.leverage} legacyMarginMode={session.expectedConfig.marginMode === undefined} onChange={change}/><section className="panel config-section"><h3>数据源与策略</h3><p>{config.mode === 'live' ? '实盘使用交易所公开实时行情；配置账户后通过启动检查确认本次自动交易。' : '默认读取交易所公开实时行情并使用纸面账户。合成演示行情用于离线验证，会明确标注。'}</p><div className="config-grid"><EntryPolicySelector config={draft} onChange={value=>change('entryPolicy',value)}/><EntryExecutionSelector config={draft} onChange={value=>change('entryExecutionMode',value)}/><ProfitExitExecutionSelector config={draft} onChange={value=>change('profitExitExecutionMode',value)}/><AsyncFundingTimingSelector config={draft} onChange={value=>change('asyncFundingEntryTiming',value)}/>{config.mode === 'paper' && <label className="config-field"><span>行情来源</span><select value={draft.dataSource} onChange={e => change('dataSource', e.target.value as AppConfig['dataSource'])}><option value="demo">合成演示行情</option><option value="public">交易所公开实时行情</option></select><small>切换前需无持仓；已有纸面累计账本会保留，独立实验请使用独立数据目录。</small></label>}<label className="config-field"><span>持仓模式</span><select value={draft.holdMode} onChange={e => change('holdMode', e.target.value as AppConfig['holdMode'])}><option value="once">单次结算后退出</option><option value="continuous">持续持有并监控费率</option><option value="adaptive">自主判断 · 按后续净收益续持/退出</option></select><small>{draft.holdMode === 'adaptive' ? entryPolicy(draft)==='aligned'?alignedAdaptiveHoldingRule(draft):'资金费到账后，按当前可平盘口扣完全部手续费净收益达标就退出；否则比较下一轮资金费能否覆盖剩余平仓手续费，能覆盖则续持' : draft.holdMode === 'once' ? '结算一次后退出，不再续持' : '一直持有，直到你手动平仓；没有自动退出'}</small></label>{draft.marginMode === undefined && <label className="config-field"><span>Bitget 新合约保证金</span><select value={draft.bitgetNewSymbolMarginMode ?? 'isolated'} onChange={e => change('bitgetNewSymbolMarginMode', e.target.value as AppConfig['bitgetNewSymbolMarginMode'])}><option value="isolated">逐仓</option><option value="crossed">全仓</option></select><small>只用于尚无配置的新合约，已有配置保持；全仓共享账户保证金。</small></label>}<label className="config-field"><span>跟踪币种</span><input value={symbolsText} onChange={e => { const value = e.target.value; setSession(previous => changeSettingsSymbols(previous, value)); }} placeholder="BTC, ETH, SOL"/><small>以英文逗号分隔基础币种，不加 USDT</small></label></div><div className="settings-note"><Shield size={16}/><span>开仓前核对行情能否成交、账户能否下单和该币种是否已占用。已有持仓只影响对应币种。</span></div><div className="exchange-select"><span>{config.mode === 'live' ? '启用行情交易所' : '启用交易所'}</span>{(Object.keys(venues) as ExchangeId[]).map(id => <label key={id}><input type="checkbox" checked={draft.exchanges.includes(id)} onChange={e => change('exchanges', e.target.checked ? [...draft.exchanges, id] : draft.exchanges.filter(x => x !== id))}/><Venue id={id}/>{config.mode === 'live' && readiness?.exchanges.find(exchange => exchange.exchange === id)?.supported === false && <small>仅行情</small>}</label>)}</div><div className="settings-note"><Shield size={16}/><span>当前执行模式：{config.mode === 'paper' ? '纸面交易' : '实盘（账户就绪后才允许下单）'}。实盘自动交易由启动检查和用户确认开启，重启或保存策略后需重新启动。</span></div></section>{visibleGroups.map(group => <section className="panel config-section" key={group.title}><h3>{group.title}</h3><p>{group.text}</p><div className="config-grid">{group.fields.map(field => <label className="config-field" key={field.key}><span>{field.label}</span><div className="input-unit"><input type="number" required value={(field.key === 'maxEntryBatches' ? draft.maxEntryBatches ?? 8 : field.key === 'entryIocBufferBps' ? draft.entryIocBufferBps ?? 8 : field.key === 'minExitProfitBps' ? draft.minExitProfitBps ?? 10 : draft[field.key]) as number} min={field.min} max={field.max} step={field.step || 'any'} onChange={e => change(field.key, Number(e.target.value))}/><span>{field.unit}</span></div><small>{field.hint}</small></label>)}</div></section>)}<section className="panel config-section"><h3>{config.mode === 'live' ? '实盘手续费 · 官方本地参考费率' : '模拟 Taker 手续费'}</h3><p>实盘列表按官方本地参考费率估算；下单前核对账户实际费率，开仓和平仓时按具体合约读取。已付费用按实际成交及账单记录；模拟配置仅用于纸面计算。</p>{config.mode === 'paper' && <div className="config-grid">{(Object.keys(venues) as ExchangeId[]).map(id => <label className="config-field" key={id}><span><Venue id={id} small/></span><div className="input-unit"><input type="number" min="0" max="100" step="0.01" required value={Number((draft.takerFees[id] * 10000).toFixed(4))} onChange={e => change('takerFees', { ...draft.takerFees, [id]: Number(e.target.value) / 10000 })}/><span>bps</span></div><small>{num(draft.takerFees[id] * 100, 4)}% / 次成交</small></label>)}</div>}</section><div className="settings-save"><button className="btn" type="button" onClick={() => setSession(previous => restoreSettingsDraft(previous))}>还原当前配置</button><button className="btn primary" type="submit" disabled={busy || saving || !dirty}>保存全部设置 <Check size={16}/></button></div></form>;
}

function Backtest({ busy, run, result, config }: { config:AppConfig; busy: boolean; run: (rows?: HistoricalRow[]) => Promise<void>; result: BacktestResult | null }) {
  const unavailableReason=config.dualAdvantageEnabled ? '当前资金费＋价差策略需要历史双腿深度盘口及数量精度，现有 funding / 价格文件还不能完整回测此策略。' : config.holdMode==='adaptive' ? '自主判断持仓需要连续退出盘口，当前历史格式不支持；原策略回测请选择单次或持续持有。' : '';
  const [importError, setImportError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const download = () => { if (!result) return; const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `funding-backtest-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url); };
  return <div className="backtest-page"><section className="panel backtest-intro"><div className="backtest-visual"><FlaskConical size={37}/><span>RESEARCH LAB</span></div><div><Badge>历史验证</Badge><h2>先验证收益，再考虑执行</h2><p>基于逐时刻可见的资金费率与价格重放策略，计算资金费、往返手续费、价差损益和最大回撤。回测使用当前策略配置。</p>{unavailableReason && <p className="negative" role="status">{unavailableReason}</p>}<div className="button-row"><button className="btn primary" disabled={busy || !!unavailableReason} onClick={() => run()}>{busy ? <LoaderCircle className="spin" size={16}/> : <Play size={15}/>} 运行演示回测</button><button className="btn" disabled={busy || !!unavailableReason} onClick={() => fileRef.current?.click()}><Upload size={16}/> 导入历史 JSON</button><input ref={fileRef} hidden type="file" accept=".json,application/json" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; setImportError(''); try { const parsed: unknown = JSON.parse(await file.text()); const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && 'rows' in parsed ? (parsed as { rows: unknown }).rows : null; if (!Array.isArray(rows) || !rows.length) throw new Error('文件需包含非空 HistoricalRow 数组，或 { "rows": [...] }。'); await run(rows as HistoricalRow[]); } catch (err) { setImportError((err as Error).message); } finally { e.target.value = ''; } }}/></div>{importError && <p className="negative">{importError}</p>}</div></section><div className="info-strip"><CircleHelp size={16}/><span>演示回测使用合成历史数据，与当前公开实时行情分开，仅验证程序逻辑。真实历史数据可通过项目历史下载命令获取，格式见 README。</span></div>{result ? <><div className="backtest-results-head"><div><h2>回测结果 <Badge kind="neutral">{result.source === 'demo' ? '合成演示数据' : result.source}</Badge></h2><p>{date(result.start)} — {date(result.end)}</p></div><button className="btn" onClick={download}><Download size={15}/>导出结果</button></div><div className="metrics-grid"><MiniStat label="回测净收益" value={money(result.netPnlUsd, true)} caption={`${result.trades} 次完整交易`} icon={<ArrowUpRight size={17}/>} tone={pnlClass(result.netPnlUsd)}/><MiniStat label="资金费收入" value={money(result.fundingUsd, true)} caption={`手续费 ${money(result.feesUsd)}`} icon={<ArrowDownLeft size={17}/>} tone={pnlClass(result.fundingUsd)}/><MiniStat label="价差损益" value={money(result.spreadPnlUsd, true)} caption={`胜率 ${num(result.winRatePct)}%`} icon={<ArrowLeftRight size={17}/>} tone={pnlClass(result.spreadPnlUsd)}/><MiniStat label="最大回撤" value={money(result.maxDrawdownUsd)} caption="按回测净值轨迹计算" icon={<ArrowDownRight size={17}/>} tone="negative"/></div><section className="panel chart-panel"><SectionTitle title="回测净收益曲线" caption="USD · 含计入的交易成本"/><EquityChart points={result.equity}/></section>{result.warnings.length > 0 && <div className="backtest-warnings">{result.warnings.map((w, i) => <p key={i}><ShieldAlert size={16}/>{w}</p>)}</div>}<section className="panel"><SectionTitle title="交易记录" caption={`${result.closedTrades.length} 笔已平仓对冲`}/>{result.closedTrades.length ? <div className="table-scroll"><table><thead><tr><th>币种</th><th>开仓时间</th><th>平仓时间</th><th>净收益</th></tr></thead><tbody>{result.closedTrades.map((t, i) => <tr key={i}><td><b>{t.base}</b></td><td>{date(t.openedAt)}</td><td>{date(t.closedAt)}</td><td className={pnlClass(t.netPnlUsd)}>{money(t.netPnlUsd, true)}</td></tr>)}</tbody></table></div> : <Empty title="该区间内没有完成交易" text="查看回测提示或调整策略条件后再次验证。"/>}</section></> : <section className="panel"><Empty title="准备好第一轮策略验证" text="运行演示回测以查看完整流程，或导入真实历史 funding 与价格数据。" icon={<FlaskConical size={30}/>}/></section>}</div>;
}

export default function App() {
  const [opportunitySearch, setOpportunitySearch] = useState('');
  const [showLiveStart, setShowLiveStart] = useState(false);
  const [state, setState] = useState<AppState | null>(null), [page, setPage] = useState<Page>('overview'), [connectionError, setConnectionError] = useState(''), [busy, setBusy] = useState(false), [toast, setToast] = useState<{ text: string; error: boolean } | null>(null), [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null), [modal, setModal] = useState<{ title: string; text: string; confirm: string; operationKey: string; manualClose?: boolean; action: () => Promise<void> } | null>(null);
  const [portfolioClock, setPortfolioClock] = useState(Date.now);
  useEffect(() => {
    const portfolio = state?.livePortfolio;
    if (!portfolio) return;
    const now = Date.now();
    const nextExpiry = nextPortfolioTransition(portfolio, now);
    if (nextExpiry === undefined) return;
    const timer = setTimeout(() => setPortfolioClock(Date.now()), Math.min(2_147_483_647, nextExpiry - now));
    return () => clearTimeout(timer);
  }, [state?.livePortfolio, portfolioClock]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [initialMutationLocks] = useState(() => new Map(restorePendingOperations().map(operation => [operation.key, operation])));
  const mutationLocks = useRef(initialMutationLocks);
  const [, operationChanged] = useState(0);
  const stateRequestVersion = useRef(0), publishedStateVersion = useRef(0);
  const operations = [...mutationLocks.current.values()];
  const hasOperation = (key: string) => mutationLocks.current.has(key);
  const manualEntries = useManualEntries(state);
  const pendingBases = new Set([...operations.flatMap(operation => operation.base ? [operation.base] : []), ...manualEntries.pendingBases]);
  const pendingEntryStages = new Map(manualEntries.entries.filter(request => manualEntries.pendingBases.has(request.base)).map(request => [request.base, manualEntryStage(request)]));
  const pendingPositionIds = new Set(operations.flatMap(operation => operation.key.startsWith('close:') && operation.positionId ? [operation.positionId] : []));
  const pendingCloseBases = new Set(operations.flatMap(operation => operation.key.startsWith('close:') && operation.base ? [operation.base] : []));
  const configBusy = hasOperation('config');
  const updateOperation = (operation: PendingOperation | string) => {
    if (typeof operation === 'string') mutationLocks.current.delete(operation);
    else mutationLocks.current.set(operation.key, operation);
    try { sessionStorage.setItem(pendingStorageKey, JSON.stringify([...mutationLocks.current.values()].filter(item => item.financial))); } catch { /* The current page still retains every pending operation. */ }
    operationChanged(version => version + 1);
  };
  const liveLocked = !!state && liveOrdersLocked(state);
  const liveEntryLocked = !!state && liveEntriesLocked(state);
  const portfolioSummary=portfolioPositionSummary(state?.livePortfolio);
  const actualPositionCount=state?.config.mode==='live' ? portfolioSummary.count : state?.totals.openPositions??0;
  const liveAccountUnavailable = state?.config.mode === 'live' && state.totals.availableBalanceUsd === null;
  useEffect(() => { if (state?.config.mode === 'live' && page === 'backtest') setPage('overview'); if (liveLocked) setModal(current => current?.manualClose ? current : null); }, [state?.config.mode, page, liveLocked]);
  const notify = (text: string, error = false) => { setToast({ text, error }); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 6500); };
  const publishState = (next: AppState, version: number) => {
    if (version < publishedStateVersion.current) return;
    publishedStateVersion.current = version;
    setState(next); setConnectionError('');
    for (const operation of [...mutationLocks.current.values()]) {
      if (!operation.financial || operation.phase === 'pending') continue;
      const manualId = operation.key.startsWith('close:manual-close-') ? operation.key.slice('close:manual-close-'.length) : undefined;
      const receipt = manualId ? next.manualCloseOperations?.find(item => item.id === manualId) : undefined;
      if (receipt?.state === 'failed' && !receipt.positionId) {
        updateOperation(operation.key); notify(receipt.error ?? '该次平仓检查未通过，未提交订单，请刷新后重新确认', true); continue;
      }
      if (receipt?.state === 'completed' && !receipt.positionId) { updateOperation(operation.key); continue; }
      const position = operation.positionId ? next.positions.find(item => item.id === receipt?.positionId || item.id === operation.positionId ||
        operation.positionId === `manual-close-${item.manualCloseOperationId}`) :
        next.positions.find(item => item.base === operation.base && item.openedAt >= operation.startedAt);
      // Unchanged state is never evidence that an interrupted financial request was rejected.
      // Recorded results, or confirmed archival evidence newer than this action, may release the duplicate guard.
      const archivedAfterAction=!!position?.accountClosure&&position.accountClosure.confirmedAt>=operation.startedAt;
      const hasCurrentUnknown=position&&(operation.key.startsWith('close:')?currentCloseOrdersUnknown(position,next):
        next.unconfirmedOrders?.some(order=>order.positionId===position.id&&!order.historical));
      if (operation.key.startsWith('entry:') && position && position.status !== 'opening' &&
        (!hasCurrentUnknown||archivedAfterAction)) updateOperation(operation.key);
      else if (operation.key.startsWith('close:') && position &&
        (position.status === 'closed' || archivedAfterAction || (manualId?finishedManualClose(position,next,manualId):
          position.status === 'attention' && (operation.phase === 'accepted' ||
          Math.max(position.closeRequestedAt ?? 0, position.closeAttemptedAt ?? 0) >= operation.startedAt))) &&
        (!hasCurrentUnknown||archivedAfterAction)&&(!currentCloseOperationInFlight(position,next)||archivedAfterAction)) {
        updateOperation(operation.key);
        if(manualId&&operation.phase==='uncertain'&&!archivedAfterAction){const feedback=manualCloseFeedback(position);notify(feedback.text,feedback.error);}
      }
      else if (operation.key === 'control:kill' && next.killSwitch && next.positions.every(item => item.status === 'closed'||item.accountClosure&&item.accountClosure.confirmedAt>=operation.startedAt)) updateOperation(operation.key);
    }
  };
  const refresh = async () => { const version = ++stateRequestVersion.current; const next = await api<AppState>('/state?view=dashboard','GET',undefined,AbortSignal.timeout(5000)); publishState(next, version); };
  useEffect(() => {
    let alive = true, inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined, active: AbortController | undefined;
    const poll = async () => {
      if (!alive || inFlight) return;
      inFlight = true;
      const controller = new AbortController(); active = controller;
      const timeout = setTimeout(() => controller.abort(), 5000);
      const version = ++stateRequestVersion.current;
      try { const next = await api<AppState>('/state?view=dashboard','GET',undefined,controller.signal); if (alive) publishState(next, version); }
      catch (err) { if (alive && version >= publishedStateVersion.current) setConnectionError((err as Error).message); }
      finally { clearTimeout(timeout); inFlight = false; if (alive) timer = setTimeout(poll, displayPollInterval(2000)); }
    };
    const stopListening = listenForForeground(() => { clearTimeout(timer); void poll(); });
    void poll();
    return () => { alive = false; active?.abort(); clearTimeout(timer); stopListening(); if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, []);
  const mutate = async <T = void,>(path: string, method: string, body: unknown, success: string, scope: { base?: string; positionId?: string; manualClose?: boolean } = {}): Promise<T> => {
    const action = path === '/control' ? (body as { action?: string }).action : undefined;
    const pause = action === 'pause';
    const manualClose = scope.manualClose === true && method === 'POST' &&
      (path === '/portfolio/close' || /^\/positions\/[^/]+\/close$/.test(path));
    if (!pause && ((!manualClose && liveLocked && (path.startsWith('/positions') || path === '/control')) ||
      (liveEntryLocked && action === 'startAuto'))) {
      if (path === '/positions' || action === 'startAuto') setShowLiveStart(true);
      const message = '账户尚未就绪，请重新检查；暂停新开仓仍可使用'; notify(message, true); throw new Error(message);
    }
    const key = path === '/positions' ? `entry:${scope.base}` : scope.positionId ? `close:${scope.positionId}` : path === '/control' ? `control:${action}` : 'config';
    if (hasOperation(key) || manualClose && [...mutationLocks.current.values()].some(item => item.key.startsWith('close:') && item.base === scope.base)) { const message = '本项操作正在处理或结果待确认，不能重复提交'; notify(message, true); throw new Error(message); }
    const financial = path.startsWith('/positions') || path === '/portfolio/close' || action === 'kill';
    const operation: PendingOperation = { key, label: scope.base ? `${scope.base}${scope.positionId ? '平仓' : '开仓'}` : action === 'kill' ? '紧急停止与平仓' : success,
      financial, phase: 'pending', startedAt: Date.now(), ...scope };
    updateOperation(operation);
    try {
      const requestBody = path === '/config' && body && typeof body === 'object' ?
        { ...body, ...(!('expectedConfig' in body) ? { expectedConfig: state?.config } : {}) } : body;
      const result = await api<Position | AppConfig | { ok?: boolean }>(path, method, requestBody, AbortSignal.timeout(financial ? 45000 : 30000));
      if (financial) {
        updateOperation({ ...operation, phase: 'accepted', ...('id' in result ? { positionId: result.id } : {}) });
      } else updateOperation(key);
      // The write is already accepted. A failed state read must never be reported as a failed write.
      const feedback=manualClose&&'id' in result&&'long' in result?manualCloseFeedback(result):{text:success,error:false};
      notify(feedback.text,feedback.error);
      try { await refresh(); }
      catch { notify(`${feedback.text}；界面同步暂未完成，请查看持仓或对账，勿重复提交`, true); }
      return result as unknown as T;
    } catch (err) {
      // A timeout, rate limit or server failure cannot prove that a financial
      // request was rejected before execution. Keep its original ID for GET
      // reconciliation; only a definite parameter/permission rejection unlocks.
      if (financial && (!(err instanceof ApiResponseError) || err.status === 408 || err.status === 429 || err.status >= 500)) {
        updateOperation({ ...operation, phase: 'uncertain' });
        const message = `${operation.label}请求结果待确认，已保留本项操作锁。请刷新持仓或对账；不会自动重发，仍可暂停新开仓`;
        notify(message, true); throw new Error(message);
      }
      updateOperation(key); notify((err as Error).message, true); throw err;
    }
  };
  const control = (action: 'startAuto' | 'pause' | 'kill' | 'resume' | 'reconcile') => mutate('/control', 'POST', { action }, { startAuto: '自动策略已启动，等待符合条件的机会', pause: '已暂停新开仓，继续管理已有仓位', kill: '已触发紧急停止与平仓流程', resume: '已解除紧急停止，请手动重新启动自动策略', reconcile: '本轮对账已完成，未确认币种继续保留限制' }[action]);
  const openCandidatePosition = (opportunityId: string) => {
    const base = opportunityId.slice(0, opportunityId.indexOf('-'));
    if (!/^[A-Z0-9]{2,30}$/.test(base)) { notify('机会币种无法确认，请重新核验', true); return; }
    if (hasOperation(`entry:${base}`)) { notify(`${base} 的原开仓请求仍待确认，不能重复提交`, true); return; }
    try { manualEntries.start(opportunityId); } catch (error) { notify((error as Error).message, true); }
  };
  const openPosition = (o: Opportunity) => openCandidatePosition(o.id);
  const closePosition = (p: Position) => {
    if (!state) return;
    const selected = positionCloseAction(p, state);
    if (!selected.enabled || pendingCloseBases.has(p.base)) { notify(selected.reason ?? '本币种平仓仍待确认，请勿重复提交', true); return; }
    const operationId = crypto.randomUUID(), expectedId = `manual-close-${operationId}`;
    const live = p.mode === 'live', positionId = live ? expectedId : p.id;
    const path = selected.external ? '/portfolio/close' : `/positions/${encodeURIComponent(p.id)}/close`;
    const expiresAt = Date.now() + 45000;
    const text = live ? selected.legs.map(leg => `${venues[leg.exchange]} · ${leg.symbol} · ${leg.side === 'long' ? '多头' : '空头'} ${leg.quantity.toLocaleString('en-US', { maximumFractionDigits: 20 })} 币`).join('；') +
      '。只平上述持仓；确认后再次读取账户，数量或持仓身份变化时提示重新确认。此操作不会启动自动策略。' : '按模拟持仓数量平仓并记录模拟成交费用。';
    setModal({ title: `确认平仓 ${p.base}`, text, confirm: '确认平仓', manualClose: true, operationKey: `close:${positionId}`, action: async () => {
      if (Date.now() > expiresAt) { notify('确认信息已过期，请重新点击平仓读取当前数量', true); return; }
      await mutate(path, 'POST', live ? { acknowledgement: selected.external ? 'CLOSE_SELECTED_ACCOUNT_POSITION' : 'CLOSE_SELECTED_POSITION',
        operationId, base: p.base, legs: selected.legs, expiresAt } : {}, '本次手动平仓已处理，请查看各腿结果', { base: p.base, positionId, manualClose: true });
    } });
  };
  const go = (next: Page) => { setPage(next); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const activeNav = nav.find(n => n.id === page)!;
  const feeOnly = !!state && isFeeOnly(state.config);
  const connectedExchanges = state ? opportunityExchangeScope(state) : [];
  const available = state ? filterOpportunityPairs(state.opportunities, connectedExchanges).filter(o => o.entryReady ?? o.eligible).length : 0;
    return <div className="app-shell"><aside className="sidebar"><a className="brand" href="#" onClick={e => { e.preventDefault(); go('overview'); }}><span className="brand-logo"><span/><span/><span/></span><div>Funding<span>DESK</span></div></a><div className="workspace"><span className="workspace-icon"><ArrowLeftRight size={17}/></span><div><b>资金费率套利</b><small>跨交易所 · 市场中性</small></div><ChevronDown size={14}/></div><span className="nav-label">工作台</span><nav>{nav.filter(item => state?.config.mode !== 'live' || item.id !== 'backtest').map(item => <button key={item.id} title={item.label} aria-label={item.label} onClick={() => go(item.id)} className={`nav-item ${page === item.id ? 'active' : ''}`}><item.icon size={18}/><span>{item.label}</span>{item.id === 'opportunities' && available > 0 && <b className="nav-count">{available}</b>}{item.id === 'positions' && !!actualPositionCount && <b className="nav-count">{actualPositionCount}</b>}</button>)}</nav><div className="sidebar-exchanges"><div className="nav-label">交易所连接 <Radio size={13}/></div>{state ? state.exchanges.map(ex => <ExchangeConnection key={ex.exchange} exchange={ex} state={state}/>) : <span className="sidebar-loading">正在连接行情服务…</span>}</div><div className="sidebar-bottom"><div className="mode-card"><span>{state?.config.mode === 'live' ? <Radio size={17}/> : <FlaskConical size={17}/>}{state?.config.mode === 'live' ? state.autoEnabled ? '实盘自动交易模式' : '实盘手动模式' : '纸面交易模式'}</span><p>{state?.config.mode === 'live' ? state.autoEnabled ? AUTOMATIC_ENTRY_MODE : '手动点击只处理所选组合，自动策略关闭' : feeOnly ? '模拟资金 · 只扣手续费' : '模拟资金 · 完整策略流程'}</p></div><div className="sidebar-footer"><span className="avatar">FD</span><div><b>本地工作区</b><small>Funding Desk v1.0</small></div><span className="local-dot"/></div></div></aside><div className="main-wrap"><header className="topbar"><div className="breadcrumb">工作台 <ChevronRight size={13}/><b>{activeNav.label}</b></div><div className="topbar-status"><MarketConnectionPill state={state} connectionError={connectionError}/><span className="topbar-separator"/>{page !== 'funding' && <span className="data-mode">{state ? state.config.dataSource === 'public' ? '公开实时行情' : '合成演示行情' : '等待数据源'}</span>}<button className="icon-btn" aria-label="查看运行日志" onClick={() => go('logs')}><Bell size={18}/>{state && (state.killSwitch || state.positions.some(position => position.status === 'attention'&&!position.accountClosure)) && <i className="notification-dot"/>}</button></div></header><main><div className="page-heading"><div><div className="eyebrow">FUNDING RATE ARBITRAGE</div><h1>{page === 'overview' ? state?.config.dataSource === 'public' ? '实时资金费率工作台' : state?.config.dataSource === 'demo' ? '演示资金费率工作台' : '资金费率工作台' : activeNav.label}<span className="heading-dot">.</span></h1><p>{({ overview: AUTOMATIC_ENTRY_RULE, execution: '比较执行方式与入场路径，区分已确认收益、失败成本与待核对记录。', funding: '查看已接入交易账户的费率矩阵，区分数据来源、结算周期与真实累计区间。', opportunities: '可开仓组合优先显示，公共盘口后台自动核验，其他币种继续监测。', positions: '让两条交易腿保持对冲，追踪每笔结算与资金变化。', backtest: '用历史轨迹检验策略，理解收益来源与潜在回撤。', settings: '调整下单金额、收益条件、行情和持仓模式。', logs: '查看行情采集、账户状态与订单执行记录。' })[page]}</p></div>{state && page !== 'funding' && <div className="page-actions"><Badge kind={state.config.mode === 'paper' ? 'neutral' : 'orange'}>{state.config.mode === 'paper' ? <FlaskConical size={13}/> : <Radio size={13}/>} {state.config.mode === 'paper' ? 'PAPER' : state.autoEnabled ? 'LIVE · 自动' : 'LIVE · 手动'}</Badge>{feeOnly && <span className="fee-only-header"><Badge kind="orange">只扣手续费 · 每腿 {state.config.orderNotionalUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })} U</Badge></span>}{state.autoEnabled ? <button className="btn" disabled={hasOperation('control:pause')} onClick={() => void control('pause').catch(() => {})}><Pause size={15}/>暂停自动策略</button> : state.config.mode === 'live' && liveEntryLocked ? <button className="btn primary" disabled={hasOperation('control:startAuto')} onClick={() => setShowLiveStart(true)}><Play size={15}/>启动策略</button> : state.killSwitch ? <button className="btn" disabled={hasOperation('control:resume') || liveLocked} onClick={() => void control('resume').catch(() => {})}><Play size={15}/>解除停止</button> : <button className="btn primary" disabled={hasOperation('control:startAuto') || !!connectionError} onClick={() => void control('startAuto').catch(() => {})}>{hasOperation('control:startAuto') ? <LoaderCircle size={16} className="spin"/> : <Play size={15}/>}启动自动策略</button>}{!state.autoEnabled && <button className="btn small-btn" disabled={hasOperation('control:pause')} onClick={() => void control('pause').catch(() => {})}><Pause size={14}/>暂停新开仓</button>}<button className="btn reconcile-btn" disabled={hasOperation('control:reconcile') || liveLocked} title="读取交易所账户与订单状态，核对本地账本" onClick={() => void control('reconcile').catch(() => {})}><ArrowLeftRight size={14}/>对账</button><button className="btn stop-btn" disabled={hasOperation('control:kill') || liveLocked || state.killSwitch} title="停止开仓并尝试平掉全部仓位" onClick={() => setModal({ title: '紧急停止所有策略？', text: '系统将阻止新开仓，并尝试平掉全部未平仓双腿。部分成交与交易所断连可能需要继续处理，请查看持仓状态和日志。', confirm: '停止并平仓', operationKey: 'control:kill', action: () => control('kill') })}><Square size={13}/>紧急停止</button></div>}</div>{operations.some(operation => operation.financial) && <div className="info-strip operation-status" role="status"><Clock3 size={17}/><span>{operations.filter(operation => operation.financial).map(operation => `${operation.label}：${operation.phase === 'pending' ? '请求处理中' : operation.phase === 'accepted' ? '已接受，等待状态同步' : '结果待确认'}`).join('；')}。对应操作不会重复提交，可刷新持仓或对账，仍可暂停新开仓。</span></div>}{connectionError && <div className="error-banner"><ShieldAlert size={18}/><div><b>无法连接服务</b><span>{connectionError}。{state ? '正在展示上次成功获取的数据；请勿依赖过期数据下单。' : '请确认本地服务已启动。'}系统将自动重试。</span></div><button className="btn small-btn" onClick={() => void refresh().catch(err => setConnectionError((err as Error).message))}>重新连接</button></div>} {state?.config.mode === 'live' && <LiveReadiness state={state} onStartCheck={liveEntryLocked ? () => setShowLiveStart(true) : undefined}/>} {page === 'funding' ? <FundingStatistics exchanges={connectedExchanges} source={state?.config.fundingStatsSource || 'auto'} sourceBusy={configBusy || !state || !!connectionError} onSourceChange={fundingStatsSource => mutate('/config', 'PATCH', { fundingStatsSource }, '资金费率统计与套利机会的数据来源已同步')} onViewOpportunities={base => { setOpportunitySearch(base || ''); go('opportunities'); }}/> : !state ? <div className="panel loading-panel"><LoaderCircle className="spin" size={30}/><h3>正在同步套利工作台</h3><p>读取账户、行情与订单状态</p></div> : <><div className={`strategy-strip ${state.killSwitch ? 'halted' : ''}`}><div><span className={`pulse-dot ${state.autoEnabled ? 'on' : ''}`}/><b>{liveLocked ? '手动观察与开仓 · 自动未启用' : liveEntryLocked ? '账户待检查 · 自动开仓暂停' : state.killSwitch ? '策略已紧急停止' : state.autoEnabled ? '自动策略运行中' : '手动观察模式'}</b><span className="strip-divider"/><span>{state.config.holdMode === 'once' ? '单次结算策略' : state.config.holdMode === 'adaptive' ? '自主判断 · 逐轮续持/退出' : '持续持有策略'}</span><span className="strip-divider"/><span>{state.config.hedgeMode === 'base' ? '币数量对冲' : '名义价值对冲'}</span></div><span><Clock3 size={13}/> 界面同步 {time(state.timestamp)}</span></div>{page === 'opportunities' && state.config.dataSource === 'public' && feeOnly && <div className="fee-only-banner"><FlaskConical size={19}/><div><b>只扣手续费 · 每腿 {state.config.orderNotionalUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })} U</b><p>{state.config.dualAdvantageEnabled ? '入场：资金费为正、开仓价差优于近期退出价差，两者合计扣一次四笔手续费后净收益达标。没有入场窗口、基差或仓位上限。' : '费后预计收益 = 预计资金费 − 双腿开平四笔手续费。实际成交及价差损益仍记录；账户、盘口与数量条件满足后才能下单。'}</p></div></div>}{(page === 'overview' || page === 'logs') && <MarketDiagnostics state={state}/>}<div className={`source-notice ${state.config.dataSource}`}><span>{state.config.dataSource === 'public' ? <Radio size={14}/> : <FlaskConical size={14}/>}</span>{state.config.dataSource === 'public' ? '交易执行行情 · 交易所公开接口' : '合成演示行情 · 非实时数据'}<span> · {state.config.mode === 'paper' ? '纸面交易，模拟账户损益' : liveLocked ? '实盘待启动，先检查账户' : '实盘交易账户'}</span></div>{page === 'overview' && <><OverviewPerformance state={state} renderEquity={points => <EquityChart points={points}/>} /><button className="funding-overview-shortcut" onClick={() => go('funding')}><span className="funding-shortcut-icon"><Gauge size={19}/></span><span><b>资金费率统计</b><small>已接入交易账户费率矩阵 · 当前费率与真实区间累计</small></span><span>查看统计 <ArrowUpRight size={15}/></span></button>{state.config.dataSource === 'public' ? <FundingOpportunities state={state} busy={!!connectionError} pendingBases={pendingBases} pendingEntryStages={pendingEntryStages} preview onOpen={openCandidatePosition} onMore={() => { setOpportunitySearch(''); go('opportunities'); }} onStatistics={() => go('funding')}/> : <Opportunities busy={!!connectionError} pendingBases={pendingBases} state={state} preview onOpen={openPosition} onMore={() => go('opportunities')}/>}<div className="overview-lower"><section className="panel strategy-summary"><SectionTitle title="策略快照" action={<button className="text-btn" onClick={() => go('settings')}><SlidersHorizontal size={14}/>配置</button>}/><div className="strategy-stats"><div><span>每腿下单金额</span><b>{money(state.config.orderNotionalUsd, false, 0)}</b></div><div><span>自动入场</span><b>单轮收益／价差两条路径</b></div><div><span>手续费口径</span><b>双腿开平四笔</b></div><div><span>自动对手价1优势</span><b>&gt;20；价差路径 &gt;100 / IOC &gt;80</b></div></div><div className="strategy-explanation"><span><Shield size={19}/></span><p><b>自动开仓筛选</b>{AUTOMATIC_ENTRY_RULE}实际成交价差、资金费与手续费持续计入损益。</p></div></section><Logs state={state} preview onMore={() => go('logs')}/></div><Positions state={state} pendingPositionIds={pendingPositionIds} pendingCloseBases={pendingCloseBases} preview onClose={closePosition} onMore={() => go('positions')}/></>}{page === 'opportunities' && (state.config.dataSource === 'public' ? <FundingOpportunities state={state} busy={!!connectionError} pendingBases={pendingBases} pendingEntryStages={pendingEntryStages} onOpen={openCandidatePosition} onStatistics={() => go('funding')} initialSearch={opportunitySearch}/> : <Opportunities busy={!!connectionError} pendingBases={pendingBases} state={state} onOpen={openPosition} onMore={() => {}}/>)}{page === 'positions' && <>{state.config.mode==='paper' && <div className="position-summary"><div><span>当前对冲仓位</span><strong>{state.totals.openPositions}<small>组</small></strong></div><div><span>双腿总名义价值</span><strong>{money(state.totals.grossExposureUsd)}</strong></div><div><span>{state.config.mode === 'paper' ? '可用模拟余额' : liveAccountUnavailable ? '交易账户未连接' : '可用余额'}</span><strong>{state.totals.availableBalanceUsd === null ? '—' : money(state.totals.availableBalanceUsd)}</strong></div></div>}<Positions state={state} pendingPositionIds={pendingPositionIds} pendingCloseBases={pendingCloseBases} onClose={closePosition} onMore={() => {}}/></>}{page === 'settings' && <div className="settings-stack"><AccountSettings readiness={state.liveReadiness} onUpdated={() => void refresh().catch(() => {})}/><Settings config={state.config} readiness={state.liveReadiness} busy={configBusy || !!connectionError} onSave={(draft, expectedConfig) => mutate<AppConfig>('/config', 'PATCH', { ...draft, expectedConfig }, '策略配置已保存')}/></div>} {page === 'backtest' && state.config.mode === 'paper' && <Backtest config={state.config} busy={busy} result={backtestResult} run={async rows => { setBusy(true); try { const result = await api<BacktestResult>('/backtest', 'POST', rows ? { rows } : { source: 'demo' }); setBacktestResult(result); notify('回测已完成'); } catch (err) { notify((err as Error).message, true); } finally { setBusy(false); } }}/>} {page === 'execution' && <ExecutionStatistics summary={state.executionStatistics}/>} {page === 'logs' && <Logs state={state} onMore={() => {}}/>}<footer className="page-footer"><span>Funding Desk <span>·</span> {state.config.dataSource === 'demo' ? '合成行情用于流程验证' : '盘口直接连接交易所公开 API'}</span><span>所有金额以 USD 计 · 时间为本地时区</span></footer></>}</main></div><ManualEntryProgress entries={manualEntries.entries} state={state} cancelPending={manualEntries.cancelPending} onCancel={manualEntries.cancel} onDismiss={manualEntries.dismiss}/>{toast && <div className={`toast ${toast.error ? 'error' : ''}`} role="status">{toast.error ? <ShieldAlert size={18}/> : <Check size={18}/>}<span>{toast.text}</span><button className="icon-btn" onClick={() => setToast(null)} aria-label="关闭提示"><X size={16}/></button></div>}{showLiveStart && state?.config.mode === 'live' && <LiveStartDialog orderNotionalUsd={state.config.orderNotionalUsd} onClose={() => setShowLiveStart(false)} onStarted={async () => { await refresh(); notify('实盘自动策略已启动'); }} onRecovered={async () => { await refresh(); notify('已恢复持仓管理，自动开仓保持关闭'); }} onConfigure={() => { setShowLiveStart(false); go('settings'); }}/>} {modal && <div className="modal-backdrop" onClick={() => !hasOperation(modal.operationKey) && setModal(null)}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onClick={e => e.stopPropagation()}><span className="modal-icon"><ShieldAlert size={25}/></span><h2 id="modal-title">{modal.title}</h2><p>{modal.text}</p><div className="button-row"><button className="btn" disabled={hasOperation(modal.operationKey)} onClick={() => setModal(null)}>取消</button><button className="btn danger" disabled={hasOperation(modal.operationKey) || (liveLocked && !modal.manualClose)} onClick={async () => { const action = modal.action; setModal(null); try { await action(); } catch {} }}>{modal.confirm}</button></div></div></div>}</div>;
}
