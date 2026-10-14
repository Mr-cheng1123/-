import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronRight, LoaderCircle, Play, RefreshCw, ShieldAlert, Wallet, X } from 'lucide-react';
import type { ExchangeId, LiveCoinExclusion } from '../../src/shared/types';
import {AUTOMATIC_ENTRY_RULE} from './automatic-entry-presentation';
import './live-start-dialog.css';

const venues: Record<ExchangeId, string> = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX', gate: 'Gate', bitget: 'Bitget' };
interface PreflightAccount { exchange: ExchangeId; credentialsConfigured: boolean; status: 'ready' | 'not_configured' | 'insufficient' | 'error'; freeUsd?: number; requiredUsd: number; message: string }
interface Preflight { canStart: boolean; canRecover?: boolean; recoveryBlockers?: string[]; executionUnlocked: boolean; orderNotionalUsd: number; bitgetNewSymbolMarginMode?: 'crossed' | 'isolated'; accounts: PreflightAccount[]; blockers: string[]; excludedCoins?: LiveCoinExclusion[] }
interface Props { orderNotionalUsd: number; onClose: () => void; onStarted: () => Promise<void> | void; onRecovered?: () => Promise<void> | void; onConfigure?: () => void }
const amount = (value?: number) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—';
const labels = { ready: '条件通过', not_configured: '未配置', insufficient: '合约保证金不足', error: '检查未通过' };
const safeMessage = (value: string) => value.replace(/((?:api[_-]?key|secret|signature|passphrase|token|authorization)["']?\s*[:=]\s*["']?)[^\s,"'&}]+/gi, '$1[已隐藏]').slice(0, 500);

