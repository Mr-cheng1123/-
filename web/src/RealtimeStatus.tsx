import {Activity,Clock3,Radio,Zap} from 'lucide-react';
import type {RealtimeStatus as StreamStatus} from '../../src/shared/realtime';
import type {ExchangeId} from '../../src/shared/types';

const venues:Record<ExchangeId,string>={binance:'Binance',bybit:'Bybit',okx:'OKX',gate:'Gate',bitget:'Bitget'};
const stateLabel={online:'在线',connecting:'连接／等待事件',degraded:'回退核对',offline:'断开',disabled:'未启用'};
const duration=(value:number|undefined,samples:number)=>samples>0&&value!==undefined&&Number.isFinite(value)?`${Math.round(value)} ms`:'尚未测量';
const age=(at:number|undefined,now:number)=>at&&Number.isFinite(at)?`${Math.max(0,now-at)<1000?`${Math.max(0,Math.round(now-at))} ms`:`${(Math.max(0,now-at)/1000).toFixed(1)} 秒`}前`:'尚未收到';

/** Observability only. None of these indicators grants permission to submit an order. */
export default function RealtimeStatus({status,autoEnabled,live,now=Date.now()}:{status?:StreamStatus;autoEnabled:boolean;live:boolean;now?:number}){
  if(!status)return null;
  const publicStreams=status.streams.filter(stream=>stream.kind==='public');
  const privateStreams=status.streams.filter(stream=>stream.kind==='private'&&stream.state!=='disabled');
  const publicOnline=publicStreams.filter(stream=>stream.state==='online'||stream.state==='degraded'&&(stream.freshBooks??0)>0).length;
  const privateOnline=privateStreams.filter(stream=>stream.state==='online').length;
  const subscriptions=publicStreams.reduce((count,stream)=>count+stream.subscriptions,0);
  const freshBooks=publicStreams.some(stream=>stream.freshBooks===undefined)?undefined:publicStreams.reduce((count,stream)=>count+(stream.freshBooks??0),0);
  const fallback=!status.enabled||publicOnline<publicStreams.length;
  const samples=status.latency.samples;
  const activeAuto=live&&status.enabled&&status.eventTriggered&&autoEnabled;
  return <details className="realtime-status">
    <summary>
      <span className="realtime-title"><Radio size={13}/><b>实时通道</b></span>
      <span>公开在线 <b>{publicOnline}/{publicStreams.length}</b></span>
      <span title="私有通道订阅确认后显示在线；不代表订单已成交，成交仍须完整回报核对">私有在线 <b>{privateOnline}/{privateStreams.length}</b></span>
      <span>重点订阅 <b>{subscriptions}</b></span>
      <span>新鲜盘口 <b>{freshBooks??'—'}/{subscriptions}</b></span>
      <span><Clock3 size={11}/>最新盘口 {age(status.lastQuoteAt,now)}</span>
      <span className={activeAuto?'realtime-active':'realtime-muted'}><Zap size={11}/>{!live?'模拟模式 · 无实盘触发':activeAuto?'自动策略：事件触发下单':autoEnabled?'自动策略等待实时条件':'自动下单关闭'}</span>
    </summary>
    <div className="realtime-detail">
      <p>{status.enabled?'重点币种通过 WebSocket 推送盘口，全市场仍由 REST 扫描；':'WebSocket 未启用，行情继续由 REST 更新；'}{fallback?'未就绪或过期通道回退 REST，过期推送不用于快速入场。':'推送已在线，提交前仍核对两腿当前报价。'} 手动开仓显示与自动策略开关独立。</p>
      <div className="realtime-venues">{publicStreams.map(stream=>{
        const privateStream=status.streams.find(row=>row.kind==='private'&&row.exchange===stream.exchange);
        return <div key={stream.exchange}><b>{venues[stream.exchange]}</b><span className={`realtime-stream ${stream.state}`}>公开 · {stream.state==='degraded'?'部分盘口待更新':stateLabel[stream.state]}</span><small>新鲜 {stream.freshBooks??'—'} / {stream.subscriptions} 合约 · 最新事件 {age(stream.lastEventAt,now)} · 重连 {stream.reconnects}</small><span className="realtime-muted">私有 · {stateLabel[privateStream?.state??'disabled']}</span></div>;
      })}</div>
      <div className="realtime-latency"><span><Activity size={12}/>执行阶段延迟 <b>{samples} 笔样本</b></span><span>首腿确认 <b>{duration(status.latency.firstLegMs,samples)}</b></span><span>补腿确认 <b>{duration(status.latency.hedgeMs,samples)}</b></span><span>双腿匹配 <b>{duration(status.latency.matchedMs,samples)}</b></span><span>匹配 P95 <b>{duration(status.latency.p95MatchedMs,samples)}</b></span></div>
      <p>{samples===0?'尚无本次运行的完整执行样本；公开行情延迟不能代表真实双腿成交速度。':'阶段延迟来自本次运行的执行记录，未测阶段保留为尚未测量。'} 私有成交或 USDT 手续费不完整时，按原订单编号继续 REST 核对。自动事件下单只用于已启动的实盘自动策略。</p>
    </div>
  </details>;
}
