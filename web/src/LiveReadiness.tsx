import { Shield, ShieldAlert } from 'lucide-react';
import type { AppState, ExchangeId } from '../../src/shared/types';

const venues: Record<ExchangeId, string> = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX', gate: 'Gate', bitget: 'Bitget' };

export const liveOrdersLocked = (state: AppState) => state.config.mode === 'live' && (!state.liveUnlocked || !state.liveReadiness?.unlocked);
export const liveEntriesLocked = (state: AppState) => state.config.mode === 'live' && (liveOrdersLocked(state) || !state.liveReadiness?.ready);

export default function LiveReadiness({ state, onStartCheck }: { state: AppState; onStartCheck?: () => void }) {
  if (state.config.mode !== 'live') return null;
  const readiness = state.liveReadiness;
  const locked = liveEntriesLocked(state);
  const readOnly = liveOrdersLocked(state);
  const exchanges = readiness?.exchanges || state.config.exchanges.map(exchange => ({ exchange, supported: undefined, credentialsConfigured: false }));
  const configured = exchanges.filter(exchange => exchange.supported !== false && exchange.credentialsConfigured).length;
  return <section className={`panel live-readiness ${locked ? 'locked' : 'ready'}`} aria-label="实盘账户连接状态">
    <div className="live-readiness-heading">{locked ? <ShieldAlert size={19}/> : <Shield size={19}/>}<div><h2>{locked ? !readOnly ? '可用账户不足 · 自动开仓暂停' : configured ? '实盘手动模式 · 自动策略未启用' : '实盘准备 · 尚未连接交易账户' : '实盘账户已就绪'}</h2><p>{readOnly ? '两腿账户、合约和盘口就绪后，可直接点击实盘开仓；该点击只处理所选组合，自动策略由启动按钮单独启用。' : locked ? '手动开仓按所选两腿条件单独检查；已有持仓可继续对账和管理。展开下方查看具体账户原因。' : '使用可用账户交易；提交订单时读取余额与最新盘口。'}</p></div><span className={`badge ${locked ? 'orange' : 'green'}`}>{locked ? readOnly ? '手动 / 自动未启用' : '自动开仓暂停' : '账户可用'}</span></div>
    <div className="live-account-grid">{exchanges.map(exchange => <div className="live-account" key={exchange.exchange}><b>{venues[exchange.exchange]}</b><span className={exchange.supported === false ? 'market-only' : exchange.credentialsConfigured ? 'configured' : 'missing'}>{exchange.supported === false ? '仅行情 · 不支持下单' : !readiness ? '账户状态待确认' : exchange.credentialsConfigured ? '凭据已配置' : '交易凭据未配置'}</span></div>)}</div>
    {readOnly && <p className="live-config-note">已保存凭据不会回显。只读检查用于显示可开仓条件；点击实盘开仓后才验证并授权该笔双腿执行。</p>}
    {onStartCheck && <button className="btn small-btn live-readiness-start" onClick={onStartCheck}>检查账户并启动</button>}
    {!!readiness?.excludedCoins?.length && <p className="live-config-note">仅跳过币种：<b>{readiness.excludedCoins.map(item => item.base).join('、')}</b>。已有持仓或待核对订单仅限制对应币种，其他币种可继续使用该交易所。</p>}
    {!!readiness?.reasons.length && <details className="live-readiness-reasons"><summary>查看未就绪原因（{readiness.reasons.length}）</summary><ul>{readiness.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details>}
  </section>;
}