export default function LiveStartDialog({ orderNotionalUsd, onClose, onStarted, onRecovered, onConfigure }: Props) {
  const [data, setData] = useState<Preflight | null>(null), [checkedAt, setCheckedAt] = useState(0);
  const [checking, setChecking] = useState(false), [starting, setStarting] = useState(false);
  const [pendingAction, setPendingAction] = useState<'start' | 'recover' | null>(null);
  const [error, setError] = useState('');
  const checkingRef = useRef<AbortController | null>(null), startingRef = useRef(false), mounted = useRef(true);
  const checkVersion = useRef(0);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  const check = async () => {
    if (checkingRef.current || startingRef.current) return;
    setChecking(true); setError(''); setCheckedAt(0);
    const controller = new AbortController(); checkingRef.current = controller;
    const version = ++checkVersion.current;
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch('/api/trading/preflight', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'funding-arb' }, body: '{}', signal: controller.signal });
      const result = await response.json() as Preflight & { error?: string };
      if (!response.ok) throw new Error(result.error || '启动检查未完成，请稍后重查。');
      if (!Array.isArray(result.accounts) || !Array.isArray(result.blockers) || typeof result.canStart !== 'boolean' || !(result.orderNotionalUsd > 0)) throw new Error('启动检查结果不完整，请重新检查。');
      if (mounted.current && checkVersion.current === version) { setData(result); setCheckedAt(Date.now()); setError(''); }
    } catch (err) { if (mounted.current && checkVersion.current === version) setError((err as Error).name === 'AbortError' ? '启动检查等待超过 30 秒，请重新检查。' : safeMessage((err as Error).message)); }
    finally { clearTimeout(timeout); if (checkingRef.current === controller) checkingRef.current = null; if (mounted.current && checkVersion.current === version) setChecking(false); }
  };
  useEffect(() => {
    mounted.current = true;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !startingRef.current) onCloseRef.current(); };
    document.addEventListener('keydown', escape);
    void check();
    return () => { mounted.current = false; checkVersion.current += 1; checkingRef.current?.abort(); checkingRef.current = null; document.removeEventListener('keydown', escape); document.body.style.overflow = previousOverflow; };
  }, [orderNotionalUsd]);
  // This read-only result is a preview. The start/recover endpoint checks the
  // account again, so a browser countdown must not strand the action button.
  const fresh = checkedAt > 0;
  const canStart = !!data?.canStart && fresh && !checking && !starting && !error;
  const canRecover = !!data?.canRecover && fresh && !checking && !starting && !error;
  const submit = async (action: 'start' | 'recover') => {
    if (!(action === 'start' ? canStart : canRecover) || startingRef.current) return;
    startingRef.current = true; setStarting(true); setPendingAction(action); setError('');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(`/api/trading/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'funding-arb' }, body: JSON.stringify({ acknowledgement: action === 'start' ? 'START_LIVE_TRADING' : 'RESTORE_LIVE_MANAGEMENT' }), signal: controller.signal });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || '服务端重新检查未通过，请查看账户状态后重查。');
      try { if (action === 'recover') await onRecovered?.(); else await onStarted(); } catch { /* Do not resubmit an accepted operation because refreshing the view failed. */ }
      if (mounted.current) onClose();
    } catch (err) {
      if (mounted.current) { setError((err as Error).name === 'AbortError' ? '请求结果尚未确认。请检查策略状态后再重查，不要重复提交。' : safeMessage((err as Error).message)); setCheckedAt(0); }
    } finally { clearTimeout(timeout); startingRef.current = false; if (mounted.current) { setStarting(false); setPendingAction(null); } }
  };
  const notional = data?.orderNotionalUsd ?? orderNotionalUsd;
  const readyCount = data?.accounts.filter(account => account.status === 'ready').length || 0;
  const readyAccounts = data?.accounts.filter(account => account.status === 'ready') || [];
  const hasBitget = data?.accounts.some(account => account.exchange === 'bitget' && account.credentialsConfigured);
  return <div className="live-start-backdrop" onClick={() => !starting && onClose()}>
    <section className="panel live-start-dialog" role="dialog" aria-modal="true" aria-labelledby="live-start-title" onClick={event => event.stopPropagation()}>
      <div className="section-title"><div><h2 id="live-start-title">启动实盘策略</h2><p>至少两家账户可用，已有持仓只跳过对应币种。</p></div><button className="icon-btn" aria-label="关闭启动检查" disabled={starting} onClick={onClose}><X size={19}/></button></div>
      <div className="live-start-content" tabIndex={0} aria-label="启动检查内容">
        <p className="live-start-margin-policy" data-testid="automatic-entry-rule">{AUTOMATIC_ENTRY_RULE}</p>
        <div className="live-start-summary"><span><Wallet size={17}/>每腿目标 <b>{amount(notional)} U</b></span><span><CheckCircle2 size={16}/>{checking ? '正在检查账户' : data && fresh ? `${readyCount} 家账户条件通过` : '等待账户检查'}</span></div>
        <div className="live-start-check-toolbar"><div className="live-start-ready-venues" aria-label="可用交易所">{fresh && !checking ? readyAccounts.map(account => <span key={account.exchange}>{venues[account.exchange]}</span>) : <span>{checking ? '检查中…' : '请重新检查'}</span>}</div><button className="btn small-btn" disabled={checking || starting} onClick={() => void check()}>{checking ? <LoaderCircle className="spin" size={13}/> : <RefreshCw size={13}/>} {checking ? '检查中' : '重新检查'}</button></div>
        {hasBitget && data?.bitgetNewSymbolMarginMode && <p className="live-start-margin-policy">Bitget 新合约：<b>{data.bitgetNewSymbolMarginMode === 'crossed' ? '全仓，共享账户保证金' : '逐仓'}</b></p>}
        {error && <p className="live-start-error" role="alert"><ShieldAlert size={15}/>{error}</p>}
        {!!data?.blockers.length && <div className="live-start-blockers"><b>当前未满足</b><ul>{data.blockers.map((blocker, index) => <li key={index}>{safeMessage(blocker)}</li>)}</ul></div>}
        {!!data?.excludedCoins?.length && <details className="live-start-exclusions"><summary>跳过币种：<b>{data.excludedCoins.map(item => item.base).join('、')}</b><small>不影响启动</small></summary><p>已有持仓或待核对订单的币种不重复开仓。</p><ul>{data.excludedCoins.map(item => <li key={item.base}><strong>{item.base}</strong><span>{item.reasons.map(safeMessage).join('；')}</span></li>)}</ul></details>}
        {data && <details className="live-start-details"><summary>账户明细<small>{readyCount} / {data.accounts.length} 可用</small></summary><p className="live-start-details-note">只读取合约账户，不下单；现货余额不计入保证金。</p><div className="live-start-accounts">{data.accounts.map(account => <article key={account.exchange}><div><b>{venues[account.exchange]}</b><span className={`badge ${!fresh || checking ? 'neutral' : account.status === 'ready' ? 'green' : account.status === 'not_configured' ? 'neutral' : 'orange'}`}>{checking ? '正在重查' : !fresh ? '等待重新检查' : labels[account.status]}</span></div><dl><div><dt>合约可用</dt><dd>{fresh && !checking ? amount(account.freeUsd) : '—'}<small> U</small></dd></div><div><dt>本次所需</dt><dd>{amount(account.requiredUsd)}<small> U</small></dd></div></dl><p>{safeMessage(account.message)}</p></article>)}</div>{hasBitget && <p className="live-start-details-note">新合约保证金设置仅用于尚无配置且无仓无挂单的合约，已有设置保留。</p>}{onConfigure && <button className="text-btn live-start-configure" disabled={starting} onClick={onConfigure}>前往配置账户 <ChevronRight size={14}/></button>}</details>}
        {(data?.canRecover || data?.recoveryBlockers !== undefined) && <details className="live-start-recovery"><summary>仅管理已有持仓</summary><p>恢复账户对账和持仓管理，自动开仓保持关闭。</p>{!!data.recoveryBlockers?.length && <ul>{data.recoveryBlockers.map((blocker, index) => <li key={index}>{safeMessage(blocker)}</li>)}</ul>}<button className="btn small-btn" disabled={!canRecover} onClick={() => void submit('recover')}>{pendingAction === 'recover' ? <LoaderCircle className="spin" size={14}/> : <RefreshCw size={14}/>} {pendingAction === 'recover' ? '正在恢复管理…' : '仅恢复持仓管理'}</button></details>}
      </div>
      <div className="live-start-actions">
      <p className="live-start-execution-note">点击启动后，按每腿 <b>{amount(notional)} U</b> 自动提交符合条件的实盘订单。服务端会重新读取账户。</p>
      <div className="live-start-footer"><button className="btn" disabled={starting} onClick={onClose}>取消</button><button className="btn primary" disabled={!canStart} onClick={() => void submit('start')}>{pendingAction === 'start' ? <LoaderCircle className="spin" size={16}/> : <Play size={16}/>} {pendingAction === 'start' ? '正在检查并启动…' : '启动实盘自动策略'}</button></div>
      </div>
    </section>
  </div>;
}
