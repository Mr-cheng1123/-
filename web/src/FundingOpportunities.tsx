import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowLeftRight, ArrowRight, ArrowUp, ArrowUpRight, Check, ChevronLeft, ChevronRight, CircleHelp, Clock3, LoaderCircle, Radio, RefreshCw, Search, Shield, ShieldAlert, X } from 'lucide-react';
import type { AppState, ExchangeId, MarketSnapshot, Opportunity } from '../../src/shared/types';
import type { FundingCandidateView, FundingOpportunitiesResponse, FundingVerificationDiagnostics } from '../../src/shared/funding-opportunities';
import { fundingPairKey } from '../../src/shared/funding-opportunities';
import { decodeFundingOpportunitiesTransport } from '../../src/shared/funding-opportunity-transport';
import { opportunityExchangeScope } from '../../src/shared/opportunity-exchange-scope';
import {feeRebatePct} from '../../src/shared/fee-rebates';
import './funding-opportunities.css';
import './candidate-evidence.css';
import { liveOrdersLocked } from './LiveReadiness';
import { DualAdvantage } from './DualAdvantage';
import { EntryChecklist } from './EntryChecklist';
import { isFeeOnly } from '../../src/shared/strategy-profile';
import { candidateProfit, candidateSortValue, compareCandidateValues, type CandidateSortKey } from './candidate-profit';
import { candidateAuthorizationKey, connectedCandidateResponse } from './candidate-authorization';
import { entryPolicy, entryPolicyLabel, roundsEstimate } from './entry-policy';
import {entryBatchPresentation} from './entry-batch-presentation';
import {candidatePricePresentation,candidateReferenceQuoteCaption,retainCandidateReferenceQuotes,type CandidatePricePresentation} from './candidate-price-reference';
import {AUTOMATIC_ENTRY_RULE} from './automatic-entry-presentation';
import AutomaticFundingEntryStatus from './AutomaticFundingEntryStatus';
import {alignedAdaptiveHoldingRule} from './holding-policy-presentation';
import { applyCandidateVerification, sameCandidatePair } from './candidate-verification';
import { candidateExecutionIsFresh, candidateIsFresh, candidateOccupiedReason, summarizeCandidateReadiness } from './candidate-readiness';
import { isPositionActive } from '../../src/shared/ledger-lifecycle';
import RealtimeStatus from './RealtimeStatus';
import { useStableLiveOrder } from './use-stable-live-order';
import { useBoundedPage } from './use-bounded-page';
import { displayPollInterval, listenForForeground } from './display-polling';
import BookCostBreakdown from './BookCostBreakdown';
import { bookCostScope, bookPrice, firstBatchBookCostCaption, opportunityBookLoss } from './book-cost-presentation';
import './book-cost-breakdown.css';
import FundingSchedule, {fundingEntryWindowCaption} from './FundingSchedule';
import './funding-schedule.css';

const venues: Record<ExchangeId, string> = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX', gate: 'Gate', bitget: 'Bitget' };
const PAGE_SIZE = 50;
const moneyFormat = new Intl.NumberFormat('en-US', {minimumFractionDigits:2,maximumFractionDigits:2});
const rateFormat = new Intl.NumberFormat('en-US', {minimumFractionDigits:4,maximumFractionDigits:4});
const numberFormats = new Map<number,Intl.NumberFormat>();
const dateFormat = new Intl.DateTimeFormat('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const money = (value: number | null | undefined, signed = false) => value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value < 0 ? '−' : signed && value > 0 ? '+' : ''}$${moneyFormat.format(Math.abs(value))}`;
const rate = (value: number) => `${value > 0 ? '+' : ''}${rateFormat.format(value * 100)}%`;
const number = (value: number, digits = 2) => { let formatter=numberFormats.get(digits); if(!formatter){formatter=new Intl.NumberFormat('en-US',{maximumFractionDigits:digits});numberFormats.set(digits,formatter);}return formatter.format(value); };
const date = (timestamp: number) => timestamp ? dateFormat.format(timestamp) : '—';
const tone = (value: number | null | undefined) => value !== null && value !== undefined && value > 0 ? 'positive' : value !== null && value !== undefined && value < 0 ? 'negative' : '';
const sourceLabel = (source?: FundingOpportunitiesResponse['source']) => source === 'coinglass' ? 'CoinGlass 官方 API' : source === 'exchanges' ? '交易所官方接口' : source === 'demo' ? '合成演示数据' : '等待统计来源';
const age = (timestamp: number, now: number) => timestamp ? `${Math.max(0, Math.floor((now - timestamp) / 1000))} 秒前` : '尚未收到';
type Filter = 'all' | 'afterFees' | 'net' | 'tradable' | 'ioc20';
type SortKey = CandidateSortKey;

function VerificationTiming({diagnostics}:{diagnostics?:FundingVerificationDiagnostics}) {
  if(!diagnostics)return null;
  const batch=diagnostics.currentBatch??diagnostics.recentBatches.at(-1);
  const ms=(value?:number)=>value!==undefined&&Number.isFinite(value)&&value>=0?`${number(value,0)} ms`:'—';
  const selections={'ioc-ready':'IOC 条件就绪','positive-fee-net':'扣费收益为正',ready:'条件就绪','funding-priority':'资金费重点','fair-rotation':'公平轮转',discovery:'普通发现'};
  const outcomes={reading:'读取中',returned:'已返回',failed:'读取失败',deadline:'读取超时','already-in-flight':'上次请求仍在途'};
  return <details className="candidate-coverage"><summary>公共核验耗时 · 最近 {diagnostics.sampleCount} 批 · 排队 P95 {ms(diagnostics.queueWaitP95Ms)} · 读取 P95 {ms(diagnostics.readP95Ms)} · 发布 P95 {ms(diagnostics.publishP95Ms)}</summary>
    <p>本次进程待轮转 {diagnostics.queuedCoins} 币，最早进入本地队列 {date(diagnostics.oldestQueuedAt??0)}。最多保留 {diagnostics.sampleLimit} 批；排队 P95 只统计已选中组合，读取按交易所请求、发布按成功批次统计。超时计入读取，仍在途未重发的不作新请求样本。这些时间不是市场机会首次出现时间，也不代表已允许下单。</p>
    {batch&&<><p>第 {batch.sequence} 批 · 选中 {date(batch.selectedAt)} · {batch.outcome==='published'?`发布完成 ${date(batch.publishedAt!)}`:batch.outcome==='discarded'?'配置或运行代际变化，本批已丢弃':batch.outcome==='publish-failed'?'本批发布失败':'本批读取中'}</p>
      <ul>{batch.reads.map(read=><li key={read.exchange}><b>{venues[read.exchange]}</b><span>{outcomes[read.outcome]} · {ms(read.finishedAt===undefined?undefined:read.finishedAt-read.startedAt)}</span></li>)}</ul>
      <ul>{batch.routes.map(route=><li key={route.id}><b>{route.base}</b><span>{selections[route.selectionReason]} · 排队 {ms(route.selectedAt-route.queuedAt)} · {route.pairedAt?`双腿齐备 ${date(route.pairedAt)}`:`待 ${route.missingExchanges.map(exchange=>venues[exchange]).join(' / ')} 盘口`}</span></li>)}</ul>
    </>}
  </details>;
}

function useCandidates(configKey: string, authorizationKey: string) {
  const requestKey = `${configKey}\u0000${authorizationKey}`;
  const [data, setData] = useState<FundingOpportunitiesResponse | null>(null);
  const [loadedKey, setLoadedKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [localVerificationAt,setLocalVerificationAt]=useState<number>();
  const reload = useRef<() => Promise<void>>(async () => {});
  const revision = useRef(0);
  const applyVerification = (row: FundingCandidateView, opportunity?: Opportunity, note?: string) => {
    revision.current += 1;
    setLocalVerificationAt(Date.now());
    setData(current => current ? { ...current, rows: current.rows.map(candidate => fundingPairKey(candidate)!==fundingPairKey(row)?candidate:applyCandidateVerification(candidate,opportunity,note)) } : current);
  };
  useEffect(() => {
    revision.current += 1;
    let disposed = false, inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined, active: AbortController | undefined;
    // Keep the current detail and table while permission changes are refreshed.
    // The previous generation cannot submit orders until the new reply arrives.
    setError('');
    const poll = async () => {
      if (disposed || inFlight) return;
      inFlight = true; setLoading(true);
      const requestRevision = revision.current;
      const controller = new AbortController(); active = controller;
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch('/api/funding-opportunities?format=columns-v1', { cache: 'no-store', signal: controller.signal });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `机会接口返回 ${response.status}`);
        const next = decodeFundingOpportunitiesTransport(payload);
        // A list request sent before a verification must not overwrite its newer result.
        if (!disposed && revision.current === requestRevision) { setData(next); setLocalVerificationAt(undefined); setLoadedKey(requestKey); setError(''); }
      } catch (err) {
        if (!disposed) setError((err as Error).name === 'AbortError' ? '机会同步超时，正在等待重试；已暂停本页核验与开仓操作。' : (err as Error).message);
      } finally {
        clearTimeout(timeout); inFlight = false;
        if (!disposed) { setLoading(false); timer = setTimeout(poll, displayPollInterval(5000)); }
      }
    };
    reload.current = async () => { if (!inFlight) { clearTimeout(timer); await poll(); } };
    const stopListening = listenForForeground(() => { void reload.current(); });
    void poll();
    return () => { disposed = true; active?.abort(); clearTimeout(timer); stopListening(); reload.current = async () => {}; };
  }, [requestKey]);
  return { data, error, loading, localVerificationAt, synchronized: loadedKey === requestKey, reload: () => reload.current(), applyVerification };
}

