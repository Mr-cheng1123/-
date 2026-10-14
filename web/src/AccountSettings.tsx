import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, KeyRound, LoaderCircle, RefreshCw, Shield, ShieldAlert, Wallet } from 'lucide-react';
import type { AppState, ExchangeId, LiveAuthorizationReport, LiveExchangeReadiness } from '../../src/shared/types';
import {accountExecutionPermission} from './account-execution-permission';
import './account-settings.css';

const exchanges: ExchangeId[] = ['binance', 'bybit', 'okx', 'gate', 'bitget'];
const names: Record<ExchangeId, string> = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX', gate: 'Gate', bitget: 'Bitget' };
type AccountStatus = 'not_configured' | 'unchecked' | 'checking' | 'connected' | 'error';
interface AccountView { exchange: ExchangeId; credentialsConfigured: boolean; status: AccountStatus; message?: string; checkedAt?: number; freeUsd?: number; equityUsd?: number; positionCount?: number; balanceScope?: 'usdt_futures' | 'unified_usdt'; accountType?: 'classic' | 'unified'; accountMode?: string; positionMode?: string; executionSupported?: boolean; usdtAvailableUsd?: number; marginAvailableUsd?: number; isolatedAvailableUsd?: number; spotAvailableUsd?: number; spotStatus?: 'available' | 'unavailable'; warnings?: string[] }
interface AccountsResponse { exchanges: AccountView[]; executionUnlocked: boolean }
interface Credentials { apiKey: string; apiSecret: string; passphrase?: string }
const labels: Record<AccountStatus, string> = { not_configured: '未配置', unchecked: '待检查', checking: '检查中', connected: '只读已连接', error: '连接异常' };
const money = (value?: number) => value === undefined || !Number.isFinite(value) ? '—' : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usdt = (value?: number) => value === undefined || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (value?: number) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '尚未检查';
const safeMessage = (value?: string) => value?.replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[已隐藏]@').replace(/Bearer\s+[^\s,]+/gi, 'Bearer [已隐藏]').replace(/((?:api[_-]?key|secret|signature|passphrase|token|authorization)["']?\s*[:=]\s*["']?)[^\s,"'&}]+/gi, '$1[已隐藏]').slice(0, 240);
const accountModes: Record<string, string> = { isolated: '逐仓', basic: '基础', advanced: '高级', delta: 'Delta 中性', REGULAR_MARGIN: '全仓', ISOLATED_MARGIN: '逐仓', PORTFOLIO_MARGIN: '组合保证金' };
const positionModes: Record<string, string> = { one_way_mode: '单向持仓', hedge_mode: '双向持仓' };
const modeLabel = (value: string | undefined, labels: Record<string, string>) => value ? labels[value] || safeMessage(value) : '待确认';

function AccountCard({ exchange, account, supported, permission, readinessKnown, loading, stale, now, onSave, onCheck }: { exchange: ExchangeId; account?: AccountView; supported?: boolean; permission?:LiveExchangeReadiness; readinessKnown:boolean; loading: boolean; stale: boolean; now: number; onSave: (exchange: ExchangeId, credentials: Credentials) => Promise<void>; onCheck: (exchange: ExchangeId) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState(''), [apiSecret, setApiSecret] = useState(''), [passphrase, setPassphrase] = useState('');
  const [operation, setOperation] = useState<'save' | 'check' | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const requiresPassphrase = exchange === 'okx' || exchange === 'bitget';
  const busy = loading || operation !== null || !stale && account?.status === 'checking';
  const checking = operation === 'check' || !stale && account?.status === 'checking';
  const bitgetUnified = exchange === 'bitget' && (account?.balanceScope === 'unified_usdt' || account?.accountType === 'unified');
  const unifiedAccount = bitgetUnified || exchange === 'bybit' && (account?.balanceScope === 'unified_usdt' || account?.accountType === 'unified');
  const bitgetFutures = exchange === 'bitget' && !bitgetUnified && account?.balanceScope === 'usdt_futures';
  const balancesFresh = !stale && account?.status === 'connected' && !!account.checkedAt && account.checkedAt <= now + 5000 && now - account.checkedAt <= 60000;
  const expired = account?.status === 'connected' && !balancesFresh;
  const displayedStatus = expired || stale && account?.status === 'checking' ? 'unchecked' : account?.status;
  const clear = () => { setApiKey(''); setApiSecret(''); setPassphrase(''); };
  const executionPermission=accountExecutionPermission(permission,readinessKnown);
  const save = async () => {
    if (busy || !apiKey.trim() || !apiSecret.trim() || requiresPassphrase && !passphrase.trim()) return;
    setOperation('save'); setNotice(null);
    try {
      await onSave(exchange, { apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), ...(requiresPassphrase ? { passphrase: passphrase.trim() } : {}) });
      clear(); setEditing(false); setNotice({ error: false, text: '凭据已保存，新开仓已暂停；请重新检查该交易所。其他账户的持仓管理保留，无需重启软件。' });
    } catch (err) { setNotice({ error: true, text: safeMessage((err as Error).message) || '保存未完成。请确认本地服务可用后重试。' }); }
    finally { setOperation(null); }
  };
  const check = async () => {
    if (busy || !account?.credentialsConfigured || supported === false) return;
    setOperation('check'); setNotice(null);
    try { await onCheck(exchange); setNotice({ error: false, text: '只读检查已完成，连接结果见上方状态。' }); }
    catch (err) { setNotice({ error: true, text: safeMessage((err as Error).message) || '连接检查未完成，请查看账户状态后重试。此次检查不提交订单。' }); }
    finally { setOperation(null); }
  };
  return <article className="account-card">
    <div className="account-card-heading"><h3>{names[exchange]}</h3><span className={`badge ${displayedStatus === 'connected' ? 'green' : displayedStatus === 'error' ? 'red' : displayedStatus === 'checking' ? 'orange' : 'neutral'}`}>{operation === 'check' ? '检查中' : displayedStatus ? labels[displayedStatus] : '等待账户状态'}</span></div>
    <div className="account-credential-status"><KeyRound size={12}/>{account?.credentialsConfigured ? '凭据已配置 · 不回显' : account ? '尚未保存交易凭据' : '正在读取配置状态'}{supported === false && <span>仅行情 · 暂不支持交易</span>}</div>
    <div className={`account-execution-permission ${executionPermission.authorized?'positive':''}`} data-exchange={exchange}><Shield size={12}/><span>软件执行许可：<b>{executionPermission.label}</b></span></div>
    {unifiedAccount ? <><div className="account-unified-mode"><b>统一账户 UTA</b><span>账户模式：{modeLabel(account.accountMode, accountModes)}</span><span>持仓模式：{exchange === 'bybit' && !account.positionMode ? '按合约读取' : modeLabel(account.positionMode, positionModes)}</span></div><dl className="account-balances unified-balances"><div><dt>USDT 可用</dt><dd>{balancesFresh ? usdt(account.usdtAvailableUsd) : '—'}<small>USDT</small></dd></div><div><dt>账户可用保证金</dt><dd>{balancesFresh ? money(account.marginAvailableUsd) : '—'}</dd></div><div><dt>账户总权益</dt><dd>{balancesFresh ? money(account.equityUsd) : '—'}</dd></div><div><dt>持仓数量</dt><dd>{balancesFresh ? account.positionCount ?? '—' : '—'}</dd></div></dl><p className="account-unified-note">{['isolated', 'ISOLATED_MARGIN'].includes(account.accountMode || '') ? '逐仓模式按可用 USDT 核验开仓额度。' : ['basic', 'advanced', 'delta', 'REGULAR_MARGIN', 'PORTFOLIO_MARGIN'].includes(account.accountMode || '') ? '全仓模式按可用 USDT 与账户可用保证金中的较小值核验开仓额度。' : '开仓额度需结合账户模式与可用保证金核验。'}账户总权益与可用保证金以 USD 计。</p>{account.executionSupported === false && <p className="account-execution-unavailable">当前账户模式不满足本策略执行条件，余额可只读查看。</p>}</> : <dl className="account-balances"><div><dt>{bitgetFutures ? 'USDT 合约可用' : '可用余额'}</dt><dd>{balancesFresh ? bitgetFutures ? usdt(account.freeUsd) : money(account.freeUsd) : '—'}</dd></div><div><dt>{bitgetFutures ? '合约权益' : '账户权益'}</dt><dd>{balancesFresh ? bitgetFutures ? usdt(account.equityUsd) : money(account.equityUsd) : '—'}</dd></div><div><dt>持仓数量</dt><dd>{balancesFresh ? account.positionCount ?? '—' : '—'}</dd></div></dl>}
    {bitgetFutures && <div className="account-balance-split"><dl className="account-balances account-additional-balances"><div><dt>现货可用 USDT</dt><dd>{balancesFresh && account.spotStatus === 'available' ? usdt(account.spotAvailableUsd) : '—'}</dd></div><div><dt>逐仓可开仓 USDT</dt><dd>{balancesFresh ? usdt(account.isolatedAvailableUsd) : '—'}</dd></div></dl><p className="account-balance-scope-note">现货余额不计入合约开仓保证金。</p>{balancesFresh && account.spotStatus === 'unavailable' && <p className="account-spot-unavailable"><ShieldAlert size={12}/>仅现货查询不可用；合约余额仍单独显示。</p>}</div>}
    <div className="account-last-check"><Wallet size={11}/>只读检查 · {date(account?.checkedAt)}</div>
    {expired ? <p className="account-server-message">账户检查结果已过期，请重新检查；旧余额不作为当前余额。</p> : account?.message && <p className={`account-server-message ${account.status === 'error' ? 'negative' : ''}`}>{safeMessage(account.message)}</p>}
    {!!account?.warnings?.length && <ul className="account-balance-warnings">{account.warnings.map((warning, index) => <li key={index}>{safeMessage(warning)}</li>)}</ul>}
    <div className="account-card-actions"><button className="btn small-btn" type="button" disabled={busy} aria-expanded={editing} onClick={() => { if (editing) clear(); setEditing(value => !value); setNotice(null); }}><KeyRound size={12}/>{editing ? '收起配置' : account?.credentialsConfigured ? '更新凭据' : '配置凭据'}<ChevronDown size={11}/></button><button className="btn small-btn" type="button" disabled={busy || !account?.credentialsConfigured || supported === false} onClick={() => void check()}>{checking ? <LoaderCircle className="spin" size={12}/> : <Shield size={12}/>}检查连接</button></div>
    {editing && <form className="account-credential-form" autoComplete="off" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label><span>API Key</span><input type="password" required autoComplete="new-password" spellCheck={false} autoCapitalize="none" aria-label={`${names[exchange]} API Key`} value={apiKey} disabled={busy} onChange={event => setApiKey(event.target.value)}/></label>
      <label><span>API Secret</span><input type="password" required autoComplete="new-password" spellCheck={false} autoCapitalize="none" aria-label={`${names[exchange]} API Secret`} value={apiSecret} disabled={busy} onChange={event => setApiSecret(event.target.value)}/></label>
      {requiresPassphrase && <label><span>Passphrase</span><input type="password" required autoComplete="new-password" spellCheck={false} autoCapitalize="none" aria-label={`${names[exchange]} Passphrase`} value={passphrase} disabled={busy} onChange={event => setPassphrase(event.target.value)}/></label>}
      <small>填入完整凭据，已有密钥不会回填。保存会暂停新开仓，该所需重新检查；其他账户管理保留，无需重启软件。</small><button className="btn primary small-btn" type="submit" disabled={busy || !apiKey.trim() || !apiSecret.trim() || requiresPassphrase && !passphrase.trim()}>{operation === 'save' ? <LoaderCircle className="spin" size={12}/> : <Check size={12}/>}保存凭据</button>
    </form>}
    {notice && <p className={`account-notice ${notice.error ? 'negative' : 'positive'}`} role="status">{notice.text}</p>}
  </article>;
}

export default function AccountSettings({ readiness, onUpdated }: { readiness?: AppState['liveReadiness']; onUpdated?: () => void }) {
  const [data, setData] = useState<AccountsResponse | null>(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [authorizing,setAuthorizing]=useState(false);
  const [authorizationNotice,setAuthorizationNotice]=useState<{text:string;error:boolean;checkedAt:number}|null>(null);
  const [now, setNow] = useState(Date.now());
  const requestRef = useRef<Promise<void> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const reloadRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(()=>{if(!authorizationNotice)return;const timer=setTimeout(()=>setAuthorizationNotice(null),30000);return()=>clearTimeout(timer);},[authorizationNotice]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    mounted.current = true;
    const load = async () => {
      if (requestRef.current) return requestRef.current;
      const controller = new AbortController(); controllerRef.current = controller;
      const timeout = setTimeout(() => controller.abort(), 8000);
      if (alive) setLoading(true);
      const task = (async () => {
        try {
          const response = await fetch('/api/accounts', { cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error('账户配置状态暂不可用，请确认本地服务已更新并启动。');
          const next = await response.json() as AccountsResponse;
          if (!Array.isArray(next.exchanges)) throw new Error('账户状态格式无效，请等待服务恢复。');
          if (alive) { setData(next); setError(''); }
        } catch (err) { if (alive) setError((err as Error).name === 'AbortError' ? '账户状态读取超时，稍后自动重试。' : '账户配置状态暂不可用，请确认本地服务已启动。'); }
        finally { clearTimeout(timeout); if (alive) { requestRef.current = null; setLoading(false); } }
      })();
      requestRef.current = task;
      return task;
    };
    reloadRef.current = load;
    const poll = async () => { await load(); if (alive) timer = setTimeout(poll, 5000); };
    void poll();
    return () => { alive = false; mounted.current = false; controllerRef.current?.abort(); requestRef.current = null; clearTimeout(timer); reloadRef.current = async () => {}; };
  }, []);
  const mutate = async (exchange: ExchangeId, type: 'credentials' | 'check', credentials?: Credentials) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), type === 'check' ? 30000 : 15000);
    try {
      const response = await fetch(`/api/accounts/${exchange}/${type}`, { method: type === 'credentials' ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'funding-arb' }, body: JSON.stringify(credentials || {}), signal: controller.signal });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        let message = typeof result.error === 'string' ? result.error : '账户操作未完成，请稍后重试。';
        for (const secret of Object.values(credentials || {})) if (secret) message = message.replaceAll(secret, '[已隐藏]');
        throw new Error(safeMessage(message) || '账户操作未完成，请稍后重试。');
      }
      const result = await response.json().catch(() => null) as { account?: AccountView; executionUnlocked?: boolean } | null;
      if (mounted.current && result?.account?.exchange === exchange) {
        setData(current => current ? { ...current, executionUnlocked: result.executionUnlocked ?? current.executionUnlocked,
          exchanges: current.exchanges.map(account => account.exchange === exchange ? result.account! : account) } : current);
        onUpdated?.();
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new Error('账户操作等待超时，请刷新状态确认结果后重试。');
      throw err;
    } finally {
      clearTimeout(timeout);
      if (mounted.current) void (async () => { await requestRef.current; if (mounted.current) { await reloadRef.current(); onUpdated?.(); } })();
    }
  };
  const authorize=async()=>{
    if(authorizing)return;
    setAuthorizing(true);setAuthorizationNotice(null);
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),60000);
    try{
      const response=await fetch('/api/trading/authorize',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'funding-arb'},body:JSON.stringify({acknowledgement:'RECHECK_LIVE_AUTHORIZATION'}),signal:controller.signal});
      const result=await response.json() as LiveAuthorizationReport&{error?:string};
      if(!response.ok)throw new Error(safeMessage(result.error)||'执行许可核对未完成，请查看账户状态。');
      if(!Array.isArray(result.accounts)||!Array.isArray(result.authorizedExchanges)||!Number.isFinite(result.checkedAt))throw new Error('执行许可核对结果无效，请刷新账户状态。');
      const failures=result.accounts.filter(account=>account.credentialsConfigured&&account.status!=='ready'&&account.status!=='insufficient'&&account.status!=='disabled');
      const granted=result.authorizedExchanges.map(exchange=>names[exchange]).join(' / ')||'暂无';
      const details=result.accounts.map(account=>`${names[account.exchange]}：${account.status==='not_configured'?'未配置':account.status==='disabled'?'未启用':account.status==='insufficient'&&account.executionAuthorized?'本次读取通过，开仓保证金不足，减仓许可保留':account.status==='ready'&&account.executionAuthorized?'本次核对通过':`读取未通过（${safeMessage(account.message)||'请查看账户状态'}）`}`).join('；');
      if(mounted.current)setAuthorizationNotice({checkedAt:result.checkedAt,error:failures.length>0,text:`本次执行许可核对完成，已授权：${granted}。${details}。自动策略${result.autoEnabled?'保持开启':'保持关闭'}；本次核对不下单，具体合约参数在提交前另行检查。`});
    }catch(err){if(mounted.current)setAuthorizationNotice({checkedAt:Date.now(),error:true,text:(err as Error).name==='AbortError'?'执行许可核对等待超时，请刷新当前授权状态确认结果；本次操作不提交订单。':safeMessage((err as Error).message)||'执行许可核对未完成。'});}
    finally{
      clearTimeout(timeout);if(mounted.current){setAuthorizing(false);onUpdated?.();await requestRef.current;if(mounted.current){await reloadRef.current();onUpdated?.();}}
    }
  };
  const authorizedNames=readiness?.exchanges.filter(account=>account.executionAuthorized===true).map(account=>names[account.exchange]).join(' / ');
  return <section className="panel account-settings" aria-label="本机交易账户配置"><div className="section-title"><div><h2>交易账户 · 本机配置</h2><p>凭据保存在本机 .env，保存后不回显；保存和检查不会自动启动交易。</p></div><div className="account-settings-actions"><button className="btn small-btn" type="button" disabled={authorizing||!data} onClick={()=>void authorize()}>{authorizing?<LoaderCircle size={12} className="spin"/>:<Shield size={12}/>}重新核对实盘授权</button><button className="btn small-btn" type="button" disabled={loading} onClick={() => void reloadRef.current()}><RefreshCw size={12} className={loading ? 'spin' : ''}/>刷新状态</button></div></div>
    <div className="account-settings-note"><Shield size={16}/><p>“只读已连接”表示余额与持仓读取成功。软件执行许可按交易所分别核对，不代表具体合约参数已经通过检查。<span className="account-authorization-summary">当前会话已授权：{readiness?authorizedNames||'暂无':'正在同步'}。</span>“重新核对实盘授权”只核对已配置且启用的账户，不启动自动策略，也不提交订单。保存该所凭据会暂停新开仓，该所需重新检查；其他账户的持仓管理保留。仅该所存在持仓或未确认订单时，不能更换该所凭据。</p></div>
    {authorizationNotice&&<div className={`account-authorization-notice ${authorizationNotice.error?'negative':'positive'}`} role="status"><span>本次核对 {date(authorizationNotice.checkedAt)}：{authorizationNotice.text}</span></div>}
    {error && <div className="account-fetch-error" role="status"><ShieldAlert size={14}/><span>{error}{data ? ' 下方保留上次读取的账户状态。' : ''}</span></div>}
    <div className="account-settings-grid">{exchanges.map(exchange => <AccountCard key={exchange} exchange={exchange} account={data?.exchanges.find(account => account.exchange === exchange)} permission={readiness?.exchanges.find(account=>account.exchange===exchange)} readinessKnown={readiness!==undefined} supported={readiness?.exchanges.find(account => account.exchange === exchange)?.supported} loading={authorizing||!data && !error} stale={!!error} now={now} onSave={(id, credentials) => mutate(id, 'credentials', credentials)} onCheck={id => mutate(id, 'check')}/>)}</div>
  </section>;
}
