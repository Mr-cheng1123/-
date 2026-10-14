import {memo,useState} from 'react';
import {RefreshCw,Wallet,Clock3} from 'lucide-react';
import type {AppState,ExchangeId,LivePortfolioExchange} from '../../src/shared/types';
import {isFreshPortfolioExchange,observeLedgerPosition,portfolioPositionSummary} from './position-observation';
import {groupLivePositions} from './live-position-groups';
import {accountPositionLiquidation} from './ledger-position-metrics';
import {accountPositionKey} from './account-position-identity';
import {positionPrice as price,positionTime,positionLiquidationLabel as liquidationObservationLabel} from './position-formatters';
import {AccountAge,usePortfolioDisplayClock} from './position-display-clock';
import {accountPositionCashDisplay} from './account-position-cash-display';
import './live-positions.css';

const names:Record<ExchangeId,string>={binance:'Binance',bybit:'Bybit',okx:'OKX',gate:'Gate',bitget:'Bitget'};
const money=(n:number|undefined,signed=false)=>n===undefined||!Number.isFinite(n)?'—':`${n<0?'−':signed&&n>0?'+':''}$${Math.abs(n).toFixed(2)}`;
const time=(n:number|undefined)=>positionTime(n,'—');
const tone=(n:number|undefined)=>n!==undefined&&n<0?'negative':n!==undefined&&n>0?'positive':'';
const quantityKey=(exchange:ExchangeId,symbol:string,side:string)=>JSON.stringify([exchange,symbol,side]);
export const LivePositions=memo(function LivePositions({state}:{state:AppState}){
  const now=usePortfolioDisplayClock(state.livePortfolio),[refreshing,setRefreshing]=useState(false),[error,setError]=useState('');
  const data=state.livePortfolio;if(!data)return null;
  const ready=(e:LivePortfolioExchange)=>isFreshPortfolioExchange(e,data,now);
  const configured=data.exchanges.filter(e=>e.credentialsConfigured),summary=portfolioPositionSummary(data,now),complete=summary.complete;
  const rows=configured.filter(ready).flatMap(e=>e.positions.filter(p=>p.quantity>0).map(p=>({...p,exchange:e.exchange,receivedAt:e.receivedAt,rowKey:accountPositionKey(e.exchange,p)})));
  const groups=groupLivePositions(rows,state.positions),pairedCount=groups.filter(group=>group.paired).length;
  const unrealized=summary.unrealizedPnlUsd,exposure=summary.exposureUsd,balance=summary.availableUsd;
  const records=new Map<string,number>();
  for(const position of state.positions.filter(p=>p.status!=='closed'&&!p.accountClosure&&observeLedgerPosition(p,data,now).status!=='account_flat'))for(const leg of [position.long,position.short]){
    const key=quantityKey(leg.exchange,leg.symbol,leg.side);records.set(key,(records.get(key)??0)+leg.quantity);
  }
  const differences:string[]=[];
  for(const e of configured.filter(ready)){
    const actual=new Map<string,number>();
    for(const p of e.positions){const key=quantityKey(e.exchange,p.symbol,p.side);actual.set(key,(actual.get(key)??0)+p.quantity);}
    for(const key of new Set([...actual.keys(),...[...records.keys()].filter(k=>JSON.parse(k)[0]===e.exchange)])){
      const recorded=records.get(key)??0,quantity=actual.get(key)??0;
      if(Math.abs(quantity-recorded)>Math.max(1e-10,Math.abs(recorded)*1e-8)){
        const [,symbol,side]=JSON.parse(key);differences.push(`${names[e.exchange]} ${symbol} ${side==='long'?'多':'空'}：账户 ${price(quantity)} / 成交记录 ${price(recorded)}`);
      }
    }
  }
  const refresh=async()=>{
    setRefreshing(true);setError('');
    try{const response=await fetch('/api/portfolio',{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error();}
    catch{setError('持仓刷新未完成，正在等待后台重试；以各交易所更新时间为准。');}
    finally{setRefreshing(false);}
  };
  return <section className="panel live-positions" aria-label="交易所实时持仓">
    <div className="section-title"><div><h2>交易所实时持仓</h2><p>同币多空两腿相邻 · 按币种 A-Z · 未成组放最后 · 每 {data.pollIntervalMs/1000} 秒更新</p></div>
      <button className="btn small-btn" disabled={refreshing} onClick={()=>void refresh()}><RefreshCw size={14} className={refreshing?'spin':''}/>刷新持仓</button></div>
    <div className="live-position-totals"><div><span>实际持仓数</span><b>{complete?rows.length:'—'}</b></div><div><span>实际仓位名义价值</span><b>{money(exposure)}</b></div><div><span>当前未实现损益</span><b className={tone(unrealized)}>{money(unrealized,true)}</b></div><div><span>账户可用保证金</span><b>{money(balance)}</b></div></div>
    <div className="live-position-accounts">{data.exchanges.map(e=><article key={e.exchange} className={ready(e)?'current':'unavailable'}>
      <b>{names[e.exchange]}</b><span className={`badge ${ready(e)?'green':'orange'}`}>{ready(e)?e.positions.length?`${e.positions.length} 个持仓`:'无持仓':e.status==='not_configured'?'未配置':e.status==='loading'?'读取中':e.status==='ready'||e.status==='stale'?'已过期':'读取失败'}</span>
      <small><Clock3 size={11}/>{ready(e)?<>更新 {time(e.receivedAt)} · <AccountAge timestamp={e.receivedAt!}/></>:e.lastSuccessAt?`上次成功 ${time(e.lastSuccessAt)}`:'尚无成功读取'}</small>
      {!ready(e)&&<p>{e.status==='ready'?'快照过期，当前持仓数量和损益未知':e.message??'等待读取交易所账户'}</p>}
    </article>)}</div>
    {error&&<p className="negative" role="status">{error}</p>}
    {differences.length>0&&<div className="info-strip live-position-differences" role="status"><Wallet size={16}/><div><b>交易所持仓与本地成交记录不一致</b><p>下表展示当前账户持仓；原订单和成交记录保留，未知订单仍需对账。</p><ul>{differences.map(d=><li key={d}>{d}</li>)}</ul></div></div>}
    {rows.length?<><div className="live-position-group-summary">{pairedCount} 组多空 · {groups.length-pairedCount} 项未成组<span>配对仅用于排列，实际数量分别显示</span></div><div className="table-scroll"><table><thead><tr><th>交易所 / 合约</th><th>方向 / 实际数量</th><th>开仓均价 / 标记价</th><th>未实现损益</th><th>当前仓位资金费</th><th>当前仓位手续费</th><th>当前周期净损益</th><th>更新时间</th></tr></thead>{groups.map((group,groupIndex)=><tbody key={group.id} className={`live-position-group ${group.paired?'paired':'unpaired'} ${!group.paired&&(groupIndex===0||groups[groupIndex-1].paired)?'unpaired-start':''}`} data-base={group.base} data-paired={group.paired}>{group.rows.map((p,index)=>{const cash=accountPositionCashDisplay(p);return <tr key={p.rowKey}>
      <td><b>{p.base}</b>{index===0&&<span className={`live-position-group-badge ${group.paired?'':'single'}`}>{group.paired?'多空组':'未成组'}</span>}<span className="cell-caption">{names[p.exchange]} · {p.symbol}</span>{p.positionMetricReason&&<span className="cell-caption">{p.positionMetricReason}</span>}</td><td><b className={p.side==='long'?'positive':'negative'}>{p.side==='long'?'多':'空'} {price(p.quantity)}</b><span className="cell-caption">币数量 · {Number.isFinite(p.leverage)&&p.leverage>0?`${price(p.leverage)}×`:'杠杆不统一 / 未明确'}{(p.splitPositionCount??0)>1?` · 多分仓合计（${p.splitPositionCount} 个，${p.marginMode?p.marginMode==='crossed'?'全仓':'逐仓':'全仓 / 逐仓'}）`:p.marginMode?` · ${p.marginMode==='crossed'?'全仓':'逐仓'}`:''}</span><span className="cell-caption">强平距离：{liquidationObservationLabel({liquidation:accountPositionLiquidation(p)})}</span></td>
      <td>{p.entryPrice===undefined?'均价待读取':price(p.entryPrice)}<span className="cell-caption">标记价 {price(p.markPrice)}</span></td><td className={tone(p.unrealizedPnlUsd)}>{p.unrealizedPnlUsd===undefined?'损益待读取':money(p.unrealizedPnlUsd,true)}<span className="cell-caption">交易所原值</span></td>
      <td className={tone(p.fundingUsd)}>{cash.fundingLabel??money(p.fundingUsd,true)}{p.exchange==='bybit'&&<span className="cell-caption">{cash.reason??cash.statusLabel??(p.cashFlowAt?'账单':'账单同步中 / 未完整返回')}{p.cashFlowAt?` · ${time(p.cashFlowAt)}`:''}</span>}</td><td>{cash.feesLabel??money(p.feesUsd)}</td><td><b className={tone(cash.totalUsd)}>{cash.totalLabel??money(cash.totalUsd,true)}{cash.totalKind==='subtotal'&&' · 参考小计'}</b><span className="cell-caption">已实现价格 {cash.realizedLabel??money(p.realizedPnlUsd,true)}</span><span className="cell-caption">{cash.totalCaption} · 未扣预计平仓费</span></td><td>{time(p.receivedAt)}<span className="cell-caption">只读账户快照</span></td>
    </tr>;})}</tbody>)}</table></div></>:<div className="empty"><Wallet size={26}/><strong>{complete?'已配置交易所当前无持仓':'当前持仓未完整读取'}</strong><p>{complete?'账户返回空持仓列表；旧成交记录不会被当作当前仓位。':'读取失败或过期的账户不显示旧数量；不能据此判断其已经平仓。'}</p></div>}
    <div className="data-footnote">资金费、手续费和已实现价格损益取当前持仓周期的交易所字段或完整账单；Bybit 账单单独读取，失败与周期待核对分别说明。缺项并非零，参考小计不是完整净损益；实时净损益不含预计平仓手续费。只读同步不会下单、平仓或解除实盘锁定。</div>
  </section>;
});