const blockSummary = (row: FundingCandidateView, policy: 'aligned'|'funding'|'dual' = 'dual') => {
  if (row.verifyNote) return `核验未取得盘口：${row.verifyNote}`;
  const all = row.execution ? [...new Set(row.execution.reasons)] : row.reasons.filter(reason => !reason.includes('待核验'));
  if (!all.length) return row.execution ? '收益与成交条件已通过，提交前检查合约设置' : policy!=='dual' ? '后台自动核验盘口，不等待历史样本' : '后台自动核验盘口与价差样本';
  return all.length > 1 ? `${all[0]} 等 ${all.length} 项，点击查看` : all[0];
};

function LegDetails({ snapshot, label, exchange }: { snapshot?: MarketSnapshot; label: string; exchange: ExchangeId }) {
  return <div className="candidate-leg"><h3><span>{label}</span>{venues[exchange]}</h3>{snapshot ? <dl><div><dt>标记 / 指数价格</dt><dd>{bookPrice(snapshot.markPrice)} / {bookPrice(snapshot.indexPrice)}</dd></div><div><dt>买一 / 卖一</dt><dd>{snapshot.bids[0] ? bookPrice(snapshot.bids[0].price) : '—'} / {snapshot.asks[0] ? bookPrice(snapshot.asks[0].price) : '—'}</dd></div><div><dt>未平仓量 OI</dt><dd>{money(snapshot.openInterestUsd)}</dd></div><div><dt>24h 成交额</dt><dd>{money(snapshot.volume24hUsd)}</dd></div><div><dt>盘口时间</dt><dd>{date(snapshot.timestamp)}</dd></div></dl> : <p>等待盘口核验后取得标记价、指数价、深度与流动性数据。</p>}</div>;
}

interface Props {
  state: AppState;
  busy: boolean;
  pendingBases?: ReadonlySet<string>;
  pendingEntryStages?: ReadonlyMap<string, string>;
  onOpen: (opportunityId: string) => void;
  preview?: boolean;
  onMore?: () => void;
  onStatistics?: () => void;
  initialSearch?: string;
}

export default function FundingOpportunities({ state, busy, pendingBases, pendingEntryStages, onOpen, preview = false, onMore, onStatistics, initialSearch = '' }: Props) {
  const feeOnly = isFeeOnly(state.config);
  const liveLocked = liveOrdersLocked(state);
  const dual = entryPolicy(state.config) === 'dual';
  const aligned = entryPolicy(state.config) === 'aligned';
  const showRebates=feeRebatePct('gate',state.config)>0||feeRebatePct('bitget',state.config)>0;
  const profitFor=(row:FundingCandidateView)=>marketView.byRow.get(row)?.profit??candidateProfit(row,{requireNative:state.config.mode==='live',entryPolicy:state.config.entryPolicy});
  const netValue = (row: FundingCandidateView) => profitFor(row).combinedNetUsd;
  const displayNet = (row: FundingCandidateView) => netValue(row) ?? profitFor(row).fundingAfterFeesUsd;
  const displayLabel = (row: FundingCandidateView) => profitFor(row).feesPending?'手续费待计算':netValue(row) !== null ? entryPolicy(state.config,row.execution)==='aligned'?row.execution?.entryBatch?'完整目标单轮净收益（条件参考）':'单轮预计净收益（参考）':'合计预计净收益' : profitFor(row).subtotalIsReference && (entryPolicy(state.config,row.execution)!=='dual'||!!row.execution) ? '资金费扣手续费 · 参考小计' : '资金费扣手续费';
  const expectedLabel = aligned?'单轮预计净收益（参考）':'合计预计净收益';
  const netThreshold = aligned?0:state.config.minCombinedNetUsd;
  const [search, setSearch] = useState(initialSearch);
  const [filter, setFilter] = useState<Filter>('all');
  const [prioritize, setPrioritize] = useState(true);
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: aligned?'grossFundingUsd':'afterFeesUsd', direction: 'desc' });

  const [orderRevision, setOrderRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [verifying, setVerifying] = useState<ReadonlySet<string>>(new Set());
  const [actionMessage, setActionMessage] = useState<{ text: string; error: boolean } | null>(null);
  const verificationRef = useRef(new Map<string, AbortController>());
  const verificationVersion = useRef(0);
  const mounted = useRef(true);
  const referenceQuoteCache = useRef(new Map<string,MarketSnapshot>());
  const configKey = JSON.stringify(state.config);
  const exchangeScope = opportunityExchangeScope(state);
  const exchangeScopeKey = JSON.stringify([...exchangeScope].sort());
  const authorizationKey = candidateAuthorizationKey(state);
  const { data: receivedData, error, loading, localVerificationAt, synchronized, reload, applyVerification } = useCandidates(configKey, authorizationKey);
  const data = useMemo(() => receivedData ? connectedCandidateResponse(receivedData, state) : null,
    [receivedData, authorizationKey, configKey]);
  // Numeric accounting and string keys depend on incoming market data, not on
  // clocks, search keystrokes, or an unrelated account/status render.
  const marketView = useMemo(() => {
    const entries=(data?.rows??[]).map(row=>({row,key:fundingPairKey(row),searchText:`${row.base} ${row.longExchange} ${row.shortExchange}`.toLowerCase(),profit:candidateProfit(row,{requireNative:state.config.mode==='live',entryPolicy:state.config.entryPolicy})}));
    return {entries,byRow:new Map(entries.map(entry=>[entry.row,entry])),byKey:new Map(entries.map(entry=>[entry.key,entry.row])),
      afterFeesPositive:entries.filter(entry=>(entry.profit.fundingAfterFeesUsd??-Infinity)>0).length,
      budgetPositive:entries.filter(entry=>(entry.profit.combinedNetUsd??-Infinity)>netThreshold).length};
  },[data,state.config.mode,state.config.entryPolicy,netThreshold]);
  const quoteLookup = retainCandidateReferenceQuotes(referenceQuoteCache.current,state.snapshots,exchangeScope,now);
  referenceQuoteCache.current = quoteLookup;
  // Resolve only displayed rows/details; independent reference prices never enter
  // financial sorting, eligibility or the automatic entry assessment.
  const priceCache = new Map<FundingCandidateView,CandidatePricePresentation>();
  const priceFor = (row:FundingCandidateView) => {
    let price=priceCache.get(row);
    if(!price){price=candidatePricePresentation(row,quoteLookup,state.config,now);priceCache.set(row,price);}
    return price;
  };
  useEffect(() => { mounted.current = true; const timer = setInterval(() => setNow(Date.now()), 1000); return () => { mounted.current = false; clearInterval(timer); for (const controller of verificationRef.current.values()) controller.abort(); }; }, []);
  useEffect(() => {
    verificationVersion.current += 1;
    for (const controller of verificationRef.current.values()) controller.abort();
    verificationRef.current.clear(); setVerifying(new Set());
  }, [configKey, authorizationKey]);
  useEffect(() => { setSearch(initialSearch); }, [initialSearch]);
  useEffect(() => { setFilter('all');setSort({key:entryPolicy(state.config)==='aligned'?'grossFundingUsd':'afterFeesUsd',direction:'desc'}); }, [state.config.entryPolicy]);
  useEffect(() => { setPage(1); }, [search, filter, sort, configKey, prioritize]);
  const existingBases = new Set(state.positions.filter(isPositionActive).map(position => position.base));
  const heldCoin=(row:FundingCandidateView)=>existingBases.has(row.base)||!!state.liveReadiness?.excludedCoins?.find(item=>item.base===row.base&&item.reasons.some(reason=>/已有.*(持仓|仓位)/.test(reason)));
  const coinBlock = (row: FundingCandidateView) => candidateOccupiedReason(row,state,pendingBases);
  const readiness = {state,data,now,synchronized,pendingBases,unavailable:busy||!!error,verifyingPairs:verifying};
  const readyRows = useMemo(() => summarizeCandidateReadiness(readiness),[marketView,state,now,synchronized,pendingBases,busy,error,verifying]);
  const prepared = (row: FundingCandidateView) => readyRows.prepared.has(row);
  const tradable = (row: FundingCandidateView) => readyRows.submittable.has(row);
  // Sort financial values only when those values or the selected sort change.
  // Time-sensitive readiness is a cheap linear partition of this cached order.
  const valueOrder = useMemo(() => marketView.entries.map(entry=>({...entry,value:candidateSortValue(entry.row,entry.profit,sort.key)}))
    .sort((a,b)=>compareCandidateValues(a.value,b.value,sort.direction)||a.row.id.localeCompare(b.row.id)),[marketView,sort]);
  const rankedKeys = useMemo(() => {
    const query = search.trim().toLowerCase();
    const first:string[]=[],rest:string[]=[];
    for(const {row,key,searchText,profit} of valueOrder){
      if(!searchText.includes(query))continue;
      if(filter==='afterFees'&&(profit.fundingAfterFeesUsd??-Infinity)<=0||filter==='net'&&(profit.combinedNetUsd??-Infinity)<=netThreshold||filter==='tradable'&&!readyRows.prepared.has(row)||filter==='ioc20'&&!readyRows.ioc20.has(row))continue;
      (prioritize&&readyRows.prepared.has(row)?first:rest).push(key);
    }
    return first.concat(rest);
  },[valueOrder,search,filter,netThreshold,readyRows,prioritize]);
  const matchingKeys = useMemo(()=>new Set(rankedKeys),[rankedKeys]);
  const liveRows = marketView.byKey;
  const listOrder = useStableLiveOrder(JSON.stringify([search, filter, sort, configKey, exchangeScopeKey, prioritize, orderRevision]), rankedKeys);
  const refreshOrder = () => { setOrderRevision(value => value + 1); setPage(1); };
  const selectFilter = (next: Filter) => { setFilter(next); refreshOrder(); };
  const refreshList = async () => { await reload(); if (mounted.current) refreshOrder(); };
  const pageCount = Math.max(1, Math.ceil(listOrder.keys.length / PAGE_SIZE));
  const [visiblePage, setPage] = useBoundedPage(pageCount);
  const rowKeys = preview ? listOrder.keys.slice(0, 5) : listOrder.keys.slice((visiblePage - 1) * PAGE_SIZE, visiblePage * PAGE_SIZE);
  const detail = selected ? liveRows.get(selected) : undefined;
  const detailProfit = detail ? profitFor(detail) : null;
  const detailFunding = !!detail && entryPolicy(state.config,detail.execution)==='funding';
  const detailAligned = !!detail && entryPolicy(state.config,detail.execution)==='aligned';
  const detailPrice=detailAligned&&detail?priceFor(detail):undefined;
  const detailBatch=detailAligned?detailPrice?.batch:entryBatchPresentation(detail?.execution,state.config.orderNotionalUsd);
  const statistics=detail?.statistics??detail;
  const detailQuoteAt=(exchange:ExchangeId,at?:number)=>at??state.snapshots.find(snapshot=>snapshot.base===detail?.base&&snapshot.exchange===exchange)?.observedAt??state.snapshots.find(snapshot=>snapshot.base===detail?.base&&snapshot.exchange===exchange)?.timestamp;
  const {afterFeesPositive,budgetPositive} = marketView;
  const verifiedCount = readyRows.prepared.size;
  const ioc20Count = readyRows.ioc20.size;
  const sourceProblem = data && data.status !== 'ready' && data.status !== 'loading';
  const sortBy = (key: SortKey) => setSort(old => ({ key, direction: old.key === key ? old.direction === 'desc' ? 'asc' : 'desc' : 'desc' }));
  const SortIcon = ({ column }: { column: SortKey }) => sort.key !== column ? <ArrowDown className="sort-idle" size={10}/> : sort.direction === 'desc' ? <ArrowDown size={10}/> : <ArrowUp size={10}/>;
  const sortLabel: Record<SortKey, string> = { expectedNetUsd: expectedLabel, afterFeesUsd: '资金费扣手续费', grossFundingUsd: '预计资金费', feesUsd: '双腿开平手续费', normalized8hBps: '净费率差' };
  const spreadProgress = (row: FundingCandidateView) => {
    const spread = row.execution?.spreadAdvantage;
    if(entryPolicy(state.config,row.execution)==='aligned'){
      const price=priceFor(row);
      return price.edgeBps===null?`${price.label}待同步 · ${price.reason}`:
        `${price.label} ${number(price.edgeBps)} bps · ${price.kind==='batch'?`IOC 实际限价 ${price.iocEdgeBps===null?'待核验':`${number(price.iocEdgeBps)} bps`}`:candidateReferenceQuoteCaption(price.reference,now)}`;
    }
    if (entryPolicy(state.config, row.execution) === 'funding') return spread?.status === 'ready' ? `盘口开平损耗 ${money(opportunityBookLoss(row.execution))} · ${bookCostScope(row.execution)}` : '等待盘口 · 不等待历史样本';
    if (spread?.status === 'ready' && Number.isFinite(spread.spreadAdvantageBps)) return `价差优势 ${number(spread.spreadAdvantageBps!)} bps`;
    if (!spread) return '盘口待采样 · 价差待计算';
    return `价差观察 ${spread.samples}/${spread.requiredSamples} · ${Math.floor(spread.observedSpanSec)}/${spread.requiredSpanSec} 秒`;
  };
  const entryWait = (row:FundingCandidateView) => entryPolicy(state.config,row.execution)==='aligned'&&
    row.fundingSchedule?.valid===true&&row.fundingSchedule.entryReady===false;
  const waitingCaption = (row:FundingCandidateView) => fundingEntryWindowCaption(row.fundingSchedule)??(row.fundingSchedule?.recommendedEntryAt?
    `${date(row.fundingSchedule.recommendedEntryAt)} 后重新核验`:'等待结算时序更新');
  const verify = async (row: FundingCandidateView) => {
    if (verificationRef.current.has(fundingPairKey(row)) || busy || error || !synchronized || !data || !candidateIsFresh(row, data, Date.now())) return;
    const controller = new AbortController(); verificationRef.current.set(fundingPairKey(row), controller);
    const version = verificationVersion.current;
    const timeout = setTimeout(() => controller.abort(), 25000);
    setVerifying(current => new Set(current).add(fundingPairKey(row))); setActionMessage(null);
    try {
      const response = await fetch('/api/funding-opportunities/verify', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'funding-arb' }, body: JSON.stringify({ opportunityId: row.id }), signal: controller.signal });
      const result: { error?: string; opportunity?: Opportunity; reason?: string } = await response.json();
      if (!response.ok) throw new Error(result.error || '盘口核验未完成');
      if (result.opportunity && !sameCandidatePair(row,result.opportunity)) throw new Error('核验结果与当前币种及交易所组合不一致，请重新核验。');
      if (mounted.current && verificationVersion.current === version) {
        applyVerification(row, result.opportunity, result.reason);
        const ready = result.opportunity?.entryReady === true || result.opportunity?.eligible === true;
        setActionMessage({ text: ready ? `${row.base} 盘口核验通过，${result.opportunity?.eligible ? '当前可开仓' : '手动可开仓'}；下单前仍会重新检查。` : result.opportunity ? `${row.base} 核验完成：还有条件未满足，点击该行“查看条件”可看到逐项原因。` : `${row.base} 没有取得盘口明细：${result.reason ?? '请稍后重试'}`, error: !ready });
      }
    } catch (err) {
      if (mounted.current && verificationVersion.current === version) setActionMessage({ text: (err as Error).name === 'AbortError' ? '核验等待超过 25 秒。此操作不会下单；请等待列表刷新或稍后重试。' : (err as Error).message, error: true });
    } finally {
      clearTimeout(timeout);
      if (verificationRef.current.get(fundingPairKey(row)) === controller) verificationRef.current.delete(fundingPairKey(row));
      if (mounted.current && verificationVersion.current === version) {
        setVerifying(current => { const next = new Set(current); next.delete(fundingPairKey(row)); return next; });
        void reload();
      }
    }
  };
  const statusText = (row: FundingCandidateView) => {
    if (pendingEntryStages?.has(row.base)) return pendingEntryStages.get(row.base)!;
    if (coinBlock(row)) return heldCoin(row)?'已持有·继续监测':'币种占用';
    if (state.killSwitch) return '已停止';
    if (error) return '同步异常';
    if (!data || !candidateIsFresh(row, data, now)) return '等待新行情';
    if (!synchronized) return '正在同步行情与账户';
    if (entryWait(row)) return row.fundingSchedule!.recommendedEntryAt!==undefined&&now>=row.fundingSchedule!.recommendedEntryAt?
      '结算时点待重核':row.fundingSchedule!.entryWindow?.phase==='after'?row.fundingSchedule!.entryWindow.kind==='first-receipt'?'错过首轮·等下周期':'窗口已过·等下周期':'等待入场窗口';
    if (!row.execution) return row.verifyNote ? '后台等待重试' : '后台自动核验';
    if (!candidateExecutionIsFresh(row,state,now)) return '后台更新盘口';
    if (row.execution.checks?.some(check => check.group === 'execution' && check.pass === false && /未确认|核对|对账|未知/.test(check.reason))) return '需核对';
    if (row.execution.checks?.some(check => check.pass === null && check.group !== 'account')) return '等待数据';
    if (prepared(row)) return tradable(row) ? '手动可开仓' : '条件就绪·核验同步中';
    if (!row.execution.eligible) return row.execution.reasons.length || row.execution.checks?.some(check => check.pass === false) ? '条件不满足' : '等待核验同步';
    return tradable(row)?'手动可开仓':busy?'操作处理中':'等待账户或合约检查';
  };
  const action = (row: FundingCandidateView) => pendingBases?.has(row.base) ? <button className="btn small-btn" disabled title="按原操作编号追踪执行，不能重复提交"><LoaderCircle size={12} className="spin"/>{pendingEntryStages?.get(row.base) || '操作待确认'}</button> : entryWait(row)&&!coinBlock(row) ?
    <div className="candidate-entry-time"><button className="btn small-btn candidate-entry-time-btn" onClick={()=>setSelected(fundingPairKey(row))} title={row.fundingSchedule!.reason}><Clock3 size={12}/>查看时序</button><span className="cell-caption">{waitingCaption(row)}</span></div> : tradable(row) ? <button className="btn primary small-btn" disabled={busy || !!error || verifying.has(fundingPairKey(row)) || state.killSwitch || existingBases.has(row.base)} title={existingBases.has(row.base) ? '该币种已有仓位' : '提交前重查合约模式、杠杆、盘口与保证金，按钮可用不代表成交保证'} onClick={() => onOpen(row.execution!.id)}>{state.config.mode === 'paper' ? '纸面开仓' : '实盘开仓'}</button> : prepared(row) ? <button className="btn small-btn" disabled={busy || verifying.has(fundingPairKey(row))} title="手动开仓无需启动自动策略；先同步本组合最新核验结果" onClick={() => void verify(row)}><RefreshCw size={12}/>同步核验</button> : <button className="btn small-btn candidate-verify" title="后台自动核验；此按钮仅手动重试公共盘口，不会下单" disabled={busy || !!error || !synchronized || verifying.has(fundingPairKey(row)) || !data || !candidateIsFresh(row, data, now)} onClick={() => void verify(row)}>{verifying.has(fundingPairKey(row)) || !synchronized ? <LoaderCircle size={12} className="spin"/> : <Shield size={12}/>} {verifying.has(fundingPairKey(row)) ? '核验中' : !synchronized ? '同步中' : '重试核验'}</button>;

  return <section className={`panel funding-candidates ${preview ? 'preview' : ''}`}>
    <div className="section-title"><div><h2>套利机会 <span className="badge">已接入交易账户组合</span></h2><p>与资金费率统计使用同一来源 · {prioritize?'优先可开仓，组内按':'按'}{sortLabel[sort.key]}{sort.direction === 'desc' ? '从高到低' : '从低到高'}排序 · 每个币种跨所组合分别计算</p></div>{preview ? <button className="text-btn" onClick={onMore}>查看全部 <ArrowUpRight size={15}/></button> : <button className="btn small-btn" onClick={() => void refreshList()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={13}/>刷新</button>}</div>
    <div className="candidate-source"><span><Radio size={12}/>{sourceLabel(data?.source)}</span><span>{data ? `${number(data.coinCount, 0)} 可配对币种 · ${number(data.pairCount, 0)} 对组合` : '正在读取已接入交易所组合'}</span><span><Clock3 size={12}/>收到于 {data?.receivedAt ? `${date(data.receivedAt)} · ${age(data.receivedAt, now)}` : '—'}</span>{onStatistics && <button className="text-btn" onClick={onStatistics}>查看资金费率统计 <ArrowUpRight size={13}/></button>}</div>
    <RealtimeStatus status={state.realtime} autoEnabled={state.autoEnabled} live={state.config.mode==='live'} now={now}/>
    <VerificationTiming diagnostics={data?.autoVerification?.diagnostics}/>
    {showRebates&&<p className="data-footnote">费用与净收益按 Gate {feeRebatePct('gate',state.config)}%、Bitget {feeRebatePct('bitget',state.config)}% 的配置返佣计算净成本。返佣仅估算，不读取或写入到账收入；实际下单仍核对账户原费率。</p>}
    <div className="candidate-monitor" role="status"><span><RefreshCw size={12} className={data?.autoVerification?.running?'spin':''}/><b>全市场公共核验进度</b></span>{data?.autoVerification?<><span>已尝试 {data.autoVerification.checkedCoins} / {data.autoVerification.totalCoins} 个币种</span><span>盘口新鲜 {data.autoVerification.freshCoins} · 待轮转 {data.autoVerification.pendingCoins} · 待重试 {data.autoVerification.failedCoins}</span><span>{data.autoVerification.running?`正在读取 ${data.autoVerification.activeCoins.join(' / ')||'下一批'}`:data.autoVerification.enabled?'持续分批更新，无需逐行点击':'当前暂停更新'}</span></>:<span>公共盘口分批读取，数值与状态自动更新；列表保持当前顺序。</span>}</div>
    {data?.coverage&&<details className="candidate-coverage"><summary>统计币种对应 {data.coverage.pairedCoinCount} / {data.coverage.statisticsCoinCount} · 已核验 {data.coverage.detailedPairCount} 组</summary><p>至少两家已接入交易账户的交易所具有有效当前费率与结算数据才可形成组合；尚未完成真实账户连接的交易所不参与机会统计。</p><ul>{data.coverage.unpaired.filter(item=>!search.trim()||item.base.toLowerCase().includes(search.trim().toLowerCase())).map(item=><li key={item.base}><b>{item.base}</b><span>{item.reason}（有效数据：{item.validExchanges.map(exchange=>venues[exchange]).join(' / ')||'暂无'}）</span></li>)}</ul>{data.coverage.unpairedCoinCount===0&&<p>已接入范围内的所有统计币种均已有可配对组合。</p>}</details>}
    <div className="candidate-budget-note"><span>{feeOnly ? '每腿目标' : '单腿目标预算'} <b>{number(state.config.orderNotionalUsd)} U</b></span><span>持有期 <b>{state.config.holdMode === 'once' ? '单次结算后退出' : state.config.holdMode === 'adaptive' ? aligned?'自主判断 · 获利达标优先分批退出':'自主判断 · 按持仓冻结规则续持或退出' : '一直持有，直到手动平仓'}</b></span><span>手动入场模式 <b>{entryPolicyLabel(entryPolicy(state.config))}</b>。{aligned ? `预计资金费为正、对手价分批 IOC 实际限价价格优势 > ${state.config.minEntryIocEdgeBps??0} bps 才入场，分批达到目标；每批重核条件，失去优势停止补仓。费用与单轮收益按完整目标条件预估，可持有多轮，不等待历史样本。` : dual ? '资金费为正、价差有优势，两者合计扣费后达标。历史样本不足时先显示资金费扣费小计。' : '资金费为正，扣四笔手续费与当前盘口开平损耗后达标；不要求正价差，不等待历史样本。盘口未就绪时显示参考小计。'}</span><span data-testid="automatic-entry-rule">{AUTOMATIC_ENTRY_RULE}</span>{aligned&&state.config.holdMode==='adaptive'&&<span>{alignedAdaptiveHoldingRule(state.config)}</span>}</div>
    {(error || sourceProblem || data?.message) && <div className="candidate-message warning"><ShieldAlert size={15}/><div>{error && <p>{error}</p>}{data?.message && <p>{data.message}</p>}{sourceProblem && !data.message && <p>统计来源暂不可用，等待恢复。过期数据不可核验或开仓。</p>}{data?.status === 'not_configured' && <button className="text-btn" onClick={onStatistics}>到资金费率统计查看来源配置 <ArrowRight size={13}/></button>}</div></div>}
    {liveLocked && <div className="candidate-message warning"><ShieldAlert size={15}/><p>{!state.liveUnlocked ? '手动开仓与自动策略独立：两腿账户、合约和盘口就绪后可直接点击实盘开仓；点击只授权这一笔，不启动自动策略。' : '当前账户条件尚未满足新开仓；请检查账户与订单状态。盘口核验本身不会下单。'}</p></div>}
    {actionMessage && <div className={`candidate-message ${actionMessage.error ? 'warning' : ''}`}>{actionMessage.error ? <ShieldAlert size={15}/> : <Check size={15}/>}<p>{actionMessage.text}</p><button className="icon-btn" aria-label="关闭核验提示" onClick={() => setActionMessage(null)}><X size={13}/></button></div>}
    <div className="candidate-filters"><label className="candidate-priority"><input type="checkbox" checked={prioritize} onChange={event=>setPrioritize(event.target.checked)}/><span>优先可开仓</span></label><div className="candidate-filter-tabs"><button className={filter === 'all' ? 'selected' : ''} onClick={() => selectFilter('all')}>全部 <span>{data?.rows.length || 0}</span></button><button className={filter === 'afterFees' ? 'selected' : ''} onClick={() => selectFilter('afterFees')}>资金费单独扣费为正 <span>{afterFeesPositive}</span></button><button className={filter === 'net' ? 'selected' : ''} onClick={() => selectFilter('net')}>{aligned?'单轮净收益为正（参考）':'合计收益达标'} <span>{budgetPositive}</span></button><button className={filter === 'tradable' ? 'selected' : ''} onClick={() => selectFilter('tradable')}>可开仓 <span>{verifiedCount}</span></button><button className={filter === 'ioc20' ? 'selected' : ''} onClick={() => selectFilter('ioc20')}>可开仓且 IOC &gt; 20 bps <span>{ioc20Count}</span></button></div><label className="search"><Search size={14}/><input placeholder="搜索币种或交易所" aria-label="搜索已接入交易所套利机会" value={search} onChange={event => setSearch(event.target.value)}/>{search && <button className="icon-btn" onClick={() => setSearch('')} aria-label="清空机会搜索"><X size={12}/></button>}</label></div>
    <div className="candidate-list-order"><span>列表位置已固定 · 行情和开仓状态实时更新{filter !== 'all' && ' · 失效组合原位标记'}</span><button className="text-btn" onClick={refreshOrder} disabled={!data || !synchronized} title="按最新筛选条件重新排列，优先可开仓；不会提交订单"><RefreshCw size={12}/>更新排序<span>{listOrder.added ? '新增 ' + listOrder.added + ' 组' : listOrder.removed ? listOrder.removed + ' 组条件变化' : listOrder.changed ? '排序有变化' : '当前排序'}</span></button></div>
    {data&&<div className="candidate-monitor" data-testid="candidate-count-evidence">
      <span>列表基准响应 {date(readyRows.computedAt??0)} · {readyRows.total} 组{localVerificationAt?` · 所选组合核验更新 ${date(localVerificationAt)}`:''}</span>
      <span>有效执行明细 {readyRows.executionCurrent} · 明细过期 {readyRows.executionStale} · 未取得明细 {readyRows.executionMissing}</span>
      <span>有效明细中：行情／收益等检查未通过 {readyRows.marketChecksFailed} · 检查未完成 {readyRows.marketChecksPending}</span>
      <span>可开仓条件就绪 {readyRows.prepared.size} · 当前按钮可提交 {readyRows.submittable.size}</span>
      <span>{readyRows.observationUnavailable?'服务连接或本页同步待恢复，已禁用核验与提交；保留的参考值不代表当前可交易。':'计数和行使用同一份当前列表，时效随当前时间检查；缺少明细不等于条件不满足。账户、权限、已有持仓及本币订单按当前状态复核。'}</span>
    </div>}
    <div className="table-scroll"><table className="candidate-table"><thead><tr>
      <th>币种 / 对冲路径</th>
      <th><button onClick={() => sortBy('normalized8hBps')}>净费率差 <SortIcon column="normalized8hBps"/></button><span className="th-note">8h 归一 · 费前参考</span></th>
      <th><button onClick={() => sortBy('grossFundingUsd')}>预计资金费 <SortIcon column="grossFundingUsd"/></button><span className="th-note">按本轮持有期</span></th>
      <th><button onClick={() => sortBy('feesUsd')}>双腿开平手续费 <SortIcon column="feesUsd"/></button><span className="th-note">{showRebates?'四次成交净费用 · 含预计返佣':'四次成交估算'}</span></th>
      {!feeOnly && <th><button onClick={() => sortBy('afterFeesUsd')}>资金费扣手续费 <SortIcon column="afterFeesUsd"/></button><span className="th-note">未计价差</span></th>}
      <th><button onClick={() => sortBy('expectedNetUsd')}>{expectedLabel} <SortIcon column="expectedNetUsd"/></button>{feeOnly && <button className="candidate-subtotal-sort" onClick={() => sortBy('afterFeesUsd')}>资金费扣手续费 <SortIcon column="afterFeesUsd"/></button>}<span className="th-note">{aligned?'资金费 − 四笔手续费 · 不计盘口损耗':dual ? '价差未就绪时显示已知小计' : '含盘口开平损耗 · 基差不变估计'}</span></th>
      <th>执行状态</th><th>操作</th>
    </tr></thead><tbody>{rowKeys.map(pairKey => {
      const row = liveRows.get(pairKey);
      if (!row) return <tr key={pairKey} data-pair-key={pairKey} className="candidate-missing"><td colSpan={feeOnly ? 7 : 8}><div className="candidate-status-content"><b>{JSON.parse(pairKey)[0]}</b><span className="cell-caption">该组合暂未同步 · 保留阅读位置，等待新数据或更新排序</span></div></td></tr>;
      const profit = profitFor(row);
      const batch=entryPolicy(state.config,row.execution)==='aligned'?priceFor(row).batch:entryBatchPresentation(row.execution,state.config.orderNotionalUsd);
      return <tr key={pairKey} data-pair-key={pairKey}>
        <td><button className="candidate-pair" onClick={() => setSelected(fundingPairKey(row))}><span className={`coin-mark coin-${row.base.toLowerCase()}`}>{row.base.slice(0, 1)}</span><span><b>{row.base}<small> / USDT</small></b><span className="pair-route"><span className="positive">多</span> {venues[row.longExchange]} <ArrowRight size={11}/><span className="negative">空</span> {venues[row.shortExchange]}</span></span></button><span className="candidate-filter-change">{!matchingKeys.has(pairKey) ? '已不符合当前分区' : '\u00a0'}</span></td>
        <td><b className={tone(row.normalized8hBps)}>{rate(row.normalized8hBps / 10000)}</b><span className="cell-caption">费前参考 APR {number(row.aprPct)}%</span></td>
        <td><b className={tone(profit.fundingUsd)}>{money(profit.fundingUsd, true)}</b><span className="cell-caption candidate-funding-batch candidate-funding-timing" title={row.fundingSchedule?.valid?`最近单次 ${date(row.fundingSchedule.nextEventTime)} ${money(row.fundingSchedule.nextEventUsd,true)}；双方本轮覆盖截至 ${date(row.fundingSchedule.endTime)}，合计 ${money(row.fundingSchedule.totalUsd,true)}。${row.fundingSchedule.hasRepeatedRate?'小时腿后续费率按当前值假设。':''}${batch?'完整目标全部成交后参考。':''}`:undefined}>{row.fundingSchedule?.valid?`最近单次 ${money(row.fundingSchedule.nextEventUsd,true)} · ${date(row.fundingSchedule.nextEventTime)}`:batch?'完整目标全部成交后参考':'\u00a0'}</span><span className="cell-caption">结算：多 {row.longFundingCount} / 空 {row.shortFundingCount} 次</span><span className="cell-caption candidate-raw-rates">统计原费率：{venues[(row.statistics??row).longExchange]} {rate((row.statistics??row).longRate)} / {(row.statistics??row).longIntervalHours}h · {venues[(row.statistics??row).shortExchange]} {rate((row.statistics??row).shortRate)} / {(row.statistics??row).shortIntervalHours}h</span></td>
        <td>{profit.feesPending?'手续费待计算':money(profit.feesUsd)}<span className="cell-caption">{profit.feesPending?'等待有效手续费估值':profit.feesSource==='reference'?'官方本地参考费率':profit.feesSource==='exchange'?'交易所账户实际费率':'模拟配置费率'}</span><span className="cell-caption">{batch?'完整目标预算 · ':''}每腿 {money(row.notionalUsd)}</span></td>
        {!feeOnly && <td><b className={tone(profit.fundingAfterFeesUsd)}>{profit.feesPending?'手续费待计算':money(profit.fundingAfterFeesUsd, true)}</b><span className="cell-caption">资金费 − 四笔手续费</span></td>}
        <td className="candidate-profit-cell"><b className={tone(displayNet(row))}>{profit.feesPending?'手续费待计算':money(displayNet(row), true)}</b><span className="cell-caption candidate-profit-label">{displayLabel(row)}</span><span className="cell-caption">{profit.feesPending?'仅展示原始资金费与价格，手续费估值待计算':entryPolicy(state.config,row.execution)==='aligned'?`资金费 ${money(profit.fundingUsd,true)} − 四笔手续费 ${money(profit.feesUsd)}`:profit.combinedNetUsd !== null ? `资金费 ${money(profit.fundingUsd, true)} · ${entryPolicy(state.config, row.execution)!=='dual'?`盘口损耗 ${money(profit.bookLossUsd)} · ${bookCostScope(row.execution)}`:`价差 ${money(profit.spreadUsd, true)}`}` : dual ? '价差待计算 · 合计未完成' : '盘口待核验 · 合计未完成'}</span>{entryPolicy(state.config,row.execution)!=='aligned'&&firstBatchBookCostCaption(row.execution)&&<span className="cell-caption">{firstBatchBookCostCaption(row.execution)}</span>}{entryPolicy(state.config,row.execution)==='aligned'?<span className="cell-caption">预计回本 {profit.feesPending?'手续费待计算':roundsEstimate(row.execution?.breakEvenRounds)}</span>:entryPolicy(state.config,row.execution)==='funding'&&<span className="cell-caption">实际 IOC 限价净收益 {money(profit.feesPending?null:row.execution?.entryLimitNetUsd,true)}</span>}<button className="candidate-detail-link" onClick={() => setSelected(fundingPairKey(row))}>查看条件 <ChevronRight size={10}/></button></td>
        <td><div className="candidate-status-content"><span className={`badge ${heldCoin(row)?'neutral':prepared(row) ? 'green' : row.verification === 'blocked' ? 'red' : 'orange'}`}>{statusText(row)}</span>{!heldCoin(row)&&<AutomaticFundingEntryStatus opportunity={row.execution} fresh={candidateExecutionIsFresh(row,state,now)}/>}<span className="dual-cell">{spreadProgress(row)}</span>{batch&&<><span className="cell-caption candidate-batch-plan">{batch.label}</span><span className="cell-caption">{batch.prices}</span></>}<span className="cell-caption candidate-risk-caption" title={[...new Set([...(row.execution?.reasons || []), ...row.reasons])].join('；')}>{coinBlock(row) || (prepared(row) && liveLocked ? '手动开仓就绪，点击后重新确认两腿条件' : blockSummary(row,entryPolicy(state.config,row.execution)))}</span></div></td>
        <td>{action(row)}</td>
      </tr>;
    })}</tbody></table></div>
    {!rowKeys.length && <div className="empty"><span className="empty-icon">{loading || data?.status === 'loading' ? <LoaderCircle size={28} className="spin"/> : <ArrowLeftRight size={28}/>}</span><strong>{state.config.mode === 'live' && exchangeScope.length < 2 ? '尚未接入两家真实交易账户' : data?.status === 'not_configured' ? '所选统计来源尚未配置' : loading || data?.status === 'loading' ? '正在计算已接入交易所组合' : filter === 'ioc20' ? '暂无可开仓且 IOC > 20 bps 的机会' : filter === 'tradable' ? '暂无通过完整核验的机会' : search || filter !== 'all' ? '没有符合筛选条件的机会' : '暂无时效合格的跨所组合'}</strong><p>{state.config.mode === 'live' && exchangeScope.length < 2 ? '成功读取账户后才显示该交易所的套利组合；仅有公开行情或已保存凭据不算完成连接。' : filter === 'ioc20' ? '该分区同时要求账户与入场检查就绪，实际 IOC 限价价格优势严格大于 20 bps（0.20%）。账户读取就绪即可查看，手动点击后按最新数据重新确认。' : filter === 'tradable' ? aligned ? `预计资金费为正、实际 IOC 价格优势 > ${state.config.minEntryIocEdgeBps??0} bps，盘口数量要能成交且两腿账户读取就绪。不用启动自动策略即可手动开仓。` : dual ? '资金费为正、开仓价差优于近期退出价差,且合计扣一次四笔手续费后净收益达标，盘口和数量也要能成交。' : '资金费为正，扣四笔手续费与盘口开平损耗后净收益达标；不等待历史样本，盘口和数量要能成交。' : '候选仅包含已真实连接交易账户的交易所组合；资金费和价差条件保持原规则。'}</p></div>}
    {preview ? listOrder.keys.length > 5 && <button className="table-footer" onClick={onMore}>查看其余 {number(listOrder.keys.length - 5, 0)} 对组合 <ArrowRight size={13}/></button> : <div className="candidate-pagination"><span>每页 {PAGE_SIZE} 行 · {listOrder.keys.length ? `${(visiblePage - 1) * PAGE_SIZE + 1}–${Math.min(visiblePage * PAGE_SIZE, listOrder.keys.length)} / ${number(listOrder.keys.length, 0)}` : '暂无结果'}</span><div><button className="btn small-btn" aria-label="上一页套利机会" disabled={visiblePage === 1} onClick={() => setPage(visiblePage - 1)}><ChevronLeft size={12}/>上一页</button><span>{visiblePage} / {pageCount}</span><button className="btn small-btn" aria-label="下一页套利机会" disabled={visiblePage >= pageCount} onClick={() => setPage(visiblePage + 1)}>下一页<ChevronRight size={12}/></button></div></div>}
    <div className="data-footnote"><CircleHelp size={13}/>多空方向按本轮结算现金流确定；8h 归一费率差和 APR 仅作参考，符号可能与本轮收益不同。后台自动分批核验公共盘口，无需逐行点击；手动开仓独立于自动策略，可开仓优先显示，其他币种继续监测。列表费用使用官方本地参考费率；下单前核对账户实际费率，并检查交易所合约模式、杠杆和余额，按钮可用不代表成交保证。</div>
    {detail && detailProfit && data && <div className="candidate-backdrop" onClick={() => setSelected(null)}><section className="panel candidate-drawer" role="dialog" aria-modal="true" aria-label={`${detail.base} 套利收益与执行详情`} onClick={event => event.stopPropagation()}>
      <div className="section-title"><div><h2>{detail.base} · 入场条件核验</h2><p>多 {venues[detail.longExchange]} / 空 {venues[detail.shortExchange]} · {sourceLabel(data.source)}</p></div><button className="icon-btn" aria-label="关闭入场详情" onClick={() => setSelected(null)}><X size={18}/></button></div>
      <div className="candidate-detail-body">
        <EntryChecklist opportunity={detail.execution} candidateReasons={detail.reasons} verified={synchronized && detail.verification === 'verified'} synchronizing={!synchronized} note={detail.verifyNote}/>
        <FundingSchedule schedule={detail.fundingSchedule} referenceOnly={!detail.execution} forEntry={detailAligned&&!heldCoin(detail)}/>
        {detailBatch&&<div className="candidate-budget-note"><span><b>{detailBatch.label}</b></span>{detailBatch.bestPrices&&<span>{detailBatch.bestPrices}</span>}<span>{detailBatch.prices}</span>{detailBatch.priceBuffers&&<span>{detailBatch.priceBuffers}</span>}{detailBatch.bestPriceEdge&&<span>{detailBatch.bestPriceEdge}</span>}{detailBatch.limitPriceEdge&&<span>{detailBatch.limitPriceEdge}</span>}<span>{detailBatch.forecastNote}</span></div>}
        <div className="candidate-summary">
          <div><span>{displayLabel(detail)}</span><strong className={tone(displayNet(detail))}>{detailProfit.feesPending?'手续费待计算':money(displayNet(detail), true)}</strong></div>
          <div><span>{detailBatch?'完整目标预计资金费（条件参考）':'预计资金费'}</span><strong className={tone(detailProfit.fundingUsd)}>{money(detailProfit.fundingUsd, true)}</strong></div>
          <div><span>{detailAligned?detailPrice!.label:detailFunding?'盘口开平损耗':'预计价差收益'}</span><strong className={detailAligned?tone(detailPrice!.edgeBps):detailFunding?'':tone(detailProfit.spreadUsd)}>{detailAligned?detailPrice!.edgeBps===null?'待同步':`${number(detailPrice!.edgeBps)} bps`:detailFunding ? detailProfit.bookLossUsd===null?'待计算':money(detailProfit.bookLossUsd) : detailProfit.spreadUsd===null?'待计算':money(detailProfit.spreadUsd, true)}</strong>{detailAligned&&<span className="cell-caption">{detailPrice!.kind==='reference'?candidateReferenceQuoteCaption(detailPrice!.reference,now):detailPrice!.reason}</span>}</div>
        </div>
        {detailProfit.combinedNetUsd === null && <p className="candidate-profit-pending">{detailProfit.feesPending?'两腿手续费估值尚未完整计算；当前仅展示原始资金费与价差，净收益待有效估值。':detailAligned?'资金费或四笔手续费尚未完整计算，单轮参考收益待计算。':<>当前数字仅为资金费扣四笔手续费{detailProfit.subtotalIsReference?'的参考小计':''}，尚未包含{detailFunding?'盘口开平损耗':'价差损益'}，完整合计待计算。</>}{spreadProgress(detail)}</p>}
        <details className="candidate-fold"><summary>{detailAligned?'入场模式与价格优势':detailFunding?'入场模式与盘口估计':'价差与历史依据'}</summary><div><DualAdvantage opportunity={detail.execution} candidate={detail} config={state.config} pricePresentation={detailPrice}/></div></details>
        {statistics&&<details className="candidate-fold candidate-source-details" open><summary>统计费率与盘口对照</summary><div><dl className="candidate-costs">
          <div><dt>资金费率统计来源</dt><dd>{sourceLabel(data.source)}</dd></div>
          <div><dt>统计原始费率 / 周期</dt><dd>{venues[statistics.longExchange]} {rate(statistics.longRate)} / {statistics.longIntervalHours}h · {venues[statistics.shortExchange]} {rate(statistics.shortRate)} / {statistics.shortIntervalHours}h</dd></div>
          <div><dt>统计更新时间</dt><dd>{date(statistics.updatedAt)} · {age(statistics.updatedAt,now)}</dd></div>
          <div><dt>核验方向</dt><dd>多 {venues[detail.longExchange]} / 空 {venues[detail.shortExchange]}{detail.directionChanged?'（已按新盘口更新方向）':''}</dd></div>
          <div><dt>多腿盘口采集</dt><dd>{date(detailQuoteAt(detail.longExchange,detail.execution?.longObservedAt)??0)}</dd></div>
          <div><dt>空腿盘口采集</dt><dd>{date(detailQuoteAt(detail.shortExchange,detail.execution?.shortObservedAt)??0)}</dd></div>
        </dl></div></details>}
        <details className="candidate-fold"><summary>收益与成本明细</summary><div>
          <dl className="candidate-costs">
            <div><dt>预计资金费收入</dt><dd className={tone(detailProfit.fundingUsd)}>{money(detailProfit.fundingUsd, true)}</dd></div>
            {!detailAligned&&<div><dt>{detailFunding?`盘口开平损耗 · ${bookCostScope(detail.execution)}`:'预计价差收益'}</dt><dd className={detailFunding?detailProfit.bookLossUsd!==null&&detailProfit.bookLossUsd>0?'negative':'':tone(detailProfit.spreadUsd)}>{detailFunding?detailProfit.bookLossUsd===null?'待计算':money(detailProfit.bookLossUsd):detailProfit.spreadUsd===null?'待计算':money(detailProfit.spreadUsd, true)}</dd></div>}
            <div><dt>{showRebates?'双腿开平净手续费（返佣后估算）':'双腿开平仓四笔手续费'}</dt><dd>{detailProfit.feesPending?'手续费待计算':'−'+money(detailProfit.feesUsd)}</dd></div>
            {detailFunding&&<div><dt>实际 IOC 限价净收益</dt><dd className={tone(detail.execution?.entryLimitNetUsd)}>{money(detailProfit.feesPending?null:detail.execution?.entryLimitNetUsd,true)}</dd></div>}
            <div><dt>资金费扣手续费（未计价差）</dt><dd className={tone(detailProfit.fundingAfterFeesUsd)}>{detailProfit.feesPending?'手续费待计算':money(detailProfit.fundingAfterFeesUsd, true)}</dd></div>
            <div className="candidate-cost-subtotal"><dt>{detailAligned?'单轮预计净收益（仅参考）':'合计预计净收益'}</dt><dd className={tone(netValue(detail))}>{detailProfit.feesPending?'手续费待计算':netValue(detail) === null ? detailAligned?'资金费待计算':detailFunding?'待核验盘口':'待计算价差' : money(netValue(detail), true)}</dd></div>
            {detailAligned&&<div><dt>按本轮假设预计回本</dt><dd>{detailProfit.feesPending?'手续费待计算':roundsEstimate(detail.execution?.breakEvenRounds)}</dd></div>}
          </dl>
          {detailFunding&&<BookCostBreakdown opportunity={detail.execution}/>}<p className="candidate-detail-explanation">{detailAligned?`完整目标单轮参考收益＝资金费－四笔手续费，不计盘口损耗与未实现价差。负值不单独阻挡手动同向开仓；自动开仓另按两条路径筛选。资金费与手续费参考已知即可参与收益统计，开仓仍须核验本批盘口、实际 IOC 价格优势、数量与账户。实际收益按成交、手续费与资金费账单核算。`:detailFunding?'完整合计＝资金费－盘口开平损耗－四笔手续费，手续费只扣一次。按基差不变估计，以当前两腿盘口计算开平损耗，不依赖历史样本；持有期间基差变化会影响实际收益。盘口未就绪时仅显示参考小计。':'完整合计＝资金费＋预计价差收益－四笔手续费，手续费只扣一次。价差未就绪时仅显示已知资金费扣费小计，不将未知价差视为零。价差采用历史退出盘口估计；实际损益按成交价格、手续费和资金费账单计算。'}{detailProfit.feesSource==='reference'?' 手续费按官方本地参考费率估算，下单前核对账户实际费率。':detailProfit.feesSource==='exchange'?' 手续费按交易所账户实际费率估算。':''}</p>
        </div></details>
        <details className="candidate-fold"><summary>结算时间与数据新鲜度</summary><div><div className="candidate-detail-schedule"><div><span>多腿原费率 / 周期</span><b>{rate(detail.longRate)} / {detail.longIntervalHours}h</b></div><div><span>空腿原费率 / 周期</span><b>{rate(detail.shortRate)} / {detail.shortIntervalHours}h</b></div><div><span>本轮结算次数</span><b>多 {detail.longFundingCount} 次 / 空 {detail.shortFundingCount} 次</b></div><div><span>下一次结算</span><b>{date(detail.nextFundingTime)}</b></div><div><span>最早一腿数据更新</span><b>{date(detail.updatedAt)} · {age(detail.updatedAt, now)}</b></div><div><span>统计时效上限</span><b>{Math.ceil(data.maxAgeMs / 1000)} 秒</b></div></div></div></details>
        <details className="candidate-fold"><summary>最新公共盘口（参考）</summary><div><p className="book-cost-times">此处是页面最新盘口，可能晚于估算采样；成本复核使用上方估算成交均价与时间。</p><div className="candidate-legs"><LegDetails label="做多盘口" exchange={detail.longExchange} snapshot={state.snapshots.find(snapshot => snapshot.base === detail.base && snapshot.exchange === detail.longExchange)}/><LegDetails label="做空盘口" exchange={detail.shortExchange} snapshot={state.snapshots.find(snapshot => snapshot.base === detail.base && snapshot.exchange === detail.shortExchange)}/></div></div></details>
      </div>
      <div className="candidate-detail-action"><span>{coinBlock(detail) || (entryWait(detail)?`等待入场窗口：${waitingCaption(detail)}；后台继续监测，届时仍需资金费与价格优势。`:tradable(detail) ? '手动可提交；点击后仍检查最新盘口、合约模式、杠杆与余额，不启动自动策略。' : '后台会自动核验公共行情；下方可手动重试，满足条件后开放手动开仓。')}</span>{action(detail)}</div>
    </section></div>}
  </section>;
}
